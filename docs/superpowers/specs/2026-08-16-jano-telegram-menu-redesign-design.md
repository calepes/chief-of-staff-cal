# Rediseño del menú de Telegram de Jano (2026-08-16)

## Contexto

Jano **ya tiene** un sistema de menú funcionando en producción (`daemon-v2/src/menu.ts`),
no es una creación desde cero:

- `buildMainMenu()` arma el teclado inline principal; `/menu` (comando registrado) y el
  botón persistente "📋 Menú" lo invocan.
- `handleMenuCallback()` (en `index.ts`) despacha callbacks con prefijo `j:`. Dos tipos:
  - **Navegación pura** (`NAV_MENUS`): edita el mensaje con un submenú, sin pasar por el LLM.
  - **Acción** (`ACTION_TEXT`): convierte el callback en un mensaje sintético en lenguaje
    natural y lo procesa como si Cal lo hubiera escrito — placeholder "⏳ Pensando..." mientras
    responde.
  - Excepción: `j:star`/`j:ytpl` son **mecánicos** (interceptados directo en `index.ts`, no
    pasan por `ACTION_TEXT`).
- Convenciones ya establecidas (`menu.ts:1-10`): prefijo `j:`, parse mode HTML siempre, máximo
  3 botones por fila, máximo 4 filas por menú, callback `j:menu` vuelve al principal.

Menú actual en vivo: Salud (submenu Resumen/Tendencia/Workouts), Cambio (submenu
BCB/P2P/Ambos), Combustible, Vuelos (submenu por aeropuerto → submenu salidas/llegadas),
Tokens, Starred, Playlist, Resumir, Journal, Estado.

Este documento es el resultado de una barrida completa de `agent-tools.ts` (82 tools) +
`agent-options.ts` (allowlist MCP) para decidir, junto con Cal, qué capacidades merecen
un botón y cómo se agrupan. Diseño iterado mensaje a mensaje con Cal hasta esta versión.

## Decisión de alcance

Botón solo para lo que Cal usa con frecuencia suficiente para justificar un atajo. Todo lo
demás sigue siendo 100% conversacional (ya funciona hoy, no se pierde nada quitándolo del
menú).

**Explícitamente fuera del menú** (quedan solo accesibles por texto libre):
Cine, Vacaciones (`listVacaciones`/`getVacacionDetail`), Referencias de Diseño, Achoradazos,
WhatsApp Contacts.

## Estructura aprobada — Nivel 1 (menú principal)

```
[🏠 Personal]     [🩺 Salud]        [📚 Learning]
[✈️ Viajes]       [💼 Yape]         [💰 Finanzas]
[🚗 Combustible]  [⚡ Tokens]       [💻 Claude Launcher]
[📋 Backlog]      [📓 Journal]
```

11 botones, 4 filas — dentro del límite de `menu.ts` (máx 3/fila, máx 4 filas). `💻 Claude
Launcher` y `📋 Backlog` son nuevos botones de acción directa (no categorías con submenú —
un solo tap, sin nivel 2), igual que `🚗 Combustible`/`⚡ Tokens` ya existentes.

| Botón | Tool / callback | Tipo | Estado |
|---|---|---|---|
| 🚗 Combustible | `j:fuel` → texto natural | acción | 🟢 ya existe |
| ⚡ Tokens | `j:tokens` → texto natural | acción | 🟢 ya existe |
| 💻 Claude Launcher | `listClaudeProjects` (lista proyectos; abrir uno específico pide el nombre) | acción | 🆕 |
| 📋 Backlog | `mapaBacklogs` (mapa de todos los backlogs; detalle de uno pide cuál) | acción | 🆕 |
| 📓 Journal | `j:journal` — mecánico, interceptado en `index.ts` ANTES del `startsWith("j:")` genérico (abre el modo journal) | mecánico | 🟢 ya existe, **detectado tarde** — no había entrado en el barrido ni en ninguna iteración de este diseño hasta que Cal lo notó ausente. Confirmado por Cal: se queda en nivel 1, botón directo, mismo lugar que tiene hoy. |

## Estructura aprobada — Nivel 2 (submenús por categoría)

Cal aprobó la agrupación por categoría; el detalle de qué tools expone cada submenú es
propuesta de esta sesión de diseño, para revisión antes de pasar a `writing-plans`.
Todos los submenús siguen el patrón ya existente: fila(s) de botones de acción + `← Volver`
(`j:menu`) al final.

### 🏠 Personal (`j:personal`)

| Botón | Tool detrás | Tipo |
|---|---|---|
| 📋 Things hoy | `executeClings(['today','--json'])` | acción |
| 📁 Proyectos | `executeClings(['projects','--json'])` | acción |
| 👪 Reminders | `executeRemctl(['today','--json'])` — familia + mercado | acción |

### 🩺 Salud (`j:health`) — ya existe, se agrega 1 botón

| Botón | Tool | Tipo | Estado |
|---|---|---|---|
| 📊 Resumen | `getHealthSummary` | acción | 🟢 ya existe |
| 📈 Tendencia | `getHealthTrend` | acción | 🟢 ya existe |
| 💪 Workouts | `getWorkouts` | acción | 🟢 ya existe |
| 🎯 Foco CAL | `getFocoCalStatus` | acción | 🆕 |

### 📚 Learning (`j:learning`) — reagrupa botones hoy top-level + agrega nuevos

| Botón | Tool / callback | Tipo | Estado |
|---|---|---|---|
| ⭐ Starred | `j:star` (mecánico) | mecánico | 🟢 se mueve de nivel 1 |
| 🎬 Playlist | `j:ytpl` (mecánico) | mecánico | 🟢 se mueve de nivel 1 |
| 📚 Resumir | `j:resumir` → texto natural | acción | 🟢 se mueve de nivel 1 |
| 📋 Estado resumidor | `j:estado` → texto natural | acción | 🟢 se mueve de nivel 1 |
| ✨ Readwise | `readwiseGetDailyReview` | acción | 🆕 |
| 📖 Reader | `readerListDocuments({location:'new'})` | acción | 🆕 |
| 📰 Feedbin | `mcp__feedbin__getUnreadEntries` | acción | 🆕 |
| 📕 Libros | `searchBooks` (o listar recientes) | acción | 🆕 |

8 botones → 3 filas (3+3+2) + Volver, dentro del límite de 4 filas.

**Nota:** mover `j:star`/`j:ytpl`/`j:resumir`/`j:estado` de nivel 1 a este submenú es un
cambio real de UX (un tap más para llegar) — Cal no lo confirmó explícitamente línea por
línea, solo aprobó que "Resumidor" viva dentro de Learning. Marcar para confirmar en la
revisión del spec.

### ✈️ Viajes (`j:flights`) — ya existe (Vuelos), se renombra y se agrega

| Botón | Tool / callback | Tipo | Estado |
|---|---|---|---|
| ✈️ Vuelos | submenú existente por aeropuerto (VVI/LPB/CBB/TJA/SRE/ORU) | navegación | 🟢 ya existe, sin cambios |
| 🛂 QR Aduana | `generarQrAduanaBolivia` → pide viajero/país si falta | acción | 🆕 |
| ✅ Check-in BoA | `mcp__boa-checkin__prepareBoaCheckin` | acción | 🆕 |

### 💼 Yape (`j:yape`)

| Botón | Tool | Tipo |
|---|---|---|
| 📊 KPI cards | `generarKpiCardYape` (+ `generarKpiCardLending` si Cal pide lending) | acción |
| 📅 Meetings | `showMeetingCards` | acción |
| 🎤 PPT wizard | `pptWizardLoad` (retoma el último wizard; `pptWizardSave` es interno del flujo) | acción |
| 🌧️ Lluvia/pronóstico | `mcp__lluvia-bolivia__getLluviaDia` (pide ciudad si falta) | acción |

### 💰 Finanzas (`j:fx`) — ya existe (Cambio), se agrega Inversiones

| Botón | Tool / callback | Tipo | Estado |
|---|---|---|---|
| 🏦 BCB | `j:fx:bcb` | acción | 🟢 ya existe |
| 💹 P2P Binance | `j:fx:p2p` | acción | 🟢 ya existe |
| 📊 Ambos | `j:fx:all` | acción | 🟢 ya existe |
| 📈 Inversiones | `mcp__inversiones-query__getPortfolioSummary` | acción | 🆕 |

## Fuera de alcance (explícito)

- No se toca ningún callback/tool existente más allá de moverlo de posición en el árbol de
  menús (mismo `callback_data`, mismo handler).
- No se cambia el mecanismo `NAV_MENUS`/`ACTION_TEXT`/mecánico — el rediseño reutiliza el
  patrón tal cual está en `menu.ts` hoy.
- No se agregan botones para nada de la lista "fuera del menú" arriba.
- PPT wizard: solo se expone `pptWizardLoad` como entrada — el flujo interno de guardado
  (`pptWizardSave`) sigue siendo conversacional, no botón propio.

## Verificación antes de dar por terminado (para la fase de implementación)

- Typecheck + build del daemon.
- Restart de Jano con confirmación explícita de Cal (norma ya establecida en este repo).
- Prueba real por Telegram de cada categoría nueva y de que las categorías existentes
  (Salud, Cambio, Vuelos) siguen funcionando igual tras el refactor de `buildMainMenu()`.
