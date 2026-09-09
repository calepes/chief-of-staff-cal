# Spec: Histórico acumulado de posts — Research de competencia (Yape Bolivia)

**Fecha:** 2026-09-08
**Estado:** Aprobado por Cal

---

## Propósito

El research de competencia (`docs/references/research-competencia.md`) hoy es una serie de fotografías puntuales: cada corrida semanal trae hasta 8 posts recientes por cuenta, los usa para el informe de esa semana, y no queda nada más — el único dato que persiste entre corridas es el conteo de seguidores (`EntitySnapshot.seguidoresHistorial`). No hay archivo acumulado de posts, no hay deduplicación entre corridas, y no hay forma de responder "¿qué publicó X en los últimos 3 meses?" sin volver a scrapear.

Esta pieza agrega un **archivo histórico acumulado de posts**, para:
1. Consultar/buscar contenido pasado (no solo el informe de la semana).
2. Detectar tendencias y patrones temporales (frecuencia de publicación, picos).
3. Dar al agente LLM semanal contexto agregado de más historia real, sin re-scrapear ni re-pagar análisis.
4. Servir de respaldo bruto — no perder lo que ya se scrapeó y analizó.

## No-objetivos

- No es una base vectorial ni de búsqueda semántica — a este volumen (ver "Volumen esperado" abajo), filtros SQL + texto crudo pasado al LLM en el momento de la consulta alcanza. Ver la sección "Por qué no vectorial".
- No reemplaza Notion — informes, battlecards y la DB de Cambios siguen exactamente igual. Esto es una capa nueva por debajo, no un rediseño de lo existente.
- No cambia el tope de posts/videos por cuenta de la corrida semanal regular (`MAX_POSTS_PER_ACCOUNT=8`, `MAX_VIDEOS_PER_ACCOUNT=4`) — eso es aparte, ver "Backfill inicial".

---

## Arquitectura

Tres piezas:

1. **D1 (`research-competencia`, Cloudflare) — el archivo histórico.** Accedido vía la REST API de Cloudflare directa (`POST /accounts/{id}/d1/database/{db_id}/query`) desde el script Node (`research-competencia-now.ts`), con `CF_API_TOKEN` — mismo patrón que otros daemons del workspace. No hace falta desplegar un Worker: el script corre local y puede hacer ese `fetch` igual que ya hace con Google Ads/Meta Ad Library.
2. **`research-competencia-social.ts` — el flujo semanal, con dedupe antes de gastar.** Antes de enriquecer un post (visión/transcripción), se consulta D1 por URL. Si ya existe, se reusa su análisis guardado. Si no, se enriquece como hoy y se inserta.
3. **Notion sin cambios.**

---

## Modelo de datos

```sql
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  platform TEXT NOT NULL,           -- instagram | tiktok | facebook | x
  handle TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,         -- dedupe key, ver "Por qué UNIQUE(url) alcanza"
  fecha TEXT,                       -- YYYY-MM-DD, nullable (mismo criterio que SocialPost.fecha hoy)
  caption TEXT,
  es_video INTEGER NOT NULL,        -- 0/1
  media_urls TEXT,                  -- JSON array
  imagenes_desc TEXT,               -- JSON array de descripciones de visión, NULL si no se enriqueció
  video_transcripcion TEXT,
  video_frames TEXT,                -- JSON array
  run_id TEXT NOT NULL,             -- corrida que lo detectó/insertó, trazabilidad
  first_seen_at TEXT NOT NULL       -- timestamp ISO de inserción
);
CREATE INDEX idx_posts_entity_fecha ON posts(entity_id, fecha);
```

Una tabla plana — crudo y enriquecido conviven en la misma fila porque siempre viajan juntos 1:1 por post; partirlos en dos tablas sería normalizar sin necesidad real.

**Retención: indefinida, sin purga.** A este volumen (ver abajo) el costo de guardar para siempre es despreciable — no hay tope rodante como el de `seguidoresHistorial`.

### Por qué `UNIQUE(url)` alcanza

Verificado en vivo el 2026-09-08: se corrió `scrapeFacebookApify` dos veces seguidas contra `altoke.bo` (real, vía Apify) y las 8 URLs devueltas fueron **idénticas** entre ambas corridas — dos formatos estables, ninguno con parámetros que roten (`facebook.com/altoke.bo/posts/pfbid...` para posts, `facebook.com/reel/{id}/` para reels; el `pfbid` es un identificador opaco permanente de Facebook, no un token de tracking). Instagram (shortcode), X (status ID) y TikTok (`id` del video, que nosotros mismos armamos en la URL) son estables por diseño.

Salvedad: la prueba cubre estabilidad de corto plazo (~1 minuto entre corridas), no semana a semana. Si en producción aparece un duplicado real, el fix es agregar un fallback de dedupe por `(entity_id, platform, handle, fecha, hash del caption)` — decisión diferida a cuando el problema sea real, no hipotético.

### Por qué no vectorial

El volumen total esperado (22 handles × ≤8 posts/semana en la corriente regular) nunca se acerca a la escala donde una base vectorial paga su costo (millones de documentos, búsqueda por significado sin palabras clave). A este volumen:
- **Tendencias/conteos** (uso semanal del agente): agregación SQL pura (`COUNT`, `GROUP BY` por semana) — ni embeddings ni FTS aportan nada ahí.
- **Búsqueda de contenido pasado** (consulta ad-hoc de Cal): filtrar por SQL (entidad + rango de fecha + `LIKE` opcional) y pasarle el texto crudo de los candidatos al LLM en el momento de la consulta — el LLM hace de "buscador semántico" sobre texto ya acotado. Si el volumen creciera a decenas de miles de posts, ahí sí valdría reconsiderar FTS5 (SQLite/D1 lo soportan nativo) antes de saltar a vectores — no es el caso hoy.

---

## Flujo semanal ajustado

Por handle, dentro de `fetchSocialText`:

1. Scrape (igual que hoy).
2. Filtro de ventana de timeframe (igual que hoy).
3. **Nuevo:** query a D1 por las URLs de los posts scrapeados — separa en "ya vistos" (traer su versión enriquecida desde D1) y "nuevos" (necesitan `enrichPosts`).
4. `enrichPosts` corre solo sobre los nuevos — mismo tope `MAX_POSTS_PER_ACCOUNT`/`MAX_VIDEOS_PER_ACCOUNT` de hoy, aplicado sobre el total en ventana (no cambia el comportamiento semanal base).
5. **Nuevo:** insertar los nuevos (ya enriquecidos) a D1 (`INSERT OR IGNORE` por `url`, con `run_id`/`first_seen_at`).
6. El texto del prompt se arma igual que hoy (`formatSocialText`), combinando nuevos + reusados.
7. **Nuevo:** una query de agregación aparte (conteo de posts / promedio semanal / fecha de pico, por entidad, sobre D1) se suma como bloque de contexto al prompt del agente LLM — resumen agregado, no posts crudos históricos completos.

### Resiliencia

D1 es una capa adicional, nunca bloqueante — mismo criterio fail-soft que el resto del research (cada fuente aislada en su propio try/catch, nunca aborta la entidad ni la corrida):
- Si D1 no responde al leer → se trata como "nada visto todavía" (se enriquece igual que hoy, más caro esa semana, no se pierde nada).
- Si falla al escribir → se loguea y se sigue; se pierde esa semana del histórico, no la corrida ni el informe.
- Si falla la agregación → el agente simplemente no recibe ese bloque extra del prompt.

---

## Backfill inicial

**Alcance acordado: 6 meses hacia atrás, en las 22 cuentas (Instagram 8 · Facebook 6 · TikTok 4 · X 4).**

### Asimetría por plataforma

- **Facebook/TikTok (Apify):** se puede pedir más historia de una corrida puntual subiendo `resultsLimit`/`maxItems` — sin tocar el límite semanal de 8 — sujeto a cuánto pueda paginar hacia atrás el actor y a la cadencia real de cada cuenta.
- **Instagram/X:** el flujo semanal regular sigue sin scroll (bajo riesgo de detección de bot, decisión ya vigente y documentada). **Para esta corrida única de backfill, se asume scroll** — el riesgo de detección se acepta una vez, no semana a semana; el flujo regular no cambia después. A diferencia de Facebook/TikTok (donde "traer más historia" es subir un parámetro que Apify ya soporta), acá scroll es **código nuevo** — `scrapeInstagram`/`scrapeX` no lo implementan hoy — así que la pasada de conteo en estas 2 plataformas depende de escribir esa función primero, no es gratis en trabajo aunque sea gratis en dinero.

### Estrategia: dos pasadas, no una

La cadencia real de publicación varía demasiado entre cuentas para estimar volumen "a ojo" — evidencia real: `altoke.bo` publicó 8 posts en Facebook en 5 días (~1.3/día) durante la prueba de dedupe, muy por encima de lo asumible a priori. En vez de comprometerse a un costo estimado sobre una suposición:

1. **Pasada de conteo (metadata cruda, sin enriquecer):** recolectar solo `url`/`fecha`/`caption` de los 6 meses en las 22 cuentas. Da el número REAL de posts por cuenta. Costo despreciable (ver tabla de pricing) — el enriquecimiento es lo caro, no el scraping.
2. **Con el conteo real en mano**, se calcula el costo exacto de enriquecer todo (o se poda deliberadamente — ej. solo los N más recientes por cuenta más activa) antes de gastarlo.

### Pricing verificado (2026-09-08)

| Servicio | Precio |
|---|---|
| Apify `facebook-posts-scraper` | $0.005/post (plan Free) a $0.0008/post (Diamond) — pay-per-event |
| Apify `tiktok-scraper` | $0.0003/post — flat |
| Instagram/X (Chrome real) | $0 de API — costo es tiempo/riesgo, no dinero |
| OpenRouter `qwen3-vl-235b-a22b-instruct` (visión) | $0.20/1M tokens input · $0.88/1M tokens output |
| ElevenLabs Scribe v2 (transcripción) | $0.00367/minuto de audio |

Costo unitario de enriquecer un post ya scrapeado: **~$0.0024** (post de imagen, hasta 4 imágenes) a **~$0.008-0.015** (post de video, transcripción + hasta 6 frames).

**Orden de magnitud, no cifra prometida:** incluso en un escenario generoso (~1.500 posts totales en 6 meses, asumiendo varias cuentas tan activas como `altoke.bo`/Facebook), el enriquecimiento completo cae en **~$15-30 total**, más unos pocos dólares de scraping. El dinero no es la restricción real de este backfill — el tiempo de ejecución (fuera de los timeouts pensados para una corrida semanal chica, ver abajo) y el riesgo de scroll en Instagram/X sí lo son.

### Ejecución

Corrida separada del cron semanal — usa `research-competencia-run-detached.sh` (ya existe, `nohup`+`disown`) porque el volumen de un backfill de 6 meses excede largamente los timeouts pensados para la corrida semanal (`SOCIAL_TIMEOUT_MS`/`PER_ENTITY_BUDGET_MS`, dimensionados para 8 posts/cuenta, no cientos). No se tocan esos timeouts para el flujo regular — el backfill corre con sus propios límites, más generosos, en un modo separado.

---

## Testing

Mismo patrón del resto del módulo: Vitest, dependencias inyectables (cliente D1 mockeable, igual que `scrapers`/`enrichFn`/`nowMs` ya lo son en `fetchSocialText`), aislamiento de fallas testeado explícitamente (D1 caído no aborta la entidad ni la corrida).
