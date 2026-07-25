# Ingesta automática de KPIs Yape desde mail (Self-Service → Notion) — Diseño

**Fecha:** 2026-07-22
**Status:** Aprobado
**Fase:** Proactivo Jano — nuevo cron interno

## Goal

Cal recibe todos los días (horario variable) un mail de BCP ("Self-Service") con un CSV
adjunto de KPIs de Yape Bolivia. Hoy esto se cargaba a mano en la DB de Notion "KPIs diarios",
o vía un agente de Notion AI (instrucción documentada en la página "Actualizar KPIs diarios
(ingesta + derivados)", DB `d4996efa-4053-44cf-8149-c6aee5eba52a`). Se porta ese proceso a un
cron mecánico de Jano: detecta el mail, baja el CSV, hace upsert de los campos raw por Fecha,
completa los derivados que falten en todo el histórico, y le manda un reporte a Cal por
Telegram.

Esta DB es la misma que ya lee `kpi-card-daily.ts` (TRX + Activos DAU) — la ingesta acá
alimenta esa tarjeta diaria indirectamente, sin tocar ese código.

## Decisiones de alcance (discutidas con Cal)

- **Vive 100% en Jano**, no en Yapito — el trigger es Gmail personal (`carlos@lepesqueur.net`),
  que solo Jano tiene conectado. La notificación final sale por el bot de Jano (Cal descartó
  explícitamente cruzar a un token de Yapito para esto).
- **Solo ingesta de CSV adjunto** — el proceso original de Notion también contemplaba texto
  pegado e imagen como input; ese alcance más amplio no aplica acá, el trigger es
  específicamente el mail con CSV.
- **Solo los 4 campos derivados documentados** (Afiliados 7d, TRX/DAU/Afiliaciones vs. Sem.
  anterior %) — la DB tiene más columnas numéricas sin fórmula documentada (Promedio 7d,
  vs. Ayer %, Activos 30d %, Trx Yapero Activo ya es fórmula nativa de Notion) que quedan
  fuera de este cron.
- **No se marca leído ni se archiva el mail** — vuelto atrás respecto de una versión anterior
  de este diseño (que sí lo contemplaba). Se mantiene el "no tocar el inbox" del proceso
  original de Notion; simplifica el scope de OAuth necesario (`gmail.readonly` en vez de
  `gmail.modify`) y evita dejar una decisión pendiente atada a cuándo Cal pueda correr el setup
  desde su Mac. Reabrir si en algún momento se vuelve a querer.
- **Gmail OAuth vía `gcloud auth application-default login`** (scope `gmail.readonly`) en vez de
  reusar el client de YouTube o crear un client nuevo en Google Cloud Console — cero pasos en
  la consola, solo un comando que corre Cal una vez desde su Mac (pendiente, no bloquea seguir
  con el resto del diseño/implementación).
- **Sin trigger push real** — Gmail no tiene webhook accesible sin infra adicional (Pub/Sub +
  verificación de dominio). Se resuelve con polling cada 15 min; el timer de "esperar 15 min
  desde que llegó el mail" del proceso original queda naturalmente cubierto por la cadencia del
  poll (un mail nunca se procesa antes de los 15 min, y como mucho tarda ~15 min más en
  detectarse el siguiente tick).

## Arquitectura

```
cron */15 6-23 * * * America/La_Paz
  → gmailAccessToken()                 # refresh_token → access_token (cache ~1h, igual que YouTube)
  → searchSelfServiceEmails()          # Gmail search: to/from/subject/has:attachment, newer_than:3d
  → mergear con estado local (~/.cos-agent/kpi-ingest-state.json)
      nuevo msgId  → agregar a "pending" con receivedAt = internalDate
      pending, aún no pasaron 15 min → esperar próximo tick
      pending, ya pasaron 15 min      → procesar
  → processMessage(msgId):
      1. findCsvAttachment()           # recorre MIME parts, elige el CSV correcto
         sin CSV → notifica "sin CSV adjunto", NO marca processed, NO toca el mail
      2. downloadAttachment()          # attachments.get + base64url decode
      3. parseCsv()                    # delimitador, números, fechas, alias de columnas
      4. upsertKpiRow() por Fecha      # Fase 1 — raw fields, regla domingo
      5. fillDerivedFields()           # Fase 2 — recorre TODO el histórico, solo si vacío
      6. sendMessage() con el reporte  # Telegram, bot de Jano
      7. mover msgId de "pending" a "processed" en el estado
  (en cualquier error de 1-5)
      → notifyFailure() (dedup: mismo msgId no repite el mismo error antes de 2h)
      → NO se marca processed → se reintenta en el próximo tick
```

## Componentes

### 1. `gmailAccessToken()` — nuevo, `daemon-v2/src/proactive/kpi-ingest-check.ts`

Mismo patrón que `ytAccessToken()` en `tools/resumir.ts` (cache en memoria, refresco ~60s antes
de expirar), pero con las env vars nuevas:

```ts
const body = new URLSearchParams({
  client_id: process.env.GMAIL_OAUTH_CLIENT_ID ?? "",
  client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET ?? "",
  refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN ?? "",
  grant_type: "refresh_token",
});
// POST https://oauth2.googleapis.com/token
```

### 2. `searchSelfServiceEmails()`

```
GET https://gmail.googleapis.com/gmail/v1/users/me/messages
    ?q=to:carlos@lepesqueur.net from:clepesqueur@bcp.com.bo subject:Self-Service has:attachment newer_than:3d
```

Devuelve solo IDs — para cada uno no visto, un segundo call `messages.get?format=metadata` para
sacar `internalDate` (epoch ms, la hora real de recepción que usamos para el timer de 15 min).

### 3. Estado local — `~/.cos-agent/kpi-ingest-state.json`

```json
{
  "processed": ["18f1a2b3c4d5e6f7"],
  "pending": { "18f9998887766554": { "receivedAt": 1753185600000 } },
  "lastErrorNotified": { "18f9998887766554": 1753186500000 }
}
```

No versionado en git (mismo criterio que `resumir-*.json`). `processed` se poda a los últimos
~200 IDs para no crecer indefinidamente (no hay necesidad de historial más largo, el filtro
`newer_than:3d` ya acota qué se vuelve a ver).

### 4. `findCsvAttachment()`

- `messages.get?format=full` → recorre `payload.parts` recursivamente (attachments pueden venir
  anidados en multipart/mixed → multipart/alternative).
- Candidatos: `filename` termina en `.csv`, o `mimeType` es `text/csv`/`application/vnd.ms-excel`
  con filename `.csv`.
- 0 candidatos → falla controlada ("sin CSV adjunto"), reporta y NO toca el mail.
- 1 candidato → ese.
- 2+ candidatos → descarga y parsea cada uno, elige el que tenga más columnas mapeables
  (Fecha + ≥1 campo raw reconocido); empate → el primero en orden de aparición.

### 5. `parseCsv()` — funciones puras, testeables sin red

- **Delimitador:** `,` o `;`, detectado en la primera línea (cuenta ocurrencias fuera de comillas).
- **Números:** si el valor matchea `^-?\d{1,3}(\.\d{3})*,\d+$` → estilo LatAm (punto=miles,
  coma=decimal). Si matchea `^-?\d{1,3}(,\d{3})*\.\d+$` → estilo US. Si solo hay un separador
  con grupos de 3 dígitos → miles, sin decimales. Vacío/ilegible → `null` + se reporta.
- **Fechas:** normaliza `DD/MM/YYYY`, `DD-MM-YYYY`, `YYYY-MM-DD` → `YYYY-MM-DD`.
- **Mapeo de columnas → propiedades Notion** (por nombre normalizado sin tildes/mayúsculas,
  con alias conocidos):

| Alias en CSV (ejemplos) | Propiedad Notion |
|---|---|
| Fecha | Fecha |
| Afiliaciones diarias, Afiliaciones Nuevas | Afiliaciones diarias |
| TRX, Transacciones | TRX |
| Activos DAU, DAU | Activos DAU |
| Activos 30d, MAU | Activos 30d |
| Stock Afiliados | Stock Afiliados |
| Saldo | Saldo |
| Remesas (cantidad), Remesas Cantidad | Remesas (cantidad) |
| Remesas (USD), Remesas USD | Remesas (USD) |

  Columna del CSV que no matchea ningún alias → se ignora y se reporta como "no mapeada" (no
  se crea una propiedad nueva en Notion).

### 6. `upsertKpiRow()` — Fase 1, por Fecha

- `POST /v1/databases/{KPI_DB_ID}/query` con filtro `{"property":"Fecha","date":{"equals":fecha}}`.
- Existe fila → `PATCH /v1/pages/{id}` con los campos raw presentes y no vacíos en el CSV (el
  CSV es la fuente de verdad para raw → sí pisa un valor previo).
- No existe → `POST /v1/pages` con `parent.database_id` + título "Registro" = la fecha + los
  campos disponibles.
- **Regla domingo:** si `Fecha` cae domingo y "Afiliaciones diarias" viene `0` → tratar como
  vacío (no escribir `0`, no pisar un valor previo si ya había uno).

### 7. `fillDerivedFields()` — Fase 2, recorre todo el histórico

- `POST /v1/databases/{KPI_DB_ID}/query` con `sorts: [{"property":"Fecha","direction":"ascending"}]`,
  paginado (`start_cursor`) hasta traer todas las filas.
- Para cada fila con el campo **vacío** (nunca pisa uno ya cargado):
  - **Afiliados 7d** = promedio de "Afiliaciones diarias" en D-6…D excluyendo domingos (ni
    suman ni dividen). Si falta algún día no-domingo de la ventana → no calculable, reporta
    la fecha faltante. Redondeado a entero al guardar.
  - **TRX vs. Sem. anterior (%)** = TRX(D)/TRX(D-7) − 1
  - **DAU vs. Sem. anterior (%)** = Activos DAU(D)/Activos DAU(D-7) − 1
  - **Afiliaciones vs. Sem. anterior (%)** = Afiliaciones diarias(D)/Afiliaciones diarias(D-7) − 1
  - Para las 3 últimas: falta D o D-7, o D-7 es 0 → no calculable, motivo exacto (ej. "no existe
    registro D-7" / "falta TRX el 2026-07-15").

### 8. Orquestador — `checkKpiIngest()`

Envuelve cada mensaje pendiente-listo en su propio try/catch (un mensaje que falla no bloquea
otros que puedan estar en la cola). Reporta por Telegram (`sendMessage`, HTML, bot de Jano):

- **Éxito:** ingesta (fechas creadas/actualizadas + campos escritos + no mapeados/ilegibles) +
  derivados (completados: Fecha→campo→valor; no calculables: Fecha→campo→motivo).
- **Sin CSV adjunto:** aviso puntual, sin tocar el mail.
- **Error** (Gmail/parseo/Notion): mensaje de error con el motivo; dedup — mismo `msgId` no
  repite notificación antes de 2h (mismo criterio que `health-sync-check.ts`).

### 9. Registro del cron — `index.ts`

```ts
function scheduleKpiIngestCheck(): void {
  cron.schedule("*/15 6-23 * * *", () => {
    void checkKpiIngest({
      botToken: env.COS_TELEGRAM_BOT_TOKEN,
      chatId: ALERT_CHAT_ID,
      notionToken: env.NOTION_TOKEN,
      gmail: {
        clientId: env.GMAIL_OAUTH_CLIENT_ID,
        clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET,
        refreshToken: env.GMAIL_OAUTH_REFRESH_TOKEN,
      },
    }).catch((err) => log({ msg: "kpi_ingest_check_unhandled_error", err: String(err) }));
  }, { timezone: "America/La_Paz" });
  log({ msg: "kpi_ingest_check_scheduled", interval: "*/15 6-23" });
}
```

Llamada junto a `scheduleKpiCardDaily()`/`scheduleHealthSyncCheck()` en el arranque del `loop()`.

## Setup manual pendiente (Cal, desde su Mac — no se puede hacer en remoto)

```bash
gcloud auth application-default login \
  --scopes="openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/gmail.readonly"
```

Luego copiar `client_id` / `client_secret` / `refresh_token` de
`~/.config/gcloud/application_default_credentials.json` a `~/.cos-agent/.env` como
`GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET` / `GMAIL_OAUTH_REFRESH_TOKEN`. Los valores
quedan copiados en nuestro `.env` — un `gcloud auth application-default login` posterior para
otro uso no rompe esta integración.

## Edge cases

| Caso | Comportamiento |
|---|---|
| Mail llega pero sin CSV adjunto | Reporta, no reintenta luego (se agrega igual a `processed` tras notificar 1 vez, aunque el mail siga sin tocar en la bandeja) |
| Mail con 2+ adjuntos CSV | Elige el de más columnas mapeables; si hay empate, el primero |
| CSV con columna no reconocida | Se ignora esa columna, se reporta como "no mapeada" |
| Valor numérico ilegible/vacío | Esa celda queda en blanco, se reporta, el resto de la fila sigue procesándose |
| Domingo con Afiliaciones diarias = 0 | Se trata como vacío, no se escribe 0 |
| Falta un día no-domingo en la ventana de "Afiliados 7d" | No calculable, reporta la fecha exacta que falta |
| D-7 no existe o es 0 (para los 3 "vs. Sem. anterior") | No calculable, motivo exacto |
| Notion API cae / 401 / timeout | Falla dura → notifica error (con dedup 2h), reintenta en el próximo tick |
| Gmail API cae / token expirado / scope insuficiente | Falla dura → notifica error (con dedup 2h) |
| El mismo mail se re-notifica por BCP con distinto Message-ID | Se procesa como mail nuevo; el upsert por Fecha es idempotente (mismos valores, sin duplicar filas) |

## Testing

- Unit tests de las funciones puras (sin red): detección de delimitador, normalización de
  números (LatAm/US/miles-sin-decimales), normalización de fechas, regla domingo, mapeo de
  columnas con alias, las 4 fórmulas de derivados (casos calculable / no calculable con motivo).
- Prueba manual end-to-end: correr `checkKpiIngest()` con `tsx` apuntando a un mail real de
  prueba (o un fixture de CSV local) contra una fila de test en Notion, confirmar upsert +
  reporte de Telegram.
- Prueba de falla forzada: token de Gmail inválido → confirmar que llega el error dedupeado.

## Observabilidad

- Logs: `~/Library/Logs/cos-agent-v2.out.log` (logger `log()` existente).
- Eventos: `kpi_ingest_check_scheduled`, `kpi_ingest_check_unhandled_error`, y logs puntuales por
  mensaje procesado (`kpi_ingest_processed`, `kpi_ingest_failed`, `kpi_ingest_no_csv`).

## Entregables

- `daemon-v2/src/proactive/kpi-ingest-check.ts` (todo el flujo)
- `daemon-v2/src/proactive/kpi-ingest-check.test.ts`
- Edit a `daemon-v2/src/index.ts` (`scheduleKpiIngestCheck()` + llamada en `loop()` + carga de
  las 3 env vars nuevas)
- `~/.cos-agent/.env` — `GMAIL_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN` (Cal, paso manual)
- Update `CLAUDE.md` de Jano (sección Automatización + índice de tools)

## Rollout

1. Implementar funciones puras (parseo CSV, normalización, fórmulas de derivados) + tests,
   sin red.
2. Implementar `gmailAccessToken()`/`searchSelfServiceEmails()`/`findCsvAttachment()`/
   `downloadAttachment()` — probar contra Gmail real una vez Cal corra el
   `gcloud auth application-default login` y pase las credenciales.
3. Implementar `upsertKpiRow()`/`fillDerivedFields()` contra la DB real de Notion (probar en
   una fecha de test, no pisar datos reales).
4. Cablear `checkKpiIngest()` + estado local, probar manualmente con `tsx` sin registrar el cron.
5. Registrar `scheduleKpiIngestCheck()`, rebuild, restart del daemon.
6. Confirmar el primer ciclo real contra el próximo mail de Self-Service que llegue.

## No-goals

- No hay trigger push instantáneo — la latencia real es "15 min desde que llega + hasta 15 min
  del próximo poll" (~15-30 min).
- No se integra con Yapito (bot ni token) — todo vive y notifica desde Jano.
- No se calculan los derivados no documentados (Promedio 7d, vs. Ayer %, Activos 30d %, etc.).
- No se soporta ingesta por texto pegado ni imagen (alcance más amplio del proceso original de
  Notion) — solo CSV adjunto al mail de Self-Service.
- No se toca `kpi-card-daily.ts` ni `kpi-card-image.ts` — siguen leyendo la misma DB en paralelo.
