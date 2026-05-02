# Jano

## Qué es
**Jano** — Chief of Staff digital para Cal. Claridad y foco operativo. AI copilot que conoce el contexto de Yape, el equipo, los stakeholders, y las iniciativas en curso para ayudar con decisiones, priorización, preparación de reuniones, y seguimiento. Se presenta como "Jano" (no "CoS").

## Estado (2026-04-29)
**ACTIVO — CoS v2** (Node + Agent SDK librería + webhook + CF Queue).
- **Daemon activo:** `com.cal.cos-agent-v2` (Node 22, KeepAlive, plist en `~/Library/LaunchAgents/`). Bot `@cal_jano_bot` ahora opera vía webhook → `cos-agent-worker.carlos-cb4.workers.dev` → CF Queue `cos-events` → daemon Node polea cola.
- **Activo (Vesta):** `com.cal.family-agent-v2` (mismo patrón). Bot `@antocatanoecal_bot`. Ver `Vesta/CLAUDE.md`.
- **Plists viejos (`disabled-2026-04-29/`):** `com.cal.cos-agent` (plugin Telegram polling, sufría TCC reset y conflict 409).
- **Plists viejos Family (`disabled-2026-04-28/`):** `com.cal.family-agent`, `com.cal.family-check-recordatorios`.
- **Pausados (`disabled-2026-04-21/`):** 16 plists secundarios pendientes de rediseño (heartbeat, briefings, nightly-report, eisenhower-weekly, morning-build, skill-detector, proactive-ideas, outlook-cache, extract-learnings, sync-learnings, cos-health-check, family-briefings AM/PM, family-extrae-aprendizajes, family-health-check).
- **Hooks `settings.json` global ACTIVOS:** SessionStart `cos-channel-bootout.sh` + `family-channel-bootout.sh`; SessionEnd `*-bootstrap.sh`. Ahora ambos bots usan webhook — abrir `claude --channels` con bot default va a borrar el webhook (grammY `bot.start()`). El bootstrap hook lo restaura al cerrar la sesión; el watchdog del daemon también lo restaura cada 1 min como defensa.
- Reactivar un cron secundario: `mv ~/Library/LaunchAgents/disabled-2026-04-2N/<plist> ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<plist>`
- Antes de reactivar crons masivamente: confirmar con Cal si el rediseño ya sucedió

## Separación de herramientas por scope
- **Jano (personal):** pendientes en Apple Reminders — lista "Personal" (tareas) y "Vibe Projects" (ideas/backlog). NO usar Notion para tareas.
- **Yapito (trabajo):** pendientes en Notion DB Tareas con tools custom (listTasks, createTask, etc.). Ver `Yapito/CLAUDE.md`.
- Notion sí aplica en Jano para: búsquedas/memoria, Metas Salud, otras DBs — nunca para tareas.

## Arquitectura v2

```
Telegram → CF Worker /telegram/webhook
              ├─ light callback (menu/t:d/t:c/t:s/t:sd/nav)? → callback-router edge (~300ms)
              └─ heavy / message → CF Queue cos-events
                                       ↓
                                 Mac daemon Node (Agent SDK + OAuth Max)
                                       ↓
                                 9 tools custom + MCPs heredados → Telegram API
```

- **Daemon Node:** `daemon-v2/src/index.ts` (Node 22, `@anthropic-ai/claude-agent-sdk` lib, OAuth Max creds en `~/.claude/.credentials.json`). Multimodal: voice (whisper-cli) + photo (Anthropic Vision Sonnet 4.6).
- **Worker CF:** `worker-v2/src/index.ts` (Hono, valida `X-Telegram-Bot-Api-Secret-Token`). Callback router edge resuelve callbacks mecánicos sin LLM (~300ms latencia).
- **Shared:** `shared-v2/src/` (types `TelegramUpdate`, `QueueMessage`; helpers `sendMessage`/`editMessage`/`escapeMarkdownV2`/`answerCallbackQuery`).
- **Workspaces npm:** `package.json` define `daemon-v2`, `worker-v2`, `shared-v2`. Build con `npm -w @cos/shared run build && npm -w @cos/daemon run build`.

## Comandos operativos v2

```bash
# Restart daemon
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist

# Build (REQUERIDO antes de restart si tocaste shared/ o daemon/)
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/shared run build && npm -w @cos/daemon run build

# Logs
tail -f ~/Library/Logs/cos-agent-v2.{out,err}.log

# Estado del proceso
launchctl print gui/$(id -u)/com.cal.cos-agent-v2 | grep -E "state|pid"

# Deploy worker CF (después de cambiar worker-v2/)
cd worker-v2 && npx wrangler deploy

# Verificar webhook
TOKEN=$(grep '^COS_TELEGRAM_BOT_TOKEN=' ~/.cos-agent/.env | cut -d= -f2-)
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | python3 -m json.tool

# Re-set webhook (raro — el watchdog lo hace solo cada 1 min)
SECRET=$(cat ~/.cos-agent/webhook-secret.txt)
curl -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://cos-agent-worker.carlos-cb4.workers.dev/telegram/webhook\",\"secret_token\":\"${SECRET}\",\"allowed_updates\":[\"message\",\"callback_query\",\"edited_message\"]}"
```

## Tools registradas en CoS

**Custom (MCP `cos-tools`, en `daemon-v2/src/agent-tools.ts`):**
- ~~Notion tasks removidas 2026-05-02~~ — Jano usa Apple Reminders vía MCP `apple-reminders`. Ver sección "Separación de herramientas por scope".
- `getOutlookEvents` — lee cache pre-procesado por cron `com.claude.outlook-cache` (`tools/outlook.ts`).
- `runBriefing` (agregado 2026-04-29) — async wrapper para generar briefings on-demand (Bolivia/Peru/Colombia). Spawn detached de `claude -p` con mismo prompt que el cron de las 5am, lock por país en `~/.cos-agent/briefing-locks/`, child process notifica a Cal cuando termina via Telegram. Ver `tools/briefing.ts`. Patrón "tool wrapper" para sortear `DISALLOWED_BUILTINS` (Bash/Write bloqueados en el daemon, pero el subprocess los tiene).

**Built-ins permitidas:** `Skill` (vuelos-bolivia, telegram-bot-ux), `WebFetch`, `WebSearch`. **Removido `briefing-pais`** del Skill — el daemon no puede ejecutarlo (necesita Bash/Write); para briefings on-demand usar `runBriefing` en su lugar.

**MCPs heredados (OAuth Max claude.ai):**
- Google Calendar (8 tools incl. create/update/delete event)
- Notion (search, fetch, create-pages, update-page, query-database-view, get-users)
- Gmail (lecturas: search_threads, get_thread, list_drafts, list_labels)

**MCPs custom registrados global (`~/.claude/.mcp.json` + wired en `BASE_OPTIONS.mcpServers` del daemon):**
- `youtube-transcribe` — tool `transcribeYoutube({url, lang?, paragraphs?, model?, forceWhisper?})` con fast-path captions + fallback whisper local. Server stdio en `mcp-servers/servers/youtube-transcribe/`.
- `exchange-rate-bolivia` (agregado 2026-04-29) — `getBcbRate` (oficial BCB scrape) y `getBinanceP2PRate` (paralelo USDT/BOB merchant median + outlier filter). Cache 60s in-memory. Server en `mcp-servers/servers/exchange-rate-bolivia/`.
- `naabol-flights` (agregado 2026-04-29, antes era tool local de Vesta) — `getFlight`, `getFlights`, `getAirportFlights` para los 12 aeropuertos NAABOL. Wraps el CLI `~/Claude Projects/Personal/Apps/Aeropuertos Bolivia/cli/consultar-vuelo.mjs`. Server en `mcp-servers/servers/naabol-flights/`.
- `health` (agregado 2026-04-30) — `getHealthSummary`, `getHealthTrend`, `getWorkouts`. Migrado de custom tools (`tools/health.ts`) a MCP global. Requiere `HEALTH_API_KEY` en env. Server en `mcp-servers/servers/health/`.
- `apple-reminders` (agregado 2026-04-30) — `listReminderLists`, `listReminders`, `addReminder`, `editReminder`, `completeReminder`, `deleteReminder`. iOS Reminders personales de Cal vía `reminders-cli`. Server en `mcp-servers/servers/apple-reminders/`.

**Gotcha SDK librería:** el archivo `~/.claude/.mcp.json` solo lo lee el CLI de Claude Code. El daemon Node con `@anthropic-ai/claude-agent-sdk` librería NO lo lee — hay que registrar custom MCPs en `BASE_OPTIONS.mcpServers` (ver `daemon-v2/src/index.ts`). Confirmado bug 2026-04-29: el LLM intentaba llamar `mcp__youtube-transcribe__*` y recibía "permissions not granted" hasta que se agregó al BASE_OPTIONS.

**Bloqueadas (`agent-options.ts` `DISALLOWED_BUILTINS`):** Bash, Read, Write, Edit, Glob, Grep, Task, Agent, TodoWrite, Task*, MCP discovery, ScheduleWakeup, CronCreate, EnterWorktree, Airtable writes, Gmail writes, Drive writes.

## Formato de respuestas Telegram (HTML)
- **Parse mode:** `HTML` (cambio 2026-04-29; antes usaba MarkdownV2 pero el LLM se equivocaba con escapes — `+`, `~~` no escapados → Telegram rechazaba el parse → fallback "No pude procesar tu mensaje").
- **Tags soportados:** `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a href>`. NO usar MarkdownV2 (`*x*`, `_x_`).
- **Escape:** solo `< > &` (en `escapeHtml()` de `shared-v2/src/telegram.ts` y `daemon-v2/src/index.ts`).
- **Fallback robusto:** si HTML falla en el `editMessage`, `daemon-v2/src/index.ts:294` reintenta con `parseMode=null` (texto plano sin formato) — garantiza entrega aunque se pierda formato. El placeholder genérico "⚠️ No pude procesar tu mensaje" solo aparece si TODO falla.
- **Family/Vesta sigue en MarkdownV2** (mismo bug pendiente). Migración a HTML quedó en BACKLOG como Fase 3.

## Callback router edge (worker)

Light callbacks resueltos en CF Worker sin LLM (~300ms):
- `menu:<section>` — render estático desde `worker-v2/src/menu.ts`.
- `nav:<section>` — alias de menu.
- `t:d:<pageId32>` — mark task done (status="Listo").
- `t:c:<pageId32>` — complete (alias de done).
- `t:s:<pageId32>` — skip (no-op, solo ack).
- `t:sd:<pageId32>` — set fecha=hoy.

Heavy callbacks (requieren LLM): `task:date:<pageId>` (parse "el viernes"), `task:change:<pageId>`, `build:approve:<id>` — caen al daemon vía queue como mensaje sintético `[callback] data`.

Spotify callbacks (`spotify:*`) descartados por el worker (out of scope v2). Pendiente: agregar tool `spotifyControl` con lenguaje natural post-cutover.

## .env file daemon
- `~/.cos-agent/.env` (chmod 600). Vars: `CF_*`, `COS_TELEGRAM_BOT_TOKEN`, `NOTION_TOKEN`, `HEALTH_API_KEY`, `ANTHROPIC_API_KEY`, `COS_WEBHOOK_URL`, `COS_WEBHOOK_SECRET`.
- Webhook secret backup: `~/.cos-agent/webhook-secret.txt` (one-way en wrangler).
- Heartbeat: `~/.cos-agent/heartbeat`.

## Referencia clave
El diseño de este CoS se basa en el framework de Tal Raviv ("Build your personal AI copilot"):
- **Arquitectura:** `docs/ARCHITECTURE.md` — mapa de componentes (launchd, hooks, flujos, invariantes)
- **Guía de implementación:** `guia-implementacion-copilot.md` — checklist detallado paso a paso
- **Backlog:** `BACKLOG.md`
- **Artículo procesado:** `/Users/calepes/Claude Projects/Claude Code Setup/docs/articulos/01kcy4phpx-tal-raviv-personal-ai-copilot.md`

## Contexto de Yape
Ver: `/Users/calepes/Claude Projects/Yape/CLAUDE.md`

## Telegram Reference (cross-project)
Ver: `/Users/calepes/Claude Projects/telegram-reference.md` — referencia consolidada de bot, plugin fork, callbacks, UX patterns, integraciones, workers, y gotchas across all projects.

## Referencias complementarias
- `~/.claude/CLAUDE.md` (global) — instrucciones globales (idioma, planning, comunicación) + detalles del fork Telegram (source of truth, deploy, callback format)

## Telegram Bot (@cal_jano_bot)
- **Menú de comandos:** /briefing_bolivia, /briefing_peru, /today, /status, /tareas, /menu, /spotify
- **Menú interactivo:** Configurable en `~/.claude/channels/telegram/menu.json`. Skill `/menu` lee el JSON y envía botones inline.
- **Botones inline interactivos:** Fork del plugin con soporte para callbacks (ver sección fork en ~/.claude/CLAUDE.md)
- **Botones inline en reply:** El tool `reply` del fork soporta parámetro `buttons` — array de filas, cada fila array de `{text, callback_data}` o `{text, url}` (para deep links). El keyboard se adjunta al último chunk.
- **Callback format:** `[callback] prefix:action[:context]` — prefixes: menu, task, approve, spotify, nav
- **Callback optimization:** Prefijos mecánicos (t:d, t:c, t:s, t:sd, spotify:*) se procesan directo en el plugin (~200ms). Módulos: `callback-router.ts`, `notion-client.ts`
- **Navegación de menú:** Callbacks `menu:*` hacen edit mecánico instantáneo ("⏳ Cargando...") en el plugin, luego el LLM envía el contenido como **reply nuevo** (NO edit_message) sin botones callback, y restaura el menú original arriba. No usar edit para contenido porque el plugin destruye el mensaje al hacer edit mecánico
- **MAX_KEYBOARD_ROWS:** 4 filas máximo en inline keyboards (reply y edit_message) para evitar stutter en iOS
- **Notion token:** en `~/.cos-agent/.env` como `NOTION_TOKEN`
- **Progreso en tareas largas:** Enviar mensajes nuevos (no editar) para que cada update genere push notification
- **Fallback outbound si MCP desconectado:** `TOKEN=$(grep COS_TELEGRAM_BOT_TOKEN ~/.cos-agent/.env | cut -d= -f2-) && curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" -d "chat_id=94137698" --data-urlencode "text=..."` — funciona sin el plugin (solo outbound, no recibe mensajes entrantes)

### Flujos de revisión de tareas
- **<10 tareas:** Botones inline uno por uno con estado, asignado, deadline, emojis
- **>10 tareas:** Lotes de 5 + texto libre. Incluir: nombre, estado emoji, 👤 asignado, ⏰ deadline, ⚠️ si vencido
- **Callbacks mecánicos:** Usar pageId completo (32 hex) en callback_data (t:d:{id32}, t:c:{id32}, t:s:{id32})
- **Callbacks que requieren input:** Pasar al LLM (task:date, task:change, etc.)
- **Mapeo personas:** Al inicio del flujo, resolver Notion person page IDs → nombres

## Notion
- **Integración:** "Claude CoS" — conectada a DB de Tareas y People
- **Referencia:** `~/Claude Projects/notion-reference.md` (cross-project, cargar bajo demanda)

## Briefings
- **Skill:** /briefing-pais — genera HTML Liquid Glass, publica en GitHub Pages, notifica por Telegram
- **Output:** `https://apps.lepesqueur.net/dailynews/{Pais}/{Pais}-{YYYYMMDD}.html`
- **Repo:** calepes.github.io/dailynews/
- **Instrucciones:** `docs/briefing-pais-instructions.md` (copia del skill para agentes remotos)
- **Cron local:** 5:00am diario (launchd) — Bolivia, Perú, Colombia secuencialmente via claude CLI

## Apple Health (consumo)
Worker e infraestructura viven en el agente Health: `~/Claude Projects/Personal/Agents/Health/health-worker/`. Ver `Health/CLAUDE.md` para detalles completos.

**Metas Salud:** Notion DB `f929198356f14b148d205e4e6723646f` — metas de Cal (pasos, sueño, HRV, composición corporal). Leer antes de coaching personalizado via `mcp__notion__notion-query-database-view`.
**Métricas composición corporal en D1:** `body_fat_percentage`, `lean_body_mass`, `body_mass_index`. `weight`/`body_mass` NO está en D1 (no configurado en Health Auto Export).

**Endpoints (quick ref para consumir desde CoS):**
- `GET https://health.carlos-cb4.workers.dev/summary?date=YYYY-MM-DD&key=$HEALTH_API_KEY` — resumen del día
- `GET https://health.carlos-cb4.workers.dev/trend?metric=X&days=N&key=$HEALTH_API_KEY` — tendencia
- API Key: `~/.cos-agent/.env` como `HEALTH_API_KEY`

**Uso en /today:** sección 🏥 Salud si hay data disponible.
**Triggers naturales:** "cómo dormí", "pasos hoy", "salud semana", "peso".

## Gestión de Viajes
- **Fuente:** Flighty (iOS) → sincronizado a Google Calendar "AntoCataNoeCal"
- **Calendar ID:** `c_4c2ogsnda3b61k1sd9eta6vc2k@group.calendar.google.com`
- **Cada evento incluye:** booking code, horarios, ruta
- **Check-in BoA:** Safari real via AppleScript (Playwright bloqueado por WAF Incapsula/Amadeus)
  - `osascript -e 'tell application "Safari" to do JavaScript "..." in current tab of front window'`
  - Prerrequisito: Safari > Settings > Developer > "Allow JavaScript from Apple Events"
  - Iframe Amadeus cross-origin → usar System Events clicks `{x, y}` (requiere Accessibility)
  - Flujo: boa.bo → cookies → Start Check-in → form (apellido + locator) → submit → iframe Amadeus
  - Boarding pass se envía a Cal via Telegram (screenshot fullPage)
- **Preferencia asiento:** el más adelante en pasillo; si no hay, el más adelante en fila del medio
- **Triggers naturales:** "check-in vuelo", "próximo vuelo", "viajes esta semana"

## Learnings históricos
- **Index:** `~/.claude/learnings/cos/index.md` — consultar antes de tomar decisiones técnicas, cambios estructurales, o cuando Cal mencione un tema con histórico (telegram, notion, heartbeat, claude-md, etc.). El index es chico (~1-2KB), abrir archivo de detalle solo si la línea relevante lo amerita
- **Captura:** skill `/learn <tipo> "<desc>"` (intencional) + hook `learn-error.sh` (errores automáticos, solo cuando exit_code != 0) + batch nocturno 21:55 `extract-learnings.sh` (red de seguridad + patterns)
- **Hook feedback loop evitado:** `learn-error.sh` solo dispara en `exit_code != 0`. Antes revisaba "error" en output text y se auto-capturaba al ver "errors.md" en sus propios logs
- **Review:** integrado en nightly-report 22:00 con botones inline `learn:keep|drop|keepall|dropall` (mecánicos en el plugin fork)
- **Sync:** domingo 21:00 a `docs/learnings/` del repo (plist creado, no cargado aún — requiere aprobación de Cal)
- **Status/observabilidad:** `~/.claude/hooks/learnings-status.sh` — cursor, pendings por tipo, top errores, último log
- **Recovery:** `~/.claude/hooks/rebuild-learnings-index.sh` regenera index desde archivos de detalle
- **Tipos:** `correction | pattern | error | decision | idea`
- **Spec/plan:** `docs/superpowers/specs/2026-04-19-self-improving-learnings-design.md` + `docs/superpowers/plans/2026-04-19-self-improving-learnings.md`

## Morning Builds (Fase 5.2)
- **Generator:** `~/.claude/hooks/morning-build.sh` — cron 22:30, lee contexto del día (git log, learnings pending, heartbeat log, tareas mañana), invoca `claude -p` con `morning-build-prompt.md`, guarda propuesta JSON a `~/.claude/morning-builds/proposals/`, manda a Telegram con botones ✅/❌
- **Executor:** `~/.claude/hooks/morning-build-execute.sh <id>` — disparado por callback `build:approve:<id>` (async via `spawn` detached). Lee propuesta, corre `claude -p` con `morning-build-exec-prompt.md` (scope restringido), clasifica output `DONE|ABORT|FAIL`, mueve a `implemented/failed/`, notifica Telegram
- **Scope de ejecución permitido (estricto):** `commands/*`, `heartbeat-tasks/*`, `hooks/*.sh`, `CLAUDE.md`, `BACKLOG.md`, `CHANGELOG.md`, `docs/**/*.md`. NO plugin TS, NO workers, NO plists, NO settings.json
- **Callbacks:** `build:approve:<id>` dispara exec async; `build:reject:<id>` archiva a `rejected/`
- **Plist:** `com.claude.morning-build` (cargado 2026-04-20, schedule diario 22:30)
- **Flujo:** propuesta llega 22:30 → Cal tap ✅ → executor corre en background (max 30min) → notifica resultado con commit hash

## Skill Detector (Fase 5.3)
- **Detector:** `~/.claude/hooks/skill-detector.sh` — cron domingo 21:30. Escanea transcripts de últimos 7 días del CoS, invoca `claude -p` con `skill-detector-prompt.md`, detecta patrones conductuales con frecuencia ≥3/semana, genera JSON con skill completo (`name`, `titulo`, `skill_body`, `ejemplos_triggers`, `frecuencia_semana`)
- **Installer:** `~/.claude/hooks/skill-install.sh <id>` — disparado por callback `skill:approve:<id>` (async). Escribe `commands/<name>.md` + `~/.claude/commands/<name>.md`, commit + push. NO pasa por LLM — es mecánico (body ya viene generado en el JSON)
- **Callbacks:** `skill:approve:<id>` dispara installer; `skill:reject:<id>` archiva a `rejected/`
- **Plist:** `com.claude.skill-detector` (creado, NO cargado)
- **Criterio:** solo propone skills con frecuencia ≥3 veces en la semana Y que no dupliquen skills existentes. Si duda → `null`
- **Gotcha find macOS:** `find -newermt "@epoch"` NO funciona en macOS. Usar `-mtime -7` para rangos, o `touch -t` + `-newer <ref>` para cursor exacto (ver `extract-learnings.sh`)

## Gotchas del entorno
- **PDF/DOCX en Telegram (2026-04-30):** soporte de documentos en `daemon-v2/src/index.ts` (`processDocument()`). Descarga via `downloadTelegramFile`, extrae texto con `pdf-parse` (PDF) o `mammoth` (DOCX/DOC), trunca a 50K chars. Dependencias instaladas en root del workspace (hoisted por npm). API de `pdf-parse` v2: `new PDFParse({ data: new Uint8Array(buf) }).getText()` — ya NO es la función directa `pdfParse(buffer)` de v1. Interop CJS/ESM via `createRequire(import.meta.url)('pdf-parse')`.
- **Bash 3.2 macOS default** — sin associative arrays (`declare -A` falla con `unbound variable` silencioso). Usar parallel arrays: `ARR=("key1|val1" "key2|val2")` + parse con `${entry%%|*}` / `${entry#*|}`
- **`set -euo pipefail` + `grep -c` sin match** — grep devuelve exit 1, `-e` mata el script silencioso. Usar `set -uo pipefail` en scripts de status/conteo
- **Plugin Telegram cache tiene 0.0.5 y 0.0.6** — el deploy con wildcard `telegram/*/` las cubre ambas, no quitar versiones viejas hasta confirmar cuál usa el harness
- **PostToolUse hook `tool_response`** no tiene `exit_code` top-level para Bash — el hook asume 0 por default. Filtrar errores por contenido de output es ruidoso (feedback loops); mejor asumir que el harness pasa solo errores reales
- **SNI filtering bloquea Telegram en ciertas redes**: algunas WiFi (guest, hoteles, captive portals) bloquean `api.telegram.org` con "Connection reset by peer" durante TLS handshake. Daemon arranca OK pero no puede hacer polling, bot queda mudo. No es la oficina por default — es red-específico. Diagnóstico rápido: `curl -s https://api.telegram.org/bot$TOKEN/getMe` devuelve vacío mientras `curl https://google.com` funciona. Fix: cambiar red (hotspot iPhone o VPN)
- **Zombies de bun tras kill mal del cos-agent**: si `kill` del agent no limpia su subprocess `bun server.ts`, quedan haciendo polling huérfanos y causan conflict 409 al próximo arranque. Limpiar con `pkill -9 -f "bun server.ts"` antes de `launchctl bootstrap`
- **Debug estado launchd:** `launchctl print gui/$(id -u)/com.cal.<agent>` muestra estado detallado (running/failed, PID, PATH, args). Más útil que `launchctl list | grep` cuando algo no arranca
- **Webhook drift cada 60s (2026-05-02):** causado por `telegram@claude-plugins-official: true` en `~/.claude/settings.json` + `channelsEnabled: true` → el plugin Telegram arranca en cada sesión de Claude Code y llama `deleteWebhook()`. Fix: setear a `false` en enabledPlugins. Para restaurar webhook manualmente: `TOKEN=$(grep COS_TELEGRAM_BOT_TOKEN ~/.cos-agent/.env | cut -d= -f2-) && SECRET=$(cat ~/.cos-agent/webhook-secret.txt) && curl -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" -H "Content-Type: application/json" -d "{\"url\":\"https://cos-agent-worker.carlos-cb4.workers.dev/telegram/webhook\",\"secret_token\":\"${SECRET}\"}"`

## Comandos operativos

### Telegram channel
```bash
claude --channels plugin:telegram@claude-plugins-official
```

### Deploy plugin fork (después de editar telegram-plugin/)
```bash
cp telegram-plugin/{server,notion-client,callback-router}.ts \
  ~/.claude/plugins/cache/claude-plugins-official/telegram/*/
```

### Deploy workers
```bash
# Health worker vive en el agente Health:
cd ~/Claude\ Projects/Personal/Agents/Health/health-worker && npx wrangler deploy
```

### Heartbeat recovery (después de "heartbeat caído")
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claude.heartbeat.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.heartbeat.plist
echo 0 > ~/.claude/state/heartbeat-failures
~/.claude/hooks/heartbeat.sh --only <check-name> --dry-run  # smoke test
```

### Test heartbeat puntual
```bash
~/.claude/hooks/heartbeat.sh --only <check-name> --dry-run  # bypassa schedule, no envía Telegram
~/.claude/hooks/heartbeat-status.sh                         # estado general del engine
```

## Hooks & Automatización
- **SessionStart hook:** `~/.claude/hooks/session-start-context.sh` — inyecta fecha/hora + recordatorios Apple + instrucción GCal. **Registrado** en `~/.claude/settings.json` (activo 2026-05-02)
- **Channel conflict guard (SessionStart/SessionEnd):** `.claude/settings.json` del proyecto registra dos hooks:
  - `cos-channel-bootout.sh` (SessionStart): si la sesión interactiva usa `--channels plugin:telegram` con el bot default, descarga el launchd agent `com.cal.cos-agent` para que no compitan por `getUpdates` (Telegram long-poll solo permite UN consumidor por bot → conflict 409 reparte mensajes aleatoriamente)
  - `cos-channel-bootstrap.sh` (SessionEnd): cuando cierras la última sesión interactiva del CoS, recarga el cos-agent para que retome escucha en background
  - `family-channel-bootout.sh` / `family-channel-bootstrap.sh` (SessionStart/End): equivalentes para sesiones con `TELEGRAM_STATE_DIR=...telegram-family`. Family v2 ya usa webhook (no polling), pero los hooks siguen siendo defensivos para evitar que una sesión `--channels` accidental tumbe el webhook (grammY `bot.start()` llama `deleteWebhook` automático).
  - **Invariante:** nunca corren simultáneo agent launchd + sesión interactiva del mismo bot. Siempre hay exactamente un consumidor activo
  - Ignora sesiones con `TELEGRAM_STATE_DIR=` custom (ej. family-agent usa otro bot)
  - **Anti self-sabotage:** el plist del cos-agent tiene `COS_AGENT_BG=1` en env — los hooks lo chequean y exit 0 si corren dentro del propio agent (sin esto, el SessionStart del agent haría bootout de su propio launchd → KeepAlive respawn → loop spawneando bun zombies). Misma lógica en Family con `FAMILY_AGENT_BG=1`
  - Si abres múltiples sesiones interactivas, el bootstrap espera hasta cerrar la última
- **Stop hook:** `~/.claude/hooks/stop-telegram-notify.sh` — notifica vía @ClaudeCalbot en `end_turn`. **NO registrado** — dispara en toda sesión CLI incluyendo crons (demasiado ruidoso). Usa `~/.claude/notifications/.env:NOTIF_BOT_TOKEN`.
- **PostToolUse hook:** `~/.claude/hooks/learn-error.sh` — captura errores de tools. **Registrado** en `~/.claude/settings.json` (activo 2026-05-02)
- **PreCompact hook:** `~/.claude/hooks/pre-compact-snapshot.sh` — copia transcript a `~/.claude/compact-snapshots/` antes de compactar (últimos 20). Notifica Telegram si trigger=manual
- **PostToolUse hook (Notion):** `~/.claude/hooks/notion-audit.sh` — filtrado a `mcp__notion__.*` (solo writes). Loguea a `~/.claude/logs/notion-audit.log` con rotación a 5MB
- **Outlook cache:** `~/.claude/hooks/refresh-outlook-cache.sh` — descarga ICS, extrae hoy/mañana, guarda en `~/.claude/hooks/cache/outlook-events.txt`
- **Cron Outlook:** launchd `com.claude.outlook-cache` — cada 4 horas + al boot
- **Cron Briefings:** launchd `com.claude.daily-briefings` — 5:00am diario, genera briefings Bolivia + Perú + Colombia via claude CLI. Usa `gtimeout` 15min por país (coreutils). Notifica errores a Telegram via curl
- **Cron Reporte nocturno:** launchd `com.claude.nightly-report` — 22:00 diario, ejecuta `~/.claude/hooks/nightly-report.sh`. Resumen día + plan mañana via Telegram
- **Cron Eisenhower semanal:** launchd `com.claude.eisenhower-weekly` — domingo 21:00, ejecuta `~/.claude/hooks/eisenhower-weekly.sh`. Clasifica tareas activas en matriz Q1-Q4 via Telegram
- **Heartbeat engine:** launchd `com.claude.heartbeat` — cada 30min de 7am a 22:30. `~/.claude/hooks/heartbeat.sh` lee `~/.claude/heartbeat-tasks/*.md` (frontmatter `schedule`+`priority`), ejecuta cada check con `claude -p` (timeout 60s), agrupa ALERTs por prioridad en un único mensaje a Telegram. Failure counter en `~/.claude/state/heartbeat-failures` → alerta si ≥3 consecutivos. Status: `~/.claude/hooks/heartbeat-status.sh`. Flags: `--dry-run`, `--only <name>` (este último bypassa el filtro de `schedule` para testing). Repo copies: `hooks/heartbeat*.sh`, `heartbeat-tasks/`, `launchd/com.claude.heartbeat.plist`
- **Gotcha launchd PATH:** Plists que invocan `claude` CLI DEBEN incluir `/Users/calepes/.local/bin` (claude) y `/Users/calepes/.bun/bin` (bun, usado por MCP servers de plugins como el de Telegram) en `EnvironmentVariables.PATH`. Sin claude: `gtimeout: failed to run command 'claude'` y silencio (heartbeat caído tras 3 fallos). Sin bun: plugin MCP falla con "1 MCP server failed", daemon arranca pero sin polling (bot no recibe mensajes)
- **Heartbeat checks actuales:**
  - **Tasks/calendario:** `overdue-tasks.md` (every/high), `flight-checkin.md` (every/high), `incomplete-tasks.md` (morning-only/medium), `midday-steps.md` (midday-only/medium)
  - **Health (4.3):** `health-sleep.md` (morning-wake/high — anoche <6h), `health-steps-evening.md` (evening/medium — <6k a las 17-19h), `health-sedentary.md` (business-hours/low — <70% stand hours esperados), `health-hrv-weekly.md` (weekly-monday-am/medium — HRV semana <80% baseline 4 sem), `health-daylight.md` (late-afternoon/low — <15min daylight), `health-strength-weekly.md` (weekly-monday-am/medium — <3 sesiones strength/sem, meta 3x), `health-bodycomp-weekly.md` (weekly-monday-am/low — recordatorio medir o trend body fat/lean mass)
  - **Schedules adicionales:** `morning-wake` (7-9am), `evening` (17-19h), `business-hours` (10-19h L-V), `weekly-monday-am` (Lun 8-9am), `late-afternoon` (17-18h)
  - **Anti-spam:** state file `~/.claude/state/health-alerts-YYYY-MM-DD.json` con 1 alerta/día por tipo. Cleanup automático >7 días al inicio de cada heartbeat run
  - **Spec/plan:** `docs/superpowers/specs/2026-04-19-health-alerts-design.md` + `docs/superpowers/plans/2026-04-19-health-alerts.md`
  - **Agregar nuevo check:** Crear `~/.claude/heartbeat-tasks/<name>.md` con frontmatter `name`, `schedule`, `priority`. Body = prompt para `claude -p`. Output esperado: `ALERT\n<msg>` o `HEARTBEAT_OK`. Copiar también a repo `heartbeat-tasks/`. Sin reload — engine lee dinámicamente
- **Proactive ideas:** launchd `com.claude.proactive-ideas` — 9am/14:00/19:00. `~/.claude/hooks/proactive-ideas.sh` lee posts X+Threads últimas 24h + tareas Notion → idea JSON → escribe a Notion DB "Ideas Proactivas (CoS)" (id `59e0439d7fe0483ab735575b9e0c1007`) + Telegram. Slots: foco 🎯, tactical ⚡, lookahead 🔮. Plist creado pero NO cargado: requiere `X_BEARER_TOKEN`, `X_USER_ID`, `THREADS_TOKEN`, `THREADS_USER_ID`, `NOTION_TASKS_DB_ID`, `NOTION_IDEAS_DB_ID` en `~/.cos-agent/.env` + DB compartida con integración. Cargar con: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.proactive-ideas.plist`
- **Status line:** muestra `fecha hora | proyecto | contexto | modelo`, refreshInterval 60s
- **Config:** `~/.claude/settings.json` (hooks) + `~/.claude/statusline-command.sh`
- **Skill telegram-miniapp:** guía global para construir TWAs — checklist, gotchas, boilerplate
- **Menú bot Telegram:** `scripts/setup-menu-button.sh` — configura setChatMenuButton con Mini App (actual: Spotify Mini App). Re-ejecutar para cambiar label/URL

## Skill /today
- **Ubicación:** `~/.claude/commands/today.md`
- **Secciones:** scope (proyecto vs panorama), calendario (Outlook + Google), salud (health worker), tareas Notion (semana actual agrupadas por asignado)

## Audio
- whisper-cli: `/opt/homebrew/bin/whisper-cli` · modelo: `/opt/homebrew/share/whisper-cpp/models/ggml-base.bin`
- Flujo transcripción nota de voz Telegram (OGA):
  ```
  ffmpeg -hide_banner -loglevel error -y -i IN.oga -ar 16000 -ac 1 OUT.wav
  whisper-cli -m /opt/homebrew/share/whisper-cpp/models/ggml-base.bin -l es -nt -f OUT.wav
  ```

## Specs y Planes
- **Specs:** `docs/superpowers/specs/` — diseños aprobados
- **Planes:** `docs/superpowers/plans/` — planes de implementación paso a paso
- **Callback Optimization:** `2026-04-11-callback-optimization-*`
- **Inline Buttons Menu:** `2026-04-11-inline-buttons-menu-*`
- **Spotify Control:** `2026-04-11-spotify-control-*`
- **Apple Health:** `2026-04-11-apple-health-*`
- **Spotify Mini App:** `2026-04-12-spotify-miniapp-*`
