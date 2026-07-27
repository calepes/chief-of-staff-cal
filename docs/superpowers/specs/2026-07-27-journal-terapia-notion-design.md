# Journal de reflexión (terapia) — Notion + Jano

**Fecha:** 2026-07-27
**Estado:** diseño aprobado, sin implementar

## Problema

Cal está en terapia (con Valeria) y quiere un lugar donde descargar pensamientos y
reflexiones sin fricción, y que de esa descarga cruda salgan las reflexiones que valen
la pena conservar.

Hoy eso vive disperso: la página **Terapia CAL** (Notion, bajo *Mental Health*) tiene
párrafos sueltos ("Me siento chiquito", "Miedo confrontación"), una sub-página
*Semana 17* con un reporte estructurado de la terapia, y *Tarea Valores*. En paralelo,
**Resonate Calendar** —la DB de insights que Cal cura hace años— ya recibe entradas
`Type: Reflexion` con `Tags: Terapia` (2 creadas el 2026-07-27), pero cargadas a mano.

Falta la capa de captura: un journal con fecha y hora donde el pensamiento quede **tal
cual**, y un puente hacia Resonate para lo que merece destilarse.

## Decisiones tomadas

| Decisión | Elegido | Por qué |
|---|---|---|
| Cómo llega una reflexión a Resonate | Checkpoint en el momento **+** barrido semanal | Nada entra a Resonate sin OK de Cal; el barrido recoge lo que quedó suelto |
| Metadata que agrega Jano | Fecha/hora + origen, ánimo + intensidad, y relaciones a **Topics** y **Big Themes** | Hace el journal consultable y cruzable con Health, reusando el vocabulario que Cal ya tiene |
| Vínculo Journal ↔ Resonate | Relación **bidireccional** + cita del texto crudo | Trazabilidad: de la reflexión pulida se puede bajar al momento exacto |
| Cómo se dispara la captura | Prefijo `journal:`/`diario:` **+** modo journal con botón | El modo cubre la descarga larga; el prefijo, el pensamiento suelto |
| Aprobación de la metadata | Patrón `propose → botones` de Pecunia | Ya probado en producción; permite ajustar campo por campo |
| Barrido semanal | **Cron dominical** | Que el sistema no dependa de que Cal se acuerde de pedirlo |

## Bases de Notion involucradas

| DB / página | ID | Rol |
|---|---|---|
| Página *Mental Health* | `f2cab0c2-f8d0-48c3-a37f-c4f55c59cc39` | Contenedor de la DB nueva |
| **Journal** | *a crear* | Captura cruda |
| **Resonate Calendar** | `e269b467-6578-48b3-8acd-1f48367b0e2a` | Destilado curado |
| **Topics** | `39fdd6fd-abe5-4971-ab1e-0ecc0e8528d7` | 60 entradas; incluye *Terapia, Psicología, Autoestima, Creencias, Identidad, Relaciones, Psicología masculina, Foco, Disciplina* |
| **Big Themes** | `0235e414-576a-4531-9ed6-535867f7172a` | 15 paraguas; incluye *Better Me, Better Leader, Better Parents* |

Topics y Big Themes son **dos bases distintas**. El Journal tendrá una relación separada
a cada una, igual que Resonate Calendar.

## 1. Modelo de datos

### DB nueva `Journal` (dentro de *Mental Health*)

| Propiedad | Tipo | Quién la llena |
|---|---|---|
| `Pensamiento` | title | Jano — resumen corto (~60 chars) para escanear la tabla |
| `Fecha y hora` | date **con hora** | automático |
| `Extracto` | rich_text | truncado mecánico a ~200 chars, preview en la vista |
| `Origen` | select: `Texto` · `Voz` · `Sesión terapia` | automático según el canal |
| `Ánimo` | select: `😔 Bajo` · `😐 Neutro` · `🙂 Bien` · `😤 Tensionado` · `😰 Ansioso` | Jano infiere, Cal corrige |
| `Intensidad` | number (1-5) | Jano infiere, Cal corrige |
| `Topics` | relation → **Topics** | Jano propone de las existentes |
| `Big Themes` | relation → **Big Themes** | Jano propone de las 15 existentes |
| `Estado` | select: `Sin revisar` · `Destilado` · `Descartado` | lo mueve el flujo |
| `Reflexión` | relation → **Resonate Calendar** | se llena al destilar |

**El texto literal completo va al cuerpo de la página, no a una propiedad.** Las
propiedades `rich_text` de Notion cortan a 2.000 caracteres: una descarga de voz larga
perdería texto en silencio. En el cuerpo no hay límite y queda sin editar.

`Estado` es lo que sostiene el barrido: todo entra como `Sin revisar`; el checkpoint lo
mueve a `Destilado` o `Descartado`; el domingo Jano muestra lo que sigue en `Sin revisar`.

### Cambio en `Resonate Calendar`

Se agrega **una sola** propiedad: `Journal` (relation → Journal), contraparte de
`Reflexión`. Nada más se toca — `Type: Reflexion`, `Tags: Terapia`, `Situacion`,
`Big Themes` y `Topics` se siguen usando como hoy.

## 2. Captura

Dos entradas, un solo camino de guardado.

**Prefijo** (pensamiento suelto): mensaje que empieza con `journal:` o `diario:` (con o
sin espacio, sin distinguir mayúsculas). Lo que sigue se guarda literal; Jano confirma
con la tarjeta y ahí termina.

**Modo journal** (descarga larga): botón `📓 Journal` en el menú. Jano abre el modo con
un mensaje ancla:

```
📓 Modo journal abierto
Todo lo que mandes —texto o voz— se guarda tal cual.
                                    [⏹️ Cerrar]
```

Cada mensaje posterior entra al Journal. Al cerrar, Jano **edita ese mismo mensaje** con
el resumen de la tanda. El modo vive en CF KV (`jano:journal-mode:{chatId}`) con **TTL de
2 horas**: si Cal olvida cerrarlo, expira solo y Jano avisa.

> **Revisado el mismo día (2026-07-27):** bajado a **30 minutos** tras el primer uso real —
> con la ventana de 2h un pedido normal de Cal se guardó como pensamiento. El TTL se
> refresca en cada guardado, así que una descarga larga no se corta a mitad.

**Voz:** reusa el pipeline de transcripción existente (whisper). La transcripción cruda
*es* el texto literal, `Origen: Voz`. Sin reescritura ni corrección de estilo.

### Guardado en dos tiempos (crítico)

1. **Mecánico, sin LLM.** Al llegar el mensaje se crea la fila con el texto tal cual,
   `Fecha y hora`, `Origen`, `Extracto` (truncado, no interpretado) y
   `Estado: Sin revisar`. Un pensamiento **nunca se pierde**, aunque falle el modelo, se
   caiga la red o se corte el turno.
2. **Enriquecimiento con LLM, después.** Completa `Pensamiento`, `Ánimo`, `Intensidad`,
   `Topics` y `Big Themes`. Si falla, la entrada ya está guardada íntegra y con preview
   legible; solo queda sin metadata y la recoge el barrido.

`Origen` sale del canal: `Voz` si el mensaje fue nota de voz, `Texto` si fue escrito.
`Sesión terapia` solo si Cal lo indica al abrir el modo journal — Jano no lo infiere.

Esa separación es lo que hace que "Jano escribe tal cual" sea literal: **el texto que se
persiste nunca pasa por el modelo.**

## 3. Aprobación de la metadata (patrón Pecunia)

Diferencia con Pecunia: allá la propuesta *crea* el registro; acá la fila **ya existe**.
La propuesta solo *completa* campos, así que no aprobarla nunca es inocuo.

```
📓 Guardado — 27/07 · 14:32

"Hoy en la sesión me di cuenta de que cuando alguien
me cuestiona en la reunión, lo primero que hago es..."

Propongo completar:
• Título — Miedo a la confrontación en reuniones
• Ánimo — 😤 Tensionado · Intensidad 4/5
• Topics — Terapia, Autoestima, Psicología masculina
• Big Theme — Better Me

[✅ Aplicar]        [✏️ Título]
[🎭 Ánimo]          [🏷️ Topics]
[🎯 Big Theme]      [❌ Dejar sin metadata]
```

Cada botón de ajuste abre un picker y vuelve a la tarjeta — **siempre el mismo mensaje
ancla editado**, nunca uno nuevo:

- `🎭 Ánimo` → los 5 estados + intensidad 1-5.
- `🏷️ Topics` → los propuestos como toggles `✅`/`⬜` (patrón `togasn:` de Pecunia) más
  los más usados en terapia. Si Cal escribe uno que no existe, Jano lo crea en Topics.
- `🎯 Big Theme` → los 15 existentes, selección única.
- `✏️ Título` → Cal responde con el texto.

Recién `✅ Aplicar` escribe en Notion. Después queda `↩️ Deshacer` por 10 minutos con
snapshot del estado previo.

Del patrón de Pecunia se copia:

- Payload en CF KV (`journal:prop:{chatId}:{shortId}`), **TTL 1 hora** (no 10 min: Cal
  journalea de noche y puede tardar). Al expirar, la entrada queda `Sin revisar`.
- Todos los callbacks son **HEAVY** (van al daemon, no al worker) porque escriben en Notion.
- Lock anti-doble-tap por `(chatId, userId)` reusando `tryAcquireLock` de `cf-kv.ts`.
  **TTL mínimo 60s** — Cloudflare KV rechaza valores menores con un 400 silencioso.
- Al aplicar, si Jano detectó una reflexión, **la misma tarjeta se transforma** en la
  propuesta para Resonate. Si no, cierra ahí.

## 4. Destilación a Resonate

### 4a. Checkpoint en el momento

```
🌟 Acá hay una reflexión

Título — Miedo a la confrontación en reuniones
Situación — Sesión con Valeria, 27/07
Type — Reflexion  ·  Tags — Terapia
Topics — Terapia, Autoestima
Big Theme — Better Me

[✅ Guardar en Resonate]   [✏️ Editar]
[⏭️ Ahora no]
```

Al guardar crea la fila en Resonate Calendar con `Name`, `Fecha`, `Type: Reflexion`,
`Tags: Terapia`, `Situacion`, `Topics`, `Big Themes` y `Journal` → la entrada de origen.
El texto crudo se copia como *quote* en el cuerpo. La entrada del Journal pasa a
`Destilado`. `⏭️ Ahora no` la deja `Sin revisar`.

**Criterio de detección** (explícito en el system prompt): hay reflexión cuando el
pensamiento contiene un **aprendizaje, patrón o decisión que sigue siendo cierto mañana**.
No la hay cuando es registro de estado ("hoy amanecí cansado") o narración sin conclusión.
**Ante la duda, no propone** — el barrido semanal es la red.

### 4b. Barrido dominical

Cron **domingos 19:00 hora La Paz**. Junta las entradas `Sin revisar` de los últimos 7
días y muestra un selector (patrón `buildQueueSelector` del resumidor):

```
📓 7 pensamientos sin destilar

1. Miedo a la confrontación en reuniones · 22/07
2. Culpa con mis papás · 23/07
3. Lo de Antonia y la paciencia · 25/07
...

[1] [2] [3] [4] [5]
[✅ Revisar todos]  [❌ Ahora no]
```

Tocar uno entra al checkpoint de 4a para ese pensamiento. Dedup en KV para no repetir el
aviso si ya se revisó esa semana.

**Costo arquitectónico asumido:** el 2026-07-14 se decidió dejar Jano reactivo, con dos
excepciones proactivas (sync de Health y ingesta de KPIs). Este cron es la **tercera**,
decidida explícitamente por Cal el 2026-07-27. Si al reactivarse otros crons coinciden en
la misma ventana, aplicar el patrón `digest-queue.ts` de Vesta en vez de `sendMessage`
suelto.

## 5. Implementación

### Setup en Notion (una vez, con `ntn` desde sesión interactiva)

1. Crear la DB `Journal` bajo *Mental Health* con las 10 propiedades.
2. Agregar la propiedad `Journal` (relation → Journal) a Resonate Calendar.

Siempre con `--notion-version 2022-06-28`: la versión default ignora propiedades al crear
DBs y devuelve esquemas vacíos.

### Archivos nuevos (`daemon-v2/src/`)

| Archivo | Responsabilidad |
|---|---|
| `tools/journal.ts` | Escrituras a Notion: crear entrada cruda, aplicar metadata, crear fila en Resonate, `revert*` del deshacer |
| `journal-card.ts` | Render **puro** de tarjetas y teclados — sin red, testeable al 100% |
| `journal-store.ts` | Payloads y snapshots de undo en CF KV (espejo de `proposal-store.ts`) |
| `journal-callbacks.ts` | Handlers de los callbacks `jnl:*` |
| `proactive/journal-sweep.ts` | Cron dominical con dedup |

### Archivos a modificar

| Archivo | Cambio |
|---|---|
| `index.ts` | Intercepta prefijo y modo journal **antes del LLM** (mecánico); registra `scheduleJournalSweep()`; rutea callbacks `jnl:` |
| `menu.ts` (daemon + worker) | Botón `📓 Journal` |
| `worker-v2/src/callback-router.ts` | Prefijo `jnl:` a `HEAVY_PREFIXES` |
| `agent-tools.ts` | Tool `consultarJournal` (solo lectura) |
| `system-prompt.ts` | Sección Journal + criterio de detección de reflexión |
| `agent.ts` | Entrada en `TOOL_MESSAGES` |

Las tools de `cos-tools` se auto-allowlistean vía el mapeo de `index.ts`; no hace falta
tocar `agent-options.ts`.

### Testing

Con test unitario (sin red): parseo del prefijo, render de cada tarjeta y teclado,
transiciones de `Estado`, toggles de Topics, dedup del barrido, y paginación de mensajes
>4096 chars.

Para la escritura real a Notion, una prueba end-to-end con una entrada de descarte. **El
borrado de esa entrada requiere autorización explícita de Cal antes de ejecutarse.**

Tras editar código del daemon, correr el subagent `daemon-health-reviewer`.

## Riesgos

- **El modo journal intercepta todos los mensajes mientras está abierto.** Si queda
  abierto y Cal escribe "¿qué vuelos hay mañana?", se guarda como pensamiento en vez de
  responder. Mitigado con el TTL de 30 minutos, el botón ⏹️ Cerrar journal en cada tarjeta guardada,
  y el mensaje ancla siempre visible; no
  eliminado — es el precio de que el modo no reinterprete nada.
- **Falsos positivos de detección de reflexión.** Mitigado con el criterio explícito y la
  regla "ante la duda, no propone".
- **Tercera excepción a la arquitectura reactiva** (ver 4b).

## Fuera de alcance

- Migrar los párrafos sueltos que ya existen en *Terapia CAL* a la DB Journal.
- Cruzar el journal con datos de Health (HRV, sueño). El modelo de datos lo habilita
  (`Ánimo` + `Intensidad` + timestamp), pero la correlación es un proyecto aparte.
- Reportes automáticos tipo el de *Semana 17*.
