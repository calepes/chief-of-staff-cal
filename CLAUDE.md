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

## Referencias complementarias
- `~/.claude/CLAUDE.md` (global) — instrucciones globales (idioma, planning, comunicación) + detalles del fork Telegram (source of truth, deploy, callback format)

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
- **Fallback outbound si MCP desconectado:** `source ~/.claude/channels/telegram/.env && curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" -d "chat_id=94137698" --data-urlencode "text=..."` — funciona sin el plugin (solo outbound, no recibe mensajes entrantes)

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

## Spotify — ⚠️ PENDIENTE DE REMOVER
- **Status:** Cal decidió remover toda la integración (Mini App + callbacks + workers). Ver BACKLOG "Deshacer integración Spotify completa"
- **NO desarrollar features nuevos aquí.** Mantener Developer App en console.spotify.com (eliminar es irreversible), pero el resto sale.
- **Funcional mientras tanto:** callbacks `spotify:*`, Mini App en `https://spotify-miniapp.carlos-cb4.workers.dev`, auth worker
- **Detalles históricos:** CHANGELOG + `docs/superpowers/specs/2026-04-11-spotify-control-*` + `docs/superpowers/specs/2026-04-12-spotify-miniapp-*`

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
- **Plist:** `com.claude.morning-build` (creado, NO cargado hasta aprobación explícita)
- **Flujo:** propuesta llega 22:30 → Cal tap ✅ → executor corre en background (max 30min) → notifica resultado con commit hash

## Skill Detector (Fase 5.3)
- **Detector:** `~/.claude/hooks/skill-detector.sh` — cron domingo 21:30. Escanea transcripts de últimos 7 días del CoS, invoca `claude -p` con `skill-detector-prompt.md`, detecta patrones conductuales con frecuencia ≥3/semana, genera JSON con skill completo (`name`, `titulo`, `skill_body`, `ejemplos_triggers`, `frecuencia_semana`)
- **Installer:** `~/.claude/hooks/skill-install.sh <id>` — disparado por callback `skill:approve:<id>` (async). Escribe `commands/<name>.md` + `~/.claude/commands/<name>.md`, commit + push. NO pasa por LLM — es mecánico (body ya viene generado en el JSON)
- **Callbacks:** `skill:approve:<id>` dispara installer; `skill:reject:<id>` archiva a `rejected/`
- **Plist:** `com.claude.skill-detector` (creado, NO cargado)
- **Criterio:** solo propone skills con frecuencia ≥3 veces en la semana Y que no dupliquen skills existentes. Si duda → `null`
- **Gotcha find macOS:** `find -newermt "@epoch"` NO funciona en macOS. Usar `-mtime -7` para rangos, o `touch -t` + `-newer <ref>` para cursor exacto (ver `extract-learnings.sh`)

## Gotchas del entorno
- **Bash 3.2 macOS default** — sin associative arrays (`declare -A` falla con `unbound variable` silencioso). Usar parallel arrays: `ARR=("key1|val1" "key2|val2")` + parse con `${entry%%|*}` / `${entry#*|}`
- **`set -euo pipefail` + `grep -c` sin match** — grep devuelve exit 1, `-e` mata el script silencioso. Usar `set -uo pipefail` en scripts de status/conteo
- **Plugin Telegram cache tiene 0.0.5 y 0.0.6** — el deploy con wildcard `telegram/*/` las cubre ambas, no quitar versiones viejas hasta confirmar cuál usa el harness
- **PostToolUse hook `tool_response`** no tiene `exit_code` top-level para Bash — el hook asume 0 por default. Filtrar errores por contenido de output es ruidoso (feedback loops); mejor asumir que el harness pasa solo errores reales

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
- **SessionStart hook:** `~/.claude/hooks/session-start-context.sh` — inyecta fecha/hora + tareas vencidas de Notion (API directa) + eventos Outlook hoy/mañana (cache) + instrucciones para Google Calendar (MCP)
- **Stop hook:** `~/.claude/hooks/stop-telegram-notify.sh` — push notification a Telegram cuando Claude termina (solo en `end_turn`)
- **PreCompact hook:** `~/.claude/hooks/pre-compact-snapshot.sh` — copia transcript a `~/.claude/compact-snapshots/` antes de compactar (últimos 20). Notifica Telegram si trigger=manual
- **PostToolUse hook (Notion):** `~/.claude/hooks/notion-audit.sh` — filtrado a `mcp__notion__.*` (solo writes). Loguea a `~/.claude/logs/notion-audit.log` con rotación a 5MB
- **Outlook cache:** `~/.claude/hooks/refresh-outlook-cache.sh` — descarga ICS, extrae hoy/mañana, guarda en `~/.claude/hooks/cache/outlook-events.txt`
- **Cron Outlook:** launchd `com.claude.outlook-cache` — cada 4 horas + al boot
- **Cron Briefings:** launchd `com.claude.daily-briefings` — 5:00am diario, genera briefings Bolivia + Perú + Colombia via claude CLI. Usa `gtimeout` 15min por país (coreutils). Notifica errores a Telegram via curl
- **Cron Reporte nocturno:** launchd `com.claude.nightly-report` — 22:00 diario, ejecuta `~/.claude/hooks/nightly-report.sh`. Resumen día + plan mañana via Telegram
- **Cron Eisenhower semanal:** launchd `com.claude.eisenhower-weekly` — domingo 21:00, ejecuta `~/.claude/hooks/eisenhower-weekly.sh`. Clasifica tareas activas en matriz Q1-Q4 via Telegram
- **Heartbeat engine:** launchd `com.claude.heartbeat` — cada 30min de 7am a 22:30. `~/.claude/hooks/heartbeat.sh` lee `~/.claude/heartbeat-tasks/*.md` (frontmatter `schedule`+`priority`), ejecuta cada check con `claude -p` (timeout 60s), agrupa ALERTs por prioridad en un único mensaje a Telegram. Failure counter en `~/.claude/state/heartbeat-failures` → alerta si ≥3 consecutivos. Status: `~/.claude/hooks/heartbeat-status.sh`. Flags: `--dry-run`, `--only <name>` (este último bypassa el filtro de `schedule` para testing). Repo copies: `hooks/heartbeat*.sh`, `heartbeat-tasks/`, `launchd/com.claude.heartbeat.plist`
- **Gotcha launchd PATH:** Plists que invocan `claude` CLI DEBEN incluir `/Users/calepes/.local/bin` en `EnvironmentVariables.PATH` (no está en homebrew). Sin esto: `gtimeout: failed to run command 'claude'` y silencio. Si el counter de fallos llega a 3 → alerta "heartbeat caído"
- **Heartbeat checks actuales:**
  - **Tasks/calendario:** `overdue-tasks.md` (every/high), `flight-checkin.md` (every/high), `incomplete-tasks.md` (morning-only/medium), `midday-steps.md` (midday-only/medium)
  - **Health (4.3):** `health-sleep.md` (morning-wake/high — anoche <6h), `health-steps-evening.md` (evening/medium — <6k a las 17-19h), `health-sedentary.md` (business-hours/low — <70% stand hours esperados), `health-hrv-weekly.md` (weekly-monday-am/medium — HRV semana <80% baseline 4 sem), `health-daylight.md` (late-afternoon/low — <15min daylight), `health-strength-weekly.md` (weekly-monday-am/medium — <3 sesiones strength/sem, meta 3x), `health-bodycomp-weekly.md` (weekly-monday-am/low — recordatorio medir o trend body fat/lean mass)
  - **Schedules adicionales:** `morning-wake` (7-9am), `evening` (17-19h), `business-hours` (10-19h L-V), `weekly-monday-am` (Lun 8-9am), `late-afternoon` (17-18h)
  - **Anti-spam:** state file `~/.claude/state/health-alerts-YYYY-MM-DD.json` con 1 alerta/día por tipo. Cleanup automático >7 días al inicio de cada heartbeat run
  - **Spec/plan:** `docs/superpowers/specs/2026-04-19-health-alerts-design.md` + `docs/superpowers/plans/2026-04-19-health-alerts.md`
  - **Agregar nuevo check:** Crear `~/.claude/heartbeat-tasks/<name>.md` con frontmatter `name`, `schedule`, `priority`. Body = prompt para `claude -p`. Output esperado: `ALERT\n<msg>` o `HEARTBEAT_OK`. Copiar también a repo `heartbeat-tasks/`. Sin reload — engine lee dinámicamente
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
