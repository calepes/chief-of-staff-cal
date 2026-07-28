# Backlog local + Self-learning — Diseño

**Fecha:** 2026-07-28
**Pedido de Cal:** darle a Jano acceso para leer y escribir su backlog local ("sobre lo que yo le
proponga o él haga"), y sumar self-learning de las interacciones tomando como referencia el estado
del arte de Anthropic.

Son dos features independientes que comparten patrones (tarjeta `propose → botones`, callbacks
HEAVY con lock, cron nocturno). Se especifican juntas porque se implementan juntas, pero cada una
puede construirse y activarse sin la otra.

---

## Parte 1 — Backlog local

### Problema

A Cal se le ocurren ideas charlando con Jano por Telegram y hoy no hay forma de anotarlas: tiene que
acordarse y escribirlas después a mano en el `BACKLOG.md` del proyecto que corresponda. El pedido
ya estaba registrado en el propio `BACKLOG.md` de Jano (sesión 2026-07-25) con la duda abierta
"¿append-only o edición libre?".

### Decisiones tomadas

| Decisión | Elegido | Descartado |
|---|---|---|
| Nivel de escritura | Append de ítems nuevos + marcar existentes como `[x]` | Solo append (deja el tildado manual) · Edición libre (riesgo de corromper formato) |
| Alcance | Multi-proyecto, descubierto en vivo (14 hoy) | Solo Jano · Jano + índice general |
| Vista panorámica | `mapaBacklogs` — árbol completo con conteo por proyecto | — (pedido de Cal, agregado durante el diseño) |
| Confirmación | Tarjeta con botones antes de escribir | Escritura directa · Híbrido por destino |
| Git | **No commitea.** Deja el archivo modificado en el working tree | Auto-commit (contradice la regla de Cal: commits solo cuando él los pida) |

### Descubrimiento de backlogs

Los backlogs **se descubren en vivo**, no se listan a mano en el código: un `find` bajo
`~/Claude Projects` (`-maxdepth 4 -iname "backlog.md"`, excluyendo `node_modules`), cacheado 10
minutos en memoria del proceso. Un proyecto nuevo aparece solo, sin tocar código ni redeployar.

El patrón del `find` es exactamente el mismo que la validación de escritura (`/^backlog\.md$/i`),
a propósito: un solo criterio, imposible que el descubrimiento ofrezca algo que la escritura
después rechace. Nada de `BACKLOG*.md` — eso también matchearía `BACKLOGS.md` o `BACKLOG-viejo.md`.

La clave de cada backlog se deriva de su carpeta contenedora, normalizada (minúsculas, sin tildes,
sin espacios): `Personal/Apps/Aeropuertos Bolivia/BACKLOG.md` → `aeropuertos-bolivia`. Colisiones
se resuelven prefijando la carpeta padre.

**El control de seguridad no es la lista fija** — es el conjunto de invariantes que se verifican en
cada escritura:

1. El modelo pasa una **clave**, nunca una ruta. Clave desconocida → error.
2. El path resuelto con `realpathSync()` debe seguir cayendo dentro de `~/Claude Projects/`.
3. El basename debe matchear `/^backlog\.md$/i` — nada más se escribe jamás.

Esto es más robusto que una lista hardcodeada y además cumple el pedido de "desde el root hasta el
último proyecto": el mapa refleja la realidad del disco, no una foto vieja.

Al 2026-07-28 el descubrimiento devuelve catorce:

```
jano                  Personal/Agents/Jano/BACKLOG.md
vesta                 Personal/Agents/Vesta/BACKLOG.md
health                Personal/Agents/Health/BACKLOG.md
inversiones           Personal/Agents/Inversiones/BACKLOG.md
learning              Personal/Agents/Learning/BACKLOG.md
school                Personal/Agents/School/BACKLOG.md
yapito                Personal/Agents/Yapito/backlog.md       ← minúscula, ver gotcha
aeropuertos-bolivia   Personal/Apps/Aeropuertos Bolivia/BACKLOG.md
caltable              Personal/Apps/Caltable/BACKLOG.md
f1-dash               Personal/Apps/F1 Dash/BACKLOG.md
readwise              Personal/Apps/Readwise/BACKLOG.md
reembolsos-bolivia    Personal/Apps/Reembolsos Bolivia/BACKLOG.md
claude-code-setup     Claude Code Setup/BACKLOG.md
claude-projects       BACKLOG.md                              ← índice cross-proyecto (raíz)
```

El path real se conserva literal tal como lo devolvió el `find` — no se reconstruye el nombre del
archivo a partir de la clave, porque HFS+ es case-insensitive y `Yapito/backlog.md` matchearía dos
veces si se probaran ambas variantes (gotcha ya documentado en el CLAUDE.md global). Por eso el
descubrimiento usa `-iname` una sola vez y guarda lo encontrado, en vez de probar
`BACKLOG.md`/`backlog.md` por separado.

### Tools

**`mapaBacklogs({})`**

Vista panorámica de todos los backlogs del árbol, del root al último proyecto, con el conteo de
pendientes de cada uno. Es la puerta de entrada: Cal pregunta "¿qué tengo pendiente?" sin nombrar
proyecto, y de ahí baja al que le interese con `leerBacklog`.

Devuelve la jerarquía real de carpetas con su conteo, más totales. Formato en Telegram (lista con
bullets, no tabla `<pre>` — el árbol tiene una sola columna de datos y el `<pre>` se rompe en
pantallas angostas):

```
📋 Mapa de backlogs · 47 pendientes

<b>Raíz</b>
• 📋 General — 3
• 📋 Claude Code Setup — 2

<b>Agentes</b>
• 📋 Jano — 12
• 📋 Vesta — 5
• 📋 Health — 4
• 📋 Inversiones — 3
• 📋 Learning — 2
• 📋 School — 1
• 📋 Yapito — 0

<b>Apps</b>
• 📋 Readwise — 6
• 📋 Aeropuertos Bolivia — 4
• 📋 Caltable — 3
• 📋 F1 Dash — 2
• 📋 Reembolsos Bolivia — 0
```

Los backlogs con 0 pendientes se muestran igual — que un proyecto esté limpio es información útil.
El agrupamiento sale de la estructura de carpetas real (`Personal/Agents/` → "Agentes",
`Personal/Apps/` → "Apps", raíz → "Raíz"), no de una tabla mantenida a mano.

Costo: leer 14 archivos y contar líneas `- [ ]`. Solo se cuentan las líneas, no se cargan al
contexto — el resultado son ~15 líneas de texto, muy por debajo del umbral de persisted-output.

**`leerBacklog({ proyecto?: string })`**

Devuelve los pendientes del backlog indicado (default `jano`). Si se omite `proyecto`, devuelve
además la lista de claves disponibles.

Crítico: **devuelve una vista compacta, no el archivo crudo.** El `BACKLOG.md` de Jano son 287
líneas (~30 KB), por encima del umbral de ~25 KB que dispara el persisted-output loop del SDK
(gotcha conocido del repo: el resultado se persiste a `toolu_*.json` y el modelo reintenta la tool).
La vista compacta:

- Solo líneas `- [ ]` (pendientes). Los `- [x]` se omiten salvo que se pida explícitamente.
- Cada ítem se trunca a ~200 caracteres, conservando el texto en negrita del título si existe.
- Se agrupa por el `###` que lo contiene.
- Se antepone un conteo (`12 pendientes en 5 secciones`).

Mismo criterio que `compactJournalRows` en el Journal, y por la misma razón.

**`proponerItemBacklog({ proyecto, texto })`**

No escribe. Construye la tarjeta de confirmación y la manda al chat. El estado de la propuesta
(proyecto + texto + messageId) se guarda en CF KV con TTL 30 min, espejando `journal-store.ts`
(que a su vez espeja `proposal-store.ts` de Pecunia).

**`marcarBacklogHecho({ proyecto, item })`**

No escribe. Igual que la anterior, pero la tarjeta confirma un tildado. `item` es texto que debe
localizar una única línea `- [ ]`:

- 0 coincidencias → error explícito ("no encontré ese ítem"), nunca crea uno nuevo.
- ≥2 coincidencias → error explícito con las líneas candidatas, para que Cal desambigüe.
- 1 coincidencia → tarjeta mostrando la línea exacta que se va a tildar.

Fallar explícito antes que adivinar: es el mismo criterio que se aplicó en el parser de Lending
(ancla de "EN PROCESO") y en `parseBcbpEssentials`.

### Escritura

Al confirmar, `appendBacklogItem` inserta bajo una sección fechada:

```markdown
### Surgió en sesión 2026-07-28
- [ ] **Texto del ítem tal como Cal lo dictó**
```

Si ya existe una sección `### Surgió en sesión <hoy>`, agrega ahí en vez de crear otra. La sección
nueva se inserta **inmediatamente después del encabezado `## Pendientes`** si existe; si no, al
final del archivo. Nunca se toca contenido preexistente salvo el tildado puntual de
`marcarBacklogHecho`, que es un reemplazo de una sola línea localizada por igualdad exacta.

Escritura atómica: se escribe a un temporal en el mismo directorio y se hace `rename` sobre el
destino. Un daemon que muere a mitad de un `writeFileSync` no debe dejar un `BACKLOG.md` truncado.

### Seguridad

- El modelo nunca provee un path. Solo una clave de la tabla; una clave desconocida es un error.
- `realpathSync()` sobre el path resuelto antes de escribir, y se verifica que el resultado siga
  cayendo dentro de `~/Claude Projects/`. La lección viene de `consultar-json.ts`: el regex de
  allowlist de `read-persisted.ts` acepta `..` dentro de sus segmentos, así que resolver primero
  es lo que colapsa el `..` y además sigue symlinks.
- No hay borrado. `marcarBacklogHecho` tilda, no elimina — el único cambio destructivo posible es
  convertir `[ ]` en `[x]`, reversible a mano.

### UX (Telegram)

Sigue el skill `telegram-bot-ux`. Parse mode HTML, bullets `•`, sin separadores Markdown.

```
📝 Nueva idea para el backlog

📁 Jano
«Tool para que Jano lea el backlog de cualquier proyecto»

[✅ Guardar] [✏️ Editar texto]
[📁 Cambiar proyecto] [❌ Descartar]
```

Emojis de dominio (extensión del lexicon, ninguno decorativo): `📝` ítem de backlog · `📁`
proyecto/destino · `☑️` marcar hecho · `📋` backlog / listado de pendientes.

`[📁 Cambiar proyecto]` abre un selector con las claves descubiertas, ordenadas por cantidad de
pendientes (los proyectos activos primero); `[✏️ Editar texto]` va por LLM (Cal dicta la
corrección), el resto son callbacks mecánicos.

### Routing de callbacks

Prefijo `bklg:`. **Debe rutearse arriba del `startsWith("j:")` genérico** en `index.ts` si en algún
momento comparte prefijo — ese bloque retorna incondicionalmente, y un callback puesto abajo queda
como código muerto sin dejar rastro en logs (encontrado en el Journal el 2026-07-27, antes de
producción).

Todos los `bklg:*` son **HEAVY** (escriben a disco) → van con `tryAcquireLock`/`releaseLock` de
`cf-kv.ts`, mismo patrón que `mlog:`/`mskip:`/`msel:`. TTL del lock 60 s — Cloudflare KV rechaza
`expiration_ttl` menor con un 400 no capturado que rompe el callback entero en silencio.

---

## Parte 2 — Self-learning

### Problema

El loop de aprendizaje **ya existe y está cerrado**: `mcp__agent-learnings__addLearning` escribe a
`~/.cos-agent/learnings.md`, y `buildLearningsSection()` (`daemon-v2/src/learnings.ts`) inyecta ese
archivo en el system prompt de cada turno.

Está muerto: **4 entries, la última del 2026-05-06** — casi tres meses sin capturar nada.

La causa no es falta de infraestructura sino **quién dispara la escritura**: hoy es el propio
modelo, en medio del turno, mientras resuelve otra cosa. El system prompt le pide que llame
`addLearning` "cuando detecte algo genuinamente nuevo", y en la práctica casi nunca lo hace porque
está ocupado con la tarea real. Es el modo de falla que la literatura de context engineering de
Anthropic describe: la reflexión compite con la ejecución y pierde siempre.

### Estado del arte consultado

- **Memory tool (`memory_20250818`)** — Anthropic. Memoria como archivos que el modelo lee y
  escribe entre sesiones, ejecutada del lado del cliente. Jano ya tiene el equivalente casero
  (`learnings.md` + `buildLearningsSection`), así que no aporta arquitectura nueva acá.
- **"Dreaming"** (Anthropic, 2026) — un pase en background revisa sesiones pasadas, extrae
  patrones y **reescribe** la memoria sin esperar que un humano diga qué arreglar. Ese es el
  patrón que se adopta: reflexión fuera del turno, y consolidación además de escritura.
- **Effective context engineering for AI agents** (Anthropic) — el note-taking persistente y la
  compactación son las dos herramientas para tareas largas; el equilibrio recall/precisión es el
  criterio de diseño. De ahí sale el presupuesto de tokens de más abajo.

### Arquitectura

```
22:00 La Paz (cron interno node-cron)
  │
  ├─ lee los .jsonl de sesiones del daemon del día
  │     (el SDK ya los persiste — ver session-store.ts)
  │
  ├─ Haiku · maxTurns:1 · sin tools
  │     (mismo patrón que compact.ts y journal-enrich.ts)
  │
  ├─ extrae candidatos + dedupe contra learnings existentes
  │
  └─ tarjeta selector en Telegram → Cal aprueba → se escribe
```

**Por qué los `.jsonl` y no el historial de texto de CF KV:** el KV guarda solo el texto de la
conversación. Los `.jsonl` traen las tool calls con sus parámetros y sus errores crudos — que es
exactamente de donde salen los "errores operativos propios" (tool que falla, parámetro que no
acepta, camino que no funciona). Cal nunca los va a notar por su cuenta; son invisibles desde
Telegram.

### Gotcha crítico: aislar las sesiones del daemon

Las sesiones del daemon de Jano y las sesiones **interactivas de Claude Code sobre este repo**
comparten el mismo directorio:

```
~/.claude/projects/-Users-calepes-Claude-Projects-Personal-Agents-Jano/*.jsonl
```

Leer el directorio entero mezclaría las charlas de Cal por Telegram con sus sesiones de desarrollo,
produciendo learnings sin sentido para el bot ("Cal prefiere que los tests corran antes del
commit").

**Solución:** `session-store.ts` pasa a acumular un registro append-only de los sessionIds que el
daemon realmente usó — `~/.cos-agent/sessions-log.jsonl`, una línea por sesión con
`{ sessionId, chatId, startedAt }`. Hoy `sessions.json` guarda solo la sesión *vigente* por chat,
y la pierde al rotar (techo de 20 turnos o TTL de 12 h), así que no sirve como fuente histórica.

El pase nocturno lee **solo** los `.jsonl` cuyo nombre está en ese registro y cuya fecha cae en el
día. El registro se poda a 30 días en el mismo pase.

### Qué se aprende — cuatro tags

Un solo archivo, con tag por categoría:

```
- [2026-07-28] [pref]  Cal quiere el total antes del desglose, no al revés
- [2026-07-28] [hecho] El pediatra de las niñas atiende en Equipetrol
- [2026-07-28] [err]   notionApi: el body va como objeto, no como string
- [2026-07-28] [flujo] Tras la card de KPIs suele pedir el detalle de afiliaciones
```

| Tag | Qué captura |
|---|---|
| `pref` | Preferencias de estilo y formato de Cal |
| `hecho` | Datos no obvios sobre Cal, su familia, su contexto |
| `err` | Errores operativos propios de Jano — tool que falló y por qué |
| `flujo` | Secuencias repetidas que Jano puede anticipar |

Un archivo con tags, y no cuatro archivos, porque `buildLearningsSection` inyecta todo junto de
todas formas y los tags permiten filtrar después sin migrar nada.

### Prompt de extracción (Haiku)

Entrada: las conversaciones del día, ya recortadas (mensajes de Cal, respuestas de Jano, y para
cada tool call solo `name` + `is_error` + el mensaje de error si lo hubo — nunca el payload
completo, que satura sin aportar).

Salida: JSON con candidatos `{ tag, texto, evidencia }`, donde `evidencia` es la cita corta de la
conversación que lo justifica (se muestra en la tarjeta, no se guarda en el archivo).

Reglas en el prompt, todas para maximizar precisión sobre recall:

- Máximo 2 líneas por learning.
- Nada que ya esté descrito en el system prompt o en un learning existente (se le pasa la lista
  actual para que deduplique).
- Nada que sea cierto una sola vez (un pedido puntual no es una preferencia).
- Si no hay nada que valga, devolver lista vacía. **Devolver vacío es el resultado esperado la
  mayoría de los días** — decirlo explícito, porque un extractor sin esta instrucción inventa
  learnings para justificar su existencia.

### Aprobación

Tarjeta selector, mismo patrón que `journal-sweep.ts`:

```
🌙 Reflexión del día

3 aprendizajes candidatos:

1️⃣ 🎯 «Cal quiere el total antes del desglose»
2️⃣ 🔧 «notionApi: body como objeto, no string»
3️⃣ 🧠 «El colegio cierra la última semana de julio»

[✅ Guardar todos] [🔍 Uno a uno] [❌ Ninguno]
```

Emojis de dominio: `🌙` reflexión nocturna · `🎯` preferencia · `🧠` hecho · `🔧` error operativo ·
`🔁` flujo · `🧹` poda. Ninguno decorativo — cada uno mapea a un tag real del archivo.

Callbacks `lrn:*`, HEAVY, con lock, ruteados arriba del `j:` genérico. Dedup en CF KV por fecha
(TTL 7 días), igual que el barrido del Journal.

### Camino manual

"Jano, recuerda que…" → captura al toque, sin esperar a la noche. Reusa
`mcp__agent-learnings__addLearning`, agregándole el parámetro `tag`. Se responde con un ack breve
(`🧠 Anotado.`), sin tarjeta — Cal ya decidió, no hay nada que aprobar.

### Consolidación y presupuesto

El archivo entero entra al system prompt en cada turno, y el system prompt de Jano ya pesa 18-20 K
tokens. A ~50 tokens por learning y ~2 aprobados por día, en seis meses serían ~18 K tokens
adicionales fijos — habría duplicado el prompt. Esto no es hipotético: la causa raíz estructural
de los cuatro episodios de "Autocompact is thrashing" fue exactamente material fijo excesivo
reenviado en cada una de las ~7-12 llamadas internas por turno.

Dos mecanismos, en orden de importancia:

**1. Consolidación (lo que de verdad mantiene el archivo chico).** El mismo pase nocturno detecta
learnings que dicen lo mismo con palabras distintas y propone fundirlos en uno, y detecta
obsoletos (contradichos por uno más nuevo, o referidos a una tool que ya no existe) y propone
archivarlos a `learnings-archive.md` — que **no** se inyecta en el prompt. Esto es la otra mitad
del patrón "Dreaming": no solo escribir memoria, reescribirla.

**2. Presupuesto blando de ~4 K tokens** (≈80-100 entries). Cuando los learnings activos lo
superan, la tarjeta nocturna lo indica y propone qué podar. **Nunca corta solo.** Es un semáforo,
no un candado: si Cal ignora el aviso, el archivo sigue creciendo y sigue funcionando. Se eligió
así explícitamente por sobre un tope duro por conteo, que sería un número arbitrario y borraría
learnings buenos por antigüedad en vez de por utilidad.

El conteo de tokens se estima por caracteres (`chars / 4`), suficiente para un semáforo; no
justifica una dependencia de tokenizer.

### Costo

Una llamada a Haiku por día, con entrada recortada. Despreciable frente al presupuesto de Claude
Max de Cal.

---

## UX — aplicación del skill `telegram-bot-ux`

El checklist del skill se corrió sobre las tarjetas de las dos partes, no solo se lo referenció.
Esto es lo que salió.

### Composición por building blocks

Cada flujo se expresa con los bloques del framework canónico del skill (B1-B8, R1-R3), no como
diseño artesanal:

| Flujo | Composición |
|---|---|
| Ver el mapa / leer un backlog | `R1+B1` — el placeholder `⏳` se edita con el resultado. Sin botones: es informativo. |
| Anotar un ítem | `B1` (tarjeta propuesta) → `B3+B4` (picker de destino) → `B5` (si Cal usa el escape de texto) → `B2a` (guardado) |
| Marcar hecho | `B1` → `B2a` guardado · `B2c` si el ítem no existe o es ambiguo |
| Reflexión nocturna | proactiva `✚` (mensaje nuevo, no hay ancla previa) → `B8` (consolidación N-items) → `B2a` |
| Uno a uno | `B8` interno: el card madre se edita por ítem, nunca abre mensajes sueltos |

### Correcciones que salieron de correr el checklist

Tres cosas del diseño original violaban el skill y se arreglaron antes de escribir una línea de
código:

1. **El picker de destino rompía el límite de teclado de Telegram.** El diseño original ponía una
   fila por proyecto: con 14 backlogs (y creciendo) daban 14 filas, contra el máximo de 4 filas /
   12 botones — arriba de eso hay stutter en iOS. Corregido a los 6 de más pendientes en 3 filas
   de 2, más una fila de escape `✍️ Otro proyecto` — bloque B3, que exige que el escape **siempre**
   esté presente. Los labels se truncan a 16 caracteres para no hacer wrap en mobile.

2. **La tarjeta de reflexión numeraba con emojis `1️⃣`-`🔟`.** No están en el lexicon, y el propio
   Jano ya resolvió esto: `renderSweepSelector` del Journal numera en texto plano y corta a 5
   visibles. Alineado a ese patrón, incluido el `(y N más)`.

3. **Cinco emojis no estaban en el lexicon** (`📝 📁 ☑️ 🔧 🧹`). Agregados a
   `~/.claude/skills/telegram-bot-ux/references/lexicon.md` en la tabla de CoS, como exige el
   skill ("si un bot necesita un emoji nuevo, agregar fila aquí y al CLAUDE.md del proyecto").
   `🔁` quedó documentado con sus **dos** contextos (TRX en reportes de KPIs, y "flujo repetido" en
   learnings) dejando explícito que nunca coexisten en un mismo mensaje.

### Reglas verificadas, ya cumplidas por el diseño

- **Parse mode HTML**, escapando solo `< > &`. Bullets `•`, nunca `-`. Sin separadores `---`.
- **Sin bloques `<pre>`**: el mapa de backlogs tiene una sola columna de datos, así que va como
  lista agrupada con `<b>` por categoría — el skill prefiere lista sobre tabla salvo que la
  densidad de columnas lo justifique.
- **`answerCallbackQuery` inmediato** (regla R3) en los dos routings, antes de cualquier trabajo.
- **Teclado vacío explícito** (`{inline_keyboard: []}`) en todo cierre de tarjeta, nunca omitido —
  el anti-pattern #23: `editMessageText` **preserva** el teclado viejo si `reply_markup` no viaja
  en el request. Hay un test dedicado a esto en cada plan.
- **Lock anti-doble-tap** en todos los callbacks que escriben (anti-pattern #25), con
  `releaseLock` en un `finally` que envuelve el trabajo async completo.
- **Una sola tarjeta por interacción**, editada por fases. Las tools que mandan tarjeta devuelven
  "no generes texto" y el daemon borra el placeholder al recibir reply vacío (verificado en
  `index.ts:1196`) — evita el anti-pattern #16, LLM y tool escribiendo en paralelo.
- **`callback_data` ≤ 64 bytes**: el peor caso es `bklg:destpick:{8}:{key}` con la clave más
  larga. Hay un test que lo verifica en vez de asumirlo.
- **Español neutro**, sin voseo, en todo texto visible.

### Gap consciente

`proponerItemBacklog` manda la tarjeta con `tgSend` (mensaje nuevo) en vez de editar el
placeholder del turno. Es el patrón establecido del bot — lo mismo hacen el resumidor y el
Journal — y funciona porque el daemon borra el placeholder cuando el reply del LLM viene vacío.
No es una violación del anti-pattern #11 (que aplica a pickers *dentro* de un flujo con
`state.messageId` vivo), pero depende de que el LLM efectivamente devuelva vacío. Por eso la
instrucción está tanto en el retorno de la tool como en el system prompt.

## Riesgos aceptados

| Riesgo | Mitigación | Estado |
|---|---|---|
| El working tree de los repos queda sucio tras escribir un backlog | Ninguna — decisión explícita de Cal (sin auto-commit) | Aceptado |
| Un `backlog.md` nuevo en el árbol se vuelve escribible sin revisión | Los tres invariantes de escritura siguen aplicando; el árbol es de Cal | Aceptado |
| El extractor inventa learnings de baja calidad | Prompt con precisión sobre recall + aprobación de Cal en cada uno | Mitigado |
| Learnings contradictorios acumulados degradan el comportamiento | Consolidación nocturna detecta y propone fundir | Mitigado |
| El pase nocturno lee sesiones de desarrollo, no de Telegram | Registro `sessions-log.jsonl` de sessionIds propios del daemon | Mitigado |
| El daemon muere a mitad de escribir un backlog | Escritura atómica (temporal + rename) | Mitigado |
| Cal ignora el aviso de presupuesto y el prompt crece | Ninguna — el semáforo es deliberadamente blando | Aceptado |

## Fuera de alcance

- Edición libre del `BACKLOG.md` (reordenar, reagrupar, borrar ítems).
- Backlogs de proyectos fuera de `~/Claude Projects/`.
- Replicar el self-learning en Vesta o Pecunia — se evalúa después de que funcione acá.
- Aprendizaje que modifique el system prompt más allá de la sección de learnings.
- Sincronización de learnings entre agentes (el MCP `agent-learnings` ya separa por agente y así
  se queda).

## Verificación

Cada pieza se construye con tests, siguiendo el estándar del repo:

- **Backlog:** descubrimiento sobre un árbol de prueba (incluye un `backlog.md` en minúscula y un
  proyecto nuevo que debe aparecer sin tocar código); derivación de claves y resolución de
  colisiones; `mapaBacklogs` con conteos y agrupamiento correctos, incluyendo un proyecto en 0;
  vista compacta sobre el `BACKLOG.md` real de 287 líneas (verificar que quede bajo 25 KB); append
  que reusa la sección del día; `marcarBacklogHecho` con 0, 1 y ≥2 coincidencias; path traversal
  (`../../etc/passwd` como clave, y un symlink que apunta fuera de `~/Claude Projects`) rechazado;
  un archivo llamado `backlog.md.bak` o `BACKLOGS.md` **no** debe ser escribible; escritura atómica.
- **Learnings:** filtro de sessionIds (una sesión interactiva de Claude Code en el mismo directorio
  debe quedar excluida); extractor devolviendo lista vacía; dedupe contra learnings existentes;
  estimación de tokens y disparo del semáforo; consolidación de dos learnings equivalentes.

Verificación end-to-end antes de dar por cerrado: dictar una idea real por Telegram y confirmar
que aparece en el archivo correcto; dejar correr un pase nocturno real y revisar los candidatos.
