# Backlog — Chief of Staff Cal

## Pendientes

### Referencia: AI Copilot framework (Tal Raviv)
- **Fuente:** Artículo #45 — "Build your personal AI copilot" (Tal Raviv via Lenny's Newsletter)
- **Resumen:** Framework de 4 pasos para construir un AI copilot como thinking partner a largo plazo
  1. **Hire:** Definir rol, personalidad, comportamientos via instructions
  2. **Onboard:** Llenar project knowledge con docs de empresa, equipo, estrategia, customer research
  3. **Kick off:** Un chat thread por iniciativa, context acumulativo
  4. **Work:** Prompts conversacionales ("What's the most important thing I should do next?")
- **Patterns clave:**
  - "Gossiping" al copilot: actualizar contexto informalmente, stream of consciousness, voz
  - Event-driven automations > batch tasks
  - Lessons learned document al final de cada iniciativa → compound interest
  - Context window limit workaround: prompt para resumir y migrar thread preservando 90% del valor
- **Prompts reutilizables:** hiring prompt, onboarding prompt, initiative kickoff, automation brainstorm (todos en el artículo)
- **Aplicar a:** Diseñar el CoS como copilot con context de Yape (equipo, estrategia, OKRs, stakeholders)
- **Doc completo:** `/Users/calepes/Documents/Claude Projects/Claude Code Setup/docs/articulos/01kcy4pypx-tal-raviv-personal-ai-copilot.md`

### Callback Optimization — Implementado (2026-04-11)
- [x] Fork del plugin de Telegram con handler de callback_query
- [x] Callback format: `[callback] prefix:action[:context]`
- [x] Desplegado al cache del plugin
- [x] CLAUDE.md global actualizado con mantenimiento del fork
- [x] Parámetro `buttons` agregado al tool `reply` (schema + handler con InlineKeyboard)
- [x] Botones probados en sesión (2026-04-11)
- [x] `notion-client.ts` — updates directos a Notion desde el plugin
- [x] `callback-router.ts` — routing mecánico (t:d, t:c, t:s, t:sd) sin LLM (~200ms)
- [x] Router integrado en `server.ts`, desplegado al cache
- [x] Configurar NOTION_TOKEN en .env (2026-04-12)
- [x] Test end-to-end de callbacks mecánicos (2026-04-12)
- Specs: `docs/superpowers/specs/2026-04-11-callback-optimization-design.md`
- Plan: `docs/superpowers/plans/2026-04-11-callback-optimization.md`

### Botones inline — Menú y flujos (código listo, pendiente test)
- [x] Menú principal configurable (`menu.json`) — creado
- [x] Skill `/menu` — creada
- [x] Flujos de revisión de tareas documentados
- [x] Test end-to-end del menú (2026-04-12) — probado: menú → Spotify → controles
- [x] Soporte para botones URL (deep links)
- [x] Toast de confirmación en callbacks no mecánicos
- [ ] Aprobaciones rápidas (sí/no)
- Spec: `docs/superpowers/specs/2026-04-11-inline-buttons-menu-design.md`
- Plan: `docs/superpowers/plans/2026-04-11-inline-buttons-menu.md`

### Spotify — Control desde Telegram (código listo, pendiente config)
- [x] Crear Spotify Developer App (2026-04-12)
- [x] Cloudflare Worker para OAuth — creado
- [x] `spotify-client.ts` en plugin — creado
- [x] Callbacks mecánicos en router — integrados
- [x] Deploy Worker + secrets + wrangler v4 (2026-04-12)
- [x] Auth flow — Cal visitó /login (2026-04-12)
- [x] Test end-to-end (2026-04-12) — callback funciona, error esperado "No active device"
- [ ] Deep link para abrir Spotify cuando no hay dispositivo activo
- Spec: `docs/superpowers/specs/2026-04-11-spotify-control-design.md`
- Plan: `docs/superpowers/plans/2026-04-11-spotify-control.md`

### Apple Health — Datos de salud desde Telegram (código listo, pendiente config)
- [x] Cloudflare Worker + D1 — creado
- [x] Migration SQL — creada
- [x] Deploy Worker + D1 + secrets (2026-04-12)
- [x] Instalar y configurar Health Auto Export en iPhone (2026-04-12)
- [x] Test ingesta de datos — data llegando correctamente (2026-04-12)
- [x] Fix: parser adaptado a formato anidado real de Health Auto Export (2026-04-12)
- [ ] Integrar en briefing /today como sección opcional
- Spec: `docs/superpowers/specs/2026-04-11-apple-health-design.md`
- Plan: `docs/superpowers/plans/2026-04-11-apple-health.md`

### Spotify Mini App (TWA) — Implementado (2026-04-12)
- [x] Scaffold del proyecto (wrangler, package.json, index.ts)
- [x] API proxy — 10 endpoints (now-playing, play, pause, next, previous, volume, seek, queue, search, play-uri)
- [x] Service Binding para Worker-to-Worker auth (fix error 1101)
- [x] Player UI Glass Immersive con SVG icons
- [x] Búsqueda, cola, controles, progreso animado
- [x] TWA best practices (ready, disableVerticalSwipes)
- [x] Deploy a `spotify-miniapp.carlos-cb4.workers.dev`
- [x] Mini app registrada en BotFather (short_name: spotify)
- [x] Menú actualizado con acceso directo a TWA
- [x] themeParams / colorScheme — adaptar a tema claro de Telegram (2026-04-12)
- [x] safeAreaInset — padding para notch/Dynamic Island (2026-04-12)
- [x] HapticFeedback en controles (play, skip, seek) (2026-04-12)
- [ ] Rate limit 429 — backoff exponencial en frontend
- Spec: `docs/superpowers/specs/2026-04-12-spotify-miniapp-design.md`
- Plan: `docs/superpowers/plans/2026-04-12-spotify-miniapp.md`

### UX Telegram — Mejoras de fluidez
- [ ] **Editar mensaje en navegación de menú** — en vez de enviar mensaje nuevo al cambiar de menú (Menu → Spotify → Menu), editar el existente. Reduce clutter y se siente más fluido. (esfuerzo: bajo)
- [ ] **Limitar keyboards a 4 filas max** — más de eso causa stutter en iOS. Paginar el resto. (esfuerzo: bajo)
- [x] **Mini App para flujos complejos** — implementado: Spotify Mini App TWA (2026-04-12)
- [ ] **MenuButtonWebApp** — reemplazar lista de comandos `/` con Mini App como menú principal del bot. (esfuerzo: medio)

### CoS Proactivo — Plan inspirado en OpenClaw (2026-04-12)
Referencia: artículos OpenClaw de Claire Vo, Federico Viticci (MacStories), guía completa

**Fase 1: Hooks básicos** (30 min c/u)
- [ ] 1.1 Hook SessionStart → inyectar fecha + tareas vencidas Notion + eventos Calendar al iniciar sesión
- [ ] 1.2 Hook Stop → push notification a Telegram cuando Claude termina tarea larga
- [ ] 1.3 Hook PostCompact → guardar contexto automáticamente antes de perderlo
- [ ] 1.4 Hook PostToolUse(Notion) → audit log de escrituras a Notion

**Fase 2: Cron Jobs — Rutinas diarias** (1-2 hrs)
- [ ] 2.1 Briefing matutino (7am L-V) → scheduled task: calendario + tareas + salud + noticias → Telegram
- [ ] 2.2 Reporte nocturno (10pm) → resumen del día, completadas, pendientes para mañana
- [ ] 2.3 Eisenhower semanal (Dom 9pm) → clasifica tareas en matriz, actualiza Notion, manda resumen

**Fase 3: Heartbeat — Trabajo proactivo** (2 hrs)
- [ ] 3.1 Heartbeat cada 30min → revisa tareas vencidas, mensajes pendientes, eventos próximos → alerta proactiva
- [ ] 3.2 Heartbeat tasks como Markdown → carpeta heartbeat-tasks/ con instrucciones .md por tarea
- [ ] 3.3 "Proactive ideas" (3x/día) → genera idea útil basada en contexto y la agrega a Notion

**Fase 4: Webhooks — Reaccionar al mundo** (medio día)
- [ ] 4.1 Email webhook → Worker recibe Gmail webhook → resume y notifica en Telegram si importante
- [ ] 4.2 GitHub PRs → notifica + propone review automático
- [ ] 4.3 Health alertas → "dormiste <6h", "no caminaste hoy" (worker ya existe, agregar lógica)
- [ ] 4.4 Notion changes → webhook cuando equipo modifica tareas → notifica a Cal

**Fase 5: Auto-mejora continua** (1 día)
- [ ] 5.1 Self-improving CLAUDE.md → registra fricciones, analiza patrones, propone mejoras. Cal aprueba por Telegram
- [ ] 5.2 "Morning builds" (estilo Viticci) → overnight construye algo útil del backlog. Cal se despierta con PR
- [ ] 5.3 Skills auto-instalables → detecta patrones repetitivos, se crea skills como archivos .md

**Fase 6: Multi-agente** (1 día)
- [ ] 6.1 Agentes especializados → Notion agent, Spotify agent, Research agent con contexto aislado
- [ ] 6.2 Coordinador principal → delega a subagentes, preserva contexto del hilo principal
- [ ] 6.3 Agent-to-agent → un agente asigna trabajo a otro (Research → Notion para guardar hallazgos)

### Futuro
- [ ] Migrar secrets a 1Password CLI (`op`)
- [ ] Webhook Cloudflare Worker para procesar callback_query server-side (alternativa si el fork del plugin da problemas de mantenimiento)
