# Resumidor: selector de cola + metadata (título/autor) — Diseño

**Estado:** Aprobado por Cal, listo para plan de implementación
**Fecha:** 2026-07-03
**Repo:** `Personal/Agents/Jano/daemon-v2/` (+ `~/.claude/scripts/audio-transcribe.sh`, compartido con el skill `resumir`)

## Objetivo

Dos cambios al auto-resumidor de Jano (`tools/resumir.ts`):

1. Antes de arrancar a procesar la cola de videos (playlist YouTube) o artículos (Feedbin
   starred), mostrar primero cuántos hay y cuáles son, dejando que Cal elija cuál procesar —
   en vez de agarrar directo el primero (FIFO). Aplica tanto al cron diario 08:00 como a cuando
   Cal lo pide por chat ("revisá la playlist"/"revisá los starred").
2. El resumen entregado debe anteponer título + autor/canal antes del TL;DR — hoy no se
   incluye ninguno de los dos en el texto del resumen (el título sí aparece en la tarjeta de
   propuesta de más abajo, pero no en el mensaje del resumen en sí).

## Estado actual (verificado en código)

- `checkPlaylistsResumir`/`checkStarredResumir` (`resumir.ts:1106`, `:977`) encolan lo nuevo y
  llaman directo a `advancePlaylistQueue`/`advanceStarredQueue` (`:1054`, `:938`), que hacen
  `q.videos.shift()`/`q.items.shift()` — sacan el primero de la cola SIN mostrar antes cuántos
  hay ni sus títulos.
- El único "listado" existente es `estadoResumidor` (`:1161`), pero es de solo lectura (no tiene
  botones para elegir).
- El patrón "lista + conteo + botones numerados para elegir" YA existe y funciona bien en
  `reviewMeetings` (`agent-tools.ts:770-834`, flujo Meetings→Foco): botones `msel:{id}` (ID real,
  no posición) en filas de máx. 5, más una fila final `[✅ Todas]` (`msel:all`).
- Slot único de propuesta activa por chat (`pendingPath(chatId)`) — playlist y starred son colas
  independientes (`PLAYLIST_QUEUE`/`STARRED_QUEUE`) pero comparten ese slot; nunca hay 2
  propuestas en curso en paralelo. `maybeAdvance` (`:1096`) drena playlist primero, luego starred.
- Canal/autor: **no se extrae en ningún punto del pipeline hoy**.
  - Video: `~/.claude/scripts/audio-transcribe.sh` solo pide `%(title)s` a yt-dlp en la rama de
    captions (línea 41); la rama de descarga+whisper (línea 58-75) ni siquiera extrae título.
  - Feedbin: `fetchStarredContent` (`resumir.ts:899`) solo destructura `title`/`content`/`summary`
    del JSON de Feedbin — el campo `author` que la API expone no se pide.
- El resumen final es un string markdown (`md`, de `splitMeta()`, `:252`) que pasa por
  `mdToTelegram()` (`:401`) y se trocea (`chunk()`, `:440`); el primer chunk edita el ancla en
  `run()` línea 550. El TL;DR es literalmente el primer bloque del `md` — prependear 2 líneas es
  simple, no hay HTML pre-armado por partes que lo bloquee.

## Diseño — Parte 1: selector de cola

### Nuevo callback prefix: `resu-pick:`

Formato: `resu-pick:{v|s}:{id}` (`v` = video/playlist, `s` = starred; `id` = `videoId` de YouTube
o `feedbinId` numérico — ambos caben cómodos en el límite de 64 bytes de Telegram) y
`resu-pick:{v|s}:all` / `resu-pick:{v|s}:none`.

### Nueva función: `buildQueueSelector(kind: 'v'|'s', items: PlaylistVideo[] | StarredItem[])`

Mismo patrón que `reviewMeetings`: header con emoji+conteo (🎬 para playlist, ⭐ para starred),
una línea numerada por ítem (título, recortado a un largo razonable), botones por ítem en filas
de máx. 5 (`resu-pick:{kind}:{id}`), fila final `[✅ Procesar todos]` (`resu-pick:{kind}:all`) +
`[❌ Ahora no]` (`resu-pick:{kind}:none`).

### Cambio en `checkPlaylistsResumir`/`checkStarredResumir`

Donde hoy llaman a `advance*Queue(deps, chatId, anchorMsgId)` directo (después de encolar y de
confirmar que no hay propuesta en curso), en su lugar: si `q.videos.length > 0` (o `items`), armar
y mandar/editar (según haya o no `anchorMsgId`) el selector en vez de arrancar solos. Sin
`anchorMsgId` (cron): `sendMessage` nuevo. Con `anchorMsgId` (tap on-demand): `editMessage`/
`setCardMessage` sobre ese mensaje.

### Nuevo callback handler (en `index.ts`, junto a los demás interceptados mecánicamente)

- `resu-pick:{kind}:{id}` → sacar ESE ítem específico de `PLAYLIST_QUEUE`/`STARRED_QUEUE` por id
  (`array.findIndex` + `splice`, no `shift()`), y arrancar a procesarlo exactamente como hace hoy
  `advancePlaylistQueue`/`advanceStarredQueue` después de su `shift()` (reservar el lock en
  `pendingPath`, editar el ancla a "Procesando...", etc.) — extraer esa lógica común a una función
  compartida que reciba el ítem ya elegido, para no duplicar código entre el camino FIFO y el
  camino "por id".
- `resu-pick:{kind}:all` → marcar modo "batch" para esa cola (ver abajo) y arrancar el FIFO normal
  de hoy (`shift()`).
- `resu-pick:{kind}:none` → editar el mensaje a algo tipo "Ok, seguís con {N} pendientes — pedime
  'revisá la playlist'/'revisá los starred' cuando quieras." Sin tocar la cola.

### Modo batch vs. selector (para `maybeAdvance`)

Cal puede elegir UN ítem puntual o "Procesar todos". Si elige uno puntual y, al resolverlo
(guardar/saltar), quedan más pendientes en esa misma cola, `maybeAdvance` debe **volver a mostrar
el selector** (no auto-continuar con un ítem al azar) — mismo espíritu que pidió Cal. Si en cambio
eligió "Procesar todos", `maybeAdvance` debe seguir drenando en FIFO automático sin volver a
preguntar, igual que el comportamiento de hoy.

Implementación: un flag de modo persistido junto a la cola (agregar `mode?: 'select'|'batch'` al
JSON de `PLAYLIST_QUEUE`/`STARRED_QUEUE`, default ausente = `'select'`). Se setea a `'batch'` al
tocar `resu-pick:{kind}:all`; se resetea a ausente/`'select'` cuando la cola queda vacía (para que
la próxima tanda de items nuevos vuelva a preguntar).

`maybeAdvance` (`:1096`): para cada cola con items, si `mode === 'batch'` → `advance*Queue` (FIFO,
como hoy); si no → mostrar el selector de nuevo (mismo `buildQueueSelector`, como mensaje nuevo ya
que no hay tap/ancla en este punto — se llama después de resolver la propuesta anterior).

## Diseño — Parte 2: título + autor/canal antes del TL;DR

### Extracción de metadata

- **`~/.claude/scripts/audio-transcribe.sh`** (rama YouTube-captions, línea 41-42): agregar
  `%(uploader)s` al `--print` (ej. `--print "%(title)s\n%(uploader)s"` y parsear las 2 líneas, o
  dos `--print` separados) e incluir `"channel"` en el JSON de salida.
- **Misma rama, descarga+whisper (línea 58-75, sin título hoy):** agregar un `--print
  "%(title)s\n%(uploader)s"` (solo si el input es YouTube — para podcasts/archivos locales no
  aplica) ANTES o junto a la descarga, e incluir ambos campos (`title`, `channel`) en el JSON
  final de esa rama también, que hoy no tiene ninguno de los dos.
- **`fetchStarredContent`** (`resumir.ts:899`): agregar `author` a la destructuración del JSON de
  Feedbin (`d.author`) y devolverlo en el objeto de retorno (`{ text, title, author? }`).
- **`run()`** (`resumir.ts:457`): agregar una variable `docAuthor` análoga a `docTitle` (línea
  492), poblada desde `r.channel` (video/podcast) o `opts.prefetched.author` (starred). Los
  artículos vía `safari-fetch.mjs` (kind `"article"`) no tienen autor estructurado hoy — dejar
  `docAuthor` vacío en ese caso (no bloquea nada, el prepend es condicional).

### Dónde anteponer el texto

En `run()`, justo antes de `const parts = chunk(mdToTelegram(md), TG_MAX);` (línea 549): si hay
`docTitle` y/o `docAuthor`, anteponer 1-2 líneas al `md` (o al resultado de `mdToTelegram(md)`,
lo que sea más simple de mantener) tipo:

```
<b>{docTitle}</b>
{emoji según kind} {docAuthor}

{resto del TL;DR sin cambios}
```

Con emoji distinto según `kind` (🎬 canal de YouTube, ⭐/📰 autor/fuente de artículo/Feedbin). Si
`docAuthor` viene vacío, solo la línea de título (o ninguna si tampoco hay título — libros
generados desde conocimiento del LLM, por ejemplo, no tienen ni uno ni otro estructurado).

## Testing

- `buildQueueSelector` es una función pura (dado un array de items, devuelve `{text, keyboard}`)
  — testeable directo sin mocks, igual que `formatExpenseSummary`/`confirmationKeyboard` en
  Pecunia. Casos: 1 item, varios items (verificar filas de máx 5), 0 items (no debería llamarse,
  pero verificar que no explota).
- La función que arma el prepend de título/autor (extraerla como helper puro, ej.
  `buildResumenHeader(title?, author?, kind)`) — testeable igual, casos: ambos presentes, solo
  título, ninguno.
- El resto (extracción de metadata desde yt-dlp/Feedbin, selección real de la cola) depende de
  procesos externos/filesystem — verificación manual + build limpio, mismo criterio que el resto
  de `resumir.ts` hoy (sin infraestructura de test para las partes I/O-heavy).

## Riesgos

- Cambiar el JSON de salida de `audio-transcribe.sh` (agregar campo `channel`) es compatible hacia
  atrás siempre que el código TS que lo consume trate el campo como opcional — no rompe otros
  consumidores del script si los hay (verificar antes de tocar si algo más además de `resumir.ts`
  llama a este script).
- El flag de modo (`mode` en el JSON de la cola) es un cambio de shape de archivo persistido en
  disco — si el archivo ya existe de una sesión anterior sin ese campo, debe tratarse como
  `undefined` (= `'select'` por default) sin romper el parseo (`readJsonSafe` ya tolera campos
  faltantes vía TypeScript optional, pero verificar que no se asuma el campo presente en ningún
  lado nuevo).
