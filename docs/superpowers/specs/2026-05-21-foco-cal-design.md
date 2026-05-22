# Foco CAL — Check-ins proactivos y herramientas de revisión

**Fecha:** 2026-05-21  
**Estado:** Aprobado por Cal  
**Proyecto:** Jano daemon-v2

---

## Resumen

Agregar a Jano tres capas de soporte para el Foco CAL de Cal:

1. **Check-ins proactivos** (node-cron, 3x/día, Lun–Vie) — Jano inicia conversaciones por sección rotativa
2. **Logging de progreso** — tool `logFocoProgress` + registro local + intento de checkbox en Notion
3. **Consulta on-demand + KPIs** — tool `getFocoCalStatus` expone estado completo (pendientes + avances + métricas de negocio)

---

## Fuentes de datos

### Página Foco CAL
- **Page ID:** `365c4876-09dd-806b-b602-f408c50a077b`
- **Acceso:** `mcp__claude_ai_Notion__notion-fetch`

### KPIs diarios (inline DB)
- **DB ID:** `d4996efa405344cf8149c6aee5eba52a`
- **Collection:** `collection://d6f1bd07-761c-4a8e-8bea-daf883d238b4`
- **Vista "Datos":** `view://35920029-b0cc-4af9-bac1-0bff18afdb5c` (ordenada por fecha desc)
- **Campos clave:** Afiliaciones diarias, Activos DAU, TRX, variaciones vs ayer y semana anterior (%)

### Vista de Tareas (inline DB)
- **DB ID:** `365c487609dd80d6a887edb08b1e324b`
- **Collection:** `collection://1f2c4876-09dd-80d2-8c0c-000b7f35059b`
- **Vista "This Week":** `view://366c4876-09dd-8062-944d-000c6c57c26a`
- **Campos clave:** Nombre de tarea, Estado (En curso/Focus/Sin empezar/Waiting for/Listo), Prioridad CAL (P1–P4), Urgencia, Deadline

---

## Secciones y rotación

6 secciones, rotan por check-in. Contador `foco_checkin_counter` (int) en CF KV — se incrementa en cada check-in, sección = contador mod 6.

| # | Sección | Fuente |
|---|---------|--------|
| 0 | CAL personal | Bloques checkbox en la página |
| 1 | Prioridades | Bloques checkbox en la página |
| 2 | Rufino Arribas | Bloques checkbox en la página |
| 3 | Christian Hausher | Bloques checkbox en la página |
| 4 | KPIs diarios | Inline DB `d4996efa...` — últimos 3 registros |
| 5 | Tareas de la semana | Inline DB `365c4876...` — vista "This Week" |

Con 3 runs/día × 5 días = 15 runs/semana → cada sección aparece ~2.5 veces/semana.

---

## Check-ins proactivos

### Horarios (America/La_Paz, Lun–Vie)

| Turno | Hora | Cron | Tono |
|-------|------|------|------|
| Mañana | 08:30 | `30 8 * * 1-5` | "¿Qué vas a mover hoy en [Sección]?" |
| Mediodía | 12:30 | `30 12 * * 1-5` | "Mitad del día — ¿lograste algo en [Sección] esta mañana?" |
| Cierre | 18:00 | `0 18 * * 1-5` | "Cierre del día — ¿qué avanzaste en [Sección]?" |

### Flujo de cada check-in

1. Incrementa `foco_checkin_counter` en KV
2. Determina sección activa (counter mod 6)
3. Llama `startup()` con prompt enfocado (no el system prompt completo)
4. LLM lee la sección desde Notion (page fetch o DB query según sección)
5. Para sección KPIs: también lee últimos 3 registros de KPIs diarios
6. Filtra items ya loggeados en `~/.cos-agent/foco-progress.json`
7. Construye mensaje con `buildApprovalFlow`:
   - Items: hasta 6 pendientes de la sección
   - `confirmVerb`: "✅ Hecho"
   - `rejectVerb`: "⏭ Saltar"
8. Envía al chat de Cal (chat_id 94137698)

### Deduplicación de check-ins

KV key: `foco_checkin_sent:{date}:{slot}` (TTL 25h) — evita doble envío si el daemon se reinicia.

---

## Nuevas tools

### `logFocoProgress`

```typescript
logFocoProgress({
  itemText: string,        // texto del item (tal como aparece en Notion)
  section: string,         // "CAL" | "Prioridades" | "Rufino" | "Christian" | "KPIs" | "Tareas"
  note?: string,           // nota opcional de Cal
  notionBlockId?: string,  // block ID de Notion para intentar marcar checkbox
})
```

**Comportamiento:**
1. Appends a `~/.cos-agent/foco-progress.json`:
   ```json
   { "date": "2026-05-21", "ts": 1234567890, "section": "CAL", "itemText": "...", "note": "..." }
   ```
2. Si `notionBlockId` presente: intenta `notion-update-page` con el block ID para marcar `checked: true`. Si falla (MCP no soporta block-level), loggea el intento y sigue.
3. Retorna string de confirmación: `"Progreso loggeado: [itemText]"`

**Registro local:** append-only (nunca sobreescribe). Para "des-loggear" un item, Cal lo dice explícitamente.

---

### `getFocoCalStatus`

```typescript
getFocoCalStatus()
// no args
```

**Comportamiento:**
1. Fetch `notion-fetch` de la página Foco CAL
2. Query `notion-query-database-view` de KPIs diarios (últimos 5 registros)
3. Query `notion-query-database-view` de Vista de Tareas (semana actual)
4. Lee `~/.cos-agent/foco-progress.json` — filtra los últimos 30 días
5. Retorna objeto estructurado:
   ```json
   {
     "sections": {
       "CAL": { "pending": ["item1", "item2"], "logged": [{"itemText": "...", "date": "...", "note": "..."}] },
       "Prioridades": { ... },
       "Rufino": { ... },
       "Christian": { ... }
     },
     "kpis": {
       "last3": [{ "fecha": "2026-05-21", "afiliaciones": 4200, "dau": 1050000, "trx": 4500000, "af_vs_ayer": 0.03, "dau_vs_sem": -0.01, "trx_vs_sem": 0.05 }]
     },
     "tareas": [{ "nombre": "...", "estado": "En curso", "prioridad": "P1", "deadline": "2026-05-25" }],
     "lastCheckinTs": 1234567890,
     "nextSection": "Rufino"
   }
   ```

**Cuándo lo llama Jano (instrucción en system prompt):**
- "cómo voy con el Foco", "qué llevas sin mover", "en qué debería enfocarme"
- "cómo van los KPIs", "cómo estamos en afiliaciones/DAU/TRX"
- "qué tareas tengo esta semana", "mis tareas de Notion"
- Al responder cualquier check-in de Foco CAL (para tener contexto actualizado)

---

## Interacción (approval flow)

Usa `buildApprovalFlow` existente. Al recibir `jano-wiz-ok`:
1. `stepApprovalWizard({ action: "ok" })` → retorna `item`
2. Pregunta nota opcional: "¿Alguna nota sobre este avance? (o toca Continuar)"
   - Si Cal escribe nota → `logFocoProgress({ itemText: item.label, section, note: calNote, notionBlockId: item.id })`
   - Si Cal dice "no" / "continuar" / toca botón → `logFocoProgress({ itemText: item.label, section, notionBlockId: item.id })`
3. Respuesta breve: "✅ Loggeado"

**Mapping de item IDs:** el campo `id` del item en `buildApprovalFlow` lleva el Notion block ID (si disponible) o un hash del texto del item. Esto permite que `logFocoProgress` intente el update de checkbox.

---

## Archivos a crear/modificar

### Nuevos
- `daemon-v2/src/proactive/foco-check.ts` — crons + lógica de secciones + prompt de check-in
- `daemon-v2/src/tools/foco-cal.ts` — helpers: `readFocoSection()`, `appendFocoProgress()`, `readFocoProgress()`, `queryFocoKpis()`, `queryFocoTareas()`

### Modificados
- `daemon-v2/src/agent-tools.ts` — agrega `logFocoProgress` y `getFocoCalStatus`
- `daemon-v2/src/system-prompt.ts` — sección "Foco CAL" (~5 líneas) + 1 línea en reglas de selección
- `daemon-v2/src/agent-options.ts` — agrega `mcp__cos-tools__logFocoProgress`, `mcp__cos-tools__getFocoCalStatus` a `CLAUDE_AI_COS_TOOLS`
- `daemon-v2/src/index.ts` — importa y arranca `scheduleFocoCheckins`

---

## Adición al system prompt (mínima)

```
### Foco CAL (prioridades estratégicas de Cal)
- `mcp__cos-tools__getFocoCalStatus()` — estado completo: pendientes + avances por sección + KPIs recientes de Yape Bolivia + tareas de la semana.
  Llamar cuando Cal pregunte sobre el Foco, su progreso, en qué enfocarse, cómo van los KPIs, DAU, afiliaciones, TRX, o sus tareas de Notion de la semana.
- `mcp__cos-tools__logFocoProgress({ itemText, section, note?, notionBlockId? })` — loggea avance en un item del Foco CAL.
  Llamar al confirmar "hecho" en un check-in de Foco, o cuando Cal mencione que completó/avanzó algo del Foco.
```

Agregar en reglas de selección:
```
- "cómo voy con el foco" / "en qué enfocarme" / "cómo van los KPIs" / "afiliaciones/DAU/TRX" / "tareas de Notion" → `getFocoCalStatus()`
```

---

## Detalles técnicos

### Prompt del check-in (en `foco-check.ts`)

El prompt de cada cron es corto y enfocado — no usa el `SYSTEM_PROMPT` completo para no pagar tokens de ~18K chars en cada run:

```typescript
const CHECK_IN_SYSTEM = `Eres Jano, CoS digital de Cal. Telegram HTML. Español neutro. Sin acks genéricos.
Tu tarea: leer la sección "${section}" del Foco CAL de Cal y mandarle un check-in de ${tone}.
Usa buildApprovalFlow con los items pendientes (máx 6). Incluye KPIs si la sección es KPIs.
Items loggeados recientemente: ${recentlyLogged.join(', ') || 'ninguno'}.`;
```

### Manejo de Notion block IDs

Al hacer `notion-fetch` de la página Foco CAL, los bloques to-do NO retornan block IDs en el output actual del MCP (el MCP retorna Markdown enriquecido sin IDs de bloque). Por lo tanto:
- `notionBlockId` será `undefined` en la mayoría de casos
- El log local siempre funciona
- El update de Notion checkbox se considera "best-effort" — si el MCP expone block IDs en el futuro, se activa automáticamente
- Cal puede marcar los checkboxes manualmente en Notion después de que Jano le notifique el progreso

### Progress file format

`~/.cos-agent/foco-progress.json` — array append-only:
```json
[
  { "date": "2026-05-21", "ts": 1716307200, "section": "CAL", "itemText": "Delegar más", "note": "Delegué el follow-up de ASFI a Lorena" },
  { "date": "2026-05-21", "ts": 1716320000, "section": "Prioridades", "itemText": "Inspeccion ASFI", "note": null }
]
```

Lectura en `getFocoCalStatus`: filtra últimos 30 días, agrupa por sección, deduplica por `itemText` (mantiene el más reciente).

---

## Consideraciones de costo

- 3 runs/día × ~$0.20/run (startup() fresco) = **~$0.60/día** en días laborales (~$3/semana)
- El prompt del check-in es corto (~500 tokens input) — mucho menor que el system prompt completo
- `getFocoCalStatus` corre en el contexto del daemon existente (sin startup() extra) — costo marginal

---

## No incluido en esta versión

- Actualización automática de checkboxes en Notion (requiere block IDs que el MCP actual no expone)
- Historial de KPIs en gráfico (texto tabular es suficiente en Telegram)
- Notificación si una sección no ha tenido avances en X días (posible v2)
