# CHANGELOG — Chief of Staff Cal

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
