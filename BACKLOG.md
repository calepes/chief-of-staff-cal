> ✅ Este `BACKLOG.md` es la fuente viva (Atenea/Notion dado de baja 2026-07-02, ver `~/Claude Projects/BACKLOG.md` para el índice general).

# Backlog — Jano

> ✅ **Estado 2026-04-29: CoS v2 ACTIVO** — daemon Node + Agent SDK librería + webhook + CF Queue. Daemon viejo `com.cal.cos-agent` movido a `disabled-2026-04-29/`. Hooks SessionStart/End adaptados (deleteWebhook gracioso, bootstrap restaura webhook). 16 crons secundarios siguen pausados en `disabled-2026-04-21/` pendientes de rediseño. Detalle en `CLAUDE.md` → sección "Estado (2026-04-29)".

## Pendientes

### Surgió en sesión 2026-07-28
- [ ] **Agregar una acción "cancelado"/"descartado" a proponerItemBacklog, distinta de "hecho" — hoy solo existe agregar/hecho y no se puede marcar un ítem como descartado sin que quede registrado como completado**

### Surgió en sesión 2026-07-25 — dar de baja tools del Mundial 2026
- [ ] **Archivar (NO borrar) el MCP `worldcup` + tools FIFA avanzadas** — pedido de Cal: ya pasó el Mundial 2026, no va a seguir usando ni el API de fútbol (`getFixtures`, etc.) ni las tools FIFA (`getMatchReport`/`getMatchPreview`/`getFifaMatchStats`/`getFifaPlayerStats`/`getFifaPowerRanking`) ni el skill `mundial-analisis-diario`. Objetivo: que dejen de estar disponibles como tools activas para Jano (no aparecer en `allowedTools`/`ToolSearch`, no consumir contexto ni presupuesto de tool-calls), pero conservar el código y la config por si se quiere reactivar en el futuro (próximo Mundial u otro torneo). Alcance a definir al implementar: sacar `worldcup` de `BASE_OPTIONS.mcpServers` en `daemon-v2/src/index.ts` + quitar las tools/sección "FIFA avanzadas" de `system-prompt.ts`, mover carpeta del MCP (`Personal/MCP Servers/mcp-servers/servers/worldcup/`) a algo tipo `servers/_archived/worldcup/` o dejarla in-place pero desregistrada, y marcar el skill `mundial-analisis-diario` como archivado (no borrarlo). Verificar también si Vesta/otro agente tiene el mismo MCP registrado. Antes de tocar código/config: seguir el flujo de planning normal (Cal aprueba approach) — no ejecutar directo.

### Surgió en sesión 2026-07-28 — pulido de las tools de backlog
> Diferidos a propósito del `daemon-health-review` del 2026-07-28 (ninguno bloqueante; el feature
> quedó con 539 tests en verde). Reconsiderar cuando haya uso real.
- [ ] **Tope de ítems en `readBacklogCompact`** — hoy trunca a 200 chars por ítem pero no limita la cantidad. `inversiones-agente` ya va en 100 ítems / 9.4 KB, y el techo teórico con ítems al máximo ronda los 25 KB, que es justo el umbral del persisted-output loop del SDK. Fix: "primeros N + «y M más»".
- [ ] **Filtrar del mapa los proyectos con 0 pendientes** — o mandarlos a un `<i>… y 2 sin pendientes</i>` al final. Hoy se listan igual (decisión original: "que un proyecto esté limpio es información"), pero con 17 backlogs la tarjeta se alarga.
- [ ] **Guardar el `path` además de la `key` en la propuesta** — la propuesta vive 1 h en KV y el cache de descubrimiento dura 10 min; si el árbol cambia en el medio, `pickFreeKey` podría reasignar la clave y el ítem terminaría en otro proyecto que el que decía la tarjeta. Probabilidad baja. Fix: guardar el path resuelto y comparar al confirmar.
- [ ] **`↩️ Deshacer` tras guardar** — la tarjeta del Journal lo ofrece y la del backlog no. Para `add` es un `markBacklogDone` invertido; para `done`, trivial.

### Surgió en sesión 2026-07-25 — tool de escritura en BACKLOG.md
- [x] ✅ **HECHO 2026-07-28** — **Tool para que Jano lea y escriba el `BACKLOG.md` del proyecto (chat/Telegram)** — pedido de Cal: se le ocurren ideas charlando con Jano y hoy no tiene forma de anotarlas. Alcance inicial: (1) tool de **lectura** (`getBacklog` o similar) que devuelva el contenido actual para que Jano lo pueda mostrar/discutir, (2) tool de **escritura** (`appendBacklogItem`/`updateBacklog`) que permita agregar o modificar ítems del `BACKLOG.md` de este mismo repo (`Personal/Agents/Jano/BACKLOG.md`) a partir de lo que Cal le pida en la charla. Diseño a definir: ¿append-only (agrega bajo una sección "Surgió en sesión {fecha}", más simple y seguro) vs. edición libre de cualquier línea (más flexible, más riesgo de romper formato)? Evaluar si conviene arrancar solo con append para minimizar riesgo de que el LLM corrompa el archivo, y dejar edición fina para después. Antes de implementar, seguir el flujo de planning normal (Cal aprueba approach) — no ejecutar directo.

### Surgió en sesión 2026-07-23/24 — kpi-ingest-check (doble pipeline CSV+PDF)
- [ ] **Ampliar scope OAuth de Gmail a `gmail.modify`** — pendiente, requiere que Cal autorice en el navegador (flujo OAuth loopback). Necesario para que `archiveAndMarkRead()` (`kpi-ingest-check.ts`) archive+marque leído el mail de "Seguimiento Diario Yape Bolivia" tras procesarlo (replica el comportamiento del agente de Notion AI viejo). Hoy falla con 403, logueado (`kpi_ingest_archive_failed`), no rompe el resto del flujo — el mail simplemente queda en el inbox. Reusar el mismo refresh token compartido `GMAIL_OAUTH_REFRESH_TOKEN_LEPESQUEUR` (proyecto `jano-youtube`, ver `Jano/CLAUDE.md` sección "scheduleKpiIngestCheck") — reemplazar el token en `apps.env`.
  - **Confirmado 2026-07-28 (pedido de Cal de ratificar el pendiente):** **9 fallas** de archivado entre el 24 y el 27 de julio, y **exactamente 9 ingestas exitosas** en el mismo período (`kpi_ingest_full_report` + `kpi_ingest_pdf_full_report` en `cos-agent-v2.out.log`). O sea la correspondencia es 1:1 — **falla solo el paso 4 (archivar); los KPIs llegan completos a Notion, las tarjetas se generan y el reporte llega a Telegram**. El impacto es puramente cosmético: ~9 mails de BCP acumulados sin leer en el inbox.
  - **Dato que abarata el fix:** `gmail.modify` **incluye** `gmail.readonly`, así que el token nuevo NO rompe el otro consumidor de esa credencial (el Ulanzi / `gmail-update.sh`). Tampoco hace falta un proyecto de Google Cloud nuevo: se reusa `jano-youtube`, ya configurado. El único paso que no se puede automatizar es el clic de "Permitir" de Cal.
  - **Ampliado 2026-07-28:** el cron nuevo de Tareas (`scheduleTaskEmailCheck()`, `task-check.ts`) también llama `archiveAndMarkRead()` y tiene el mismo gap — ahora son 2 pipelines bloqueados por el mismo scope faltante (el de "Seguimiento Diario Yape Bolivia" y el de mails "(Tarea)"), no 1.
  - **Cambió el peso del pendiente el mismo día (rediseño a tarjeta + cola):** con "crear al confirmar", el mail sin archivar pasó de ser cosmético a ser **el respaldo real** mientras la propuesta espera en el chat — si Cal nunca toca la tarjeta, el correo en la inbox es lo único que queda. Además el archivado ya no ocurre al detectar el mail sino al **confirmar la tarea** (dentro de `createTaskFromProposal`, junto con los correos de seguimiento del mismo hilo), así que cuando se resuelva el scope conviene verificar ese orden y no reintroducir un archivado temprano.

### Surgió en sesión 2026-07-28 — tarjeta de propuesta de tareas
- [ ] **Verificar en producción la @mención de Notion** (`notifyMissingDate`) — requiere que la integración "Claude CoS" tenga habilitada la capacidad de insertar comentarios en el Developer Portal. Nunca se comprobó con una tarea real; si falla es un 403 logueado (`task_notify_missing_date_failed`) que no rompe nada, pero la notificación que pedía el spec no llega. Chequear tras la primera tarea creada con Fecha o Deadline vacíos.
- [ ] **Primera prueba end-to-end de la tarjeta** — al 2026-07-28 el pipeline quedó verificado hasta la búsqueda de Gmail (6 mails, credenciales y adjuntos OK), pero la tarjeta misma no se probó en vivo porque los 6 correos existentes ya tenían tarea creada. Falta reenviar un mail nuevo con "(Tarea)" y recorrer los pickers de asignado/Fecha/Deadline, el `✍️ Escribir` y el avance de cola.
- [ ] **Regenerar el snapshot de People cuando envejezca** — `npx tsx scripts/refresh-task-people.ts --write`. El actual se tomó el 2026-07-28 sobre 763 tareas. No hay recordatorio automático; el síntoma es tener que usar `✍️ Otro` seguido para la misma persona.
- [ ] **Adjuntos de un mail de seguimiento** — hoy solo se sube el texto (decisión de Cal para v1). Si hace falta, extender la rama de followups de `createTaskFromProposal` para llamar `uploadAttachments` también ahí.

### ✅ Completados recientes
- [x] **WhatsApp link skill** ✅ 2026-05-08 — Tools `getWhatsappContacts` + `saveWhatsappContact` en daemon-v2 (`tools/whatsapp.ts` + tests). Skill CLI en `~/.claude/skills/whatsapp/`. Contactos compartidos en `~/.claude/whatsapp-contacts.md`. Replicado en Vesta. Spec/plan: `docs/superpowers/{specs,plans}/2026-05-08-whatsapp-link-skill*.md`. Bug fix MCP -32602: `saveWhatsappContact` retornaba void → JSON.stringify(undefined) → text:undefined; ahora retorna confirmación de texto.

### Surgieron en sesión 2026-05-08
- [x] **Reestructurar Jano/CLAUDE.md** — ✅ HECHO 2026-06-13: reescrito como guía operativa + índice (85 líneas, de 156). Detalle de producto → punteros al código; automatización dormida. Spec/plan en `docs/superpowers/`.
- [ ] **System-prompt: regla "mira X" = WebSearch** — cuando Cal usa "mira X" sin entidad local clara, default a WebSearch sobre Santa Cruz/Bolivia. Bug observado 2026-05-08: "mira restaurantes vigentes" → Jano buscó listas en Apple Notes/Notion en vez de buscar en web. Agregar disambiguación en system-prompt o pedir confirmación con botones inline cuando el comando sea ambiguo.

### Migración MCP apple-reminders → EventKit (2026-05-04)
- [ ] **Reemplazar wrapper `keith/reminders-cli`** en `~/Claude Projects/Personal/MCP Servers/mcp-servers/servers/apple-reminders/` por una solución basada en EventKit nativo. Limitación actual: el CLI underlying (`reminders-cli` 2.5.1) **NO soporta priority ni dueDate en `edit`** — solo title y notes. El MCP ahora throw-ea error claro si el LLM intenta. Eisenhower semanal queda como reporte visual sin escritura de prioridades.
- **Opciones evaluadas (2026-05-04):**
  - **A) Swap del CLI underlying** por `BRO3886/rem` (Go + cgo + EventKit), `AungMyoKyaw/apple-reminders-cli` (Swift + EventKit), o `ekctl` (Swift). Riesgo: TCC re-grant + ajustar wrapper TS si la API difiere.
  - **B) Reemplazar el MCP completo** por un publicado: [FradSer/mcp-server-apple-events](https://github.com/FradSer/mcp-server-apple-events) o [Krishna-Desiraju/apple-reminders-swift-mcp-server](https://github.com/Krishna-Desiraju/apple-reminders-swift-mcp-server) — soportan priority + dueDate + recurring + location + tags. Requiere actualizar `BASE_OPTIONS.mcpServers` de Jano + Vesta + Pecunia + system prompts.
  - **C) Helper Swift custom** firmado con TCC + EventKit. Más esfuerzo pero control total.
- **Triggers para priorizar:** Eisenhower no actualiza prioridades en Apple, recurring/location/tags se vuelvan necesarios, o un MCP de la lista se vuelva mantenedor activo en npm.

### Hooks pendientes de revisar (2026-05-02)
- [x] ✅ **pre-compact-snapshot.sh** — registrado como PreCompact hook en `settings.json` (activo)
- [x] ✅ **notion-audit.sh** — registrado como PostToolUse(Notion) hook en `settings.json` (activo)
- [x] ✅ **stop-telegram-notify.sh** — registrado como Stop hook en `settings.json` (activo, contrario a lo que decía este BACKLOG antes)
- [x] ✅ **Limpiar `~/.claude/channels/telegram/.env`** (2026-05-04) — token de Jano removido (rotado vía BotFather, invalidó copias leakeadas en transcripts). Quedan solo `NOTION_TOKEN` y `HEALTH_API_KEY` en el .env. Como parte de la migración Jano+Vesta al modelo Pecunia (sin plugin interactivo), state dirs `telegram-cos/` y `telegram-family/` fueron eliminados completos.
- [ ] **Validar setup de Yapito** (`@yapito_cal_bot`, `~/.yapito/.env`) — durante el inventario 2026-05-03 vimos que NO tiene webhook configurado y no aparece daemon en `launchctl list`. Confirmar si está activo en otra máquina, archivado, o si necesita setup completo (worker CF + queue + daemon Node estilo Pecunia).
- [ ] **Revisar contenido y formato del nightly-report cron** (2026-05-04) → reporte 2026-05-03 22:00 mostró: (1) "GCal no disponible" pese a tener `mcp__claude_ai_Google_Calendar__list_events` en `--allowedTools` — el OAuth Max del cron no autoriza el MCP, ver log; (2) formato Markdown legacy con `**bold**` (revisar parse_mode usado vs HTML que usa el daemon Jano); (3) **validar con Cal qué secciones deben ir en el briefing** antes de tocar el script — el contenido actual (Hoy/Pendientes/Mañana/Feedbin/Readwise/Sugerencia/Learnings) puede no ser el set ideal. Script: `~/.claude/hooks/nightly-report.sh`.

### Cierre OpenClaw — Fase 6 (multi-agente)
- [ ] **Revisar y cerrar el plan OpenClaw** — Fases 1-5 implementadas. Fase 6 (multi-agent) es la única pendiente. Decidir si se implementa, se archiva como "out of scope por ahora", o se reformula. Consolidar learnings en `docs/superpowers/`.

### Salud (2026-05-01)
- [ ] **Definir metas de Cal en "Metas Salud"** — poblar Notion DB con targets concretos: pasos diarios, hrs sueño, HRV target, body fat % objetivo, sesiones strength/semana.
- [ ] **Configurar `weight`/`body_mass` en Health Auto Export (iOS)** — habilitar "Body Mass" en la app para que el D1 la ingeste. Actualmente solo hay `body_fat_percentage`, `lean_body_mass`, `body_mass_index`.

### ✅ Migración CoS v2 (2026-04-29)
- **Hecho:** daemon `com.cal.cos-agent-v2`, worker CF, callback router edge, 9 tools custom, hooks adaptados, cutover completo. Spec/plan en `docs/superpowers/{specs,plans}/2026-04-28-cos-agent-v2-*`.

### Spotify control con lenguaje natural (post-cutover)
- **Pedido Cal 2026-04-29:** integrar Spotify pero NO con callbacks dedicados — el agent interpreta "pausa", "skip", "qué suena" y llama una tool `spotifyControl` con lenguaje natural.
- **Infra existente:** worker `spotify-auth.carlos-cb4.workers.dev` (OAuth flow). Pendiente: endpoint exacto para access token + crear `daemon-v2/src/tools/spotify.ts` con args `{ action, query? }`.

### Crons secundarios — Estado post-auditoría 2026-05-24

> ⚠️ **TODOS DESACTIVADOS 2026-06-13 (dormidos).** Los 5 "activos" de abajo fueron `bootout` + archivados en `~/Library/LaunchAgents/disabled-2026-06-13/` (sus plists quedaron corruptos por un script de update de schedule). Jano corre 100% reactivo. Reactivar requiere reconstruir el plist — ver `docs/references/hooks-automatizacion.md`.

**Activos (5) → [BLOQUEADO — automatización dormida 2026-06-13]:**
- `com.claude.heartbeat` — cada 30min, 7am-22:30
- `com.claude.nightly-report` — 22:00 diario
- `com.claude.eisenhower-weekly` — Dom 21:00
- `com.claude.outlook-cache` — cada 4h
- `com.cal.jano-morning-build` — 22:30 diario (renombrado desde `com.claude.morning-build`)

**Deshabilitados intencionalmente:**
- `com.claude.daily-briefings` — `.disabled` en LaunchAgents. On-demand via `runBriefing` tool. Si se quiere 5am automático, renombrar quitando `.disabled`.

**Sin cargar — requieren decisión:**
- `com.claude.extract-learnings` — batch nocturno 21:55 que consolida learnings de transcripts. Nunca fue cargado. Verificar que `extract-learnings.sh` apunte a `~/.npm-global/bin/claude` antes de activar.
- `com.claude.sync-learnings` — sync semanal Dom 21:00 de learnings al repo. Nunca fue cargado.
- `com.claude.skill-detector` — Dom 21:30, escanea transcripts y propone skills. Nunca fue cargado (BACKLOG decía "cargado 2026-04-20" — era incorrecto). Mismo check de CLI path antes de activar.

**Bloqueado por tokens externos:**
- `com.claude.proactive-ideas` — requiere `X_BEARER_TOKEN`, `X_THREADS_TOKEN`, `NOTION_IDEAS_DB_ID` en `~/.cos-agent/.env`.

**Obsoletos — candidatos a eliminar:**
- `disabled-2026-04-21/com.cal.cos-health-check.plist` — reemplazado por heartbeat engine
- `disabled-2026-04-21/com.claude.morning-build.plist` — reemplazado por `com.cal.jano-morning-build`
- `disabled-2026-04-29/com.cal.cos-agent.plist` — reemplazado por `com.cal.cos-agent-v2`

**Deuda de docs en heartbeat-tasks/:**
- `overdue-reminders.md` — CLAUDE.md lo menciona como `overdue-tasks.md` (nombre viejo, actualizar)
- `usage-morning.md` y `usage-evening.md` — sin documentar en CLAUDE.md

### Migrar Family/Vesta de MarkdownV2 a HTML (Fase 3 - 2026-04-29)
- **Bug compartido con CoS pre-fix:** Family/Vesta system-prompt instruye MarkdownV2 al LLM, pero el `shared-v2/src/telegram.ts` ya tiene default `HTML`. Resultado: LLM genera `*texto*`, `\.`, `\!` y al mandar como HTML → Cal/Noe ven los caracteres literales (asteriscos, backslashes en puntos).
- **Cambios necesarios** (espejo del fix en CoS aplicado 2026-04-29):
  - `Family/shared-v2/src/telegram.ts`: agregar soporte `parseMode: null` (texto plano) + helper `escapeHtml()`.
  - `Family/daemon-v2/src/index.ts`: reemplazar `escapeMarkdownV2()` por `escapeHtml()`, todos los `editMessage` con `"HTML"`, fallback con `null` parse para garantizar entrega, templates de error con `<b>` en vez de `*`.
  - `Family/daemon-v2/src/system-prompt.ts`: reescribir bloque "Formato MarkdownV2" → HTML, plantillas en HTML.
  - `Family/daemon-v2/src/cron-tasks.ts`: prompts de briefings instruyen MarkdownV2 — cambiar a HTML.
- **Build + restart:** `npm -w @family/shared run build && npm -w @family/daemon run build && launchctl bootout/bootstrap com.cal.family-agent-v2`.
- **Validación:** mandar mensaje al grupo Family que típicamente tendría caracteres reservados (números, guiones, paréntesis); confirmar que llega con formato HTML correcto.

### ✅ Hooks conflict guard (resueltos 2026-04-29 con cutover v2)
- Hooks `cos-channel-bootout.sh` + `cos-channel-bootstrap.sh` ahora coordinan webhook (deleteWebhook gracioso al abrir sesión, setWebhook restore al cerrar última).

### ✅ Deshacer integración Spotify completa (2026-04-20)
- **Removido:** `telegram-plugin/spotify-client.ts`, handlers `spotify:*` en `callback-router.ts`, carpetas `spotify-miniapp-worker/` + `spotify-auth-worker/`, secrets `.env` (`SPOTIFY_AUTH_WORKER_URL`), workers Cloudflare (`spotify-auth` + `spotify-miniapp`), KV `spotify-auth-SPOTIFY_TOKENS`, secciones CLAUDE.md
- **Mantenido:** Spotify Developer App en console.spotify.com (eliminar es irreversible), CHANGELOG + specs históricos
- ~~**Pendiente manual Cal:** reset `setChatMenuButton` a default~~ — ✅ reseteado 2026-05-24 a `type: commands` (estaba como `web_app` apuntando a Panini album)

### Referencia: Filesystem-based knowledge system (alt RAG) — @soyabraham.ia
- **Fuente:** Post de Threads — https://www.threads.com/@soyabraham.ia/post/DXUxwD3jVX6
- **Autor:** Abraham Olvera (@soyabraham.ia), inspirado en Andrej Karpathy
- **Idea:** Reemplazar RAG con vector DB por estructura de filesystem + CLAUDE.md como esquema mental
- **Estructura propuesta:**
  - `raw/` — fuentes inmutables (artículos, transcripts, PDFs originales)
  - `wiki/` — knowledge compilado (síntesis del raw)
  - `outputs/` — respuestas archivadas
  - `CLAUDE.md` — instrucciones de cómo pensar
  - `index.md` — mapa central, LLM busca directo (sin embeddings)
  - `log.md` — memoria persistente cronológica entre sesiones
  - **Health check** periódico — detecta contradicciones y archivos huérfanos
- **Qué adoptar (mi recomendación):**
  1. **`index.md` como mapa central** — útil cuando crece el proyecto, evita que el LLM adivine dónde está cada cosa
  2. **Health check semanal** — como heartbeat task adicional, escanea docs y reporta inconsistencias
  3. (Opcional) `raw/` vs `wiki/` separation — overkill hoy, considerar si el volumen crece
- **Aplicar a:** Refactorizar la organización de docs/, specs/, plans/ del CoS si decidimos adoptarlo
- **Status:** Pendiente decidir alcance + prioridad (no es urgente, framework ya funciona bien)

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
- **Doc completo:** `/Users/calepes/Claude Projects/Claude Code Setup/docs/articulos/01kcy4pypx-tal-raviv-personal-ai-copilot.md`

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
- [x] Aprobaciones rápidas (sí/no) — callbacks `approve:yes[:context]` y `approve:no[:context]` procesados mecánicamente (2026-04-19)
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
- [x] Deep link para abrir Spotify cuando no hay dispositivo activo — callback-router detecta "No active device" y responde con botón URL "🎵 Abrir Spotify" (2026-04-19)
- Spec: `docs/superpowers/specs/2026-04-11-spotify-control-design.md`
- Plan: `docs/superpowers/plans/2026-04-11-spotify-control.md`

### Apple Health — Datos de salud desde Telegram (código listo, pendiente config)
- [x] Cloudflare Worker + D1 — creado
- [x] Migration SQL — creada
- [x] Deploy Worker + D1 + secrets (2026-04-12)
- [x] Instalar y configurar Health Auto Export en iPhone (2026-04-12)
- [x] Test ingesta de datos — data llegando correctamente (2026-04-12)
- [x] Fix: parser adaptado a formato anidado real de Health Auto Export (2026-04-12)
- [x] Integrar en briefing /today como sección opcional (2026-04-12)
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
- [x] Rate limit 429 — backoff exponencial en frontend (2026-04-12)
- Spec: `docs/superpowers/specs/2026-04-12-spotify-miniapp-design.md`
- Plan: `docs/superpowers/plans/2026-04-12-spotify-miniapp.md`

### UX Telegram — Mejoras de fluidez
- [x] **Editar mensaje en navegación de menú** — edit_message en callbacks menu:*, skill actualizado, server.ts no destruye mensaje en menu callbacks (2026-04-12)
- [x] **Limitar keyboards a 4 filas max** — MAX_KEYBOARD_ROWS=4 en reply y edit_message (2026-04-12)
- [x] **Mini App para flujos complejos** — implementado: Spotify Mini App TWA (2026-04-12)
- [x] **Loading transitions mecánicas** — callbacks `menu:*` hacen edit instantáneo ("⏳ Cargando...") en el plugin antes de pasar al LLM (~150ms). Approach A: edit texto + quitar botones (2026-04-12)
- [x] **MenuButtonWebApp** — script `scripts/setup-menu-button.sh` configura setChatMenuButton apuntando a Mini App (2026-04-19). Actual: Spotify Mini App con label "🎵 Abrir". Cambiar en el futuro si se crea una Mini App main menu
- [x] **Polling robusto** — telegram-plugin retry en cualquier error (no solo 409). Reset attempt counter en onStart. Antes ETIMEDOUT/ECONNRESET mataban el polling silenciosamente (2026-04-19)
- [x] **Health check end-to-end** — `scripts/health-check.sh` detecta long-poll colgado (200+empty vs 409 Conflict) y fuerza relanzamiento del LaunchAgent (2026-04-19)

### Documentación Telegram
- [x] **telegram-reference.md** — referencia cross-project consolidada en `~/Claude Projects/telegram-reference.md`. Cubre: bot, plugin fork, callbacks, UX patterns, integraciones (CoS, Presupuesto, MCP), workers, hooks, gotchas (2026-04-12)

### CoS Proactivo — Plan inspirado en OpenClaw (2026-04-12)
Referencia: artículos OpenClaw de Claire Vo, Federico Viticci (MacStories), guía completa

**Fase 1: Hooks básicos** (30 min c/u)
- [x] 1.1a Hook SessionStart → inyectar fecha/hora actual (implementado 2026-04-12)
- [x] 1.1b Hook SessionStart → tareas vencidas Notion + calendar. Script: `~/.claude/hooks/session-start-context.sh`. Nota: requiere compartir DB con integración "Claude CoS" para query directo; fallback a instrucciones MCP (2026-04-12)
- [x] 1.2 Hook Stop → push notification a Telegram. Script: `~/.claude/hooks/stop-telegram-notify.sh`. Solo notifica en `end_turn` (2026-04-12)
- [x] 1.3 Hook PreCompact → snapshot del transcript antes de compactar. Script: `~/.claude/hooks/pre-compact-snapshot.sh`. Últimos 20 snapshots en `~/.claude/compact-snapshots/` (2026-04-19)
- [x] 1.4 Hook PostToolUse(Notion) → audit log de escrituras. Script: `~/.claude/hooks/notion-audit.sh` filtrado a `mcp__notion__.*`, loguea a `~/.claude/logs/notion-audit.log` con rotación a 5MB (2026-04-19)

**Fase 1.5: Outlook Calendar + Cron cache** (implementado 2026-04-12)
- [x] ICS feed de Outlook integrado en hook SessionStart (cache local + launchd cada 4h)
- [x] Script: `~/.claude/hooks/refresh-outlook-cache.sh`, cache: `~/.claude/hooks/cache/outlook-events.txt`
- [x] launchd: `~/Library/LaunchAgents/com.claude.outlook-cache.plist`
- [x] /today actualizado: refresca Outlook cache + Google Calendar MCP + Health

**Fase 2: Cron Jobs — Rutinas diarias** (1-2 hrs)
- [x] 2.1 Briefings diarios (5am) → trigger remoto combinado Bolivia + Perú + Colombia. ID: `trig_017HYzPBsdFkjGPb43BnjhPy`. Lee instrucciones de `docs/briefing-pais-instructions.md`, genera HTML Liquid Glass, publica en GitHub Pages, notifica por Telegram via Zapier MCP (2026-04-12)
- [x] 2.2 Reporte nocturno (22:00) → launchd `com.claude.nightly-report` + `~/.claude/hooks/nightly-report.sh`. Resumen día (completadas, eventos), pendientes hoy, plan mañana, sugerencia accionable (2026-04-19)
- [x] 2.3 Eisenhower semanal (Dom 21:00) → launchd `com.claude.eisenhower-weekly` + `~/.claude/hooks/eisenhower-weekly.sh`. Clasifica tareas en Q1-Q4, reporta por Telegram. V1 solo reporta (no actualiza Notion) — agregar campo Eisenhower si Cal lo pide (2026-04-19)

**Fase 3: Heartbeat — Trabajo proactivo** (implementado 2026-04-19)
- [x] 3.1 Heartbeat cada 30min → `~/.claude/hooks/heartbeat.sh` + launchd `com.claude.heartbeat` (cargado, 7am-22:30 cada 30min). Razona sobre contexto, agrupa alerts por prioridad (high/medium/low), buffer único a Telegram, contador de fallos consecutivos (≥3 → alerta). Log rotation 5MB. Status script: `heartbeat-status.sh`. Spec: `2026-04-19-heartbeat-fase3-design.md`. Plan: `2026-04-19-heartbeat-fase3.md`
- [x] 3.2 Heartbeat tasks como Markdown → `~/.claude/heartbeat-tasks/` con frontmatter (`name`, `schedule: every|morning-only|afternoon-only|midday-only`, `priority: high|medium|low`). Checks actuales (2026-05-24): `overdue-reminders.md` (antes llamado `overdue-tasks.md`), `incomplete-tasks.md`, `midday-steps.md`, 7 health checks, `usage-morning.md`, `usage-evening.md`. `flight-checkin.md` movido al daemon (2026-05-10). Cada check responde `HEARTBEAT_OK` o `ALERT\n<mensaje>`
- [x] 3.3 "Proactive ideas" (3x/día) → `~/.claude/hooks/proactive-ideas.sh` + plist `com.claude.proactive-ideas` (creado, NO cargado hasta que Cal configure tokens X/Threads + NOTION_IDEAS_DB_ID). Slots: 9am=foco 🎯, 14:00=tactical ⚡, 19:00=lookahead 🔮. Lee posts propios X+Threads últimas 24h + tareas activas Notion → JSON {title, body, source} → Notion DB "Ideas Proactivas (CoS)" (id `59e0439d7fe0483ab735575b9e0c1007`, anidada bajo "💡 Ideas") + Telegram. Graceful degradation si falta cualquier API.

**Fase 4: Webhooks — Reaccionar al mundo**
- [x] 4.3 Health alertas reactivas (2026-04-19) — 7 checks via heartbeat: sleep, steps-evening, sedentary, hrv-weekly, daylight, strength-weekly (meta 3x/sem), bodycomp-weekly. Anti-spam con state file diario. Spec+plan en `docs/superpowers/`
- ~~4.1 Email webhook (Gmail)~~ — descartado (no relevante hoy)
- ~~4.2 GitHub PRs~~ — descartado (Cal no hace code review)
- ~~4.4 Notion changes~~ — descartado (no relevante)

**Fase 5: Auto-mejora continua** (1 día)
- [x] 5.1 Self-improving (2026-04-20) — sistema captura learnings en `~/.claude/learnings/cos/` (filesystem-RAG indexado), review diario en nightly-report con botones, sync semanal a repo. Tipos: correction/error/decision/idea/pattern. Componentes: skill `/learn`, hook PostToolUse `learn-error.sh`, batch nocturno `extract-learnings.sh`, callbacks `learn:*` mecánicos. **Estado 2026-05-24:** captura individual activa (hook registrado). Plists `sync-learnings` y `extract-learnings` en `disabled-2026-04-21/` — nunca fueron cargados. Batch nocturno y sync semanal NO están corriendo. Spec/plan en `docs/superpowers/`
- [x] 5.2 Morning builds (2026-04-20) — activo como `com.cal.jano-morning-build` (renombrado desde `com.claude.morning-build`). Cron 22:30, genera propuesta, manda a Telegram con botones ✅/❌, executor corre en background con scope estricto. Plist `com.claude.morning-build` en `disabled-2026-04-21/` es obsoleto — limpiar.
- [x] 5.3 Skills auto-instalables (2026-04-20) — script y plist creados. **Estado 2026-05-24:** plist `com.claude.skill-detector` en `disabled-2026-04-21/` — NUNCA fue cargado en producción (documentación anterior decía "cargado 2026-04-20" — incorrecto). Pendiente: verificar path CLI + decidir si activar.

**Fase 6: Multi-agente** (1 día)
- [ ] 6.1 Agentes especializados → `notion-agent`, `research-agent`, `spotify-agent` con sesión aislada. Ref: proyecto `openclaw-agents` instala 9 agentes especializados con un comando + routing por grupo Telegram. Performance: 4 subagentes paralelos = 5min vs 20min secuencial.
- [ ] 6.2 Coordinador principal → recibe intent de Cal, delega a subagentes, ensambla respuesta. Preserva contexto del hilo principal.
- [ ] 6.3 Agent-to-agent → un agente asigna trabajo a otro (Research → Notion para guardar hallazgos). Ref: subagentes NO reciben session tools por defecto (seguridad), profundidad de nesting configurable.

---

## Otros Agentes (backlogs separados)

Cada agente tiene su propia carpeta, CLAUDE.md y BACKLOG.md. Desde aquí se puede consultar y actualizar.

| Agente | Ruta | Estado | Bot Telegram |
|--------|------|--------|-------------|
| **Inversiones** | `~/Claude Projects/Personal/Agents/Inversiones/` | MVP activo | pendiente |
| **Gestión Presupuesto** | `~/Claude Projects/Personal/Agents/Presupuesto/` | Producción (5+ meses) | integrado en PFM |
| **Familiar (Cal + Noe)** | `~/Claude Projects/Personal/Agents/Family/` | Planificación | pendiente |
| **Learning** | `~/Claude Projects/Personal/Agents/Learning/` | Planificación | pendiente |
| **Health & Fitness** | `~/Claude Projects/Personal/Agents/Health/` | Planificación | pendiente |
| **Escolar (Antonia + Catalina)** | `~/Claude Projects/Personal/Agents/School/` | Planificación | pendiente |

Notas:
- **Inversiones** — MVP lanzado 2026-04-06. Portfolio, análisis fundamental, screening. Airtable + Kubera MCP + yfinance. 30 tests
- **Gestión Presupuesto** — Producción desde nov 2025. 1,365+ transacciones. Dashboard Cloudflare Workers, bot Telegram (foto→categoriza), email polling BCP Perú, multi-moneda. D1+KV+R2+Airtable+Claude API. 26 tests E2E
- **Learning** — Kindle, Feedbin, Readwise Reader. Tracking de libros en Notion
- **Health & Fitness** — Coach data-driven. Health Worker vive en `Health/health-worker/` (desplegado en `health.carlos-cb4.workers.dev`, recibiendo data real)
- **Escolar** — Calendario escolar, parciales/finales, material de repaso para Antonia y Catalina
- **Familiar** — Coordinación Cal+Noe, calendarios, conflictos horarios

### Futuro
- [ ] Migrar secrets a 1Password CLI (`op`)
- [x] **Google Maps API — distancias y tiempos** (2026-05-02) → implementado: `searchPlace` (Places API New) + `travelTime` (Routes API v2 TRAFFIC_AWARE) en `tools/maps.ts`. `requestUserLocation` extendido para cualquier consulta de distancia/ruta/ETA.
- [ ] **Aprendizaje de largo plazo (Paweł model)** (2026-05-01) → sistema de knowledge tiers en `~/.claude/learnings/jano/` (facts→hypotheses→rules). Al cerrar sesión, el summary compactado pasa por extracción de patrones. Dependencia: conversation memory operativa primero. Ver diseño en `~/.claude/docs/superpowers/specs/2026-05-01-conversation-memory-design.md`
- [ ] ~~**Evaluar `remindctl` como reemplazo de `reminders-cli`**~~ (parqueado 2026-05-03) → migración no aporta valor: (1) gotcha de índices UUID ya tiene workaround en código (`String(idx)` ignorando `externalId`), (2) `remindctl` también usa EventKit → no evita TCC. Si en el futuro se quiere blindar Reminders contra TCC reset (ej. para portar a otra Mac/VPS sin diálogos), las únicas vías reales son CalDAV directo a iCloud o espejar a Notion — ambos son proyectos en sí, no migraciones de CLI.
- [ ] **Evaluar VPS para correr Claude Code** (agregado 2026-04-21) → alternativa a Mac local + launchd para correr cos-agent y family-agent 24/7. Motivación: problemas recurrentes con health-checks + zombies MCP + dependencia de red local (SNI filtering tumba polling Telegram). Evaluar: costo mensual vs estabilidad, migración del fork del plugin + workers + ambientes, latencia desde/hacia Telegram, y si conviene VPS completo o solo ejecutores remotos. Referencias: spec de watchdog (`docs/references/2026-04-21-agent-launchd-fix.pdf`) — si el VPS resuelve el problema raíz, el rediseño de health-check se vuelve innecesario
