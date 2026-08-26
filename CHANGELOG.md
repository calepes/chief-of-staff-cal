# CHANGELOG — Jano

## 2026-08-26

### Fix (infra) — Journal entries perdidos durante un corte de webhook de ~8.5h
Cal: *"Mandé un entry y no hizo el flujo"*. El log mostraba `skip_message: unsupported kind` justo
en la ventana en la que había mandado el texto, lo cual no cuadraba — un mensaje de texto plano
siempre llena `message.text`. La investigación real necesitó bajar hasta la capa del Worker.

- **Root cause de la ventana rota (22:15→06:53, ~8.5h):** un blip de Cloudflare (`Bad Gateway` al
  validar la URL del webhook durante un `setWebhook`) coincidió con que la Mac perdió conectividad
  saliente hacia `api.telegram.org` por horas (mismo síntoma que el gotcha de SNI filtering ya
  documentado). El watchdog del webhook corre LOCAL en la Mac — sin esa conectividad no podía ni
  diagnosticar ni reintentar arreglar nada, aunque corra cada 1 min. Los `skip_message` que sí
  aparecieron en el log eran ruido de esa ventana (updates corruptos/reintentados de Telegram), no
  el journal de Cal — ese directamente nunca llegó a la cola.
- **Diagnóstico en vivo:** `wrangler tail` sobre `cos-agent-worker` + un `console.log` temporal del
  `update` crudo en `worker-v2/src/index.ts` (revertido y redeployado limpio al terminar) —
  confirmó que, con la infra sana, un mensaje de texto normal con prefijo `Journal:` guarda
  perfecto (`journal_saved`, entrada real en Notion). No había ningún bug en `journal-capture.ts`
  ni en la clasificación de `message.text`/`voice`/`photo`/`document` de `index.ts` — el problema
  fue 100% la ventana de conectividad.
- **No se tocó código de journal.** El único cambio real de este incidente es la mitigación de
  abajo.

### Feature — Alerta proactiva si el webhook lleva roto >10 min
Mismo incidente: no había forma de que Cal se enterara de que el webhook estaba roto sin mandar
un mensaje primero (y descubrir que no pasa nada). `scheduleWebhookWatchdog()`/`ensureWebhook()`
(`index.ts`) ahora trackea desde cuándo no puede confirmar el webhook sano.

- **Bot separado para el aviso** (@ClaudeCalbot / `notifications`, token `NOTIF_BOT_TOKEN` — ya en
  `apps.env`, sin secretos nuevos que agregar): si el webhook de Jano está roto, un aviso por el
  MISMO bot no serviría de nada. No cubre el caso "la Mac entera sin red hacia Telegram" (mismo
  path para ambos bots, visto en este incidente) — sí cubre el caso más común: el webhook se
  desincroniza con la Mac sana (blip del Worker, algo lo pisó).
- **Umbral 10 min, dedup + timestamp en CF KV** (`jano:webhook:brokenSince`/`jano:webhook:alerted`,
  TTL 24h) — evita spamear cada minuto mientras dure el corte, y avisa también al recuperarse.
  Mismo patrón que `health-sync-check.ts` (alerta de corte de sync de Apple Health).
- **2 bloqueantes encontrados por `daemon-health-reviewer` antes de mergear, corregidos:**
  (1) el primer intento usaba un `fetch` a mano sin validar `res.ok`/`data.ok` — reemplazado por
  `sendMessage()` de `@cos/shared` (ya usado en todo el resto del archivo, toma el token como
  parámetro), que sí valida y tira si Telegram rechaza el envío. (2) `markWebhookBroken()` marcaba
  `alerted=true` en KV sin importar si el envío realmente salió — exactamente el escenario que
  debía cubrir (un fallo de red o `NOTIF_BOT_TOKEN` vacío/rotado dejaría a Cal sin aviso por 24h,
  sin reintento). Fix: solo marcar `alerted` en éxito confirmado, mismo patrón que
  `health-sync-check.ts` ya documentaba en su propio comentario.
- Typecheck limpio, 916 tests OK, build + reinicio del daemon confirmados por Cal, arranque limpio
  verificado en logs.

## 2026-07-29

### UX — El reporte diario de KPIs (CSV) pasó de ~30 líneas a 2
Cal: *"repensemos esta notificación, es demasiado ruido"*, con el mensaje pegado: 27 fechas, cada
una repitiendo los mismos 9 nombres de campo. Es la tercera pasada de ruido sobre este mismo
reporte (las dos anteriores, 2026-07-24, habían limpiado la sección "Derivados"), pero esta vez el
problema era el bloque grande — y estaba **mal diagnosticado en el código**.

- **El "catch-up" no existía.** El comentario original trataba varias fechas en un tick como la
  excepción. Los logs dicen lo contrario: los últimos 5 `kpi_ingest_full_report` arrancaban todos
  en `2026-07-01`. El CSV del Self-Service trae el **mes-a-la-fecha completo todos los días**, así
  que la corrida NORMAL desglosaba ~27 fechas idénticas. La pared crecía un renglón por jornada y
  a fin de mes tocaba `MAX_REPORT_LINES` y se truncaba sola.
- **Dos líneas en el caso normal** (`✅ KPIs diarios · Self-Service` + `📅 {última} · {N} fechas ·
  {M} campos`). El desglose por fecha aparece solo bajo `⚠️ Revisar:` y solo para lo que se sale de
  la norma: fecha creada (registro nuevo), cero campos escritos, un conteo distinto al **modal** de
  la corrida — así se detecta una columna que dejó de venir —, columnas ilegibles o no mapeadas.
- **`formatSuccessReport()` recibe `CsvIngestRow[]`**, no strings ya formateados: decidir qué es
  anómalo exige los datos, no un texto armado. En el log estructurado el campo pasó de
  `ingestSummary` a `ingestRows` (romper greps viejos es el único costo; el detalle completo sigue
  ahí para debug).
- **`Derivados: • nada pendiente` dejó de imprimirse**, acá y en el reporte del PDF. Era una línea
  fija en cada corrida que nunca comunicó nada.

El principio que unifica los tres casos: **reportar la excepción, no la confirmación**. Si algo se
imprime siempre, no es información.

## 2026-07-28 (3)

### Feature — Tareas por mail: de "se crea sola" a "la confirmás vos", con cola
El pipeline de mails "(Tarea)" (implementado el mismo día, ver entrada 1) creaba la página de
Notion directo y avisaba después. Cal pidió cuatro cosas: **Sonnet** en la extracción, una
**tarjeta de confirmación** que muestre a quién está asignado + Fecha + Deadline con opción de
ajustar cada uno (estilo Pecunia), el listado de **People de Yape cacheado** para no ir a Notion, y
**botones de fecha** (hoy / esta semana / próxima / escribir). Sobre la marcha sumó: si llegan
varios mails juntos, **una cola** para procesarlos de a uno.

- **Crear al confirmar** (decisión explícita de Cal sobre la alternativa "crear y luego ajustar"):
  la propuesta vive 7 días en KV y la página nace al tocar `✅ Crear tarea`. El costo aceptado es
  que una propuesta ignorada es una tarea que no nace; por eso el mail **no se archiva** hasta
  crearla — la inbox es el respaldo.
- **Una tarjeta activa por vez.** El resto se encola guardando solo `{messageId, threadId, subject}`:
  el cuerpo, los adjuntos y la llamada a Sonnet se resuelven cuando el ítem llega al frente, así un
  tick con 5 mails no dispara 5 llamadas al modelo ni deja correos escritos en disco. `⏭️ Después`
  manda al final de la cola; al resolver, la siguiente llega como mensaje nuevo (un edit no
  notifica, y el punto es que Cal se entere).
- **Snapshot estático de 20 personas** (`task-people.ts`), ordenado por uso real en "Asignado a"
  sobre las 763 tareas de la DB. El picker pagina de a 6 sin tocar Notion (la DB People tiene 639
  filas); `✍️ Otro` resuelve primero contra el snapshot y solo consulta Notion si el nombre no
  está. Con 0 o 2+ coincidencias repregunta: nunca asigna a quien no era. Regenerable con
  `scripts/refresh-task-people.ts`.
- **Atajos de fecha al viernes** (hoy / viernes de esta semana / de la próxima / sin fecha /
  escribir), mismo set para Fecha y Deadline. En fin de semana "esta semana" salta al viernes
  siguiente: un atajo nunca propone una fecha ya pasada.
- **El texto libre solo consume el mensaje si parsea** como fecha o como nombre; si no, sigue su
  curso normal hacia el agente. Es la lección del modo journal, que intercepta todo mientras está
  abierto y ya se tragó un pedido real.

#### Lo que encontró el review de salud (tres pasadas) — dos bloqueantes y dos carreras
- **Cola trabada 7 días.** El orden era `active = ...` y después mandar la tarjeta. Un fallo de
  envío (blip de red, el SNI filtering ya documentado) dejaba `active` apuntando a una propuesta
  cuya tarjeta nunca llegó: el cron la veía viva por el TTL del KV, no proponía nada más, y todos
  los mails siguientes se acumulaban **sin ningún aviso**. Ahora se manda primero y se marca
  activo solo si el envío salió bien.
- **Tarea duplicada en Notion.** El botón `✅ Crear tarea` seguía visible durante todo el trabajo
  (adjuntos + página), que supera los 60 s del lock anti-doble-tap: un segundo toque creaba otra
  página. El fix real es quitar el teclado con un `⏳ Creando la tarea…` antes de arrancar; el
  guard de idempotencia por hilo (`threadPages`) cubre el `🔄 Reintentar` y cualquier reintento
  secuencial.
- **Dos promociones simultáneas.** El flag `running` del cron solo lo protege de sí mismo: los
  botones entran por otro camino. Toda promoción pasa ahora por una cadena serializada **con
  timeout de 120 s** — al ser un cuello de botella global, un solo await colgado (`extractTaskFields`
  no tiene timeout, y `sendMessage` de `shared-v2` es un `fetch` pelado) habría dejado esperando a
  todos los avances posteriores, incluidos los de los botones. Y `advanceTaskQueue` recibe el
  `proposalId` para liberar el turno **solo si sigue siendo el activo**: si no, un avance que llega
  tarde pisaba una tarjeta recién mandada y promovía otra más.
- **Sonnet quemado cada 15 minutos.** Con Telegram caído, el reintento rehacía Gmail + síntesis
  sobre el mismo correo en cada tick. La propuesta ya sintetizada queda cacheada en el ítem de la
  cola y se reusa.
- Menores con síntoma visible: el cuerpo del mail entra recortado a 40 K (la forma exacta que
  produjo los cuatro "Autocompact is thrashing"), `accionRequerida`/`contextoRelevante` se cortan
  a 1800 para no chocar con el límite de 2000 de Notion, la tarjeta muestra el conteo **real** de
  adjuntos subidos (Notion corta el upload en ~20 MB y decir "2 adjuntos" con la página vacía los
  daba por guardados), y `"gracias"`/`"ok"` dejaron de contar como nombre de persona.

**Estado:** 754 tests, typecheck y build limpios, daemon reiniciado. Verificado en vivo que la
búsqueda de Gmail devuelve los 6 correos "(Tarea)" con sus adjuntos; la tarjeta en sí no se probó
todavía porque esos 6 ya tenían tarea creada (queda en BACKLOG).

## 2026-07-28 (2)

### Feature — Self-learning: la reflexión sale del turno
- **Diagnóstico primero:** el loop de aprendizaje ya existía y estaba cerrado (`addLearning` →
  `~/.cos-agent/learnings.md` → system prompt), pero llevaba **4 entries en 3 meses**. No faltaba
  infraestructura: fallaba QUIÉN dispara la escritura. Se lo pedíamos al modelo en medio del turno,
  compitiendo con la tarea real, y perdía siempre.
- **El rediseño:** cron a las 22:00 (La Paz) lee las sesiones del día que el SDK ya persiste en
  `.jsonl`, las recorta, las pasa por una llamada acotada a Haiku (`maxTurns:1`, sin tools) cuyo
  único trabajo es reflexionar, deduplica contra lo ya guardado, y propone una tarjeta con botones.
  Solo lo aprobado se escribe. Más `recordarAprendizaje` para cuando Cal dice "recuerda que…".
- **Cuatro tags:** `pref` · `hecho` · `err` · `flujo`. Las 4 entries viejas sin tag se siguen
  parseando (caen a `hecho`) — romper con ellas habría significado perder lo único que existía.
- **Referencia:** el patrón viene del "Dreaming" de Anthropic (2026) — un pase en background que
  revisa sesiones, extrae patrones y reescribe la memoria sin esperar que un humano diga qué
  arreglar. Documentado en el spec.

#### Dos bugs que habrían hecho el feature inútil, ambos invisibles en verde
- **El system prompt se calculaba una sola vez al arrancar.** `BASE_OPTIONS` era un `const` de
  módulo, así que `buildLearningsSection()` corría al cargar el proceso y nunca más. Todo lo
  aprobado quedaba en el archivo sin influir en ningún turno hasta reiniciar el daemon — en un
  proceso que corre semanas, indefinido. Es un defecto **preexistente** (aplicaba igual a las 4
  entries viejas y probablemente explica en parte por qué el mecanismo se sentía muerto), pero este
  feature lo volvía inaceptable. Ahora se recalcula por turno.
- **`SDK_SESSIONS_DIR` apuntaba al directorio equivocado.** El SDK deriva la carpeta de sesiones del
  **cwd del proceso**, y el `WorkingDirectory` del plist es `.../Jano/daemon-v2` — o sea las
  sesiones del daemon están en `-...-Agents-Jano-daemon-v2`, no en `-...-Agents-Jano`, que es el de
  las sesiones interactivas de Claude Code. Los dos existen. Verificado con el `sessionId` real:
  **0 caracteres** contra el directorio hardcodeado, **16.461** contra el correcto. El modo de falla
  era silencioso — transcript vacío → `learning_reflect_empty` → ninguna tarjeta, idéntico a un día
  sin nada que aprender. El paso de verificación del plan comprobaba que el directorio *existiera*,
  no que fuera *el correcto*, y existe por el uso interactivo.

#### Otros hallazgos de los reviews
- **Punto ciego de 22:00 a medianoche:** el cron filtraba por día calendario, así que una sesión
  iniciada a las 22:30 no la leía ni el pase de ese día ni el del siguiente. Justo la franja en que
  Cal más usa el bot (hay sesiones reales arrancando 23:08). Corregido con ventana móvil de 24 h.
- **`✅ Guardar todos` guardaba lo que Cal nunca vio:** la tarjeta mostraba 5 y el botón persistía
  todos. Con el transcript acarreando material no confiable (Jano resume webs con `fetchAsUser`),
  ese era el camino por el que texto de una página podía fijarse sin haber sido leído. El batch
  ahora se recorta **al crearlo**.
- **`message.content` no siempre es un array:** en 144 casos sobre 40 sesiones reales viene como
  string plano, y todos son mensajes de usuario — la fuente principal de learnings de preferencia.
  El parser original los descartaba en silencio, con los tests en verde porque los fixtures solo
  cubrían la forma de array. Encontrado verificando el formato real antes de escribir el parser.
- **El ack no era auditable:** `recordarAprendizaje` escribe sin confirmación y el prompt le pedía
  al modelo responder solo "🧠 Anotado.". Ahora el ack muestra el texto guardado — es lo único que
  le permite a Cal ver qué se fijó en el comportamiento del bot.
- **`addLearning` seguía allowlisteada** pese a que el prompt la declaraba obsoleta. Con ToolSearch
  activo la prosa no alcanza: sacada de `agent-options.ts`.
- **La fecha en UTC apareció cuatro veces** en este trabajo (heading de sección, registro de
  sesiones, clave del cron, tool manual). Cal está en UTC-4 y usa el bot de noche, así que entre las
  20:00 y medianoche todo se fechaba al día siguiente. Todas corregidas con `nowInLaPaz`.

- **Archivos nuevos:** `learning-{types,file,transcript,extract,card,store,callbacks}.ts`,
  `session-log.ts`, `proactive/learning-reflect.ts`, todos con test.
- **Modificados:** `index.ts` (cron + routing `lrn:*` + recálculo del prompt), `agent-tools.ts`,
  `system-prompt.ts`, `agent-options.ts`, `learnings.ts`, `session-store.ts`.
- **632 tests en verde**, typecheck limpio.

## 2026-07-28

### Feature — Tools de backlog: Jano lee y escribe los `BACKLOG.md` de los proyectos de Cal
- **Motivo:** a Cal se le ocurren ideas charlando con Jano por Telegram y no tenía forma de
  anotarlas — tenía que acordarse y escribirlas después a mano. El pedido ya estaba registrado en
  el propio `BACKLOG.md` (sesión 2026-07-25) con la duda abierta "¿append-only o edición libre?".
  Durante el diseño Cal sumó el pedido de ver **el mapa completo, del root al último proyecto**.
- **Tres tools** (`agent-tools.ts`): `mapaBacklogs` (vista panorámica agrupada por Raíz/Agentes/Apps
  con conteo de pendientes), `leerBacklog` (pendientes de un proyecto, compactados) y
  `proponerItemBacklog` (propone agregar o tildar — **no escribe**, manda una tarjeta y Cal
  confirma con ✅).
- **Descubrimiento en vivo, no allowlist hardcodeada.** Un `find` cacheado 10 min sobre
  `~/Claude Projects` (profundidad 6, podando `node_modules`, `_archive`, `commands` y `.git`).
  Un proyecto nuevo aparece solo. La seguridad no la da una lista sino cuatro invariantes
  verificados en cada escritura: el modelo pasa una **clave** (nunca una ruta), el `realpathSync`
  debe caer dentro del root, el basename debe ser exactamente `backlog.md`, y el destino debe ser
  un archivo regular.
- **Solo dos escrituras posibles:** append bajo `### Surgió en sesión YYYY-MM-DD` y tildado
  `[ ]`→`[x]`. Nunca edición libre de líneas — el riesgo de que el modelo reformatee o pierda
  contenido de un archivo de 287 líneas no vale la flexibilidad (decisión de Cal). Escritura
  atómica (temporal + `rename`) porque el daemon corre semanas y muere por launchd sin aviso.
- **Tildado que falla explícito:** con 0 coincidencias avisa que no encontró el ítem; con ≥2 lista
  los candidatos y pide precisión. Nunca adivina cuál tildar.
- **Sin auto-commit** (decisión de Cal): el archivo queda modificado en el working tree del
  proyecto correspondiente.

#### Lo que encontraron los reviews (y no los tests)
Seis defectos reales que el plan no había capturado, todos verificados con pruebas antes de
arreglarlos:
- **Colisiones de clave perdían proyectos en silencio.** Con tres `Agents/Jano` en disco,
  `discoverBacklogs` devolvía **dos** entradas — la clave ya prefijada no se re-verificaba contra
  `seen`. Además, quién se quedaba con la clave pelada lo decidía el orden de `readdir` (verificado
  que NO es alfabético), así que una clave podía pasar a apuntar a otro proyecto tras un cambio en
  disco, con el mismo label en la tarjeta y sin forma de que Cal lo notara antes de aprobar.
  **Fix:** orden determinista por profundidad y nombre antes de asignar claves, más bucle hasta
  clave libre.
- **`asText(JSON.stringify(x))` cuando `asText` ya serializa** — exactamente el bug de doble-encode
  de `notionApi` documentado el 2026-07-27, a punto de reintroducirse en `leerBacklog`.
- **El botón `✏️ Editar texto` estaba muerto:** se emitía, tomaba el lock, se ackeaba, y moría en
  `if (action !== "save") return;` sin editar la tarjeta ni dejar log. Cal lo tocaba y no pasaba
  nada. Resuelto con el mismo patrón que el escape del picker de destino (quitar teclado + pedir el
  texto, que el LLM vuelve a proponer), sin inventar estado tipo `pendingEdit`.
- **Un directorio llamado `BACKLOG.md`** se descubría como proyecto válido y se devolvía como
  destino de escritura.
- **El `find` parseado por `\n` sin `-print0`** podía producir un path relativo, que `realpathSync`
  resuelve contra el cwd del daemon — y ese cwd vive DENTRO de `~/Claude Projects`.
- **Nombres de tool cortos en el system prompt.** Con `ToolSearch` activo, `mapaBacklogs` pelado no
  matchea; hay que usar `mcp__cos-tools__mapaBacklogs`. Es el modo de falla que quemó los 12 turnos
  del incidente del 2026-07-27.

#### Decisiones de diseño que quedaron escritas
- **`execFileSync` a propósito.** El módulo cita `consultar-json.ts` como estándar, y ese archivo
  documenta por qué NO usa llamadas síncronas. Acá se midió el `find` real: **10-70 ms**. Pasarlo a
  async obligaría a volver asíncrona la cadena entera (resolve, labels, tools, callbacks) por esos
  70 ms. Se queda síncrono, pero el **timeout bajó de 10 s a 2 s** — lo inaceptable no era el caso
  normal sino que el peor caso congelara el daemon diez segundos.
- **Clave y label salen del PROYECTO, no de la carpeta contenedora.** Al bajar a profundidad 6,
  derivarlos de la carpeta inmediata producía `📋 docs — 3` y `📋 agente — 2` en el mapa, y obligaba
  al modelo a pedir el backlog de Combustible con la clave `docs`. Ahora Pecunia es `pecunia`
  (aunque su backlog viva en `pfm-dashboard/`), y dos backlogs del mismo proyecto se desambiguan
  con la subcarpeta (`inversiones` / `inversiones-agente`).
- **UX según el skill `telegram-bot-ux`, corrida como checklist y no como referencia.** De ahí
  salieron: el tope de 6 opciones + escape `✍️` en el picker de destino (una fila por proyecto daba
  14 filas contra el máximo de 4 de Telegram), cinco emojis nuevos documentados en el lexicon
  (`📝 📁 ☑️ 🔧 🧹`), y la corrección de cinco textos que estaban en voseo.

- **Archivos nuevos:** `backlog-{types,card,store,callbacks}.ts`,
  `tools/backlog-{discovery,read,write}.ts`, todos con test.
- **Modificados:** `agent-tools.ts` (3 tools), `index.ts` (routing `bklg:*` con lock),
  `system-prompt.ts` (sección "Backlogs de proyectos").
- **Spec y plan:** `docs/superpowers/specs/2026-07-28-backlog-tool-y-self-learning-design.md` y
  `docs/superpowers/plans/2026-07-28-backlog-tools.md`.
- **528 tests en verde**, typecheck limpio.

## 2026-07-27

### Feature — Journal de reflexión (terapia): DB Notion + captura por Telegram
- **Motivo:** Cal está en terapia y quería un lugar donde descargar pensamientos sin fricción, que
  quedaran **tal cual** con fecha y hora, y que de esa descarga cruda salieran las reflexiones que
  valen la pena conservar. Hasta ahora eso vivía disperso entre párrafos sueltos en la página
  *Terapia CAL* y entradas cargadas a mano en **Resonate Calendar** (la DB de insights que Cal cura
  hace años).
- **Modelo:** DB nueva `Journal` (`3aac4876-09dd-81ee-8ead-f55a15074cab`) bajo la página *Mental
  Health*, con 10 propiedades y relación bidireccional a Resonate Calendar (`Journal` ↔ `Reflexión`).
  Reusa los catálogos existentes **Topics** y **Big Themes** en vez de inventar vocabulario nuevo.
  **El texto literal va al CUERPO de la página, no a una propiedad:** `rich_text` corta a 2000 chars
  y una descarga de voz larga perdería texto en silencio.
- **Captura en dos tiempos (la decisión central):** el paso 1 escribe la fila con el texto íntegro
  de forma **mecánica, sin LLM** (prefijo `journal:`/`diario:` o modo journal con el botón 📓); el
  paso 2 propone metadata con Haiku (`journal-enrich.ts`, patrón de `compact.ts`) sobre una tarjeta
  `propose → botones` copiada de Pecunia. Si el paso 2 falla, el pensamiento ya está a salvo. Eso es
  lo que hace que "Jano escribe tal cual" sea literal: el texto persistido nunca pasa por el modelo.
- **Destilación a Resonate:** checkpoint en el momento (la misma tarjeta se transforma) + barrido
  dominical de lo que quedó `Sin revisar`. Nuevo cron interno `scheduleJournalSweep()`
  (`0 19 * * 0`, La Paz) — **tercera excepción** a la arquitectura reactiva decidida el 2026-07-14.
- **Archivos nuevos:** `journal-{types,text,payloads,store,card,enrich,capture,callbacks,ids}.ts`,
  `tools/journal.ts`, `proactive/journal-sweep.ts`. Tool nueva `consultarJournal` (solo lectura).

### Hallazgos del `daemon-health-reviewer` (3 bloqueantes, resueltos antes de producción)
- **El botón 📓 del menú era código muerto.** `if (cb.data?.startsWith("j:"))` en `index.ts` retorna
  incondicionalmente; el handler de `j:journal` había quedado 39 líneas más abajo, inalcanzable, y
  sin dejar rastro en logs. Movido arriba, junto a `j:star`/`j:ytpl`, que están ahí por lo mismo.
- **`apply` no movía `Estado`.** Un pensamiento sin reflexión quedaba `Sin revisar` para siempre → el
  barrido se lo reproponía cada domingo, re-corriendo Haiku sobre metadata ya aplicada y pisándola.
- **`consultarJournal` disparaba el persisted-output loop.** Devolvía páginas completas de Notion
  (75-150 KB, contra el umbral de ~25 KB documentado). Ahora devuelve filas compactas.
- Más 6 warnings resueltos: la captura pasó a fire-and-forget (bloqueaba el poll loop secuencial
  ~10-20s por pensamiento), `enrichEntry` cierra su handle del SDK (corría 1 vez por pensamiento en
  un daemon que vive semanas), `fetchIndex` ya no cachea un índice vacío ante fallo de Notion, el
  deshacer restaura título y estado previos, y `sweep:all` quedó acotado a 5 por tanda.

### Validación contra el skill `telegram-bot-ux` (pedida por Cal)
- **Voseo en toda la copia de las tarjetas** ("Respondé", "Elegí", "Mandame", "Acá") — contra la
  regla de español neutro. Corregido.
- **Violación de la regla cardinal de feedback:** `createRawEntry` es un `spawnSync` de `ntn` de 1-3s
  y el primer mensaje salía *después*. Ahora typing pulse + placeholder antes de tocar Notion.
- Emojis de dominio del Journal documentados en `CLAUDE.md` (el lexicon del skill no los trae).
- **Desviación deliberada:** `✅ Revisar todos` manda una tarjeta por pensamiento en vez de
  consolidar en una sola ancla (bloque B8). Cada pensamiento necesita sus propios pickers de
  aprobación; consolidarlos es un rediseño, no un ajuste. Acotado a 5 por tanda.

### Dos problemas encontrados con datos reales, el mismo día
- **Permisos de Notion:** la DB se creó con el token de `ntn` (integración *Notion CLI interactivo*)
  pero el daemon usa otra (*Claude CoS*) → `404 object_not_found` en el primer guardado. No se puede
  arreglar por API (Notion no permite agregar integraciones a una página desde la API pública); Cal
  conectó a mano las 4 bases. Se agregaron al system prompt los IDs exactos con prohibición de
  `/v1/search`, para que el modelo no se ponga a buscar por todo Notion ahora que ve más.
- **El modo journal se tragó un pedido real.** Con la ventana de 2h abierta, "Dame el último card de
  lending" se guardó como pensamiento en vez de responderse — el riesgo que el spec ya declaraba,
  materializado el primer día. **TTL bajado de 2h a 30 min** (se refresca en cada guardado, así que
  una descarga larga no se corta) + botón `⏹️ Cerrar journal` en cada tarjeta guardada. La entrada
  espuria se borró con autorización de Cal.

### Pendientes conocidos (sin resolver, decisión de Cal)
- Sin idempotencia contra redelivery de la CF Queue: un batch que exceda los 30s de
  `visibility_timeout_ms` podría duplicar filas en la DB de terapia, en silencio.
- El picker de Topics no permite crear uno nuevo (`createTopic` existe pero no tiene call site).
- `Origen: "Sesión terapia"` no tiene UI — el modo siempre abre como `Texto`.
- El texto crudo del journal sí sale hacia la API de Anthropic en el paso de enriquecimiento.

## 2026-07-15

### Feature — Detección de cortes de sync de Apple Health (`getHealthSyncStatus`)
- **Motivo:** Cal solo usa Apple Watch (sin Strava/WHOOP/Oura/Hevy) y sincroniza vía Health Auto
  Export (iOS) → `health-worker` (CF). El corte real detectado: HAE solo exporta al abrir la app a
  mano si no se configura su automatización interna + Background App Refresh en iOS — sin forma de
  saber si se cortó silenciosamente.
- **Fix:** nueva tabla `sync_status` en D1 (`health-worker/migrations/0004_sync_status.sql`,
  aplicada directo con `d1 execute` porque `0002`/`0003` ya estaban aplicadas fuera del tracking de
  `wrangler d1 migrations` y no son idempotentes). `POST /ingest` ahora hace UPSERT del timestamp
  del servidor en cada recepción exitosa. Nuevo `GET /status` (+ tool `getHealthSyncStatus` en el
  MCP JSON-RPC del worker) devuelve `{lastIngestAt, hoursSinceLastIngest, lastMetricsCount,
  lastWorkoutsCount}`.
- **Wireado en Jano:** tool agregado al wrapper stdio (`mcp-servers/servers/health`), a
  `allowedTools` (`agent-options.ts`) y a `system-prompt.ts` (sección `## Salud`) — instruye avisar
  a Cal si `hoursSinceLastIngest` es `null` o >6h.
- **Decisión de scope:** implementado reactivo (tool consultable, ej. "¿está sincronizando bien mi
  salud?"), no proactivo — Jano sigue 100% reactivo por decisión de Cal del 2026-07-14 (0 crons
  internos activos). Si el corte se repite en la práctica, reconsiderar un cron dedicado.
- `daemon-health-reviewer` revisó el cambio completo (worker + migración + wrapper MCP + daemon) —
  sin bloqueantes. Worker deployado, migración aplicada, daemon reiniciado — arranque limpio
  confirmado (`state=running`).

## 2026-07-14 (auditoría de seguridad — C1 + C4)

### Fix — Allowlist de remitente en Telegram (C1)
- **Riesgo cerrado:** cualquier usuario que encontrara `@cal_jano_bot` tenía acceso completo a las
  164 tools (Gmail, Calendar, borrar notas/eventos, datos personales vía `generarQrAduanaBolivia`)
  — no había ninguna validación de `from.id` en la cadena worker→daemon.
- **Fix:** allowlist de remitente por `from.id`/`callback_query.from.id` agregada en
  `worker-v2/src/index.ts` (`/telegram/webhook`) y replicada como defensa en profundidad en
  `daemon-v2/src/index.ts` (`processMessage`).
- Fix ya desplegado (worker + daemon) antes de esta sesión.

### Fix — Retirada la tool `runBriefing` (C4)
- **Riesgo cerrado:** `runBriefing` spawneaba un subproceso `claude -p --dangerously-skip-permissions
  --allowedTools "Bash,..."` con prompt interpolado libre — escalada de privilegios real. Además
  estaba rota: las rutas que usaba (`Chief of Staff Cal`, `calepes.github.io`) ya no existen.
- **Fix:** eliminada la tool del registro (opción de menor riesgo vs. arreglar rutas + acotar el
  subprocess). Borrado `daemon-v2/src/tools/briefing.ts` completo; sacado el registro de la tool +
  import + `briefingDeps` de `agent-tools.ts`; sacada la mención de `TOOL_MESSAGES` en `agent.ts`;
  sacadas las 2 referencias en `system-prompt.ts`. `CLAUDE.md` actualizado (fuera del índice de
  tools). Build (`@cos/shared` + `@cos/daemon`) verificado limpio.
- Daemon reiniciado (`launchctl bootout`/`bootstrap`) — arranque limpio confirmado en
  `~/Library/Logs/cos-agent-v2.{out,err}.log`, sin referencias colgantes a `runBriefing`/`briefingDeps`.

Ambos fixes vienen de la auditoría de seguridad de todo el repo hecha el mismo día (agente de
solo lectura, modelo Fable) — ver `HANDOFF.md` para el detalle completo y los items pendientes
(C2, C3, moderados, menores).

## 2026-07-14

### Fix — Causa raíz estructural del "autocompact thrashing" recurrente + ToolSearch nativo

- **Investigación:** tercera recurrencia documentada del bug "Autocompact is thrashing" del SDK (tras 2 casos de FIFA el 2026-07-06; un cuarto caso más viejo, no documentado hasta ahora, encontrado en el propio `CHANGELOG.md`: Readwise sin `pageSize`, 2026-05-23). Esta vez en el flujo de check-in BoA, 2 turnos consecutivos colapsados. Decompilando strings del binario nativo del SDK (`claude-agent-sdk-darwin-arm64`) se encontró el mecanismo exacto: circuit breaker hardcodeado que aborta el turno si el contexto se recompacta y vuelve a tocar el umbral en <3 turnos internos, 3 veces seguidas. Causa raíz real: 164 tools permitidos en 13 MCP servers + system prompt (~18-20K tokens) se reenvían COMPLETOS en cada llamada interna del turno, dejando poco margen — confirmado con `cacheReadInputTokens` sumando 1.19M-1.37M en turnos de solo 6-7 tool calls.
- **Fix — `ToolSearch` (carga diferida de tools, nativa del SDK) desbloqueada:** sacada de `DISALLOWED_BUILTINS` (estaba ahí desde el commit inicial del daemon, 28-abr, sin relación con tool-bloat) y agregada a `CLAUDE_AI_COS_TOOLS` (`agent-options.ts`). El modelo ahora busca la tool que necesita (`{query}` → `tool_reference`) y carga solo su schema, en vez de los 164 completos siempre — mismo patrón que recomienda Anthropic en "code execution with MCP" / "Tool Search" para este problema. **Primer test real:** flujo BoA completo (Calendar + 3 tools boa-checkin + envío de documento, 9 tool calls) sin errores ni thrashing, `cacheReadInputTokens` 405K vs. 1.19M-1.37M de los turnos que colapsaron con carga comparable (~3x menos). Un solo caso confirmado — monitorear antes de darlo por resuelto del todo.
- **Fix defensivo en `agent.ts` (hallado por `daemon-health-reviewer`):** el SDK puede cortar un turno con `subtype:"success"` pero `terminal_reason:"tool_deferred"` (modelo intenta usar una tool diferida sin buscarla primero) — sin manejarlo, Cal recibiría una respuesta vacía/incompleta sin rastro en logs. Agregado chequeo de `terminal_reason`/`deferred_tool_use` con log `tool_deferred_unresolved` + mensaje de fallback visible. Agregada entrada de `"ToolSearch"` a `TOOL_MESSAGES`.
- **Riesgo aceptado, sin mitigar:** `ToolSearch` expone el universo completo de ~180 tools de OAuth Max (no solo las 164 curadas de Jano), confirmado empíricamente por el reviewer. Si `allowedTools` sigue haciendo enforcement al ejecutar (lo más probable), el peor caso es tool-calls desperdiciados en "permissions not granted" — vale monitorear.

### Fix — PNR de BoA no se recuperaba entre turnos (dato falso en system-prompt)

- **Bug encontrado probando el fix de arriba:** Cal pidió el boarding pass de un vuelo (resuelto bien, PNR encontrado vía Calendar) y a continuación, mismo chat, pidió cambiar el asiento — Jano respondió que no tenía el PNR "en esta sesión" y lo volvió a pedir, pese a que el vuelo ya estaba identificado. Verificado leyendo el KV real (`cos-ctx:{chatId}`) que el historial de texto SÍ persiste entre turnos (`state.ts`, hasta 40 mensajes) — el problema es que solo guarda el TEXTO de la conversación, nunca los parámetros crudos de una tool call, y la respuesta anterior mencionaba el número de vuelo pero no el PNR.
- **Causa raíz:** `system-prompt.ts` decía "El código de reserva (PNR) NO está en el calendario — pedíselo a Cal directo" — verificado en vivo contra Calendar que es FALSO: los eventos sincronizados por Flighty traen `"Booking Code: XXX"` en la descripción.
- **Fix:** corregida la afirmación falsa (Paso 1 de check-in, `system-prompt.ts`) + nota compartida antes de las 3 subsecciones "check-in YA hecho" (asiento/boarding pass/viajero frecuente) instruyendo re-buscar el vuelo en Calendar (`list_events` con `calendarId`+`fullText`+`startTime`/`endTime` acotado, nombrada explícita tras el review — `search_events` no sirve, no acepta esos parámetros) antes de volver a pedirle el PNR a Cal.

### Fix — Guía positiva de uso de ToolSearch + conversión completa a español neutro

- **Gap encontrado por `daemon-health-reviewer`:** tras desbloquear `ToolSearch`, el prompt solo la mencionaba en negativo (una prohibición vieja ya sacada) — sin instrucción positiva de cuándo/cómo usarla. Agregado párrafo al inicio de "## Tools disponibles" (`system-prompt.ts`): buscar tools no cargadas con `ToolSearch`, agrupar varias en una sola llamada separadas por coma (`select:tool1,tool2,tool3`, no una por una — cada llamada de más gasta un turno de los 12 de `maxTurns`), tope de 1 reintento antes de avisarle a Cal (mismo criterio que cerró el thrashing de FIFA), y aclaración de que `ToolSearch` no cuenta como "tool call de prueba" bajo la regla de sanity-checks.
- **Pedido de Cal — español neutro sí o sí:** todo el texto instruccional del system prompt (no solo lo que Jano le dice a Cal, ya declarado neutro desde antes) estaba escrito en voseo rioplatense ("buscá", "confirmá", "llamá", "pedile", etc.) en la mayoría de las secciones de dominio. Pasada completa de conversión voseo→tuteo en las 691 líneas (más densa en la sección BoA) — verificado con grep exhaustivo: 0 formas voseo remanentes, salvo la línea 26 que es intencional (ejemplo de qué NO usar). Dejadas sin tocar citas textuales de mensajes reales de Cal (esas sí pueden estar en cualquier registro).

## 2026-07-14 (continuación)

### Ops — Auto-resumidor de playlist/starred: cron diario apagado

- **Pedido de Cal:** apagado el cron `scheduleResumirPlaylist` (corría 1×/día a las 08:00, activo desde 2026-06-20). Jano queda 100% reactivo salvo el webhook watchdog (infra). Mismo patrón que los otros 2 crons ya desactivados (`scheduleFlightCheckin`, `scheduleFocoCheckinsLocal`): comentar la llamada en `loop()` (`index.ts`), función queda definida sin usar. Confirmado por `daemon-health-reviewer`: los botones ⭐ Starred / 🎬 Playlist del menú siguen funcionando on-demand igual, no dependen del cron.

### Fix — WarmQuery huérfano en 4 caminos de retorno temprano

- **Encontrado revisando un fix análogo en Pecunia (commit `4ccc44c`, mismo día):** en `processMessage`, `takeWarm()` se dispara al inicio del turno para solapar el arranque del subprocess del SDK con el preprocessing multimodal, pero 4 caminos de `return` temprano (falla al transcribir audio, falla al leer foto, falla al leer documento, sin texto tras el preprocessing) abandonaban el `warmPromise` sin cerrarlo nunca — el subprocess pre-warmeado quedaba corriendo huérfano indefinidamente. En Pecunia este mismo patrón rompía el turno SIGUIENTE ("No such tool available", 86 ocurrencias abr-jul) porque comparten un mcpServer singleton; en Jano no rompe el turno siguiente (cada `takeWarm()` ya usa un mcpServer fresco y aislado por diseño), pero el leak de subprocess/recursos igual aplica en un daemon que corre semanas sin reiniciar.
- **Fix:** agregada `discardWarm(warmPromise)` (usa `WarmQuery.close()`, documentado en el SDK exactamente para este caso: "Close the subprocess without sending a prompt") en los 4 `return` — todos verificados por `daemon-health-reviewer` como anteriores al `await warmPromise` real (línea ~825), así que nunca interrumpen un turno en curso.
- **Gap preexistente encontrado de paso, sin resolver:** el `try` externo de `processMessage` no tiene `catch` propio — una excepción real (no un `return`) lanzada antes de `await warmPromise` (ej. `state.load` o un `editMessage`/`sendMessage` sin `.catch()` en las ramas de voz/foto/documento) escapa sin capturar, deja el `warm` sin cerrar, Y deja a Cal con el placeholder "⏳ Procesando..." colgado sin mensaje de error (el daemon no crashea, el loop principal la atrapa más arriba, pero Cal nunca se entera). Documentado en el comentario de `discardWarm` (`index.ts`); no implementado — fuera del scope pedido.

## 2026-07-06

### Fix — Fuga de mensaje de diagnóstico interno del SDK a Telegram

- **Bug:** `agent.ts` extraía `finalText` de cualquier evento `{type:"result", subtype:"success"}` sin filtrar, asumiendo que "success" implica respuesta válida. En un turno real (Cal comparando stats FIFA de Suiza y Colombia), el modelo pasó el `fixtureId` de `getFixtures` (API-Football) como `matchId` a `getFifaMatchStats` (que espera el `matchId` interno de FIFA, sistema de IDs distinto) → 2 tool calls fallidos + reintentos → 8 tool calls en un turno sobre la sesión `warm` (que no resetea contexto entre turnos, `cacheReadInputTokens` 273K→540K→942K) → el SDK entró en auto-compact repetido y abortó devolviendo su propio texto de diagnóstico ("Autocompact is thrashing...") marcado `success`. El daemon lo reenvió tal cual a Cal.
- **Fix (2 partes):** `agent.ts` — `SDK_DIAGNOSTIC_PATTERNS` detecta el texto antes de devolver `reply`, lo reemplaza por un mensaje entendible + log `sdk_diagnostic_leak`. `system-prompt.ts` — documentada la sección "FIFA avanzadas" (antes inexistente), aclarando pasar siempre `teamA`/`teamB` y nunca `matchId` adivinado desde `getFixtures`.
- **Pendiente (decisión de Cal, fuera de scope):** la sesión `warm` sigue sin reseteo periódico entre turnos.

### Fix — Recurrencia del mismo día: causa raíz distinta

- **Bug:** el filtro de arriba funcionó (Cal recibió el fallback), pero el thrashing volvió a las pocas horas con "dame todas las stats FIFA de los partidos jugados de Suiza y Colombia": `getFixtures` (`worldcup` MCP) solo filtraba por `date`, no por equipo, así que el modelo adivinó rival+fecha de memoria 7 veces, falló 3, y ante cada fallo reintentó la misma búsqueda con variantes de ortografía (Uzbekistan/Uzbekistán, DR Congo/Congo DR/...) — 17 tool calls en 7 min.
- **Fix (2 partes):** `worldcup` MCP — `getFixtures` acepta `team?` y filtra client-side sobre la respuesta cacheada; sin partidos → error explícito. `system-prompt.ts` — instruye usar `getFixtures({team})` primero antes de `getFifaMatchStats` en loop, prohíbe reintentar la misma búsqueda con variantes de ortografía tras un fallo.
- **Lección:** el filtro de la fuga (fix anterior) es una red de seguridad, no una cura — cada thrashing puede tener causa raíz distinta mientras la sesión `warm` no tenga reseteo. (Tercera recurrencia + causa raíz estructural: ver entrada 2026-07-14 "Causa raíz estructural del autocompact thrashing".)

## 2026-07-03

### Feature — Resumidor: selector de cola antes de procesar + título/autor en el resumen

- **Selector de cola (playlist YouTube / starred Feedbin):** antes de arrancar a procesar de a
  uno (FIFO), `checkPlaylistsResumir`/`checkStarredResumir` ahora muestran primero una tarjeta con
  conteo + lista numerada + botones (`buildQueueSelector`, `tools/resumir.ts`) para que Cal elija
  QUÉ resumir — en vez de agarrar directo el primero. Aplica al cron 08:00 y a los botones
  ⭐/🎬 del menú (on-demand). Botones: uno por ítem (`resu-pick:{v|s}:{id}`, filas de máx 5),
  `[✅ Procesar todos]` (`resu-pick:{v|s}:all`, activa modo `batch` = FIFO automático de siempre
  hasta vaciar la cola) y `[❌ Ahora no]` (`resu-pick:{v|s}:none`, no toca la cola). El flag
  `mode?: "batch"` se persiste junto a la cola (`resumir-playlist-queue.json`/
  `resumir-starred-queue.json`) y se resetea al vaciarse, para que la próxima tanda vuelva a
  preguntar. `maybeAdvance` (tras resolver una propuesta) respeta el mismo criterio: sigue el FIFO
  si la cola está en modo batch, si no vuelve a mostrar el selector.
- **Callback `resu-pick:` mecánico (sin LLM):** interceptado en `index.ts` igual que
  `j:resu:save/skip/stop` — dispatcher único `handleQueuePick()` en `resumir.ts`. Mismo lock
  anti-doble-tap `(chatId, userId)` que ya usan `mlog:/mskip:/msel:` (`tryAcquireLock`/
  `releaseLock`, `cf-kv.ts`), reusado a propósito (no se creó un lock nuevo). Extraída la lógica
  de "arrancar UN ítem" a `startPlaylistItem`/`startStarredItem`, compartida entre el camino FIFO
  (`shift()`) y el camino "por id" (`findIndex`+`splice`, desde el pick puntual).
- **Bug bloqueante corregido antes de mergear (hallado por `daemon-health-reviewer`):** la primera
  versión del bloque `resu-pick:` en `index.ts` hacía `await handleQueuePick(...)`, que puede
  tardar minutos (transcribe+resume vía `run()`, hasta `TRANSCRIBE_TIMEOUT_MS`=10min) — awaitear
  ahí congela el loop secuencial del daemon (un solo `for` con `await processMessage`) para TODOS
  los chats hasta que termine. Fix: `void handleQueuePick(...).catch(...).finally(releaseLock)`,
  el mismo patrón fire-and-forget que ya usan `j:star`/`j:ytpl` (`void checkStarredResumir(...)`/
  `void checkPlaylistsResumir(...)`) unas líneas más abajo en el mismo archivo.
- **Título + autor/canal antes del TL;DR:** el resumen entregado ahora antepone
  `<b>{título}</b>` + `{emoji} {autor}` (🎬 canal de YouTube para video/podcast, 📰 fuente para
  artículo/libro) vía `buildResumenHeader()` (función pura, `tools/resumir.ts`) — antes no se
  incluía ninguno de los dos en el mensaje del resumen (solo el título aparecía en la tarjeta de
  propuesta, más abajo).
  - `audio-transcribe.sh` ahora pide también `%(uploader)s` a yt-dlp (rama captions Y rama
    descarga+whisper, esta última no traía metadata antes) → nuevo campo `channel` en el JSON de
    salida, best-effort (si el `--print` falla, queda ausente sin bloquear la transcripción).
  - `fetchStarredContent` (Feedbin) ahora también extrae `author` del JSON de la entrada.
- **Tests nuevos:** `tools/resumir.test.ts` (13 casos) — `buildResumenHeader` (título+autor,
  solo título, solo autor, ninguno, emoji por `kind`, escape HTML) y `buildQueueSelector` (1 item,
  7 items con paginado de filas de máx 5, ids string vs number, 0 items, truncado de títulos
  largos). Solo las funciones puras — la extracción real (yt-dlp/Feedbin/filesystem) sigue sin
  mocks, verificación manual + build limpio.
### Fix — falla al procesar una selección puntual ya no auto-avanza sola

- **Bug de diseño (reportado por Cal el mismo día, con un caso real: video en vivo sin
  transcripción utilizable):** si Cal elegía un ítem puntual del selector (`resu-pick:{v|s}:{id}`)
  y ese ítem fallaba al procesarse (sin captions/contenido, error de transcripción), el sistema
  auto-avanzaba solo al SIGUIENTE de la cola (comportamiento heredado del modo FIFO/batch) —
  contradice el propósito del selector: Cal eligió ESE, no "cualquiera que venga después".
- **Fix:** `startPlaylistItem`/`startStarredItem` reciben un flag `autoAdvanceOnFail`. En modo
  batch (`resu-pick:{v|s}:all`, FIFO de siempre) sigue siendo `true` — auto-avanza como antes. En
  una selección puntual es `false` — si falla, el ítem se devuelve al principio de la cola (no se
  pierde, no se des-estrella/saca de la playlist), se avisa a Cal explícitamente que falló y que
  NO se siguió con otro solo, y se lo invita a pedir el selector de nuevo para decidir.
- **Logging del motivo real de la falla:** el `catch` de `run()` en `startPlaylistItem`/
  `startStarredItem` tragaba el error en silencio — imposible diagnosticar por qué falló un ítem
  puntual. Ahora loguea `err.message` (`console.error`). Caso real que motivó esto: un video en
  vivo larguísimo — `audio-transcribe.sh` probado manualmente SÍ transcribe bien, la sospecha es
  que la transcripción resultante es tan larga que el resumen (`summarize()`, subprocess `claude
  -p`) excede `SUMMARIZE_TIMEOUT_SEC` (180s).

## 2026-06-21

### Feature — Enviar adjuntos de Notion por Telegram (`enviarArchivoNotion`)

- **Feature**: Jano ahora envía el archivo REAL (PDF/imagen) adjunto a una página de Notion como documento/foto en el chat, en vez de decir "no puedo enviar el adjunto interno". Reusa el patrón de Pecunia (`sendComprobante`): tool agéntica + envío por URL remota (Telegram descarga server-side).
- **Helpers**: `sendPhoto`/`sendDocument` agregados a `shared-v2/src/telegram.ts` (POST JSON, parse_mode HTML, retornan `{ message_id }`).
- **Módulo** `daemon-v2/src/tools/notion-files.ts` (**compartido con Vesta**, igual que `schedule-cal.ts` — al tocarlo copiar a ambos y rebuildar): `collectAttachments` (puro, resuelve propiedades tipo `files` + bloques `pdf`/`file`/`image`, dedup por url) + `fetchNotionAttachments` (I/O vía `callNtn`, resuelve URL fresca al momento de enviar para evitar expiración de las firmas S3 de Notion). Tests en `notion-files.test.ts` (6).
- **Tool** `enviarArchivoNotion({ pageId, caption? })` en `agent-tools.ts` (prefijo `mcp__cos-tools__`): decide foto vs documento, caption (escapado HTML) solo en el primero, usa `deps.botToken` + `deps.getCurrentChatId()`. Devuelve `{ status: sent|empty|send_failed|error }`. Progreso "📤 Enviando archivo…" en `agent.ts`; instrucción en `system-prompt.ts`.
- **Decisiones**: solo `jpg/png/gif/webp` van como foto (SVG/HEIC/HEIF/BMP → documento, Telegram los rechaza por URL); NO usa el MCP `notifications` (enviaría desde otro bot, fuera del hilo). Límite Telegram por URL: 20 MB doc / 5 MB foto.

## 2026-06-20

### Feature — Resumidor: checkpoint con tarjeta + colas (playlist YouTube + starred Feedbin)
- **UX rediseñada (sigue skill `telegram-bot-ux`):** la propuesta es una **tarjeta inline** con botones `[✅ Guardar] [🏷️ Agregar tag] [✏️ Editar] [⏭️ Saltar] [⏹️ Parar la cola]` (para artículos, además `[📄 Guardar artículo]`). Guardar/Saltar/Parar/Guardar-artículo + los botones ⭐/🎬 del menú son **callbacks mecánicos** (interceptados en `index.ts`, sin LLM); tag/editar van por LLM. Estado = **un solo mensaje ancla editado por fases** (Revisando→Procesando→Resumiendo→resumen, hilvanando `messageId`). Tras estas tools el LLM devuelve **vacío** (la tarjeta es el único canal). Tools nuevas: `editarPropuestaResumen` (addTags/setTags/removeHighlights/retag sin guardar), `detenerResumidor`, `revisarStarredResumir`.
- **📄 Guardar artículo completo:** `guardarResumenReadwise({fullArticle:true})` → Reader baja el original desde la URL con los tags (en vez del resumen). `readwise-save.sh` acepta html `-` (sin html → Reader fetchea).
- **Auto-resumidor de starred de Feedbin:** espejo del de playlist. Cron diario 08:00 (ambos) + on-demand. Contenido desde Feedbin; si viene truncado (<1500 chars) cae a `safari-fetch` (full + paywall). Al guardar/saltar se des-estrella. Colas/seen en `~/.cos-agent/resumir-starred-*.json`.
- **Borrado de video de playlist YouTube:** al guardar/saltar, `removeVideoFromPlaylist` saca el video (YouTube Data API v3 OAuth, proyecto `jano-youtube`, secrets `YOUTUBE_OAUTH_*` en apps.env; la app DEBE estar "En producción" o el refresh token expira a 7 días).
- **Menú de Telegram rediseñado:** quitados Briefing/Tareas/Agenda; agregados ⭐ Starred · 🎬 Playlist · 📚 Resumir · 📋 Estado · 🧹 carpetas. Botón persistente "📋 Menú" en el chat.
- **Resiliencia:** `cleanStalePlaceholders()` al arrancar limpia locks `placeholder` huérfanos (restart a mitad de transcripción ya no deja el resumidor pegado). Anti doble-tap de ✅ Guardar (lock `saving` sincrónico).
- **Bugs corregidos:** reply keyboard en placeholder rompía `editMessage` ("message can't be edited") → quitado; cleanup fire-and-forget se colaba entre chunks del resumen → plegado en la tarjeta + awaited.
- **Learnings → skills:** `telegram-bot-ux` anti-patterns #14-17; `sync-agent-docs` gotcha UTF-16 en code blocks.

## 2026-06-19

### Ops — Monitor de combustible APAGADO (quemaba el free tier de KV)
- **Fix/Ops**: el cron de `combustible-proxy` (`* * * * *`, cada minuto) escribía `monitor_lastrun` + `monitor_state` cada 5 min ≈ **576 writes/día de KV ≈ 57% del límite free** (~1.000 writes/día) → Cloudflare disparó la alerta "50% daily Workers KV limit reached". Apagado por dos vías: `crons = []` en `proxy/wrangler.toml` (redeploy) + `enabled:false` en la key `monitor_config` de KV. Ya **no llegan `fuel_alert`** a la cola; Jano queda 100% reactivo (sin ninguna proactividad automática).
- **Diagnóstico**: el loop de poll de la cola (CF Queues HTTP pull) NO toca KV; los watchdogs cada minuto (Jano/Vesta) tampoco. El único quema-KV era el monitor de gasolina. Reads del monitor (~2.880/día) eran triviales (3% de 100k); el problema eran los **writes**.
- **Para reactivar** (ver `Personal/Apps/Combustible/repo/CLAUDE.md` y `docs/plans/2026-06-17-...`): restaurar `crons = ["*/5 * * * *"]` (5 min, NO cada minuto) + `enabled:true` en KV; antes, hacer el `put monitor_state` **condicional** (solo si cambió) para no volver a quemar writes.

## 2026-06-18

### Feature — Monitor de combustible: alertas proactivas de disponibilidad
- **Feature**: Jano avisa cuando llega gasolina a las estaciones que Cal monitorea (inicial: Urubó, Equipetrol, Vangas; las 27 configurables). Cron cada 5 min en `combustible-proxy` (CF) detecta el flanco sin→con gasolina (`evaluateStation` + KV `monitor_config`/`monitor_state`/`monitor_lastrun`) → `POST /fuel/alert` al worker de Jano → `QueueMessage{kind:"fuel_alert"}` → daemon `proactive/fuel-alert.ts` re-verifica litros (descarta alertas vencidas) y avisa. Umbral 1.500 L, recordatorio cada 3h (máx 2), sin horario de silencio.
- **Config por texto**: tools nuevas del MCP `combustible` (`getFuelMonitorConfig/Status/setFuelMonitorConfig`) — "activa Pirai", "umbral 3000", "cada 10 min". Menú agrupado por empresa (texto).
- **Gotcha (CF)**: fetch worker→worker por `*.workers.dev` se pierde en el edge → Service Bindings (`combustible-proxy ↔ cos-agent-worker`). Cron "registrado pero sin disparar" → re-registrar schedule limpio (`PUT []` luego `PUT [{cron}]`). Límite 5 crons/cuenta → liberado uno de `digest-generator` (16:00 UTC).
- **Gotcha (daemon)**: envío proactivo debe llamar `sendMessage` con el `reply` del agente; el agente no tiene tool de envío.
- **Revertido**: menú de botones tappables (inline keyboard + callbacks `jf:*`) — no funcionó en el Telegram de Cal; se volvió a texto + config por escrito.

### Ops — proactividad interna apagada
- **Ops**: `scheduleFlightCheckin()` + `scheduleFocoCheckinsLocal()` desactivados en `loop()` (Jano 100% reactivo salvo el evento externo `fuel_alert`). Los Foco CAL check-ins (am/md/pm) eran cron interno `node-cron`, no plist launchd — distinto de la desactivación de 2026-06-13.

## 2026-06-13 (tarde)

### Feature — Things 3: Jano gestiona tareas/proyectos personales

- **Feature**: nueva capacidad Things 3 (`daemon-v2/src/tools/things.ts`). Antes Jano no podía: `clings` necesita Bash (bloqueado). Dos tools: `executeClings` (LEER vía clings/SQLite) + `thingsWrite` (ESCRIBIR vía URL scheme `things:///` con `open`).
- **Gotcha clave**: las escrituras de `clings` usan osascript/JXA (Apple Events) → cuelgan bajo launchd por TCC Automation que no se puede responder headless. Solución: escrituras por URL scheme (`open`, sin Apple Events). `add`/`add-project` sin token; `update`/`update-project` con `THINGS3_AUTH_TOKEN` (el wrapper lo agrega). Proyectos usan param `area` (no `list`).
- **Scope corregido**: TODAS las tareas/proyectos personales → Things; Apple Reminders (`executeRemctl`) solo familia/mercado. Removidas refs a la lista "Personal"/"Vibe Me" (ya no existen). Actualizado system-prompt + CLAUDE.md.
- **Ops**: `brew pin clings` (+ reminders-cli) — un upgrade rompería el binding FDA del path versionado del Cellar.

## 2026-06-13

### Switch — Notion: MCP heredado → ntn CLI (Jano + Vesta)

- **Breaking/Migration**: removido el acceso a Notion vía el MCP heredado `mcp__claude_ai_Notion__*` (7 tools en allowlist Jano, 6 en Vesta). Notion ahora SOLO vía tools custom que envuelven `ntn` CLI: `notionCli({method,path,body?})`, `notionPageMarkdown({pageId})`, `notionUpdateBody({pageId,markdown})` — ahora allowlisteadas (antes "en pruebas", sin allowlist).
- **Migration**: 3 usos programáticos de Jano migrados — subagente `analyzeTranscriptAgent` (`allowedTools` → `notionPageMarkdown`), Foco check-in (`proactive/foco-check.ts`: KPIs → DB `d4996efa`, Tareas → DB `1f2c4876` filtro Estado, secciones → `notionPageMarkdown`), Metas Salud (system-prompt → `notionCli`).
- **Security**: `DELETE` removido del enum de `notionCli` (archivar = `PATCH {in_trash:true}`). Auth por env `NOTION_TOKEN`→`NOTION_API_TOKEN` (sin Keychain/TCC). daemon-health-reviewer: 0 blocking.

### Docs — rediseño CLAUDE.md + automatización dormida

- **Docs**: `CLAUDE.md` reescrito como guía operativa + índice (156→85 líneas); cruft pre-build → `docs/archive/`; anexos/ARCHITECTURE/BACKLOG marcados. Spec/plan en `docs/superpowers/`.
- **Ops**: 7 crons launchd (heartbeat/learnings/nightly/eisenhower/morning-build/outlook-cache) DESACTIVADOS + archivados en `~/Library/LaunchAgents/disabled-2026-06-13/`. Jano 100% reactivo.

## 2026-06-11

### Feature — Mundial 2026: MCP `worldcup` (datos en vivo + predicciones)

- **Feature**: nuevo MCP server `worldcup` (`MCP Servers/mcp-servers/servers/worldcup/`) con 8 tools — datos en vivo vía API-Football v3 (`getFixtures`, `getStandings`, `getMatchDetail`, `getLineups`, `getMatchStats` con xG) + predicciones que spawnean el Predictor Mundial Python (`predictMatch`, `forecastTournament`) + `syncResults` (baja resultados reales → el modelo condiciona, simula solo lo que falta).
- **Feature**: wired en `BASE_OPTIONS.mcpServers` (`index.ts`) + 8 tools en `CLAUDE_AI_COS_TOOLS` (`agent-options.ts`) + `TOOL_MESSAGES` (`agent.ts`) + doc en `system-prompt.ts`. Env `API_FOOTBALL_KEY` (plan Pro — el free NO cubre season 2026, solo 2022-2024).
- **Refactor**: consolidados los wrappers locales `tools/worldcup.ts` (`predictMatch`/`worldCupForecast`) dentro del MCP; archivo eliminado de Jano. Reusable ahora por cualquier agente.

## 2026-06-07

### Feature — YouTube: resumen estructurado con envío Telegram

- **Feature**: sección `### YouTube` en `system-prompt.ts` expandida — flujo completo `transcribeYoutube` + resumen HTML (3-5 secciones, ≤15 bullets, takeaway) + envío automático al chat de Cal. Antes: transcripción cruda. Ahora: análisis estructurado en `<b>`, `<i>`, `<code>`.

### Fix — Limpieza MCPs redundantes en daemon

- **Fix**: removidos `apple-reminders` y Readwise remote de `BASE_OPTIONS.mcpServers` en `index.ts` — ambos heredados vía OAuth Max. Elimina duplicación y posibles conflictos de tool names.
- **Fix**: `getVacacionDetail` — `await` faltante corregido; descripción de la tool actualizada.

## 2026-06-06

### Feature — Schedule CAL: herramientas de vacaciones

- **Feature**: `daemon-v2/src/tools/schedule-cal.ts` — 2 nuevas tools para consultar vacaciones de Cal vía Notion:
  - `listVacaciones` — lista vacaciones con filtros opcionales (año, status); incluye `[pageId: ...]` en output para encadenar con `getVacacionDetail`
  - `getVacacionDetail` — detalle completo de un viaje: propiedades + ítems de BDs interiores (Alojamiento, Pasajes, Plan de Viaje) + contenido de PDFs e imágenes adjuntos vía OpenRouter
- **Infra**: PDFs analizados via `pdf-parse` (CJS/ESM interop con `createRequire`) → texto completo enviado a OpenRouter/Gemini para summarizar (~600 tokens) en vez de truncar. Protege context window.
- **Infra**: Imágenes analizadas vía OpenRouter vision (`google/gemini-3.1-flash-lite`) — no Anthropic API directa (daemons usan OAuth Max, sin `ANTHROPIC_API_KEY`).
- **Arquitectura Notion**: 3 BDs centrales con relación `Viaje` — Alojamiento (`44f70e0b`), Pasajes (`19201a50`), Plan de Viaje (`9769869a`). Queries vía `v1/data_sources/{id}/query` con `{ property: "Viaje", relation: { contains: pageId } }`.
- **⚠️ Gotcha**: inline `child_database` en páginas Notion NO heredan permisos de la página padre — requieren conexión explícita al integration. Solución: BDs centrales con relación `Viaje`.

## 2026-06-05

### Refactor — Reminders: migración de MCP apple-reminders a remctl CLI

- **Migración**: removido `mcp__apple-reminders__*` (6 tools) de `allowedTools`. Reemplazado por tool custom `executeRemctl({ args })` que invoca `/Users/calepes/bin/remctl` via spawn.
- **Nuevo**: `daemon-v2/src/tools/reminders.ts` — wrapper remctl con env aislado (solo PATH) y timeout 10s.
- **system-prompt**: actualizadas todas las referencias → `executeRemctl`. Lista "Vibe Projects" → "Vibe Me".
- **Gotcha**: output de remctl es JSON string — NO usar `asText()` (double-encoding). Usar `{ content: [{ type: "text", text: rawString }] }`.

### Fix — Books tools: gotchas de covers descubiertos en uso real

- **Fix docs**: Google Books API `zoom=0` devuelve imágenes pequeñas/placeholder — usar `zoom=6`. Corregido en CLAUDE.md.
- **Docs**: Covers en Notion requieren HTTPS (HTTP bloqueado). ISBN puede mapear a edición incorrecta — validar título del resultado; fallback `intitle:X inauthor:Y`.
- **Docs**: `ntn` file upload 3-pasos para hostear covers directamente en Notion: `POST /v1/file_uploads` → `send --file` → PATCH con `file_upload.id`.

### Books — Cover Search (fallback chain)
- **Fix**: Open Library usa `?default=false` para detectar ISBNs sin cover real (antes retornaba placeholder HTTP 200 → cover vacío en Notion)
- **Feature**: Goodreads search como fallback final en `searchCover()` — imágenes vía Amazon CDN (`compressed.photo.goodreads.com`), alta calidad
- **Fix**: Source display en `setBookCover` ahora detecta la fuente real por URL (Google Books / Open Library / Goodreads)

### Books — Reading Tracker
- **Feature**: `logReadingProgress` auto-detecta `% Inicial` del último registro existente — Cal solo declara el `% Final`
- **Fix**: Query del tracking DB corregido: `ntn` no soporta `v1/databases/{id}/query`; usar `v1/data_sources/TRACKING_DS/query`. Agregado `TRACKING_DS = "908f96f0-f573-4945-8da8-172641151265"` a `books.ts`
- **Feature**: Respuesta de confirmación incluye el título del libro (fetch del page en Notion)

## 2026-06-04

### Tools — BD de Libros (Notion)

- **Feature**: `daemon-v2/src/tools/books.ts` — 5 nuevas tools para gestionar la BD personal de libros:
  - `searchBooks` — busca/lista por nombre o estado
  - `addBook` — crea libro con cover + ícono automático
  - `updateBook` — actualiza propiedades (estado, rating, fechas, páginas)
  - `logReadingProgress` — registra sesión de lectura en BD tracking (porcentajes decimales)
  - `setBookCover` — busca cover en Google Books (primario) / Open Library (fallback) y setea cover + ícono con la misma URL
- **Feature**: Cover search usa Google Books API (`GOOGLE_BOOKS_API_KEY` en `apps.env`) con imagen `zoom=6` para imágenes de tamaño completo. Open Library como fallback por ISBN.
- **Infra**: `ntn` CLI (`/opt/homebrew/bin/ntn`) usado via `spawnSync` para todas las operaciones Notion — funciona en daemon launchd user-level via Keychain macOS sin config adicional.

## 2026-06-01

### UX — Markdown → HTML sanitizer

- **Fix**: `compact.ts` generaba summaries con bullets Markdown que Sonnet replicaba en respuestas. Reemplazado por texto plano sin guiones.
- **Fix**: `daemon-v2/src/format.ts` — `sanitizeForTelegram()` post-processor (mismo módulo que Pecunia). Para voice (TTS) se usa el texto raw sin sanitizar.
- **Fix**: `system-prompt.ts` — bloque ⛔ VERIFICACIÓN OBLIGATORIA con tabla de patrones Markdown prohibidos vs HTML correcto.

## 2026-05-27

### Fix — Mensajes largos y TTS chunking en Jano

- **Fix: MESSAGE_TOO_LONG en respuestas largas:** `editMessage` de Telegram tiene límite de 4096 chars. Agregado `chunkText()` en `daemon-v2/src/index.ts` — primer chunk edita el placeholder, chunks adicionales se envían como mensajes nuevos.
- **Fix: TTS cortaba a 900 chars:** `tools/tts.ts` tenía un hard cap de 900 chars. Reemplazado por `textToVoiceOggChunks()` que parte el texto en chunks de 4800 chars y envía un audio por chunk via `sendVoice`.
- **Fix: regex TTS demasiado estrecho:** añadidas frases "como audio", "léemelo", "cuéntamelo" al trigger de TTS (antes solo "en audio"/"en voz").
- **Docs:** `CLAUDE.md` actualizado — gotcha 4096 chars y sección Audio reescrita (STT ElevenLabs vs whisper-cli, triggers TTS).

## 2026-05-26

### Bugfix — Morning Build callbacks y duplicados en Apple Reminders

- **Fix: `build:approve` siempre descartaba propuestas:** `"build:approve:id".split(":")` + destructuring `const [action, , id]` daba `action="build"` (no `"build:approve"`), cayendo siempre al branch reject. Corregido usando `parts[1]` como subaction en `index.ts`.
- **Fix: `addReminder` creaba duplicados:** el MCP `apple-reminders` ahora verifica si ya existe un reminder activo con el mismo título (case-insensitive) antes de crear. Retorna `{ ok: false, duplicate: true, externalId }` en lugar de crear un segundo reminder con el mismo nombre.

## 2026-05-24

### Cleanup — Álbum Panini FIFA World Cup 2026 eliminado
- **Removido**: MCP `panini-mundial` (7 tools), botón "🃏 Álbum" del menú principal, handler mecánico `j:panini:*`, comando `/album`, handler `web_app_data` para mini app, y toda la sección del system-prompt (dictado de figuritas, mapeo de países, números en español).
- **Motivo**: ya no en uso.

## 2026-05-23

### Feature — fetchAndSummarize: artículos paywalled en background

- **`fetchAndSummarize({ url, instruction })` tool:** descarga URL con cookies de Safari de Cal y genera resumen/análisis en subprocess separado (`claude -p --tools ""`). El texto del artículo no entra al contexto de Jano — solo el resultado final (~1-2K chars). Async: progress updates + resultado como mensajes nuevos en Telegram.
- **`fetchAsUser({ url })` tool:** parsea `Cookies.binarycookies` de Safari sin dependencias npm (packages existentes: 404, deprecated, o API limitada). Requiere FDA en `~/.npm-global/bin/node`. Devuelve texto stripeado de HTML, máx 50K chars.
- **`readPersistedOutput({ path })` tool:** lee archivos SDK persisted-output con whitelist estricta de paths (`~/.claude/projects/*/tool-results/toulu_*.json`).
- **Readwise anti-thrashing:** system prompt fuerza `pageSize: 20` en `reader_list_documents` y `readwise_list_highlights`. Sin límite, Readwise devuelve miles de items → autocompact thrashing.
- **Playwright bloqueado:** `mcp__plugin_playwright_playwright__*` agregado a `DISALLOWED_BUILTINS` — se heredaba de OAuth Max y Jano intentó usarlo para leer `file://` paths.
- **Gotchas confirmados:** prompts >10K chars al subprocess deben ir via stdin (`child.stdin.write()`), no como arg CLI. Flag correcto: `--tools ""` (no `--no-tools` que no existe).

## 2026-05-21

### Feature — Foco CAL: check-ins proactivos + tools de revisión

- **3 crons proactivos (Lun–Vie):** `proactive/foco-check.ts` — 8:30 (mañana), 12:30 (mediodía), 18:00 (cierre), timezone `America/La_Paz`. Sección rotativa via KV counter `foco_checkin_counter` (mod 6).
- **6 secciones rotativas:** CAL personal, Prioridades, Rufino Arribas, Christian Hausher, KPIs diarios (DB Notion), Tareas de la semana (vista Notion "This Week").
- **`getFocoCalStatus` tool:** retorna progress log local (últimos 30 días) + punteros a Notion + sección activa. Triggerado cuando Cal pregunta por el Foco, KPIs Yape (DAU/afiliaciones/TRX), o tareas de Notion.
- **`logFocoProgress` tool:** appends a `~/.cos-agent/foco-progress.json` (append-only). Llamado al confirmar "hecho" en check-in o cuando Cal menciona avance en una sección.
- **Progress log:** `~/.cos-agent/foco-progress.json` — array append-only `{ date, ts, section, itemText, note }`.
- **`CfKv.set()` TTL ahora opcional:** antes era `600s` fijo. Sin TTL → persiste indefinidamente (necesario para `foco_checkin_counter`).
- **Patrón cron + buildApprovalFlow:** `setCurrentChatId(chatId)` debe llamarse antes de `startup()` en crons que usan approval flows; inyectado via `FocoCheckinOpts.setCurrentChatId` desde `index.ts`.
- **Tests:** `tools/foco-cal.test.ts` — 8 tests: appendFocoProgress, readFocoProgress, sectionFromCounter.

## 2026-05-16

### Feature — PPT Wizard en Jano + skill global ppt-yape

- **Skill global `ppt-yape`:** wizard de 4 pasos (SCQA → Storyline → Tipos → Contenido) basado en Minto Pyramid Principle + 5 tipos de slides (McKinsey/BCG/Bain). Archivo en `~/.claude/skills/ppt-yape/SKILL.md`. Activa con cualquier variante de "arma una PPT / deck / presentación".
- **Cheat sheet Yape:** `~/Claude Projects/Yape/Presentaciones/framework-presentaciones.md` — referencia rápida del método.
- **`pptWizardSave`, `pptWizardLoad` tools:** estado del wizard en CF KV (`ppt-wiz:{chatId}`, TTL 2h). Implementado en `daemon-v2/src/tools/ppt-wizard.ts`.
- **System prompt Jano:** sección `## Wizard de Presentaciones (PPT)` con instrucciones del wizard de 4 fases, uso de tools de estado, y formato Telegram para cada paso.
- **Gotcha wizard tools (4 lugares):** al agregar un wizard tool nuevo en Jano hay que tocar: `tools/*.ts` (lógica + KV), `agent-tools.ts` (tool registration), `agent.ts:TOOL_MESSAGES` (progress text), `system-prompt.ts` (instrucciones LLM).

## 2026-05-15

### Fix — Automatizaciones: nightly-report, heartbeat, morning-build

#### Nightly Report (`~/.claude/hooks/nightly-report.sh`)
- **Fix preamble leak:** `claude -p` emitía texto de razonamiento antes del HTML. Prompt reforzado con "el PRIMER carácter DEBE ser 📊" + Python post-processor stripea contenido antes del emoji.
- **Fix prefijos Readwise:** `mcp__readwise__*` → `mcp__claude_ai_Readwise__*` en `--allowedTools` y en el prompt.
- **Feature horizonte +2 días:** sección "Mañana" ahora incluye sublínea condensada de recordatorios del día siguiente.

#### Heartbeat — `incomplete-tasks.md`
- **Fix spam matutino:** task sin deduplicación alertaba el mismo item hasta 10 veces por mañana (cada 30 min). Agregado patrón `seen_today`/`mark_seen` con state file `~/.claude/state/incomplete-tasks-seen.json`.

#### Heartbeat — `usage-evening.md` / `usage-morning.md`
- **Fix KeyError:** scripts usaban keys del schema viejo de `claude-usage.py` (`pct`, `tokens_w`, `limit_w`). Actualizados a schema actual: `total_pct`, `local_tokens_w`; `limit_w` derivado como `tokens_w / (pct/100)`.

#### Morning Build (`~/.cos-agent/morning-build.sh`)
- **Fix cuelgue nocturno:** `reminders show-lists` colgaba 8.5h cada noche esperando respuesta TCC con pantalla bloqueada. Agregado `timeout 30s` antes de la llamada.

### Docs — CLAUDE.md Jano
- Documentado gotcha `reminders show-lists` con pantalla bloqueada.
- Documentado requisito de dedup en heartbeat tasks con schedule multi-run.
- Documentado nightly-report: preamble fix + prefijo Readwise correcto.
- Corregido path de morning-build: `~/.claude/hooks/` → `~/.cos-agent/`.

## 2026-05-14

### Feature — inversiones-query MCP wired

- **`inversiones-query` wired:** 8 tools de portafolio disponibles en Jano. Permite queries sobre `getPortfolioSummary`, `getDailyMovers`, `getPortfolioPerformance`, `getPortfolioConcentration`, `getPositionDetail`, `getPriceHistory`, `getTransactionHistory`, `searchPosition`.
- **Env vars agregadas** a `~/.cos-agent/.env`: `KUBERA_AUTH_TOKEN`, `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`.
- **`agent-options.ts`:** 8 tool names en `CLAUDE_AI_COS_TOOLS`; **`index.ts`:** mcpServer entry con `command: "node"`.

## 2026-05-13

### Fix — getTokenUsage: campos JSON actualizados y formato mejorado
- **Bug**: `agent-tools.ts` usaba campos del schema viejo (`pct`, `tokens_w`, `limit_w`, `burn_per_h`) que dejaron de existir al reescribir `claude-usage.py` en 2026-05-12. La tool devolvía error al intentar formatear valores `undefined`.
- **Fix**: `getTokenUsage` reescrito para usar campos actuales: `total_pct`, `local_tokens_w`, `local_burn_per_h`, `has_live_data`, `live`. Eliminada lógica de "presupuesto del día" (requería `limitW`). Semáforo diario relativo al promedio de días anteriores.

### Fix — claude-usage.py: deduplicación por message.id en JSONL
- **Bug**: `collect_tokens()` acumulaba cada línea de streaming por separado. Claude Code escribe N registros con el mismo `message.id` por respuesta; sin dedup los tokens se contaban ~2x (707M → 379M tokens-w reales).
- **Fix**: dict `{message_id → last_record}` — el último registro por `message.id` gana y contiene los totales finales del stream. Registros sin `message.id` reciben clave sintética única.

## 2026-05-10

### Fix — Date injection runtime (timezone America/La_Paz)
- **Bug**: `SYSTEM_PROMPT` era constante estática evaluada una vez al arrancar el daemon. Sin `new Date()` en runtime y sin timezone explícito, Node usaba UTC (4h adelantado) → LLM refería eventos de hoy como "ayer".
- **Fix**: `runtimeDateContext()` en `daemon-v2/src/index.ts` — inyecta fecha/hora con `Intl.DateTimeFormat("America/La_Paz", {locale:"es-BO"})` al inicio de `contextHeader` en cada turno.

### Refactor — Vuelos NAABOL a constante compartida
- **Cambio**: bloque de instrucciones NAABOL (`system-prompt.ts` líneas 75-114) extraído a `mcp-servers/shared/vuelos-naabol-format.ts` (constante `VUELOS_NAABOL_INSTRUCTIONS`). Jano y Vesta importan del shared — única fuente de verdad.
- `daemon-v2/tsconfig.json`: `rootDirs` incluye `../../../../MCP Servers/mcp-servers/shared`.

### Fix — Acks genéricos prohibidos en system-prompt
- **Bug**: sección `## Canal` solo prohibía "ya respondo", dejando sin cubrir "ya tengo los datos", "procesando", "dame un momento". Generaban push notification innecesaria.
- **Fix**: bloque `PROHIBIDO — acks genéricos de recepción` con ejemplos literales + regla positiva (usar verbo concreto de la acción si se necesita confirmar).

## 2026-05-08

### Estado conversacional — TTL 12h + alineamiento con Pecunia/Vesta
- **Change**: `TTL_SECONDS` 1800 → 43200 en `daemon-v2/src/state.ts` (12h). Análisis empírico de logs (`historyLen` por turno) mostró que las ráfagas reales de Cal están separadas por 1-12h — el TTL anterior hacía que cada interacción arrancara en frío.
- **Tests**: `state.test.ts` actualizado.
- **Doc**: tabla de context window por bot agregada a `~/Claude Projects/telegram-reference.md`.

### Fix — Notion MCP prefijo correcto
- **Bug**: `agent-options.ts` y `system-prompt.ts` referenciaban `mcp__notion__*` (prefijo viejo) — el MCP real heredado vía OAuth Max es `mcp__claude_ai_Notion__*`. Resultado: invocar Notion devolvía silenciosamente "permissions not granted" (con UI mostrando "🔍 Buscando..." engañoso).
- **Fix**: 6 entradas en allowlist + 3 menciones en system-prompt.
- **Doc**: gotcha agregado a `~/.claude/CLAUDE.md` global y `~/Claude Projects/CLAUDE.md` workspace.

### Doc — CLAUDE.md updates
- Sección Notion: prefijo MCP correcto documentado.
- Comando para inspeccionar KV de contexto agregado en "Comandos operativos v2".

### Tools — WhatsApp link skill
- **Feature**: tools `getWhatsappContacts` + `saveWhatsappContact` agregadas a `cos-tools` (`daemon-v2/src/tools/whatsapp.ts` + tests `whatsapp.test.ts`). Lee/escribe `~/.claude/whatsapp-contacts.md` (compartido con Vesta y skill CLI `~/.claude/skills/whatsapp/`). El link `wa.me` se genera en el LLM (`encodeURIComponent` del mensaje).
- **System prompt**: sección WhatsApp con flujo de 6 pasos (identificar contacto, manejar múltiples matches, capturar mensaje, generar link, ofrecer crear contacto nuevo con mapa de códigos de país).
- **TOOL_MESSAGES**: entradas para los 2 tools nuevos en `agent.ts`.

### Fix — MCP -32602 en tools que retornan void
- **Root cause**: `saveWhatsappContact` retornaba `Promise<void>` y se registraba con `asText(await fn())`. `JSON.stringify(undefined)` produce `text: undefined` → MCP server tira `Invalid tools/call result: invalid_union expected string`.
- **Fix**: el handler ahora retorna `asText(\`Contacto ${nombre} guardado.\`)` después del await. Documentado como gotcha global en `~/.claude/CLAUDE.md` sección "Claude Agent SDK + OAuth Max".

## 2026-05-06

### UX — Progress Updates en Telegram
- **Feature**: `onProgress` callback en `AgentDeps` (`daemon-v2/src/agent.ts`) — el event loop detecta bloques `tool_use` en el stream del SDK y llama `editMessage` sobre el placeholder con un mensaje amigable (ej: "📅 Leyendo Google Calendar...")
- **Feature**: `TOOL_MESSAGES` map con 39 entries cubiertas: cos-tools, apple-reminders, naabol-flights, health, exchange-rate-bolivia, youtube-transcribe, feedbin, serpapi-flights, combustible, Google Calendar, Gmail, Notion

### Tool — getTokenUsage (consumo Claude Max)
- **Feature**: tool `getTokenUsage` agregada a `cos-tools` (`daemon-v2/src/agent-tools.ts`) — devuelve JSON del ciclo Claude Max: % usado, burn rate, ETA al 100%, tokens por día y por modelo. Wrappea `~/.claude/scripts/claude-usage.py json` via `spawnSync` (sin Bash, que está bloqueado en el daemon).
- **System prompt**: sección "Consumo de tokens Claude Max" con campos del JSON, triggers en lenguaje natural y formato Telegram de respuesta.
- **Skill global**: `~/.claude/skills/token-usage/SKILL.md` — invocable desde Claude Code (via Bash) y desde Jano (via `mcp__cos-tools__getTokenUsage`).

### Tool — getTokenUsage (refactor formato)
- **Fix**: `getTokenUsage` ahora pre-formatea HTML en TypeScript (mismo formato que `~/.claude/heartbeat-tasks/usage-morning.md`) en lugar de devolver JSON crudo al LLM. Eliminado bug de nombres de día incorrectos (el LLM infería "Lun" para fechas que eran martes, etc.) y diferencias de redondeo.
- **System prompt**: instrucción simplificada — "la tool ya devuelve HTML formateado listo para Telegram, reenviar sin reformatear".

## 2026-05-04

### Fix naabol-flights — Jano respondía "no puedo confirmar" pese a tener datos

- **Root cause**: el CLI `consultar-vuelo.mjs` emitía un campo `nota` con texto "Endpoint operativo NAABOL caído (404)" en cada response. El LLM lo interpretaba como "no puedo responder" y omitía `gate`/`estado`/`horaProgramada` que sí venían poblados en `matches[]`. Bug reportado mid-pre-flight 2026-05-04 04:23 hora Bolivia.
- **Fix CLI** (`Aeropuertos Bolivia/cli/consultar-vuelo.mjs`): removido el campo `nota` cuando hay matches. Solo aparece si no hay resultados.
- **Fix system-prompt** (`daemon-v2/src/system-prompt.ts`): regla OBLIGATORIA — si `matches[]` trae items con `gate`/`estado`/`horaProgramada` poblados, mostrarlos literales. PROHIBIDO decir "no puedo confirmar gate/delays" o "endpoint caído". Mismo refuerzo aplicado a Vesta.
- **Docs**: gotcha documentado en `Aeropuertos Bolivia/CLAUDE.md` + `CHANGELOG.md` (nuevo), `MCP Servers/CLAUDE.md` (principio general "outputs minimalistas") y `Jano/CLAUDE.md` (regla naabol-flights).

### Auditoría TCC pre-viaje

- Confirmado que los 3 daemons activos (`com.cal.cos-agent-v2`, `com.cal.family-agent-v2`, `com.calepes.pecunia-agent`) usan Node + SDK librería — inmunes a TCC reset.
- `enabledPlugins.telegram: false` en `~/.claude/settings.json` previene que crons disparen `deleteWebhook` automático del plugin grammY. Webhooks de Jano/Vesta/Pecunia activos sin drift.
- BACKLOG actualizado: parqueado item "evaluar remindctl" (EventKit no se evita migrando CLI), agregado item "revisar contenido + formato + secciones del nightly-report cron".

## 2026-05-02

### Solicitud de ubicación nativa + combustible (requestUserLocation)

- **Nueva tool `requestUserLocation()`**: manda a Cal un botón nativo de Telegram (`ReplyKeyboardMarkup` con `request_location: true`) para obtener coordenadas GPS. Cuando Cal toca el botón, el daemon recibe el `message.location` y lo inyecta como texto neutral al agent.
- **Location handling**: agregado `location?: { latitude; longitude }` a `shared-v2/src/types.ts` y manejo en `processMessage` — convierte el pin GPS en `[ubicación GPS compartida: lat=X, lon=Y]` antes de pasar al agent.
- **Combustible en system-prompt**: sección `getFuelStatus` + `requestUserLocation` documentados con regla de selección.

### Hooks, bots y refactor de tokens

- **Bots inventariados**: @cal_jano_bot (Jano), @yapito_cal_bot (Yapito), @Vesta_cal_bot (Vesta), @cal_pecunia_bot (Pecunia), @cal_codex_bot (Codex). Bot de Jano renombrado de @calclaudecode_bot → @cal_jano_bot.
- **Bot de notificaciones (@ClaudeCalbot)**: nuevo canal genérico para notificaciones del sistema Claude Code. Token en `~/.claude/notifications/.env:NOTIF_BOT_TOKEN`. MCP `notifications` creado con tools `sendNotification` y `sendNotificationWithEmoji`.
- **Hooks registrados en settings.json global**: `session-start-context.sh` (SessionStart — inyecta fecha + Apple Reminders + GCal) y `learn-error.sh` (PostToolUse — captura errores de tools).
- **Refactor tokens Jano**: 10 scripts de crons/hooks (`heartbeat`, `nightly-report`, `daily-briefing`, `morning-build`, `morning-build-execute`, `skill-install`, `skill-detector`, `eisenhower-weekly`, `proactive-ideas`, `pre-compact-snapshot`) migrados de `~/.claude/channels/telegram/.env:TELEGRAM_BOT_TOKEN` → `~/.cos-agent/.env:COS_TELEGRAM_BOT_TOKEN`.
- **stop-telegram-notify.sh**: actualizado para usar @ClaudeCalbot. Mantenido fuera del settings.json — dispara en toda sesión CLI incluyendo crons, demasiado ruidoso.
- **Docs**: referencias obsoletas limpiadas en CLAUDE.md (listTasks/getPersonas removidas, NOTION_TAREAS_DB_ID, channels/telegram/.env).

### MCP Combustible + formato tablas

- **Nuevo MCP `combustible`**: `getFuelStatus({ lat?, lon?, limit?, minLitros? })` disponibilidad gasolina 27 estaciones Santa Cruz con distancias Google Maps y links por estación. Wired en daemon.
- **Tablas Telegram**: system prompt actualizado — `<pre>` con columnas alineadas y separador ─. NUNCA `| col |`.
- **Fix bold system prompt**: `**Jano**` y `**Cal**` → sin bold para evitar asteriscos literales en HTML mode.

### Pendientes: Notion → Apple Reminders

- **Refactor**: quitadas tools de Notion DB Tareas (`listTasks`, `createTask`, `setTaskStatus`, `setTaskFecha`, `setTaskDeadline`, `getPersonas`). Pendientes personales de Cal ahora en Apple Reminders — lista "Personal" (tareas) y "Vibe Projects" (ideas/backlog).
- **System-prompt**: sección Notion DB Tareas reemplazada por Apple Reminders con triggers, plantilla y reglas actualizadas.
- **Yapito/CLAUDE.md**: sección Notion DB Tareas documentada lista para cuando se implemente el daemon de Yapito.

### Diagnóstico y fix de webhook drift de Jano

- **Diagnóstico caída de red**: bots (Jano, Vesta, Pecunia) cayeron simultáneamente 8:31–8:43 AM por corte de internet (`TypeError: fetch failed`, 6 errores consecutivos con backoff). Recuperación automática. Segundo corte breve a las 9:00 AM.
- **Fix webhook drift constante**: `telegram@claude-plugins-official: true` + `channelsEnabled: true` en `~/.claude/settings.json` hacía que el plugin Telegram arrancara en toda sesión de Claude Code (incluyendo VS Code), llamando `deleteWebhook()` del bot de Jano al inicio. Fix: puesto en `false` — el plugin sigue disponible vía `--channels` explícito.
- **Webhook restaurado**: `setWebhook` manual a `cos-agent-worker.carlos-cb4.workers.dev/telegram/webhook`.
- **Docs**: gotcha documentado en `~/.claude/CLAUDE.md` y `Jano/CLAUDE.md`.

### Google Maps tools + fix requestUserLocation

- **Nuevas tools `searchPlace` + `travelTime`**: copiadas de Vesta (`tools/maps.ts`). `searchPlace` usa Google Places API New; `travelTime` usa Google Routes API v2 con modo DRIVE TRAFFIC_AWARE (tiempo real en tráfico). Requieren `GOOGLE_MAPS_API_KEY` y `HOME_PIN` en `~/.cos-agent/.env`.
- **Fix trigger `requestUserLocation`**: el system-prompt solo tenía regla para consultas de combustible. Extendido para cubrir cualquier consulta de distancia, ruta, tiempo de viaje o "cuánto tardo".
- **Wired en daemon**: `GOOGLE_MAPS_API_KEY` y `HOME_PIN` leídos de env, pasados a `buildSdkTools`. Tools añadidas a `CLAUDE_AI_COS_TOOLS` allowlist.

### Fix formato HTML (REGLA ABSOLUTA position)

- **Bug**: el bloque `## FORMATO DE SALIDA — REGLA ABSOLUTA` estaba enterrado en la sección UX (~línea 130 del system-prompt) → el LLM lo ignoraba y usaba `**bold**` en lugar de `<b>bold</b>`.
- **Fix**: bloque movido al top del system-prompt, justo después del párrafo de identidad. El LLM ahora respeta HTML consistentemente.
- **Family/Vesta**: mismo fix aplicado a Vesta (migrado a HTML en esta sesión).

### Readwise MCP (via mcp-remote)

- **MCP Readwise externo**: integrado via bridge `mcp-remote` apuntando a `https://mcp2.readwise.io/mcp` con auth `Authorization: Token TOKEN`. Alternativa al MCP OAuth Max de claude.ai (que requería re-auth en iPad).
- **22 tools disponibles**: Reader (list/search/get_details/create/move docs, highlights, tags, export, bulk_edit) + Readwise classic (list/search/daily_review/create/update/delete highlights).
- **Wired solo en Jano**: token `READWISE_TOKEN` en `~/.cos-agent/.env`. Vesta no tiene acceso (out of scope).
- **Global también**: registrado en `~/.claude/.mcp.json` como `"type": "url"` para sesiones interactivas Claude Code.

### Feedbin write tools + fix subscription_id

- **Nuevas tools en MCP `feedbin`**: `savePage(url)` guarda artículo via POST /v2/pages.json (para leer luego en Reader), `addSubscription(feedUrl)` suscribe a feed (maneja 302 = ya suscrito), `deleteSubscription(subscriptionId)` elimina suscripción.
- **Fix `getSubscriptions()`**: bug donde el output solo exponía `feed_id` pero el endpoint DELETE necesita `subscription_id` (`s.id`). Ahora expone ambos campos. Causaba 404 al intentar borrar suscripciones.

## 2026-05-01

### Capacidades de Salud + Renames

- **Health coaching → Jano**: capacidades de salud migradas del agente Health a Jano. Sección `## Salud` en `system-prompt.ts` con las 3 tools health + coaching activo (interpreta, no enumera, proactivo con patrones).
- **Notion DB "Metas Salud"**: creada (`f929198356f14b148d205e4e6723646f`) bajo página CAL. Campos: Meta, Valor Actual, Target, Unidad (pasos/hrs/kg/sesiones/bpm/ms/%), Fecha Inicio, Estado, Notas.
- **Métricas composición corporal**: `body_fat_percentage`, `lean_body_mass`, `body_mass_index` confirmadas en D1. `weight`/`body_mass` no está — pendiente configurar en Health Auto Export.
- **Rename**: repo `Chief of Staff Cal` → `Jano`. Plist y CLAUDE.md actualizados.

## 2026-04-30

### Health + Reminders como MCPs globales

- **Health migrado a MCP**: `getHealthSummary`, `getHealthTrend`, `getWorkouts` removidos de `cos-tools` custom y migrados al MCP global `health` (`mcp-servers/servers/health/`). Wired en `BASE_OPTIONS.mcpServers` con `HEALTH_API_KEY`.
- **Apple Reminders MCP**: nuevo server `mcp-servers/servers/apple-reminders/` — 6 tools: `listReminderLists`, `listReminders`, `addReminder`, `editReminder`, `completeReminder`, `deleteReminder`. Wraps `reminders-cli` Swift. Jano puede leer y gestionar los Reminders personales de Cal.
- **Fix reminders-cli**: versiones nuevas devuelven UUIDs en `externalId` pero `complete`/`delete` solo aceptan índice entero — `listItems()` ahora usa `String(idx)`.

### Migración de bot + PDF/DOCX

- **Bot migrado a @cal_jano_bot**: token actualizado en `~/.cos-agent/.env` y `~/.claude/channels/telegram/.env`. Bot viejo silenciado.
- **PDF/DOCX en Telegram**: `processDocument()` en `daemon-v2/src/index.ts` — extrae texto de PDFs y Word, pasa al agent como contexto. Fix: pdf-parse v2 API (`new PDFParse({ data }).getText()`) + `createRequire` CJS/ESM interop + dependencias instaladas en workspace root.

## 2026-04-29

### Migración mayor: daemon CoS v2 (Node + Agent SDK librería + webhook + CF Queue)

**Razón**: el daemon viejo `claude --channels` sufría TCC reset en cada update del binario `claude` y conflict 409 con sesiones interactivas. Mismo patrón que ya migró Vesta v2 / Pecunia v2.

**Arquitectura nueva**:
- Telegram → CF Worker `cos-agent-worker.carlos-cb4.workers.dev` (Hono webhook + callback router edge)
- Light callbacks (menu/t:d/t:c/t:s/t:sd/nav) resueltos en edge (~300ms, sin LLM)
- Heavy → CF Queue `cos-events` → daemon Node `com.cal.cos-agent-v2` (Node 22 + `@anthropic-ai/claude-agent-sdk` lib + OAuth Max)

**Phases ejecutadas**:
- **Phase 1 — Scaffolding**: npm workspaces (`shared-v2`, `daemon-v2`, `worker-v2`), tsconfig.base, types y telegram helpers compartidos.
- **Phase 2 — Worker CF**: queue `cos-events` (HTTP pull mode), KV `cos-state` (id `8e5840cda34546949ff780be61c2579e`), secrets (`COS_WEBHOOK_SECRET`, `COS_TELEGRAM_BOT_TOKEN`, `NOTION_TOKEN`), callback router edge con status valor real `Listo` (no `Done`).
- **Phase 3 — Daemon Node**: 9 tools custom (notion-tasks con property names reales `Nombre de tarea`/`Asignado a` relation/`Fecha`/`Deadline`/`Prioridad CAL`, personas con cache 1h + fallback hardcoded de 7 personas Yape, outlook cache reader, health worker tools, multimodal voice/photo). Fresh `startup()` per turn (warm pool stale gotcha). Watchdog webhook cada 1 min. Circuit breaker con alerta a Cal tras 3 errores consecutivos.
- **Phase 4 — Standby test**: plist `com.cal.cos-agent-v2` con `/usr/local/bin/node`, `.env` con 12 vars, daemon corriendo en background con webhook deshabilitado para no chocar con daemon viejo.
- **Phase 5 — Hooks adaptados**: `cos-channel-bootout.sh` y `cos-channel-bootstrap.sh` reescritos. Bootout deja que grammY `bot.start()` borre webhook (esperado). Bootstrap restaura webhook al worker v2 inmediatamente al cerrar la última sesión interactiva.
- **Phase 6 — Cutover**: `setWebhook` al worker v2, daemon viejo `com.cal.cos-agent` movido a `disabled-2026-04-29/`, smoke test pendiente con Cal.

**Tools custom** (MCP `cos-tools`, 9 total):
1. `listTasks({status?, assigneePageId?, fromDate?, toDate?, limit?})` — query DB Tareas
2. `createTask({title, status?, assigneePageId?, fechaIso?, deadlineIso?, prioridad?})`
3. `setTaskStatus({pageId, status})` — usar `Listo` para "done"
4. `setTaskFecha({pageId, fechaIso})`
5. `setTaskDeadline({pageId, deadlineIso})`
6. `getPersonas()` — mapping cache
7. `getOutlookEvents({when?})` — cache pre-procesado
8. `getHealthSummary({date?})`
9. `getHealthTrend({metric, days})`

**Worker callback router edge** (`worker-v2/src/callback-router.ts`):
- `menu:<section>` y `nav:<section>` — render estático (solo `root` por ahora)
- `t:d:<pageId32>` — mark done (status="Listo")
- `t:c:<pageId32>` — complete (alias)
- `t:s:<pageId32>` — skip
- `t:sd:<pageId32>` — set fecha=hoy
- `spotify:*` — descartados (out of scope v2)

**Estado post-cutover**:
- ✅ Bot @calclaudecode_bot responde via webhook
- ✅ Sin TCC reset (Node + SDK lib, sin binario `claude`)
- ✅ Sin conflict 409 (webhook reemplaza polling)
- ✅ Watchdog auto-recupera webhook si algún proceso lo borra
- ✅ Sesiones interactivas coordinadas via hooks (deleteWebhook gracioso)
- ⏸️ Spotify control con lenguaje natural — pendiente post-cutover (Cal pidió agregarlo después)

**Spec/plan**: `docs/superpowers/specs/2026-04-28-cos-agent-v2-design.md` + `docs/superpowers/plans/2026-04-28-cos-agent-v2-implementation.md`.

### Telegram UX — Migración MarkdownV2 → HTML

**Bug detectado**: el bot respondía con "⚠️ No pude procesar tu mensaje. Hubo un error interno" cada vez que el LLM generaba un reply con caracteres MarkdownV2 reservados sin escapar (`+`, `~~`, `=`, etc.). Telegram rechazaba el parse, y el "fallback" en `daemon-v2/src/index.ts:294` reintentaba sin pasar `parseMode` — pero el default en `shared-v2/src/telegram.ts:35` también era `MarkdownV2`, así que el fallback fallaba igual y caía al placeholder genérico.

**Fix**:
- `shared-v2/src/telegram.ts`: default `editMessage` ahora es `HTML`. Tipo `parseMode` extendido a `"HTML" | "MarkdownV2" | null`. Si `null`, no se incluye `parse_mode` en el body (texto plano). Agregado export `escapeHtml(s)` que escapa solo `< > &`.
- `daemon-v2/src/index.ts`: helper local `escapeHtml`, todos los `editMessage` con `"HTML"`. Fallback ahora usa `parseMode=null` → garantiza entrega aunque se pierda formato. Templates de error en HTML.
- `daemon-v2/src/system-prompt.ts`: instrucciones reescritas — el LLM ahora genera `<b>`, `<i>`, `<code>`, `<a href>` en vez de `*x*`, `_x_`. Plantillas de output (tarea, lista, briefing) en HTML.

**Resultado**: bot responde sin "No pude procesar" — verificado con mensaje real (replyLen 274 chars con bold + bullets, sendMs 457ms, sin `html_parse_failed` en log).

**Impacto en otros bots**: Family/Vesta tiene el mismo bug (su `shared-v2/telegram.ts` default = `HTML` ya, pero el prompt instruye MarkdownV2 — los users ven `\*texto\*` literal). Migración análoga queda en BACKLOG. Pecunia usa HTML hardcoded — no afectado.

### Briefings on-demand — tool `runBriefing`

**Problema**: el bot CoS no podía generar briefings on-demand porque `Bash`, `Write`, `Read`, `Edit` están en `DISALLOWED_BUILTINS` (allowlist estricta). Cuando Cal pedía "genera el briefing Bolivia", el LLM intentaba `Skill briefing-pais` y se frustraba porque el skill necesita Bash/curl/git/Write y no los tiene. Solo el cron `com.claude.daily-briefings` (sesión claude regular con tools completos) podía generar briefings — pero el cron quedó deshabilitado en `disabled-2026-04-29/` y los briefings llevaban 11 días sin generarse cuando llegó el pedido de Cal.

**Solución — patrón "tool wrapper"**: tool custom `mcp__cos-tools__runBriefing({pais, fecha?})` en `daemon-v2/src/tools/briefing.ts`:
- Async: spawn detached de `claude -p` con el mismo comando que usaba el cron (`gtimeout 900 claude -p --dangerously-skip-permissions --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Skill" -d <PROJECT_DIR> "<prompt>"`). Tool retorna inmediatamente con `status: "started"`.
- Lock: `~/.cos-agent/briefing-locks/<pais>.lock` con PID + chatId + timestamp. Bloquea ejecución concurrente del mismo país (diferentes países pueden correr en paralelo). Detecta locks stale (PID muerto).
- Notificación: el child process mismo manda al chat de Cal (chat_id pasado en el prompt) con top 3 titulares + URL cuando termina. Si el child falla (timeout 15min o exit≠0), el daemon manda aviso de error al chat.
- ChatId del turno actual: `daemon-v2/src/index.ts` mantiene `currentChatId` global mutable, seteado al inicio de cada `processMessage`. `agent-tools.ts` usa `getCurrentChatId()` callback. Safe porque el daemon procesa serialmente (1 worker en queue).

**system-prompt actualizado**: removida mención del Skill `briefing-pais` (no funciona desde el daemon), agregada sección "Briefings de país (on-demand)" con la nueva tool.

**Flujo nuevo**: Cal pide *"genera el briefing Bolivia de hoy"* → LLM invoca `runBriefing({pais: "Bolivia"})` → bot responde "Briefing arrancado para Bolivia 2026-04-29. Te aviso cuando termine" → en background el subprocess corre 5-15 min → manda mensaje nuevo a Cal con top 3 + URL.

### YouTube transcripts — MCP custom + integración CoS

**Motivación**: el MCP global `youtube-transcript` (3rd party) solo lee captions cuando existen — falla con videos sin captions. Cal mandaba videos al bot CoS para resumir y el bot decía "no tengo permiso" o "el video no tiene captions".

**MCP nuevo**: `youtube-transcribe` (Node 22 + TS + `@modelcontextprotocol/sdk` stdio) en `~/Claude Projects/Personal/MCP Servers/mcp-servers/servers/youtube-transcribe/`. Tool único `transcribeYoutube({url, lang?, paragraphs?, model?, forceWhisper?})` con estrategia 2 fases:
1. **Caption fast-path** (~5-30s): `yt-dlp --skip-download --write-subs --write-auto-subs --sub-langs <lang>,*  --convert-subs srt`. Parsea SRT, devuelve texto. `source: "caption"`, `captionLang` indica el idioma real usado.
2. **Whisper fallback** (1-5 min según duración): `yt-dlp -x --audio-format wav --postprocessor-args "ffmpeg:-ar 16000 -ac 1"` + `whisper-cli -m ggml-small.bin -l <lang> -nt`. `source: "whisper"`.
- Cache por `videoId+lang+model` en `/tmp/yt-transcribe-cache/<id>-<lang>-<model>.txt`. Subsecuentes hits → `source: "cache"`.
- `paragraphs: true` (default) parte el texto en chunks ~80 palabras separados por `\n\n`.
- `forceWhisper: true` salta el caption fast-path (útil si auto-captions son malos).

**Registro global**: `~/.claude/.mcp.json` agregado server `youtube-transcribe` (stdio, command=node, args=[dist path]). Disponible en TODAS las sesiones interactivas + daemons que hereden MCPs.

**CoS allowlist**: `mcp__youtube-transcribe__transcribeYoutube` agregado a `CLAUDE_AI_COS_TOOLS` en `agent-options.ts`. Removido el viejo `mcp__youtube-transcript__get_transcripts` para que el LLM use solo el nuevo. system-prompt actualizado con nueva sección "YouTube" describiendo las 2 fases y opciones.

### MCP wiring fix — SDK librería no lee `.mcp.json`

**Bug detectado** durante prueba inicial de youtube-transcribe en CoS y Vesta: el LLM intentaba llamar al tool nuevo pero fallaba con `"Claude requested permissions to use mcp__youtube-transcribe__*, but you haven't granted it yet"`. Investigación: el archivo `~/.claude/.mcp.json` solo lo lee el binario Claude Code CLI. Los daemons que usan `@anthropic-ai/claude-agent-sdk` como librería Node NO leen ese archivo — hay que registrar custom MCPs en `Options.mcpServers` al hacer `startup()`.

**Fix**:
- `daemon-v2/src/index.ts`: `BASE_OPTIONS.mcpServers` ahora incluye objetos stdio para todos los MCPs externos (youtube-transcribe, exchange-rate-bolivia, naabol-flights). Formato: `{ type: "stdio", command: "node", args: ["/abs/path/dist/index.js"] }`.
- `agent-options.ts`: agregado `mcp__youtube-transcript__get_transcripts` (3rd party legacy heredado de OAuth Max claude.ai) a `DISALLOWED_BUILTINS` para que el LLM no caiga en él por accidente.

Mismo fix aplicado a Family/Vesta y Pecunia.

### Exchange-rate-bolivia MCP (BCB oficial + Binance P2P paralelo)

**Motivación**: en Bolivia hay brecha grande entre el dólar oficial (BCB ~9.79 venta) y el paralelo (Binance P2P ~13+). Tener ambas fuentes accesibles desde el bot facilita decisiones de gasto en USD.

**Server nuevo**: `mcp-servers/servers/exchange-rate-bolivia/` (Node + TS + stdio + sdk MCP). Dos tools read-only:
- `getBcbRate()` — scrape de bcb.gob.bo (regex sobre el bloque "Valor referencial del dólar estadounidense"). Cache 60s. Replica la lógica del Scriptable widget en repo `tipo-de-cambio-Bolivia`.
- `getBinanceP2PRate()` — POST al endpoint público C2C de Binance para USDT/BOB. Top 5 BUY + top 5 SELL merchants, mediana, filtro outliers >3%, promedio. Cache 60s.

Registrado global + wired en CoS, Vesta y Pecunia. system-prompt de CoS actualizado con triggers naturales ("¿a cuánto está el dólar?" → llamar las 2 y mostrar oficial vs paralelo).

**Repo `tipo-de-cambio-Bolivia` actualizado**: default branch arreglado a `main` (estaba en `claude/create-exchange-folders-0JRtW`). Agregado widget Scriptable Binance P2P (`tipo cambio Binance/binanceP2P.js` + `loader.js`).

### Naabol-flights MCP (promovido de tool local a global)

**Motivación**: las tools de vuelos NAABOL existían solo como tools custom dentro de Vesta (`Family/daemon-v2/src/tools/flights.ts`). CoS y Pecunia no podían consultar vuelos sin pasar por el skill global `vuelos-bolivia` que requiere Bash (bloqueado en daemons). Promovido a MCP global single-source-of-truth.

**Server nuevo**: `mcp-servers/servers/naabol-flights/`. Wraps el CLI `~/Claude Projects/Personal/Apps/Aeropuertos Bolivia/cli/consultar-vuelo.mjs`. Tres tools:
- `getFlight({vuelo, aeropuerto?, tipo?})` — un solo vuelo. Acepta variantes: "OB659", "BOA 659", "el 659".
- `getFlights({queries: [...]})` — múltiples vuelos en una llamada (eficiente cuando comparten aeropuerto+tipo).
- `getAirportFlights({aeropuerto, tipo?, horaDesde?, horaHasta?, aerolinea?})` — consulta abierta cuando NO se conoce el código. 12 aeropuertos NAABOL.

Wired en los 3 daemons. Vesta perdió `tools/flights.ts` (delete de 113 líneas) y las 3 entradas en `agent-tools.ts` — el namespace cambia de `mcp__vesta-tools__getFlight` → `mcp__naabol-flights__getFlight`. system-prompt de Vesta + CoS actualizados con prefijos nuevos. Skill global `vuelos-bolivia` se mantiene para sesiones interactivas/CLI (no se deprecó).

**Bug del CLI corregido en mismo día**: `categorizeStatus()` no reconocía estado "CONFIRMADO"/"CONFIRMED" del endpoint NAABOL → todos los vuelos volvían como `estadoCategoria: "other"` (Cal vio todos los emojis como ⚪ blanco). Fix aplicado: agregado caso CONFIRMED en el clasificador + nueva función `adjustForDelay()` que recategoriza a `delayed` cuando `horaReal - horaProgramada > 15 min`. CLI vive en repo Aeropuertos-Bolivia local sin commitear (carpeta `cli/` untracked).

### Pecunia system-prompt fix

**Bug**: Pecunia tenía `exchange-rate-bolivia` y `naabol-flights` correctamente wired (BASE_OPTIONS + allowlist), pero el `system-prompt.ts` no mencionaba ninguno de los tools nuevos. Cal preguntó "Dame el tipo de cambio del BCP y de Binance" y el LLM respondió sin invocar tools (`turn_summary toolCalls: []` confirmado en `daemon.out.log`).

**Fix**: agregadas 2 secciones nuevas en `pecunia-agent/daemon/src/system-prompt.ts` después del bloque de Airtable: "Tipo de cambio Bolivia" con triggers naturales y "Vuelos NAABOL" como referencia para queries laterales en planning de gastos por viajes.

## 2026-04-24

### Reactivación parcial — daemon CoS vivo 24/7
- **Fix**: `com.cal.cos-agent` cargado en launchd. Plist intacto en `~/Library/LaunchAgents/` (nunca se movió a `disabled-2026-04-21/`). Bot `@calclaudecode_bot` polleando; verificado con `409 Conflict` via getUpdates
- **Cleanup**: zombie `bun server.ts` (PID 56593) huérfano de sesión previa killeado antes del bootstrap para evitar conflict
- **Family agent**: sin cambios — ya estaba vivo, plist también intacto. El entry del 2026-04-21 afirmaba "18 plists movidos a disabled" — en realidad son 16; los 2 daemons principales nunca fueron movidos

### Docs
- **CLAUDE.md**: sección "Estado" reescrita (2026-04-21 → 2026-04-24). "DORMANT" → "PARCIALMENTE ACTIVO". Lista explícita de 16 crons pausados vs 2 daemons activos. Aclaración de conflict 409 al abrir sesión interactiva (hooks bootout/bootstrap siguen vaciados)
- **Global `~/.claude/CLAUDE.md`**: path "Agentes AI personales" corregido a `~/Claude Projects/Personal/Agents/` (estaba apuntando a `~/Documents/...` desactualizado — los agentes 24/7 están fuera de `~/Documents/` por TCC de launchd)

## 2026-04-21

### Pausa operativa — desactivación total pendiente de rediseño
- **Decisión**: Cal desmonta toda la automatización del CoS + Family tras problemas recurrentes. Ambos agentes quedan DORMANT hasta rediseño del ecosistema
- **Launchd**: 18 plists movidos a `~/Library/LaunchAgents/disabled-2026-04-21/` (10 `com.claude.*` de CoS/sistema + 6 `com.cal.family-*` + 2 `com.cal.cos-*`). Ningún plist cargado, ningún job disparándose
- **Hooks `settings.json`** (3 archivos con backup `.bak-2026-04-21`):
  - `~/.claude/settings.json` (global): quitado bloque `hooks` completo (SessionStart context, Stop telegram-notify, PreCompact snapshot, PostToolUse notion-audit + learn-error). Preservado: permissions, statusline, enabledPlugins
  - `Chief of Staff Cal/.claude/settings.json`: vaciado a `{}`
  - `Family/.claude/settings.json`: quitado bloque `hooks` (UserPromptSubmit datetime, SessionStart family-context, SessionEnd bootstrap, Stop notify). Preservado: model, permissions
- **Procesos**: cero `bun server.ts`, cero `claude --channels`, cero `claude -p` headless
- **Recovery**: reversible. Mover plist de `disabled-2026-04-21/` a `~/Library/LaunchAgents/` + `launchctl bootstrap gui/$(id -u) <plist>`. Restaurar `.bak-2026-04-21` para recuperar hooks

### Diagnóstico — Telegram CoS mudo
- **Root cause**: red bloquea `api.telegram.org` via SNI filtering (`curl (35) Recv failure: Connection reset by peer` durante TLS handshake; `google.com` funciona). Gotcha ya documentado en CLAUDE.md
- **Problema secundario**: dos sesiones interactivas con `--channels` del mismo bot → conflict 409. El channel conflict guard actual solo cubre launchd↔interactiva, no interactiva↔interactiva
- **Fix aplicado**: ninguno — el diagnóstico motivó la decisión de desactivar todo

### Docs
- `CLAUDE.md` CoS: nueva sección "Estado (2026-04-21): DORMANT" con recovery instructions
- `Family/CLAUDE.md`: sección "Estado" reescrita (era "v1 operativo 24/7"). Limpieza de afirmaciones stale "corre 24/7" en "Qué es" y warning DORMANT en "Comando de arranque"

## 2026-04-20

### Telegram — Channel conflict guard (cos-agent + family-agent)
- **Feature**: Hooks `cos-channel-bootout.sh` (SessionStart) + `cos-channel-bootstrap.sh` (SessionEnd) en `~/.claude/hooks/`. Registrados en `.claude/settings.json` del proyecto. Al abrir sesión interactiva `claude --channels`, descargan el launchd agent `com.cal.cos-agent` para evitar conflict 409 (solo UN poller por bot token). Al cerrar la última sesión interactiva, recargan el daemon automáticamente
- **Feature**: Misma lógica replicada para Family (`family-channel-bootout.sh` + `family-channel-bootstrap.sh`). Filtran por `TELEGRAM_STATE_DIR=/Users/calepes/.claude/channels/telegram-family`. Registrados en `Family/.claude/settings.json`. Copias en `Family/hooks/`
- **Fix crítico**: Añadido `/Users/calepes/.bun/bin` al PATH de los dos plists (`com.cal.cos-agent.plist` y `com.cal.family-agent.plist`). Sin esto, `bun` no estaba disponible para launchd → plugin MCP de Telegram fallaba ("1 MCP server failed") → daemon arrancaba pero sin polling → bot mudo aunque el proceso estuviera vivo
- **Fix self-sabotage**: env var `COS_AGENT_BG=1` / `FAMILY_AGENT_BG=1` en los plists. Los hooks lo chequean y exit 0 si corren dentro del propio daemon. Sin este flag: el SessionStart hook también dispara al arrancar el launchd → el daemon se descargaba a sí mismo → KeepAlive respawn → loop spawneando bun zombies
- **Docs**: CLAUDE.md del CoS con sección "Channel conflict guard" extendida + gotchas nuevos (SNI filtering en WiFis específicas, bun PATH, zombies bun, debug con `launchctl print gui/$(id -u)/<agent>`). CLAUDE.md del Family con sección "Channel conflict guard" + mismos gotchas

### Cleanup — Remover integración Spotify completa
- **Removido del plugin:** `telegram-plugin/spotify-client.ts` eliminado, handlers `spotify:play|pause|skip|back|volup|voldown` y función `spotifyNoDeviceResult` / `isNoDeviceError` quitados de `callback-router.ts`. Imports de `spotify-client` removidos. Redesplegado a plugin cache 0.0.5 + 0.0.6
- **Removido del repo:** carpetas `spotify-miniapp-worker/` y `spotify-auth-worker/` borradas completas
- **Removido del .env:** `SPOTIFY_AUTH_WORKER_URL` (los CLIENT_ID/SECRET ya vivían como secrets del worker, no en .env local). Backup creado en `.env.backup-before-spotify-cleanup`
- **Desprovisionado Cloudflare:** `spotify-auth.carlos-cb4.workers.dev` + `spotify-miniapp.carlos-cb4.workers.dev` deleted via `wrangler delete`. KV namespace `spotify-auth-SPOTIFY_TOKENS` (id 48ced040...) deleted
- **Docs:** secciones "Spotify" y "Spotify Mini App (TWA)" removidas de CLAUDE.md. Comando deploy actualizado (sin spotify-client, wildcard `telegram/*/` cubre 0.0.5+0.0.6)
- **Conservado:** Spotify Developer App en console.spotify.com (eliminar es irreversible, Cal puede reactivar en el futuro). CHANGELOG + specs históricos quedan intactos por trazabilidad
- **Pendiente manual:** reset `setChatMenuButton` del bot a `type: commands` — Telegram API daba connection reset desde esta sesión. Comando en BACKLOG

### Fase 5.3 — Skill Detector (auto-instalación de skills)
- **Feature**: `skill-detector.sh` (cron domingo 21:30) escanea transcripts del CoS últimos 7 días, extrae digest de user+assistant messages con jq (max 500 líneas), pasa a `claude -p` con `skill-detector-prompt.md`. Detecta patrones conductuales con frecuencia ≥3/sem que ameriten skill dedicado. Evita duplicar skills existentes (lista enviada al prompt)
- **Feature**: `skill-install.sh <id>` — disparado por callback `skill:approve:<id>` async. Mecánico (NO pasa por LLM): lee propuesta JSON (ya incluye skill_body completo), valida name en kebab-case, escribe `commands/<name>.md` + copia a `~/.claude/commands/`, git commit + push, notifica Telegram con commit hash. Con rollback si commit falla
- **Feature**: Callbacks `skill:approve:<id>` / `skill:reject:<id>` mecánicos en `callback-router.ts`. Approve lanza installer via `spawn` detached
- **Prompt**: `skill-detector-prompt.md` con criterios explícitos (qué sí, qué no proponer), lista de skills existentes para anti-duplicate, formato JSON estricto con `frecuencia_semana` mínima 3
- **Plist**: `com.claude.skill-detector` (creado, NO cargado)
- **Fix colateral**: `extract-learnings.sh` — bug de macOS `find -newermt "@epoch"` no soportado. Cambiado a `touch -t <cursor>` + `-newer <ref>` (cursor exacto) o `-mtime -30` (primer run). Sin este fix, el batch nocturno de learnings tampoco habría encontrado transcripts

### Fase 5.2 — Morning Builds (scope B: propuesta + ejecución auto-restringida)
- **Feature**: `morning-build.sh` (cron 22:30) analiza contexto del día (git log, learnings pending, heartbeat log, tareas mañana) e invoca `claude -p` para generar UNA propuesta JSON concreta de mejora. Guarda a `~/.claude/morning-builds/proposals/<id>.json` y envía a Telegram con botones ✅/❌
- **Feature**: `morning-build-execute.sh <id>` ejecuta propuesta aprobada. Invoca `claude -p` con scope restringido a `commands/*`, `heartbeat-tasks/*`, `hooks/*.sh`, docs (`CLAUDE.md`, `BACKLOG.md`, `CHANGELOG.md`, `docs/**`). Bloquea plugin TS, workers, plists, settings.json. Clasifica output `DONE|ABORT|FAIL`, archiva JSON a implemented/failed/, notifica Telegram con commit hash
- **Feature**: Callbacks `build:approve:<id>` y `build:reject:<id>` mecánicos en `callback-router.ts`. Approve lanza executor async via `spawn` detached (no bloquea el callback). Reject mueve JSON a `rejected/`
- **Prompts**: `morning-build-prompt.md` (criterios de qué proponer + formato JSON) y `morning-build-exec-prompt.md` (scope explícito + respuestas `DONE|ABORT|FAIL`)
- **Plist**: `com.claude.morning-build` (creado, NO cargado — requiere aprobación Cal antes de activar)
- **Fix colateral**: `heartbeat.sh` — `--only <check>` ya NO incrementa failure counter (evita falso "heartbeat caído" durante debug con `--only`)

### Fase 5.1 — Self-improving Learnings
- **Feature**: Sistema de captura de aprendizajes con filesystem-RAG en `~/.claude/learnings/cos/`. CLAUDE.md queda lean — todo el conocimiento histórico vive en learnings/ + index.md como mapa central
- **Feature**: Skill `/learn <tipo> "<desc>"` para captura intencional (correction, decision, idea, error, pattern)
- **Feature**: Hook PostToolUse `learn-error.sh` captura errores automáticamente. Fix: solo dispara cuando `exit_code != 0` (el match de "error" en output texto era demasiado ruidoso y generaba feedback loop)
- **Feature**: Batch nocturno `extract-learnings.sh` lee transcripts del día via `claude -p` (prompt en `extract-learnings-prompt.md`). Plist `com.claude.extract-learnings` 21:55 daily (creado, NO cargado)
- **Feature**: `nightly-report.sh` extendido — LLM genera sección Learnings desde index.md + arma keyboard con callbacks `learn:keep|drop|keepall|dropall`, escribe batch IDs a `~/.claude/state/learn-batches/<id>`
- **Feature**: Callbacks `learn:*` mecánicos en `callback-router.ts` (ejecutan `flip_pending` / `move_to_archive` via bash, ~200ms, no pasan por LLM)
- **Feature**: Sync semanal `sync-learnings.sh` (domingo 21:00, plist NO cargado) — rsync `~/.claude/learnings/cos/` → `docs/learnings/` + commit + push
- **Library**: `~/.claude/hooks/learnings-lib.sh` — bash 3.2 compat (sin associative arrays). Funciones: `generate_id`, `slug`, `hash_normalize`, `is_duplicate`, `append_entry`, `update_index`, `find_entry_in_index`, `flip_pending`, `move_to_archive`, `tipo_to_filename`
- **Utilities**: `rebuild-learnings-index.sh` (recovery desde archivos de detalle), `learnings-status.sh` (cursor, pendings, top errores)
- **Spec/Plan**: `docs/superpowers/specs/2026-04-19-self-improving-learnings-design.md` + `docs/superpowers/plans/2026-04-19-self-improving-learnings.md`

### Fase 5.1 — Activación + verificación end-to-end
- **Activación**: cargados `com.claude.extract-learnings` (21:55 daily) y `com.claude.sync-learnings` (dom 21:00) con `launchctl bootstrap`
- **Smoke test**: pipeline completa verificada — `append_entry` → entry en index + detalle, `flip_pending` (keep) → `pending:false, valid:true`, `move_to_archive` (drop) → entry a `archive/YYYY-MM.md` con `rejected_at`, sistema limpio post-test
- **Canal Telegram reiniciado** por Cal para que el plugin fork recargue callbacks `learn:*`

### Docs — gotchas del entorno agregados a CLAUDE.md
- **Gotcha**: Bash 3.2 macOS default — sin `declare -A`, usar parallel arrays `("key|val")` + `${entry%%|*}` / `${entry#*|}`
- **Gotcha**: `set -euo pipefail` + `grep -c` sin match — grep devuelve exit 1, `-e` mata el script silencioso. Usar `set -uo pipefail` en scripts de status/conteo
- **Gotcha**: Plugin Telegram cache tiene versiones 0.0.5 y 0.0.6 coexistentes — deploy con wildcard `telegram/*/` las cubre
- **Gotcha**: PostToolUse hook `tool_response` no tiene `exit_code` top-level para Bash

### Backlog — decisiones de Cal
- **Expandir alcance "Deshacer Spotify"**: Cal confirmó remover TODA la integración Spotify del agente (Mini App + callbacks mecánicos + spotify-client + ambos workers + secrets). Mantener solo el Spotify Developer App en console.spotify.com (eliminar es irreversible). CLAUDE.md marcado con "⚠️ PENDIENTE DE REMOVER"
- **Convención de sesión**: sesión principal de Cal (Telegram) = temas operativos; sesión terminal = solo setup del agente

## 2026-04-19 (noche)

### Telegram plugin — robustez polling + Spotify UX
- **Fix**: Polling loop reintenta en cualquier error (antes solo 409). ETIMEDOUT/ECONNRESET/DNS rechazaban `bot.start()` y el polling moría silenciosamente mientras el proceso seguía vivo (MCP stdin). Ahora reset del attempt counter en `onStart` para que reconexiones sucesivas no acumulen backoff
- **Feature**: `editMessageText` desde `RouteResult` soporta inline keyboards (vía `RouteButton[][]`)
- **Feature**: Detección de "no active device" en respuestas de Spotify → UX con deep link "🎵 Abrir Spotify" en vez de error genérico

### Scripts operativos
- **Feature**: `scripts/health-check.sh` — detección end-to-end de long-poll a Telegram (409 Conflict = bot vivo; 200+empty = colgado). Fuerza relanzamiento del LaunchAgent si detecta caída
- **Feature**: `scripts/setup-menu-button.sh` — configura `setChatMenuButton` del bot para abrir la Mini App de Spotify como default

### Docs
- **CLAUDE.md**: agregado bloque "Test heartbeat puntual" + pattern para "Agregar nuevo check" (frontmatter mínimo + output esperado, sin reload)

## 2026-04-19 (tarde 2)

### Fase 4.3 CoS Proactivo — Health alertas reactivas
- **Feature**: 7 nuevos heartbeat checks de salud, cada uno como `~/.claude/heartbeat-tasks/health-*.md` con frontmatter (`schedule`, `priority`):
  - `health-sleep.md` (morning-wake/high) — anoche `sleep_totalSleep < 6h`
  - `health-steps-evening.md` (evening/medium) — `step_count < 6000` a las 17-19h
  - `health-sedentary.md` (business-hours/low) — `apple_stand_hour` bajo en horario laboral
  - `health-hrv-weekly.md` (weekly-monday-am/medium) — HRV semana actual <80% baseline 4 sem
  - `health-daylight.md` (late-afternoon/low) — `time_in_daylight < 15min` hoy
  - `health-strength-weekly.md` (weekly-monday-am/medium) — <3 sesiones strength en 7 días (meta 3x/sem)
  - `health-bodycomp-weekly.md` (weekly-monday-am/low) — recordatorio medir si data >7 días, o trend body fat + lean mass
- **Feature**: 5 schedule values nuevos en `should_run()` de heartbeat.sh — `morning-wake` (7-9am), `evening` (17-19h), `business-hours` (10-19h L-V), `weekly-monday-am` (Lun 8-9am), `late-afternoon` (17-18h)
- **Feature**: Bypass de `should_run()` cuando se usa `--only` (permite testear cualquier check fuera de ventana)
- **Feature**: Cleanup automático state files >7 días al inicio de cada heartbeat run (`find ~/.claude/state -name 'health-alerts-*.json' -mtime +7 -delete`)
- **Feature**: Anti-spam — state file diario `~/.claude/state/health-alerts-YYYY-MM-DD.json`. Cada check verifica su key antes de evaluar threshold; tras alertar, agrega su key con `jq` (1 alerta/día por tipo)
- **Worker**: Health worker extendido — endpoint `/workouts/summary?days=N&type=strength|cardio|...` ya existía (Fase 3), reusable por `health-strength-weekly`
- **Spec/Plan**: `docs/superpowers/specs/2026-04-19-health-alerts-design.md`, `docs/superpowers/plans/2026-04-19-health-alerts.md` (11 tareas)
- **Fix**: launchd plist heartbeat + proactive-ideas — agregado `~/.local/bin` al PATH para que encuentre el CLI de claude (causaba "heartbeat caído" tras 3 runs fallando con `gtimeout: failed to run command 'claude'`)

## 2026-04-19 (tarde)

### Fase 3 CoS Proactivo — Heartbeat + Proactive Ideas
- **Feature**: Heartbeat engine `~/.claude/hooks/heartbeat.sh` + launchd `com.claude.heartbeat` cargado (7am-22:30 cada 30min). Lee checks de `~/.claude/heartbeat-tasks/*.md` con frontmatter (`schedule`, `priority`), invoca `claude -p` por cada uno con timeout 60s, agrupa ALERTs por prioridad en un único mensaje a Telegram. Contador de fallos consecutivos en `~/.claude/state/heartbeat-failures` → alerta si ≥3 consecutivos. Log rotation automática a 5MB. Flags: `--dry-run`, `--only <name>`
- **Feature**: 4 checks iniciales — `overdue-tasks.md` (Notion vencidas, every/high), `flight-checkin.md` (Google Calendar AntoCataNoeCal, every/high), `incomplete-tasks.md` (sin asignado/deadline, morning-only/medium), `midday-steps.md` (Health worker, midday-only/medium, alerta si <3000)
- **Feature**: `~/.claude/hooks/heartbeat-status.sh` — observabilidad: último run, status launchctl, checks activos, últimos 5 alerts, failure counter
- **Feature**: Proactive ideas `~/.claude/hooks/proactive-ideas.sh` + plist `com.claude.proactive-ideas` (creado, NO cargado hasta que Cal complete tokens X/Threads + DB). Slots 9am=foco 🎯, 14:00=tactical ⚡, 19:00=lookahead 🔮. Lee posts propios X+Threads últimas 24h + tareas activas Notion → JSON `{title, body, source}` → escribe a Notion DB "Ideas Proactivas (CoS)" (`59e0439d7fe0483ab735575b9e0c1007`, anidada bajo "💡 Ideas") + Telegram. Graceful degradation si falta cualquier API
- **Spec/Plan**: `docs/superpowers/specs/2026-04-19-heartbeat-fase3-design.md`, `docs/superpowers/plans/2026-04-19-heartbeat-fase3.md`
- **Pendiente Cal**: crear app X (token + user_id), app Threads (token + user_id), compartir DB Ideas con integración "Claude CoS", agregar `NOTION_TASKS_DB_ID`, `NOTION_IDEAS_DB_ID`, `X_BEARER_TOKEN`, `X_USER_ID`, `THREADS_TOKEN`, `THREADS_USER_ID` a `~/.claude/channels/telegram/.env`. Después: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.proactive-ideas.plist`

## 2026-04-19

### Quick wins — hooks + Spotify UX + aprobaciones
- **Feature**: Hook `PreCompact` → `~/.claude/hooks/pre-compact-snapshot.sh` guarda snapshot del transcript antes de compactar. Últimos 20 snapshots en `~/.claude/compact-snapshots/`. Notifica Telegram si el trigger es manual
- **Feature**: Deep link Spotify cuando no hay device activo — callbacks `spotify:*` detectan "No active device" y responden con botón URL "🎵 Abrir Spotify" (https://open.spotify.com). Mensaje guía al usuario: abre Spotify, reproduce algo, reintenta
- **Feature**: Aprobaciones rápidas — callbacks `approve:yes[:context]` y `approve:no[:context]` procesados mecánicamente en el plugin (~200ms, sin LLM)
- **Feature**: `RouteResult` del callback-router ahora soporta `buttons?: RouteButton[][]` — los callbacks mecánicos pueden devolver inline keyboards (útil para el deep link Spotify y futuros flujos)

### Plugin Telegram — upgrade 0.0.5 → 0.0.6
- **Update**: Fork re-aplicado a versión 0.0.6 del plugin (0.0.5 quedó orphaned Apr 16). Upstream fix mergeado: retry polling con backoff en cualquier error (antes solo 409 se reintentaba — un ETIMEDOUT/ECONNRESET mataba el polling silenciosamente)
- **Update**: `~/.claude/CLAUDE.md` y `CLAUDE.md` de CoS actualizados con ruta 0.0.6
- **Backup**: `server.ts.original` de 0.0.6 guardado para comparar futuras actualizaciones upstream

### Cron jobs — rutinas diarias/semanales
- **Feature**: Reporte nocturno 22:00 → `~/.claude/hooks/nightly-report.sh` + `com.claude.nightly-report.plist`. Resumen del día (completadas, eventos), pendientes, plan mañana, sugerencia accionable. Notifica via Telegram
- **Feature**: Eisenhower semanal domingo 21:00 → `~/.claude/hooks/eisenhower-weekly.sh` + `com.claude.eisenhower-weekly.plist`. Clasifica tareas activas en matriz Urgente/Importante (Q1-Q4), top 3 Q1+Q2, recomendación '3 tareas para el lunes'. Solo reporta por Telegram, no actualiza Notion en primera iteración

### Audit + Mini App menu
- **Feature**: Hook `PostToolUse` filtrado a `mcp__notion__.*` → `~/.claude/hooks/notion-audit.sh` loguea escrituras a `~/.claude/logs/notion-audit.log`. Rotación automática al pasar 5MB
- **Feature**: `scripts/setup-menu-button.sh` — configura el botón de menú del bot (reemplaza lista `/commands` con Mini App). Ejecutado apuntando a Spotify Mini App (`https://spotify-miniapp.carlos-cb4.workers.dev`, label "🎵 Abrir")

## 2026-04-17

### Refactor estructural
- **Move**: `health-worker/` movido de `Chief of Staff Cal/` a `Health/` — vive con su agente
- **Update**: `CoS/CLAUDE.md` reducido a consumer con quick-ref de endpoints + pointer a `Health/CLAUDE.md`
- **Update**: `Health/CLAUDE.md` enriquecido con especificación completa del worker (endpoints, ingesta, métricas, dedup, deploy, ejemplos curl)

### Notion (cross-project)
- **Feature**: Creado `~/Claude Projects/notion-reference.md` — referencia global cargada bajo demanda: mapeo personas (pageId ↔ nombre) para 7 miembros del equipo Yape, schema DB Tareas (32 props), patterns jq para outputs grandes (70KB+), gotchas (users vs pages en API)
- **Update**: `Claude Projects/CLAUDE.md` referencia `notion-reference.md` junto a telegram-reference.md
- **Update**: `CoS/CLAUDE.md` sección Notion reducida a pointer al archivo cross-project

### Handoff Health
- **Feature**: Creado `Health/SESSION-HANDOFF.md` con contexto heredado de la sesión CoS para arrancar trabajo en el agente Health (Fase 1: metas + baseline + BD Notion + bot propio)

### Docs
- **Update**: Sección Audio de `CoS/CLAUDE.md` ahora incluye path completo del modelo whisper (`ggml-base.bin`) y comando completo de transcripción OGA → WAV → texto
- **Update**: `Health/CLAUDE.md` añade ejemplo POST /ingest para debugging

## 2026-04-12 (noche) — 2026-04-13

### Telegram UX
- **Fix**: Contenido de callbacks del menú ahora se envía como reply nuevo (no edit_message) — evita que el plugin destruya el contenido al navegar de vuelta
- **Fix**: Eliminados botones callback en mensajes de contenido — el plugin hacía edit mecánico al presionarlos

### Cron Briefings
- **Fix**: `timeout` → `gtimeout` (coreutils) — `timeout` no existe en macOS
- **Feature**: Notificación a Telegram via curl cuando un briefing falla (timeout o error)
- **Feature**: Rutas de GitHub Pages explícitas en el prompt para evitar búsquedas con find
- **Feature**: `Skill` agregado a --allowedTools del cron
- **Fix**: Removido `set -euo pipefail` para que no aborte si un país falla

### Briefings
- **Feature**: Briefing Peru 12 abril 2026 — cobertura elecciones generales (Keiko 16.6%, empate técnico segundo lugar, escándalo ONPE 63K votantes)

### Skill /today
- **Feature**: Sección de tareas Notion agregada — semana actual, agrupadas por asignado, ordenadas por deadline

### Backlog
- **Feature**: Agregado item Google Maps API (distancias/tiempos) al backlog CoS
- **Feature**: Agregado item Tipo de Gasto (Factura) al backlog Presupuesto

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

### Telegram UX & Documentación (sesión nocturna 2)
- **Feature**: Loading transitions mecánicas en plugin para callbacks `menu:*` — edit instantáneo (~150ms) con "⏳ Cargando..." antes de pasar al LLM
- **Docs**: `telegram-reference.md` — referencia cross-project consolidada (bot, plugin fork, callbacks, UX, integraciones, workers, gotchas)
- **Docs**: Referencia agregada en `Claude Projects/CLAUDE.md` y CoS `CLAUDE.md`

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
