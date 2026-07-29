# Menú interactivo de Telegram (@cal_jano_bot)

## Invocación
- Comando `/menu` desde el chat, o desde el ícono `/` junto al campo de texto.
- Comandos registrados: `/menu`, `/reset`.

## Estructura de botones

**Menú principal:**
```
[🔮 Briefing]    [📋 Tareas]    [📅 Agenda]
[🏥 Salud]       [💰 Cambio]    [🚗 Combustible]
[✈️ Vuelos]      [⚡ Tokens]
```

**Sub-menús:**

| Sección | Opciones |
|---------|---------|
| Briefing | 🇧🇴 Bolivia · 🇵🇪 Perú · 🇨🇴 Colombia |
| Tareas | Personal · Vibe Projects · Nueva |
| Agenda | Hoy · Esta semana · Outlook · Nuevo evento |
| Salud | Resumen · Tendencia · Workouts |
| Cambio | BCB Oficial · P2P Binance · Ambos |
| Combustible | → dispara `requestUserLocation` → estaciones cercanas |
| Vuelos | → pasa directo al LLM |
| Tokens | → pasa directo al LLM |

## Convención de callback_data

- **Prefijo `j:`** — todos los callbacks del menú interactivo de Jano.
- **Navegación** (`j:menu`, `j:brief`, `j:tasks`, `j:cal`, `j:health`, `j:fx`) — el daemon edita el mensaje sin invocar al LLM (~50ms).
- **Acción** (`j:brief:bo`, `j:tasks:personal`, etc.) — se convierten a texto natural y pasan al LLM como mensaje sintético (~2-5s).

**Ejemplos:**
```
j:brief         → navega al sub-menú Briefing (mecánico, daemon)
j:health        → navega al sub-menú Salud (mecánico, daemon)
j:brief:bo      → LLM recibe "Genera el briefing para Bolivia" (heavy)
j:tasks:new     → LLM recibe "Quiero agregar una nueva tarea" (heavy)
```

## Prefijos mecánicos fuera del menú (interceptados en `index.ts`, sin LLM)

Flujos con tarjeta propia. Todos se resuelven en el daemon editando la tarjeta; ninguno pasa por el
modelo. Los que escriben algo (Notion, disco, Gmail) llevan el lock anti-doble-tap de `cf-kv.ts`.

| Prefijo | Flujo | Escribe | Archivo |
|---|---|---|---|
| `jnl:*` | Journal de reflexión | Notion | `journal-callbacks.ts` |
| `bklg:*` | Ítems de `BACKLOG.md` | disco | `backlog-callbacks.ts` |
| `lrn:*` | Reflexión nocturna del self-learning | disco | `learning-callbacks.ts` |
| `tsk:*` | Propuesta de tarea desde un mail "(Tarea)" | Notion + Gmail | `proactive/task-callbacks.ts` |
| `resu-pick:*`, `j:resu:*` | Selector y checkpoint del resumidor | Readwise / YouTube / Feedbin | `tools/resumir.ts` |
| `mlog:`, `mskip:`, `msel:` | Reuniones → Foco Log (legacy) | Notion | `index.ts` |

⚠️ **Todos tienen que ir ARRIBA del catch-all de "Heavy callbacks legacy"** de `index.ts` — ese
bloque se traga cualquier `callback_data` sin prefijo `j:`/`build:` y se lo manda al LLM como
mensaje sintético. Puesto debajo, el botón es **código muerto sin ningún rastro en logs**, que es
un modo de falla caro de diagnosticar. Mismo motivo por el que `j:journal` va arriba del
`startsWith("j:")` genérico. Ya pasó con `bklg:*` y con `j:journal`, ambos detectados en review
antes de llegar a producción.

## Callback router edge (worker)

Light callbacks resueltos en CF Worker sin LLM (~300ms):
- `j:menu` / `j:brief` / `j:tasks` / `j:cal` / `j:health` / `j:fx` — navegan a sub-menú (mecánico en el daemon, no el worker).
- `j:brief:bo` / `j:tasks:personal` / etc. — acciones que pasan al LLM como mensaje sintético.
- `menu:<section>` / `nav:<section>` — alias legacy (menú viejo); redirige igual.
- `t:d:<pageId32>` — mark task done (status="Listo").
- `t:c:<pageId32>` — complete (alias de done).
- `t:s:<pageId32>` — skip (no-op, solo ack).
- `t:sd:<pageId32>` — set fecha=hoy.

Heavy callbacks (requieren LLM): `j:action:*`, `task:date:<pageId>` (parse "el viernes"), `task:change:<pageId>`, `build:approve:<id>` — caen al daemon vía queue como mensaje sintético `[callback] data`.

Spotify callbacks (`spotify:*`) descartados por el worker (out of scope v2). Pendiente: tool `spotifyControl` con lenguaje natural post-cutover.

## Cómo agregar nuevos items al menú

El menú `j:*` vive 100% en el daemon (NO en el worker). El worker solo maneja `t:d/c/s/sd` (legacy).

1. Editar `daemon-v2/src/menu.ts` — agregar botón en `buildXxxMenu()` o crear nueva función de sub-menú.
2. Si es **navegación**: agregar entrada en `NAV_MENUS` dentro de `handleMenuCallback` (callback_data → función de menú).
3. Si es **acción**: agregar entrada en `ACTION_TEXTS` dentro de `handleMenuCallback` (callback_data → texto natural para el LLM).
4. Agregar entry en `daemon-v2/src/agent.ts:TOOL_MESSAGES` si la acción dispara un tool específico.
5. Build solo del daemon: `npm -w @cos/shared run build && npm -w @cos/daemon run build` + restart daemon (no se necesita deploy del worker).

## Botones inline en reply
- Parámetro `buttons` — array de filas, cada fila array de `{text, callback_data}` o `{text, url}` (deep links). El keyboard se adjunta al último chunk.
- **MAX_KEYBOARD_ROWS:** 4 filas máximo (reply y edit_message) para evitar stutter en iOS.

## Flujos de revisión de tareas
- **<10 tareas:** Botones inline uno por uno con estado, asignado, deadline, emojis.
- **>10 tareas:** Lotes de 5 + texto libre. Incluir: nombre, estado emoji, 👤 asignado, ⏰ deadline, ⚠️ si vencido.
- **Callbacks mecánicos:** Usar pageId completo (32 hex) en callback_data (`t:d:{id32}`, `t:c:{id32}`, `t:s:{id32}`).
- **Callbacks que requieren input:** Pasar al LLM (`task:date`, `task:change`, etc.).
- **Mapeo personas:** Al inicio del flujo, resolver Notion person page IDs → nombres.

## Fallback outbound si MCP desconectado
```bash
TOKEN=$(grep COS_TELEGRAM_BOT_TOKEN ~/.cos-agent/.env | cut -d= -f2-) && \
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d "chat_id=94137698" --data-urlencode "text=..."
```
Funciona sin el plugin (solo outbound, no recibe mensajes entrantes).
