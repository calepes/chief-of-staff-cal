> ✅ Este `BACKLOG.md` es la fuente viva (Atenea/Notion dado de baja 2026-07-02, ver `~/Claude Projects/BACKLOG.md` para el índice general).

# Backlog — Jano

> ✅ **Estado 2026-04-29: CoS v2 ACTIVO** — daemon Node + Agent SDK librería + webhook + CF Queue. Daemon viejo `com.cal.cos-agent` movido a `disabled-2026-04-29/`. Hooks SessionStart/End adaptados (deleteWebhook gracioso, bootstrap restaura webhook). 16 crons secundarios siguen pausados en `disabled-2026-04-21/` pendientes de rediseño. Detalle en `CLAUDE.md` → sección "Estado (2026-04-29)".

## Pendientes

### Surgió en sesión 2026-08-22
- [ ] **Ajustar el cron de salud (scheduleHealthSyncCheck / health-sync-check) para asegurar que la data de Apple Health esté al día y genere reportes de estado de salud**

### Surgió en sesión 2026-08-21
- [ ] **Crear widget que muestre las tareas de Notion de la semana**
- [ ] **Dar contexto al triage de inbox (Spark) para que identifique qué mails son importantes de abrir/leer**

### Surgió en sesión 2026-08-17
- [ ] **Mejoras al resumidor (YouTube + Feedbin starred)** — análisis completo (código real + research de comunidad) listo, esperando que Cal responda 4 preguntas antes de implementar. Falla real y reproducible: timeout de 360s por transcripción sin truncar (pasó el 2026-08-16 22:16, ya había pasado el 2026-07-03). Cron diario apagado desde 2026-07-14 dejó dormido también el flujo de starred (que YA existe, completo, no es idea nueva). Detalle completo, prioridades y preguntas: `HANDOFF-resumidor-mejoras.md`.

### Surgió en sesión 2026-08-16
- [ ] **Que el coaching de salud de Jano (getHealthSummary/getHealthTrend) incluya acciones concretas para subir el HRV cuando detecte que está bajo, no solo reportar el dato**

### Surgió en sesión 2026-08-08

Reorganizado por tema (antes agrupado por fecha/sesión de origen — ver anotaciones `(YYYY-MM-DD)` en cada ítem/sub-sección para la fecha original cuando no está ya en el texto).
- [x] **Crear tool que aprenda qué tipo de artículos/contexto le interesa más a Cal (Feedbin/Reader) para sugerir qué leer y qué marcar como leído automáticamente** — ✅ HECHO 2026-08-25: `scheduleTopicsProfileRefresh()` (domingos 19:00, sintetiza el perfil desde shortlist Reader + starred/leídos Feedbin) + `scheduleFeedbinDailyReport()` (diario 08:00, recomienda qué abrir usando ese perfil — solo sugiere, nunca marca leído). Detalle completo: `CLAUDE.md` sección "Automatización — dos capas".

### Secretos / 1Password
- [ ] **Migrar los secretos de Jano de `apps.env` a 1Password** — fase 2 del piloto hecho en Vesta (fase 1, completa y validada el 2026-08-02: vault `Daemons`, wrapper `op run`, fail-loud real). El vault ya tiene 12 ítems creados y reusables (`Anthropic API Key`, `Notion Integration Token`, `SerpAPI`, `OpenRouter`, `ElevenLabs`, `Google Maps`, `Home PIN`, `OpenWeather`, `WeatherAPI`, `Pecunia Internal`, `Cloudflare Account ID`, `Cloudflare API Token`) — Jano comparte varias de estas credenciales (`ELEVENLABS_VOICE_ID` ya se agregó en texto plano al plist de Jano el mismo día, por ser la misma voz que Vesta; `HOME_PIN`/`GOOGLE_MAPS_API_KEY` genéricos también los usa Jano). Antes de sacar el fallback a `apps.env`: auditar bien las variables reales que lee Jano — el relevamiento de Vesta falló la primera vez porque un grep por `process.env.NOMBRE` no detectó las leídas vía `requireEnv()`/notación de corchete (causó una caída real en producción, con rollback). Referencia técnica completa: `Vesta/docs/superpowers/specs/2026-08-02-1password-secrets-pilot-design.md`. Pointer también en `Personal/Agents/CLAUDE.md`.
- [ ] Migrar secrets a 1Password CLI (`op`)

### Backlog tooling (lectura/escritura de BACKLOG.md)
- [x] ✅ **HECHO 2026-07-28** — **Tool para que Jano lea y escriba el `BACKLOG.md` del proyecto (chat/Telegram)** — pedido de Cal: se le ocurren ideas charlando con Jano y hoy no tiene forma de anotarlas. Alcance inicial: (1) tool de **lectura** (`getBacklog` o similar) que devuelva el contenido actual para que Jano lo pueda mostrar/discutir, (2) tool de **escritura** (`appendBacklogItem`/`updateBacklog`) que permita agregar o modificar ítems del `BACKLOG.md` de este mismo repo (`Personal/Agents/Jano/BACKLOG.md`) a partir de lo que Cal le pida en la charla. Diseño a definir: ¿append-only (agrega bajo una sección "Surgió en sesión {fecha}", más simple y seguro) vs. edición libre de cualquier línea (más flexible, más riesgo de romper formato)? Evaluar si conviene arrancar solo con append para minimizar riesgo de que el LLM corrompa el archivo, y dejar edición fina para después. Antes de implementar, seguir el flujo de planning normal (Cal aprueba approach) — no ejecutar directo. (idea surgida en sesión 2026-07-25)
- [x] **Agregar una acción "cancelado"/"descartado" a proponerItemBacklog, distinta de "hecho"** — ✅ HECHO 2026-08-08: nuevo `kind: "discard"`, tilda el ítem tachándolo (`~~texto~~ — ❌ descartado {fecha}`) en vez del `[x]` limpio de "hecho", para que no se lea como trabajo completado.

#### Pulido de las tools de backlog (2026-07-28)
> Diferidos a propósito del `daemon-health-review` del 2026-07-28 (ninguno bloqueante; el feature
> quedó con 539 tests en verde). Reconsiderar cuando haya uso real.
- [x] **Tope de ítems en `readBacklogCompact`** — ✅ HECHO 2026-08-08: `MAX_ITEMS=40`, con `total` real sin recortar y flag `truncated` para que el modelo avise a Cal si hay más de los que ve. Test de regresión + instrucción en `system-prompt.ts`.
- [x] **Filtrar del mapa los proyectos con 0 pendientes** — ✅ HECHO 2026-08-08: `buildBacklogMap` filtra `pending>0` (aplica también al picker de destino, decisión explícita de Cal). Los escapes (`destother`, error de `proponerItemBacklog`) siguen listando todas las claves sin filtrar.
- [x] **Guardar el `path` además de la `key` en la propuesta** — ✅ HECHO 2026-08-08: `BacklogProposal.path`, poblado al crear/al cambiar destino (`destpick` recalcula con `resolveBacklogPath`). Informativo/auditoría — `resolveBacklogPath` sigue siendo la única fuente para escribir, nunca se reemplaza.
- [x] **`↩️ Deshacer` tras guardar** — ✅ HECHO 2026-08-08: snapshot del archivo completo antes de escribir (KV, TTL 10 min, mismo patrón que Journal), botón en las 3 tarjetas de confirmación (add/done/discard). Gap aceptado: si Cal guarda 2 ítems seguidos y deshace el más viejo, también se pierde el más nuevo — el archivo está en git, esa es la red de seguridad real.

### KPI ingest Yape (doble pipeline CSV+PDF)
- [x] **Ampliar scope OAuth de Gmail a `gmail.modify`** — ✅ HECHO 2026-08-08: Cal autorizó vía flujo OAuth loopback (proyecto `jano-youtube`, cuenta `carlos@lepesqueur.net` verificada antes de persistir), `GMAIL_OAUTH_REFRESH_TOKEN_LEPESQUEUR` regenerado en `apps.env` (backup previo guardado), scope confirmado `gmail.modify` vía `tokeninfo`. Daemon reiniciado sin errores nuevos. El token nunca se imprimió en la conversación. Pendiente de confirmar en vivo con el próximo mail real que `archiveAndMarkRead()` deje de dar 403 (antes fallaba solo el paso 4/archivar; KPIs/tarjetas/Telegram nunca se vieron afectados). (pipeline kpi-ingest-check surgió en sesión 2026-07-23/24)
  - **Confirmado 2026-07-28 (pedido de Cal de ratificar el pendiente):** **9 fallas** de archivado entre el 24 y el 27 de julio, y **exactamente 9 ingestas exitosas** en el mismo período (`kpi_ingest_full_report` + `kpi_ingest_pdf_full_report` en `cos-agent-v2.out.log`). O sea la correspondencia es 1:1 — **falla solo el paso 4 (archivar); los KPIs llegan completos a Notion, las tarjetas se generan y el reporte llega a Telegram**. El impacto es puramente cosmético: ~9 mails de BCP acumulados sin leer en el inbox.
  - **Dato que abarata el fix:** `gmail.modify` **incluye** `gmail.readonly`, así que el token nuevo NO rompe el otro consumidor de esa credencial (el Ulanzi / `gmail-update.sh`). Tampoco hace falta un proyecto de Google Cloud nuevo: se reusa `jano-youtube`, ya configurado. El único paso que no se puede automatizar es el clic de "Permitir" de Cal.
  - **Ampliado 2026-07-28:** el cron de Tareas (`scheduleTaskEmailCheck()`, `task-check.ts`) también llama `archiveAndMarkRead()` y tenía el mismo gap — eran 2 pipelines bloqueados por el mismo scope faltante (el de "Seguimiento Diario Yape Bolivia" y el de mails "(Tarea)"). **Resuelto 2026-08-08 para los dos**, mismo token compartido. `daily-note-check.ts` nunca estuvo afectado — no llama `archiveAndMarkRead()`, solo lee/busca.
  - **Cambió el peso del pendiente el mismo día (rediseño a tarjeta + cola):** con "crear al confirmar", el mail sin archivar pasó de ser cosmético a ser **el respaldo real** mientras la propuesta espera en el chat — si Cal nunca toca la tarjeta, el correo en la inbox es lo único que queda. Además el archivado ya no ocurre al detectar el mail sino al **confirmar la tarea** (dentro de `createTaskFromProposal`, junto con los correos de seguimiento del mismo hilo), así que cuando se resuelva el scope conviene verificar ese orden y no reintroducir un archivado temprano.

### Tareas por mail (tarjeta de propuesta) (2026-07-28)
- [ ] **Verificar en producción la @mención de Notion** (`notifyMissingDate`) — requiere que la integración "Claude CoS" tenga habilitada la capacidad de insertar comentarios en el Developer Portal. Nunca se comprobó con una tarea real; si falla es un 403 logueado (`task_notify_missing_date_failed`) que no rompe nada, pero la notificación que pedía el spec no llega. Chequear tras la primera tarea creada con Fecha o Deadline vacíos.
- [ ] **Primera prueba end-to-end de la tarjeta** — al 2026-07-28 el pipeline quedó verificado hasta la búsqueda de Gmail (6 mails, credenciales y adjuntos OK), pero la tarjeta misma no se probó en vivo porque los 6 correos existentes ya tenían tarea creada. Falta reenviar un mail nuevo con "(Tarea)" y recorrer los pickers de asignado/Fecha/Deadline, el `✍️ Escribir` y el avance de cola.
- [ ] **Regenerar el snapshot de People cuando envejezca** — `npx tsx scripts/refresh-task-people.ts --write`. El actual se tomó el 2026-07-28 sobre 763 tareas. No hay recordatorio automático; el síntoma es tener que usar `✍️ Otro` seguido para la misma persona.
- [ ] **Adjuntos de un mail de seguimiento** — hoy solo se sube el texto (decisión de Cal para v1). Si hace falta, extender la rama de followups de `createTaskFromProposal` para llamar `uploadAttachments` también ahí.

### Mundial / deportes
- [x] **Archivar (NO borrar) el MCP `worldcup` + tools FIFA avanzadas** — ✅ HECHO 2026-08-08. Desregistrado de `daemon-v2/src/index.ts` (`BASE_OPTIONS.mcpServers`, incluida la var `API_FOOTBALL_KEY` huérfana que quedó tras sacarlo), `agent-options.ts` (29 tools de la allowlist), `agent.ts` (`TOOL_MESSAGES`) y `system-prompt.ts` (sección completa "Mundial 2026"). Código del MCP dejado **in-place sin mover** (`Personal/MCP Servers/mcp-servers/servers/worldcup/`) — decisión explícita, no vale la pena mover dado que hay un pendiente aparte ([[project_worldcup_multi_competicion_pendiente]]) de generalizarlo para Champions/Libertadores/Sudamericana/Eliminatorias/Colombia (mismo API-Football, `league_id` ya confirmados). Skill `mundial-analisis-diario` marcado ARCHIVADO en su `description` (cuerpo intacto). Confirmado que ningún otro agente (Vesta/Pecunia/Yapito/Atenea) tenía este MCP registrado. `daemon-health-reviewer` sin bloqueantes; 2 warnings corregidos (var huérfana + referencia desactualizada en `Jano/CLAUDE.md`). Build limpio. Pendiente: restart del daemon en producción, con confirmación de Cal. (pedido de dar de baja surgió en sesión 2026-07-25)

### Salud
- [x] **Crons proactivos de metas de salud** — ✅ HECHO 2026-08-08 (pedido de Cal): `proactive/health-goals-check.ts`, 2 crons mecánicos (sin LLM) registrados en `index.ts`. **Mediodía (12:30):** evalúa "Pasos al mediodía" vs Target. **Cierre (21:00):** evalúa "Pasos diarios" y "Sueño diario" vs Target. Fuente: DB Notion "Metas Salud" (`Target`/`Unidad` por título) + Health Worker (`/summary`, `/measurements`). Avisa solo si `actual < target * 0.85` (silencio si vas bien, mismo criterio que los reportes de KPIs). **Valida sync reciente antes de evaluar** (`/status`, umbral 2h mediodía / 4h cierre) — si Health Auto Export no sincronizó, pide hacer sync en vez de arriesgar un falso "no caminaste nada". Fuerza/Cardio semanal, HRV, grasa/masa corporal y luz natural quedan **fuera** de estos crons a propósito (cadencia semanal o de tendencia lenta — evaluarlos todos los días generaría ruido falso); pendiente un resumen semanal aparte para esas 6 si Cal lo pide. `daemon-health-reviewer` sin bloqueantes; 3 warnings corregidos (log faltante si el título de una meta no matchea en Notion, edge case `Target: 0` tratado como falsy, `todayLaPaz()` reimplementado → ahora reusa `nowInLaPaz()` de `journal-capture.ts`). Riesgo aceptado sin resolver: en un corte de sync que dure todo el día, estos crons pueden sumar hasta 2 avisos de "no puedo chequear" además de la alerta ya deduplicada de `scheduleHealthSyncCheck()` — mensajes con propósito distinto, sin dedup cruzado entre los dos mecanismos.
- [ ] **En el mensaje de alerta del cron de corte de sync de Apple Health (health-sync-check.ts): reemplazar el timestamp ISO crudo del "último dato" (ej. 2026-07-29T22:44:44.324Z) por un formato legible en hora La Paz (ej. "ayer 22:44") — el "hace Xh" ya está bien, es el timestamp entre paréntesis el que hay que arreglar** (2026-07-30)
- [x] **Definir metas de Cal en "Metas Salud"** — ✅ HECHO: verificado 2026-08-08 vía query directa a Notion — 9 metas cargadas (pasos diarios 8000, pasos mediodía 4000, sueño 7hrs, fuerza 3 sesiones/sem, cardio 2 sesiones/sem, HRV 70ms, grasa corporal 20%, masa magra 62kg, luz natural 15min). Nadie había tildado el ítem. (2026-05-01)
- [x] **Configurar `weight`/`body_mass` en Health Auto Export (iOS)** — ✅ HECHO: verificado 2026-08-08 vía query directa al D1 (`weight_body_mass`, kg, últimas entradas 2026-08-03/07-27/07-21/07-19) — ya está habilitado e ingiriendo. (2026-05-01)

#### Apple Health — Datos de salud desde Telegram (código listo, pendiente config)
- [x] Cloudflare Worker + D1 — creado
- [x] Migration SQL — creada
- [x] Deploy Worker + D1 + secrets (2026-04-12)
- [x] Instalar y configurar Health Auto Export en iPhone (2026-04-12)
- [x] Test ingesta de datos — data llegando correctamente (2026-04-12)
- [x] Fix: parser adaptado a formato anidado real de Health Auto Export (2026-04-12)
- [x] Integrar en briefing /today como sección opcional (2026-04-12)
- Spec: `docs/superpowers/specs/2026-04-11-apple-health-design.md`
- Plan: `docs/superpowers/plans/2026-04-11-apple-health.md`

### WhatsApp
- [x] **WhatsApp link skill** ✅ 2026-05-08 — Tools `getWhatsappContacts` + `saveWhatsappContact` en daemon-v2 (`tools/whatsapp.ts` + tests). Skill CLI en `~/.claude/skills/whatsapp/`. Contactos compartidos en `~/.claude/whatsapp-contacts.md`. Replicado en Vesta. Spec/plan: `docs/superpowers/{specs,plans}/2026-05-08-whatsapp-link-skill*.md`. Bug fix MCP -32602: `saveWhatsappContact` retornaba void → JSON.stringify(undefined) → text:undefined; ahora retorna confirmación de texto.

### Documentación / system-prompt
- [x] **Reestructurar Jano/CLAUDE.md** — ✅ HECHO 2026-06-13: reescrito como guía operativa + índice (85 líneas, de 156). Detalle de producto → punteros al código; automatización dormida. Spec/plan en `docs/superpowers/`.
- [x] **System-prompt: regla "mira X" = WebSearch** — ✅ HECHO 2026-08-08: agregada regla de disambiguación en `system-prompt.ts` (sección "### Web"). "mira X" sin entidad local clara → WebSearch (Santa Cruz/Bolivia por default); excepción explícita para no romper los triggers ya cableados de Feedbin/starred, playlist YouTube y Reader (hallado por `daemon-health-reviewer` antes de restart). Build limpio. Pendiente: restart del daemon en producción, con confirmación de Cal. (surgido en sesión 2026-05-08)

### Spotify

**Spotify control con lenguaje natural (post-cutover):**
- **Pedido Cal 2026-04-29:** integrar Spotify pero NO con callbacks dedicados — el agent interpreta "pausa", "skip", "qué suena" y llama una tool `spotifyControl` con lenguaje natural.
- **Infra existente:** worker `spotify-auth.carlos-cb4.workers.dev` (OAuth flow). Pendiente: endpoint exacto para access token + crear `daemon-v2/src/tools/spotify.ts` con args `{ action, query? }`.

#### ✅ Deshacer integración Spotify completa (2026-04-20)
- **Removido:** `telegram-plugin/spotify-client.ts`, handlers `spotify:*` en `callback-router.ts`, carpetas `spotify-miniapp-worker/` + `spotify-auth-worker/`, secrets `.env` (`SPOTIFY_AUTH_WORKER_URL`), workers Cloudflare (`spotify-auth` + `spotify-miniapp`), KV `spotify-auth-SPOTIFY_TOKENS`, secciones CLAUDE.md
- **Mantenido:** Spotify Developer App en console.spotify.com (eliminar es irreversible), CHANGELOG + specs históricos
- ~~**Pendiente manual Cal:** reset `setChatMenuButton` a default~~ — ✅ reseteado 2026-05-24 a `type: commands` (estaba como `web_app` apuntando a Panini album)

#### Spotify — Control desde Telegram (código listo, pendiente config)
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

#### Spotify Mini App (TWA) — Implementado (2026-04-12)
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

### Callbacks/UX Telegram

- [x] ~~**Migrar Family/Vesta de MarkdownV2 a HTML**~~ (Fase 3 - 2026-04-29) — ✅ YA NO APLICA (verificado 2026-08-08): `Vesta/daemon-v2/src/system-prompt.ts` ya instruye explícito "parse_mode HTML. NUNCA uses Markdown ni MarkdownV2" — el bug descrito acá quedó resuelto de fondo por la migración de Vesta a `@cal/telegram` + Rich Messages (2026-08-05/06), que reescribió todo el manejo de formato/parse mode.
- [x] **`tools/resumir.ts` (resumen de videos/artículos + auto-resumidor de starred de Feedbin) se había quedado afuera de la migración a Rich Messages** — ✅ HECHO 2026-08-09: Cal reportó que el resumidor y el starred de Feedbin no usaban la API nueva. Todos los ~25 call sites (antes `sendMessage`/`editMessage` clásicos) migrados a `sendCronMessage`/`editCronMessage` (`proactive/rich-send.ts`), con un 3er nivel de fallback a texto plano agregado a pedido de Cal (a diferencia de los demás crons, acá perder el mensaje es perder el resumen mismo, no una notificación secundaria). `stripHtmlTags` relocado desde `index.ts` a `rich-send.ts` como helper compartido, con 7 tests nuevos (antes sin cobertura). Reviewed por `daemon-health-reviewer` en 2 pasadas, sin bloqueantes; un bug real encontrado y corregido durante la implementación (`.then(() => true)` sobre una promesa que ya resolvía boolean directo, dejando `ok` siempre en `true`). 836/836 tests, typecheck y build limpios. Commit `269d2a9`, daemon reiniciado.
- [x] **Resumen con muchos espacios en blanco entre título y contenido** — ✅ HECHO 2026-08-09 (2 rondas, mismo día): Cal reportó espacio excesivo al generar un resumen. Root cause: el prompt de resumen estructura la respuesta con varios headings `##` (TL;DR, secciones temáticas, Citas, Takeaways, Fuente); `convertMarkdownHeadings` (`format.ts`) envolvía cada heading con `\n` manual antes y después — como el tag ya es un elemento de bloque en Rich Messages (margen propio), ese salto se sumaba al margen del bloque en vez de reemplazarlo, duplicando el espacio en cada uno de los headings del resumen. **Ronda 1** (quitar el `\n` manual) no alcanzó — Cal confirmó que seguía viéndose igual: el margen NATIVO del bloque ya era el gap completo, así que hasta una sola línea en blanco de más (normal en Markdown) lo duplicaba. **Ronda 2:** normalizar a EXACTAMENTE 1 `\n` pegado al heading (ni 0 —arriesga que el texto corra pegado si el cliente no fuerza salto de bloque—, ni 2+). Verificado con una simulación local del pipeline real (no solo tests) antes de aplicar, comparando contra el resumen real que mandó Cal. 14/14 tests de `format.test.ts`, 850/850 tests del daemon, typecheck y build limpios. Daemon reiniciado, confirmado por Cal.
- [x] **Headings de bloque (`<h3>`/`<h4>`) abandonados — estándar final: título en negrilla `<b>`** — ✅ HECHO 2026-08-09 (misma sesión, 2 pasos): Cal probó primero `<h4>` ("no me gusta el h3, usemos h4"), pero terminó pidiendo sacar los headings de bloque del todo ("mejor titulo normal en negrilla"). `convertMarkdownHeadings`/`format.ts` (Jano) ahora convierte `#`-`######` a `<b>Título</b>` sin agregar `\n` propio — como `<b>` es INLINE (a diferencia de `<h3>`/`<h4>`, que son bloque con margen propio impredecible), no hace falta la lógica de normalización de saltos que se había armado para eso; se sacó por completo, simplificando el código. System prompt actualizado en los 3 bots (Jano, Vesta, Pecunia) — Vesta/Pecunia no tienen safety-net de conversión Markdown→HTML como Jano, solo instruyen al modelo directo. 850/850 tests, typecheck y build limpios en los 3. Daemons reiniciados.

#### Callback Optimization — Implementado (2026-04-11)
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

#### Botones inline — Menú y flujos (código listo, pendiente test)
- [x] Menú principal configurable (`menu.json`) — creado
- [x] Skill `/menu` — creada
- [x] Flujos de revisión de tareas documentados
- [x] Test end-to-end del menú (2026-04-12) — probado: menú → Spotify → controles
- [x] Soporte para botones URL (deep links)
- [x] Toast de confirmación en callbacks no mecánicos
- [x] Aprobaciones rápidas (sí/no) — callbacks `approve:yes[:context]` y `approve:no[:context]` procesados mecánicamente (2026-04-19)
- Spec: `docs/superpowers/specs/2026-04-11-inline-buttons-menu-design.md`
- Plan: `docs/superpowers/plans/2026-04-11-inline-buttons-menu.md`

#### UX Telegram — Mejoras de fluidez
- [x] **Editar mensaje en navegación de menú** — edit_message en callbacks menu:*, skill actualizado, server.ts no destruye mensaje en menu callbacks (2026-04-12)
- [x] **Limitar keyboards a 4 filas max** — MAX_KEYBOARD_ROWS=4 en reply y edit_message (2026-04-12)
- [x] **Mini App para flujos complejos** — implementado: Spotify Mini App TWA (2026-04-12)
- [x] **Loading transitions mecánicas** — callbacks `menu:*` hacen edit instantáneo ("⏳ Cargando...") en el plugin antes de pasar al LLM (~150ms). Approach A: edit texto + quitar botones (2026-04-12)
- [x] **MenuButtonWebApp** — script `scripts/setup-menu-button.sh` configura setChatMenuButton apuntando a Mini App (2026-04-19). Actual: Spotify Mini App con label "🎵 Abrir". Cambiar en el futuro si se crea una Mini App main menu
- [x] **Polling robusto** — telegram-plugin retry en cualquier error (no solo 409). Reset attempt counter en onStart. Antes ETIMEDOUT/ECONNRESET mataban el polling silenciosamente (2026-04-19)
- [x] **Health check end-to-end** — `scripts/health-check.sh` detecta long-poll colgado (200+empty vs 409 Conflict) y fuerza relanzamiento del LaunchAgent (2026-04-19)

#### Documentación Telegram
- [x] **telegram-reference.md** — referencia cross-project consolidada en `~/Claude Projects/telegram-reference.md`. Cubre: bot, plugin fork, callbacks, UX patterns, integraciones (CoS, Presupuesto, MCP), workers, hooks, gotchas (2026-04-12)

### boa-checkin (MCP compartido con Vesta)

- [x] **`getBoaBoardingPass`/`generateBoaWalletPass` devolvían `boardingPassUrl` vacío** — ✅ HECHO 2026-08-09: Cal reportó que no podía obtener el boarding pass de un vuelo por Jano; el check-in en sí se había completado bien (asiento confirmado), pero la extracción del link del PDF fallaba consistentemente. Diagnosticado (NO era un cambio de sitio de BoA) reproduciendo en vivo contra la reserva real de Cal: al clickear "Download / Print" se abre una pestaña que arranca en `about:blank` y navega asincrónicamente al PDF real — el código leía la URL antes de que esa navegación terminara. Fix en `mcp-servers/servers/boa-checkin/src/flow.ts` (`waitForRealUrl`, poll con chequeo de estabilidad + error explícito en vez de vacío silencioso si se agota el timeout). Verificado end-to-end contra la misma reserva real, antes y después. Reviewed por `daemon-health-reviewer`, 1 blocking corregido. No requirió reinicio de daemon (server `stdio`, se lanza fresco por invocación). Detalle completo: skill `boa-checkin-bolivia`. Commit `276daa0` (mcp-servers).

### OpenClaw / Automatización proactiva

**✅ Migración CoS v2 (2026-04-29):**
- **Hecho:** daemon `com.cal.cos-agent-v2`, worker CF, callback router edge, 9 tools custom, hooks adaptados, cutover completo. Spec/plan en `docs/superpowers/{specs,plans}/2026-04-28-cos-agent-v2-*`.

**✅ Hooks conflict guard (resueltos 2026-04-29 con cutover v2):**
- Hooks `cos-channel-bootout.sh` + `cos-channel-bootstrap.sh` ahora coordinan webhook (deleteWebhook gracioso al abrir sesión, setWebhook restore al cerrar última).

#### Hooks pendientes de revisar (2026-05-02)
- [x] ✅ **pre-compact-snapshot.sh** — registrado como PreCompact hook en `settings.json` (activo)
- [x] ✅ **notion-audit.sh** — registrado como PostToolUse(Notion) hook en `settings.json` (activo)
- [x] ✅ **stop-telegram-notify.sh** — registrado como Stop hook en `settings.json` (activo, contrario a lo que decía este BACKLOG antes)
- [x] ✅ **Limpiar `~/.claude/channels/telegram/.env`** (2026-05-04) — token de Jano removido (rotado vía BotFather, invalidó copias leakeadas en transcripts). Quedan solo `NOTION_TOKEN` y `HEALTH_API_KEY` en el .env. Como parte de la migración Jano+Vesta al modelo Pecunia (sin plugin interactivo), state dirs `telegram-cos/` y `telegram-family/` fueron eliminados completos.

#### CoS Proactivo — Plan inspirado en OpenClaw (2026-04-12)
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
- [x] ~~2.3 Eisenhower semanal (Dom 21:00)~~ — implementado 2026-04-19, ✅ DADO DE BAJA 2026-08-08 (pedido de Cal): plists `com.claude.eisenhower-weekly.plist` (`disabled-2026-06-13/` + backup) eliminados definitivamente. `~/.claude/hooks/eisenhower-weekly.sh` queda sin usar, no borrado.

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

#### Crons secundarios — Estado post-auditoría 2026-05-24

> ⚠️ **TODOS DESACTIVADOS 2026-06-13 (dormidos).** Los 5 "activos" de abajo fueron `bootout` + archivados en `~/Library/LaunchAgents/disabled-2026-06-13/` (sus plists quedaron corruptos por un script de update de schedule). Jano corre 100% reactivo. Reactivar requiere reconstruir el plist — ver `docs/references/hooks-automatizacion.md`.

**Activos (4) → [BLOQUEADO — automatización dormida 2026-06-13]:**
- `com.claude.heartbeat` — cada 30min, 7am-22:30
- `com.claude.nightly-report` — 22:00 diario
- `com.claude.outlook-cache` — cada 4h
- `com.cal.jano-morning-build` — 22:30 diario (renombrado desde `com.claude.morning-build`)

**Dado de baja definitivamente (2026-08-08):**
- `com.claude.eisenhower-weekly` — Dom 21:00, pedido de Cal

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

### Graphify
- [ ] **Correr Graphify** — CLI + skill ya instalados en la máquina (`uv tool install graphifyy` + `graphify install`, `~/.claude/skills/graphify/`). Se probó `/graphify` sobre el repo `Claude Projects`: el corpus completo (3,340 archivos / 7.4M palabras) y luego `Personal/` completo (2,316 / ~6M) resultaron demasiado grandes para correr de un saque — Cal acotó a `Personal/Agents` + `Personal/Apps` pero decidió limpiar los repos de archivos innecesarios antes de retomar. Pendiente: volver a invocar `/graphify` sobre ese scope (o el que Cal defina) una vez terminada la limpieza. (2026-07-30)

### Referencias externas (ideas para explorar)

**Filesystem-based knowledge system (alt RAG) — @soyabraham.ia:**
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

**AI Copilot framework (Tal Raviv):**
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

### Otros pendientes / Futuro
- [x] **Google Maps API — distancias y tiempos** (2026-05-02) → implementado: `searchPlace` (Places API New) + `travelTime` (Routes API v2 TRAFFIC_AWARE) en `tools/maps.ts`. `requestUserLocation` extendido para cualquier consulta de distancia/ruta/ETA.
- [ ] **Aprendizaje de largo plazo (Paweł model)** (2026-05-01) → sistema de knowledge tiers en `~/.claude/learnings/jano/` (facts→hypotheses→rules). Al cerrar sesión, el summary compactado pasa por extracción de patrones. Dependencia: conversation memory operativa primero. Ver diseño en `~/.claude/docs/superpowers/specs/2026-05-01-conversation-memory-design.md`

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
