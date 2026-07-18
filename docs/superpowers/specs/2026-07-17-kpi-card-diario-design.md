# Tarjeta Diaria de KPIs Yape (TRX + Activos DAU) — Diseño

**Fecha:** 2026-07-17
**Status:** Aprobado
**Fase:** Proactivo Jano — nuevo cron interno

## Goal

Cal quiere recibir cada mañana, por Telegram, una tarjeta visual con los 2 KPIs diarios de
Yape Bolivia (Transacciones y Activos DAU, con su variación % vs. la semana anterior) para
poder reenviarla con un tap al grupo de WhatsApp de su equipo. Los mismos KPIs ya se muestran
en el reloj Ulanzi TC001 (`trx-update.sh`/`activos-update.sh`), así que esta feature reusa la
misma fuente de datos sin tocar esos scripts.

## Decisión de alcance: no hay envío automático a WhatsApp

`wa.me` (usado por el skill `whatsapp`) solo abre un chat 1:1 con un número — no existe forma
de pre-llenar un mensaje dirigido a un grupo existente de WhatsApp vía link. Automatizar el
envío real al grupo requeriría WhatsApp Business API (Meta Cloud API), con el número
verificado como negocio y agregado al grupo — descartado por Cal por ser mucho mayor esfuerzo
de infra para el beneficio. **v1 = Jano genera y entrega la tarjeta a Cal por Telegram; Cal la
reenvía manualmente al grupo.**

## Arquitectura

Nuevo cron interno del daemon (`node-cron`, mismo patrón que `scheduleHealthSyncCheck()`),
100% mecánico — **sin pasar por el agente SDK / `takeWarm()`**. No hay razonamiento involucrado
(query fija a Notion → render de imagen → 1 o 2 llamadas a la API de Telegram), así que evita
por completo el riesgo de "thrashing" de autocompact documentado para otros flujos de Jano.

```
cron 09:30 America/La_Paz (diario)
  → fetchDailyKpis()          # Notion: fila más reciente de "KPIs diarios"
  → renderKpiCardImage()      # @napi-rs/canvas → PNG 1080×1080 en tmpdir
  → enviarFotoLocal()         # sendDocument a Cal (ALERT_CHAT_ID) por Telegram
  (en cualquier fallo duro)
  → sendMessage() con texto de error a Cal, en vez de la tarjeta
```

## Componentes

### 1. `fetchDailyKpis()` — nuevo, `daemon-v2/src/proactive/kpi-card-daily.ts`

Query HTTP directa a la API de Notion (mismo patrón que `trx-update.sh`/`activos-update.sh`,
sin pasar por `ntn` ni por MCP — un cron desatendido no debe depender de un CLI interactivo):

- `POST https://api.notion.com/v1/databases/d4996efa-4053-44cf-8149-c6aee5eba52a/query`
- Header `Authorization: Bearer ${env.NOTION_TOKEN}` (ya cargado como env requerido en
  `index.ts`, no hace falta releer `apps.env` a mano como hacen los scripts bash)
- Body: `{"page_size": 1, "sorts": [{"property": "Fecha", "direction": "descending"}]}`
- Lee de `results[0].properties`: `TRX`, `TRX vs. Sem. anterior (%)`, `Activos DAU`,
  `DAU vs. Sem. anterior (%)`, `Fecha`
- Si `TRX` o `Activos DAU` vienen `null`, o `results` viene vacío → falla dura (ver Edge cases)
- **No filtra por fecha de hoy** — usa la fila más reciente que haya, sea de hoy o de días
  antes (mismo criterio que Ulanzi: sin bloquear el envío por falta de carga de hoy)

### 2. `renderKpiCardImage()` — nuevo, `daemon-v2/src/proactive/kpi-card-image.ts`

Genera el PNG 1080×1080 con **`@napi-rs/canvas`** (bindings nativos, sin navegador) en vez de
Playwright — a diferencia de la tarjeta de wallet de BoA (`wallet-image.ts` en el MCP
`boa-checkin`), acá el layout es simple (2 rectángulos redondeados, texto, un logo) y no
justifica agregar Chromium como dependencia nueva del daemon principal solo para esto.
`@napi-rs/canvas` arranca instantáneo (sin proceso de browser) — mejor para un cron diario.

Layout (estilo "Data Card Clara" aprobado en el companion visual, 1080×1080):

- Fondo blanco, borde gris claro sutil, esquinas redondeadas
- Logo de Yape Bolivia arriba-izquierda (`daemon-v2/assets/kpi-card/yape-logo.png`, el mismo
  que pasó Cal — burbuja verde "Bs" + wordmark violeta), dibujado con `drawImage`
- Fecha (`Fecha` de Notion, formateada `D MMM`) arriba-derecha, gris
- Línea "Foco diario · Yape Bolivia" en violeta (`#7A1FA2`), debajo del header
- Dos tiles lado a lado (fondo `#F7F4FB`, esquinas redondeadas):
  - Tile izquierdo: "Transacciones" / `{TRX/1e6:.1f}M` en negro bold / chip de %
  - Tile derecho: "Activos DAU" / `{DAU/1e6:.1f}M` en negro bold / chip de %
  - Chip verde (`#E4F7E9` fondo, `#1B8A3D` texto) si el % es ≥ 0, rojo (`#FBE4E4`/`#C22`) si es < 0

Devuelve un `Buffer` PNG. El caller lo escribe a
`{tmpdir()}/kpi-card-{YYYY-MM-DD}.png`.

### 3. Extensión de `telegram-files.ts` — allowlist de nombre de archivo

`enviarFotoLocal` hoy solo acepta `/^boa-wallet-.+\.png$/` dentro de `tmpdir()` (validado con
`realpath()` — ver gotcha de seguridad ya documentado en `CLAUDE.md`). Se amplía el regex a
`/^(boa-wallet|kpi-card)-.+\.png$/` para aceptar también el nuevo prefijo. Mismo criterio de
seguridad, ningún cambio de comportamiento para el flujo de BoA existente.

### 4. Orquestación — `checkKpiCardDaily()` en `kpi-card-daily.ts`

```ts
export async function checkKpiCardDaily(opts: {
  botToken: string;
  chatId: number;
  notionToken: string;
}): Promise<void> {
  let kpis: DailyKpis;
  try {
    kpis = await fetchDailyKpis(opts.notionToken);
  } catch (err) {
    await notifyFailure(opts, "No pude leer los KPIs desde Notion", err);
    return;
  }

  let imagePath: string;
  try {
    const png = await renderKpiCardImage(kpis);
    imagePath = join(tmpdir(), `kpi-card-${todayIso()}.png`);
    await writeFile(imagePath, png);
  } catch (err) {
    await notifyFailure(opts, "No pude generar la imagen de la tarjeta", err);
    return;
  }

  const sent = await enviarFotoLocal(opts.botToken, opts.chatId, imagePath, "kpi-card.png");
  if (!sent.ok) {
    await notifyFailure(opts, "No pude mandarte la tarjeta por Telegram", sent.error);
  }
}
```

`notifyFailure()` manda un texto simple por `sendMessage` (`@cos/shared`), ej.:
`⚠️ No pude armar la tarjeta de KPIs de hoy (falló: {motivo}). Revisa los logs del daemon.`
— reemplaza a la tarjeta ese día en vez de fallar en silencio (decisión explícita de Cal:
prefiere enterarse por texto antes que quedarse sin nada sin saber por qué).

### 5. Registro del cron — `index.ts`

```ts
function scheduleKpiCardDaily(): void {
  cron.schedule("30 9 * * *", () => {
    void checkKpiCardDaily({
      botToken: env.COS_TELEGRAM_BOT_TOKEN,
      chatId: ALERT_CHAT_ID,
      notionToken: env.NOTION_TOKEN,
    }).catch((err) => log({ msg: "kpi_card_daily_unhandled_error", err: String(err) }));
  }, { timezone: "America/La_Paz" });
  log({ msg: "kpi_card_daily_scheduled", interval: "daily 09:30" });
}
```

Llamada junto a `scheduleHealthSyncCheck()` en el arranque del `loop()`. Todos los días
(incluye fines de semana), sin excepción de día hábil — decisión explícita de Cal.

## Edge cases

| Caso | Comportamiento |
|---|---|
| No hay fila en Notion para hoy, pero sí hay una anterior | Usa esa fila igual, sin avisar (comportamiento normal, no es una falla) |
| `TRX` o `Activos DAU` vienen `null` en la fila más reciente | Falla dura → texto de error a Cal |
| Notion API cae / timeout / 401 | Falla dura → texto de error a Cal |
| `NOTION_TOKEN` inválido o revocado | Falla dura → texto de error a Cal (mismo mensaje genérico; el detalle va a logs) |
| Render de canvas falla (ej. logo PNG corrupto/faltante) | Falla dura → texto de error a Cal |
| `enviarFotoLocal` falla (Telegram caído, `sendDocument` rechaza) | Falla dura → texto de error a Cal (best-effort — si el texto también falla, se loguea y no se reintenta hasta el próximo día) |
| El % de variación viene `null` (columna vacía) | La tarjeta se genera igual, sin el chip de % para ese KPI (mismo criterio que `trx-update.sh`) |

## Testing

- Unit test de `fetchDailyKpis()` con respuesta de Notion mockeada (caso normal, caso sin
  resultados, caso con `TRX`/`DAU` null)
- Unit test de `renderKpiCardImage()`: solo valida que devuelve un `Buffer` no vacío con
  header PNG válido (sin comparar pixel a pixel)
- Prueba manual end-to-end: correr `checkKpiCardDaily()` con `tsx` apuntando al token real de
  Notion (sandbox), confirmar que llega la tarjeta a Telegram con los datos de hoy
- Prueba de falla forzada: pasar un `notionToken` inválido y confirmar que llega el texto de
  error en vez de trabar el cron

## Observabilidad

- Logs: `~/Library/Logs/cos-agent-v2.out.log` (mismo logger `log()` que el resto del daemon)
- Eventos: `kpi_card_daily_scheduled` (arranque), `kpi_card_daily_unhandled_error` (excepción
  no capturada), y los `console.error`/mensajes de `notifyFailure()` con el motivo puntual

## Entregables

- `daemon-v2/src/proactive/kpi-card-daily.ts` (`fetchDailyKpis`, `checkKpiCardDaily`,
  `notifyFailure`)
- `daemon-v2/src/proactive/kpi-card-image.ts` (`renderKpiCardImage`)
- `daemon-v2/assets/kpi-card/yape-logo.png` (asset provisto por Cal)
- Edit a `daemon-v2/src/tools/telegram-files.ts` (regex de `enviarFotoLocal`)
- Edit a `daemon-v2/src/index.ts` (`scheduleKpiCardDaily()` + llamada en `loop()`)
- Nueva dependencia: `@napi-rs/canvas` en `daemon-v2/package.json`
- Update `CLAUDE.md` (sección Automatización — nuevo cron activo) + `BACKLOG.md` si aplica

## Rollout

1. Implementar `fetchDailyKpis()` + tests, validar contra la DB real de Notion
2. Implementar `renderKpiCardImage()`, iterar el layout comparando contra el mockup aprobado
3. Cablear `checkKpiCardDaily()` + extensión de `telegram-files.ts`
4. Probar manualmente (forzar ejecución con `tsx`, sin esperar al cron) antes de registrar el
   schedule
5. Registrar `scheduleKpiCardDaily()`, rebuild, restart del daemon
6. Confirmar la primera entrega real a las 09:30 del día siguiente

## No-goals

- No hay envío automático al grupo de WhatsApp (ver "Decisión de alcance" arriba) — v1 termina
  en la entrega a Cal por Telegram
- No hay caption de texto acompañando la imagen — solo la tarjeta (decisión de Cal)
- No hay configuración de horario/KPIs por comando de chat — el horario (09:30) y los 2 KPIs
  están hardcodeados en el código, igual que otros crons proactivos de Jano
- No se toca `trx-update.sh`/`activos-update.sh` de Ulanzi — quedan como están, esta feature
  solo lee la misma DB de Notion en paralelo
