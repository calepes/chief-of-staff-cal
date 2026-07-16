# HANDOFF — Auditoría de seguridad/correctness Jano

**Fecha auditoría:** 2026-07-14
**Método:** agente de solo lectura (modelo Fable) sobre todo el repo — ningún cambio aplicado, esto es un plan de trabajo pendiente.
**Alcance:** `daemon-v2/`, `worker-v2/`, `shared-v2/`, `hooks/`, `telegram-plugin/`, plists, configs.

## Estado
**Actualizado 2026-07-14:** C1 y C4 resueltos, desplegados y con el daemon reiniciado (restart
confirmado limpio en logs). C2, C3, moderados y menores siguen sin tocar — ver detalle de cada uno
abajo.

## Prioridad de fix (sugerida)

### 1. C1 — Sin autorización de remitente en Telegram (el más grave)
Cualquier usuario que encuentre `@cal_jano_bot` tiene acceso a las 164 tools (Gmail, Calendar, borrar notas/eventos, datos personales de documento vía `generarQrAduanaBolivia`). No hay allowlist de `from.id` en ningún punto de la cadena worker→daemon.
- **Fix:** filtrar en `worker-v2/src/index.ts:61-86` por `message.from.id`/`callback_query.from.id` (allowlist: Cal, opcionalmente Noe/grupos conocidos). Replicar el check en `daemon-v2/src/index.ts:630-633` como defensa en profundidad.
- **RESUELTO (desplegado antes de esta auditoría):** allowlist de remitente por `from.id`/`callback_query.from.id` ya implementada en `worker-v2/src/index.ts` (`/telegram/webhook`) y replicada en `daemon-v2/src/index.ts` (`processMessage`) como defensa en profundidad. Confirmado 2026-07-14.

### 2. C2 — Lease de CF Queue (30s) vs turnos de minutos
`daemon-v2/src/queue-poller.ts:31` (`visibility_timeout_ms: 30000`), ack solo al final del batch completo (`index.ts:1108-1139`). Causa doble procesamiento en turnos largos y poison messages en loop infinito (nunca se ackea un mensaje que lanza excepción, `index.ts:1114-1116`; no hay DLQ en `wrangler.jsonc`).
- **Fix:** subir `visibility_timeout_ms` a ≥300000, ackear por mensaje (no al final del batch), dedupe por `update_id` en KV, contador de intentos para poison messages.

### 3. C3 — `pdf-parse` API v1 contra paquete v2 instalado
`daemon-v2/src/index.ts:410-415` usa `pdfParse(buf)` (API v1) pero `package-lock.json` fija `pdf-parse@2.4.5` (API v2, export `{ PDFParse }`). El `catch {}` (416-418) traga el TypeError → todo PDF de texto cae al OCR de visión, limitado a 3 páginas (`tools/vision.ts:39`).
- **Fix:** replicar el patrón ya correcto de `tools/schedule-cal.ts:5-6,223` (`const { PDFParse } = require("pdf-parse")` → `new PDFParse({data}).getText()`). ~5 líneas. Loguear el error en vez de tragarlo.

### 4. C4 — `runBriefing` con escalada de privilegios y roto
`tools/briefing.ts:108-126` spawnea `claude -p --dangerously-skip-permissions --allowedTools "Bash,..."` con prompt interpolado libre. Además las rutas (`briefing.ts:15-16`) apuntan a carpetas que ya no existen (`Chief of Staff Cal`, `calepes.github.io`).
- **Decisión pendiente:** retirar la tool del registro (hoy no funciona igual) o arreglar rutas + acotar el subprocess (sin `--dangerously-skip-permissions`, validar `fecha` con regex `^\d{4}-\d{2}-\d{2}$`).
- **RESUELTO 2026-07-14:** Cal decidió retirar la tool del registro (opción de menor riesgo). Eliminados: `daemon-v2/src/tools/briefing.ts` (archivo completo), el registro de la tool + import + `briefingDeps` en `agent-tools.ts`, la mención en `agent.ts` (`TOOL_MESSAGES`), y las 2 referencias en `system-prompt.ts`. `CLAUDE.md` actualizado (sacado del índice de tools). Build (`@cos/shared` + `@cos/daemon`) verificado limpio. Daemon reiniciado (`launchctl bootout`/`bootstrap`) y verificado en producción — logs limpios, sin rastro de `runBriefing`/`briefingDeps`, `state=running`.

## Moderados (después de los críticos)
- **M1** — `POST /panini/register` sin auth real (`worker-v2/src/index.ts:30-59`) + no maneja `web_app_data` (ruta muerta). Validar `initData` (HMAC) o eliminar.
- **M2** — `system-prompt.ts:128-129` referencia tools de salud viejas (`mcp__cos-tools__getHealthSummary/getHealthTrend`) que ya no existen. Borrar esas líneas (las correctas ya están en 514-516).
- **M3** — Lock KV no atómico (`cf-kv.ts:67-73`, get-then-set) + comentario stale sobre TTL de 20s (es 60s desde 2026-07-03).
- **M4** — Form 250 Aduana por HTTP plano (`tools/qr-aduana.ts:9`) — verificar si el sitio de la Aduana tiene HTTPS.
- **M5** — `hooks/morning-build-execute.sh` del repo divergido del deployado en `~/.cos-agent/` (el del repo sourcea `.env` viejo, patrón del incidente de leak). `telegram-plugin/` es modelo legacy sin referencias — archivar o borrar.
- **M6** — `tools/things.ts:102-108` (`thingsWrite`) devuelve `ok:true` incondicional sin verificar. `tools/resumir.ts:326-333` traga el motivo real de fallo de Readwise.
- **M7** — Wrappers CLI síncronos (`tools/readwise.ts`, `tools/notion-cli.ts`, timeout 30s) bloquean el event loop entero mientras corren.
- **M8** — Cache de Outlook (`tools/outlook.ts`) muerta desde el 13-jun (cron no existe en LaunchAgents), pero la tool la sirve igual sin chequear staleness.

## Menores (nice-to-have, sin urgencia)
`whisper.ts:46-52` fallback de modelo roto · HTML sin escapar en `approval-flow.ts:46-54` · `verifySecret` no constant-time · anotaciones `READ_ONLY` mal aplicadas en varias tools de escritura · entradas muertas en `TOOL_MESSAGES` · dependencia `@anthropic-ai/sdk` sin uso · `state.ts` append con carrera menor · CLAUDE.md desactualizado en sección Notion.

## Lo que ya está bien (no tocar)
Orden de carga de secretos correcto (agent .env → apps.env, first-wins), cero secretos hardcodeados, cero inyección de shell (todo `spawn`/`execFile` con argv arrays), webhook + fuel-alert autenticados, TTL mínimo de KV ya corregido y documentado, resiliencia del loop (backoff, heartbeat, alertas), resumidor con locks y cancelación cooperativa sólidos, tests unitarios donde importa.

## Notion
Documentación sincronizada a la DB "Agentes AI" (2026-07-15) reflejando el código post-C1/C4: 67 custom tools (bajó de 68 tras retirar `runBriefing`), 165 MCPs, System Prompt/CLAUDE.md actualizados, nota de arquitectura sobre el allowlist de remitente agregada. URL: https://app.notion.com/p/Jano-36bc487609dd81c7ad90f7259856cca4

## Siguiente paso
C2 (lease CF Queue), C3 (pdf-parse v2) y los hallazgos moderados/menores siguen sin tocar. Ejecutar de a uno con plan/diff aprobado por Cal antes de aplicar cada cambio (regla del proyecto: nunca modificar código de daemon sin confirmación explícita, y deploy/restart requieren confirmación separada del fix de código).

## Referencia
Transcript completo del agente de auditoría: buscar en el historial de la sesión del 2026-07-14 (agentId `afcba1af0d1f5e115`, no persistido fuera de esta conversación — si se pierde, re-lanzar la auditoría con el mismo prompt).
