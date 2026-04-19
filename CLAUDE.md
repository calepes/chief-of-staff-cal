# Chief of Staff Cal

## Qué es
Chief of Staff digital para Cal — claridad y foco operativo. AI copilot que conoce el contexto de Yape, el equipo, los stakeholders, y las iniciativas en curso para ayudar con decisiones, priorización, preparación de reuniones, y seguimiento.

## Referencia clave
El diseño de este CoS se basa en el framework de Tal Raviv ("Build your personal AI copilot"):
- **Guía de implementación:** `guia-implementacion-copilot.md` — checklist detallado paso a paso
- **Backlog:** `BACKLOG.md`
- **Artículo procesado:** `/Users/calepes/Documents/Claude Projects/Claude Code Setup/docs/articulos/01kcy4phpx-tal-raviv-personal-ai-copilot.md`

## Contexto de Yape
Ver: `/Users/calepes/Documents/Claude Projects/Yape/CLAUDE.md`

## Telegram Reference (cross-project)
Ver: `/Users/calepes/Documents/Claude Projects/telegram-reference.md` — referencia consolidada de bot, plugin fork, callbacks, UX patterns, integraciones, workers, y gotchas across all projects.

## Telegram Bot (@calclaudecode_bot)
- **Menú de comandos:** /briefing_bolivia, /briefing_peru, /today, /status, /tareas, /menu, /spotify
- **Menú interactivo:** Configurable en `~/.claude/channels/telegram/menu.json`. Skill `/menu` lee el JSON y envía botones inline.
- **Botones inline interactivos:** Fork del plugin con soporte para callbacks (ver sección fork en ~/.claude/CLAUDE.md)
- **Botones inline en reply:** El tool `reply` del fork soporta parámetro `buttons` — array de filas, cada fila array de `{text, callback_data}` o `{text, url}` (para deep links). El keyboard se adjunta al último chunk.
- **Callback format:** `[callback] prefix:action[:context]` — prefixes: menu, task, approve, spotify, nav
- **Callback optimization:** Prefijos mecánicos (t:d, t:c, t:s, t:sd, spotify:*) se procesan directo en el plugin (~200ms). Módulos: `callback-router.ts`, `notion-client.ts`
- **Navegación de menú:** Callbacks `menu:*` hacen edit mecánico instantáneo ("⏳ Cargando...") en el plugin, luego el LLM envía el contenido como **reply nuevo** (NO edit_message) sin botones callback, y restaura el menú original arriba. No usar edit para contenido porque el plugin destruye el mensaje al hacer edit mecánico
- **MAX_KEYBOARD_ROWS:** 4 filas máximo en inline keyboards (reply y edit_message) para evitar stutter en iOS
- **Notion token:** en `~/.claude/channels/telegram/.env` como `NOTION_TOKEN`
- **Progreso en tareas largas:** Enviar mensajes nuevos (no editar) para que cada update genere push notification

### Flujos de revisión de tareas
- **<10 tareas:** Botones inline uno por uno con estado, asignado, deadline, emojis
- **>10 tareas:** Lotes de 5 + texto libre. Incluir: nombre, estado emoji, 👤 asignado, ⏰ deadline, ⚠️ si vencido
- **Callbacks mecánicos:** Usar pageId completo (32 hex) en callback_data (t:d:{id32}, t:c:{id32}, t:s:{id32})
- **Callbacks que requieren input:** Pasar al LLM (task:date, task:change, etc.)
- **Mapeo personas:** Al inicio del flujo, resolver Notion person page IDs → nombres

## Notion
- **Integración:** "Claude CoS" — conectada a DB de Tareas y People
- **Referencia:** `~/Documents/Claude Projects/notion-reference.md` (cross-project, cargar bajo demanda)

## Briefings
- **Skill:** /briefing-pais — genera HTML Liquid Glass, publica en GitHub Pages, notifica por Telegram
- **Output:** `https://apps.lepesqueur.net/dailynews/{Pais}/{Pais}-{YYYYMMDD}.html`
- **Repo:** calepes.github.io/dailynews/
- **Instrucciones:** `docs/briefing-pais-instructions.md` (copia del skill para agentes remotos)
- **Cron local:** 5:00am diario (launchd) — Bolivia, Perú, Colombia secuencialmente via claude CLI

## Spotify
- **Worker OAuth:** `https://spotify-auth.carlos-cb4.workers.dev` (login, callback, token refresh) — **desplegado y autenticado**
- **Credenciales:** `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` en secrets del Worker; `SPOTIFY_AUTH_WORKER_URL` en `~/.claude/channels/telegram/.env`
- **KV namespace:** `spotify-auth-SPOTIFY_TOKENS` (access_token + refresh_token)
- **Client module:** `telegram-plugin/spotify-client.ts` — play, pause, skip, nowPlaying, setVolume
- **Callbacks mecánicos:** spotify:play, spotify:pause, spotify:skip, spotify:back, spotify:volup, spotify:voldown (procesados directo en el plugin)
- **Búsqueda y discovery:** pasa por el LLM ("pon algo de Coldplay", "qué suena")

## Spotify Mini App (TWA)
- **Worker:** `https://spotify-miniapp.carlos-cb4.workers.dev` — **desplegado**
- **TWA deep link:** `https://t.me/calclaudecode_bot/spotify`
- **Spec:** `docs/superpowers/specs/2026-04-12-spotify-miniapp-design.md`
- **Funcionalidad:** Player visual, búsqueda, queue — estilo Glass Immersive (SVG icons)
- **Auth:** Service Binding `AUTH_SERVICE` al auth worker (Worker-to-Worker requiere binding, no URL)
- **Polling:** cada 5s (15s cuando pierde foco)
- **Entry points:** botón "🎵 Spotify" en menú principal (URL directa a TWA)

## Apple Health (consumo)
Worker e infraestructura viven en el agente Health: `~/Documents/Claude Projects/Personal/Agents/Health/health-worker/`. Ver `Health/CLAUDE.md` para detalles completos.

**Endpoints (quick ref para consumir desde CoS):**
- `GET https://health.carlos-cb4.workers.dev/summary?date=YYYY-MM-DD&key=$HEALTH_API_KEY` — resumen del día
- `GET https://health.carlos-cb4.workers.dev/trend?metric=X&days=N&key=$HEALTH_API_KEY` — tendencia
- API Key: `~/.claude/channels/telegram/.env` como `HEALTH_API_KEY`

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

## Comandos operativos

### Telegram channel
```bash
claude --channels plugin:telegram@claude-plugins-official
```

### Deploy plugin fork (después de editar telegram-plugin/)
```bash
cp telegram-plugin/{server,notion-client,callback-router,spotify-client}.ts \
  ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/
```

### Deploy workers
```bash
cd spotify-auth-worker && npx wrangler deploy
cd spotify-miniapp-worker && npx wrangler deploy
# Health worker vive en el agente Health:
cd ../../Health/health-worker && npx wrangler deploy
```

## Hooks & Automatización
- **SessionStart hook:** `~/.claude/hooks/session-start-context.sh` — inyecta fecha/hora + tareas vencidas de Notion (API directa) + eventos Outlook hoy/mañana (cache) + instrucciones para Google Calendar (MCP)
- **Stop hook:** `~/.claude/hooks/stop-telegram-notify.sh` — push notification a Telegram cuando Claude termina (solo en `end_turn`)
- **PreCompact hook:** `~/.claude/hooks/pre-compact-snapshot.sh` — copia transcript a `~/.claude/compact-snapshots/` antes de compactar (últimos 20). Notifica Telegram si trigger=manual
- **PostToolUse hook (Notion):** `~/.claude/hooks/notion-audit.sh` — filtrado a `mcp__notion__.*` (solo writes). Loguea a `~/.claude/logs/notion-audit.log` con rotación a 5MB
- **Outlook cache:** `~/.claude/hooks/refresh-outlook-cache.sh` — descarga ICS, extrae hoy/mañana, guarda en `~/.claude/hooks/cache/outlook-events.txt`
- **Cron Outlook:** launchd `com.claude.outlook-cache` — cada 4 horas + al boot
- **Cron Briefings:** launchd `com.claude.daily-briefings` — 5:00am diario, genera briefings Bolivia + Perú + Colombia via claude CLI. Usa `gtimeout` 15min por país (coreutils). Notifica errores a Telegram via curl
- **Cron Reporte nocturno:** launchd `com.claude.nightly-report` — 22:00 diario, ejecuta `~/.claude/hooks/nightly-report.sh`. Resumen día + plan mañana via Telegram
- **Cron Eisenhower semanal:** launchd `com.claude.eisenhower-weekly` — domingo 21:00, ejecuta `~/.claude/hooks/eisenhower-weekly.sh`. Clasifica tareas activas en matriz Q1-Q4 via Telegram
- **Heartbeat engine:** launchd `com.claude.heartbeat` — cada 30min de 7am a 22:30. `~/.claude/hooks/heartbeat.sh` lee `~/.claude/heartbeat-tasks/*.md` (frontmatter `schedule`+`priority`), ejecuta cada check con `claude -p` (timeout 60s), agrupa ALERTs por prioridad en un único mensaje a Telegram. Failure counter en `~/.claude/state/heartbeat-failures` → alerta si ≥3 consecutivos. Status: `~/.claude/hooks/heartbeat-status.sh`. Flags: `--dry-run`, `--only <name>`. Repo copies: `hooks/heartbeat*.sh`, `heartbeat-tasks/`, `launchd/com.claude.heartbeat.plist`
- **Heartbeat checks actuales:** `overdue-tasks.md` (every/high), `flight-checkin.md` (every/high), `incomplete-tasks.md` (morning-only/medium), `midday-steps.md` (midday-only/medium)
- **Proactive ideas:** launchd `com.claude.proactive-ideas` — 9am/14:00/19:00. `~/.claude/hooks/proactive-ideas.sh` lee posts X+Threads últimas 24h + tareas Notion → idea JSON → escribe a Notion DB "Ideas Proactivas (CoS)" (id `59e0439d7fe0483ab735575b9e0c1007`) + Telegram. Slots: foco 🎯, tactical ⚡, lookahead 🔮. Plist creado pero NO cargado: requiere `X_BEARER_TOKEN`, `X_USER_ID`, `THREADS_TOKEN`, `THREADS_USER_ID`, `NOTION_TASKS_DB_ID`, `NOTION_IDEAS_DB_ID` en `~/.claude/channels/telegram/.env` + DB compartida con integración. Cargar con: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.proactive-ideas.plist`
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
