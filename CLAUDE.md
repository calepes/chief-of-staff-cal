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
# Tests / typecheck
npm run test -w @cos/daemon
npm run typecheck -w @cos/daemon
# Restart daemon
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
# Logs / estado del proceso
tail -f ~/Library/Logs/cos-agent-v2.{out,err}.log
launchctl print gui/$(id -u)/com.cal.cos-agent-v2 | grep -E "state|pid"
# Generar/mandar la tarjeta de KPIs de Yape on-demand (fuera del cron 10:00)
cd daemon-v2 && npm run kpi-card:send-now
# Deploy worker CF (tras cambiar worker-v2/)
cd worker-v2 && npx wrangler deploy
```
El watchdog re-setea el webhook solo cada 1 min. Re-set manual de webhook + debug de contexto en CF KV: ver `docs/ARCHITECTURE.md`.

**Iterar visualmente una card/imagen sin pasar por Telegram:** script one-off en el scratchpad que
importa las funciones de fetch+render directo desde `daemon-v2/dist/` (ya compilado) y manda el PNG
con `SendUserFile` — mucho más rápido que disparar el flujo real de Telegram en cada ajuste de
diseño. Ojo con las comillas en valores de `apps.env` (`GMAIL_OAUTH_REFRESH_TOKEN_LEPESQUEUR` viene
con `"..."` literales) — parsear el `.env` a mano sin `dotenv` exige stripearlas o el valor queda
corrupto.

## Índice de tools + MCPs
Implementación y detalle en código (ver "dónde vive qué"). Inventario:
- **Custom (`cos-tools`):** getOutlookEvents · searchPlace · travelTime · requestUserLocation · getTokenUsage · getWhatsappContacts/saveWhatsappContact · pptWizardSave/Load · getFocoCalStatus/logFocoProgress · fetchAsUser · fetchAndSummarize · **Resumidor** (suite, ver abajo) · readPersistedOutput · readwiseGetDailyReview · **executeClings** (leer Things) · **thingsWrite** (escribir Things, URL scheme) · **executeRemctl** (Reminders, familia/mercado) · notionCli/notionPageMarkdown/notionUpdateBody · enviarArchivoNotion · **generarQrAduanaBolivia** (QR salida/ingreso Bolivia Form 250 vía POST HTTP → manda imagen al chat; identidad de `~/.claude/datos-viaje.json`; flujo en `tools/qr-aduana.ts`) · **generarKpiCardYape** (tarjeta PNG diaria de KPIs Yape on-demand) · **reprocesarKpisDerivadosYape** (fuerza recálculo de derivados de "KPIs diarios", todo el histórico o fechas puntuales — ver sección "scheduleKpiIngestCheck" más abajo) · **consultarJournal** (LEER el Journal de reflexión; guardar NO pasa por el LLM — ver sección "Journal de reflexión" abajo) · **mapaBacklogs/leerBacklog/proponerItemBacklog** (leer y escribir los `BACKLOG.md` de los proyectos de Cal — ver sección "Backlogs de proyectos" abajo) · **guardarReferenciaDiseno** (capturar y guardar referencias visuales de diseño en `Personal/Referencias de Diseño/` — ver sección "Referencias de Diseño" abajo).

### Resumidor (`tools/resumir.ts`) — checkpoint con tarjeta + colas
Resumidor universal con checkpoint antes de guardar a Readwise. Reusa los scripts del skill `resumir` vía spawn (sin Bash); cookies Safari con `~/.claude/bin/node-fda` (requiere FDA bajo launchd).
- **Tools (`cos-tools`):** `resumirContenido` (link artículo/paywall/podcast/YouTube o título de libro → resumen en el idioma del contenido) · `guardarResumenReadwise` · `editarPropuestaResumen` (addTags/setTags/removeHighlights/retag, sin guardar) · `saltarResumen` · `detenerResumidor` (vacía colas) · `revisarPlaylistResumir` · `revisarStarredResumir` · `estadoResumidor`.
- **UX (sigue skill `telegram-bot-ux`):** la propuesta es una **tarjeta inline** `[✅ Guardar] [🏷️ Agregar tag] [✏️ Editar] [⏭️ Saltar] [⏹️ Parar la cola]`. Para **artículos** suma `[📄 Guardar artículo]` (`guardarResumenReadwise({fullArticle:true})`: Reader baja el original de la URL con los tags, en vez del resumen — `readwise-save.sh` con html `-`). Guardar/Saltar/Parar/Guardar-artículo y los botones ⭐/🎬 del menú son **callbacks mecánicos** (interceptados en `index.ts`, sin LLM); tag/editar van por LLM. Flujo de estado = **un solo mensaje ancla editado por fases** (hilvana `messageId`). Tras estas tools el LLM devuelve **vacío** (la tarjeta es el único canal).
- **Contenido de starred:** usa el `content` de Feedbin; si viene truncado (<1500 chars) cae a `safari-fetch` (full + paywall). Mercury extract NO está implementado (necesita Extract secret + HMAC). `getEntriesByFeed` del MCP feedbin ahora soporta `order`/`offset` + devuelve `total_unread` (para triage de backlog grande).
- **Auto-resumidores (cron diario 08:00 + on-demand):** playlist YouTube "Para resumir" (`revisarPlaylistResumir`) y **starred de Feedbin** (`revisarStarredResumir`, contenido de Feedbin, sin Safari). Al guardar/saltar: el video sale de la playlist (YouTube Data API OAuth, ver [[reference_youtube_oauth_playlist]]) / el artículo se des-estrella. Colas + seen en `~/.cos-agent/resumir-*.json`. Locks `placeholder` huérfanos se limpian al arrancar (`cleanStalePlaceholders`).
- **Selector de cola antes de procesar (2026-07-03):** en vez de arrancar directo con el primer ítem (FIFO), `checkPlaylistsResumir`/`checkStarredResumir` muestran primero conteo + lista numerada + botones (`buildQueueSelector`) para que Cal elija QUÉ resumir — aplica al cron 08:00 y a los botones ⭐/🎬 del menú. Botones: uno por ítem (`resu-pick:{v|s}:{id}`), `[✅ Procesar todos]` (`resu-pick:{v|s}:all` → modo `batch`, FIFO automático de siempre hasta vaciar la cola) y `[❌ Ahora no]` (`resu-pick:{v|s}:none`). El flag `mode?: "batch"` vive junto a la cola en disco y se resetea al vaciarse (la próxima tanda vuelve a preguntar); `maybeAdvance` (tras guardar/saltar) respeta el mismo criterio. Callback `resu-pick:` **mecánico** (interceptado en `index.ts`, sin LLM, igual que `j:resu:save/skip/stop`), con el MISMO lock anti-doble-tap `(chatId, userId)` que `mlog:/mskip:/msel:` (reusado, no uno nuevo). Dispatcher único `handleQueuePick()`; lógica de "arrancar un ítem" compartida en `startPlaylistItem`/`startStarredItem` entre el camino FIFO y el camino "por id" (`resu-pick:{v|s}:{id}`). **Gotcha (hallado por `daemon-health-reviewer`, corregido antes de mergear):** `handleQueuePick()` puede tardar minutos (transcribe+resume vía `run()`, hasta `TRANSCRIBE_TIMEOUT_MS`=10min) — el bloque en `index.ts` lo dispara `void ....catch().finally(releaseLock)` en vez de `await`, igual que `j:star`/`j:ytpl` unas líneas más abajo; awaitearlo ahí congelaría el loop secuencial del daemon entero (todos los chats) hasta terminar. **Fix real 2026-07-03:** el TTL del lock (`MEETING_FLOW_LOCK_TTL_SEC`) estaba en 20s — Cloudflare KV exige mínimo 60s, y un valor menor tira 400 sin capturar, rompiendo el callback ENTERO en silencio (así se manifestó: "toqué el selector y no pasó nada"). Subido a 60s. **Falla de un ítem elegido puntualmente (2026-07-03, pedido por Cal):** `startPlaylistItem`/`startStarredItem` reciben `autoAdvanceOnFail` — en modo batch sigue auto-avanzando al fallar (como siempre); en una selección puntual, si falla, NO avanza solo a otro — devuelve el ítem al principio de la cola, avisa a Cal, y lo invita a pedir el selector de nuevo. **Diagnóstico de fallas + timeout de resumen (2026-07-03):** `startPlaylistItem`/`startStarredItem` tragaban el error de `run()` en silencio — ahora loguean `err.message` con `console.error`. Caso real: un video en vivo larguísimo (programa de fútbol completo) que transcribe bien (probado manualmente con `audio-transcribe.sh`) pero cuya transcripción enorme probablemente excedía `SUMMARIZE_TIMEOUT_SEC` al resumirse — subido de 180s a 360s (línea ~24 de `resumir.ts`). Seguro subirlo porque `summarize()` corre fire-and-forget (vía `handleQueuePick`), no bloquea el loop principal del daemon.
- **Título + autor/canal antes del TL;DR (2026-07-03):** el resumen entregado antepone `<b>{título}</b>` + `{emoji} {autor}` (🎬 canal YouTube para video/podcast, 📰 fuente para artículo/libro) vía `buildResumenHeader()` (pura, testeada). Canal de YouTube viene de `audio-transcribe.sh` (nuevo campo `channel` en el JSON, pide `%(uploader)s` a yt-dlp en ambas ramas — captions y descarga+whisper); autor de Feedbin viene de `fetchStarredContent`. Artículos vía `safari-fetch` no tienen autor estructurado hoy (solo título).
- **Built-ins:** Skill · WebFetch · WebSearch.
- **MCPs heredados (OAuth Max):** Google Calendar. (Notion removido 2026-06-13 — se accede vía CLI, ver `notionCli`/`notionPageMarkdown`/`notionUpdateBody`. Gmail removido 2026-08-02 — decisión de Cal, bajo valor interactivo; los pipelines de KPIs/notas/tareas siguen intactos porque usan un OAuth2 directo propio en `kpi-ingest-gmail.ts`, no este MCP — ver sección KPI-ingest más abajo.)
- **MCPs custom:** youtube-transcribe · exchange-rate-bolivia · naabol-flights · health · agent-learnings · combustible · feedbin · serpapi-flights · apple-notes · inversiones-query · worldcup · spark · achoradazos · **boa-checkin** (check-in online BoA vía Chrome real + CDP — `prepareBoaCheckin`/`confirmBoaCheckin`/`manageBoaSeat`/`getBoaBoardingPass`/`setBoaFrequentFlyer`, agregado 2026-07-04; 5 bugs reales de automatización encontrados y arreglados el mismo día (incluido uno silencioso: boarding pass del pasajero equivocado en reservas multi-pax) — ver `Personal/MCP Servers/mcp-servers/servers/boa-checkin/` y skill `boa-checkin-bolivia`). **`generateBoaWalletPass`** (agregado 2026-07-16, certificado de Apple Developer de Cal activo desde 2026-07-17 — desbloqueado y funcionando con reservas reales) genera un `.pkpass` escaneable del boarding pass MÁS una imagen `.png` decorativa (`cardImagePath`) con el diseño navy/dorado aprobado por Cal (mismo BCBP real como barcode, renderizada con Playwright + bwip-js en `wallet-image.ts`). Se entregan con dos tools: `enviarDocumentoLocal` (el `.pkpass`) y `enviarFotoLocal` (la tarjeta — vía `sendDocument`, no `sendPhoto`, porque Telegram recomprime fotos a JPEG y pierde la transparencia de las esquinas redondeadas). Ambas en `agent-tools.ts`/`tools/telegram-files.ts` — suben un archivo LOCAL a Telegram vía multipart, restringidas por seguridad a `tmpdir()` + patrón `boa-wallet-*.{pkpass,png}` con `realpath()` (resuelve symlinks antes de validar), ya que `enviarDocumentoUrl` solo acepta URLs públicas. · **cine** (cartelera + compra de entradas Cinemark/Multicine/Cine Center — ver abajo).

### Cine (MCP `cine`, agregado 2026-07-25)
Cartelera + compra de entradas de los 3 cines de Santa Cruz (**Cinemark** Ventura Mall, **Multicine** Las Brisas, **Cine Center** MegaCenter/Trompillo), **para cualquier fecha**. Compra automatizada **solo en Cinemark**. Server compartido con Vesta en `Personal/MCP Servers/mcp-servers/servers/cine/` (migrado desde tools locales de Vesta).
- **7 tools:** `getCartelera({fecha?, pelicula?, cines?})` · `iniciarCompraCine` → `{purchaseId, mapaPath, minutosRestantes}` · `elegirAsientosCine({purchaseId, asientos})` → `{resumenPath, total, minutosRestantes}` · `confirmarCompraCine({purchaseId})` → `{qrPath, minutosRestantes}` · `verificarPagoCine({purchaseId})` → `{pagado, codigoRetiro?, entradasPath?}` · `cancelarCompraCine({purchaseId})` · `estadoCompraCine({})` (recupera la compra activa si el LLM perdió el `purchaseId`).
- 📖 **Gotchas técnicos del server (BFF, navegación por fecha, matcher día+mes, browser lazy, reaper, `purchaseId`): fuente única en `mcp-servers/CLAUDE.md` → tabla de servidores, fila `cine`.** El server lo comparten Jano y Vesta — NO dupliques esos gotchas acá ni en el CLAUDE.md de Vesta; se desincronizan.
- **Específico de Jano — confirmación de pago POR TEXTO.** No hay polling y **Jano no tiene parser de teclados emitidos por el LLM** (sus botones se construyen en código): Cal escribe "ya pagué" y recién ahí se llama `verificarPagoCine`. Vesta sí muestra el botón `✅ Ya pagué`. Si alguna vez se quiere el botón acá, hay que agregarle a Jano un parser genérico o un tool tipo `enviarBotonPago` — es un cambio aparte.
- **Específico de Jano — allowlist:** `enviarFotoLocal` (`tools/telegram-files.ts`) acepta `cine-*.png` además de `boa-wallet-*` y `kpi-card-*`; el MCP devuelve PATHS en `tmpdir()` y el daemon los sube.
- **Compra real end-to-end VALIDADA** (2026-07-26, Cal la corrió hasta el QR de pago y el código de retiro). Multicine y Cine Center siguen sin compra automatizada (Multicine se frena en un reCAPTCHA v2 del checkout; Cine Center tiene el modo invitado bugueado).
- **Al mandar el mapa de asientos, mandá TAMBIÉN la lista `butacasLibres`** que devuelve `iniciarCompraCine` (agrupada por fila, ej. `Fila B: B1-B4, B6-B9`). El screenshot NO trae los números de butaca impresos, así que sin esa lista Cal adivina el código y pide asientos que no existen. En salas premier las butacas vienen de a pares pero **cada mitad es independiente**: para 2 personas juntas hay que pedir las dos (`['A1','A2']`). Detalle técnico del parser (dos renderizados según tipo de sala) en `mcp-servers/CLAUDE.md`, fila `cine` — no duplicar acá.

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
- **Carrera de conexión MCP no-bloqueante (`alwaysLoad`, 2026-08-02):** desde Claude Code SDK
  v2.1.142, la conexión a `mcpServers` es no-bloqueante por default — el primer turno arranca
  sin esperar a que el server termine de conectar. Con `startup()` fresco por invocación (Jano
  no usa warm pool), esto genera una carrera real: confirmado en logs, `mcp__cos-tools__*`
  (22x, el server MÁS usado) y `mcp__claude_ai_Google_Calendar__list_events` (20x) fallaron con
  "No such tool available" en el PRIMER intento tras `warm_startup`. Fix aplicado: `alwaysLoad:
  true` en `cos-tools` (dentro de `createFreshMcpServer()`) y en `naabol-flights`/
  `serpapi-flights` (preventivo, sin evidencia directa acá pero mismo mecanismo — sí confirmado
  en Vesta). **Trade-off real, no gratis:** con `ToolSearch` activo, `alwaysLoad` en `cos-tools`
  reintroduce ~49% del volumen de tools (80 de 164) que motivó activar ToolSearch en primer
  lugar — monitorear `cacheReadInputTokens`/`sdk_diagnostic_leak` los próximos días; si vuelve
  el thrashing, la palanca es mover a `alwaysLoad` per-tool solo el subconjunto de `cos-tools`
  realmente usado cada turno, no todo el server. `alwaysLoad` en los 2 stdio de vuelos también
  puede sumar hasta 5s a TODOS los turnos (no solo los de vuelos) — decisión de Cal, evaluada
  contra el patrón de industria (lazy-loading por intención solo compensa arriba de 15-30 tools;
  estos servers tienen 2 c/u, no vale la complejidad). **Pendiente, fuera de código:** Calendar
  heredado no vive en `mcpServers` (lo inyecta OAuth Max) — `alwaysLoad` no le aplica; la única
  palanca es `MCP_CONNECTION_NONBLOCKING=0` a nivel proceso (plist), evaluar aparte. Mismo fix
  portado a Vesta (`vesta-tools`) y Pecunia (`pecunia-tools`) el mismo día. Ref:
  docs.claude.com/en/agent-sdk/mcp#connection-timing, issue github #76239 (mismo síntoma
  reportado, abierto).
- **`ntn api` query:** usar `/v1/data_sources/{ds_id}/query`, NO `/v1/databases/{id}/query` (devuelve 400). El `data_source_id` ≠ `db_id`.
- **Nunca derivar una fecha de calendario con `new Date(ms).toISOString().slice(0,10)`:** eso da el día en UTC, y La Paz es UTC-4 — cualquier timestamp entre las 20:00 y medianoche hora local queda fechado al día siguiente. Usar `nowInLaPaz(new Date(ms)).slice(0,10)` (`journal-capture.ts`, acepta un `Date` opcional — no solo "ahora"). Encontrado 2026-07-28 (Cal lo pisó 4 veces el mismo día en otro contexto) y corregido en `task-check.ts` y `daily-note-check.ts` (`isoDateFromMillis` en ambos). Antes de agregar cualquier cron nuevo que fechee algo por `internalDate`/timestamp de recepción, revisar que use este helper.
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
- **Fuga de mensaje de diagnóstico interno del SDK a Telegram — resuelto (2026-07-06):** `agent.ts` extraía `finalText` de cualquier evento `{type:"result", subtype:"success"}` sin filtrar, asumiendo que "success" implica respuesta válida del agente. En un turno real (Cal pidiendo comparar stats FIFA de Suiza y Colombia), el modelo pasó `matchId` con el `fixtureId` de `getFixtures` (API-Football) a `getFifaMatchStats` (que espera el `matchId` **interno de FIFA**, sistema de IDs totalmente distinto) → 2 tool calls fallidos + reintentos con parámetros distintos → 8 tool calls en un solo turno sobre la sesión `warm` persistente (que nunca resetea contexto entre turnos, confirmado por `cacheReadInputTokens` subiendo 273K→540K→942K turno a turno) → el SDK entró en auto-compact repetido dentro del mismo turno y terminó abortando, devolviendo su propio texto de diagnóstico ("Autocompact is thrashing: the context refilled to the limit...") marcado como `success`. El daemon lo reenvió tal cual a Cal como si fuera la respuesta del bot. **Fix (2 partes):** (1) `agent.ts` — `SDK_DIAGNOSTIC_PATTERNS` detecta ese texto antes de devolver `reply` y lo reemplaza por un mensaje entendible + log `sdk_diagnostic_leak`. (2) `system-prompt.ts` — se documentó la sección "FIFA avanzadas" (antes inexistente: `getMatchReport`/`getMatchPreview`/`getFifaMatchStats`/`getFifaPlayerStats`/`getFifaPowerRanking` no estaban en el prompt en absoluto), aclarando que hay que pasar siempre `teamA`/`teamB` y NUNCA `matchId` adivinado desde `getFixtures`. **Pendiente sin resolver (decisión de Cal, fuera de scope):** la sesión `warm` sigue sin reseteo periódico — el riesgo de acumulación de contexto entre turnos de un mismo chat sigue latente para otros flujos con muchos tool calls encadenados.
- **Recurrencia del thrashing — causa raíz real era otra (2026-07-06, mismo día):** el filtro `SDK_DIAGNOSTIC_PATTERNS` de arriba funcionó (Cal recibió el fallback, no el texto crudo), pero el thrashing volvió a las pocas horas con "dame todas las stats FIFA de los partidos jugados de Suiza y Colombia": `getFixtures` (`worldcup` MCP) solo filtraba por `date`, no por equipo, así que para "todos los partidos de un equipo" el modelo no tenía mejor opción que ADIVINAR rival+fecha de memoria — adivinó 7 veces, falló 3, y ante cada fallo **reintentó la misma búsqueda 2-3 veces con variantes de ortografía/traducción** (Uzbekistan/Uzbekistán, DR Congo/Congo DR/Democratic Republic of Congo) en vez de rendirse — 17 tool calls en un turno de 7 min. **Fix (2 partes):** (1) `worldcup` MCP (`apifootball.ts`/`index.ts`, repo `mcp-servers`) — `getFixtures` ahora acepta `team?` y filtra client-side sobre la respuesta ya cacheada (home/away, partial match case-insensitive); sin partidos → error explícito. (2) `system-prompt.ts` — instruye usar `getFixtures({team})` primero para sacar rivales/fechas reales antes de llamar `getFifaMatchStats` en loop, y prohíbe reintentar la misma búsqueda con variantes de ortografía tras un fallo. Lección: el filtro de la fuga (fix anterior) es una red de seguridad, no una cura — la causa raíz de cada thrashing puede ser distinta y hay que seguir cazándolas una por una mientras la sesión `warm` no tenga reseteo.
- **Thrashing recurrencia #3 (BoA check-in, 2026-07-13) + causa raíz estructural encontrada (2026-07-14):** tercera recurrencia del mismo bug, esta vez con "hazme el check-in, cargá mi frecuente y dame el boarding" — 2 turnos consecutivos colapsaron con `sdk_diagnostic_leak`. A diferencia de los 2 casos de FIFA (arriba), el segundo turno tenía `historyLen:0` (conversación recién arrancada) y aun así thrasheó al primer intento — descarta la teoría de "la sesión warm nunca resetea contexto entre turnos": Jano NO usa warm pool (`takeWarm()` hace `startup()` fresco por mensaje, `index.ts:319`), así que no hay acumulación entre turnos de Telegram. **Causa raíz real (encontrada decompilando strings del binario nativo `claude-agent-sdk-darwin-arm64`):** "Autocompact is thrashing" es un circuit breaker hardcodeado del SDK — si el contexto se recompacta y vuelve a tocar el umbral en <3 turnos internos, 3 veces seguidas, el SDK aborta el turno devolviendo ese texto como `result` con `subtype:"success"`. Jano tiene 164 tools permitidos repartidos en 13 MCP servers + system prompt de ~18-20K tokens — todo eso se reenvía COMPLETO en cada una de las ~7-12 llamadas internas de un turno (`maxTurns:12`), dejando poco margen antes de volver a tocar el techo de compactación. Confirmado con los números reales: `cacheReadInputTokens` sumó 1.19M–1.37M en apenas 6-7 tool calls (piso ya alto desde el arranque). Revisando `CHANGELOG.md` aparece un CUARTO caso más viejo, no documentado acá todavía: 2026-05-23, Readwise sin `pageSize` devolviendo miles de highlights — mismo bug, 6 semanas antes de los de FIFA. **Fix estructural probado (2026-07-14):** el SDK (`claude-agent-sdk@0.2.122`, ya instalado) trae nativo el mecanismo de carga diferida de tools ("Tool Search" — mismo patrón que recomienda Anthropic en "code execution with MCP" para este problema exacto). Encontrado que `"ToolSearch"` estaba bloqueada en `DISALLOWED_BUILTINS` desde el commit inicial del daemon (`7016197`, 28-abr) — agrupada sin comentario específico junto a otros builtins de orquestación de CLI (Task/Agent/TodoWrite), de cuando Jano tenía 9 tools y el problema de bloat todavía no existía; nunca se reconsideró mientras crecía a 164. Fix: `ToolSearch` sacada de `DISALLOWED_BUILTINS` y agregada a `CLAUDE_AI_COS_TOOLS` (`agent-options.ts`) — el modelo ahora busca (`{query}` → `tool_reference`) y carga solo los schemas que necesita por turno, en vez de los 164 completos siempre. **Primer test real (BoA check-in completo — Calendar + 3 tools de boa-checkin + envío de documento, 9 tool calls con 3 `ToolSearch` intercaladas):** 0 errores, 0 thrashing, `cacheReadInputTokens` **405K** contra 1.19M-1.37M de los turnos que colapsaron con carga de trabajo comparable — caída de ~3x. Un solo caso confirmado hasta ahora, monitorear logs unos días antes de darlo por resuelto del todo. **Fix defensivo agregado en el mismo cambio (`agent.ts`):** el `daemon-health-reviewer` señaló que el SDK puede cortar un turno con `subtype:"success"` pero `terminal_reason:"tool_deferred"` (el modelo intenta usar una tool diferida sin buscarla primero) — sin manejarlo, Cal recibiría una respuesta vacía/incompleta sin rastro en logs. Agregado chequeo de `terminal_reason`/`deferred_tool_use` con log `tool_deferred_unresolved` + mensaje de fallback visible (mismo patrón que `SDK_DIAGNOSTIC_PATTERNS`). También agregada entrada de `"ToolSearch"` a `TOOL_MESSAGES` ("🔎 Buscando la herramienta correcta..."). **Riesgo aceptado, sin mitigar:** `ToolSearch` expone el universo completo de ~180 tools de OAuth Max (no solo las 164 curadas de Jano) — confirmado empíricamente. Si el enforcement de `allowedTools` sigue aplicando al ejecutar (lo más probable), el peor caso es tool-calls desperdiciados en "permissions not granted" — vale monitorear en logs.
- **Bug distinto encontrado probando el fix de arriba — PNR de BoA no se recuperaba entre turnos (resuelto 2026-07-14):** con `ToolSearch` ya andando, Cal pidió el boarding pass de un vuelo (Jano lo resolvió bien, encontró el PNR vía Calendar) y a continuación, en el MISMO chat, pidió cambiar el asiento — Jano respondió "No tengo a mano el localizador (PNR) de esa reserva en esta sesión. ¿Me lo confirmas de nuevo?" pese a que el vuelo ya estaba identificado dos mensajes antes. Verificado leyendo el KV real (`cos-ctx:{chatId}`) que el historial de texto entre turnos SÍ persiste (no es un problema de "sesión sin memoria" en general — `state.ts` guarda hasta 40 mensajes), pero solo guarda el TEXTO de la conversación, nunca los parámetros crudos de una tool call — la respuesta anterior mencionaba "OB688" pero no el PNR. **Causa raíz real, no arquitectural sino un dato falso en el prompt:** `system-prompt.ts` decía literalmente "El código de reserva (PNR) NO está en el calendario — pedíselo a Cal directo" — verificado en vivo contra el Calendar real que es FALSO: los eventos sincronizados por Flighty traen `"Booking Code: XXX"` en la descripción. El modelo lo había usado correctamente en el turno del boarding pass (encontrándolo pese a la instrucción errónea) pero siguió la instrucción al pie de la letra en el turno del asiento y ni lo intentó. **Fix:** corregida la afirmación falsa (Paso 1 de check-in) + agregada nota compartida antes de las 3 subsecciones "check-in YA hecho" (cambiar asiento / boarding pass / viajero frecuente) recordando re-buscar el vuelo en Calendar (`list_events` con `calendarId`+`fullText`+`startTime`/`endTime` acotado — nombrado explícito tras el review: `search_events` NO acepta `calendarId` ni `fullText`, hubiera buscado en el calendario equivocado) antes de volver a pedirle el PNR a Cal.
- **Keyboard sin limpiar en `jano-wiz-*` — resuelto (2026-07-03):** el helper local `editMsg` en `tools/approval-flow.ts` omitía `reply_markup` cuando no había un teclado nuevo que pasar, y por el mismo gotcha de Telegram (`editMessageText` no limpia `reply_markup` si se omite) los botones de la tarjeta anterior (`bulk-ok`/`bulk-no`/`back`/`start`/`ok`/`no` en sus ramas terminales — todas las que hacen `kv.delete(wizKey(...))` con `done: true`) quedaban vivos y tocables tras pasar a un estado sin botones ("todos revisados"). Fix: `editMsg` ahora manda SIEMPRE `reply_markup`, con `{ inline_keyboard: [] }` por default si no se pasa uno nuevo — generalizado en el helper en vez de parchar cada call site (todos los que quieren conservar teclado ya lo pasaban explícito). Fix 100% aislado en `approval-flow.ts`, no toca el routing de `index.ts` ni `existingPlaceholderId` (confirmado por `daemon-health-reviewer` vía `git diff --stat` + grep de `buildApprovalFlow`/`stepApprovalWizard` en `index.ts`, sin llamadas reales ahí).
- **`AskUserQuestion` cuelga turnos ~1min con error silencioso — resuelto (2026-07-12):** el modelo a veces intenta usar `AskUserQuestion` (tool interactiva de Claude Code CLI, pensada para sesiones con un humano respondiendo botones en el momento) para confirmarle algo a Cal antes de seguir — visto en el flujo de tags del resumidor (`editarPropuestaResumen`) y en confirmación de fechas de calendario. En el daemon headless de Jano esa tool no tiene handler real: falla siempre con el mismo error genérico `"Answer questions?"` (`tool_result.is_error:true`), y el modelo tarda decenas de segundos en reintentar con la tool correcta — desde Telegram se siente como "no funcionó" o error. Fix: agregada `"AskUserQuestion"` a `DISALLOWED_BUILTINS` en `agent-options.ts`, mismo patrón que las demás tools interactivas de CLI ya bloqueadas (`ScheduleWakeup`, `Monitor`, `PushNotification`, `EnterWorktree`/`ExitWorktree`, `ExitPlanMode`). Diagnosticado leyendo `~/Library/Logs/cos-agent-v2.out.log` (`grep "AskUserQuestion"` mostró el patrón repetido con el mismo `err`).
- **YouTube exige "Sign in to confirm you're not a bot" a `yt-dlp` sin cookies — resuelto (2026-07-12):** un video de la playlist auto-resumidor falló ("⚠️ No pude resumir..."), y el fallo no dejaba rastro en `out.log` ni `err.log` porque en `run()` (`tools/resumir.ts:549-552`) el fallo de transcripción hace `return` (no `throw`) — sin excepción no hay `console.error`, y el mensaje específico del error (`"❌ No pude transcribir (...)"`) se pisa casi al instante por el genérico de `startPlaylistItem` (`"⚠️ No pude resumir... Lo dejé de nuevo en la cola"`, ver gotcha de fallas puntuales arriba en la sección Jano/CLAUDE.md de Resumidor). Reproducido a mano: `yt-dlp --print "%(title)s" <url>` devolvía el bloqueo de YouTube para CUALQUIER video (no uno puntual) — bloqueo nuevo de YouTube a nivel IP, no un bug de código. `brew upgrade yt-dlp` (2026.6.9→2026.7.4) NO lo resolvió. Fix real: `~/.claude/scripts/audio-transcribe.sh` ahora pasa `--cookies-from-browser safari` (array `YTDLP_COOKIES`) a las 4 llamadas a `yt-dlp` del script (captions, metadata ×2, descarga de audio) — reusa la sesión de YouTube logueada de Cal en Safari. Confirmado funcionando end-to-end bajo el daemon real (vía Telegram), no solo en shell interactivo — a diferencia de `fetchAsUser`/`safari-fetch.mjs`, acá NO hizo falta el wrapper `node-fda` con FDA especial; `yt-dlp --cookies-from-browser safari` funcionó directo bajo launchd.
- **`WarmQuery` huérfano en retornos tempranos de `processMessage` — resuelto (2026-07-14):** encontrado al revisar un fix análogo en Pecunia el mismo día (commit `4ccc44c`). `takeWarm()` se dispara al inicio de cada turno para solapar el arranque del subprocess del SDK con el preprocessing multimodal — pero 4 `return` tempranos (falla al transcribir audio, falla al leer foto, falla al leer documento, sin texto tras preprocessing) abandonaban el `warmPromise` sin cerrarlo, dejando el subprocess pre-warmeado corriendo huérfano indefinidamente. En Pecunia el mismo patrón rompía el turno SIGUIENTE ("No such tool available", 86 ocurrencias abr-jul) por compartir un mcpServer singleton; en Jano NO rompe el turno siguiente (cada `takeWarm()` ya usa un mcpServer fresco y aislado, `index.ts:317-336`), pero el leak de subprocess/recursos igual aplica en un daemon que corre semanas sin reiniciar. **Fix:** `discardWarm(warmPromise)` (usa `WarmQuery.close()`, documentado en el SDK para exactamente este caso) en los 4 `return`, todos verificados por `daemon-health-reviewer` como anteriores al `await warmPromise` real — nunca interrumpen un turno en curso. **Gap preexistente encontrado de paso, sin resolver:** el `try` externo de `processMessage` no tiene `catch` propio — una excepción real (no un `return`) antes de `await warmPromise` (ej. `state.load` o un `editMessage`/`sendMessage` sin `.catch()` en las ramas de voz/foto/documento) escapa sin capturar, deja el `warm` sin cerrar Y deja a Cal con el placeholder "⏳ Procesando..." colgado sin mensaje de error (el daemon no crashea, el loop principal la atrapa más arriba, pero Cal nunca se entera). Sin implementar — decisión pendiente de Cal si se materializa en la práctica.
- **Detección de cortes de sync de Apple Health — agregado (2026-07-15), pasado a proactivo (2026-07-16):** Cal reportó que tenía que abrir Health Auto Export a mano para que suba data (la automatización interna de la app + Background App Refresh no estaban configuradas). Fix de fondo es config en el teléfono (fuera de este repo); como red de seguridad se agregó tracking del último `/ingest` recibido — ver detalle completo en `Health/CLAUDE.md` y `Health/health-worker/`. Tool `mcp__health__getHealthSyncStatus` (sin args) wireado en `allowedTools` + `system-prompt.ts` (sección `## Salud`) para el camino reactivo (Cal pregunta, Jano responde). **2026-07-16:** un corte real de 11 horas (07:02-18:23 local, confirmado vía diagnóstico exportado de la app: el loop de automatización de Health Auto Export no corrió NADA en esa ventana — iOS suspendió el background refresh) llevó a Cal a pedir que esto SÍ sea proactivo. Se agregó `scheduleHealthSyncCheck()` (`proactive/health-sync-check.ts`, cron `0,30 7-22 * * *` timezone La Paz) — chequeo mecánico (sin LLM) contra `GET /status` del health-worker; si `hoursSinceLastIngest >= 4h` y no se avisó ya para ese corte (dedup en CF KV, TTL 24h), manda alerta directa por Telegram. Esto **reabre puntualmente** la arquitectura 100% reactiva decidida el 2026-07-14 (ver sección "Automatización — dos capas" abajo) — a diferencia de las otras 3 proactivas (resumidor/flight-checkin/foco-checkin), que siguen desactivadas.
- **`generateBoaWalletPass` — origen/destino vacíos o cruzados en el pase (encontrado y resuelto 2026-07-20, reserva HVKNUC):** Cal probó el wallet pass de un boarding pass ya checkeado y el pase (tanto el `.pkpass` como la tarjeta `.png`) salió con origen/destino VACÍOS ("VVI"/"LPB" en blanco, el ícono de avión sin nada a los costados). Causa raíz: `getWalletPassScrapeData` (`flow.ts`, MCP `boa-checkin`) sacaba origen/destino con un regex sobre el texto de "Manage your booking" que el propio código ya marcaba como *nunca validado contra una reserva real* — quedó demostrado que no matchea el DOM real. **Fix intento 1:** reemplazar el scrape por un parseo del BCBP (código de barras del PDF oficial, ya decodificado por `decodeBoardingPassBarcode` para el propio barcode del pase — mucho más confiable que scrapear pantalla) con offsets fijos contados desde el inicio del mensaje, calibrados contra un decode real. **Reventó en el segundo intento** (mismo PNR, después de un cambio de asiento): el campo de nombre del pasajero salió 1 carácter más corto en el segundo decode del mismo código de barras ("LEPESQUEUR" vs "LEPESQUEUER" — ruido normal de leer un PDF417, no un dato real distinto), lo que corrió TODOS los campos siguientes una posición → origen/destino salieron "VIL"/"PBO" (basura, leyendo el pedazo equivocado del mensaje). **Fix real:** `parseBcbpEssentials(message, pnrCode)` en `wallet-pdf417.ts` ahora ancla la lectura en el PNR/locator YA CONOCIDO (`args.locator`, vía `indexOf`) en vez de contar bytes desde el arranque del mensaje — el campo de ruta está a un offset fijo (+7) desde ahí, y ese offset SÍ es estable porque no depende del largo variable del nombre. Validado contra los dos decodes reales de HVKNUC (el corrupto y el limpio), ambos dan VVI/LPB. **Lección para cualquier parseo de BCBP futuro:** nunca asumir offsets absolutos desde el inicio del mensaje — anclar en un campo ya conocido de antemano. De paso se agregó `AIRPORT_NAMES` (diccionario IATA→"Ciudad — Aeropuerto", los 12 NAABOL + destinos internacionales de BoA confirmados) en `wallet-pass.ts` para que el label del pase muestre la ciudad y no el código pelado, se endureció el regex de `Gate` (capturaba la palabra "Check" como si fuera código de puerta — ahora exige un dígito y ≤4 caracteres) y se agregó fallback "—" para "Grupo" cuando BoA no lo muestra en check-in. Commit `a6234fe`.
- **`prepareBoaCheckin` EJECUTA el check-in real + "no está abierto" cuando en realidad "ya está hecho" (encontrado y resuelto 2026-07-20, reserva HVKNUC — reinterpreta el incidente del 2026-07-12):** Cal pidió check-in vía Jano; `prepare` funcionó (mostró asientos, preseleccionado 27A, Cal eligió 4B) pero el `confirm` de 3 minutos después falló con "El check-in todavía no está abierto para ningún tramo" — y todos los reintentos igual. Sonda de solo lectura posterior: **ambos tramos ya checkeados**, boarding pass emitido con 27A. Descubrimiento: el "Confirm and continue" de Required information (que `prepare` clickea para llegar al mapa de asientos) **consuma el check-in en el backend de Amadeus** — no hay "hold temporal" (esa teoría del incidente 2026-07-12 era incorrecta: aquella reserva "bloqueada por horas" estaba simplemente checkeada y el código no sabía leerlo). Causa raíz del mensaje falso: las cards de "Your journeys" tienen 3 estados (botón "Check in" = abierto · botón "Manage check-in" = ya hecho · sin botón = no abre todavía) y `selectJourney` solo distinguía 2, reportando "no está abierto" también para tramos checkeados. **Fix (MCP boa-checkin):** módulo puro `journeys.ts` (+13 tests) clasifica los 3 estados y los enumera en cada error; `selectJourney` devuelve `{yaCheckeado}` y entra por "Manage check-in" si corresponde; `prepare` sobre tramo checkeado devuelve `{yaCheckeado:true, boardingPasses}`; `confirm` idempotente (sobre tramo checkeado ajusta asiento vía `changeSeatFromManage` y devuelve pases) + post-condición `asientoVerificado` (asiento leído del BCBP del PDF real — 4ta aparición del patrón "ok:true sin verificar"); `withBoaSession` captura screenshot+texto a tmpdir en toda falla (`boa-diag-*`). Tool descriptions + system prompts de Jano y Vesta actualizados con la semántica real ("prepare = check-in ejecutado"). Detalle completo en el skill `boa-checkin-bolivia`.
- **MCP `cine` perdía el estado de la compra entre turnos — resuelto (2026-07-25):** el flujo de compra (`iniciarCompraCine` → `elegirAsientosCine` → `confirmarCompraCine`) guarda el browser de Playwright y el `Map` de sesiones en memoria del proceso del MCP (`compra-store.ts`) — necesario porque el hold de asientos de Cinemark está atado a esa pestaña específica, no es un código portátil como un PNR de avión. Pero Jano no usa warm pool (fresh `startup()` por mensaje, ver arriba) y `cine` estaba registrado `type: "stdio"` → cada mensaje de Telegram spawneaba un proceso `cine` NUEVO, con memoria vacía. Resultado: Cal elegía asiento en un mensaje, confirmaba en el siguiente, y ese siguiente mensaje hablaba con un `cine` recién nacido que nunca supo que la compra existía (`estadoCompraCine` devolvía `{activa:false}` a los ~76-90s, mucho antes de los "7 minutos restantes" que mostraba — el problema no era el timeout de Cinemark, era el reinicio de proceso). `boa-checkin` no sufre esto: abre y cierra el browser en CADA llamada, re-buscando la reserva por PNR/apellido (dato portátil), sin depender de memoria compartida entre llamadas. **Fix:** `cine` pasó de subproceso `stdio` efímero a proceso HTTP persistente (`servers/cine/src/http.ts`, `StreamableHTTPServerTransport` en modo stateless — el estado real sigue viviendo en `compra-store.ts`, lo que cambió es que el proceso que lo contiene ya no se reinicia por turno). Corre vía launchd (`com.cal.cine-mcp-jano.plist`, puerto 8791, `KeepAlive`), un proceso separado por bot (Vesta usa `com.cal.cine-mcp-vesta.plist`, puerto 8792) para preservar el invariante "una compra activa por instancia = por bot". `daemon-v2/src/index.ts` registra `cine` como `type: "http"` apuntando a `http://127.0.0.1:8791/mcp` en vez de spawnear el binario. **Gotcha del SDK MCP encontrado en el camino:** `StreamableHTTPServerTransport` en modo stateless (`@modelcontextprotocol/sdk@1.26.0`) NO soporta reusar un mismo `Transport` en más de un request HTTP (tira `"Stateless transport cannot be reused across requests"`) — `http.ts` crea `Server`+`Transport` nuevos por cada POST (mismo patrón del ejemplo oficial bundleado del SDK), lo cual es inocuo para el objetivo real porque el estado de negocio vive en `compra-store.ts` a nivel de módulo, no dentro del objeto `Server` — verificado con un test que abre dos conexiones MCP independientes y confirma que ambas ven la misma compra activa. Detalle completo: `docs/superpowers/plans/2026-07-25-cine-mcp-persistent-process.md`.

## Journal de reflexión (terapia) — agregado 2026-07-27

DB `Journal` en Notion (`3aac4876-09dd-81ee-8ead-f55a15074cab`, bajo la página *Mental Health*) para
captura cruda de pensamientos con fecha y hora, con puente a **Resonate Calendar** (`Type: Reflexion`,
`Tags: Terapia`) vía la propiedad `Journal` ↔ `Reflexión`. Diseño completo en
`docs/superpowers/specs/2026-07-27-journal-terapia-notion-design.md`; plan en `docs/superpowers/plans/`.

- **Captura mecánica, sin LLM:** prefijo `journal:`/`diario:` o modo journal (botón 📓 del menú, estado
  en KV `jano:journal-mode:{chatId}` con TTL 30 min, refrescado en cada guardado). El texto se persiste ANTES de que el modelo lo vea —
  por eso "Jano escribe tal cual" es literal. **El texto va al CUERPO de la página, no a una propiedad:**
  `rich_text` corta a 2000 chars y una descarga de voz larga perdería texto en silencio.
- **Metadata en un segundo paso** (`journal-enrich.ts`: Haiku, `maxTurns:1`, sin tools, patrón de
  `compact.ts`) → tarjeta `propose → botones` copiada de Pecunia (`journal-store.ts` espeja
  `proposal-store.ts`). Si ese paso falla, la entrada ya está a salvo y la levanta el barrido.
- **Callbacks `jnl:*` son todos HEAVY** (escriben en Notion) con el lock anti-doble-tap de `cf-kv.ts`.
- **Emojis de dominio del Journal (extensión del lexicon de `telegram-bot-ux`,** que no los trae):
  `📓` journal/entrada · `🌟` reflexión destilable · `🎭` ánimo · `🏷️` topics · `⏹️` cerrar modo ·
  `⏭️` posponer · `⬜` toggle apagado · `⬅️` volver · `🚫` quitar valor · `⌛` expirado · `👍` ack sin
  acción. Los de terapia (`😔 😐 🙂 😤 😰`) son **valores de datos** de la propiedad `Ánimo` en Notion,
  no decoración — el mismo string vive en la DB y en la tarjeta. Ninguno es decorativo.
- **⚠️ `j:journal` tiene que estar ARRIBA del `startsWith("j:")` genérico en `index.ts`** (el que rutea a
  `handleMenuCallback`), porque ese bloque retorna incondicionalmente. Puesto abajo, el botón es código
  muerto y no deja ni rastro en logs. Mismo motivo por el que `j:star`/`j:ytpl` están donde están.
  Encontrado por `daemon-health-reviewer` el 2026-07-27, antes de llegar a producción.
- **`apply` mueve `Estado` a `Destilado`** aunque no haya reflexión. Sin eso la entrada queda
  `Sin revisar` para siempre y el barrido dominical se la repropone cada semana, re-corriendo Haiku
  sobre metadata ya aplicada y pisándola.
- **`consultarJournal` devuelve filas COMPACTAS** (`compactJournalRows`), no las páginas crudas de
  Notion: 15 páginas completas rondan los 75-150 KB y disparan el persisted-output loop del SDK
  (umbral ~25 KB, ver gotcha más arriba).
- **La captura va fire-and-forget** (`void captureThought(...)` en `index.ts`), igual que `resu-pick:`
  y `j:star`: hace un `startup()` del SDK más 3 `spawnSync` de `ntn` (~10-20s) y el poll loop del
  daemon es estrictamente secuencial — awaitearlo congelaba todos los chats.
- **Gotcha del modo journal:** mientras está abierto intercepta TODOS los mensajes del chat, incluidos
  los que eran pedidos normales. Mitigado con el TTL de 30 min (bajado de 2h el 2026-07-27 tras tragarse un pedido real el primer día), el botón ⏹️ Cerrar journal en cada tarjeta guardada, y el mensaje ancla visible. No eliminado.
- **Pendientes conocidos** (del review, sin resolver): no hay idempotencia contra redelivery de la CF
  Queue → un batch que exceda los 30s de `visibility_timeout_ms` podría duplicar filas; el picker de
  Topics no permite crear uno nuevo (`createTopic` existe pero no tiene call site); `Origen: "Sesión
  terapia"` no tiene UI (el modo siempre abre como `Texto`).

## Self-learning — agregado 2026-07-28

Jano aprende de sus conversaciones. Un cron nocturno (22:00 La Paz) lee las sesiones del día que el
SDK ya persiste, las pasa por Haiku, y propone aprendizajes en una tarjeta con botones. Solo lo que
Cal aprueba se escribe a `~/.cos-agent/learnings.md`, que se inyecta en el system prompt.
Spec: `docs/superpowers/specs/2026-07-28-backlog-tool-y-self-learning-design.md` (Parte 2).

- **El diagnóstico que originó el rediseño:** el loop de aprendizaje YA existía y estaba cerrado
  (`addLearning` → archivo → system prompt), pero llevaba **4 entries en 3 meses**. La causa no era
  falta de infraestructura sino QUIÉN dispara la escritura: el modelo, en medio del turno, mientras
  resuelve otra cosa. La reflexión compite con la ejecución y pierde siempre. El fix es moverla
  fuera del turno.
- **Cuatro tags** en un solo archivo: `pref` (preferencia de estilo) · `hecho` (dato sobre Cal) ·
  `err` (error operativo propio) · `flujo` (secuencia repetida). Las líneas viejas sin tag se
  parsean igual y caen a `hecho`.
- **⚠️ `SDK_SESSIONS_DIR` se deriva del `process.cwd()`, NUNCA se hardcodea.** El SDK arma el nombre
  del directorio de sesiones desde el cwd, y el `WorkingDirectory` del plist es `.../Jano/daemon-v2`
  — o sea las sesiones del daemon están en `-...-Agents-Jano-daemon-v2`, no en `-...-Agents-Jano`
  (que es el de las sesiones interactivas de Claude Code sobre el repo). **Los dos directorios
  existen**, y apuntar al equivocado da transcript vacío → `learning_reflect_empty` → ninguna
  tarjeta: un modo de falla indistinguible de "hoy no hubo nada que aprender", que puede durar
  semanas sin notarse. Encontrado por `daemon-health-reviewer` antes de producción; el paso de
  verificación original comprobaba que el directorio *existiera*, no que fuera *el correcto*.
- **Aislamiento de sesiones:** `session-log.ts` mantiene un registro append-only de los sessionIds
  que usó el daemon (`~/.cos-agent/sessions-log.jsonl`). Sin él, el pase leería sesiones de
  desarrollo. `sessions.json` no sirve: guarda solo la vigente y la pierde al rotar.
- **Ventana móvil de 24 h**, no día calendario: un cron a las 22:00 que filtrara por fecha dejaría
  ciega la franja 22:00-00:00, que es justo cuando Cal más escribe.
- **El system prompt se recalcula POR TURNO.** `BASE_OPTIONS` ya no lleva `systemPrompt`: lo
  inyectan `buildOptions()` y `getOptions()` vía `buildSystemPrompt()`. Antes era un `const` de
  módulo evaluado una sola vez al arrancar, así que ningún learning nuevo influía hasta reiniciar el
  daemon — en un proceso que corre semanas, indefinido. **No lo "optimices" de vuelta a constante.**
  Limitación conocida: con `resume`, una sesión en curso conserva el prompt con el que arrancó, así
  que un learning aprobado impacta en la sesión siguiente de ese chat (TTL 12 h o tope de turnos).
- **El batch se recorta a 5 candidatos AL CREARLO**, no al renderizar: si la tarjeta mostrara 5 y
  `✅ Guardar todos` guardara 8, entraría al system prompt texto que Cal nunca vio — y el transcript
  acarrea material no confiable (Jano resume artículos con `fetchAsUser`/resumidor y eso entra como
  bloque `JANO:`).
- **`recordarAprendizaje` muestra SIEMPRE el texto guardado en el ack** (`🧠 Anotado: «...»`).
  Escribe sin confirmación, y Jano ingiere contenido no confiable de rutina; sin el eco, un
  "de ahora en más..." incrustado en una web podría fijarse sin que Cal pueda auditarlo.
- **`mcp__agent-learnings__addLearning` fuera de la allowlist** (`agent-options.ts`): con ToolSearch
  activo, decirlo solo en prosa no alcanzaba — el modelo podía llamarla igual, y escribe a un store
  que no se inyecta en ningún prompt.
- **Emojis de dominio** (extensión del lexicon de `telegram-bot-ux`): `🌙` reflexión nocturna ·
  `🎯` pref · `🧠` hecho · `🔧` err · `🔁` flujo (mismo emoji que TRX en KPIs Yape — nunca coexisten
  en un mensaje) · `🧹` poda. Ninguno decorativo.
- **Pendiente conocido:** no hay forma de podar learnings desde el chat. El presupuesto blando
  (~4 K tokens) avisa, pero borrar exige editar el archivo a mano.

## Backlogs de proyectos — agregado 2026-07-28

Tres tools para que Jano lea y escriba los `BACKLOG.md` repartidos por `~/Claude Projects`:
`mapaBacklogs` (mapa completo con conteos), `leerBacklog` (pendientes de uno) y
`proponerItemBacklog` (propone agregar/tildar, **no escribe** — manda tarjeta y Cal confirma).
Spec: `docs/superpowers/specs/2026-07-28-backlog-tool-y-self-learning-design.md`.

- **Descubrimiento en vivo, no allowlist.** `find` cacheado 10 min, profundidad 6, podando
  `node_modules`, `_archive`, `commands` (contiene slash commands, no backlogs) y `.git`.
  Hoy da 17 backlogs. Un proyecto nuevo aparece solo.
- **La seguridad son cuatro invariantes**, no la lista: el modelo pasa una **clave** (nunca ruta) ·
  `realpathSync` dentro del root · basename exactamente `backlog.md` · destino que sea archivo
  regular. El `realpath` va ANTES de validar — misma lección que `consultar-json.ts`.
- **Clave y label salen del PROYECTO, no de la carpeta contenedora.** Pecunia es `pecunia` aunque
  su backlog viva en `pfm-dashboard/`. Sin esto el mapa mostraba `📋 docs` y `📋 agente`. Dos
  backlogs del mismo proyecto se desambiguan con la subcarpeta (`inversiones-agente`).
- **Solo dos escrituras:** append bajo `### Surgió en sesión YYYY-MM-DD` y tildado `[ ]`→`[x]`
  (falla explícito con 0 o ≥2 coincidencias, nunca adivina). Nunca edición libre. Escritura
  atómica (temporal + `rename`).
- **`execFileSync` a propósito**, contra el estándar de `consultar-json.ts`: el `find` real mide
  **10-70 ms** y pasarlo a async obligaría a volver asíncrona toda la cadena. Timeout **2 s** como
  techo del peor caso (bajado de 10 s — ese sí congelaría el daemon entero).
- **`leerBacklog` devuelve vista COMPACTA** (solo `- [ ]`, truncados a 200 chars): el `BACKLOG.md`
  de Jano son ~30 KB, por encima del umbral de ~25 KB del persisted-output loop del SDK.
- **Callbacks `bklg:*` son HEAVY** (escriben a disco) con el lock anti-doble-tap de `cf-kv.ts`.
  Van **arriba del catch-all de "Heavy callbacks legacy"** de `index.ts` — ese bloque agarra
  cualquier `callback_data` sin prefijo `j:`/`build:` y lo manda al LLM; puesto debajo, el botón
  sería código muerto. (Ojo: `bklg:` NO empieza con `j:`, así que el bloque que lo tapaba era el
  legacy, no el `startsWith("j:")`.)
- **Sin auto-commit** (decisión de Cal): el archivo queda modificado en el working tree.
- **Emojis de dominio del backlog** (extensión del lexicon de `telegram-bot-ux`): `📝` ítem nuevo ·
  `📁` proyecto destino · `☑️` marcar hecho · `📋` mapa/listado. Ninguno decorativo.
- **Gotcha del picker de destino:** con 17 backlogs, una fila por proyecto daría 17 filas contra el
  máximo de 4 de Telegram (arriba de eso hay stutter en iOS). Se muestran los 6 de más pendientes
  en 3 filas de 2, más `✍️ Otro proyecto` — el escape SIEMPRE presente (bloque B3 del skill).
- **`✏️ Editar texto` y `✍️ Otro proyecto` no guardan estado propio:** quitan el teclado y le piden
  a Cal que escriba; su mensaje va al LLM, que vuelve a llamar `proponerItemBacklog` y nace una
  tarjeta nueva debajo. Un `pendingEdit` propio sería estado extra que se puede desincronizar.

## Referencias de Diseño — agregado 2026-08-01

Jano captura links de inspiración de diseño (X, Instagram, dashboards, webs) y los guarda en
`Personal/Referencias de Diseño/` (fuera de este repo, hermano de `Personal/Agents/`) — ficha +
screenshot + análisis de visión, para que Claude los use como contexto al rediseñar apps de Cal.
Mismo flujo replicado en sesión interactiva vía el skill `guardar-referencia-diseno`. Spec:
`docs/superpowers/specs/2026-07-31-referencias-diseno-design.md`.

- **Una sola tool, `guardarReferenciaDiseno({ url, aplicableA? })`.** El diseño original (en el
  spec) le pedía al LLM orquestar Playwright a mano (navigate + inyectar cookies con
  `browser_run_code_unsafe` + screenshot) — **nunca llegó a producción así**: esos MCP tools están
  bloqueados para Jano en `DISALLOWED_BUILTINS` (`agent-options.ts`, desde 2026-05-23, "Jano no
  necesita control de navegador") y darle a la LLM `browser_run_code_unsafe` (RCE-equivalent por
  su propia descripción) hubiera sido una regresión de seguridad real. Reescrito el mismo día antes
  de llegar a producción, siguiendo el patrón que este repo ya usa para browser automation
  (`boa-checkin`, `cine`): una tool angosta que controla Playwright **puertas adentro**, sin
  exponerle nada al LLM. `tools/design-capture.ts` (`captureDesignScreenshot`) lanza Chromium
  headless en proceso (paquete `playwright`, no MCP), inyecta cookies si las hay, navega, saca el
  screenshot y cierra — todo dentro de la tool, un solo call desde el LLM.
- **`url` restringido a http/https en dos capas** (zod `.refine()` en el schema + chequeo explícito
  al inicio de `captureDesignScreenshot`, antes de `chromium.launch()`): sin esto, `page.goto()`
  navega `file://` tal cual — a diferencia de `fetchAsUser` (usa `fetch()` nativo, que no puede
  cargar `file://`). Encontrado en code review antes de producción: una inyección de prompt en
  contenido que Jano ya ingesta (`fetchAndSummarize`/resumidor) podía apuntar
  `guardarReferenciaDiseno` a `file:///Users/calepes/.ssh/id_ed25519`, capturar el screenshot,
  mandarlo a una API externa de visión (OpenRouter) y guardarlo en disco/Telegram — un vector de
  exfiltración real, cerrado antes de mergear.
- **Riesgo residual aceptado, no bloqueante:** la restricción es de ESQUEMA, no de destino — una
  URL `https://localhost:{puerto}/...` o a una IP de LAN sigue pasando la validación. Con el screenshot
  yéndose a una API externa de visión, esto es SSRF-adjacent (no lee archivos, pero sí podría
  exponer contenido de servicios internos vía captura). Inherente a cualquier tool de "screenshot de
  una URL cualquiera" — no se cerró, queda documentado.
- **Gap conocido, no bloqueante: el muro de login no siempre corta el guardado.** `vision.ts`
  (task `design_critique`) instruye al modelo de visión a marcar explícito en `QUE_ES` si la imagen
  muestra un muro de login — pero `guardarReferenciaDiseno` solo devuelve `titulo`/`tipo`/`tags` al
  LLM, nunca `queEs`/`porQueFunciona`. Resultado: en un dominio sin cookie sincronizada,
  `guardarReferenciaDiseno` puede devolver `ok:true` con una ficha que describe una pantalla de
  login, y Jano se la manda a Cal como si fuera inspiración real — el `ok:false` que el system
  prompt sabe manejar nunca se dispara en este caso. Pendiente: propagar la señal de "muro de
  login"/"no cargó contenido real" desde `parseDesignCritique` hasta el resultado de la tool.
- **Cookie Broker (`cookie-jar.ts`) ganó `getStructuredCookies`:** el broker solo daba un header
  HTTP para `fetchAsUser`, no servía para autenticar un navegador real. La función nueva lo parsea
  a `{name,value,url}` — formato mínimo que acepta `context.addCookies()` de Playwright.
- **Excepción puntual a la regla dura del Cookie Broker:** `x.com`, `twitter.com` e
  `instagram.com` se agregaron a la whitelist (`~/.claude/config/cookie-jar-domains.json`),
  autorizado explícitamente por Cal el 2026-07-31 — la regla "solo medios de noticias/lectura"
  sigue aplicando para cualquier otro dominio nuevo.
- **`screenshotPath` ya NO lo provee el LLM** (a diferencia del diseño original del spec): lo
  genera `captureDesignScreenshot` internamente (`disref-<timestamp>.png` en `tmpdir()`), así que
  no hay superficie de path traversal desde el modelo. `resolveAllowedLocalFile`
  (`telegram-files.ts`, ya exportada) sigue existiendo para otros usos pero `agent-tools.ts` no la
  importa más para este flujo.
- **El formato de ficha/índice vive en un solo lugar:** `Personal/Referencias de Diseño/_FORMATO.md`
  — lo siguen tanto `design-refs.ts` (Jano) como el skill de sesión interactiva, para que no
  diverjan con el tiempo. El skill SÍ sigue el diseño original (orquesta Playwright MCP a mano) —
  ahí no hay problema de permisos: una sesión interactiva de Claude Code tiene esos MCP tools sin
  restricción, a diferencia del agente headless de Jano.
- **Sin tarjeta de confirmación** (informativo, como `mapaBacklogs`): no hay nada sensible que
  aprobar, Jano manda el screenshot con `enviarFotoLocal` y un caption corto.
- **`design-style-router`** (skill global) lee `INDEX.md` antes de preguntar la línea visual de un
  rediseño y menciona referencias guardadas que apliquen.

### Gotchas de producción, encontrados el mismo día en pruebas reales con Cal (2026-08-01)

- **Cookies inyectadas con `url` en vez de `domain` — la sesión se sincronizaba bien pero el
  browser nunca la mandaba.** Primer smoke test real: Cal se logueó en Threads en Safari, la
  sincronización trajo `sessionid`/`ds_user_id` reales, y el capture SEGUÍA mostrando el muro de
  login. Causa: `getStructuredCookies` armaba cada cookie como `{name, value, url:
  "https://threads.com"}` — el shorthand `url` de Playwright hace la cookie **host-only** (exacta
  a `threads.com`, sin el punto inicial), y Chromium nunca la manda en pedidos a un subdominio
  real como `www.threads.com` (que es literalmente la URL de cualquier link compartido de
  Threads). Fix: `StructuredCookie` pasó a `{name, value, domain, path}` con
  `domain: ".${dominio}"` (con el punto inicial, como el atributo real `Domain=.threads.com` que
  usa el sitio) — aplica a cualquier subdominio. Tocó `cookie-jar.ts` (Jano) y
  `design-ref-cookies.mjs` (skill) por igual, para no divergir.
- **`screenshotPath` vs `shotPath` — dos paths distintos con nombres parecidos, `enviarFotoLocal`
  necesita el primero.** `guardarReferenciaDiseno` solo devolvía `shotPath` (spread de
  `writeDesignRef`) — la copia PERMANENTE en `Personal/Referencias de Diseño/shots/`, fuera de
  `tmpdir()` y sin el prefijo `disref-`. `enviarFotoLocal` exige `disref-*` dentro de `tmpdir()`,
  así que el primer smoke test real falló al mandar la foto (Jano lo diagnosticó solo y avisó en
  vez de fallar en silencio). Fix: la tool ahora devuelve TAMBIÉN `screenshotPath` (el original en
  `tmpdir()`, `capture.screenshotPath`) — el system prompt usa explícitamente ese campo, nunca
  `shotPath`, para `enviarFotoLocal`.
- **Un screenshot fullPage trae toda la interfaz de la red social, no el diseño compartido.**
  Pedido de Cal viendo el resultado: para X/Instagram/Threads, `captureDesignScreenshot` ahora
  primero busca el `<img>` más grande de la página (filtro de 200px para descartar
  avatares/íconos, ignora `data:` URIs) y lo DESCARGA directo (sin recompresión de screenshot) en
  vez de sacar un screenshot de la página completa. Solo cae al screenshot fullPage si no
  encuentra ninguna imagen candidata (dashboards/webs renderizadas con CSS/canvas). La extensión
  del archivo resultante ya NO es siempre `.png` — puede ser `.jpg`/`.webp`/`.gif` según el CDN de
  origen; `design-refs.ts` la deriva del path real (`extname()`), y `enviarFotoLocal` se amplió
  para aceptar esos formatos SOLO para el prefijo `disref-` (los demás prefijos siguen `.png`-only).
- **`page.evaluate()` necesita tipos de DOM, pero NO se agregó `"DOM"` al `lib` del tsconfig.**
  Eso aplicaría a todo el paquete y podría chocar con los tipos de `fetch`/`Response`/`Headers` de
  Node ya usados en el resto del daemon. En cambio, `design-capture.ts` declara un `document`
  mínimo con `declare const` dentro del propio módulo — queda acotado a ese archivo (es un módulo
  con import/export, no un `.d.ts` global), sin tocar el resto del proyecto.

## Runtime del SDK — modelo, effort, turnos y sesión (2026-07-27)

Origen: Cal pidió *"toma los valores de los sábados, ¿a este ritmo cuándo llegamos a 5MM?"* y recibió
"⚠️ No pude procesar tu mensaje". El log mostró `agent_error: Reached maximum number of turns (12)` —
el turno quemó los 12 turnos en `ToolSearch` con nombre corto (falla; hay que usar el nombre COMPLETO
`mcp__cos-tools__X`), 6 llamadas a `notionCli` que fallaban con `400 invalid_json` (ver abajo) y una
query sin filtro que devolvió 352 KB. Auditando eso salió el resto.

- **`notionApi` doble-encodeaba el body — RESUELTO 2026-07-27 (commit `d0b9789`).** Era la causa real
  del `400 invalid_json`, y el fix quedó fuera de la primera tanda de cambios: `notionApi` hacía
  `JSON.stringify(body)` asumiendo que `body` siempre llega como objeto, pero el modelo lo manda como
  **string con JSON adentro** bastante seguido — y `JSON.stringify('{"a":1}')` produce
  `"{\"a\":1}"`, un string JSON donde Notion espera un objeto.
  - **Costó dos turnos reales de Cal el mismo día**, 14 llamadas fallidas entre ambos: el primero
    murió por agotar los turnos, el segundo respondió sin datos tras 233 s y $1.55.
  - **Se diagnostica pésimo desde afuera:** el error de Notion dice *"Error parsing JSON body"*, que
    se lee como "el conector está caído" — Jano de hecho le dijo eso a Cal y le ofreció reintentar
    más tarde, cosa que nunca hubiera funcionado. Y los `GET` andaban perfecto (no llevan body), así
    que token, permisos y conectividad daban verde. El modelo reintentó 14 veces variando el
    *contenido* del body y el endpoint, cuando el problema era la *serialización*.
  - **Fix:** `serializeBody()` en `tools/notion-cli.ts` — objeto → `stringify`; string que ya es JSON
    válido → pasa tal cual; string que no es JSON → `stringify` (ahí sí la intención era un literal).
    7 tests de regresión. Se reforzó además la descripción del tool ("body va como OBJETO, no como
    string") y se lo apunta a `consultarJson` para queries grandes.
  - **Verificado end-to-end** contra la Notion real llamando al `dist` compilado con el body string
    exacto que había mandado el modelo: devuelve filas.

- **SDK actualizado 0.2.122 → 0.3.220.** Estaba 98 versiones atrasado; los comentarios del 0.2.x
  todavía decían `'xhigh' — Opus 4.7 only`, o sea era pre-Opus 5. El upgrade exige
  `@anthropic-ai/sdk >= 0.93` como peer. Esa dependencia **no se importa en ningún `.ts` del repo**
  (verificado con grep), pero **no es huérfana**: en 0.3.x el agent SDK la movió a `peerDependencies`
  junto con `@modelcontextprotocol/sdk`, y sus tipos hacen `import type` desde ahí — sacarla rompería
  el typecheck. Las dos quedan declaradas explícitas en `daemon-v2/package.json`; antes
  `@modelcontextprotocol/sdk` solo existía porque npm la auto-instaló como peer, y un
  `--legacy-peer-deps` o una regeneración del lock habría roto el build.
  Los breaking changes documentados del SDK (`systemPrompt` ya no es default, `settingSources`) son
  de **v0.1.0** — Jano ya los tenía pasados y pasa `systemPrompt` explícito.
- **`maxTurns` 12 → 25** (`index.ts`). El techo existe para cortar loops, no para acotar trabajo
  legítimo; con 12, un pedido analítico real moría aunque fuera correcto.
- **`effort` (nuevo, `effort.ts`).** Antes sin setear. Default `high` (override con env `JANO_EFFORT`),
  y Cal sube a `xhigh` en un turno puntual con prefijo `/deep`, `/fondo` o `++`. **Prefijos explícitos
  a propósito** — una heurística que adivine "esto parece analítico" gastaría cuota de Claude Max
  (la MISMA de Cal) sin que él sepa por qué, y al fallar al revés dejaría los pedidos difíciles en
  effort bajo justo cuando importa.
- **Techo de 20 turnos por sesión** (`JANO_MAX_SESSION_TURNS`). `resume` reintroduce a propósito el
  crecimiento monotónico de contexto que "startup() fresco por mensaje" había eliminado — el modo de
  falla que tumbó a Jano **4 veces** ("Autocompact is thrashing"). El TTL de 12 h no es un techo: en un
  día activo entran decenas de turnos. Al tope, el chat arranca sesión nueva y vuelve al historial de
  KV: se pierde el detalle de tool calls viejas, no la conversación — o sea el peor caso es "como
  antes de este cambio", no peor. Monitorear `grep sdk_diagnostic_leak ~/Library/Logs/cos-agent-v2.out.log`
  los primeros días y ajustar el número si aparece.
- **`resume` por chat (`session-store.ts`) — cierra el gap de contexto de raíz.** El SDK ya venía
  persistiendo cada sesión COMPLETA (tool calls + resultados crudos) en
  `~/.claude/projects/<proj>/<sessionId>.jsonl` — 245 archivos había cuando se encontró — y Jano las
  tiraba: cada mensaje arrancaba de cero y reconstruía desde 40 mensajes de TEXTO en KV. Ese era
  exactamente el bug del PNR de BoA (2026-07-14, ver más arriba). Ahora el `sessionId` se guarda por
  chat en `~/.cos-agent/sessions.json` (IO **sync** a propósito: se lee en el camino crítico justo
  antes de `takeWarm()`, y un round-trip a KV comería el solapamiento que ese `takeWarm()` temprano
  existe para ganar) y se pasa como `resume`. Detalles que importan:
  - **TTL 12 h, igual que el historial en KV** — desincronizarlos daría el peor caso: sesión viva con
    historial vencido, o al revés.
  - **Si hubo resume, `runAgent` NO reinyecta el historial de texto de KV** (`deps.resumed`): el SDK ya
    lo tiene, y duplicarlo le daría al modelo dos versiones del pasado — la real y una resumida por
    Haiku que puede contradecirla. KV pasó de fuente primaria a **fallback**.
  - **Fallback si el resume falla** (`.jsonl` borrado, vacío o corrupto): `takeWarm` reintenta limpio
    y `onResumeFailed` borra el sessionId roto. **Verificado empíricamente** contra el SDK real: los
    tres casos tiran `Error: No conversation found with session ID: …`, así que el `catch` los cubre
    de verdad — no es una suposición. Sin eso, un resume roto dejaba el chat muerto hasta que a Cal
    se le ocurriera mandar `/reset`.
  - **`/deep` por voz funciona** (`ensureWarmEffort`): el prefijo viene dentro del audio, así que el
    effort se recalcula después de transcribir y el warm se rehace solo si cambió. Sin esto el dial
    se ignoraba en silencio en la mitad de los mensajes de Cal, que usa voz seguido.
  - **`/reset` ahora limpia KV *y* sessionId.** Limpiar solo KV lo dejaba sin efecto real: el turno
    siguiente retomaba la sesión y traía de vuelta todo lo que Cal quiso borrar.
- **Tool `consultarJson({path, jqExpr})`** (`tools/consultar-json.ts`) — corre `jq` sobre un
  persisted-output **sin traerlo al contexto**. Es la capacidad que faltaba: `readPersistedOutput`
  trae el archivo entero, que sobre un dump de Notion de 350 KB es el problema mismo que el
  persisted-output quería evitar. `system-prompt.ts` ahora instruye preferir `consultarJson` para
  datos estructurados y dejar `readPersistedOutput` para cuando de verdad se necesita todo el texto.
  - **Corre `execFile` ASÍNCRONO, nunca `spawnSync`.** `spawnSync` congela el proceso entero — y este
    daemon es uno solo: se frenarían el poll loop (todos los chats), los updates de progreso, el
    watchdog del webhook y los 4 crons proactivos. Hasta 10 s de parálisis global por una consulta.
  - **`realpathSync` ANTES de validar el path.** El regex de la allowlist acepta `..` en sus
    segmentos `[^/]+`, así que `~/.claude/projects/../../tool-results/toolu_x.json` pasaba el chequeo
    y apuntaba fuera del árbol. Resolver primero colapsa el `..` y además sigue symlinks. **La misma
    debilidad sigue en `read-persisted.ts`**, que tiene el regex idéntico — no se tocó en este
    cambio, pero está ahí.
  - **⚠️ Gotcha de seguridad, verificado en vivo: `jq` expone el entorno del proceso** vía `env` y
    `$ENV` (`FOO=secreto jq -n 'env.FOO'` devuelve `"secreto"`). El daemon corre con `NOTION_TOKEN`,
    `COS_TELEGRAM_BOT_TOKEN` y todo `apps.env` cargado, así que el spawn va con
    `env: { PATH: "/usr/bin:/bin" }`. Sin eso, una expresión con `env` — escrita por error por el
    modelo o inducida por prompt injection en contenido web que Jano haya leído — volcaría todos los
    secretos de Cal al contexto y de ahí a Telegram. Hay tests de regresión para `env` y `$ENV`.
  - **`maxBuffer` 64 MB:** `spawnSync` corta en 1 MB por default y devuelve `ENOBUFS`. Lo encontró un
    test, no la revisión — sin esto, cualquier consulta amplia fallaba con error críptico en vez de
    truncar. El truncado real lo hace `MAX_OUTPUT_CHARS` (20 K), que sí es explícito.
  - NO es un `Bash` general: `Bash` sigue en `DISALLOWED_BUILTINS`. Es un binario fijo, sin shell,
    con allowlist de paths (la misma de `read-persisted.ts`).

**El upgrade del SDK desbloqueó 5× de contexto (confirmado con prueba de humo real).** Con 0.2.122 el
log reportaba `contextWindow: 200000` en cada turno; con 0.3.220, una query mínima contra el mismo
`claude-sonnet-5` reporta **`contextWindow: 1000000`** y `maxOutputTokens: 64000`. O sea el techo de
200K no era un límite del modelo ni del harness: eran las tablas de modelos desactualizadas del SDK
0.2.x (esa rama es anterior a Opus 5 / Sonnet 5 — sus propios comentarios todavía decían
`'xhigh' — Opus 4.7 only`). No hizo falta ningún flag beta: `context-1m-2025-08-07` sigue existiendo
en los tipos pero está documentado como "Sonnet 4/4.5 only" y NO se usa.
La misma prueba confirmó que 0.3.220 arranca bien con OAuth Max y acepta `effort`.

## Notion
- Integración "Claude CoS" (DB Tareas + People). Prefijo MCP: `mcp__claude_ai_Notion__*`.
- **Ese MCP es SOLO del daemon.** En sesión interactiva de Claude Code no existe — usar el CLI `ntn` (skill `notion-ntn`) para cualquier query/escritura a Notion sobre este repo (ej. sync de docs a la DB "Agentes AI").
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
- `scheduleResumirPlaylist()` — **DESACTIVADO 2026-07-14** (pedido de Cal). Estuvo activo desde 2026-06-20 (opt-in). 1×/día revisaba la playlist YouTube "Para resumir" + starred de Feedbin, encolaba y proponía de a uno con checkpoint. Los botones ⭐/🎬 del menú siguen funcionando on-demand igual (no dependen del cron).
- `scheduleFlightCheckin()` — **DESACTIVADO 2026-06-17** (check-ins de vuelos, every 30min 7-22h).
- `scheduleFocoCheckinsLocal()` — **DESACTIVADO 2026-06-17** (Foco CAL am/md/pm, `proactive/foco-check.ts`).
- `scheduleHealthSyncCheck()` — **ACTIVO 2026-07-16** (pedido de Cal, ver gotcha "Detección de cortes de sync de Apple Health" arriba). Cron `0,30 7-22 * * *`, mecánico (sin LLM/`takeWarm`) — chequea `GET /status` del health-worker y avisa por Telegram si `hoursSinceLastIngest >= 4h`, con dedup en CF KV (TTL 24h) para no repetir el aviso mientras dure el mismo corte.
- **`scheduleKpiCardDaily()` — ELIMINADO 2026-07-24** (cron fijo `0 10 * * *`, pedido de Cal). La tarjeta PNG (TRX + Activos DAU + % vs. semana anterior, `@napi-rs/canvas`, `enviarFotoLocal`) ya NO espera un horario fijo — se dispara sola desde el pipeline PDF de `scheduleKpiIngestCheck()` (ver abajo) apenas ese mail se procesa con éxito, porque los 4 campos que la tarjeta muestra son 100% del PDF (el CSV no le aporta nada). Idempotente por fecha vía `state.cardSent` en `kpi-ingest-state.json`; un fallo en la tarjeta no rompe el resto de la ingesta (try/catch propio) ni deja de marcar el mail como procesado. Sigue disponible **on-demand** sin cambios vía el tool `generarKpiCardYape` (chat con Jano) — la función `checkKpiCardDaily()` (`kpi-card-daily.ts`) no se tocó, solo cambió QUIÉN la llama y CUÁNDO.
  - **Bug visual, encontrado por Cal viendo la tarjeta real (2026-07-24): esquinas negras en vez de blancas.** `renderKpiCardImage()` (`kpi-card-image.ts`) crea el canvas (transparente por default) y solo pintaba blanco DENTRO del `roundRect()` (`ctx.fill()`) — los 4 triángulos de esquina que quedan AFUERA de la curva redondeada nunca se tocaban, quedaban transparentes, y Telegram los mostraba como negro sólido. **Fix:** `ctx.fillRect(0, 0, card.size, card.size)` con el mismo blanco ANTES de trazar el `roundRect` — pinta el canvas entero primero; el `roundRect` de abajo queda solo como borde decorativo (`stroke()`, ya no `fill()`). Test de regresión con `getImageData(0,0,1,1)` verificando que el píxel de esquina sea opaco y blanco (antes: alpha=0) — confirmado que reproduce el bug con el código viejo antes de aplicar el fix.
- `scheduleJournalSweep()` — **ACTIVO 2026-07-27** (pedido de Cal, ver sección "Journal de reflexión" abajo). Cron `0 19 * * 0` (domingos 19:00 La Paz) — junta las entradas `Sin revisar` de los últimos 7 días de la DB Journal y manda un selector para destilarlas a Resonate Calendar. Dedup en CF KV (TTL 7 días). Es la **tercera excepción** a la arquitectura reactiva decidida el 2026-07-14.
- `scheduleKpiIngestCheck()` — **ACTIVO 2026-07-23** (implementado 2026-07-22, credenciales conectadas y cron corriendo desde 2026-07-23; ampliado el mismo día a doble pipeline — pedido de Cal, ver `docs/superpowers/specs/2026-07-22-kpi-ingest-email-notion-design.md`). Cron `*/15 6-23 * * *`, mecánico (sin agente SDK) — detecta los mails diarios de BCP, espera 15 min desde que llegan, hace upsert de los KPIs raw por Fecha en "KPIs diarios" y completa los derivados que falten en todo el histórico. Si las credenciales no están configuradas, el cron queda sin registrar al arrancar (no rompe el daemon). No vive en Yapito — el trigger es el Gmail personal de Cal, que solo Jano tiene conectado.
  - **Credenciales Gmail — el plan original del spec (`gcloud auth application-default login` con scope `gmail.readonly`) no funcionó:** Google bloquea al cliente OAuth propio de `gcloud` para scopes sensibles como Gmail en apps no verificadas ("This app is blocked"). **Fix real:** reusar cross-project el OAuth que ya existe para el Ulanzi (`gmail-update.sh`, proyecto Google Cloud `jano-youtube`, ver [[reference_youtube_oauth_playlist]]) — `index.ts` lee `GMAIL_OAUTH_CLIENT_ID`/`GMAIL_OAUTH_CLIENT_SECRET` desde `YOUTUBE_OAUTH_CLIENT_ID`/`YOUTUBE_OAUTH_CLIENT_SECRET` y `GMAIL_OAUTH_REFRESH_TOKEN` desde `GMAIL_OAUTH_REFRESH_TOKEN_LEPESQUEUR`, todas ya en `~/.claude/secrets/apps.env` (cargado como fallback por todo daemon, ver `Personal/Agents/CLAUDE.md`). **No duplicar estas credenciales en `~/.cos-agent/.env`** — son un recurso cross-project, un solo origen en `apps.env`.
  - **Bug real, resuelto el mismo día del primer run (2026-07-23):** el primer arranque encontró 4 mails atrasados (backlog desde que se implementó el cron sin credenciales) y los procesó en cadena — esperado, no se repite (de acá en más 1 mail/día). Pero el reporte del 4to mail (~6600 caracteres) nunca llegó a Telegram: `sendReport()` truncaba el texto a lo bruto con `.slice(0, 4076)` cuando superaba 4096 chars, y el corte cayó a mitad de la etiqueta `<b>Derivados:</b>` — Telegram rechazó el mensaje entero por HTML mal formado (`can't parse entities`). Los datos SÍ se habían escrito bien en Notion, solo faltó la confirmación. **Fix (siguiendo la sección "Paginación de mensajes >4096 chars" del skill `telegram-bot-ux`):** `sendReport()` ahora usa `paginateReport()` — corta en el último `\n\n`/`\n`/espacio antes del límite (nunca a mitad de una etiqueta, porque los tags `<b>...</b>` del reporte siempre viven dentro de una sola línea) y manda los chunks resultantes como mensajes secuenciales en vez de truncar y perder información. Aplica el mismo patrón a cualquier otro reporte de texto largo por cron (`health-sync-check.ts`, `kpi-card-daily.ts`) si algún día crece más allá de 4096 chars — hoy no les pasa, pero el riesgo es el mismo.
  - **Ampliado a doble pipeline (2026-07-23) — replica el agente de Notion AI que hacía esto antes a mano.** Cal encontró que la Fecha de "Seguimiento Diario Yape Bolivia" (PDF de BCP, subject exacto, `has:attachment`) llega CASI al mismo segundo que el "Self-Service" (CSV) para la misma fecha — son dos formatos del mismo reporte diario, no fuentes independientes. Antes de este cambio existía un agente nativo de Notion (AI Agent, `app.notion.com/agent/...`, NO expuesto por la API pública) que procesaba solo el PDF, con lógica de detección de fallo y archivado — se replicó su comportamiento en vez de descartarlo. Reparto de campos para que las dos fuentes nunca se pisen:
    - **PDF-only (autoritativo):** `Afiliaciones diarias`, `TRX`, `Activos DAU` (el CSV YA NO los escribe — `PDF_OWNED_RAW_PROPS` en `kpi-ingest-check.ts`), más `Afiliados 7d` (antes solo calculado, ahora directo del PDF — `fillDerivedFields()` sigue de fallback si el PDF no llegó), `TRX Promedio 7d` (propiedad que ya existía en la DB pero nunca se llenaba), y las 6 `vs. Ayer (%)`/`vs. Sem. anterior (%)` de Afiliaciones/TRX/DAU (propiedades ya existentes, antes fuera de scope del cron — el PDF las trae directas, sin esperar el cálculo D/D-7).
    - **CSV-only:** todo lo demás (`Activos 30d`, `Stock Afiliados`, `Saldo`, `Remesas (cantidad/USD)`, `Activos 30d %`, `Activos DAU %`, `DAU Promedio 7d`, `Ingresos Recaudacion/Recargas/PDS`) — el PDF no los reporta.
    - **Parser del PDF (`kpi-ingest-pdf.ts`):** `pdf-parse` (mismo patrón `createRequire`+`PDFParse` que `schedule-cal.ts`/`index.ts`) extrae texto plano; `extractPdfKpis()` busca líneas EXACTAS ("Afiliaciones diarias", "TRX", "Activos DAU", "Afiliados 7d", "TRX Promedio 7d" — nunca por prefijo, para no confundir con las etiquetas de los gráficos tipo "Afiliaciones diarias\tAfiliaciones (Prom. 7d)") y lee el valor + las 2 líneas "vs. Día anterior"/"vs. Sem." dentro de un lookahead corto. **Gotcha real encontrado en un PDF real:** el bloque de "Afiliados 7d" trae un typo de Yape ("vs. Sem. **anteior**", sin r) — el match es por prefijo `vs. Sem.` para no depender de la ortografía exacta.
    - **Fecha del reporte:** del FILENAME del adjunto (`"Seguimiento Diario Yape | DD/MM/YYYY.PDF"`, `parseReportDateFromFilename()`) — más confiable que el Subject o el `internalDate` de recepción.
    - **Reporte fallido ("updated fail"):** `isFailedReport()` — regex case-insensitive sobre el texto completo (sin verificar todavía contra un PDF real fallido, solo contra el flujo documentado del agente de Notion — si el patrón no dispara con un caso real, ajustar). Si dispara: NO se tocan los 3 campos raw ni los derivados de esa fecha, se escribe la propiedad **Notas** (rich_text) con `PDF_FAIL_NOTE` (`markPdfReportFailed()`, conserva cualquier nota manual previa concatenando), NO se archiva el mail, y el reporte a Telegram lo dice explícito. Un reintento posterior no-fallido limpia la nota (`clearPdfFailNote()`, solo remueve el texto de la marca, conserva el resto).
    - **Archivado + marcar leído (`archiveAndMarkRead()`, requiere scope `gmail.modify`):** decisión de Cal, replica al agente viejo. El refresh token compartido (`GMAIL_OAUTH_REFRESH_TOKEN_LEPESQUEUR`) hoy solo tiene `gmail.readonly` — **pendiente que Cal regenere ese token con `gmail.modify` vía el flujo OAuth loopback** (mismo patrón que `reference_youtube_oauth_playlist` / el `gmail-update.sh` original: Cal autoriza en el navegador). Hasta entonces `archiveAndMarkRead()` falla con 403 — capturado y logueado (`kpi_ingest_archive_failed`), no rompe el resto del flujo (el KPI igual se escribe y se reporta). El nuevo token con scope ampliado reemplaza al actual en `apps.env` (mismo criterio cross-project — Ulanzi sigue andando igual, `gmail.modify` incluye lectura).
    - **Las dos búsquedas (CSV y PDF) corren en el mismo tick, cada una con su propio estado pending/processed compartiendo el mismo `kpi-ingest-state.json`** (los IDs de mensaje son únicos en todo el buzón, sin colisión entre los dos subjects) — `pollAndProcess()` genérico parametrizado por `searchFn`/`processFn`. No hay pairing/merge por fecha: cada pipeline procesa y reporta de forma independiente: Cal recibe 2 mensajes de Telegram por día (uno por fuente), nunca 1 fusionado — más simple y sin ventana de carrera por asincronía de llegada.
  - **UX del reporte, iterado con Cal el mismo día (2026-07-24, aplicando el skill `telegram-bot-ux`):**
    - Header separa la fuente con `·` en vez de paréntesis; con 2+ fechas en un mismo tick de CSV se antepone el conteo — antes una corrida de 20 fechas era pura pared de texto sin ningún resumen arriba. **Reemplazado el 2026-07-29 por el rediseño de abajo** (el conteo se fundió en la línea de resumen).
    - **Tercer caso de ruido — el reporte del CSV entero, rediseñado el 2026-07-29 a pedido de Cal ("es demasiado ruido"):** los dos fixes anteriores atacaron la sección "Derivados", pero el bloque **Ingesta** era el problema grande y estaba mal diagnosticado. El comentario original hablaba de "catch-up", como si varias fechas en un tick fueran la excepción: **no lo son**. El CSV del Self-Service trae el **mes-a-la-fecha completo todos los días** (verificado en `kpi_ingest_full_report`: los últimos 5 reportes arrancaban todos en `2026-07-01`), así que la corrida NORMAL desglosaba ~27 fechas, cada una repitiendo los MISMOS 9 nombres de campo. La pared crecía un renglón por jornada y a fin de mes tocaba `MAX_REPORT_LINES` y se truncaba sola. Nada de eso era accionable: el mensaje contestaba "¿qué hizo el robot?" en vez de "¿algo necesita tu atención?". **Fix:** `formatSuccessReport()` recibe ahora `CsvIngestRow[]` (structured) en vez de strings ya formateados, y colapsa el caso normal a **dos líneas** (`✅ KPIs diarios · Self-Service` + `📅 {última fecha} · {N} fechas · {M} campos`). El desglose por fecha SOLO aparece bajo `⚠️ Revisar:` y solo para lo que se sale de la norma: fecha `created` (registro nuevo), `fieldsWritten` vacío, un conteo de campos distinto al **modal** de la corrida (`modalFieldCount()` — así se detecta una columna que dejó de venir), columnas ilegibles o no mapeadas. El detalle completo sigue yendo al log estructurado `kpi_ingest_full_report` (ahora con `ingestRows` en vez de `ingestSummary` — ojo si tenés greps viejos sobre ese campo).
    - **`Derivados: • nada pendiente` se dejó de imprimir** (mismo cambio, aplicado a los reportes de CSV **y** de PDF): una línea fija que aparecía en cada corrida y nunca comunicó nada. La sección entera se omite cuando no hay completados ni huecos recientes. El principio detrás de los tres casos es el mismo: **reportar la excepción, no la confirmación** — si algo se imprime siempre, no es información.
    - El reporte del PDF (`formatPdfSuccessReport`) muestra los VALORES reales (no solo qué campos se tocaron), con separador de miles, y la tendencia día/semana que ya trae el propio PDF (`▲ +0.4% día · ▼ -10.3% sem.`) — emojis de categoría documentados en el lexicon del skill: 👥 afiliaciones, 🔁 TRX, 📊 DAU. El CSV se dejó sin esto (sus 9 campos son heterogéneos — dinero, actividad, personas — forzar un solo emoji no comunica nada real).
    - **Bug de ruido real, encontrado por Cal viendo el reporte en vivo:** la sección "Derivados" listaba TODOS los "no calculables" de fillDerivedFields() en CADA corrida — incluidas ~25-49 fechas de enero 2026 que son permanentemente no-calculables (no existe D-7 porque ahí arranca el histórico) y NUNCA van a cambiar. Resultado: el mismo bloque de 40+ líneas repetido idéntico en todos y cada uno de los reportes, para siempre. **Fix:** `formatDerivedLines()` ahora filtra los "no calculables" a los de los últimos 30 días (`isRecentFecha()`, sobre `Date.now()`) — solo lo reciente es accionable (indicaría un hueco real que vale revisar); lo viejo se sigue viendo completo en el log estructurado (`kpi_ingest_(pdf_)?full_report`), solo se sacó del mensaje de Telegram. Los "completados" (valores nuevos rellenados) no se filtran — son intrínsecamente raros y siempre informativos.
    - **Segundo caso de ruido, mismo día, encontrado corriendo el fix anterior con datos reales:** después del filtro de 30 días seguían quedando ~4 líneas — "Afiliaciones vs. Sem. anterior (%) → no calculable (falta afiliacionesDiarias el {domingo})". Causa: `applySundayRule` pone "Afiliaciones diarias" en `null` TODOS los domingos (restricción SEGIP) — así que ese derivado nunca se puede calcular ningún domingo, para siempre, y con el filtro de recencia esos domingos siempre están "dentro de la ventana", rotando semana a semana. Mismo patrón que el bug de enero (permanente, no accionable), solo que recurrente en vez de histórico. **Fix:** `isPermanentSundayGap()` filtra ese caso puntual (domingo + motivo `"falta afiliacionesDiarias el ..."`) además del filtro de recencia.
    - **Arquitectura de recálculo, pedido por Cal el mismo día:** `fillDerivedFields()` ya no recorre TODO el histórico buscando huecos en cada tick — solo evalúa/escribe sobre las fechas recién tocadas por ESE mail (`onlyFechas`, 2do parámetro; `CSV` pasa todas las fechas del batch, `PDF` pasa `[fecha]`). El fetch de historial completo se sigue haciendo igual (hace falta como contexto para el cálculo D-7), pero el loop externo y el reporte quedan acotados. Sin `onlyFechas` (parámetro omitido) sigue haciendo el reproceso completo de siempre — es el modo "recalcular todo", disponible para cuando Cal lo pida.
    - **Reproceso manual, dos vías:** (1) **por acá** (sesión interactiva de Claude Code) — llamar `fillDerivedFields(notionToken)` sin `onlyFechas` directo desde un script `tsx`/`node`, igual que se hizo para inspeccionar durante el desarrollo. (2) **por Jano** (chat) — tool nuevo `mcp__cos-tools__reprocesarKpisDerivadosYape({ fechas? })` (`agent-tools.ts`, guía de uso en `system-prompt.ts` sección "Reprocesar KPIs derivados de Yape") — Cal le pide a Jano "reprocesa los KPIs derivados" (todo el histórico) o "reprocesa el 15 de julio" (fecha puntual) y el LLM llama la tool. Auto-allowlisteada vía el mapeo `sdkTools.map(t => mcp__cos-tools__${t.name})` en `index.ts` — no hace falta tocar `agent-options.ts` para tools nuevos de `cos-tools`.

  - **Ampliado a TRIPLE pipeline (2026-07-27) — 3er dominio, DB Notion separada.** Cal reenvió el primer "Reporte diario Créditos Yape Lending - Riesgos" (Milton Silva, Risk Specialist Yape, `msilva@bcp.com.bo`, reenviado vía `CLepesqueur@bcp.com.bo` — mismo patrón de origen que los otros 2). Dashboard Power BI del "Funnel Piloto Yape Lending" (créditos): 15 nodos ACUMULADOS desde el arranque del piloto (Leads→Vistos→Me Interesa→Contactado→Derivados→Agencia→Desembolso, con sus ramas negativas) — dominio de negocio distinto (Riesgos, no afiliación/TRX/DAU), así que va a una DB Notion **separada** ("KPIs Yape Lending", `KPI_LENDING_DB_ID = 3aac4876-09dd-8164-8905-e287a7b16f40`, bajo el mismo parent page que "KPIs diarios") — no se mezcló en la DB existente.
    - **Archivos:** `kpi-ingest-lending-pdf.ts` (parser) + `kpi-lending-notion.ts` (upsert/derivados) nuevos; `kpi-ingest-gmail.ts` ganó `searchLendingReportEmails()` + `extractPlainTextBody()` (nuevo, genérico — DFS sobre `payload.parts`, `GmailMessageDetail.bodyText` opcional para no romper CSV/PDF); `kpi-ingest-check.ts` ganó `processLendingMessage()` como una 3ra llamada a `pollAndProcess()` dentro de `checkKpiIngest()`, reusando el mismo `kpi-ingest-state.json` (IDs de Gmail únicos, sin colisión). `index.ts` sin cambios — mismo cron `*/15 6-23 * * *`, mismas env vars (reusa `NOTION_TOKEN` + `GMAIL_OAUTH_*`).
    - **Fecha del reporte viene del CUERPO del mail, no del filename** (`parseReportDateFromBody()`, regex sobre "cierre de la jornada de YYYY-MM-DD") — a diferencia del PDF de Seguimiento Diario, `LENDING.pdf` no trae fecha en el nombre. Si no matchea → `throw` SIN marcar `processed` (reintenta hasta 3 días, ventana de `newer_than:3d` de la query) — **gap conocido, no resuelto:** si nunca se encuentra la fecha, el mail sale de la ventana de búsqueda al día 4 y queda huérfano en `state.pending` para siempre, sin ningún aviso final de "abandono" (Cal solo deja de recibir el error dedupeado, puede leerse como que se resolvió solo). Mismo patrón preexistente en `processPdfMessage` (fecha no determinable por filename) — no es nuevo de Lending, decisión pendiente si vale la pena un aviso explícito de abandono en los 3 pipelines.
    - **Gotcha real del PDF, encontrado con los 4 primeros reportes reales:** `pdf-parse` a veces pega el porcentaje del bloque anterior justo antes de la label siguiente SIN salto de línea real (`"27,1 %NO DERIVADOS"` en una sola línea, visto en 3 de 4 PDFs) — el matcher de labels acepta esto vía `matchLabelSuffix()` (label al final de la línea con un residuo puramente numérico/% antes; residuos con letras, como en "NO VISTOS" vs. label "VISTOS", se rechazan). También "SIN INTERACCIÓN" apareció sin tilde en uno de los 4 reportes reales — normalización NFD de diacríticos antes de comparar.
    - **"EN PROCESO" aparece 2 veces** (una rama Derivados→Agencia, otra Agencia→Desembolso) — se resuelve por **ancla de contexto** (última label simple vista antes: `DESEMBOLSO`→rama Agencia, `DERIVADOS`→rama pre-Agencia), no por orden ordinal. Robusto si Power BI reordena SECCIONES completas; asume que el orden interno Agencia-antes-de-Desembolso se mantiene (confirmado en los 4 reportes reales) — si algún día cambia, falla explícito ("sin ancla reconocible"), nunca asigna a la rama equivocada en silencio.
    - **Validación de integridad 100% aritmética, no por %:** los porcentajes del PDF no se parsean (posición inconsistente entre bloques). `reconcileLendingFunnel()` — 6 igualdades que cubren los 15 campos — verificadas contra los 4 días reales (cierran exacto) y contra un test que corrompe cada uno de los 15 campos +1 uno por uno confirmando que las 6 ecuaciones lo detectan. Si no reconcilia: `markLendingReportFailed(fecha, detalle)` (nota variable en `Notas`, a diferencia del `PDF_FAIL_NOTE` fijo del pipeline de Seguimiento Diario — el motivo de fallo acá es distinto cada vez) + aviso Telegram + sí marca processed (reintentar el mismo mail no cambia su contenido).
    - **Derivados:** `Incremento Desembolso (D-1)` / `Incremento Derivados (D-1)` — resta simple contra el registro de exactamente un día antes (`isoDaysBefore(fecha,1)` + `rows.find`, nunca `rows[index-1]` para no asumir contigüidad) — a diferencia de los `vs. Sem. anterior (%)` de "KPIs diarios", que son %. Sin D-1 real (primer registro del histórico, o hueco de reporte — ej. 2026-07-24/25 no se generaron) → no calculable, explícito.
    - **Backfill inicial (2026-07-27):** 4 correos reenviados por Cal (cierres 21/22/23/26 jul, falta el 24 — no se generó reporte ese día) cargados a mano vía `scripts/verify-lending-parse.ts FECHA=RUTA.pdf [--write]` (parsea, muestra los 15 campos + reconciliación, y con `--write` hace upsert real) — confirmado en Notion que coinciden con los números verificados a mano contra el dashboard antes de activar el cron.
    - **Reviewed por `daemon-health-reviewer`:** sin bloqueantes. 2 warnings (el gap de abandono silencioso de arriba, y que la ancla de "EN PROCESO" asume orden fijo Agencia-antes-de-Desembolso) — ambos aceptados como riesgo de diseño (fallar explícito > adivinar), no bloquean build/restart.
    - **Tarjeta PNG (2026-07-27), mismo patrón que la de KPIs diarios.** `kpi-card-lending-image.ts` (render, tokens duplicados de `kpi-card-image.ts`) + `kpi-card-lending-daily.ts` (fetch de la fila más reciente/por fecha + envío) — 3 columnas en orden de funnel (Vistos → Derivados Agencia → Desembolsos), incremento vs. **día anterior** como resta simple (no %, a diferencia de la tarjeta de TRX/DAU que muestra %WoW). Se agregó `Incremento Vistos (D-1)` a la DB (mismo patrón D-1 que Desembolso/Derivados) y se backfilleó para los 4 registros existentes. Se dispara sola desde `processLendingMessage()` apenas ingesta con éxito (dedup propio `state.lendingCardSent`, independiente de `state.cardSent` de la tarjeta de KPIs diarios — mismo patrón, arrays separados por dominio). On-demand: tool `mcp__cos-tools__generarKpiCardLending({ fechas? })` (`system-prompt.ts` sección "Tarjeta de KPIs de Yape Lending").
    - **Ancho de columna más angosto que la tarjeta de KPIs diarios** (`valueMaxPx`/`valueMinPx` bajados de 190/110 a 160/70) — 3 columnas en vez de 2, y "Vistos" puede llegar a 6 cifras con separador de miles ("12,129"), mucho más ancho que "85"/"435" — sin bajar el piso de fuente, ese valor desbordaría la columna.
    - **Renombre (2026-07-27, pedido de Cal):** "Vistos"/"No Vistos" → **"Ofertas Vistas"/"Ofertas No Vistas"** en la DB Notion (rename de propiedad vía `ntn api PATCH /v1/databases/{id}` con `{"properties":{"Vistos":{"name":"Ofertas Vistas"}}}` — preserva el `id` de la propiedad y los datos existentes, no es un borrado+alta), en la card, y en el reporte de Telegram; `Incremento Vistos (D-1)` → `Incremento Ofertas Vistas (D-1)`. El heading de la card pasó de "Funnel Lending · Riesgos" a **"Funnel Piloto Lending Híbrido"**. Los identificadores internos en TS (`vistos`, `noVistos`, `incrementoVistos` en `LendingFunnelFields`/`LendingHistoryRow`) NO se tocaron — solo cambiaron los strings de propiedad Notion y los textos visibles (card/Telegram); es deliberado, evita un refactor grande sin beneficio (el nombre interno no es user-facing).
    - **Card rediseñada a 4 columnas (2026-08-05), delta D-1 estricto en vez de "último dato
      disponible":** pedido de Cal — `Derivados Agencia → Agencia → En Proceso (Agencia) →
      Desembolso` (sacó `Ofertas Vistas`). 2 propiedades Notion nuevas (`Incremento Agencia (D-1)`,
      `Incremento En Proceso (Agencia) (D-1)`), mismo patrón D-1 estricto que las 3 existentes.
      `kpi-card-lending-daily.ts` dejó de recalcular su propio delta "contra el último dato
      disponible" (diseño original, documentado arriba) — ahora solo EXPONE los `Incremento X (D-1)`
      ya calculados en Notion; sin D-1 real el delta sale en blanco (antes toleraba huecos de
      reporte comparando contra el registro previo más reciente).
    - **Bug real encontrado el mismo día — derivados D-1 quedaban stale tras un reenvío del
      reporte con números corregidos:** `fillLendingDerivedFields()` saltaba cualquier
      `Incremento X (D-1)` que ya tuviera valor, pero el CRUDO del que depende sí cambia en un
      reenvío (`upsertLendingRow` lo pisa sin condición). Visto en vivo: 2 mails de Lending para el
      4/ago, el 2do corrigió `Desembolso` 133→147 pero el incremento quedó pegado en 0 en vez de 14.
      **Fix:** con `onlyFechas` (ingesta puntual o reproceso explícito vía
      `reprocesarKpisDerivadosYape`) ahora FUERZA el recálculo aunque ya exista un valor; sin
      `onlyFechas` (modo "reprocesar todo el histórico") sigue sin tocar lo ya calculado, para no
      barrer toda la DB en cada tick del cron. **Mismo patrón `getExisting != null → skip` existe
      en `fillDerivedFields()` de `kpi-ingest-notion.ts` (KPIs diarios) — no auditado todavía,
      podría tener el mismo bug latente si algún día se resuelve reenviar el CSV/PDF corregido.**

  - **Reconciliación como fallback de un campo ilegible (2026-07-28) — no solo validación, también reparación acotada.** El 2026-07-27 falló el reporte (`kpi_ingest_lending_parse_failed`, "noContactado: no pude leer el valor tras la label"): Power BI renderizó "NO CONTACTADO" abreviado como `"1K"` en vez del número completo ("1.179") — probablemente por ancho de tarjeta ese día, no una regresión del parser (los otros 14 campos parsearon normal). Como el resto del funnel ya reconciliaba, el valor era deducible sin ambigüedad: `Contactado(1.179)+NoContactado=MeInteresa(2.358)` → 1.179. **Fix:** `deriveMissingField()` en `kpi-ingest-lending-pdf.ts` — si falta EXACTAMENTE UN campo de los 15 y aparece en alguna de las 6 ecuaciones de `FUNNEL_EQUATIONS` (refactorizadas de 6 llamadas `checkSum()` inline a una tabla compartida entre `reconcileLendingFunnel()` y esta función) con todos los demás términos ya conocidos, lo completa por aritmética simple; nunca si faltan 2+, nunca si el resultado da negativo. `parseAndValidateLendingReport()` lo intenta ANTES de rechazar el reporte, y siempre re-verifica con `reconcileLendingFunnel()` que el valor derivado cierre — nunca confía ciegamente en la resta. Se loguea explícito como `kpi_ingest_lending_field_derived` (campo, valor, ecuación) para que quede claro que ese número vino de reconciliación, no de una lectura literal del PDF. Backfill puntual del 2026-07-27 hecho a mano (mismo camino que `upsertLendingRow`/`clearLendingFailNote`/`fillLendingDerivedFields`) — confirmado en Notion (`No Contactado: 1179`, sin nota de fallo). Reviewed por `daemon-health-reviewer`: sin bloqueantes.

### Cron de Tareas por mail — `scheduleTaskEmailCheck()` (2026-07-28)

Mails que Cal reenvía a mano con **"(Tarea)"** en el asunto (de `clepesqueur@bcp.com.bo` a `carlos@lepesqueur.net`) → tarea nueva en la DB Notion **"Tareas"** (`1f2c487609dd802985dcd7ad59110ddd`). Mismas credenciales Gmail cross-project que KPI/DN, mismo cron `*/15 6-23 * * *` La Paz. Spec original: página Notion "Cron para Tareas en Notion" (pedida por Cal, instrucciones del "agente de Notion" que hacía esto antes a mano — mismo patrón que el triple pipeline de KPIs, que también replica un agente nativo de Notion no expuesto por la API).

- **Archivos:** `task-extract.ts` (síntesis del cuerpo del mail vía LLM — único paso de este pipeline que NO es 100% mecánico, a diferencia de KPI/DN/Lending), `task-notion.ts` (escritura a Notion), `task-check.ts` (cola + propuesta + creación, state en `~/.cos-agent/task-check-state.json`), `task-card.ts` (render puro de las tarjetas), `task-callbacks.ts` (botones `tsk:*` + texto libre), `task-store.ts` (propuestas en CF KV), `task-people.ts` (snapshot de People), `task-dates.ts` (atajos y parser de fechas), `task-types.ts`.
- **`task-extract.ts` — Sonnet (`claude-sonnet-5`), `maxTurns:1`, sin tools, mismo patrón que `journal-enrich.ts`.** Pasó de Haiku a Sonnet el 2026-07-28 a pedido de Cal: son hilos de trabajo reenviados, con contexto implícito y varios interlocutores, y la síntesis se paga UNA vez por mail. Convierte el cuerpo en `{resumen, accionRequerida, contextoRelevante, deadline, fecha, sinAccionClara}`. Reglas explícitas de "no inventar" (ni fechas, ni contexto, ni responsables) — resuelve fechas relativas ("para el viernes") contra la fecha de recepción real. Si la llamada falla o el JSON no parsea, el caller NO pierde el mail: propone igual, marcado `sinAccionClara:true`, con el cuerpo crudo como resumen.

#### Tarjeta de confirmación + cola (2026-07-28, rediseño pedido por Cal)

El cron ya **no crea la tarea directo**: propone una tarjeta en Telegram y la página de Notion nace recién al tocar `✅ Crear tarea` (patrón `propose → botones` de Pecunia). Cal ajusta ahí mismo **asignado, Fecha y Deadline**.

- **Una tarjeta activa por vez.** Los mails detectados van a una cola FIFO (`state.queue`) y se proponen de a uno; `state.active` marca cuál está en pantalla. Cada tarjeta muestra `📥 Quedan N en la cola`. Al resolver (`✅`/`❌`) la siguiente llega como **mensaje nuevo** — un edit no genera push, y el punto es que Cal se entere.
- **La cola guarda solo `{messageId, threadId, subject, followupIds}`.** El cuerpo, los adjuntos y la llamada a Sonnet se resuelven cuando el ítem llega al frente (`promoteNext`): un tick con 5 mails no dispara 5 llamadas al modelo de golpe, y ningún cuerpo de correo queda escrito en disco.
- **`processed` se marca al ENCOLAR** (para no re-encolar cada 15 min) pero **el mail NO se archiva hasta crear la tarea** — la inbox es el respaldo si Cal nunca toca la tarjeta. Ese es el costo aceptado de "crear al confirmar": una propuesta ignorada 7 días (TTL del KV) es una tarea que no nace. `ensureActiveProposal()` detecta la propuesta vencida, libera el turno y sigue con la cola: **nunca queda trabada**.
- **`⏭️ Después`** manda la propuesta al final de la cola y descarta su payload en KV — cuando vuelva a tocarle turno se re-sintetiza, así refleja el mail tal como está en ese momento. El botón solo aparece si hay algo detrás.
- **Snapshot estático de People (`task-people.ts`), decisión explícita de Cal:** top 20 por uso real en "Asignado a" (sobre 763 tareas: CAL 525, Lorena 33, Matias 30, Dieter 27…). El picker renderiza **sin tocar Notion** — la DB People tiene 639 filas. Se pagina de a 6 (`⏭️ Más` cicla a la primera página). El escape `✍️ Otro` resuelve primero contra el snapshot y **solo si el nombre no está entre los 20** consulta Notion (`findPersonInNotion`, filtro sobre la propiedad title **`Name`** — no "Nombre", verificado contra el schema real). Con 0 o 2+ coincidencias **repregunta**: nunca asigna a quien no era. Regenerar con `npx tsx scripts/refresh-task-people.ts [--write]`.
- **Atajos de fecha = viernes** (`task-dates.ts`, puro y testeado): `📅 Hoy` · `📅 Vie {esta semana}` · `📅 Vie {próxima}` · `🚫 Sin fecha` · `✍️ Escribir`. Mismo set para Fecha y Deadline, con callbacks distintos (`tsk:fecs:` / `tsk:deds:`). En sábado o domingo "esta semana" salta al viernes siguiente — **un atajo nunca propone una fecha ya pasada**.
- **⚠️ El texto libre (`✍️`) solo consume el mensaje si REALMENTE parsea** como fecha (`parseWrittenDate`: ISO, `dd/mm`, "mañana", día de la semana, "sin fecha") o como nombre (`looksLikeName`: ≤4 palabras, solo letras, ≥3 chars). Si no, el mensaje **sigue su curso normal hacia el agente**. Sin esa condición, el estado "esperando fecha" se tragaría un pedido real de Cal — exactamente el gotcha que ya pagó el modo journal, que intercepta TODO mientras está abierto. La tarjeta que pregunta conserva `⬅️ Atrás` para no quedar trabada sin botones. **`looksLikeName` además rechaza una lista de cortesías de una palabra** (gracias, ok, listo, dale, hola…): pasan el filtro "una palabra, solo letras" y se consumían gastando una query a Notion. `cancelar`/`olvidalo`/`nada` cierran la espera y devuelven la tarjeta (bloque B2b del skill: una palabra-comando nunca es un valor).
- **El `pendingInput` se lee en el mismo `Promise.all` que el journal** (`index.ts`), no en serie: son ~100-300 ms Mac→Cloudflare que se pagan en CADA mensaje de texto, y ese bloque existe justamente para no erosionar el "placeholder en <1 s".
- **Callbacks `tsk:*` son HEAVY** (crear escribe la página, sube adjuntos y archiva el mail) con el lock anti-doble-tap de `cf-kv.ts`, fire-and-forget, y **arriba del catch-all de "Heavy callbacks legacy"** de `index.ts` — abajo serían código muerto sin rastro en logs (mismo motivo que `bklg:*` y `lrn:*`).
- **Los adjuntos se suben al CONFIRMAR, no al proponer:** los `file_upload` de Notion caducan en ~1 h y Cal puede tocar la tarjeta al día siguiente. Se bajan de Gmail y se suben dentro de `createTaskFromProposal`.
- **`mutateState()` es el único camino de escritura del estado** (`task-check.ts`): lee-muta-escribe **sin awaits en el medio**. El cron y los callbacks corren en el mismo proceso pero intercalados por el event loop; una función que leyera, esperara a Notion y recién después escribiera pisaría lo que el otro camino guardó mientras tanto. Escribe con temporal + `renameSync`: `readTaskCheckState` traga cualquier error devolviendo estado vacío, así que un archivo cortado a la mitad se llevaría puestos `queue` y `threadPages`, no solo la lista de `processed` como en los pipelines previos.

**Cinco cosas que encontró `daemon-health-reviewer` antes de producción** (las dos primeras eran bloqueantes) y que conviene no re-romper:

1. **El orden `sendMessage` → `active` no es cosmético.** Al revés (marcar activo y después mandar), un fallo de envío — un blip de red, o el SNI filtering documentado más arriba — dejaba `active` apuntando a una propuesta cuya tarjeta nunca llegó al chat: el cron la veía viva 7 días (TTL del KV), no proponía nada más, y **todos los mails siguientes se acumulaban en la cola sin ningún aviso**. Ahora si el envío falla se borra la propuesta y el ítem queda en la cola para el próximo tick.
2. **Crear la tarea tiene que ser idempotente por hilo.** `createTaskFromProposal` chequea `threadPages[threadId]` y devuelve la página existente con `yaExistia`. Sin eso, el `🔄 Reintentar` tras un fallo parcial —o un segundo tap una vez vencido el lock de 60 s mientras se suben adjuntos— creaba una **segunda página**. Complemento: `createTaskPage` no propaga el fallo del `appendChildrenInBatches` de los bloques que pasan de 100, porque ahí la página YA existe y propagar el error invita justamente a ese reintento.
3. **El `⏳ Creando la tarea…` es la protección real contra el doble tap, no un adorno.** Subir adjuntos + escribir en Notion supera fácil los 60 s del lock (`MEETING_FLOW_LOCK_TTL_SEC`); mientras tanto el botón `✅ Crear tarea` seguía visible y sin ninguna señal. Quitar el teclado antes de arrancar es lo que cierra la ventana; el lock solo cubre el doble-tap rápido.
4. **Toda promoción de la cola pasa por `serializePromote`** (cadena de promesas a nivel módulo). El flag `running` de `checkTaskEmails` solo lo protege de sí mismo: `advanceTaskQueue`/`postponeActiveTask` entran desde los callbacks, en paralelo con un tick del cron, y `promoteNext` lee `queue[0]`, espera segundos (Gmail + Sonnet) y recién ahí escribe `active` — ventana de sobra para mandar **dos tarjetas confirmables del mismo correo**. La mutación de `active` va DENTRO de la cadena, no antes. ⚠️ Nada dentro de la cadena puede volver a llamar una función que serializa: encolarse detrás de uno mismo es un deadlock (por eso existe `promoteNextUnsafe`). Y la cadena lleva **timeout de 120 s** (`PROMOTE_TIMEOUT_MS`): al ser un cuello de botella global, un solo await colgado —`extractTaskFields` no tiene timeout propio, y `sendMessage` de `shared-v2` es un `fetch` pelado, a diferencia de Gmail/Notion— dejaría esperando para siempre a todos los avances posteriores, incluidos los de los botones.
   **`advanceTaskQueue` recibe el `proposalId`** y libera el turno solo si sigue siendo el activo. Los handlers `ok`/`no` borran la propuesta de KV y recién después de un round-trip a Telegram llaman a avanzar; si un tick del cron cae en esa ventana, la declara expirada y promueve la siguiente — y un `active = null` incondicional pisaba esa tarjeta recién mandada y promovía otra más.
5. **El cuerpo del mail entra recortado a Sonnet** (`MAX_BODY_CHARS` = 40 K en `task-extract.ts`) y `accionRequerida`/`contextoRelevante` se cortan a 1800. Lo primero porque un hilo largo reenviado es exactamente la forma que produjo los cuatro "Autocompact is thrashing" documentados arriba; lo segundo porque Notion rechaza un `rich_text` de más de 2000 y el `validation_error` le llegaba a Cal como "no pude crear la tarea", sin nada que pudiera hacer.

6. **La propuesta ya sintetizada se cachea en el ítem de la cola** (`TaskQueueItem.proposalId`). Si falla el envío de la tarjeta, el trabajo caro (Gmail + Sonnet) ya se pagó: sin la caché, con Telegram caído el cron lo rehacía **cada 15 minutos sobre el mismo correo** — 4 turnos de Sonnet por hora contra la cuota de Claude Max de Cal, con el único rastro de un `task_propose_send_failed` en el log. `⏭️ Después` sí limpia el campo: ahí se quiere re-sintetizar.

Otros dos, menores pero con síntoma visible: `renderCreated` muestra el conteo **real** de adjuntos subidos (`uploadAttachments` traga el fallo por adjunto y Notion corta el upload single-part en ~20 MB — decir "2 adjuntos" con la página vacía los daba por guardados), y `createTaskFromProposal` **relee la propuesta de KV** antes de apendar los seguimientos, porque un correo del mismo hilo puede haber llegado después de que el handler leyó su copia.
- **Emojis de dominio** (agregados al lexicon del skill `telegram-bot-ux`): `📎` adjunto · `📥` cola pendiente · `⏰` **Deadline** por contraste con `📅` Fecha (los dos conviven en la misma tarjeta). Ninguno decorativo.
- **Anti-duplicados: por `threadId` de Gmail únicamente, no semántico.** Tres caminos: hilo con tarea YA creada → bloque `↪️ Seguimiento` en la página (`appendTaskFollowup()`); hilo con propuesta activa o en cola → se anexa a `followupIds` (se apenda al crear, con el cuerpo crudo recortado, sin gastar otra llamada al modelo) y **no nace una segunda tarjeta**; hilo nuevo → a la cola. **Decisión de Cal (2026-07-28): los adjuntos de un mail de seguimiento NO se suben** (solo el texto) — gap real encontrado por `daemon-health-reviewer`, dejado así a propósito para v1.
- **"Bloque de Mail" del spec original no tiene equivalente en la API pública de Notion** (el bloque nativo de Gmail es una integración privada de la UI de Notion, ni siquiera `ntn` —que solo pega contra la misma API pública— lo puede crear). Resuelto con: bloque `bookmark` al permalink de Gmail (`gmailPermalink()`, `#all/{threadId}` — sobrevive al archivado, a diferencia de `#inbox/{id}`) + cada adjunto real subido como bloque `file` vía el flujo de 2 pasos de la File Upload API pública de Notion (`uploadAttachmentToNotion()`: crear `file_upload` → `POST .../send` con `FormData`/`Blob`, mismo patrón que `telegram-files.ts`). Bytes del adjunto SOLO en memoria (`Buffer`, nunca tocan disco) — sin el riesgo de path traversal que tienen los flujos que sí escriben a `tmpdir()` (ej. `boa-wallet-*`).
- **`Asignado a` sale de la tarjeta; `Solicitado por` queda SIEMPRE en Cal** — es él quien reenvía el mail. En la DB real esa propiedad casi no se usa (18 de 763 tareas, todas Cal), así que no se le puso UI.
- **Notificación en Notion a Cal cuando falta Fecha o Deadline (spec: "si queda Deadline O Fecha vacía"):** único mecanismo real de push de Notion vía API pública es un **comentario con @mención** (`notifyMissingDate()`, `POST /v1/comments`, mención de tipo `user` con el id real de Cal `11fa1824-6b4f-49b1-9427-8c2c494b69c1` — NO el pageId de People, son namespaces distintos). **Requiere que la integración "Claude CoS" tenga la capacidad de insertar comentarios habilitada en el Developer Portal de Notion — no verificado en producción todavía.** Si falla (403 por falta de capacidad), queda logueado (`task_notify_missing_date_failed`) sin romper el resto del flujo — Cal igual se entera por el reporte de Telegram, que también lista las preguntas.
- **`archiveAndMarkRead()` con el mismo gap ya conocido:** requiere scope `gmail.modify`, que el token compartido (`GMAIL_OAUTH_REFRESH_TOKEN_LEPESQUEUR`) todavía no tiene (mismo pendiente que el pipeline PDF de KPIs, ver arriba). Falla con 403, capturado y logueado (`task_archive_failed`), no bloquea la creación de la tarea.
- **Reviewed por `daemon-health-reviewer`** (tres pasadas: el pipeline original, el rediseño con tarjeta + cola, y la verificación de los fixes). Los 2 bloqueantes y los 8 warnings del rediseño están arriba, resueltos y con test de regresión; la tercera pasada cerró sin bloqueantes y aportó los 3 warnings que introdujo el propio fix de concurrencia (timeout de la cadena, `advanceTaskQueue` con `proposalId`, caché de la propuesta) — también resueltos. Gaps aceptados a conciencia: (a) si el proceso muere entre el envío de la tarjeta y el `mutateState`, ese mail se re-propone (tarjeta duplicada, no tarea duplicada — la creación sí es idempotente); (b) `MAX_QUEUE` = 50 con la búsqueda de Gmail acotada a 3 días: si la cola sigue llena al cuarto día el correo sale de la ventana, por eso el aviso al llenarse.
- **Lo que va a CF KV** (`jano:task:proposal:*`, TTL 7 días) es asunto + síntesis de correo interno de BCP. Misma postura que journal/backlog, pero con un TTL bastante más largo — decisión consciente, no un descuido.

Los otros 3 (resumidor/flight-checkin/foco-checkin) siguen comentados en `loop()`. Reactivar: descomentar la llamada correspondiente + rebuild + restart.

**Al reactivar (familia 6 del rediseño de mensajes Telegram, 2026-07-02):** `scheduleFlightCheckin`,
`scheduleFocoCheckinsLocal`, `scheduleResumirPlaylist` (ya activo) y el monitor de combustible (abajo)
mandan cada uno su propio `sendMessage` independiente. Si dos coinciden en la misma ventana (ej. foco
check-in y una alerta de vuelo, o cualquiera de estos con el resumidor a las 08:00), hoy saldrían
como 2 mensajes separados. Vesta ya resolvió el mismo problema entre sus 4 crons con un módulo
`digest-queue.ts` (cola en memoria, debounce ~15s, sin KV — ver `Vesta/daemon-v2/src/digest-queue.ts`
+ `Vesta/CLAUDE.md` sección "Digest-queue entre crons" y el spec
`Vesta/docs/superpowers/specs/2026-07-02-digest-queue-crons-design.md`). Al reactivar cualquiera de
las proactivas hoy desactivadas en Jano, copiar ese mismo patrón desde el día uno (adaptado a
`resumidor.ts`'s cola existente si aplica) en vez de volver a `sendMessage` suelto por mecanismo.
**Auditoría 2026-07-03 (histórica, ya no aplica):** riesgo teórico de colisión entre `scheduleResumirPlaylist`
(único proactivo activo en ese momento) y un futuro `fuel_alert` reactivado — nunca se confirmó en la
práctica ni se implementó nada, y quedó sin objeto al apagarse `scheduleResumirPlaylist` el 2026-07-14.

**Estado real (actualizado 2026-07-28):** **6 proactivos internos activos** — `scheduleHealthSyncCheck()`
(alerta de corte de sync de Apple Health), `scheduleKpiIngestCheck()` (ingesta del mail diario de BCP a
"KPIs diarios" + tarjeta de KPIs disparada desde ahí mismo, ver arriba), `scheduleJournalSweep()`
(barrido dominical del Journal de terapia, ver abajo), `scheduleDailyNoteCheck()` (ingesta de
"Daily Notes Yape" por mail, cada 15 min 6-23h — implementado en otra sesión el 2026-07-27,
**pendiente de documentar en detalle por quien lo hizo**), `scheduleTaskEmailCheck()` (mails
"(Tarea)" → tarjeta de propuesta en el chat, y tarea en la DB Notion "Tareas" al confirmarla; cola
de a uno, cada 15 min 6-23h — ver sección propia arriba) y
`scheduleLearningReflect()` (reflexión nocturna del self-learning, 22:00 La Paz — ver sección
"Self-learning" abajo), además del webhook watchdog (infra, no le manda nada a Cal).
`scheduleKpiCardDaily()` dejó de ser un cron propio el 2026-07-24 — ver arriba, quedó absorbido
dentro del pipeline PDF de `scheduleKpiIngestCheck()`. Los otros 3 crons de dominio (resumidor,
flight check-in, Foco check-in) siguen desactivados. Jano ya no es
100% reactivo — son las seis excepciones puntuales a esa decisión del 2026-07-14.
**Sin proactividad por evento externo** — el monitor de combustible sigue apagado (`crons = []` en
`combustible-proxy/wrangler.toml`, verificado 2026-07-03), ver abajo. Verificar qué crons internos
arrancan: `grep -E "_scheduled" ~/Library/Logs/cos-agent-v2.out.log`.

## Monitor de combustible (alertas proactivas) — ⛔ APAGADO 2026-06-19
> El cron de `combustible-proxy` quemaba ~576 writes/día de KV (≈57% del free tier) → Cloudflare disparó alerta "50% daily KV limit". Apagado con `crons = []` + `enabled:false` en KV (`monitor_config`). Ya NO llegan `fuel_alert` a la cola. Reactivar: ver `~/Claude Projects/Personal/Apps/Combustible/repo/CLAUDE.md` (restaurar cron a `*/5`, no cada minuto; hacer el `put monitor_state` condicional). El flujo descrito abajo queda como referencia de cómo funcionaba.

Cron en `combustible-proxy` (CF, externo) detecta "llegó gasolina" → `POST /fuel/alert` (Service Binding) al worker de Jano → `QueueMessage{kind:"fuel_alert"}` → daemon `proactive/fuel-alert.ts` re-verifica litros y avisa a Cal. Config editable **por texto** vía tools del MCP `combustible` (`getFuelMonitorConfig/Status/setFuelMonitorConfig`); el menú es texto (los botones tappables se revirtieron 2026-06-18, no funcionaron en el Telegram de Cal). Endpoint `/fuel/alert` en `worker-v2/src/index.ts`; tipo `FuelEvent` en `shared-v2/src/types.ts`. Detalle: `~/Claude Projects/Personal/Apps/Combustible/repo/CLAUDE.md`.
