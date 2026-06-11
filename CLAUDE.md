# Jano

## Qué es
**Jano** — Chief of Staff digital para Cal. Claridad y foco operativo. AI copilot que conoce el contexto de Yape, el equipo, los stakeholders, y las iniciativas en curso para ayudar con decisiones, priorización, preparación de reuniones, y seguimiento. Se presenta como "Jano" (no "CoS").

## Estado (2026-06-11)
**ACTIVO — CoS v2** (Node + Agent SDK librería + webhook + CF Queue).
- **Daemon activo:** `com.cal.cos-agent-v2` (Node 22, KeepAlive, plist en `~/Library/LaunchAgents/`). Bot `@cal_jano_bot` opera vía webhook → `cos-agent-worker.carlos-cb4.workers.dev` → CF Queue `cos-events` → daemon Node polea cola.
- **Activo (Vesta):** `com.cal.family-agent-v2` (mismo patrón). Bot `@antocatanoecal_bot`. Ver `Vesta/CLAUDE.md`.
- **Crons secundarios:** activos `extract-learnings` (21:55), `sync-learnings` (Dom 21:00). Pausados en `disabled-2026-04-21/`: `skill-detector`, `proactive-ideas` (bloqueado por tokens X/Threads).
- Reactivar un cron: `mv ~/Library/LaunchAgents/disabled-2026-04-2N/<plist> ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<plist>`. Antes de reactivar masivamente, confirmar con Cal.

## Separación de herramientas por scope
- **Jano (personal):** pendientes en Apple Reminders — lista "Personal" (tareas) y "Vibe Projects" (ideas/backlog). NO usar Notion para tareas.
- **Yapito (trabajo):** pendientes en Notion DB Tareas con tools custom. Ver `Yapito/CLAUDE.md`.
- Notion sí aplica en Jano para: búsquedas/memoria, Metas Salud, otras DBs — nunca para tareas.

## Arquitectura v2

```
Telegram → CF Worker /telegram/webhook
              ├─ light callback (t:d/t:c/t:s/t:sd) → callback-router edge (~300ms)
              ├─ j:* callback (menú interactivo) → CF Queue cos-events → daemon (mecánico ~50ms o LLM ~2-5s)
              └─ heavy / message → CF Queue cos-events
                                       ↓
                                 Mac daemon Node (Agent SDK + OAuth Max)
                                       ↓
                                 tools custom + MCPs heredados → Telegram API
```

- **Daemon Node:** `daemon-v2/src/index.ts` (Node 22, `@anthropic-ai/claude-agent-sdk` lib, OAuth Max creds en `~/.claude/.credentials.json`). Multimodal: voice (whisper-cli) + photo (Vision Sonnet 4.6) + PDF/DOCX.
- **Worker CF:** `worker-v2/src/index.ts` (Hono, valida `X-Telegram-Bot-Api-Secret-Token`). Callback router edge resuelve callbacks mecánicos sin LLM.
- **Shared:** `shared-v2/src/` (types `TelegramUpdate`, `QueueMessage`; helpers `sendMessage`/`editMessage`/`escapeMarkdownV2`/`answerCallbackQuery`).
- **Workspaces npm:** `package.json` define `daemon-v2`, `worker-v2`, `shared-v2`.

## Comandos operativos

```bash
# Build (REQUERIDO antes de restart si tocaste shared/ o daemon/)
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/shared run build && npm -w @cos/daemon run build

# Restart daemon
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist

# Logs / estado del proceso
tail -f ~/Library/Logs/cos-agent-v2.{out,err}.log
launchctl print gui/$(id -u)/com.cal.cos-agent-v2 | grep -E "state|pid"

# Deploy worker CF (después de cambiar worker-v2/)
cd worker-v2 && npx wrangler deploy

# Verificar / re-set webhook (el watchdog lo hace solo cada 1 min)
TOKEN=$(grep '^COS_TELEGRAM_BOT_TOKEN=' ~/.cos-agent/.env | cut -d= -f2-)
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | python3 -m json.tool
SECRET=$(grep ^COS_WEBHOOK_SECRET ~/.cos-agent/.env | cut -d= -f2-)
curl -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://cos-agent-worker.carlos-cb4.workers.dev/telegram/webhook\",\"secret_token\":\"${SECRET}\",\"allowed_updates\":[\"message\",\"callback_query\",\"edited_message\"]}"

# Inspeccionar contexto conversacional vivo en CF KV (debug TTL/memoria)
set -a; source ~/.cos-agent/.env; set +a
curl -s "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/cos-ctx:94137698" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" | python3 -m json.tool
```

Si el daemon está caído: debug via logs y restart. No hay flujo `claude --channels` (eliminado 2026-05-03, modelo Pecunia: webhook puro).

## Tools registradas en CoS

**Custom (MCP `cos-tools`, en `daemon-v2/src/agent-tools.ts`):**
- `getOutlookEvents` — lee cache pre-procesado por cron `com.claude.outlook-cache` (`tools/outlook.ts`).
- `runBriefing` — async wrapper para briefings on-demand (Bolivia/Peru/Colombia). Spawn detached de `claude -p`, lock por país en `~/.cos-agent/briefing-locks/`. Patrón "tool wrapper" para sortear `DISALLOWED_BUILTINS`. Ver `tools/briefing.ts`.
- `searchPlace(query, location?)` — Google Places API New. Requiere `GOOGLE_MAPS_API_KEY` + `HOME_PIN`. `tools/maps.ts`.
- `travelTime(origin, destination, departureTime?)` — Google Routes API v2, modo DRIVE, TRAFFIC_AWARE.
- `requestUserLocation` — ReplyKeyboard con `request_location: true` (botón GPS nativo). Triggear cuando Cal pregunta por distancia, ruta, tiempo de viaje.
- `getTokenUsage` — `total_pct` (todos los clientes vía API headers) + historial CC-local por día + burn rate. Wrappea `~/.claude/scripts/claude-usage.py json`. El LLM debe reenviar el resultado sin reformatear.
- `getWhatsappContacts`, `saveWhatsappContact` — gestión de contactos para links `wa.me`. Lee/escribe `~/.claude/whatsapp-contacts.md`. El link se genera en el LLM: `https://wa.me/{numero}?text={encodeURIComponent(msg)}`. `tools/whatsapp.ts`.
- `pptWizardSave(...)`, `pptWizardLoad()` — estado del wizard de presentaciones en CF KV (`ppt-wiz:{chatId}`, TTL 7200s). System prompt tiene los 4 pasos (SCQA → Storyline → Tipos → Contenido). `tools/ppt-wizard.ts`.
- `getFocoCalStatus()` — lee `~/.cos-agent/foco-progress.json` + punteros a Notion (focoPageId, kpisViewUrl, tareaViewUrl). Llamar cuando Cal pregunte por Foco, KPIs Yape (DAU/afiliaciones/TRX), o tareas Notion de la semana.
- `logFocoProgress({ itemText, section, note? })` — appends a `~/.cos-agent/foco-progress.json`. `section` es `z.enum(FOCO_SECTIONS)` de `tools/foco-cal.ts`.
- `fetchAsUser({ url })` — fetch con cookies de Safari de Cal (requiere FDA en `~/.npm-global/bin/node`). Devuelve texto stripeado de HTML, máx 50K. Solo si el LLM necesita el texto en contexto; para artículos largos usar `fetchAndSummarize`.
- `fetchAndSummarize({ url, instruction })` — descarga URL con cookies Safari + resumen en subprocess separado (`claude -p --tools ""`). El texto NO entra al contexto de Jano. Async. Usar siempre para artículos paywalled o largos. `tools/fetch-and-summarize.ts`.
- `readPersistedOutput({ path })` — lee archivos SDK persisted-output (`~/.claude/projects/*/tool-results/toulu_*.json`). Whitelist estricta de paths.

**Built-ins permitidas:** `Skill` (vuelos-bolivia, telegram-bot-ux, token-usage), `WebFetch`, `WebSearch`.

**MCPs heredados (OAuth Max claude.ai):** Google Calendar (8 tools), Notion (search, fetch, create-pages, update-page, query-database-view, get-users), Gmail (lecturas).

**MCPs custom registrados global (`~/.claude/.mcp.json` + wired en `BASE_OPTIONS.mcpServers` del daemon):**
- `youtube-transcribe` — `transcribeYoutube({url, lang?, paragraphs?, model?, forceWhisper?})`. Fast-path captions + fallback whisper.
- `exchange-rate-bolivia` — `getBcbRate` (oficial BCB) y `getBinanceP2PRate` (paralelo USDT/BOB). Cache 60s.
- `naabol-flights` — `getFlight`, `getFlights`, `getAirportFlights` para 12 aeropuertos NAABOL. Wraps CLI en `Apps/Aeropuertos Bolivia/`.
- `health` — `getHealthSummary`, `getHealthTrend`, `getWorkouts`. Requiere `HEALTH_API_KEY`.
- `apple-reminders` — `listReminderLists`, `listReminders`, `addReminder`, `editReminder`, `completeReminder`, `deleteReminder`. Vía `reminders-cli`.
- `combustible` — `getFuelStatus({ lat?, lon?, limit?, minLitros? })` disponibilidad gasolina 27 estaciones Santa Cruz.
- `feedbin` — reads (`getUnreadCount`, `getUnreadEntries`, `getEntryContent`, `markRead`, `searchEntries`...) + writes (`savePage`, `addSubscription`, `deleteSubscription`). **Gotcha:** pasar `subscription_id` (≠ `feed_id`) a `deleteSubscription`.
- `readwise` — MCP remoto oficial via `mcp-remote` bridge. 22 tools Reader + classic. Token `READWISE_TOKEN`. **Anti-thrashing:** system prompt fuerza `pageSize: 20` en todo call — NO quitar (sin límite, contexto se llena y autocompact entra en thrashing).
- `inversiones-query` — 8 tools de consulta del portafolio (`getPortfolioSummary`, `getDailyMovers`, `getPositionDetail`, etc.). Datos Kubera + Yahoo Finance. Requiere `KUBERA_AUTH_TOKEN`, `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`.

**Regla naabol-flights:** system-prompt fuerza usar `matches[].gate`/`estado`/`horaProgramada` literales cuando vienen poblados. PROHIBIDO decir "no puedo confirmar gate/delays" o repetir el campo `nota`. Mismo refuerzo en Vesta.

**Progress updates en Telegram:** `daemon-v2/src/agent.ts` tiene `TOOL_MESSAGES: Record<string, string>` — mapa de `mcp__<server>__<tool>` → mensaje visible en el placeholder mientras el tool corre. Agregar entry aquí al registrar un tool nuevo.

**Gotcha SDK librería:** `~/.claude/.mcp.json` solo lo lee el CLI de Claude Code. El daemon con `@anthropic-ai/claude-agent-sdk` librería NO lo lee — registrar custom MCPs en `BASE_OPTIONS.mcpServers` (`daemon-v2/src/index.ts`). Sin esto: "permissions not granted".

**Bloqueadas (`agent-options.ts` `DISALLOWED_BUILTINS`):** Bash, Read, Write, Edit, Glob, Grep, Task, Agent, TodoWrite, MCP discovery, ScheduleWakeup, CronCreate, EnterWorktree, Airtable writes, Gmail writes, Drive writes, Playwright (heredado de OAuth Max).

## Formato de respuestas Telegram (HTML)
- **REGLA ABSOLUTA posición en system-prompt:** el bloque `## FORMATO DE SALIDA — REGLA ABSOLUTA` debe estar al inicio del system-prompt (justo después de identidad), NO enterrado en UX. Si está lejos, el LLM usa `**bold**` en vez de `<b>bold</b>`.
- **Parse mode:** `HTML` (antes MarkdownV2, pero el LLM erraba escapes → Telegram rechazaba el parse).
- **Tags soportados:** `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a href>`. NO MarkdownV2.
- **Escape:** solo `< > &` (en `escapeHtml()` de `shared-v2/src/telegram.ts` y `daemon-v2/src/index.ts`).
- **Fallback robusto:** si HTML falla en el `editMessage`, `index.ts` reintenta con `parseMode=null` (texto plano). El placeholder "⚠️ No pude procesar tu mensaje" solo aparece si TODO falla.
- **Markdown safety net:** `sanitizeForTelegram(rawReply)` en `index.ts` (módulo `daemon-v2/src/format.ts`) convierte `**bold**`→`<b>`, `| table |`→`<pre>`, `---`→vacío, `- bullet`→`• bullet`. Para voice (TTS) se usa `rawReply` sin sanitizar.
- **Chunking 4096 chars:** `chunkText()` en `index.ts` parte respuestas largas (primer chunk = editMessage del placeholder; siguientes = sendMessage nuevos) para evitar `MESSAGE_TOO_LONG`.

## .env file daemon
- `~/.cos-agent/.env` (chmod 600). Vars específicas Jano: `COS_TELEGRAM_BOT_TOKEN`, `COS_WEBHOOK_URL`, `COS_WEBHOOK_SECRET`, `HOME_PIN`, `NOTION_TOKEN`, `HEALTH_API_KEY`, `READWISE_TOKEN`.
- **Secretos compartidos:** `dist/index.js` carga `~/.cos-agent/.env` PRIMERO, luego `~/.claude/secrets/apps.env` (dotenv no-override = first-wins). Tokens cross-agent (Anthropic, Notion, Airtable, CF, Maps, Health, Readwise, SerpAPI, Kubera) viven en apps.env. Override puntual en `.cos-agent/.env` siempre gana.
- Heartbeat: `~/.cos-agent/heartbeat`.

## Notion
- **Integración:** "Claude CoS" — conectada a DB de Tareas y People.
- **Prefijo MCP correcto:** `mcp__claude_ai_Notion__*` (heredado vía OAuth Max). NO usar `mcp__notion__*` — el daemon devuelve "permissions not granted" silenciosamente.
- **Referencia:** `~/Claude Projects/notion-reference.md` (cross-project, cargar bajo demanda).

## Referencias (cargar bajo demanda)
- **Menú interactivo + callbacks + flujos de tareas:** `docs/references/menu-telegram.md`
- **Hooks, crons, heartbeat, morning builds, skill detector, learnings:** `docs/references/hooks-automatizacion.md`
- **Viajes, calendarios, briefings, health, audio, /today:** `docs/references/viajes-calendarios.md`
- **Arquitectura completa:** `docs/ARCHITECTURE.md`
- **Backlog:** `BACKLOG.md`
- **Telegram cross-project:** `~/Claude Projects/telegram-reference.md`
- **Contexto Yape:** `~/Claude Projects/Yape/CLAUDE.md`
- **Specs/Planes:** `docs/superpowers/specs/` y `docs/superpowers/plans/`

## Gotchas del entorno
- **`ntn api` NO soporta `v1/databases/{id}/query`** — devuelve 400 `invalid_request_url`. Usar `v1/data_sources/{ds_id}/query`. El `data_source_id` ≠ `db_id` — ver `books.ts`.
- **Google Books API key distinta a Maps:** `GOOGLE_MAPS_API_KEY` no sirve para Google Books. Clave dedicada `GOOGLE_BOOKS_API_KEY` en `apps.env`.
- **Crons con `buildApprovalFlow`:** llamar `setCurrentChatId(chatId)` ANTES de `startup()`. Sin esto, `currentChatId = 0` y el flow envía al chat incorrecto.
- **PDF/DOCX en Telegram:** `processDocument()` en `index.ts` extrae texto con `pdf-parse` (PDF) o `mammoth` (DOCX), trunca a 50K. API `pdf-parse` v2: `new PDFParse({ data: new Uint8Array(buf) }).getText()`. Interop CJS/ESM via `createRequire`.
- **Bash 3.2 macOS** — sin associative arrays. Usar parallel arrays: `ARR=("k1|v1")` + `${entry%%|*}`/`${entry#*|}`.
- **`set -euo pipefail` + `grep -c` sin match** — grep exit 1, `-e` mata el script. Usar `set -uo pipefail` en scripts de status/conteo.
- **SNI filtering bloquea Telegram en ciertas redes** (WiFi guest, hoteles, captive portals): "Connection reset by peer" en TLS handshake. Daemon arranca pero el bot queda mudo. Diagnóstico: `curl -s https://api.telegram.org/bot$TOKEN/getMe` vacío mientras `curl https://google.com` funciona. Fix: cambiar red.
- **Debug estado launchd:** `launchctl print gui/$(id -u)/com.cal.<agent>` — más útil que `launchctl list | grep`.
- **`reminders show-lists` cuelga con pantalla bloqueada:** espera respuesta TCC sin sesión activa. En crons nocturnos puede colgar. Fix: `timeout 30s /opt/homebrew/bin/reminders ...`.
- **MCP `apple-reminders` `editReminder` no soporta priority ni dueDate:** el CLI `reminders-cli 2.5.1` solo edita title y `--notes`. Los flags se ignoran silenciosamente. El MCP throw-ea error claro. Para esos cambios: `deleteReminder + addReminder`.
- **`claude -p` del cron NO carga el system prompt del daemon:** si el cron necesita reglas de formato (HTML, sin Markdown, sin `---`, sin preámbulo) hay que duplicarlas literal en el prompt del script.
- **LLM puede alucinar workarounds cuando una tool falla silenciosa:** puede afirmar que ejecutó un workaround vía Bash/AppleScript aunque NO tenga esa tool. Validar siempre con outputs reales (re-list después del edit), no confiar en lo que narra.
- **`claude -p` subprocess con texto largo:** pasar prompts >10K chars via stdin (`child.stdin.write(text); child.stdin.end()`), NO como arg CLI. Flag para deshabilitar tools: `--tools ""` (`--no-tools` no existe).
- **Safari cookies TCC:** `fetchAsUser` requiere FDA en `~/.npm-global/bin/node` para leer `Cookies.binarycookies`. Parser de `.binarycookies` implementado desde cero en `tools/fetch-as-user.ts` (npm packages no sirven).
- **SDK persisted-output loop:** tool result >~25KB → SDK persiste a `toulu_*.json` y muestra preview 2KB. El LLM ignora `readPersistedOutput` y reintenta el tool. Solución real: `fetchAndSummarize` (el texto nunca entra al contexto).
- **compact.ts "bullets cortos" → Markdown en historial:** el prompt de compactación generaba `- bullet` Markdown → al inyectarse como historial, Sonnet lo replicaba. Fix: "Sin Markdown, sin bullets con guión — texto plano". Si reaparece Markdown en respuestas largas, verificar `daemon-v2/src/compact.ts`.
