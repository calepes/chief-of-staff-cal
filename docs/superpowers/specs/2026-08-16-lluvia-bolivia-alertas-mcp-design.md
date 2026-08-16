# Lluvia Bolivia — alertas proactivas + MCP on-demand (2026-08-16)

## Contexto

`lluvia-bolivia` (`~/Claude Projects/Personal/Apps/lluvia-bolivia/`) es una app standalone —
lluvia diaria **medida** (SYNOP/Ogimet) de 11 ciudades de Bolivia, ingestada por un cron Python
(`ingesta_d1.py`, launchd, 09:30 hora Bolivia) a D1 `clima-bolivia`, expuesta por un Worker CF
(`lluvia-bolivia.carlos-cb4.workers.dev`) con endpoints `/api/dia`, `/api/ciudades`, `/api/lluvia`,
`/api/resumen`, `/api/referencia`. Detalle completo: `HANDOFF.md`/`README.md` de ese proyecto y
memoria `project_lluvia_bolivia_d1`.

Cal pidió tres cosas, todas entregadas **vía Jano** (su bot de Telegram, no notificaciones
genéricas):
1. Alertas cuando un día de lluvia sea inusual para una ciudad.
2. Reporte diario de lluvia por región.
3. Confirmación de que el cron de ingesta cargó bien ese día.
4. Un MCP/tool que Jano cargue on-demand con dato real + pronóstico, para cualquier ciudad.

## Decisiones ya tomadas con Cal

- **Ciudades del cron proactivo (1-3):** solo 3 — `"Santa Cruz (centro)"`, `"Cochabamba"`,
  `"La Paz"` (strings exactos usados en la base, confirmados en `lluvia_bolivia.py`). El MCP
  on-demand (4) cubre las 11.
- **Formato de entrega:** 3 mensajes de Telegram **separados**, no uno consolidado — cada uno con
  su propio propósito.
- **Umbral de alerta:** desde "Considerable" en adelante (p75+, top 25% de los días de lluvia de
  esa ciudad) — no solo Fuerte/Excepcional.
- **Confirmación del cron:** Cal quiere un mensaje **todos los días** (éxito o falla), no solo
  cuando falla — a diferencia del criterio "solo reportar la excepción" que usan otros crons de
  Jano (`kpi-ingest-check`, `health-sync-check`). Decisión explícita, no un descuido.
- **Pronóstico:** **Open-Meteo Forecast API** (`api.open-meteo.com/v1/forecast`) — gratis, sin
  key, sin registro. Evaluado contra WeatherAPI/OpenWeatherMap (los que ya usa Vesta en
  `tools/weather.ts`): Bolivia no tiene radar meteorológico denso ni modelo regional de alta
  resolución en ninguno de los tres, así que el nowcasting "hyperlocal" que vende OpenWeatherMap no
  aplica acá — todo se reduce a qué modelo global usa cada uno. Open-Meteo, sin regional para los
  Andes, cae a `best_match` entre modelos globales (típicamente ECMWF IFS, el de mejor score de
  habilidad en precipitación en las verificaciones públicas OMM/ECMWF, consistentemente mejor que
  GFS). WeatherAPI/OpenWeatherMap son blends propietarios sin documentar qué modelo alimenta cada
  región. No existe verificación independiente específica para Bolivia — la decisión es la mejor
  fundamentada disponible, no una certeza. Nunca se presenta como dato medido: es pronóstico de
  modelo, y así se etiqueta en el output del tool y en cómo Jano lo comunica.

## Arquitectura

```
lluvia-bolivia Worker (YA EXISTE, sin cambios)
  /api/dia /api/ciudades /api/lluvia /api/resumen /api/referencia
        │                                    │
        │ fetch simple, sin auth             │ fetch simple, sin auth
        ▼                                    ▼
┌──────────────────────────┐      ┌──────────────────────────────┐
│ Jano — cron interno       │      │ MCP nuevo: mcp-lluvia-bolivia │
│ proactive/lluvia-check.ts │      │ (Worker CF, patrón            │
│ 09:50 La Paz, diario      │      │  exchange-rate-bolivia)       │
│ → 3 mensajes Telegram     │      │ + Open-Meteo (pronóstico)     │
└──────────────────────────┘      └──────────────────────────────┘
```

Cero cambios al Worker de `lluvia-bolivia`: `/api/dia?fecha&ciudad` ya devuelve `total` (mm) y
`contexto.etiqueta`/`contexto.percentil` (la categoría Poca/Normal/Considerable/Fuerte/Excepcional
ya calculada), y `/api/ciudades` ya da `hasta` (última fecha con dato) por ciudad — alcanza para
freshness-check sin agregar ningún endpoint.

## Componente 1 — Cron proactivo en Jano (`proactive/lluvia-check.ts`)

Nuevo cron interno (`scheduleLluviaCheck()`, mismo patrón que `scheduleHealthSyncCheck` —
`node-cron`, timezone `America/La_Paz`), registrado en `index.ts` `loop()`, horario **09:50 diario**
(20 min de margen sobre el cron de ingesta de las 09:30, que hoy tarda segundos).

Por cada una de las 3 ciudades, un fetch a `/api/dia?fecha={hoy}&ciudad={X}` (timeout 8-10s). Con
esos 3 resultados arma:

1. **Mensaje de reporte diario** (siempre) — tabla Rich Message ciudad/mm/categoría.
2. **Mensaje de confirmación del cron** (siempre) — éxito si las 3 ciudades tienen dato de hoy;
   falla con detalle (cuál ciudad, qué error) si falta alguna o el fetch da error.
3. **Mensaje de alerta** (solo si dispara) — cualquier ciudad con `contexto.etiqueta` en
   {Considerable, Fuerte, Excepcional}, con el detalle que ya trae `contexto` (percentil, máximo
   histórico de esa ciudad).

Los 3 usan `sendCronMessage()` (`proactive/rich-send.ts`, ya existente) — mismo fallback Rich→HTML
clásico que usan los demás crons.

**Dedup:** clave CF KV `jano:lluvia-check:{fecha}` (TTL 24h), mismo patrón que
`scheduleHealthSyncCheck` — evita duplicar si el daemon reinicia el mismo día.

**Test:** `lluvia-check.test.ts` con mock de `fetch` (patrón de `kpi-card-daily.test.ts`) — cubre
las 3 ramas de mensaje + el criterio de umbral + el caso de falla parcial (1 de 3 ciudades sin
dato).

## Componente 2 — MCP nuevo `mcp-lluvia-bolivia` (on-demand, 11 ciudades)

Server chico, mismo esqueleto que `exchange-rate-bolivia` (`servers/exchange-rate-bolivia/`):
`package.json`+`tsconfig.json` copiados, `src/index.ts` (stdio) + `src/worker.ts`
(`handleMcp`/`McpTool[]`/`dispatchTool`), desplegado a `mcp-lluvia-bolivia.carlos-cb4.workers.dev`.

| Tool | Envuelve | Uso |
|---|---|---|
| `getLluviaDia({ciudad, fecha?})` | `/api/dia` | "¿cuánto llovió en Cochabamba ayer?" — incluye categoría/percentil |
| `getLluviaSerie({ciudad, desde, hasta})` | `/api/lluvia` | serie de un rango |
| `getLluviaResumen({desde, hasta, ciudad?})` | `/api/resumen` | totales por mes |
| `getPronosticoLluvia({ciudad, dias?})` | **nuevo** — Open-Meteo Forecast API | "¿va a llover el finde en Tarija?" — hasta 16 días, explícitamente marcado como estimación |

`getPronosticoLluvia` necesita una tabla chica de lat/lon por ciudad (coordenadas públicas de cada
estación/aeropuerto, las 11) embebida en el worker — llama
`api.open-meteo.com/v1/forecast?latitude&longitude&daily=precipitation_sum,precipitation_probability_max&timezone=America/La_Paz&forecast_days=N`
y mapea la respuesta a `{fecha, mm_estimado, probabilidad}[]`.

**Registro en Jano:** entrada nueva en `BASE_OPTIONS.mcpServers` (`daemon-v2/src/index.ts`, remoto
vía URL como `naabol-flights`) + los 4 tools agregados a `allowedTools` en `agent-options.ts`. Sin
`alwaysLoad` — se carga on-demand vía ToolSearch, que es justamente lo que Cal pidió ("que Jano
cargue cuando se necesite").

**Test:** sin test unitario dedicado (mismo criterio que `exchange-rate-bolivia`/`naabol-flights`
en este repo — wrappers finos de fetch) — se verifica con el smoke-test de Node de
`mcp-servers/CLAUDE.md` antes de wirear en Jano.

## Manejo de errores

- Todo fetch (al Worker de lluvia o a Open-Meteo) con timeout explícito 8-10s.
- Cron de Jano: un fetch fallido de cualquier ciudad → el mensaje de confirmación reporta falla
  con detalle (mismo patrón `notifyFailure` de `kpi-card-daily.ts`), no rompe el resto del cron.
- MCP: error propagado con mensaje claro, sin retry automático — el LLM decide si reintentar.

## Verificación antes de dar por terminado

Build + typecheck + restart de Jano con confirmación explícita de Cal en cada restart (norma ya
establecida en este repo) + prueba real por Telegram después de cada restart.

## Fuera de alcance (explícito)

- No se toca el Worker de `lluvia-bolivia` ni la ingesta Python — todo lo nuevo consume la API ya
  existente.
- El pronóstico nunca se guarda en D1 (es efímero, se pide y se descarta) — D1 sigue siendo
  solo dato medido.
- No se unifica con `tools/weather.ts` de Vesta (WeatherAPI/OpenWeatherMap) — dominios distintos
  (clima general de Santa Cruz hoy/mañana vs. lluvia por ciudad con horizonte largo en 11
  ubicaciones), decisión evaluada y descartada arriba.
