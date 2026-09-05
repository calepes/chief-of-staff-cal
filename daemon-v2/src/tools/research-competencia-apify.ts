import type { BrowserContext } from "playwright";
import type { SocialPost } from "./research-competencia-social.js";
import { isoDateFromUnix, handlesMatch, sortPostsByFechaDesc } from "./research-competencia-scrapers.js";

/**
 * Facebook y TikTok vía Apify (marketplace de actors de scraping pagos) — reemplaza
 * `scrapeFacebook`/`scrapeTikTok` de research-competencia-scrapers.ts, bloqueados por scraping
 * directo (Facebook ofusca el texto del feed a nivel DOM — ver research-competencia-meta-ads.ts;
 * TikTok ya no trae el `itemList` de videos en el JSON embebido inicial). Validado en vivo por Cal
 * el 2026-09-05, fuera de este repo, contra 6 páginas reales de Facebook (100% de éxito) y varias
 * cuentas de TikTok.
 *
 * A diferencia de todo lo demás en research-competencia-scrapers.ts, esto NO usa Playwright/Chrome
 * — son llamadas HTTP directas a la API de Apify (`fetch`, sin browser), más parecido en espíritu a
 * research-competencia-ads.ts (Google, fetch puro) que a los scrapers de Chrome real. Por eso vive
 * en un archivo aparte en vez de sumarse a research-competencia-scrapers.ts (que es 100%
 * Playwright) — separación por MECANISMO, no por plataforma.
 *
 * `scrapeFacebookApify`/`scrapeTikTokApify` igual matchean el tipo `ScraperFn`
 * (`(handle, context) => Promise<SocialPost[]>`, research-competencia-social.ts) para poder
 * enchufarse en `DEFAULT_SCRAPERS` sin tocar el dispatcher — el segundo parámetro (`BrowserContext`,
 * la sesión de Chrome compartida por las 6 entidades) queda sin usar a propósito: Apify no
 * necesita browser local, corre en la infraestructura de Apify.
 */

// Debe ser <= MAX_POSTS_PER_ACCOUNT (research-competencia-social.ts, hoy 8) — pedirle a Apify más
// posts de los que `enrichPosts` va a usar sería pagar/tardar de más por datos que el pipeline
// descarta igual en el `slice` downstream. Literal duplicado (no importado) para no crear un
// import circular entre este archivo y research-competencia-social.ts (que importa los scrapers
// de acá) — mismo criterio que otras constantes relacionadas entre archivos de este módulo
// (ej. SOCIAL_TIMEOUT_MS/PER_ENTITY_BUDGET_MS), documentadas por comentario en vez de compartidas
// por import.
const APIFY_RESULTS_LIMIT = 8;

// 60-90s: Apify a veces tarda si el actor hace varios reintentos internos (ver el log real de
// TikTok, `[PROFILE_VIDEO_CONTINUATION] ... retrying...`). Es el timeout que el propio Apify usa
// para cortar la ejecución del actor (`run-sync-get-dataset-items?timeout=`), no un timeout de
// nuestro `fetch` — coherente con el resto del research, que tampoco pone timeout manual a sus
// llamadas de red (research-competencia-ads.ts) y confía en los deadlines externos por entidad
// (SOCIAL_TIMEOUT_MS/PER_ENTITY_BUDGET_MS en research-competencia.ts/-social.ts) como red de
// seguridad final.
const ACTOR_TIMEOUT_SEC = 90;

const FACEBOOK_ACTOR_ID = "apify~facebook-posts-scraper";
const TIKTOK_ACTOR_ID = "apidojo~tiktok-scraper";

// El actor de TikTok resuelve su proxy por default a la región "US" (campo `location` de su input
// schema) — para cuentas geo-indexadas hacia Bolivia (altoke.bo, yapebolivia), servir el listado
// de videos desde un proxy de EE.UU. devuelve sistemáticamente 0 resultados aunque el perfil cargue
// bien. Verificado en vivo el 2026-09-05: agregando `location: "BO"` ambas cuentas devuelven
// contenido real completo. NO es opcional — sin esto, el actor parece "andar" (no tira error) pero
// nunca trae posts de una cuenta boliviana real.
const TIKTOK_LOCATION = "BO";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/**
 * Llama al endpoint no interactivo de Apify (`run-sync-get-dataset-items`) que corre el actor y
 * devuelve directo el dataset resultante, sin polling manual. Fail-soft, mismo criterio que
 * `fetchAdvertiserReal` (research-competencia-ads.ts): nunca tira, siempre `null` ante cualquier
 * problema — este bloque es complementario, y una falla suya no puede tumbar el research de la
 * entidad. El token NUNCA se loguea (va en la URL pero no se imprime ni siquiera en el log de
 * error — el `err`/`status` no incluyen la URL completa).
 */
async function fetchApifyDatasetItems(
  actorId: string,
  input: unknown,
  platform: string,
  handle: string,
): Promise<unknown[] | null> {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_apify_missing_token", platform, handle }));
    return null;
  }
  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=${ACTOR_TIMEOUT_SEC}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_apify_fetch_error", platform, handle, err: String(err) }));
    return null;
  }
  if (!res.ok) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_apify_http", platform, handle, status: res.status }));
    return null;
  }
  try {
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_apify_parse_failed", platform, handle, err: String(err) }));
    return null;
  }
}

/** `time` de Facebook ya viene ISO CON hora ("2026-09-05T14:00:05.000Z") — a diferencia de
 * `uploadedAt` de TikTok (epoch en segundos), hace falta convertir a epoch primero antes de
 * reusar `isoDateFromUnix` (mismo offset fijo -4h La Paz que el resto del archivo). */
function parseFacebookApifyDate(time: unknown): string | null {
  if (typeof time !== "string") return null;
  const ms = new Date(time).getTime();
  return Number.isNaN(ms) ? null : isoDateFromUnix(ms / 1000);
}

/** `media[0].photo_image.uri` si existe (la foto en resolución completa), si no
 * `media[0].thumbnail`, si no hay `media` no hay imagen — nunca inventa un campo de video: la
 * forma real capturada en vivo no expone ninguno para un post de imagen. */
function extractFacebookImageUrl(media: unknown): string | null {
  if (!Array.isArray(media) || media.length === 0) return null;
  const primero = asRecord(media[0]);
  if (!primero) return null;
  const photoImage = asRecord(primero.photo_image);
  if (typeof photoImage?.uri === "string") return photoImage.uri;
  if (typeof primero.thumbnail === "string") return primero.thumbnail;
  return null;
}

/**
 * Parsea los items crudos de `apify~facebook-posts-scraper` a `SocialPost`. Función pura — sin
 * red — mismo criterio que los parsers de research-competencia-scrapers.ts.
 *
 * Verificación de autoría OBLIGATORIA vía `pageName` — mismo criterio fail-closed que
 * `handlesMatch` aplica al resto del archivo (retweets/posts compartidos de otra cuenta con
 * exactamente la misma forma). Descarta también items sin `url` (no hay fuente citable).
 *
 * `esVideo` siempre `false`: la forma real de un post capturada en vivo no expone ningún campo de
 * video (son posts de imagen) — si algún día aparece un post de video real en la respuesta, hay
 * que sumar el campo acá, no asumirlo de antemano.
 */
export function parseFacebookApifyItems(raw: unknown[], handle: string): SocialPost[] {
  const posts: SocialPost[] = [];
  for (const crudo of raw) {
    const it = asRecord(crudo);
    if (!it) continue;
    if (!handlesMatch(it.pageName, handle)) continue;
    if (typeof it.url !== "string" || !it.url) continue;
    const mediaUrl = extractFacebookImageUrl(it.media);
    posts.push({
      platform: "facebook",
      handle,
      url: it.url,
      fecha: parseFacebookApifyDate(it.time),
      caption: typeof it.text === "string" ? it.text : "",
      mediaUrls: mediaUrl ? [mediaUrl] : [],
      esVideo: false,
    });
  }
  return sortPostsByFechaDesc(posts);
}

/**
 * Scrapea Facebook de `handle` vía Apify. `resultsLimit` alineado a `APIFY_RESULTS_LIMIT` (ver su
 * comentario). Fail-soft: nunca tira, `[]` ante cualquier problema (token faltante, HTTP, parseo).
 */
export async function scrapeFacebookApify(handle: string, _context: BrowserContext): Promise<SocialPost[]> {
  const raw = await fetchApifyDatasetItems(
    FACEBOOK_ACTOR_ID,
    { startUrls: [{ url: `https://www.facebook.com/${handle}` }], resultsLimit: APIFY_RESULTS_LIMIT },
    "facebook",
    handle,
  );
  if (raw === null) return [];
  const items = parseFacebookApifyItems(raw, handle);
  if (items.length === 0) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_scrape_empty", platform: "facebook", handle, itemsCrudos: raw.length }));
  }
  return items;
}

/**
 * Parsea los items crudos de `apidojo~tiktok-scraper` a `SocialPost`. Función pura — sin red.
 *
 * `{ noResults: true }` (sin videos indexables para la cuenta) se descarta explícitamente como
 * "0 items", NO como un item malformado — no tiene `channel`/`id`, así que de todos modos no
 * pasaría la validación de autoría, pero el chequeo explícito documenta la intención.
 *
 * Verificación de autoría OBLIGATORIA vía `channel.username` — encontrado en vivo el 2026-09-05:
 * la cuenta `takenos_app_bo` devolvió contenido de OTRAS 2 cuentas no relacionadas
 * (`luisfer.sarabia`, `rodrigolo_`). Mismo criterio fail-closed que el resto del archivo.
 *
 * `esVideo` siempre `true` — TikTok no tiene posts que no sean video. `video.url` SÍ es un video
 * real descargable (a diferencia de `mediaUrls` de Instagram, que es solo la miniatura).
 */
export function parseTikTokApifyItems(raw: unknown[], handle: string): SocialPost[] {
  const posts: SocialPost[] = [];
  for (const crudo of raw) {
    const it = asRecord(crudo);
    if (!it || it.noResults === true) continue;
    const channel = asRecord(it.channel);
    if (!handlesMatch(channel?.username, handle)) continue;
    if (typeof it.id !== "string" || !it.id) continue;
    const video = asRecord(it.video);
    const videoUrl = typeof video?.url === "string" ? video.url : null;
    posts.push({
      platform: "tiktok",
      handle,
      url: `https://www.tiktok.com/@${handle}/video/${it.id}`,
      fecha: isoDateFromUnix(it.uploadedAt),
      caption: typeof it.title === "string" ? it.title : "",
      mediaUrls: videoUrl ? [videoUrl] : [],
      esVideo: true,
    });
  }
  return sortPostsByFechaDesc(posts);
}

/**
 * Scrapea TikTok de `handle` vía Apify. `maxItems` alineado a `APIFY_RESULTS_LIMIT` (ver su
 * comentario) y `location: "BO"` SIEMPRE presente (ver `TIKTOK_LOCATION` — sin esto, cuentas
 * bolivianas grandes devuelven 0 videos por el proxy default en EE.UU., no por bloqueo real).
 * Fail-soft: nunca tira, `[]` ante cualquier problema.
 */
export async function scrapeTikTokApify(handle: string, _context: BrowserContext): Promise<SocialPost[]> {
  const raw = await fetchApifyDatasetItems(
    TIKTOK_ACTOR_ID,
    { startUrls: [`https://www.tiktok.com/@${handle}`], maxItems: APIFY_RESULTS_LIMIT, location: TIKTOK_LOCATION },
    "tiktok",
    handle,
  );
  if (raw === null) return [];
  const items = parseTikTokApifyItems(raw, handle);
  if (items.length === 0) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_scrape_empty", platform: "tiktok", handle, itemsCrudos: raw.length }));
  }
  return items;
}
