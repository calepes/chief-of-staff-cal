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
| Schema de MCPs custom | `~/AI Projects/Personal/MCP Servers/mcp-servers/CLAUDE.md` |
| Worker CF (webhook/callbacks) | `worker-v2/src/index.ts` |
| Arquitectura completa | `docs/ARCHITECTURE.md` |

## Comandos operativos
```bash
cd "/Users/calepes/AI Projects/Personal/Agents/Jano"
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
- **Custom (`cos-tools`):** getOutlookEvents · searchPlace · travelTime · requestUserLocation · getTokenUsage · getWhatsappContacts/saveWhatsappContact · pptWizardSave/Load · getFocoCalStatus/logFocoProgress · fetchAsUser · fetchAndSummarize · **Resumidor** (suite, ver abajo) · readPersistedOutput · readwiseGetDailyReview · **executeClings** (leer Things) · **thingsWrite** (escribir Things, URL scheme) · **executeRemctl** (Reminders, familia/mercado) · notionCli/notionPageMarkdown/notionUpdateBody · enviarArchivoNotion · **generarQrAduanaBolivia** (QR salida/ingreso Bolivia Form 250 vía POST HTTP → manda imagen al chat; identidad de `~/.claude/datos-viaje.json`; flujo en `tools/qr-aduana.ts`) · **generarKpiCardYape** (tarjeta PNG diaria de KPIs Yape on-demand) · **reprocesarKpisDerivadosYape** (fuerza recálculo de derivados de "KPIs diarios", todo el histórico o fechas puntuales — ver sección "scheduleKpiIngestCheck" más abajo) · **consultarJournal** (LEER el Journal de reflexión; guardar NO pasa por el LLM — ver sección "Journal de reflexión" abajo) · **mapaBacklogs/leerBacklog/proponerItemBacklog** (leer y escribir los `BACKLOG.md` de los proyectos de Cal — ver sección "Backlogs de proyectos" abajo) · **guardarReferenciaDiseno** (capturar y guardar referencias visuales de diseño en `Personal/Referencias de Diseño/` — ver sección "Referencias de Diseño" abajo) · **listarProyectosClaude/abrirProyectoClaude** (abrir un proyecto de Cal en VS Code o cmux desde el chat — wrapper del mismo `claude-launcher-helper.sh` que usa el skill `claude-launcher` en sesión interactiva; flujo en `tools/claude-launcher.ts`, guía en `system-prompt.ts` sección "Claude Launcher") · **searchBooks/addBook/updateBook/confirmCreateBookRelation/getReadingHistory** (gestión de la BD de libros en Notion — ver sección "Libros" abajo).

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
- **MCPs custom:** youtube-transcribe · exchange-rate-bolivia · naabol-flights · health · agent-learnings · combustible · feedbin · serpapi-flights · apple-notes · inversiones-query · spark · achoradazos · **boa-checkin** (check-in online BoA vía Chrome real + CDP — `prepareBoaCheckin`/`confirmBoaCheckin`/`manageBoaSeat`/`getBoaBoardingPass`/`setBoaFrequentFlyer`, agregado 2026-07-04; 5 bugs reales de automatización encontrados y arreglados el mismo día (incluido uno silencioso: boarding pass del pasajero equivocado en reservas multi-pax) — ver `Personal/MCP Servers/mcp-servers/servers/boa-checkin/` y skill `boa-checkin-bolivia`). **`generateBoaWalletPass`** (agregado 2026-07-16, certificado de Apple Developer de Cal activo desde 2026-07-17 — desbloqueado y funcionando con reservas reales) genera un `.pkpass` escaneable del boarding pass MÁS una imagen `.png` decorativa (`cardImagePath`) con el diseño navy/dorado aprobado por Cal (mismo BCBP real como barcode, renderizada con Playwright + bwip-js en `wallet-image.ts`). Se entregan con dos tools: `enviarDocumentoLocal` (el `.pkpass`) y `enviarFotoLocal` (la tarjeta — vía `sendDocument`, no `sendPhoto`, porque Telegram recomprime fotos a JPEG y pierde la transparencia de las esquinas redondeadas). Ambas en `agent-tools.ts`/`tools/telegram-files.ts` — suben un archivo LOCAL a Telegram vía multipart, restringidas por seguridad a `tmpdir()` + patrón `boa-wallet-*.{pkpass,png}` con `realpath()` (resuelve symlinks antes de validar), ya que `enviarDocumentoUrl` solo acepta URLs públicas. · **cine** (cartelera + compra de entradas Cinemark/Multicine/Cine Center — ver abajo). *`worldcup` archivado 2026-08-08 — terminó el Mundial 2026, desregistrado de `index.ts`/`agent-options.ts`/`agent.ts`/`system-prompt.ts`, código conservado en `Personal/MCP Servers/mcp-servers/servers/worldcup/` sin mover; skill `mundial-analisis-diario` también marcado archivado.*

### Cine (MCP `cine`, agregado 2026-07-25)
Cartelera + compra de entradas de los 3 cines de Santa Cruz (**Cinemark** Ventura Mall, **Multicine** Las Brisas, **Cine Center** MegaCenter/Trompillo), **para cualquier fecha**. Compra automatizada **solo en Cinemark**. Server compartido con Vesta en `Personal/MCP Servers/mcp-servers/servers/cine/` (migrado desde tools locales de Vesta).
- **7 tools:** `getCartelera({fecha?, pelicula?, cines?})` · `iniciarCompraCine` → `{purchaseId, mapaPath, minutosRestantes}` · `elegirAsientosCine({purchaseId, asientos})` → `{resumenPath, total, minutosRestantes}` · `confirmarCompraCine({purchaseId})` → `{qrPath, minutosRestantes}` · `verificarPagoCine({purchaseId})` → `{pagado, codigoRetiro?, entradasPath?}` · `cancelarCompraCine({purchaseId})` · `estadoCompraCine({})` (recupera la compra activa si el LLM perdió el `purchaseId`).
- 📖 **Gotchas técnicos del server (BFF, navegación por fecha, matcher día+mes, browser lazy, reaper, `purchaseId`): fuente única en `mcp-servers/CLAUDE.md` → tabla de servidores, fila `cine`.** El server lo comparten Jano y Vesta — NO dupliques esos gotchas acá ni en el CLAUDE.md de Vesta; se desincronizan.
- **Específico de Jano — confirmación de pago POR TEXTO.** No hay polling y **Jano no tiene parser de teclados emitidos por el LLM** (sus botones se construyen en código): Cal escribe "ya pagué" y recién ahí se llama `verificarPagoCine`. Vesta sí muestra el botón `✅ Ya pagué`. Si alguna vez se quiere el botón acá, hay que agregarle a Jano un parser genérico o un tool tipo `enviarBotonPago` — es un cambio aparte.
- **Específico de Jano — allowlist:** `enviarFotoLocal` (`tools/telegram-files.ts`) acepta `cine-*.png` además de `boa-wallet-*` y `kpi-card-*`; el MCP devuelve PATHS en `tmpdir()` y el daemon los sube.
- **Compra real end-to-end VALIDADA** (2026-07-26, Cal la corrió hasta el QR de pago y el código de retiro). Multicine y Cine Center siguen sin compra automatizada (Multicine se frena en un reCAPTCHA v2 del checkout; Cine Center tiene el modo invitado bugueado).
- **Al mandar el mapa de asientos, mandá TAMBIÉN la lista `butacasLibres`** que devuelve `iniciarCompraCine` (agrupada por fila, ej. `Fila B: B1-B4, B6-B9`). El screenshot NO trae los números de butaca impresos, así que sin esa lista Cal adivina el código y pide asientos que no existen. En salas premier las butacas vienen de a pares pero **cada mitad es independiente**: para 2 personas juntas hay que pedir las dos (`['A1','A2']`). Detalle técnico del parser (dos renderizados según tipo de sala) en `mcp-servers/CLAUDE.md`, fila `cine` — no duplicar acá.

### Libros (`tools/books.ts`) — gestión ampliada 2026-08-24/27

DB de libros de Notion (135 libros al momento del análisis). A pedido de Cal ("análisis completo de la
Bd. y qué tools debería tener Jano para gestión de libros desde el bot") se auditó la BD entera y se
amplió `books.ts` de gestión básica a un set completo: crear/actualizar con relaciones, confirmar
relaciones nuevas con gate real, buscar por cualquier campo (incluidos rollups), y ver historial de
lectura.

- **Bug real encontrado y arreglado — "Estado" cambió de `select` a `status` en Notion, el código
  seguía tratándolo como `select`.** Rompía `searchBooks` con meta 2026 (`filter type mismatch`).
  Corregido en los 5 lugares que lo tocan (filtro de query, lectura en `pageToBookResult`, escritura en
  `addBook`/`updateBook`). **Gotcha de sesión SDK con `resume:true`:** después de aplicar el fix, Cal
  seguía viendo el mismo error porque el historial retomado traía el tool_call fallido — el modelo
  reintentaba con `notionCli` como workaround en vez de re-llamar `searchBooks` ya arreglado. Se
  resuelve con `/reset` en el chat (limpia KV + `sessionId`, ver sección "Runtime del SDK" abajo).
- **`avanceTracking` se leía del path equivocado:** `props["Avance Tracking"]?.number` en vez de
  `.rollup?.number` — el shape real es un rollup, no un number plano. Corregido.
- **`EstadoLibro` (union type) estaba incompleto:** no incluía `"Not started"` (51/135 libros — la
  mayoría del catálogo) ni `"Por comprar"` (1/135). Ampliado.
- **URL se escribía a una propiedad inexistente** (`"userDefined:URL"` en vez de `"URL"`, el nombre
  real en Notion). Corregido.
- **`addBook`/`updateBook` ganaron `author`/`tags`/`bigThemes`** (relaciones a las DBs `Author`,
  `Tags`, `Big Themes`) vía `resolveRelation()` (busca match EXACTO por título en la DB relacionada).
  Si no matchea 1:1 (`not_found`/`ambiguous`), la tool **NO crea nada por su cuenta** — devuelve una
  nota pendiente (`resolveOrNote()`) para que Jano le pregunte a Cal si quiere crear la entrada nueva.
- **Gate técnico real anti-prompt-injection para crear relaciones nuevas** (`tools/book-relation-pending.ts`,
  bloqueante antes de producción según `daemon-health-reviewer` — Jano tiene web search/fetch, y solo
  confiar en prosa del system prompt ("esperá confirmación de Cal") es vulnerable). `addPendingRelation`
  registra `(bookPageId, tipo, nombre)` en `~/.cos-agent/book-relation-pending.json` con TTL 15 min;
  `confirmCreateBookRelation` (tool nueva) SOLO crea la página+relación si `consumePendingRelation`
  encuentra un pending real que matchea — si no, rechaza sin tocar Notion.
- **`updateBook.author` REEMPLAZA (no mergea)** — es un campo single-value, corre independiente sin
  necesitar leer relaciones existentes primero. `tags`/`bigThemes` sí **mergean** (leen la página
  actual, agregan a lo existente). **Bug de silent clobber encontrado por review:** si el GET para leer
  relaciones existentes fallaba, el código seguía con lista vacía y el PATCH pisaba (perdía) las
  relaciones ya guardadas. Fix: `existingFetchFailed` aborta la escritura de esas relaciones puntuales
  con una nota explícita a Cal, en vez de seguir con datos parciales.
- **`clearPlanningToRead` (nuevo, booleano en `updateBook`)** — gap real que Cal encontró en vivo: no
  había forma de VACIAR el campo "Planning to read" (select de años 2021-2026), solo asignarlo. Gana
  sobre `planningToRead` si ambos vienen en la misma llamada (`properties["Planning to read"] =
  {select:null}`).
- **`searchBooks` reescrito con ~17 filtros combinables** (`{and:[...]}` cuando hay 2+): `query, estado,
  rating, planningToRead, isbn (contains, no equals — evita falso negativo por formato), totalPaginas
  Min/Max, startDate/finishDate From/To, avanceTrackingMin/Max (SÍ se puede filtrar por rollup —
  `{rollup:{number:{...}}}`), ultimaLecturaFrom/To (rollup date), author/tag/bigTheme` (relaciones
  resueltas por nombre vía `resolveRelation`, sin fallback silencioso si no matchea). Usa
  `queryAllPages()` (paginación real con `start_cursor`, techo defensivo 20 páginas) — antes cortaba en
  la primera página y perdía resultados con más de 100 filas.
- **`getReadingHistory` (nuevo)** — "cómo he ido leyendo": busca en TODA la biblioteca (`queryAllPages`)
  y trae el historial de sesiones de la Tracking DB ordenado por fecha para el libro que matchea.
- **Salida de lectura enriquecida (2026-08-27):** `searchBooks` expone `Total Páginas` cuando existe;
  `getReadingHistory` expone `Avance (pag)` por sesión y el total en el encabezado. Así Jano puede
  responder avances recientes en páginas sin pedirle a Cal el total manualmente; si Notion no tiene
  el valor, omite ese dato y conserva la respuesta en porcentajes.
- **Bug de fecha UTC en `logReadingProgress`, encontrado construyendo el cron de libros (ver
  `scheduleBooksDailyReport` en "Automatización" abajo):** usaba `new Date().toISOString().slice(0,10)`
  en vez de `nowInLaPaz()` — sesiones de lectura registradas entre las 20:00 y medianoche hora La Paz
  quedaban fechadas al día siguiente (mismo gotcha documentado más abajo para `task-check.ts`/
  `daily-note-check.ts`, no se había aplicado acá todavía). Una línea, corregido.
- **Cover automático** (icon + cover de la página = portada del libro) ya existía antes de esta ronda,
  sin cambios.

### Análisis de imágenes (`tools/vision.ts`) — rediseño 2026-08-24/25

Cal mandó un screenshot de Apple Books y Jano "no supo qué hacer" — el diagnóstico mostró que
`processPhoto()` clasificaba la imagen con una heurística (`taskForPhotoCaption`/`isCodexUsageAnalysis`)
ANTES de mirarla, y el resumen que le devolvía al modelo principal era demasiado acotado ("1-3 líneas
para familia") para que decidiera bien qué hacer. Pedido explícito de Cal: *"Quiero que vea toda imagen
que suba y sobre eso decida qué hacer o pregunte. Ajustemos el prompt y quitemos lo de codex."*

- **Heurística de pre-clasificación eliminada.** `taskForPhotoCaption()`/`isCodexUsageAnalysis()`
  removidas; `processPhoto()` (`index.ts`) ahora siempre pide `task:"describe"`. `AnalyzePhotoOpts["task"]`
  pasó de `"ocr"|"describe"|"design_critique"|"classify"` a solo los 3 primeros (`"classify"` era código
  muerto de la heurística removida).
- **Prompt "describe" reescrito** de un resumen corto y acotado a extracción COMPLETA sin resumir ni
  limitar el dominio — el LLM principal necesita el contenido real de la imagen para decidir, no un
  resumen ya recortado por otro modelo.
- **Modelo de visión — 3 iteraciones en la misma sesión, investigado con la API pública de OpenRouter**
  (`api/v1/models`, no WebFetch a la web — un WebFetch anterior había traído datos de precios
  sospechosos/posiblemente alucinados, ver memoria `feedback_verificar_research_llm_en_vivo`):
  1. `google/gemini-3-pro-image` — **error real, descartado antes de producción:** es el modelo de
     GENERACIÓN de imágenes de Google ("Nano Banana Pro"), no de comprensión. Riesgo real si hubiera
     llegado a producción: costo ~10x y el parser rompiendo con `content` como array de imágenes.
  2. `moonshotai/kimi-k2.5` — funcionó técnicamente, pero Cal lo probó con una foto real y "no anduvo
     bien" en calidad.
  3. **`qwen/qwen3-vl-235b-a22b-thinking`** — elegido, en producción.
- **`max_tokens` 1024 → 2048; agregado `modalities: ["text"]`** al body del request.
- **Parseo de `content` ahora defensivo:** soporta tanto string plano como array de partes
  `{type:"text",text}` — distintos modelos de OpenRouter devuelven formatos distintos en la misma API.
- **`vision.test.ts` eliminado** — solo testeaba las 2 funciones removidas, sin lógica pura nueva que
  reemplazarlo.

### Achoradazos — cobros, juntes y gastos (2026-08-27)

El MCP `achoradazos` permite listar y crear grupos de cobro y juntes, registrar pagos y gastos, y
consultar gastos por junte. Para registrar un gasto, Jano exige elegir el junte explícitamente desde
el selector de Telegram antes de procesar el comprobante.

- **Comprobantes:** `uploadReceipt` admite imágenes y PDF. Las imágenes se comprimen; el PDF se sube
  sin conversión y retorna `{url, filename}`. `registerExpense` y `registerDeposit` reciben ambos
  valores para que Airtable preserve el nombre y tipo del adjunto.
- **Consulta:** `listExpensesByEvento({ junteId })` devuelve cantidad, total y detalle de los gastos
  registrados del junte.
- **Límite:** no hay validación automática de duplicados por decisión de Cal.

## Telegram Rich Messages (@cal/telegram)

Jano usa la librería compartida `@cal/telegram` (`Personal/Agents/shared-telegram/`), igual que
Vesta/Pecunia. **Historia completa de la migración: `CHANGELOG.md`, entrada `2026-08-06`; contexto/
decisiones compartidas entre los 3 bots: `Personal/Agents/HANDOFF-telegram-rich-messages-shared-lib.md`.**

- **Política "diseño activo, no reactivo"** (`system-prompt.ts`, sección "Rich Messages"):
  headings/listas/tablas son la herramienta por defecto cuando el contenido tiene esa forma, no un
  lujo ocasional. El bloque SCQA/STORYLINE de PPT (wizard de slides) es la única excepción
  explícita — se deja en `<pre>` porque es contenido para copiar tal cual.
- **`index.ts` (reply del modelo) tiene fallback de 3 niveles:** rich → HTML clásico (chunking a
  4096) → texto plano (`stripHtmlTags`). Rich Messages soporta 32.768 chars, así que el chunking
  solo corre si cae al segundo nivel.
- **Los crons proactivos activos NO pasan por ese fallback** — construyen su HTML en código y usan
  `sendCronMessage()` (`proactive/rich-send.ts`, rich → HTML clásico, sin nivel de texto plano). Los
  3 crons desactivados (flight-checkin/foco-check/fuel-alert) siguen con `sendMessage` clásico.

## .env / secrets — carga en runtime (migrado a 1Password 2026-08-30)
Fuente: `daemon-v2/src/index.ts`.
1. **`loadEnv({ path: ~/.cos-agent/.env })` es el ÚNICO `loadEnv()`.** El segundo (`~/.claude/secrets/apps.env`, fallback compartido) se sacó del código — ya no existe. `~/.cos-agent/.env` en sí ya no tiene secretos reales (solo `OPENROUTER_MODEL`, sin uso).
2. **launchd arranca vía wrapper, no `node` directo:** `ProgramArguments` del plist (`~/Library/LaunchAgents/com.cal.cos-agent-v2.plist`) apunta a `~/.cos-agent/run-with-1password.sh`, que corre `op run --env-file=~/.cos-agent/apps-env.1password.tpl -- node dist/index.js` — inyecta las 30 variables (9 ítems compartidos con Vesta + 21 propios de Jano) desde el vault `Daemons` de 1Password ANTES de que Node arranque. Notifica a Telegram (cooldown 30 min) si `op run` falla — **fail-loud, verificado con prueba negativa real** (sin el token del Service Account, el daemon queda en `spawn scheduled`, nunca arranca en silencio con datos vacíos).
3. **Validación:** críticas con `requireEnv()` (throw si faltan): `CF_*`, `COS_TELEGRAM_BOT_TOKEN`, `NOTION_*`. Opcionales → `""`.
4. **MCPs custom:** cada uno spawneado con solo sus tokens vía `mcpServers[].env` (least-privilege).

| Credencial | Origen en runtime |
|---|---|
| API keys de servicios + bot token + Notion token | 1Password (vault `Daemons`) vía el wrapper `op run` |
| Auth Claude/Anthropic + MCPs heredados | OAuth Max en macOS Keychain |
| Tokens por-MCP custom | inyectados en `mcpServers[].env` |

Detalle completo (inventario de los 30 ítems, mapeo variable→ítem, gotchas encontrados —
incluidas 2 variables REALMENTE ocultas que ningún audit anterior había listado,
`YOUTUBE_OAUTH_REFRESH_TOKEN` y `GOOGLE_BOOKS_API_KEY`, que se leían con `process.env.X` directo
fuera del bloque `env` de `index.ts`): `Personal/Agents/HANDOFF-1password-migration.md`, sección
"Fase 1a — Jano". Para migrar otro daemon con el mismo mecanismo, ese doc tiene el checklist
reusable.

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
- **Webhook roto sin aviso — incidente real 2026-08-26, ~8.5h (22:15→06:53).** Un blip del Worker (`Bad Gateway` al validar la URL en el `setWebhook`) coincidió con que la Mac perdió conectividad saliente a `api.telegram.org` por horas (mismo síntoma que el gotcha de SNI de arriba) — el watchdog corre LOCAL en la Mac, así que sin esa conectividad no podía ni diagnosticar ni arreglar nada, aunque corra cada 1 min. Cal mandó un entry al Journal en esa ventana y se perdió en silencio (Telegram reintenta y eventualmente descarta el update; el daemon nunca lo vio). Diagnosticado con `wrangler tail` sobre `cos-agent-worker` + un `console.log` temporal del `update` crudo (revertido después) — confirmó que un mensaje de texto normal, una vez sano el webhook, guarda perfecto (`journal_saved`). **Mitigación agregada el mismo día:** alerta proactiva por el bot de notifications si el corte pasa de 10 min (ver `scheduleWebhookWatchdog()` arriba) — no cubre el caso "la Mac entera sin red" (mismo path que la alerta), pero sí "el webhook se desincroniza con la Mac sana". Recuperación manual más rápida: reiniciar el daemon fuerza un `setWebhook` inmediato sin esperar al watchdog (ver "Comandos operativos").
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
- **"Autocompact is thrashing" — circuit breaker del SDK, 4 recurrencias hasta resuelto (2026-07-06 ×2, 2026-07-13/14):** el SDK aborta un turno devolviendo su propio texto de diagnóstico marcado `subtype:"success"` si el contexto se recompacta y vuelve a tocar el umbral 3 veces seguidas en <3 turnos internos — el daemon lo reenviaba tal cual a Cal como respuesta real. Causa raíz estructural: 164 tools + system prompt ~18-20K tokens se reenviaban COMPLETOS en cada llamada interna. **Resuelto (2026-07-14):** `ToolSearch` (carga diferida nativa del SDK) desbloqueada de `DISALLOWED_BUILTINS` — el modelo busca y carga solo los schemas que necesita por turno. `cacheReadInputTokens` cayó ~3x (405K vs 1.19M-1.37M) en carga de trabajo comparable. De paso: `SDK_DIAGNOSTIC_PATTERNS` en `agent.ts` filtra el texto de diagnóstico como red de seguridad adicional, y se corrigió un dato falso en `system-prompt.ts` sobre dónde vive el PNR de BoA (encontrado mientras se testeaba el fix de arriba). Historia completa de las 4 recurrencias + investigación: `CHANGELOG.md` entradas 2026-07-06 (×2) y 2026-07-14.
- **Keyboard sin limpiar en `jano-wiz-*` — resuelto (2026-07-03):** el helper local `editMsg` en `tools/approval-flow.ts` omitía `reply_markup` cuando no había un teclado nuevo que pasar, y por el mismo gotcha de Telegram (`editMessageText` no limpia `reply_markup` si se omite) los botones de la tarjeta anterior (`bulk-ok`/`bulk-no`/`back`/`start`/`ok`/`no` en sus ramas terminales — todas las que hacen `kv.delete(wizKey(...))` con `done: true`) quedaban vivos y tocables tras pasar a un estado sin botones ("todos revisados"). Fix: `editMsg` ahora manda SIEMPRE `reply_markup`, con `{ inline_keyboard: [] }` por default si no se pasa uno nuevo — generalizado en el helper en vez de parchar cada call site (todos los que quieren conservar teclado ya lo pasaban explícito). Fix 100% aislado en `approval-flow.ts`, no toca el routing de `index.ts` ni `existingPlaceholderId` (confirmado por `daemon-health-reviewer` vía `git diff --stat` + grep de `buildApprovalFlow`/`stepApprovalWizard` en `index.ts`, sin llamadas reales ahí).
- **`AskUserQuestion` cuelga turnos ~1min con error silencioso — resuelto (2026-07-12):** el modelo a veces intenta usar `AskUserQuestion` (tool interactiva de Claude Code CLI, pensada para sesiones con un humano respondiendo botones en el momento) para confirmarle algo a Cal antes de seguir — visto en el flujo de tags del resumidor (`editarPropuestaResumen`) y en confirmación de fechas de calendario. En el daemon headless de Jano esa tool no tiene handler real: falla siempre con el mismo error genérico `"Answer questions?"` (`tool_result.is_error:true`), y el modelo tarda decenas de segundos en reintentar con la tool correcta — desde Telegram se siente como "no funcionó" o error. Fix: agregada `"AskUserQuestion"` a `DISALLOWED_BUILTINS` en `agent-options.ts`, mismo patrón que las demás tools interactivas de CLI ya bloqueadas (`ScheduleWakeup`, `Monitor`, `PushNotification`, `EnterWorktree`/`ExitWorktree`, `ExitPlanMode`). Diagnosticado leyendo `~/Library/Logs/cos-agent-v2.out.log` (`grep "AskUserQuestion"` mostró el patrón repetido con el mismo `err`).
- **YouTube exige "Sign in to confirm you're not a bot" a `yt-dlp` sin cookies — resuelto (2026-07-12):** un video de la playlist auto-resumidor falló ("⚠️ No pude resumir..."), y el fallo no dejaba rastro en `out.log` ni `err.log` porque en `run()` (`tools/resumir.ts:549-552`) el fallo de transcripción hace `return` (no `throw`) — sin excepción no hay `console.error`, y el mensaje específico del error (`"❌ No pude transcribir (...)"`) se pisa casi al instante por el genérico de `startPlaylistItem` (`"⚠️ No pude resumir... Lo dejé de nuevo en la cola"`, ver gotcha de fallas puntuales arriba en la sección Jano/CLAUDE.md de Resumidor). Reproducido a mano: `yt-dlp --print "%(title)s" <url>` devolvía el bloqueo de YouTube para CUALQUIER video (no uno puntual) — bloqueo nuevo de YouTube a nivel IP, no un bug de código. `brew upgrade yt-dlp` (2026.6.9→2026.7.4) NO lo resolvió. Fix real: `~/.claude/scripts/audio-transcribe.sh` ahora pasa `--cookies-from-browser safari` (array `YTDLP_COOKIES`) a las 4 llamadas a `yt-dlp` del script (captions, metadata ×2, descarga de audio) — reusa la sesión de YouTube logueada de Cal en Safari. Confirmado funcionando end-to-end bajo el daemon real (vía Telegram), no solo en shell interactivo — a diferencia de `fetchAsUser`/`safari-fetch.mjs`, acá NO hizo falta el wrapper `node-fda` con FDA especial; `yt-dlp --cookies-from-browser safari` funcionó directo bajo launchd.
- **`WarmQuery` huérfano en retornos tempranos de `processMessage` — resuelto (2026-07-14):** encontrado al revisar un fix análogo en Pecunia el mismo día (commit `4ccc44c`). `takeWarm()` se dispara al inicio de cada turno para solapar el arranque del subprocess del SDK con el preprocessing multimodal — pero 4 `return` tempranos (falla al transcribir audio, falla al leer foto, falla al leer documento, sin texto tras preprocessing) abandonaban el `warmPromise` sin cerrarlo, dejando el subprocess pre-warmeado corriendo huérfano indefinidamente. En Pecunia el mismo patrón rompía el turno SIGUIENTE ("No such tool available", 86 ocurrencias abr-jul) por compartir un mcpServer singleton; en Jano NO rompe el turno siguiente (cada `takeWarm()` ya usa un mcpServer fresco y aislado, `index.ts:317-336`), pero el leak de subprocess/recursos igual aplica en un daemon que corre semanas sin reiniciar. **Fix:** `discardWarm(warmPromise)` (usa `WarmQuery.close()`, documentado en el SDK para exactamente este caso) en los 4 `return`, todos verificados por `daemon-health-reviewer` como anteriores al `await warmPromise` real — nunca interrumpen un turno en curso. **Gap preexistente encontrado de paso, sin resolver:** el `try` externo de `processMessage` no tiene `catch` propio — una excepción real (no un `return`) antes de `await warmPromise` (ej. `state.load` o un `editMessage`/`sendMessage` sin `.catch()` en las ramas de voz/foto/documento) escapa sin capturar, deja el `warm` sin cerrar Y deja a Cal con el placeholder "⏳ Procesando..." colgado sin mensaje de error (el daemon no crashea, el loop principal la atrapa más arriba, pero Cal nunca se entera). Sin implementar — decisión pendiente de Cal si se materializa en la práctica.
- **Detección de cortes de sync de Apple Health — agregado (2026-07-15), pasado a proactivo (2026-07-16):** Cal reportó que tenía que abrir Health Auto Export a mano para que suba data (la automatización interna de la app + Background App Refresh no estaban configuradas). Fix de fondo es config en el teléfono (fuera de este repo); como red de seguridad se agregó tracking del último `/ingest` recibido — ver detalle completo en `Health/CLAUDE.md` y `Health/health-worker/`. Tool `mcp__health__getHealthSyncStatus` (sin args) wireado en `allowedTools` + `system-prompt.ts` (sección `## Salud`) para el camino reactivo (Cal pregunta, Jano responde). **2026-07-16:** un corte real de 11 horas (07:02-18:23 local, confirmado vía diagnóstico exportado de la app: el loop de automatización de Health Auto Export no corrió NADA en esa ventana — iOS suspendió el background refresh) llevó a Cal a pedir que esto SÍ sea proactivo. Se agregó `scheduleHealthSyncCheck()` (`proactive/health-sync-check.ts`, cron `0,30 7-22 * * *` timezone La Paz) — chequeo mecánico (sin LLM) contra `GET /status` del health-worker; si `hoursSinceLastIngest >= 4h` y no se avisó ya para ese corte (dedup en CF KV, TTL 24h), manda alerta directa por Telegram. Esto **reabre puntualmente** la arquitectura 100% reactiva decidida el 2026-07-14 (ver sección "Automatización — dos capas" abajo) — a diferencia de las otras 3 proactivas (resumidor/flight-checkin/foco-checkin), que siguen desactivadas.
- **`generateBoaWalletPass` — origen/destino vacíos o cruzados en el pase (resuelto 2026-07-20):** el parseo del BCBP debe anclarse en el PNR/locator ya conocido (`indexOf`), nunca en offsets absolutos desde el inicio del mensaje — contar bytes desde el arranque corre todos los campos si el nombre del pasajero cambia de largo entre decodes. Fix en `parseBcbpEssentials` (`wallet-pdf417.ts`). Detalle completo (incluida la causa raíz del intento fallido previo): skill `boa-checkin-bolivia`.
- **`prepareBoaCheckin` reportaba "no está abierto" en tramos YA checkeados (resuelto 2026-07-20):** el "Confirm and continue" que `prepare` clickea para llegar al mapa de asientos consume el check-in en el backend de Amadeus (no hay "hold temporal") — `selectJourney` solo distinguía 2 de los 3 estados posibles de una reserva. Fix: `journeys.ts` clasifica los 3 estados; `prepare`/`confirm` son idempotentes sobre un tramo ya checkeado. Detalle completo: skill `boa-checkin-bolivia`.
- **MCP `cine` perdía el estado de la compra entre turnos — resuelto (2026-07-25):** el flujo de compra guarda browser+sesión en memoria del proceso (`compra-store.ts`, necesario porque el hold de asientos está atado a la pestaña); Jano no usa warm pool y `cine` era `stdio` → cada mensaje spawneaba un proceso nuevo con memoria vacía, perdiendo la compra en curso. Fix: `cine` pasó de `stdio` efímero a proceso HTTP persistente vía launchd (`com.cal.cine-mcp-jano.plist`, puerto 8791; Vesta usa el 8792, un proceso separado por bot). Detalle completo (incluido un gotcha de `StreamableHTTPServerTransport` en modo stateless): `docs/superpowers/plans/2026-07-25-cine-mcp-persistent-process.md`.

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

Tres tools para que Jano lea y escriba los `BACKLOG.md` repartidos por `~/AI Projects`:
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

## Runtime del SDK — modelo, effort, turnos y sesión

**Historia completa (bug de `notionApi` doble-encodeando el body, upgrade 0.2.122→0.3.220): `CHANGELOG.md`, entrada `2026-07-27 — Runtime del SDK`.** Referencia operativa vigente:

- **`maxTurns` = 25** (`index.ts`) — el techo corta loops, no trabajo legítimo.
- **`effort`** (`effort.ts`): default `high` (override `JANO_EFFORT`); Cal sube a `xhigh` con prefijo explícito `/deep`, `/fondo` o `++` — nunca heurística automática, para no gastar cuota de Claude Max sin que Cal sepa por qué.
- **Techo de 20 turnos por sesión** (`JANO_MAX_SESSION_TURNS`) — al tope, el chat arranca sesión nueva y vuelve al historial de KV (se pierde detalle de tool calls viejas, no la conversación). Monitorear `grep sdk_diagnostic_leak ~/Library/Logs/cos-agent-v2.out.log` si aparece "Autocompact is thrashing" de nuevo.
- **`resume` por chat** (`session-store.ts`, `sessionId` en `~/.cos-agent/sessions.json`, TTL 12h igual que KV): KV pasó de fuente primaria a fallback — con resume exitoso, `runAgent` NO reinyecta el historial de texto de KV (duplicaría el pasado real + uno resumido por Haiku que puede contradecirlo). Fallback automático si el `.jsonl` está borrado/vacío/corrupto. `/deep` por voz recalcula el effort post-transcripción. `/reset` limpia KV **y** sessionId (limpiar solo uno no tiene efecto real).
- **`consultarJson({path, jqExpr})`** (`tools/consultar-json.ts`) — corre `jq` sobre un persisted-output sin traerlo al contexto (preferir sobre `readPersistedOutput` para datos estructurados grandes). `execFile` async, nunca `spawnSync` (congelaría el daemon entero). `realpathSync` ANTES de validar el path (mismo regex con debilidad a `..` que `read-persisted.ts`, sin resolver ahí). **⚠️ `jq` expone el entorno del proceso vía `env`/`$ENV`** — el spawn va con `env: { PATH: "/usr/bin:/bin" }` explícito; sin eso, una expresión (por error o prompt injection) volcaría todos los secretos de Cal a Telegram. `maxBuffer` 64 MB (default de `spawnSync` es 1 MB → `ENOBUFS`). No es `Bash` general — binario fijo, sin shell, con allowlist de paths.

## Research de competencia (Yape Bolivia) — Fase 1 2026-08-31, Fase 2 2026-09-02/03, Chrome real 2026-09-04/05, Apify + features 2026-09-05/06

> **Flujo de negocio + diseño funcional y tecnológico completo (mapa de archivos, modelo de datos,
> resiliencia/límites conocidos):** `docs/references/research-competencia.md`. Esta sección es el
> changelog narrado día a día — para entender el sistema entero, empezar por ese doc.

**Standalone, NO vive en el daemon.** `daemon-v2/scripts/research-competencia-now.ts`, disparado por
un cron externo de launchd (`launchd/com.cal.jano-research-competencia.plist`, lunes 06:00 La Paz —
instalado a mano por Cal, no se autoinstala). Sin tool de Telegram ni cron interno — decisión
explícita desde el spec Fase 1 (`docs/superpowers/specs/2026-08-31-research-competencia-design.md`).
6 entidades fijas (`research-competencia-entities.ts`): bancosol-altoke, ganadero-yolopago,
economico-zas, takenos, meru, peso-app. **Corren en paralelo** (`runWithConcurrency`,
`CONCURRENCY = 3`, agregado 2026-09-06) — antes era secuencial, y 6 entidades × varios minutos cada
una alargaban demasiado la corrida completa.

Por entidad, 4 fuentes en paralelo (`research-competencia.ts`, cada una con su propio deadline vía
`raceWithLoggedTimeout` — un `Promise.race` contra un timer, con `.finally()` para no dejar el timer
huérfano logueando un "timeout" fantasma después de que la promesa real ya ganó):
1. **Fase 1 — mecánico + agente LLM**: App Store/Google Play + sitio propio + LinkedIn/prensa vía
   WebSearch, un agente SDK one-off por entidad (`research-competencia-agent.ts`, maxTurns 20,
   timeout 5 min). Dimensiones: Producto/Estrategia/GTM/Hiring/**Pricing** (agregada 2026-09-06).
2. **Fase 2 — social orgánico**: Instagram/TikTok/Facebook/X (`research-competencia-social.ts` +
   `-scrapers.ts` + `-apify.ts`, timeout externo 20 min — subido de 10, ver "Apify" abajo —,
   presupuesto interno dividido POR PLATAFORMA, no un pool compartido — ver abajo).
3. **Ads**: Google Ads Transparency Center + Meta Ad Library (`research-competencia-ads.ts` /
   `-meta-ads.ts`, timeout 2 min) — más un fetch en paralelo de los KPIs de ads del propio Yape
   como referencia (`YAPE_ADS_REFERENCE`, ver abajo).
4. Notion: baseline + battlecard previo (`research-competencia-notion.ts`).

Resultado por entidad: hallazgos por dimensión + battlecard vivo (resumen/fortalezas/debilidades/
amenaza), escrito a Notion y resumido a Telegram vía @ClaudeCalbot (`formatSummaryHtml`) —
NOTIF_BOT_TOKEN, no el bot de Jano.

### Social orgánico — de cookies de Safari, a Chrome real, a Apify (2026-09-04 a 06)
- **Diseño original (Fase 2):** Chromium headless de Playwright + cookies inyectadas leídas de
  `Cookies.binarycookies` de Safari (requería Full Disk Access vía `node-fda`). Descartado el mismo
  día de la primera corrida real: con cookie de sesión de Instagram VÁLIDA, el scraper igual
  devolvía 0 posts — Instagram le sirve una página degradada a Chromium headless, sesión válida o
  no.
- **Fix 2026-09-04 — Chrome real vía CDP** (`research-competencia-browser.ts`, mismo patrón ya
  validado en este repo para `boa-checkin`). Perfil dedicado persistente
  `~/.cos-agent/research-competencia-chrome-profile` — Cal se loguea UNA VEZ
  (`npm run research:chrome-login`, ventana visible) y la sesión sobrevive entre corridas (headless
  en el cron real). **Resultado real, mixto:** Instagram quedó resuelto reescribiendo el parser a
  extracción DOM del grid ya renderizado (`parseInstagramGridItems`/`collectInstagramGridItems` —
  Instagram migró a su framework "Comet" y el JSON embebido `shortcode`+`owner.username` que se
  buscaba antes ya no existe; 11 posts reales de altoke.bo en la primera corrida de prueba). Pero
  Facebook devolvía texto deliberadamente ofuscado (anti-scraping real, no un bug de selector) y
  TikTok disparaba un captcha de slider ("Drag the slider to fit the puzzle") antes de mostrar el
  grid — mismo tipo de bloqueo ya descartado automatizar para Multicine (`mcp-servers` CLAUDE.md,
  ficha `cine`).
  - Las dos formas de post de Instagram traen datos complementarios, ninguna trae todo: **Reel**
    (`href` con `/reel/`) trae caption real completo en el `alt` pero sin fecha parseable; **Foto**
    (`href` con `/p/`) trae fecha pero el `alt` es descripción de visión auto-generada por Instagram
    ("Photo by altoke on {fecha}..."), no un caption real — se descarta a propósito (`caption:""`).
    `esVideo` se fuerza `false` para los dos (el grid nunca expone una URL de video real, solo la
    miniatura). El grid NO se reordena por fecha — reordenar empujaría todos los reels (mayoría del
    contenido real) al final, porque no tienen fecha.
- **Fix 2026-09-05 — migración a Apify para Facebook y TikTok** (`research-competencia-apify.ts`):
  marketplace de scrapers de terceros, en vez de pelear el DOM/anti-bot directamente. Actores:
  `apify/facebook-posts-scraper` (Facebook) y `apidojo/tiktok-scraper` (TikTok), vía
  `APIFY_TOKEN`. Instagram y X siguen en Chrome real + extracción DOM, sin cambios — Apify solo
  reemplazó las dos fuentes que estaban bloqueadas.
  - **⚠️ Gotcha real, TikTok devolvía 0 posts para cuentas grandes/verificadas — encontrado y
    resuelto en vivo.** El input `location` del actor de Apify (región del proxy que hace el
    scraping) default a `"US"` — con eso, cuentas grandes de Bolivia (altoke.bo, y `yapebolivia`
    usada a propósito para descartar la hipótesis de "es un problema de tamaño de cuenta")
    devolvían 0 resultados silenciosamente, sin error. Fix: `location: "BO"` explícito en el input
    del actor (`TIKTOK_LOCATION` en `research-competencia-apify.ts`) — verificado contra ambas
    cuentas.
- **Presupuesto de tiempo — de pool compartido a división POR PLATAFORMA (2026-09-06, "robusta" por
  decisión de Cal frente a la opción más simple de solo reordenar/subir el timeout):** con Apify
  devolviendo contenido real y más voluminoso, el presupuesto de 7 min compartido entre las 4
  plataformas dejaba que una plataforma lenta (ej. Instagram+TikTok) le comiera todo el tiempo a
  las que venían después en el loop (ej. Facebook), aunque hubiera tiempo de sobra en términos
  absolutos. Fix: `PER_ENTITY_BUDGET_MS` (subido 7→15 min, con `SOCIAL_TIMEOUT_MS` 10→20 min en
  `research-competencia.ts`) se divide en partes iguales entre las plataformas CON handles
  configurados, y cada plataforma corre contra SU PROPIO timer (`inicioPlataforma`) — exceder la
  porción de una plataforma solo la corta a ELLA (log
  `research_competencia_social_platform_budget_exceeded`, antes `..._budget_exceeded` a secas), las
  demás siguen con su presupuesto intacto.

### Nuevas dimensiones — Pricing y comparación explícita con Yape (2026-09-06)
- **Dimensión `Pricing` agregada** (`Dimension` en `research-competencia-types.ts`) — ejemplos en el
  prompt del agente: tarifas de transferencia, comisiones, tipo de cambio, límites.
- **`YAPE_CONTEXT`** (`research-competencia-agent.ts`) — bloque fijo con la posición real de Yape
  (gratis, features, positioning, sacado de yape.com.bo) inyectado en el prompt del agente, con una
  instrucción explícita: cuando un hallazgo compita DIRECTO contra algo de Yape, decirlo — pero sin
  forzarlo en cada hallazgo, solo cuando la comparación es real y aporta.
- **Regresión encontrada y arreglada el mismo día — el agente dejó de usar WebSearch.** Al sumar más
  contenido social pre-cargado en el prompt (Apify trayendo más volumen), el modelo empezó a
  saltearse la búsqueda web para Hiring/Producto — confirmado comparando dos corridas consecutivas
  en Notion (Cal: *"me parece que en el anterior había más información de producto de hiring que no
  salió en este último informe"*). Causa: atención/priorización del modelo con mucho contenido
  interpuesto, no un bug de código. Fix: reforzar la instrucción de NO saltearse WebSearch cerca del
  FINAL del prompt (justo antes del formato de salida) en vez de solo al principio — instrucciones
  tempranas se diluyen cuando hay mucho contenido en el medio (recency bias). Verificado
  empíricamente instrumentando `runEntityAgent()` para loguear `webSearchCalls`/`totalToolCalls` por
  entidad (`research_competencia_agent_tool_usage`) — conteos sanos post-fix (8, 8, 3, 5, 5, 6 en
  una corrida real).

### Ads — Google Ads Transparency Center + Meta Ad Library + referencia propia de Yape (2026-09-03 a 06)
- Complementario al orgánico, no lo reemplaza: dice en qué gasta publicidad la entidad y a quién le
  habla, no qué publica orgánicamente.
- **Google (agregado 2026-09-03/04):** endpoint NO oficial (RPC interno
  `SearchService/SearchCreatives`), `region=BO`, sin login. IDs de anunciante (`AR...`) descubiertos
  a mano y hardcodeados en `EntityConfig.ads.google` — 5 de 6 entidades resueltas (Peso App sin
  anunciante boliviano confiable todavía). El anunciante real casi nunca coincide con el nombre de
  marca (Takenos → "GLOBAL FLOW S.A.", Meru → "R3mit Solutions Inc.").
  - **⚠️ Rate limit real, más duro de lo esperado:** tras ~40-50 requests en un día, Google devolvió
    429 en TODO el dominio (no solo el RPC) y siguió bloqueado 20+ horas — baneo de IP, no throttle
    de ráfaga. `THROTTLE_MS` (2,5s entre pedidos) ayuda contra el caso fácil, no contra un umbral
    acumulado de horas/días. Uso real del cron (~7 pedidos/semana) muy por debajo del volumen que lo
    disparó — probablemente seguro en la práctica, sin garantía.
  - **Cola de throttle GLOBAL (2026-09-06)**, no solo por entidad (`conColaGlobal`, promise chain a
    nivel de módulo, serializa TODOS los pedidos del proceso) — con la paralelización de entidades
    (arriba), pedidos concurrentes de entidades distintas hubieran multiplicado el riesgo de 429 si
    el throttle solo serializaba dentro de una misma entidad.
- **Meta Ad Library agregada 2026-09-04+** (`research-competencia-meta-ads.ts`) — pública, sin
  login, headless-fetchable. Búsqueda por keyword trae ruido; se filtra con un allowlist
  (`entity.ads.meta`, nombre exacto de la página).
  - **Explorado y descartado: desglose Facebook vs. Instagram dentro de Meta.** Cal pidió separar
    los anuncios por plataforma dentro de Meta — los íconos de "Plataformas" en el Ad Library NO
    tienen `aria-label`, solo coordenadas `mask-position` de un sprite CSS sin mapeo público
    confiable. Sin señal utilizable, descartado (no implementado).
- **Split Google/Meta nuevos/existentes — llevado a producción (2026-09-08).** El pedido de Cal de
  separar la tabla de ads por red y por nuevo/existente se había aplicado el 2026-09-06 solo de forma
  MANUAL (script ad-hoc descartable sobre el informe ya generado, sin tocar `buildAdsKpisBlocks`) —
  por eso la corrida automática siguiente no lo mostró. Diagnosticado y corregido: `AdsKpis` ganó
  `google:{nuevos,existentes}`/`meta:{nuevos,existentes}` (`computeAdsKpis`,
  research-competencia-ads.ts), y la tabla del informe (`buildAdsKpisBlocks`,
  research-competencia-notion.ts) ahora muestra esas columnas en vez de los totales combinados.
  `campanasNuevas`/`creativosActivos` combinados se mantuvieron intactos (los sigue usando
  `formatSummaryHtml` para el resumen de Telegram). **Lección:** una iteración pedida "viendo la
  tabla" en el momento, sin persistirla en el código, se pierde en la corrida siguiente sin aviso —
  si un ajuste debe quedar, tiene que tocar el pipeline real, no solo el output de esa corrida.
- **`YAPE_ADS_REFERENCE` (2026-09-06)** — KPIs de ads del propio Yape (Google advertiser ID
  `AR15902350746855669761`, reconciliado a "BANCO DE CREDITO DE BOLIVIA S.A." / yape.com.bo; página
  Meta "Yape Bolivia" exacta) como referencia PERMANENTE en el pipeline, NO un competidor —
  deliberadamente fuera de `ENTITIES`. Verificado explícito que es Bolivia y no Perú antes de
  integrarlo. Fetch en paralelo al batch de entidades, protegido con el mismo
  `raceWithLoggedTimeout` que el resto (encontrado en tests: sin el timeout, un mock
  intencionalmente colgado de OTRA entidad quedaba "robado" por este fetch al ser el primero en
  evaluarse en JS, rompiendo 11 tests). Aparece como primera fila "Yape Bolivia (referencia)" en la
  tabla comparativa de ads del informe (`buildAdsKpisBlocks`).
  - **Split Google/Meta activos/nuevos** aplicado puntualmente al informe consolidado manual (pedido
    de Cal viendo la tabla) — NO tocó el código de producción, `buildAdsKpisBlocks` sigue con las
    columnas Creativos activos/Campañas nuevas/Duración/Formato de siempre; el split se calculó
    ad-hoc con un script descartable reusando `fetchAdsText`/`fetchMetaAdsText`/`esNuevo`.

### Procesos en background que se mataban sin razón aparente (2026-09-05)
- **Síntoma:** 3 corridas largas lanzadas vía `run_in_background` del Bash tool de Claude Code
  terminaron en `[killed]` sin error de código propio, incluso con `caffeinate -i` corriendo.
  Descartado sleep real del sistema (`pmset -g log` mostró un `caffeinate` con `ClientDied`
  inesperado — un sleep real pausaría el proceso, no lo mataría). Candidatos sin descartar del
  todo: App Nap de macOS sobre una terminal en background, o el manejo de ciclo de vida de procesos
  en background del harness de Claude Code.
- **Fix:** `scripts/research-competencia-run-detached.sh` — `nohup ... & disown` (confirmado
  `PPID=1`, desconectado del todo del proceso padre), envuelto en `caffeinate -i`, con su PROPIA
  notificación a Telegram por `curl` (bot `NOTIF_BOT_TOKEN`) al terminar — desacopla la entrega del
  aviso de que la sesión interactiva de Claude Code siga viva. Log a
  `/tmp/research-competencia-run.log`.

## Notion
- Integración "Claude CoS" (DB Tareas + People). Prefijo MCP: `mcp__claude_ai_Notion__*`.
- **Ese MCP es SOLO del daemon.** En sesión interactiva de Claude Code no existe — usar el CLI `ntn` (skill `notion-ntn`) para cualquier query/escritura a Notion sobre este repo (ej. sync de docs a la DB "Agentes AI").
- Referencia cross-project: `~/AI Projects/notion-reference.md` (bajo demanda).

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
- Research de competencia (Yape Bolivia) — flujo de negocio + diseño funcional/técnico completo: `docs/references/research-competencia.md`
- Arquitectura completa: `docs/ARCHITECTURE.md` · Backlog: `BACKLOG.md`
- Telegram cross-project: `~/AI Projects/telegram-reference.md`
- Contexto Yape: `~/AI Projects/Yape/CLAUDE.md`
- Specs/Planes: `docs/superpowers/specs/` y `docs/superpowers/plans/`

## Automatización — dos capas (NO confundir)
Hay dos mecanismos de proactividad independientes:

**1. Plists launchd (crons externos) — DESACTIVADOS 2026-06-13 (dormidos).**
7 plists `bootout` + archivados en `~/Library/LaunchAgents/disabled-2026-06-13/`. Cubrían heartbeat/learnings. Carpetas `heartbeat-tasks/`, `hooks/`, `launchd/` conservadas. Cómo era y cómo reactivar: `docs/references/hooks-automatizacion.md`.

**2. Crons internos del daemon (`node-cron`, dentro del proceso) — los apaga/prende el código, NO launchd.** En `index.ts` (`loop()`):
- `scheduleWebhookWatchdog()` — ACTIVO (re-set webhook cada 1 min; infra necesaria, no es proactividad hacia Cal). **Alerta de corte agregada 2026-08-26** (ver gotcha "Webhook roto sin aviso" abajo): si el webhook lleva >10 min sin poder confirmarse sano, avisa por el bot de notifications (@ClaudeCalbot, `NOTIF_BOT_TOKEN` — bot/token separados del de Jano) y de nuevo cuando se recupera. Dedup + timestamp "roto desde" en CF KV (`jano:webhook:brokenSince`/`alerted`, TTL 24h).
- `scheduleResumirPlaylist()` — **DESACTIVADO 2026-07-14** (pedido de Cal). Estuvo activo desde 2026-06-20 (opt-in). 1×/día revisaba la playlist YouTube "Para resumir" + starred de Feedbin, encolaba y proponía de a uno con checkpoint. Los botones ⭐/🎬 del menú siguen funcionando on-demand igual (no dependen del cron).
- `scheduleFlightCheckin()` — **DESACTIVADO 2026-06-17** (check-ins de vuelos, every 30min 7-22h).
- `scheduleFocoCheckinsLocal()` — **DESACTIVADO 2026-06-17** (Foco CAL am/md/pm, `proactive/foco-check.ts`).
- `scheduleHealthSyncCheck()` — **ACTIVO 2026-07-16** (pedido de Cal, ver gotcha "Detección de cortes de sync de Apple Health" arriba). Cron `0,30 7-22 * * *`, mecánico (sin LLM/`takeWarm`) — chequea `GET /status` del health-worker y avisa por Telegram si `hoursSinceLastIngest >= 4h`, con dedup en CF KV (TTL 24h) para no repetir el aviso mientras dure el mismo corte.
- **`scheduleKpiCardDaily()` — ELIMINADO 2026-07-24** (cron fijo `0 10 * * *`, pedido de Cal). La tarjeta PNG (TRX + Activos DAU + % vs. semana anterior, `@napi-rs/canvas`, `enviarFotoLocal`) ya NO espera un horario fijo — se dispara sola desde el pipeline PDF de `scheduleKpiIngestCheck()` (ver abajo) apenas ese mail se procesa con éxito, porque los 4 campos que la tarjeta muestra son 100% del PDF (el CSV no le aporta nada). Idempotente por fecha vía `state.cardSent` en `kpi-ingest-state.json`; un fallo en la tarjeta no rompe el resto de la ingesta (try/catch propio) ni deja de marcar el mail como procesado. Sigue disponible **on-demand** sin cambios vía el tool `generarKpiCardYape` (chat con Jano) — la función `checkKpiCardDaily()` (`kpi-card-daily.ts`) no se tocó, solo cambió QUIÉN la llama y CUÁNDO.
  - **Bug visual, encontrado por Cal viendo la tarjeta real (2026-07-24): esquinas negras en vez de blancas.** `renderKpiCardImage()` (`kpi-card-image.ts`) crea el canvas (transparente por default) y solo pintaba blanco DENTRO del `roundRect()` (`ctx.fill()`) — los 4 triángulos de esquina que quedan AFUERA de la curva redondeada nunca se tocaban, quedaban transparentes, y Telegram los mostraba como negro sólido. **Fix:** `ctx.fillRect(0, 0, card.size, card.size)` con el mismo blanco ANTES de trazar el `roundRect` — pinta el canvas entero primero; el `roundRect` de abajo queda solo como borde decorativo (`stroke()`, ya no `fill()`). Test de regresión con `getImageData(0,0,1,1)` verificando que el píxel de esquina sea opaco y blanco (antes: alpha=0) — confirmado que reproduce el bug con el código viejo antes de aplicar el fix.
- `scheduleJournalSweep()` — **ACTIVO 2026-07-27** (pedido de Cal, ver sección "Journal de reflexión" abajo). Cron `0 19 * * 0` (domingos 19:00 La Paz) — junta las entradas `Sin revisar` de los últimos 7 días de la DB Journal y manda un selector para destilarlas a Resonate Calendar. Dedup en CF KV (TTL 7 días). Es la **tercera excepción** a la arquitectura reactiva decidida el 2026-07-14.
- `scheduleKpiIngestCheck()` — **ACTIVO** (solo si hay credenciales Gmail, ver arriba). Cron
  `*/15 6-23 * * *`, mecánico (sin agente SDK) — detecta los mails diarios de BCP, espera 15 min,
  hace upsert en "KPIs diarios" y en "KPIs Yape Lending" (DB separada, dominio Riesgos) y completa
  derivados D/D-7. Reemplaza a mano lo que hacía un AI Agent nativo de Notion no expuesto por la
  API pública. **Historia completa (build del doble pipeline CSV+PDF, triple pipeline Lending,
  bugs de truncado/ruido/reconciliación): `CHANGELOG.md`, entrada `2026-07-22 a 2026-08-09`.**
  Referencia operativa que sigue vigente:
  - **Reparto de campos, KPIs diarios:** PDF es autoritativo para `Afiliaciones diarias`/`TRX`/
    `Activos DAU`/`Afiliados 7d`/`TRX Promedio 7d` + las 6 `vs. Ayer/Sem (%)`; el CSV trae el resto
    (Activos 30d, Saldo, Remesas, Ingresos...). Parser (`kpi-ingest-pdf.ts`) tolera un typo real de
    Yape ("vs. Sem. **anteior**", sin r) matcheando por prefijo, y pega el % con la label siguiente
    sin salto de línea real en algunos PDFs (`matchLabelSuffix()`).
  - **Lending: validación 100% aritmética** (`reconcileLendingFunnel()`, no por %, posición
    inconsistente entre bloques) — si falta EXACTAMENTE un campo de los 15 y las ecuaciones lo
    determinan sin ambigüedad, se completa por reparación (`deriveMissingField()`) en vez de
    rechazar. "EN PROCESO" aparece 2 veces en el PDF — se resuelve por ancla de contexto, no orden.
  - **Gotcha sin auditar, riesgo latente real:** `fillDerivedFields()`/`fillLendingDerivedFields()`
    saltan cualquier derivado D-1 que ya tenga valor — un reenvío del mismo reporte con números
    CORREGIDOS deja el derivado viejo stale (bug real, resuelto solo para Lending vía `onlyFechas`
    forzando recálculo; el mismo patrón en KPIs diarios no se auditó todavía).
  - **Gap conocido sin resolver:** la fecha de Lending viene del CUERPO del mail (no del filename)
    — si nunca se determina, el mail queda huérfano en `state.pending` sin aviso de abandono.
  - Reproceso manual: tool `mcp__cos-tools__reprocesarKpisDerivadosYape({ fechas? })` (chat) o
    `fillDerivedFields(notionToken)` sin `onlyFechas` desde un script (recalcula todo el histórico).

### Cron de Tareas por mail — `scheduleTaskEmailCheck()` (2026-07-28) — ⛔ DESACTIVADO 2026-09-05

**Desactivado a pedido de Cal** (línea comentada en `loop()`, `index.ts`) — código y diseño intactos por si se reactiva. **Historia completa del diseño (tarjeta+cola, y los 2 bloqueantes + 3 carreras que encontró `daemon-health-reviewer`): `CHANGELOG.md`, entradas `2026-07-28 (3)`.**

Mails que Cal reenvía a mano con **"(Tarea)"** en el asunto → tarea en la DB Notion **"Tareas"** (`1f2c487609dd802985dcd7ad59110ddd`). Mismas credenciales Gmail que KPI/DN, mismo cron `*/15 6-23 * * *`.

- **Archivos:** `task-extract.ts` (síntesis vía Sonnet, único paso no-mecánico de este pipeline), `task-notion.ts`, `task-check.ts` (cola+estado, `~/.cos-agent/task-check-state.json`), `task-card.ts`, `task-callbacks.ts` (`tsk:*`), `task-store.ts` (KV), `task-people.ts`, `task-dates.ts`.
- **Si se reactiva, verificar que sigan intactos** (son los puntos que rompieron producción antes del fix): orden `sendMessage → active` (invertirlo deja la cola trabada sin aviso si falla el envío), idempotencia por `threadPages[threadId]` en `createTaskFromProposal` (evita tareas duplicadas), y el `⏳ Creando la tarea…` que saca el teclado ANTES de escribir en Notion (el lock de 60s solo cubre el doble-tap rápido, no una operación de más de 60s con el botón visible).
- **`notifyMissingDate()` (comentario @mención a Cal en Notion si falta Fecha/Deadline) nunca se verificó en producción** — depende de que la integración "Claude CoS" tenga la capacidad de comentarios habilitada en el Developer Portal de Notion.
- `archiveAndMarkRead()` requiere `gmail.modify` — ✅ mismo token que el pipeline de KPIs, resuelto 2026-08-08.

- `scheduleBooksDailyReport()` — **ACTIVO 2026-08-25** (pedido de Cal, ver sección "Libros" abajo). Cron `0 7 * * *`, mecánico (sin agente SDK) — status de la meta de libros 2026 agrupado por Estado + avance de páginas leídas AYER por libro (suma `Avance (pag)` de la Tracking DB vía rollup "Book Name"). Reporta **todos los días**, no solo cuando hubo avance — decisión explícita de Cal, para reforzar el hábito de lectura en vez de reportar solo la excepción (a diferencia del principio "reportar la excepción" del pipeline de KPIs de arriba — acá el objetivo es el recordatorio diario en sí, no una alerta).
- `scheduleFeedbinDailyReport()` — **ACTIVO 2026-08-25** (pedido de Cal — motor de aprendizaje de temas). Cron `0 8 * * *` — no leídos de Feedbin agrupados por carpeta + recomendación de qué abrir, usando el perfil de temas semanal (`topics-profile-refresh.ts`, ver bullet siguiente); solo **SUGIERE**, nunca marca nada como leído por su cuenta. Sin `FEEDBIN_USERNAME`/`FEEDBIN_PASSWORD` el cron no se registra al arrancar.
  - **Bug real encontrado corriendo el cron manualmente el mismo día de implementarlo (2026-08-25):** con 733 artículos sin leer acumulados, un solo page de `getAllUnreadEntries` (`per_page=1000`) tarda ~10.3s en responder del lado de Feedbin — por encima del timeout de 10s que tenía `apiFetch()` en `tools/feedbin-client.ts`. Medido en vivo contra la API real (200 OK, 10351ms, reproducido 2 veces). **Fix:** timeout subido a 25s.
- `scheduleTopicsProfileRefresh()` — **ACTIVO 2026-08-25** (mismo pedido, motor de aprendizaje). Cron `0 19 * * 0` (domingos 19:00 — **mismo horario que `scheduleJournalSweep()`**, son independientes, no se pisan) — sintetiza el perfil de temas de interés ACTUALES desde 3 señales (de más a menos fuerte): shortlist de Reader, starred de Feedbin, leídos recientes de Feedbin. **Regenera el perfil ENTERO cada semana** (no acumula como `learnings.md` — "intereses actuales" caduca, un perfil de hace 2 meses ya no representa lo que Cal lee hoy) en `~/.cos-agent/topics-profile.md`, consumido por `feedbin-daily-report.ts`.

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

**Estado real (actualizado 2026-09-05, verificado contra `loop()` en `index.ts`): 11 proactivos internos activos** (+ webhook watchdog, infra, no le manda nada a Cal):
`scheduleHealthSyncCheck` (corte de sync Apple Health) · `scheduleBooksDailyReport` ·
`scheduleFeedbinDailyReport` · `scheduleTopicsProfileRefresh` · `scheduleLluviaCheck` (lluvia
Bolivia, ver `project_lluvia_bolivia_d1`) · `scheduleHealthGoalsMidday`/`scheduleHealthGoalsDaily`
(metas de salud vs. Target, ver "Salud" en `BACKLOG.md`) · `scheduleJournalSweep` (barrido
dominical Journal) · `scheduleLearningReflectLocal` (self-learning, 22:00) ·
`scheduleKpiIngestCheck`/`scheduleDailyNoteCheck` (solo si hay credenciales Gmail — ver arriba).
**`scheduleTaskEmailCheck` (mails "(Tarea)") está DESACTIVADO desde 2026-09-05** — no cuenta en
los 11. `scheduleKpiCardDaily` no es cron propio desde 2026-07-24 (absorbido en el pipeline PDF de
`scheduleKpiIngestCheck`). Resumidor/flight-checkin/Foco-checkin siguen desactivados. Jano ya no es
100% reactivo — son las excepciones puntuales a esa decisión del 2026-07-14.
**Sin proactividad por evento externo** — el monitor de combustible sigue apagado (`crons = []` en
`combustible-proxy/wrangler.toml`, verificado 2026-07-03), ver abajo. Verificar qué crons internos
arrancan: `grep -E "_scheduled" ~/Library/Logs/cos-agent-v2.out.log`.

## Monitor de combustible (alertas proactivas) — ⛔ APAGADO 2026-06-19
> El cron de `combustible-proxy` quemaba ~576 writes/día de KV (≈57% del free tier) → Cloudflare disparó alerta "50% daily KV limit". Apagado con `crons = []` + `enabled:false` en KV (`monitor_config`). Ya NO llegan `fuel_alert` a la cola. Reactivar: ver `~/AI Projects/Personal/Apps/Combustible/repo/CLAUDE.md` (restaurar cron a `*/5`, no cada minuto; hacer el `put monitor_state` condicional). El flujo descrito abajo queda como referencia de cómo funcionaba.

Cron en `combustible-proxy` (CF, externo) detecta "llegó gasolina" → `POST /fuel/alert` (Service Binding) al worker de Jano → `QueueMessage{kind:"fuel_alert"}` → daemon `proactive/fuel-alert.ts` re-verifica litros y avisa a Cal. Config editable **por texto** vía tools del MCP `combustible` (`getFuelMonitorConfig/Status/setFuelMonitorConfig`); el menú es texto (los botones tappables se revirtieron 2026-06-18, no funcionaron en el Telegram de Cal). Endpoint `/fuel/alert` en `worker-v2/src/index.ts`; tipo `FuelEvent` en `shared-v2/src/types.ts`. Detalle: `~/AI Projects/Personal/Apps/Combustible/repo/CLAUDE.md`.
