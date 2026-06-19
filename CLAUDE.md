# Jano

**Chief of Staff digital de Cal.** Copilot personal (familia, bienestar, claridad, hábitos); también ayuda con trabajo (Yape) cuando Yapito no está. Se presenta como "Jano". Daemon `com.cal.cos-agent-v2`.

> Este CLAUDE.md es la guía **dev/ops** para trabajar SOBRE el repo. El **comportamiento** del bot en runtime vive en `daemon-v2/src/system-prompt.ts` (fuente de verdad), no acá.

## Scope de herramientas
- **Jano (personal):** TODAS las tareas y proyectos personales en **Things 3**. Dos tools (split por TCC): `executeClings` = LEER (clings/SQLite), `thingsWrite` = ESCRIBIR (URL scheme `things:///` vía `open`, headless-safe). Las escrituras de clings usan Apple Events → cuelgan bajo launchd; por eso el split.
- **Apple Reminders** vía `executeRemctl`: SOLO familia y mercado (listas: Tareas Familia, Mercado, Colegio AntoCata). Ya NO existe lista "Personal" en Reminders.
- **Yapito (trabajo):** pendientes en Notion DB Tareas. Ver `Yapito/CLAUDE.md`.
- Notion en Jano solo para: búsquedas/memoria, Metas Salud, otras DBs (vía `notionCli`/`notionPageMarkdown`).

## Dónde vive qué
| Tema | Fuente de verdad |
|---|---|
| Comportamiento / reglas / formato Telegram | `daemon-v2/src/system-prompt.ts` |
| Tools custom (implementación) | `daemon-v2/src/agent-tools.ts` |
| Permisos / DISALLOWED_BUILTINS / allowlist | `daemon-v2/src/agent-options.ts` |
| Registro de MCPs + su env | `daemon-v2/src/index.ts` (`BASE_OPTIONS.mcpServers`) |
| Schema de MCPs custom | `~/Claude Projects/Personal/MCP Servers/mcp-servers/CLAUDE.md` |
| Worker CF (webhook/callbacks) | `worker-v2/src/index.ts` |
| Arquitectura completa | `docs/ARCHITECTURE.md` |

## Comandos operativos
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
# Build (REQUERIDO antes de restart si tocaste shared/ o daemon/)
npm -w @cos/shared run build && npm -w @cos/daemon run build
# Restart daemon
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
# Logs / estado del proceso
tail -f ~/Library/Logs/cos-agent-v2.{out,err}.log
launchctl print gui/$(id -u)/com.cal.cos-agent-v2 | grep -E "state|pid"
# Deploy worker CF (tras cambiar worker-v2/)
cd worker-v2 && npx wrangler deploy
```
El watchdog re-setea el webhook solo cada 1 min. Re-set manual de webhook + debug de contexto en CF KV: ver `docs/ARCHITECTURE.md`.

## Índice de tools + MCPs
Implementación y detalle en código (ver "dónde vive qué"). Inventario:
- **Custom (`cos-tools`):** getOutlookEvents · runBriefing · searchPlace · travelTime · requestUserLocation · getTokenUsage · getWhatsappContacts/saveWhatsappContact · pptWizardSave/Load · getFocoCalStatus/logFocoProgress · fetchAsUser · fetchAndSummarize · readPersistedOutput · readwiseGetDailyReview · **executeClings** (leer Things) · **thingsWrite** (escribir Things, URL scheme) · **executeRemctl** (Reminders, familia/mercado) · notionCli/notionPageMarkdown/notionUpdateBody.
- **Built-ins:** Skill · WebFetch · WebSearch.
- **MCPs heredados (OAuth Max):** Google Calendar · Notion · Gmail (lectura).
- **MCPs custom:** youtube-transcribe · exchange-rate-bolivia · naabol-flights · health · apple-reminders · combustible · feedbin · readwise · inversiones-query · worldcup · spark · panini-mundial.

## .env / secrets — carga en runtime
Fuente: `daemon-v2/src/index.ts`.
1. **dotenv first-wins:** `~/.cos-agent/.env` PRIMERO → `~/.claude/secrets/apps.env`. No-override → el del agente pisa al compartido.
2. **Validación:** críticas con `requireEnv()` (throw si faltan): `CF_*`, `COS_TELEGRAM_BOT_TOKEN`, `NOTION_*`. Opcionales → `""`.
3. **MCPs custom:** cada uno spawneado con solo sus tokens vía `mcpServers[].env` (least-privilege).

| Credencial | Origen en runtime |
|---|---|
| API keys de servicios + bot token + Notion token | `.env` files (dotenv) |
| Auth Claude/Anthropic + MCPs heredados | OAuth Max en macOS Keychain |
| Tokens por-MCP custom | inyectados en `mcpServers[].env` |

## Gotchas del entorno
- **`ntn api` query:** usar `/v1/data_sources/{ds_id}/query`, NO `/v1/databases/{id}/query` (devuelve 400). El `data_source_id` ≠ `db_id`.
- **SDK librería NO lee `~/.claude/.mcp.json`:** registrar MCPs custom en `BASE_OPTIONS.mcpServers` (`daemon-v2/src/index.ts`). Sin esto: "permissions not granted".
- **Formato Telegram = HTML:** parse mode HTML, escapar solo `< > &`. NO MarkdownV2. `sanitizeForTelegram()` convierte Markdown rezagado. Detalle en `system-prompt.ts`.
- **PDF/DOCX:** `processDocument()` en `index.ts` (pdf-parse v2 / mammoth), trunca a 50K.
- **SNI filtering bloquea Telegram** en algunas redes (WiFi guest/hoteles): "Connection reset" en TLS. Daemon arranca pero el bot queda mudo. Diagnóstico: `curl -s https://api.telegram.org/bot$TOKEN/getMe` vacío mientras google.com funciona. Fix: cambiar red.
- **Debug estado launchd:** `launchctl print gui/$(id -u)/com.cal.cos-agent-v2` (más útil que `launchctl list | grep`).
- **`reminders` con pantalla bloqueada cuelga** (espera TCC). En procesos sin sesión: `timeout 30s reminders ...`.
- **Things 3 (`tools/things.ts`) — split read/write por TCC bajo launchd:** las ESCRITURAS de `clings` usan osascript/JXA (Apple Events) → cuelgan esperando permiso TCC de Automatización que no se puede responder en background (confirmado 2026-06-13: hasta `clings add`/`delete` interactivos cuelgan). **Lecturas** (`executeClings`, SQLite/FDA) sí funcionan. **Escrituras** van por URL scheme `things:///add|update` vía `open` (`thingsWrite`), que NO usa Apple Events → headless-safe. `things:///add` sin token; `things:///update` requiere `THINGS3_AUTH_TOKEN` (el wrapper lo agrega). `clings` está **`brew pin`-eado** (con reminders-cli) — un upgrade rompería el path versionado del Cellar y su binding FDA.
- **`fetchAsUser` requiere FDA** en `~/.npm-global/bin/node` (lee Cookies.binarycookies de Safari).
- **SDK persisted-output loop:** tool result >~25KB → SDK persiste a `toulu_*.json`; el LLM reintenta el tool. Solución: usar `fetchAndSummarize` (el texto no entra al contexto).
- **compact.ts → Markdown en historial:** si reaparece Markdown en respuestas largas, revisar el prompt de `daemon-v2/src/compact.ts` ("sin Markdown, texto plano").
- **Envío proactivo (no reactivo):** el daemon entrega la respuesta del agente vía `sendMessage` SOLO en el flujo reactivo (`processMessage`). En handlers PROACTIVOS (ej. `proactive/fuel-alert.ts`) el handler debe llamar `sendMessage` con el `reply` de `runAgent` él mismo — el agente NO tiene tool de envío; si el prompt dice "envía", intentará tools de notificación inexistentes y nada llega a Cal. Alternativa: tool que envía sola (patrón `buildApprovalFlow`/foco-check).
- **Fetch worker→worker por `*.workers.dev` se pierde en el edge CF** (mismo account). Usar **Service Binding** (ej. `combustible-proxy → cos-agent-worker` binding `JANO`, y viceversa). Síntoma: el POST "sale ok" pero nunca llega; el destino no registra el request.

## Notion
- Integración "Claude CoS" (DB Tareas + People). Prefijo MCP: `mcp__claude_ai_Notion__*`.
- Referencia cross-project: `~/Claude Projects/notion-reference.md` (bajo demanda).

## Referencias (cargar bajo demanda)
- Menú interactivo + callbacks + flujos de tareas: `docs/references/menu-telegram.md`
- Viajes, calendarios, briefings, health, audio, /today: `docs/references/viajes-calendarios.md`
- Arquitectura completa: `docs/ARCHITECTURE.md` · Backlog: `BACKLOG.md`
- Telegram cross-project: `~/Claude Projects/telegram-reference.md`
- Contexto Yape: `~/Claude Projects/Yape/CLAUDE.md`
- Specs/Planes: `docs/superpowers/specs/` y `docs/superpowers/plans/`

## Automatización — dos capas (NO confundir)
Hay dos mecanismos de proactividad independientes:

**1. Plists launchd (crons externos) — DESACTIVADOS 2026-06-13 (dormidos).**
7 plists `bootout` + archivados en `~/Library/LaunchAgents/disabled-2026-06-13/`. Cubrían heartbeat/learnings. Carpetas `heartbeat-tasks/`, `hooks/`, `launchd/` conservadas. Cómo era y cómo reactivar: `docs/references/hooks-automatizacion.md`.

**2. Crons internos del daemon (`node-cron`, dentro del proceso) — los apaga/prende el código, NO launchd.** En `index.ts` (`loop()`):
- `scheduleWebhookWatchdog()` — ACTIVO (re-set webhook cada 1 min; infra necesaria, no es proactividad hacia Cal).
- `scheduleFlightCheckin()` — **DESACTIVADO 2026-06-17** (check-ins de vuelos, every 30min 7-22h).
- `scheduleFocoCheckinsLocal()` — **DESACTIVADO 2026-06-17** (Foco CAL am/md/pm, `proactive/foco-check.ts`).

Ambos comentados juntos en `loop()`. Reactivar: descomentar la llamada correspondiente + rebuild + restart.

**Estado real (2026-06-19):** sin crons internos de proactividad (solo webhook watchdog, infra) Y **sin proactividad por evento externo** — el monitor de combustible se apagó 2026-06-19 (ver abajo). Hoy NO hay ninguna proactividad automática hacia Cal. Verificar qué crons internos arrancan: `grep -E "_scheduled" ~/Library/Logs/cos-agent-v2.out.log`.

## Monitor de combustible (alertas proactivas) — ⛔ APAGADO 2026-06-19
> El cron de `combustible-proxy` quemaba ~576 writes/día de KV (≈57% del free tier) → Cloudflare disparó alerta "50% daily KV limit". Apagado con `crons = []` + `enabled:false` en KV (`monitor_config`). Ya NO llegan `fuel_alert` a la cola. Reactivar: ver `~/Claude Projects/Personal/Apps/Combustible/repo/CLAUDE.md` (restaurar cron a `*/5`, no cada minuto; hacer el `put monitor_state` condicional). El flujo descrito abajo queda como referencia de cómo funcionaba.

Cron en `combustible-proxy` (CF, externo) detecta "llegó gasolina" → `POST /fuel/alert` (Service Binding) al worker de Jano → `QueueMessage{kind:"fuel_alert"}` → daemon `proactive/fuel-alert.ts` re-verifica litros y avisa a Cal. Config editable **por texto** vía tools del MCP `combustible` (`getFuelMonitorConfig/Status/setFuelMonitorConfig`); el menú es texto (los botones tappables se revirtieron 2026-06-18, no funcionaron en el Telegram de Cal). Endpoint `/fuel/alert` en `worker-v2/src/index.ts`; tipo `FuelEvent` en `shared-v2/src/types.ts`. Detalle: `~/Claude Projects/Personal/Apps/Combustible/repo/CLAUDE.md`.
