# Resumidor: selector de cola + metadata (título/autor) — Plan de implementación

> **Para agentes:** usar `superpowers:subagent-driven-development` o ejecutar directo si el
> alcance es manejable en una sola sesión de implementación con revisión propia al final.

**Goal:** Reemplazar el auto-avance FIFO de la cola del resumidor por un selector (lista +
botones), y anteponer título/autor-canal al resumen entregado.

**Repos/archivos:** `Personal/Agents/Jano/daemon-v2/src/tools/resumir.ts`,
`daemon-v2/src/index.ts` (nuevo callback handler), `~/.claude/scripts/audio-transcribe.sh`.

**Spec de referencia:** `docs/superpowers/specs/2026-07-03-resumidor-selector-metadata-design.md`

---

## Task 1: Extracción de metadata (autor/canal) en `audio-transcribe.sh`

**Archivo:** `~/.claude/scripts/audio-transcribe.sh`

- [ ] Rama YouTube-captions (línea ~41-42): cambiar el `--print "%(title)s"` por
  `--print "%(title)s\n%(uploader)s"`, parsear las 2 líneas de salida (title = primera, channel =
  segunda), e incluir `"channel"` en el JSON emitido (junto a `"title"`).
- [ ] Rama descarga+whisper (línea ~58-75, hoy sin título/canal): SOLO si `$INPUT` matchea
  `*youtube.com*`/`*youtu.be*` (mismo check que arriba), correr un `--print
  "%(title)s\n%(uploader)s"` extra contra `$INPUT` y capturar título+canal; incluir ambos
  (`title`, `channel`) en el JSON final de esa rama (línea 75), como campos opcionales (si el
  `--print` falla o el input no es YouTube, quedan ausentes — no bloquear la transcripción por
  esto).
- [ ] Probar manualmente: `~/.claude/scripts/audio-transcribe.sh "https://youtu.be/<algún-id-corto>"`
  y confirmar que el JSON de salida trae `channel` cuando aplica, sin romper el `status:"ok"`
  existente.

## Task 2: `run()` en `resumir.ts` — extraer y anteponer título/autor

**Archivo:** `daemon-v2/src/tools/resumir.ts`

- [ ] Agregar función pura testeable `buildResumenHeader(title: string | undefined, author: string
  | undefined, kind: Kind): string` que devuelve las 1-2 líneas a anteponer (o string vacío si no
  hay ni título ni autor). Emoji de autor según `kind`: 🎬 para `video`/`podcast`, 📰 para
  `article`. Formato exacto (ajustable): `<b>{title}</b>\n{emoji} {author}\n\n` (con salto extra
  antes del TL;DR). Si falta `author` pero hay `title`: solo la línea de título. Si falta todo:
  string vacío.
- [ ] Exportar esa función (para el test).
- [ ] En `run()` (línea ~457): agregar `let docAuthor = "";` junto a `docTitle` (línea 492).
  Poblarla: en la rama `opts.prefetched` (línea 495-499) desde `opts.prefetched.author` (nuevo
  campo, ver Task 3); en la rama `kind === "video"/"podcast"` (línea 518-532) desde `r.channel`
  (nuevo campo del script, Task 1).
- [ ] Justo antes de `const parts = chunk(mdToTelegram(md), TG_MAX);` (línea 549): anteponer
  `buildResumenHeader(docTitle, docAuthor, kind)` al string que se trocea.
- [ ] Actualizar `RunOpts.prefetched` (línea ~69-70) para incluir `author?: string`.

## Task 3: Feedbin — extraer `author`

**Archivo:** `daemon-v2/src/tools/resumir.ts`

- [ ] `fetchStarredContent` (línea ~899): agregar `author` a la destructuración del JSON de
  Feedbin (`d.author`) y devolverlo en el objeto de retorno: `{ text, title, author? }`.
- [ ] `advanceStarredQueue` (línea ~938, donde llama a `run(...)` con `prefetched: content`,
  línea ~959): el `content` ya trae `author` una vez actualizado el tipo de retorno — no requiere
  cambio adicional ahí, solo que el tipo fluya correctamente (TypeScript debería marcarlo si falta
  algo).

## Task 4: Selector de cola — función pura + integración

**Archivo:** `daemon-v2/src/tools/resumir.ts`

- [ ] Nueva función pura testeable `buildQueueSelector(kind: "v" | "s", items: Array<{ id: string
  | number; title: string }>): { text: string; keyboard: unknown }`. Header con emoji+conteo (🎬
  para `"v"`, ⭐ para `"s"`), líneas numeradas (título recortado a ~80 chars), botones
  `resu-pick:{kind}:{id}` en filas de máx. 5, fila final `[✅ Procesar todos]`
  (`resu-pick:{kind}:all`) + `[❌ Ahora no]` (`resu-pick:{kind}:none`). Mismo estilo de texto/HTML
  que `reviewMeetings` en `agent-tools.ts:770-834` (referencia de patrón, NO tocar ese archivo).
- [ ] Agregar `mode?: "batch"` al shape de `PLAYLIST_QUEUE` (`{ videos: PlaylistVideo[]; mode?:
  "batch" }`) y `STARRED_QUEUE` (`{ items: StarredItem[]; mode?: "batch" }") — actualizar los
  `readJsonSafe<...>` correspondientes.
- [ ] Extraer de `advancePlaylistQueue`/`advanceStarredQueue` la lógica que arranca a procesar UN
  ítem ya elegido (reservar `pendingPath` lock, editar ancla a "Procesando...", llamar `run()`,
  manejar el caso de falla) a una función compartida por cola, ej. `startPlaylistItem(deps, chatId,
  video: PlaylistVideo, anchorMsgId?: number)` / `startStarredItem(deps, chatId, item: StarredItem,
  anchorMsgId?: number)` — reusable tanto desde el camino FIFO (`shift()`) como desde el camino
  "por id" (`splice`).
- [ ] `checkPlaylistsResumir`/`checkStarredResumir` (línea ~1106, ~977): donde hoy llaman a
  `advance*Queue(deps, chatId, anchorMsgId)` tras confirmar "no hay propuesta en curso" (líneas
  ~1135-1141, ~1002-1008 aprox.), cambiar a: si `q.mode === "batch"` → comportamiento actual
  (FIFO); si no → armar `buildQueueSelector` y mandarlo/editarlo (según haya `anchorMsgId` o no) en
  vez de arrancar solo.
- [ ] `maybeAdvance` (línea ~1096): para cada cola con items pendientes, mismo criterio — si
  `mode === "batch"` sigue el FIFO de siempre; si no, muestra el selector de nuevo (mensaje nuevo,
  no hay ancla en este punto).

## Task 5: Callback handler `resu-pick:` en `index.ts`

**Archivo:** `daemon-v2/src/index.ts`

- [ ] Junto a los demás callbacks interceptados mecánicamente (`j:resu:*`, buscar el bloque),
  agregar manejo de `resu-pick:{v|s}:{id|all|none}`:
  - `{id}`: sacar el ítem de la cola por id (`findIndex`+`splice`, NO `shift()`), llamar
    `startPlaylistItem`/`startStarredItem` con ese ítem y `cb.message.message_id` como ancla.
  - `all`: setear `mode: "batch"` en el JSON de esa cola, luego comportamiento FIFO normal
    (`shift()` + arrancar, mismo que hace `advancePlaylistQueue`/`advanceStarredQueue` hoy).
  - `none`: editar el mensaje a `"Ok, seguís con {N} pendientes — pedime 'revisá la
    playlist'/'revisá los starred' cuando quieras."` sin tocar la cola ni el `mode`.
- [ ] Usar `answerCallbackQuery` apropiado (ack inmediato) — seguir el patrón ya establecido hoy
  en este mismo archivo para callbacks similares (ver el fix de `mlog:`/`mskip:`/`msel:` de más
  temprano en el día, mismo archivo).
- [ ] **Aplicar el lock anti doble-tap** (mismo patrón `jano:lock:{chatId}:{userId}` de
  `cf-kv.ts`, ya usado hoy para `mlog:`/`mskip:`/`msel:`) alrededor de este nuevo callback también
  — mismo riesgo de concurrencia que ya se resolvió hoy para el otro flujo.

## Task 6: Tests

**Archivo:** `daemon-v2/src/tools/resumir.test.ts` (nuevo — no existe hoy test para este archivo)

- [ ] `buildResumenHeader`: casos título+autor, solo título, ninguno, kind video vs article (emoji
  distinto).
- [ ] `buildQueueSelector`: 1 item, 6+ items (verificar filas de máx 5 + fila final con 2 botones),
  ids que son string vs number (playlist vs starred).
- [ ] Correr `npx vitest run --root daemon-v2` — debe seguir en verde (hoy 58/58, sube con los
  tests nuevos).

## Task 7: Build, verificación manual, docs

- [ ] `npm -w @cos/shared run build && npm -w @cos/daemon run build` — limpio.
- [ ] Invocar `daemon-health-reviewer` sobre los cambios de `index.ts`.
- [ ] Verificar manualmente (o razonar sobre el código) que los archivos JSON de cola existentes
  (sin el campo `mode`) siguen parseando bien con `readJsonSafe` (no debe romper si `mode` está
  ausente).
- [ ] Actualizar `CLAUDE.md` (sección Resumidor) y `CHANGELOG.md` si existe, describiendo el nuevo
  flujo selector + metadata.
- [ ] NO commitear ni reiniciar el daemon si esto lo ejecuta un subagente — dejar para revisión.
