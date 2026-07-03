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
- **Custom (`cos-tools`):** getOutlookEvents · runBriefing · searchPlace · travelTime · requestUserLocation · getTokenUsage · getWhatsappContacts/saveWhatsappContact · pptWizardSave/Load · getFocoCalStatus/logFocoProgress · fetchAsUser · fetchAndSummarize · **Resumidor** (suite, ver abajo) · readPersistedOutput · readwiseGetDailyReview · **executeClings** (leer Things) · **thingsWrite** (escribir Things, URL scheme) · **executeRemctl** (Reminders, familia/mercado) · notionCli/notionPageMarkdown/notionUpdateBody · enviarArchivoNotion · **generarQrAduanaBolivia** (QR salida/ingreso Bolivia Form 250 vía POST HTTP → manda imagen al chat; identidad de `~/.claude/datos-viaje.json`; flujo en `tools/qr-aduana.ts`).

### Resumidor (`tools/resumir.ts`) — checkpoint con tarjeta + colas
Resumidor universal con checkpoint antes de guardar a Readwise. Reusa los scripts del skill `resumir` vía spawn (sin Bash); cookies Safari con `~/.claude/bin/node-fda` (requiere FDA bajo launchd).
- **Tools (`cos-tools`):** `resumirContenido` (link artículo/paywall/podcast/YouTube o título de libro → resumen en el idioma del contenido) · `guardarResumenReadwise` · `editarPropuestaResumen` (addTags/setTags/removeHighlights/retag, sin guardar) · `saltarResumen` · `detenerResumidor` (vacía colas) · `revisarPlaylistResumir` · `revisarStarredResumir` · `estadoResumidor`.
- **UX (sigue skill `telegram-bot-ux`):** la propuesta es una **tarjeta inline** `[✅ Guardar] [🏷️ Agregar tag] [✏️ Editar] [⏭️ Saltar] [⏹️ Parar la cola]`. Para **artículos** suma `[📄 Guardar artículo]` (`guardarResumenReadwise({fullArticle:true})`: Reader baja el original de la URL con los tags, en vez del resumen — `readwise-save.sh` con html `-`). Guardar/Saltar/Parar/Guardar-artículo y los botones ⭐/🎬 del menú son **callbacks mecánicos** (interceptados en `index.ts`, sin LLM); tag/editar van por LLM. Flujo de estado = **un solo mensaje ancla editado por fases** (hilvana `messageId`). Tras estas tools el LLM devuelve **vacío** (la tarjeta es el único canal).
- **Contenido de starred:** usa el `content` de Feedbin; si viene truncado (<1500 chars) cae a `safari-fetch` (full + paywall). Mercury extract NO está implementado (necesita Extract secret + HMAC). `getEntriesByFeed` del MCP feedbin ahora soporta `order`/`offset` + devuelve `total_unread` (para triage de backlog grande).
- **Auto-resumidores (cron diario 08:00 + on-demand):** playlist YouTube "Para resumir" (`revisarPlaylistResumir`) y **starred de Feedbin** (`revisarStarredResumir`, contenido de Feedbin, sin Safari). Al guardar/saltar: el video sale de la playlist (YouTube Data API OAuth, ver [[reference_youtube_oauth_playlist]]) / el artículo se des-estrella. Colas + seen en `~/.cos-agent/resumir-*.json`. Locks `placeholder` huérfanos se limpian al arrancar (`cleanStalePlaceholders`).
- **Selector de cola antes de procesar (2026-07-03):** en vez de arrancar directo con el primer ítem (FIFO), `checkPlaylistsResumir`/`checkStarredResumir` muestran primero conteo + lista numerada + botones (`buildQueueSelector`) para que Cal elija QUÉ resumir — aplica al cron 08:00 y a los botones ⭐/🎬 del menú. Botones: uno por ítem (`resu-pick:{v|s}:{id}`), `[✅ Procesar todos]` (`resu-pick:{v|s}:all` → modo `batch`, FIFO automático de siempre hasta vaciar la cola) y `[❌ Ahora no]` (`resu-pick:{v|s}:none`). El flag `mode?: "batch"` vive junto a la cola en disco y se resetea al vaciarse (la próxima tanda vuelve a preguntar); `maybeAdvance` (tras guardar/saltar) respeta el mismo criterio. Callback `resu-pick:` **mecánico** (interceptado en `index.ts`, sin LLM, igual que `j:resu:save/skip/stop`), con el MISMO lock anti-doble-tap `(chatId, userId)` que `mlog:/mskip:/msel:` (reusado, no uno nuevo). Dispatcher único `handleQueuePick()`; lógica de "arrancar un ítem" compartida en `startPlaylistItem`/`startStarredItem` entre el camino FIFO y el camino "por id" (`resu-pick:{v|s}:{id}`). **Gotcha (hallado por `daemon-health-reviewer`, corregido antes de mergear):** `handleQueuePick()` puede tardar minutos (transcribe+resume vía `run()`, hasta `TRANSCRIBE_TIMEOUT_MS`=10min) — el bloque en `index.ts` lo dispara `void ....catch().finally(releaseLock)` en vez de `await`, igual que `j:star`/`j:ytpl` unas líneas más abajo; awaitearlo ahí congelaría el loop secuencial del daemon entero (todos los chats) hasta terminar. **Fix real 2026-07-03:** el TTL del lock (`MEETING_FLOW_LOCK_TTL_SEC`) estaba en 20s — Cloudflare KV exige mínimo 60s, y un valor menor tira 400 sin capturar, rompiendo el callback ENTERO en silencio (así se manifestó: "toqué el selector y no pasó nada"). Subido a 60s. **Falla de un ítem elegido puntualmente (2026-07-03, pedido por Cal):** `startPlaylistItem`/`startStarredItem` reciben `autoAdvanceOnFail` — en modo batch sigue auto-avanzando al fallar (como siempre); en una selección puntual, si falla, NO avanza solo a otro — devuelve el ítem al principio de la cola, avisa a Cal, y lo invita a pedir el selector de nuevo. **Diagnóstico de fallas + timeout de resumen (2026-07-03):** `startPlaylistItem`/`startStarredItem` tragaban el error de `run()` en silencio — ahora loguean `err.message` con `console.error`. Caso real: un video en vivo larguísimo (programa de fútbol completo) que transcribe bien (probado manualmente con `audio-transcribe.sh`) pero cuya transcripción enorme probablemente excedía `SUMMARIZE_TIMEOUT_SEC` al resumirse — subido de 180s a 360s (línea ~24 de `resumir.ts`). Seguro subirlo porque `summarize()` corre fire-and-forget (vía `handleQueuePick`), no bloquea el loop principal del daemon.
- **Título + autor/canal antes del TL;DR (2026-07-03):** el resumen entregado antepone `<b>{título}</b>` + `{emoji} {autor}` (🎬 canal YouTube para video/podcast, 📰 fuente para artículo/libro) vía `buildResumenHeader()` (pura, testeada). Canal de YouTube viene de `audio-transcribe.sh` (nuevo campo `channel` en el JSON, pide `%(uploader)s` a yt-dlp en ambas ramas — captions y descarga+whisper); autor de Feedbin viene de `fetchStarredContent`. Artículos vía `safari-fetch` no tienen autor estructurado hoy (solo título).
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
- **Emojis de dominio Mundial (lexicon extendido):** además del lexicon estándar (`telegram-bot-ux/references/lexicon.md`), Jano puede usar para fútbol/Mundial 2026: `⚽` (header deportivo), `🥇 🥈 🥉` (podio/ranking de goleadores/posiciones/power ranking), y banderas de país (`🇦🇷 🇧🇷 …`) junto al nombre de la selección. **Regla:** las banderas NO van dentro de bloques `<pre>` (rompen la alineación monoespaciada → usar código de 3 letras tipo ARG/FRA ahí). Para rankings de datos preferir **lista** (bullets `•` + `<b>`) sobre tabla `<pre>`, salvo que la densidad de columnas lo justifique.
- **PDF/DOCX:** `processDocument()` en `index.ts` (pdf-parse v2 / mammoth), trunca a 50K. API pdf-parse v2: `const { PDFParse } = require("pdf-parse")` (named export, NO la clase directa) → `new PDFParse({data}).getText()` → `.text`. Mismo patrón obligatorio en `tools/schedule-cal.ts` (`extractPdfUrl`, PDFs de Notion) — archivo compartido con Vesta; al tocarlo copiar a ambos y rebuildar. Bug histórico (fix 2026-06-21): require sin destructurar + `parsed.text` sin `.getText()` → TypeError enmascarado como `"[PDF — error al procesar]"`.
- **SNI filtering bloquea Telegram** en algunas redes (WiFi guest/hoteles): "Connection reset" en TLS. Daemon arranca pero el bot queda mudo. Diagnóstico: `curl -s https://api.telegram.org/bot$TOKEN/getMe` vacío mientras google.com funciona. Fix: cambiar red.
- **Debug estado launchd:** `launchctl print gui/$(id -u)/com.cal.cos-agent-v2` (más útil que `launchctl list | grep`).
- **`reminders` con pantalla bloqueada cuelga** (espera TCC). En procesos sin sesión: `timeout 30s reminders ...`.
- **Things 3 (`tools/things.ts`) — split read/write por TCC bajo launchd:** las ESCRITURAS de `clings` usan osascript/JXA (Apple Events) → cuelgan esperando permiso TCC de Automatización que no se puede responder en background (confirmado 2026-06-13: hasta `clings add`/`delete` interactivos cuelgan). **Lecturas** (`executeClings`, SQLite/FDA) sí funcionan. **Escrituras** van por URL scheme `things:///add|update` vía `open` (`thingsWrite`), que NO usa Apple Events → headless-safe. `things:///add` sin token; `things:///update` requiere `THINGS3_AUTH_TOKEN` (el wrapper lo agrega). `clings` está **`brew pin`-eado** (con reminders-cli) — un upgrade rompería el path versionado del Cellar y su binding FDA.
- **`fetchAsUser` requiere FDA** en `~/.npm-global/bin/node` (lee Cookies.binarycookies de Safari).
- **SDK persisted-output loop:** tool result >~25KB → SDK persiste a `toulu_*.json`; el LLM reintenta el tool. Solución: usar `fetchAndSummarize` (el texto no entra al contexto).
- **compact.ts → Markdown en historial:** si reaparece Markdown en respuestas largas, revisar el prompt de `daemon-v2/src/compact.ts` ("sin Markdown, texto plano").
- **Envío proactivo (no reactivo):** el daemon entrega la respuesta del agente vía `sendMessage` SOLO en el flujo reactivo (`processMessage`). En handlers PROACTIVOS (ej. `proactive/fuel-alert.ts`) el handler debe llamar `sendMessage` con el `reply` de `runAgent` él mismo — el agente NO tiene tool de envío; si el prompt dice "envía", intentará tools de notificación inexistentes y nada llega a Cal. Alternativa: tool que envía sola (patrón `buildApprovalFlow`/foco-check).
- **Fetch worker→worker por `*.workers.dev` se pierde en el edge CF** (mismo account). Usar **Service Binding** (ej. `combustible-proxy → cos-agent-worker` binding `JANO`, y viceversa). Síntoma: el POST "sale ok" pero nunca llega; el destino no registra el request.
- **Callbacks legacy (`mlog:`/`mskip:`/`msel:`) NO reusaban el mensaje tocado (fix 2026-07-03):** `processMessage()` ya soportaba `opts.existingPlaceholderId` para editar in-place, pero el bloque "Heavy callbacks legacy" en `index.ts` (cualquier `callback_data` sin prefijo `j:`/`build:`) nunca se lo pasaba → creaba SIEMPRE un mensaje nuevo, dejando la tarjeta de reunión original (con sus botones `mlog:`/`mskip:`/`msel:`) viva y tocable → mensajes apilados + riesgo de doble-procesar la misma reunión. Fix: si `cb.data` matchea `/^(mlog:|mskip:|msel:)/`, pasar `{ existingPlaceholderId: cb.message.message_id, clearKeyboard: true }`. **Gotcha de Telegram descubierto acá:** `editMessageText` NO limpia el `reply_markup` si el parámetro se omite (lo deja intacto) — `shared-v2/src/telegram.ts:editMessage()` solo mete `reply_markup` en el body si el argumento está definido, y `JSON.stringify` descarta keys `undefined`. Por eso se agregó `opts.clearKeyboard` → `{ inline_keyboard: [] }` explícito en cada edit (💭 Pensando..., progreso, final, error) cuando el placeholder viene de una tarjeta con botones ya "consumida".
- **`system-prompt.ts` ahora instruye explícitamente "NO generes texto" para `msel:{meetingId}`** (antes solo lo decía para `msel:all`) — sin esto, si el LLM agregaba una frase de acompañamiento junto a `buildApprovalFlow`, esa frase se editaba in-place sobre el mensaje de selección múltiple (botones 1-5+Todas) y podía pisar la lista antes de que Cal terminara de elegir otras reuniones de la misma tanda. Hallado por `daemon-health-reviewer` al revisar el fix de arriba.
- **Doble-tap sobre `mlog:`/`mskip:`/`msel:` — mitigado con lock (2026-07-03):** el placeholder reusado por el fix anterior tenía riesgo de 2 `processMessage` concurrentes editando el mismo `message_id` si Cal tocaba el mismo botón dos veces rápido. Fix: lock corto por `(chatId, userId)` en CF KV — `tryAcquireLock`/`releaseLock` en `daemon-v2/src/cf-kv.ts` (key `jano:lock:{chatId}:{userId}`, TTL 60s — **corregido de 20s el mismo día**: Cloudflare KV exige mínimo 60s para `expiration_ttl`, un valor menor tira 400 sin capturar y rompe el callback ENTERO en silencio, ver gotcha de arriba —, get-then-set no atómico, mismo patrón que `ExpenseStateStore.tryAcquireLock` en Pecunia). En `index.ts`, el bloque `isMeetingFlowCallback` intenta adquirir el lock ANTES de llamar `processMessage`; si ya está tomado, responde `answerCallbackQuery(cb.id, "⏳ Todavía estoy procesando tu toque anterior...")` y corta sin tocar el mensaje; si lo adquiere, hace el ack normal y libera el lock en un `finally` que envuelve el `await processMessage(...)` completo (incluye el turno del agente SDK). `releaseLock` va con `.catch(() => {})` — un blip de red en el DELETE a KV no debe tirar `processMessage` a error (el lock igual expira solo por TTL). **Dato del `daemon-health-reviewer`:** el poll loop principal (`index.ts`) es estrictamente secuencial (`for` con `await`, sin `Promise.all` ni `void`), así que dos taps que caen en el MISMO proceso del daemon ya estaban serializados por diseño — el lock protege sobre todo concurrencia **entre procesos** (ventana de restart de launchd, `npm run dev` corriendo en paralelo a producción, o redelivery de CF Queue si un run largo excede el lease). Sigue siendo la herramienta correcta para ese caso. Scope deliberadamente acotado a `mlog:`/`mskip:`/`msel:`; el reviewer señaló (sin arreglar, no era el alcance pedido) el mismo patrón de riesgo latente en `j:star`/`j:ytpl` (fire-and-forget de `checkStarredResumir`/`checkPlaylistsResumir` sin lock) y en `build:approve:`/`build:reject:` (`spawn` del script de build sin lock) — reconsiderar si se reporta doble-ejecución en esos flujos.
- **Keyboard sin limpiar en `jano-wiz-*` — resuelto (2026-07-03):** el helper local `editMsg` en `tools/approval-flow.ts` omitía `reply_markup` cuando no había un teclado nuevo que pasar, y por el mismo gotcha de Telegram (`editMessageText` no limpia `reply_markup` si se omite) los botones de la tarjeta anterior (`bulk-ok`/`bulk-no`/`back`/`start`/`ok`/`no` en sus ramas terminales — todas las que hacen `kv.delete(wizKey(...))` con `done: true`) quedaban vivos y tocables tras pasar a un estado sin botones ("todos revisados"). Fix: `editMsg` ahora manda SIEMPRE `reply_markup`, con `{ inline_keyboard: [] }` por default si no se pasa uno nuevo — generalizado en el helper en vez de parchar cada call site (todos los que quieren conservar teclado ya lo pasaban explícito). Fix 100% aislado en `approval-flow.ts`, no toca el routing de `index.ts` ni `existingPlaceholderId` (confirmado por `daemon-health-reviewer` vía `git diff --stat` + grep de `buildApprovalFlow`/`stepApprovalWizard` en `index.ts`, sin llamadas reales ahí).

## Notion
- Integración "Claude CoS" (DB Tareas + People). Prefijo MCP: `mcp__claude_ai_Notion__*`.
- Referencia cross-project: `~/Claude Projects/notion-reference.md` (bajo demanda).

## Gap conocido — bulk review parcial en approval-flow (2026-07-02, familia 3)

`buildApprovalFlow`/`stepApprovalWizard` (`tools/approval-flow.ts`) solo ofrece "revisar uno a uno"
o "confirmar/descartar todo" — no se puede aprobar un subconjunto (ej. "estos 3 sí, esos 2 después")
sin pasar por el wizard completo. Investigado como parte del proyecto de rediseño de mensajes
Telegram (familia 3, bulk review); impacto evaluado como bajo (único uso activo hoy es
meetings→Foco Log, bajo volumen) — **decisión de Cal: documentar nada más, no implementar** por
ahora. Si el volumen de uso crece o se reactiva algún cron que dispare este wizard con más
frecuencia, reconsiderar.

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

**Al reactivar (familia 6 del rediseño de mensajes Telegram, 2026-07-02):** `scheduleFlightCheckin`,
`scheduleFocoCheckinsLocal` y el monitor de combustible (abajo) mandan cada uno su propio
`sendMessage` independiente. Si dos coinciden en la misma ventana (ej. foco check-in y una alerta
de vuelo), hoy saldrían como 2 mensajes separados. Vesta ya resolvió el mismo problema entre sus
4 crons con un módulo `digest-queue.ts` (cola en memoria, debounce ~15s, sin KV — ver
`Vesta/daemon-v2/src/digest-queue.ts` + `Vesta/CLAUDE.md` sección "Digest-queue entre crons" y
el spec `Vesta/docs/superpowers/specs/2026-07-02-digest-queue-crons-design.md`). Al reactivar
cualquiera de estas proactivas en Jano, copiar ese mismo patrón desde el día uno (adaptado a
`resumidor.ts`'s cola existente si aplica) en vez de volver a `sendMessage` suelto por mecanismo.

**Estado real (2026-06-19):** sin crons internos de proactividad (solo webhook watchdog, infra) Y **sin proactividad por evento externo** — el monitor de combustible se apagó 2026-06-19 (ver abajo). Hoy NO hay ninguna proactividad automática hacia Cal. Verificar qué crons internos arrancan: `grep -E "_scheduled" ~/Library/Logs/cos-agent-v2.out.log`.

## Monitor de combustible (alertas proactivas) — ⛔ APAGADO 2026-06-19
> El cron de `combustible-proxy` quemaba ~576 writes/día de KV (≈57% del free tier) → Cloudflare disparó alerta "50% daily KV limit". Apagado con `crons = []` + `enabled:false` en KV (`monitor_config`). Ya NO llegan `fuel_alert` a la cola. Reactivar: ver `~/Claude Projects/Personal/Apps/Combustible/repo/CLAUDE.md` (restaurar cron a `*/5`, no cada minuto; hacer el `put monitor_state` condicional). El flujo descrito abajo queda como referencia de cómo funcionaba.

Cron en `combustible-proxy` (CF, externo) detecta "llegó gasolina" → `POST /fuel/alert` (Service Binding) al worker de Jano → `QueueMessage{kind:"fuel_alert"}` → daemon `proactive/fuel-alert.ts` re-verifica litros y avisa a Cal. Config editable **por texto** vía tools del MCP `combustible` (`getFuelMonitorConfig/Status/setFuelMonitorConfig`); el menú es texto (los botones tappables se revirtieron 2026-06-18, no funcionaron en el Telegram de Cal). Endpoint `/fuel/alert` en `worker-v2/src/index.ts`; tipo `FuelEvent` en `shared-v2/src/types.ts`. Detalle: `~/Claude Projects/Personal/Apps/Combustible/repo/CLAUDE.md`.
