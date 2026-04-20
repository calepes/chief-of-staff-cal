# CHANGELOG — Chief of Staff Cal

## 2026-04-19 (noche)

### Telegram plugin — robustez polling + Spotify UX
- **Fix**: Polling loop reintenta en cualquier error (antes solo 409). ETIMEDOUT/ECONNRESET/DNS rechazaban `bot.start()` y el polling moría silenciosamente mientras el proceso seguía vivo (MCP stdin). Ahora reset del attempt counter en `onStart` para que reconexiones sucesivas no acumulen backoff
- **Feature**: `editMessageText` desde `RouteResult` soporta inline keyboards (vía `RouteButton[][]`)
- **Feature**: Detección de "no active device" en respuestas de Spotify → UX con deep link "🎵 Abrir Spotify" en vez de error genérico

### Scripts operativos
- **Feature**: `scripts/health-check.sh` — detección end-to-end de long-poll a Telegram (409 Conflict = bot vivo; 200+empty = colgado). Fuerza relanzamiento del LaunchAgent si detecta caída
- **Feature**: `scripts/setup-menu-button.sh` — configura `setChatMenuButton` del bot para abrir la Mini App de Spotify como default

### Docs
- **CLAUDE.md**: agregado bloque "Test heartbeat puntual" + pattern para "Agregar nuevo check" (frontmatter mínimo + output esperado, sin reload)

## 2026-04-19 (tarde 2)

### Fase 4.3 CoS Proactivo — Health alertas reactivas
- **Feature**: 7 nuevos heartbeat checks de salud, cada uno como `~/.claude/heartbeat-tasks/health-*.md` con frontmatter (`schedule`, `priority`):
  - `health-sleep.md` (morning-wake/high) — anoche `sleep_totalSleep < 6h`
  - `health-steps-evening.md` (evening/medium) — `step_count < 6000` a las 17-19h
  - `health-sedentary.md` (business-hours/low) — `apple_stand_hour` bajo en horario laboral
  - `health-hrv-weekly.md` (weekly-monday-am/medium) — HRV semana actual <80% baseline 4 sem
  - `health-daylight.md` (late-afternoon/low) — `time_in_daylight < 15min` hoy
  - `health-strength-weekly.md` (weekly-monday-am/medium) — <3 sesiones strength en 7 días (meta 3x/sem)
  - `health-bodycomp-weekly.md` (weekly-monday-am/low) — recordatorio medir si data >7 días, o trend body fat + lean mass
- **Feature**: 5 schedule values nuevos en `should_run()` de heartbeat.sh — `morning-wake` (7-9am), `evening` (17-19h), `business-hours` (10-19h L-V), `weekly-monday-am` (Lun 8-9am), `late-afternoon` (17-18h)
- **Feature**: Bypass de `should_run()` cuando se usa `--only` (permite testear cualquier check fuera de ventana)
- **Feature**: Cleanup automático state files >7 días al inicio de cada heartbeat run (`find ~/.claude/state -name 'health-alerts-*.json' -mtime +7 -delete`)
- **Feature**: Anti-spam — state file diario `~/.claude/state/health-alerts-YYYY-MM-DD.json`. Cada check verifica su key antes de evaluar threshold; tras alertar, agrega su key con `jq` (1 alerta/día por tipo)
- **Worker**: Health worker extendido — endpoint `/workouts/summary?days=N&type=strength|cardio|...` ya existía (Fase 3), reusable por `health-strength-weekly`
- **Spec/Plan**: `docs/superpowers/specs/2026-04-19-health-alerts-design.md`, `docs/superpowers/plans/2026-04-19-health-alerts.md` (11 tareas)
- **Fix**: launchd plist heartbeat + proactive-ideas — agregado `~/.local/bin` al PATH para que encuentre el CLI de claude (causaba "heartbeat caído" tras 3 runs fallando con `gtimeout: failed to run command 'claude'`)

## 2026-04-19 (tarde)

### Fase 3 CoS Proactivo — Heartbeat + Proactive Ideas
- **Feature**: Heartbeat engine `~/.claude/hooks/heartbeat.sh` + launchd `com.claude.heartbeat` cargado (7am-22:30 cada 30min). Lee checks de `~/.claude/heartbeat-tasks/*.md` con frontmatter (`schedule`, `priority`), invoca `claude -p` por cada uno con timeout 60s, agrupa ALERTs por prioridad en un único mensaje a Telegram. Contador de fallos consecutivos en `~/.claude/state/heartbeat-failures` → alerta si ≥3 consecutivos. Log rotation automática a 5MB. Flags: `--dry-run`, `--only <name>`
- **Feature**: 4 checks iniciales — `overdue-tasks.md` (Notion vencidas, every/high), `flight-checkin.md` (Google Calendar AntoCataNoeCal, every/high), `incomplete-tasks.md` (sin asignado/deadline, morning-only/medium), `midday-steps.md` (Health worker, midday-only/medium, alerta si <3000)
- **Feature**: `~/.claude/hooks/heartbeat-status.sh` — observabilidad: último run, status launchctl, checks activos, últimos 5 alerts, failure counter
- **Feature**: Proactive ideas `~/.claude/hooks/proactive-ideas.sh` + plist `com.claude.proactive-ideas` (creado, NO cargado hasta que Cal complete tokens X/Threads + DB). Slots 9am=foco 🎯, 14:00=tactical ⚡, 19:00=lookahead 🔮. Lee posts propios X+Threads últimas 24h + tareas activas Notion → JSON `{title, body, source}` → escribe a Notion DB "Ideas Proactivas (CoS)" (`59e0439d7fe0483ab735575b9e0c1007`, anidada bajo "💡 Ideas") + Telegram. Graceful degradation si falta cualquier API
- **Spec/Plan**: `docs/superpowers/specs/2026-04-19-heartbeat-fase3-design.md`, `docs/superpowers/plans/2026-04-19-heartbeat-fase3.md`
- **Pendiente Cal**: crear app X (token + user_id), app Threads (token + user_id), compartir DB Ideas con integración "Claude CoS", agregar `NOTION_TASKS_DB_ID`, `NOTION_IDEAS_DB_ID`, `X_BEARER_TOKEN`, `X_USER_ID`, `THREADS_TOKEN`, `THREADS_USER_ID` a `~/.claude/channels/telegram/.env`. Después: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.proactive-ideas.plist`

## 2026-04-19

### Quick wins — hooks + Spotify UX + aprobaciones
- **Feature**: Hook `PreCompact` → `~/.claude/hooks/pre-compact-snapshot.sh` guarda snapshot del transcript antes de compactar. Últimos 20 snapshots en `~/.claude/compact-snapshots/`. Notifica Telegram si el trigger es manual
- **Feature**: Deep link Spotify cuando no hay device activo — callbacks `spotify:*` detectan "No active device" y responden con botón URL "🎵 Abrir Spotify" (https://open.spotify.com). Mensaje guía al usuario: abre Spotify, reproduce algo, reintenta
- **Feature**: Aprobaciones rápidas — callbacks `approve:yes[:context]` y `approve:no[:context]` procesados mecánicamente en el plugin (~200ms, sin LLM)
- **Feature**: `RouteResult` del callback-router ahora soporta `buttons?: RouteButton[][]` — los callbacks mecánicos pueden devolver inline keyboards (útil para el deep link Spotify y futuros flujos)

### Plugin Telegram — upgrade 0.0.5 → 0.0.6
- **Update**: Fork re-aplicado a versión 0.0.6 del plugin (0.0.5 quedó orphaned Apr 16). Upstream fix mergeado: retry polling con backoff en cualquier error (antes solo 409 se reintentaba — un ETIMEDOUT/ECONNRESET mataba el polling silenciosamente)
- **Update**: `~/.claude/CLAUDE.md` y `CLAUDE.md` de CoS actualizados con ruta 0.0.6
- **Backup**: `server.ts.original` de 0.0.6 guardado para comparar futuras actualizaciones upstream

### Cron jobs — rutinas diarias/semanales
- **Feature**: Reporte nocturno 22:00 → `~/.claude/hooks/nightly-report.sh` + `com.claude.nightly-report.plist`. Resumen del día (completadas, eventos), pendientes, plan mañana, sugerencia accionable. Notifica via Telegram
- **Feature**: Eisenhower semanal domingo 21:00 → `~/.claude/hooks/eisenhower-weekly.sh` + `com.claude.eisenhower-weekly.plist`. Clasifica tareas activas en matriz Urgente/Importante (Q1-Q4), top 3 Q1+Q2, recomendación '3 tareas para el lunes'. Solo reporta por Telegram, no actualiza Notion en primera iteración

### Audit + Mini App menu
- **Feature**: Hook `PostToolUse` filtrado a `mcp__notion__.*` → `~/.claude/hooks/notion-audit.sh` loguea escrituras a `~/.claude/logs/notion-audit.log`. Rotación automática al pasar 5MB
- **Feature**: `scripts/setup-menu-button.sh` — configura el botón de menú del bot (reemplaza lista `/commands` con Mini App). Ejecutado apuntando a Spotify Mini App (`https://spotify-miniapp.carlos-cb4.workers.dev`, label "🎵 Abrir")

## 2026-04-17

### Refactor estructural
- **Move**: `health-worker/` movido de `Chief of Staff Cal/` a `Health/` — vive con su agente
- **Update**: `CoS/CLAUDE.md` reducido a consumer con quick-ref de endpoints + pointer a `Health/CLAUDE.md`
- **Update**: `Health/CLAUDE.md` enriquecido con especificación completa del worker (endpoints, ingesta, métricas, dedup, deploy, ejemplos curl)

### Notion (cross-project)
- **Feature**: Creado `~/Documents/Claude Projects/notion-reference.md` — referencia global cargada bajo demanda: mapeo personas (pageId ↔ nombre) para 7 miembros del equipo Yape, schema DB Tareas (32 props), patterns jq para outputs grandes (70KB+), gotchas (users vs pages en API)
- **Update**: `Claude Projects/CLAUDE.md` referencia `notion-reference.md` junto a telegram-reference.md
- **Update**: `CoS/CLAUDE.md` sección Notion reducida a pointer al archivo cross-project

### Handoff Health
- **Feature**: Creado `Health/SESSION-HANDOFF.md` con contexto heredado de la sesión CoS para arrancar trabajo en el agente Health (Fase 1: metas + baseline + BD Notion + bot propio)

### Docs
- **Update**: Sección Audio de `CoS/CLAUDE.md` ahora incluye path completo del modelo whisper (`ggml-base.bin`) y comando completo de transcripción OGA → WAV → texto
- **Update**: `Health/CLAUDE.md` añade ejemplo POST /ingest para debugging

## 2026-04-12 (noche) — 2026-04-13

### Telegram UX
- **Fix**: Contenido de callbacks del menú ahora se envía como reply nuevo (no edit_message) — evita que el plugin destruya el contenido al navegar de vuelta
- **Fix**: Eliminados botones callback en mensajes de contenido — el plugin hacía edit mecánico al presionarlos

### Cron Briefings
- **Fix**: `timeout` → `gtimeout` (coreutils) — `timeout` no existe en macOS
- **Feature**: Notificación a Telegram via curl cuando un briefing falla (timeout o error)
- **Feature**: Rutas de GitHub Pages explícitas en el prompt para evitar búsquedas con find
- **Feature**: `Skill` agregado a --allowedTools del cron
- **Fix**: Removido `set -euo pipefail` para que no aborte si un país falla

### Briefings
- **Feature**: Briefing Peru 12 abril 2026 — cobertura elecciones generales (Keiko 16.6%, empate técnico segundo lugar, escándalo ONPE 63K votantes)

### Skill /today
- **Feature**: Sección de tareas Notion agregada — semana actual, agrupadas por asignado, ordenadas por deadline

### Backlog
- **Feature**: Agregado item Google Maps API (distancias/tiempos) al backlog CoS
- **Feature**: Agregado item Tipo de Gasto (Factura) al backlog Presupuesto

## 2026-04-12

### Deploy & Configuración
- **Deploy**: Spotify OAuth Worker desplegado — KV namespace, secrets, wrangler v4, auth completado
- **Deploy**: Health Worker desplegado — D1 database creada, migración aplicada
- **Config**: Notion token configurado en .env, integración "Claude CoS" conectada
- **Config**: Spotify auth worker URL agregada a .env
- **Config**: Health API key generada y configurada en .env
- **Config**: Health Auto Export conectado en iPhone (auth via query param)

### Health Worker
- **Fix**: Adaptado parser de ingesta al formato real de Health Auto Export (estructura anidada data.metrics[].data[])
- **Feature**: Sleep analysis expandido a sub-métricas (sleep_totalSleep, sleep_deep, sleep_rem, sleep_core, sleep_awake)
- **Feature**: Batch de D1 con límite de 500 statements

### Telegram Plugin
- **Feature**: Soporte para botones URL en reply y edit_message — deep links (spotify://, https://) además de callbacks
- **Feature**: Toast de confirmación ("✓ {label}") en callbacks no mecánicos via answerCallbackQuery

### Spotify Mini App (TWA)
- **Feature**: Worker `spotify-miniapp.carlos-cb4.workers.dev` — API proxy (10 endpoints) + UI inline
- **Feature**: Player Glass Immersive con SVG icons, búsqueda, cola, controles completos
- **Feature**: Service Binding para Worker-to-Worker auth (fix error 1101)
- **Feature**: TWA best practices — `ready()`, `disableVerticalSwipes()`
- **Feature**: Toast "No active device" para feedback al usuario
- **Fix**: Escape de comillas en onclick — `&apos;` en vez de `\'` en template literals HTML
- **Fix**: Skip buttons con re-poll automático para actualizar UI
- **Design**: 3 propuestas visuales (Minimal Noir, Vinyl Warmth, Glass Immersive) — Cal eligió C
- **Config**: Mini app registrada en BotFather, menú actualizado con acceso directo
- **Feature**: TWA audit MEDIUM+LOW — themeParams, safeAreaInset, HapticFeedback, viewport vars

### Claude Code Setup
- **Feature**: Hook SessionStart — inyecta fecha/hora actual al iniciar sesión
- **Feature**: Status line con fecha/hora + refreshInterval 60s
- **Feature**: Skill `telegram-miniapp` — guía global para construir TWAs
- **Research**: Auditoría Superpowers best practices — recomendaciones aplicadas
- **Research**: OpenClaw articles — plan "CoS Proactivo" con 6 fases y 19 items
- **Backlog**: Plan CoS Proactivo + Agente Familiar (Cal+Noe)

### Spotify Client
- **Fix**: JSON parse error en respuestas vacías de Spotify API (nowPlaying después de skip)

### Quick Wins (sesión nocturna)
- **Feature**: /today integra sección 🏥 Salud (consulta health worker) y 📅 Calendario (Outlook cache + Google Calendar MCP)
- **Feature**: Navegación de menú con edit_message in-place (no mensaje nuevo) + botón "⬅️ Menu"
- **Feature**: MAX_KEYBOARD_ROWS=4 en reply y edit_message (fix stutter iOS)

### Telegram UX & Documentación (sesión nocturna 2)
- **Feature**: Loading transitions mecánicas en plugin para callbacks `menu:*` — edit instantáneo (~150ms) con "⏳ Cargando..." antes de pasar al LLM
- **Docs**: `telegram-reference.md` — referencia cross-project consolidada (bot, plugin fork, callbacks, UX, integraciones, workers, gotchas)
- **Docs**: Referencia agregada en `Claude Projects/CLAUDE.md` y CoS `CLAUDE.md`

### Hooks & Crons (sesión nocturna)
- **Feature**: Hook SessionStart mejorado — tareas vencidas de Notion (API directa) + eventos Outlook (ICS cache) + Google Calendar (MCP)
- **Feature**: Hook Stop — push notification Telegram cuando Claude termina (solo end_turn)
- **Feature**: Outlook ICS cache — `refresh-outlook-cache.sh` + launchd cada 4h (`com.claude.outlook-cache`)
- **Feature**: Cron briefings diarios 5am — launchd `com.claude.daily-briefings`, Bolivia+Perú+Colombia via claude CLI
- **Fix**: Health Worker dedup — `INSERT OR IGNORE` + unique index + migration 0002 (eliminó ~24K filas duplicadas)

### Spotify Mini App (sesión nocturna)
- **Feature**: Backoff exponencial en 429 rate limit (1s→30s, resetea en success, toast "esperando...")

### Organización (sesión nocturna)
- **Feature**: Carpetas Yape unificadas (removido espacio trailing + merge Océano Azul)
- **Feature**: Gestión de Viajes integrado al CoS (Flighty, check-in BoA, preferencias)
- **Feature**: Gestión Presupuesto Familiar movido de Apps/ a Agents/Presupuesto/
- **Feature**: Estructura de agentes — Family, Learning, Health, School con CLAUDE.md + BACKLOG.md
- **Feature**: Tabla de agentes en BACKLOG.md con rutas, estados, y bots Telegram
- **Docs**: CLAUDE.md global y proyecto actualizados con ruta Agents/
- **Docs**: Briefing instructions commiteados para agentes remotos
- **Docs**: Notion DB Tareas — esquema completo (32 props), ID corregido para API directa

## 2026-04-11

### Telegram Bot
- **Feature**: Menú de comandos configurado (/briefing_bolivia, /briefing_peru, /today, /status, /tareas)
- **Feature**: Fork del plugin de Telegram con soporte para botones inline interactivos
- **Feature**: Reply keyboard (implementado y luego removido a favor de botones inline)
- **Feature**: Parámetro `buttons` en tool `reply` — envío de inline keyboards con callbacks custom
- **Feature**: Transcripción de notas de voz con whisper-cpp

### Briefings
- **Feature**: Briefing Bolivia 10 abril — generado, publicado en GitHub Pages, notificado por Telegram
- **Feature**: Briefing Colombia 10 abril — generado, publicado en GitHub Pages, notificado por Telegram

### Notion
- **Feature**: Consulta de tareas Eisenhower desde Telegram
- **Feature**: Actualización de deadlines y asignaciones desde Telegram
- **Feature**: Vista "Todas activas" creada para queries ad-hoc

### Calendario
- **Feature**: Escaneo de calendario semanal (Yape + personal + familia) desde Telegram

### Callback Optimization
- **Feature**: Notion client module — updates directos a Notion sin pasar por LLM
- **Feature**: Callback router — prefijos mecánicos (t:d, t:c, t:s, t:sd) procesados en ~200ms
- **Feature**: Router integrado en server.ts del fork del plugin

### Menu & Botones
- **Feature**: Menu configurable via `~/.claude/channels/telegram/menu.json`
- **Feature**: Skill `/menu` para mostrar inline keyboard interactivo
- **Feature**: Flujos de revisión de tareas documentados (botones <10, lotes >10)

### Spotify
- **Feature**: Cloudflare Worker OAuth (`spotify-auth.carlos-cb4.workers.dev`) — login, callback, token refresh
- **Feature**: Spotify client module — play, pause, skip, nowPlaying, setVolume
- **Feature**: Callbacks mecánicos en router (spotify:play, spotify:pause, spotify:skip, etc.)

### Apple Health
- **Feature**: Cloudflare Worker + D1 (`health.carlos-cb4.workers.dev`) — ingesta y consulta de datos
- **Feature**: Endpoints: POST /ingest, GET /summary, GET /trend
- **Feature**: Integración documentada para /today y triggers naturales

### Specs & Planes
- **Docs**: 4 specs de diseño aprobados en `docs/superpowers/specs/`
- **Docs**: 4 planes de implementación en `docs/superpowers/plans/`

### Backlogs actualizados
- Gestión Presupuesto Familiar: merchant adjustment UX con botones
- Claude Code Setup: guardrails de seguridad
- Chief of Staff: Spotify control, Apple Health integration
