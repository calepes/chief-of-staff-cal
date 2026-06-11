# Meetings → Foco Log Integration — Design Spec
*2026-05-26*

## Objetivo

Permitir que Jano cruce las reuniones de Cal (Notion Meetings DB) contra su Foco CAL y Tareas, sugiera items de log, y los valide con Cal antes de guardar. Dos modos: automático al 6pm y tool on-demand para rangos históricos.

---

## Contexto

- **Sistema de foco existente:** `logFocoProgress()` guarda entries en `~/.cos-agent/foco-progress.json`. Check-ins 3x/día (8:30, 12:30, 6pm) via `foco-check.ts`.
- **Meetings DB:** `collection://04f0447d-985a-4991-ab8b-9ea1a46e6314`. Campos relevantes: `Descripción` (title), `Fecha` (date), `Resumen` (Notion AI summary), `Resumen Foco CAL` (text — cruce pre-computado por agente Notion AI contra Foco CAL), `Tareas` (relation).
- **Campo clave:** `Resumen Foco CAL` contiene los temas del Foco CAL que se avanzaron en la reunión, pre-procesados. Es la fuente primaria. `Resumen` es el fallback.

---

## Arquitectura

### Dos modos de entrada, un flujo compartido

```
MODO DAILY (6pm cron)              MODO ON-DEMAND (tool reviewMeetings)
      ↓                                        ↓
queryMeetingsToday()               Fase 1: queryMeetingsByRange(from, to)
                                   → lista meetings con indicador ✦
                                   Cal selecciona cuáles procesar
                                   Fase 2: queryMeetingDetails(ids[])
      ↓                                        ↓
                    FLUJO COMPARTIDO
                          ↓
              Por cada meeting seleccionado:
              ┌─────────────────────────────────┐
              │ Nivel 1 — Por meeting            │
              │ [✅ Loguear][⏭ Saltar][🔍 Trans.]│
              └─────────────────────────────────┘
                          ↓ (si Loguear)
              ┌─────────────────────────────────┐
              │ Nivel 2 — Por tema               │
              │ Temas de "Resumen Foco CAL"      │
              │ [✅ Sí][⏭ No] por cada tema      │
              └─────────────────────────────────┘
                          ↓ (aprobados)
                    logFocoProgress()
```

### Prioridad de fuente por meeting

```
¿Tiene "Resumen Foco CAL" poblado?
  Sí → mostrar temas directamente en Nivel 2
  No → mostrar [📄 Analizar con resumen] [🎙 Analizar con transcript]
       → LLM procesa → genera temas → Nivel 2
```

El callback `[🔍 Analizar con transcript]` también está disponible en meetings con `Resumen Foco CAL`, como análisis adicional.

---

## UX Telegram

### Nivel 1 — Meeting con Resumen Foco CAL

```
📋 Steerco Q2 · mar 20  ✦
[✅ Loguear] [⏭ Saltar] [🔍 Transcript]
```

### Nivel 1 — Meeting sin Resumen Foco CAL

```
📋 Reunión Legal · jue 22
[📄 Analizar con resumen] [🎙 Analizar con transcript] [⏭ Saltar]
```

### Nivel 2 — Temas para validación individual

```
📋 Steerco Q2 — ¿qué logueamos?

→ Estrategia afiliaciones Q2
  [✅ Sí] [⏭ No]

→ Alineación roadmap con Christian
  [✅ Sí] [⏭ No]

→ Revisión KPIs Q2
  [✅ Sí] [⏭ No]
```

Solo los `✅ Sí` se pasan a `logFocoProgress()`. El callback de análisis (📄/🎙) también desemboca en este mismo Nivel 2.

### On-demand — Fase 1 (selección de meetings)

```
📋 Meetings del 19–23 mayo (6 reuniones):
1. ✦ Steerco Q2 · mar 20
2. ✦ 1:1 Rufino · mar 20
3. ✦ Sync Christian · mié 21
4.   Reunión Legal · jue 22
5. ✦ All Hands · vie 23

¿Cuáles cruzamos contra tu Foco?
[1][2][3][4][5][Todas]
```

`✦` = tiene `Resumen Foco CAL` poblado.

---

## Modo Daily — Slot 6pm

En `foco-check.ts`, el slot de 6pm (lunes-viernes) se extiende:

1. **Fetch paralelo** (código, no LLM):
   - `queryMeetingsToday()` — meetings de hoy, campos: title, Fecha, Resumen Foco CAL, Resumen
   - Tareas de la semana (ya existe)
   - Foco CAL page (ya existe)
   - KPIs (ya existe)

2. **Si hay meetings hoy:** ejecutar flujo compartido (Nivel 1 → Nivel 2) antes del check-in de foco normal.

3. **Si no hay meetings:** proceder directamente al check-in de foco normal.

### Límite diario
Máximo 5 meetings procesados en modo daily. Si hay más, se procesan los 5 más recientes y se notifica cuántos se omitieron.

---

## Modo On-Demand — Tool `reviewMeetings`

### Parámetros
```typescript
reviewMeetings({ from: string, to: string })
// from/to: fechas en formato ISO o lenguaje natural ("esta semana", "lunes pasado")
```

### Fase 1
`queryMeetingsByRange(from, to)` — lista meetings del rango con título, fecha, y flag `hasFocoCal: boolean`.
Envía mensaje Telegram con lista + inline buttons numerados + [Todas].

### Fase 2
Cal selecciona → `queryMeetingDetails(ids[])` fetcha `Resumen Foco CAL` + `Resumen` de los seleccionados.
Procesa cada uno por el flujo compartido (Nivel 1 → Nivel 2).

### Límite on-demand
Opción B para rangos grandes: Fase 1 siempre muestra lista completa (sin límite). Fase 2 procesa solo los seleccionados por Cal.

---

## Tool `analyzeMeeting` (callback)

Disparado por [📄 Analizar con resumen] o [🎙 Analizar con transcript].

```typescript
analyzeMeeting({ meetingId: string, mode: "resumen" | "transcript" })
```

**mode "resumen":** Lee campo `Resumen` (Notion AI summary). Claude cruza contra Tareas activas + Foco CAL y genera lista de temas.

**mode "transcript":** Hace `notion-fetch` del page body de la reunión para extraer el bloque de transcript completo. Más tokens, resultado más detallado.

En ambos casos: output → Nivel 2 (temas con [✅ Sí][⏭ No]).

---

## Archivos

| Archivo | Cambio |
|---------|--------|
| `src/tools/meeting-notes.ts` (nuevo) | Tipos `MeetingNote`, `FocoTopic`. Funciones: `queryMeetingsToday()`, `queryMeetingsByRange(from, to)`, `queryMeetingDetails(ids[])` |
| `src/proactive/foco-check.ts` | Slot 6pm: fetch meetings + ejecutar flujo compartido antes del check-in |
| `src/agent-tools.ts` | Registrar `reviewMeetings` y `analyzeMeeting` |
| `src/agent-options.ts` | Whitelist: `mcp__cos-tools__reviewMeetings`, `mcp__cos-tools__analyzeMeeting` |
| Callback router | Nuevos callbacks: `meeting-log`, `meeting-skip`, `meeting-topic-yes`, `meeting-topic-no`, `meeting-analyze` |

**Sin cambios a:** `logFocoProgress()`, `buildApprovalFlow()`, `stepApprovalWizard()` — se reutilizan.

---

## Notion Query — Meetings DB

- **Collection ID:** `04f0447d-985a-4991-ab8b-9ea1a46e6314`
- **Herramienta MCP:** `mcp__claude_ai_Notion__notion-query-database-view`
- **Filtro daily:** `Fecha = today` (date filter)
- **Filtro on-demand:** `Fecha between from and to`
- **Campos leídos:** `Descripción` (title), `Fecha`, `Resumen Foco CAL`, `Resumen`
- **Transcript:** solo vía `mcp__claude_ai_Notion__notion-fetch` del page body (solo cuando Cal lo pide explícitamente)

---

## Casos edge

| Caso | Comportamiento |
|------|----------------|
| Meeting sin Resumen Foco CAL y sin Resumen | Muestra título + [🎙 Analizar con transcript] únicamente |
| Transcript muy largo | LLM recibe solo los primeros ~8000 caracteres del transcript |
| Cal dice "Todas" en on-demand con 20+ meetings | Procesa de a 5 meetings, avisa cuántos quedan |
| logFocoProgress falla | Muestra error en Telegram, no avanza al siguiente tema |
| No hay meetings hoy | 6pm check-in corre normal sin bloque de meetings |
