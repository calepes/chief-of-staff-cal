# Research de competencia (Yape Bolivia) — flujo de negocio + diseño funcional y tecnológico

> Documento vivo. Actualizar acá cuando cambie el diseño (fuentes, dimensiones, persistencia).
> El detalle día a día de CADA decisión/gotcha (con fecha) sigue viviendo en `Jano/CLAUDE.md`,
> sección "Research de competencia" — este doc es el mapa completo, ese es el changelog narrado.

## 1. Flujo de negocio

**Qué es:** inteligencia competitiva semanal para Yape Bolivia. Vigila 6 billeteras/fintechs que
compiten por el mismo espacio (pagos, transferencias, remesas) y compara su actividad contra Yape.

**Para quién:** Cal. No hay otro consumidor — sin tool de Telegram, sin cron interno del daemon,
sin acceso desde el chat de Jano.

**A quién vigila (`ENTITIES`, 6 fijas):**

| Entidad | Producto | Dominio |
|---|---|---|
| Banco Sol | Altoke | altoke.com.bo |
| Banco Ganadero | Yolo Pago | bg.com.bo |
| Banco Económico | ZAS | baneco.com.bo/zas |
| — | Takenos | takenos.com |
| — | Meru | getmeru.com |
| — | Peso App | peso-latam.com |

Yape Bolivia mismo entra como **referencia propia** (no competidor, no corre el pipeline completo)
solo para la tabla comparativa de publicidad — ver §3.6.

**Qué preguntas responde, por dimensión:**

| Dimensión | Pregunta de negocio |
|---|---|
| **Producto** | ¿Sacaron versión nueva, cambió el rating, cambió el sitio? |
| **Estrategia** | ¿Alianzas, comunicados, cambios de T&C, posicionamiento? |
| **GTM** | ¿Campañas, promos, canales nuevos, lanzamientos? |
| **Hiring** | ¿Roles publicados en LinkedIn, posts institucionales? |
| **Pricing** | ¿Tarifas de transferencia, comisiones de remesa, tipo de cambio, límites? |
| *(transversal)* | ¿En qué gastan publicidad y a quién le hablan? (Google Ads + Meta) |
| *(transversal)* | ¿Qué comunican en redes propias (Instagram/TikTok/Facebook/X)? |
| *(transversal)* | ¿Cómo evolucionan sus seguidores semana a semana? |

Cuando un hallazgo choca directo contra algo de Yape (misma feature, misma tarifa, mismo público),
el informe lo dice explícito — "a diferencia de Yape, que no cobra comisión, X cobra Y" — pero solo
cuando la comparación es real, nunca forzada en cada línea.

**Cadencia:** semanal, automático (cron `launchd`, lunes 06:00 hora La Paz, ventana de 7 días por
default). También on-demand desde sesión interactiva de Claude Code vía el skill
`/research-competencia [timeframe_dias] [entidades]` — mismo código, timeframe/entidades a pedido.

**Dónde aparece el resultado:**
- **Notion** (fuente de verdad, persiste todo): informe semanal con tabla comparativa de ads +
  hallazgos por entidad, DB de "Cambios" (un registro por hallazgo, histórico completo y
  filtrable), y una página de "estado" por entidad (battlecard legible + snapshot JSON que sirve de
  baseline a la corrida siguiente).
- **Telegram** (@ClaudeCalbot, notifications — NO el bot de Jano): resumen corto de la corrida
  (cuántos hallazgos, quién más pautó, quién falló, link al informe).

**Qué NO hace:** no dispara ninguna acción (no arma un draft de respuesta, no crea tareas, no
alerta en caliente). Es puramente informativo — la decisión de actuar es 100% de Cal, leyendo
Notion o el resumen de Telegram.

---

## 2. Diseño funcional (qué hace, paso a paso)

Por corrida:

1. **Se abre una sesión de Chrome real** (perfil dedicado, logueado una vez por Cal) — si falla,
   el research sigue sin datos de redes sociales, todo lo demás corre igual.
2. **Las 6 entidades corren en tandas de 3 en simultáneo.** Por entidad, en paralelo:
   - **Mecánico:** versión + rating de la app (iOS/Android), texto del sitio propio.
   - **Agente LLM** (uno por entidad, con WebSearch): busca prensa/LinkedIn, recibe los datos
     mecánicos + el contenido social + los anuncios YA recolectados (no busca eso, se lo dan
     armado), compara contra el snapshot anterior (baseline) y contra el contexto fijo de Yape, y
     devuelve hallazgos nuevos + un battlecard actualizado (resumen ejecutivo, fortalezas,
     debilidades, nivel de amenaza).
   - **Social orgánico:** recorre Instagram/TikTok/Facebook/X de la entidad, filtra por la ventana
     de días pedida, y enriquece cada post con visión (imágenes) y transcripción+visión (videos).
   - **Publicidad:** consulta Google Ads Transparency Center y Meta Ad Library — qué está
     corriendo, si es nuevo o ya venía activo, formato, duración.
3. **Referencia propia de Yape:** en paralelo al lote de 6, se piden los mismos datos de
   publicidad (Google + Meta) para Yape Bolivia — sin agente LLM, sin social, solo para comparar
   volumen de ads.
4. **Se escribe el informe semanal a Notion**, con la tabla comparativa de ads primero y luego
   cada entidad con sus hallazgos nuevos.
5. **Se actualiza el estado de cada entidad** (battlecard + snapshot) para que sirva de baseline a
   la corrida siguiente, y se agrega un registro por hallazgo a la DB de "Cambios" (histórico
   consultable, no se pisa nunca).
6. **Se manda el resumen por Telegram.**

Una entidad que falla en cualquier punto queda marcada "⚠️ Falló" en el resumen — nunca aborta ni
contamina a las otras 5. Una fuente que falla dentro de una entidad (ads caído, social caído, sin
handles) deja esa parte en `null`/vacío y el resto sigue — el agente LLM sabe distinguir "no hay
datos de esta fuente" (falla técnica) de "no hay novedad" (dato real), y nunca inventa una a partir
de la otra.

---

## 3. Diseño tecnológico

**Standalone — NO vive en el daemon de Jano.** Es un script que corre por su cuenta, disparado por
un cron externo de `launchd` (`com.cal.jano-research-competencia`, lunes 06:00 La Paz). No hay tool
de Telegram ni cron interno del daemon — decisión explícita desde el diseño original.

### 3.1 Mapa de archivos

```
daemon-v2/
├── scripts/
│   ├── research-competencia-now.ts        # entrypoint del cron/CLI — env, orquesta, notifica
│   ├── research-competencia-chrome-login.ts  # login manual único al perfil de Chrome
│   ├── research-competencia-run-detached.sh  # corrida on-demand desacoplada (nohup+disown)
│   ├── research-competencia-apify-token.ts   # resuelve APIFY_TOKEN vía 1Password
│   ├── research-competencia-cf-token.ts      # resuelve token CF + database_id de D1 vía 1Password
│   ├── research-competencia-notify.ts        # envío del resumen / aviso de error a Telegram
│   ├── research-competencia-env.ts           # valida env vars requeridas antes de arrancar
│   ├── setup-notion-research-competencia.ts  # provisioning one-off de las DBs/páginas de Notion
│   └── setup-d1-research-competencia.ts      # provisioning one-off de la D1 database
└── src/tools/
    ├── research-competencia.ts            # ORQUESTADOR — concurrencia, timeouts, guard, resumen
    ├── research-competencia-entities.ts   # las 6 entidades + Yape (config fija, IDs de ads)
    ├── research-competencia-agent.ts      # prompt + parseo del agente LLM por entidad
    ├── research-competencia-sources.ts    # Fase 1 mecánica: app stores + sitio propio
    ├── research-competencia-social.ts     # dispatcher social: presupuesto de tiempo, enrich, texto
    ├── research-competencia-scrapers.ts   # Instagram + X vía Chrome real (DOM)
    ├── research-competencia-apify.ts      # Facebook + TikTok vía Apify (HTTP, sin browser)
    ├── research-competencia-browser.ts    # sesión de Chrome real vía CDP (perfil dedicado)
    ├── research-competencia-media.ts      # visión (imágenes) + transcripción (videos)
    ├── research-competencia-ads.ts        # Google Ads Transparency Center (RPC no oficial)
    ├── research-competencia-meta-ads.ts   # Meta Ad Library (scraping DOM, headless fresco)
    ├── research-competencia-notion.ts     # lectura/escritura de Notion (3 tipos de página/DB)
    ├── research-competencia-ids.ts        # IDs de las DBs/páginas de Notion (hardcoded)
    ├── research-competencia-d1.ts         # cliente D1 puro — fetch directo a la REST API de Cloudflare
    ├── research-competencia-history.ts    # dedupe por URL, inserción, agregación de tendencia
    └── research-competencia-types.ts      # tipos compartidos (Hallazgo, Battlecard, AdsKpis...)
```

### 3.2 Orquestador (`research-competencia.ts`)

- **Concurrencia:** `CONCURRENCY = 3` — las 6 entidades corren en 2 tandas de 3 (`runWithConcurrency`),
  nunca las 6 juntas (riesgo de rate-limit de Google Ads) ni secuencial (tardaría el doble sin
  necesidad).
- **Guard anti-overlap:** un flag en memoria de proceso (`researchInFlight`) evita dos corridas
  superpuestas dentro del MISMO proceso — no cubre dos procesos en paralelo (no hace falta: el
  script no corre así hoy).
- **Deadlines en cascada** (todos `Promise.race` contra un timer, con `.finally()` para no dejar un
  timer fantasma logueando un timeout después de que la promesa real ya ganó):
  - Social por entidad: **20 min** (`SOCIAL_TIMEOUT_MS`)
  - Agente LLM por entidad: **5 min** (`AGENT_TIMEOUT_MS`)
  - Bloque de ads (Google+Meta) por entidad, y el de la referencia de Yape: **2 min** (`ADS_TIMEOUT_MS`)
  - Dentro del social, el presupuesto de 15 min (`PER_ENTITY_BUDGET_MS`) se reparte en partes
    IGUALES entre las plataformas con handles configurados — así una plataforma lenta no le come
    el tiempo a las que corren después en el loop.
- **Aislamito de fallas en 2 niveles:** por FUENTE (ads/social/agente, cada uno con su propio
  try/catch → `null`/vacío) y por ENTIDAD (la entidad completa cae en `catch` y queda marcada con
  `error`, sin abortar el resto de la corrida ni la escritura a Notion de las demás).
- **`formatSummaryHtml`** arma el resumen de Telegram: total de hallazgos, quién tuvo, quién es
  primera corrida, quién falló, quién pautó más (usando `campanasNuevas` combinado — el split por
  red vive en la tabla de Notion, no en este renglón).

### 3.3 Fuente 1 — Mecánica (`research-competencia-sources.ts`)

App Store (iOS, por `trackId` o `searchTerm`) + Google Play (por `packageName`) + texto plano del
sitio propio (`fetchSiteText`, HTML→texto con `extractVisibleText`). Sin browser, `fetch` puro.

### 3.4 Fuente 2 — Agente LLM (`research-competencia-agent.ts`)

Un agente **one-off del Agent SDK** por entidad (`startup()`, `maxTurns: 20`, única tool permitida
`WebSearch`). Recibe en el prompt: el baseline (snapshot anterior completo), un bloque **fijo** de
contexto de Yape (posicionamiento/features/tarifas, extraído una vez de yape.com.bo, no se
re-investiga), los datos mecánicos nuevos, el bloque de texto social YA recolectado, y el bloque de
texto de ads YA recolectado. Instruido a:
- Generar hallazgos SOLO con fuente citable (URL) para cualquier hecho puntual — nunca completar
  "de memoria".
- Reusar tal cual las fortalezas/debilidades del battlecard anterior que sigan vigentes (no
  re-verificar cada corrida lo ya verificado).
- Buscar en la web SIEMPRE (WebSearch), incluso con mucho contenido social precargado — hay una
  regresión real documentada (2026-09-06, ver CLAUDE.md) donde el modelo dejó de buscar al haber
  más contenido en el prompt; el fix fue reforzar esa instrucción cerca del FINAL del prompt.

Devuelve un JSON estricto (`hallazgos[]` + `notas` + `battlecard`), parseado de forma tolerante
(`parseAgentJson` — regex `\{[\s\S]*\}` + `JSON.parse`, cae a vacío/default si no matchea).

### 3.5 Fuente 3 — Social orgánico (`-social.ts`, `-scrapers.ts`, `-apify.ts`, `-browser.ts`, `-media.ts`)

| Plataforma | Mecanismo | Motivo |
|---|---|---|
| Instagram | Chrome real (CDP) + extracción DOM del grid | Chromium headless de Playwright es detectado como bot incluso con cookie de sesión válida — Chrome real con perfil persistente no |
| X | Chrome real (CDP) + extracción DOM | Sin alternativa a Apify evaluada todavía |
| Facebook | **Apify** (`apify/facebook-posts-scraper`) | El feed vía DOM viene con el texto ofuscado (anti-scraping real, no bug de selector) |
| TikTok | **Apify** (`apidojo/tiktok-scraper`, `location:"BO"` obligatorio) | Captcha de slider bloquea el scraping directo; sin `location:"BO"` el actor devuelve 0 posts para cuentas bolivianas (proxy default en EE.UU.) |

La sesión de Chrome (perfil `~/.cos-agent/research-competencia-chrome-profile`) es **una sola por
corrida**, compartida por las 6 entidades — Cal se loguea una vez a mano
(`npm run research:chrome-login`) y la sesión persiste en disco entre corridas semanales.

Cada post recolectado pasa por `enrichPosts`: hasta 4 imágenes por post analizadas con visión
(`describeImage`), hasta 4 videos por cuenta con transcripción de audio + lectura de frames
(`analyzeVideo`) — tope de 8 posts por cuenta. Es el costo dominante de tiempo de toda la corrida
(hasta decenas de minutos por cuenta en el peor caso). Todo el enriquecimiento es secuencial
(`ponytail`, decisión deliberada — no hay necesidad probada de paralelizarlo todavía).

El texto final se arma intercalado round-robin por plataforma (`interleaveByPlatform`) antes de
truncar a 20.000 caracteres — así el truncado no siempre le come el espacio a la misma plataforma
(antes X, al ser la última del loop, era la primera en perderse).

### 3.6 Fuente 4 — Publicidad (`-ads.ts`, `-meta-ads.ts`)

| Fuente | Mecanismo | Qué expone |
|---|---|---|
| **Google Ads Transparency Center** | RPC interno no oficial (`SearchService/SearchCreatives`), `region=BO`, sin login | Anunciante, dominio destino, formato (imagen/display), fecha primera/última vez visto |
| **Meta Ad Library** | Headless FRESCO (sin la sesión logueada), scraping DOM, búsqueda por palabra clave + allowlist de nombre exacto | Igual + el COPY real del anuncio (Google no lo expone) |

Ambas son proxies de **volumen/actividad**, nunca de gasto real ni de impresiones/alcance — ninguna
fuente gratuita expone eso para anuncios comerciales en Bolivia.

**`computeAdsKpis`** (`-ads.ts`) consolida los creativos de ambas fuentes en un `AdsKpis`:
- `creativosActivos` / `campanasNuevas`: totales combinados Google+Meta (usados en el resumen de
  Telegram — "más activo en ads").
- **`google: {nuevos, existentes}` / `meta: {nuevos, existentes}`** — el split por red que Cal pidió
  (2026-09-08, en producción desde entonces; antes de eso se calculaba ad-hoc con un script
  descartable, fuera del pipeline real). `existentes = activos - nuevos` por red.
- `duracionPromedioDias` / `mixFormato`: SOLO de Google (Meta no expone fecha de fin ni formato).

Ambas fuentes tienen throttle: Google vía una **cola global a nivel de módulo** (serializa TODOS los
pedidos del proceso, sin importar de qué entidad vengan — necesario desde que las entidades corren
en paralelo) — hay un rate-limit real y duro documentado (baneo de IP de 20+ horas tras ~40-50
requests en un día). Meta no tiene throttle propio documentado (volumen mucho menor, 1 búsqueda por
entidad).

**Yape Bolivia como referencia** (`YAPE_ADS_REFERENCE`, fuera de `ENTITIES`): mismo par de fetches
+ `computeAdsKpis`, corrido en paralelo al lote de 6, sin agente ni social — solo para la primera
fila de la tabla comparativa ("Yape Bolivia (referencia)").

### 3.7 Persistencia — Notion (`-notion.ts`, `-ids.ts`)

Tres superficies, todas vía el CLI `ntn` (`callNtn`, `spawnSync` — bloqueante, aceptado a propósito
porque esto corre 1x/semana, no es hot path):

1. **Informe semanal** (DB `INFORME_DB`) — una página por corrida: tabla comparativa de ads primero
   (`buildAdsKpisBlocks`), luego cada entidad con sus hallazgos nuevos (o "sin novedades"/"primera
   corrida").
2. **DB de Cambios** (`CAMBIOS_DB`) — un registro POR HALLAZGO, histórico permanente y filtrable
   (Entidad/Dimensión/Fecha/Fuente/relación a la Corrida). Nunca se pisa.
3. **Página de estado por entidad** (`STATUS_PAGE_IDS`, una por entidad, hardcoded) — battlecard
   legible (heading + fortalezas/debilidades con hipervínculo a la fuente) MÁS un code-block con el
   `EntitySnapshot` completo en JSON, que es el baseline que lee la corrida siguiente
   (`readEntityState`). Se reemplaza entero en cada corrida (`replacePageBody`: borra todos los
   bloques hijos, escribe de nuevo) — no acumula historial, para eso está la DB de Cambios.

### 3.8 Modelo de datos (`research-competencia-types.ts`)

```
Dimension = "Producto" | "Estrategia" | "GTM" | "Hiring" | "Pricing"
Hallazgo      { dimension, descripcion, fuente }
Battlecard    { resumen, fortalezas: BattlecardPunto[], debilidades: BattlecardPunto[], amenaza }
BattlecardPunto { texto, fuente }             // fuente obligatoria salvo caracterización general
FollowerPoint { fecha, instagram, facebook }  // null = no se pudo leer esta corrida, no "cero"
EntitySnapshot{ entityId, updatedAt, ios?, android?, siteSnippet?, notas?, battlecard?,
                seguidoresHistorial? }        // tope 104 puntos (~2 años semanales)
AdsKpis       { creativosActivos, campanasNuevas, google:{nuevos,existentes},
                meta:{nuevos,existentes}, duracionPromedioDias, mixFormato }
```

### 3.9 Operación

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2"
npm run research:now -- --timeframe=7 [--entidades=takenos,meru] [--no-notify]
npm run research:chrome-login   # una vez, o cuando la sesión de Chrome expire (ventana visible)
```

- **Cron:** `launchd/com.cal.jano-research-competencia.plist` — lunes 06:00 La Paz. Instalación
  manual (no se autoinstala); ver comentarios del propio plist para instalar/verificar/desactivar.
- **Logs:** `~/Library/Logs/jano-research-competencia.{out,err}.log`.
- **Secretos:** `OPENROUTER_API_KEY`/`ELEVENLABS_API_KEY`/`NOTION_TOKEN`/`NOTIF_BOT_TOKEN` vía
  `dotenv` desde `~/.cos-agent/.env` + `~/.claude/notifications/.env` + `~/.claude/secrets/apps.env`
  (deuda conocida, sin migrar a 1Password). **`APIFY_TOKEN` y las credenciales D1
  (`CF_API_TOKEN_D1_RESEARCH_COMPETENCIA`/`D1_RESEARCH_COMPETENCIA_DATABASE_ID`) son la
  excepción** — por ser secretos nuevos, van al vault `Daemons` de 1Password y se resuelven con
  `op read` puntual (`resolveApifyToken`/`resolveD1Credentials`), sin `op run` para todo el script.
  Las credenciales D1 arrancaron reusando `DIGEST_CF_API_TOKEN` en texto plano (2026-09-08, ver
  historial abajo) y se migraron al vault el 2026-09-09 (ítem "Research Competencia D1", campos
  `credential`+`database_id`) — ya no queda ningún secreto de research-competencia en `apps.env`.
- **Corrida desacoplada de una sesión de Claude Code:** `scripts/research-competencia-run-detached.sh`
  (`nohup ... & disown`) — evita que el proceso muera si el harness de background del Bash tool lo
  mata (visto en vivo, causa exacta sin confirmar del todo).

### 3.10 Resiliencia y límites conocidos

- **Rate-limit de Google Ads es real y no mitigado del todo:** un baneo de IP de 20+ horas tras
  ~40-50 requests en un día. El throttle (2,5s entre pedidos + cola global) cubre el caso de ráfaga,
  no un umbral acumulado de horas/días. El volumen real (cron semanal) está muy por debajo del que
  disparó el bloqueo — sin garantía formal.
- **Endpoint de Google es NO oficial** (RPC interno) — puede romperse sin aviso; el síntoma es un
  log estructurado (`_ads_http` / `_ads_parse_failed`), nunca una excepción sin capturar.
- **Split Facebook/Instagram DENTRO de Meta Ad Library:** explorado y descartado (2026-09-04) — los
  íconos de plataforma no tienen `aria-label`, solo `mask-position` de un sprite CSS sin mapeo
  público confiable.
- **Sin Full Disk Access ni cookies de Safari** desde el rediseño a Chrome real (2026-09-04) — la
  sesión social vive 100% en el perfil de Chrome dedicado.
- **`campanasNuevas`/`creativosActivos` combinados siguen sin split** en el resumen de Telegram
  (`formatSummaryHtml`) — el split Google/Meta vive solo en la tabla de Notion. Extender el resumen
  de Telegram con el mismo split sería un cambio aparte, no incluido acá.

### 3.11 Histórico acumulado (D1)

Desde 2026-09-08: cada post enriquecido (visión/transcripción) se guarda en una D1 database
(`research-competencia`, tabla `posts`, dedupe por `url UNIQUE`) — spec completo en
`docs/superpowers/specs/2026-09-08-research-competencia-historico-design.md`. Antes de enriquecer
un post, `fetchSocialText` consulta D1 por su URL; si ya existe, reusa el análisis guardado en vez
de re-pagar visión/transcripción. El agente LLM recibe un resumen agregado (conteo/promedio
semanal de los últimos 90 días, `getAggregateStats`) como contexto de tendencia — nunca posts
crudos históricos completos.

Acceso vía REST API de Cloudflare directa (sin Worker, sin wrangler). Token + `database_id`
resueltos desde el vault `Daemons` de 1Password (ítem "Research Competencia D1", campos
`credential`/`database_id`) por `resolveD1Credentials()` (`research-competencia-cf-token.ts`) —
mismo patrón que `APIFY_TOKEN`. Migrado el 2026-09-09 desde el diseño original (2026-09-08), que
reusaba `DIGEST_CF_API_TOKEN` en texto plano de `apps.env` para evitar crear un ítem 1Password
nuevo — ver "Decisión revisada" en el plan de implementación para el razonamiento original.

Fail-soft en toda la cadena: si 1Password/D1 no responde, el research corre exactamente igual que
antes de esta feature (sin dedupe, sin bloque de tendencia).

Retención: indefinida, sin purga — el volumen (≤8 posts/semana × 22 handles) nunca justifica un
tope rodante.

---

## Historial resumido (fechas clave — detalle completo en `Jano/CLAUDE.md`)

| Fecha | Hito |
|---|---|
| 2026-08-31 | Fase 1: mecánico + agente LLM, 6 entidades, cron semanal |
| 2026-09-02/03 | Fase 2: scraping social (cookies Safari, luego descartado) |
| 2026-09-03/04 | Google Ads Transparency agregado; rediseño a Chrome real vía CDP |
| 2026-09-04/05 | Meta Ad Library agregado; Facebook/TikTok migrados a Apify |
| 2026-09-05/06 | Paralelización de entidades (3 a la vez); presupuesto social dividido por plataforma; dimensión Pricing + contexto de Yape; KPIs de ads propios (referencia Yape) |
| 2026-09-08 | Split Google/Meta nuevos/existentes en la tabla de ads llevado a producción (antes era ad-hoc, fuera del código) |
| 2026-09-08 | Histórico D1: dedupe de posts por URL + bloque de tendencia agregada en el prompt del agente |
| 2026-09-09 | Credenciales D1 migradas de `apps.env` (texto plano) al vault `Daemons` de 1Password |
