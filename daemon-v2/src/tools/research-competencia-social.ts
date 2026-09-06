import type { BrowserContext } from "playwright";
import { describeImage, analyzeVideo, type VideoAnalysis } from "./research-competencia-media.js";
import type { EntityConfig } from "./research-competencia-entities.js";
import { scrapeInstagram, scrapeX } from "./research-competencia-scrapers.js";
import { scrapeFacebookApify, scrapeTikTokApify } from "./research-competencia-apify.js";

export type SocialPlatform = "instagram" | "tiktok" | "facebook" | "x";

export interface SocialPost {
  platform: SocialPlatform;
  handle: string;
  /** Permalink del post — se usa como `fuente` citable en hallazgos y battlecard. */
  url: string;
  /** ISO date (YYYY-MM-DD) si se pudo extraer; null si la plataforma no la expone legible. */
  fecha: string | null;
  caption: string;
  mediaUrls: string[];
  esVideo: boolean;
}

export interface EnrichedPost extends SocialPost {
  /** Descripciones de visión de las imágenes del post. */
  imagenes: string[];
  video?: VideoAnalysis;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Interpreta un `fecha` (YYYY-MM-DD) como medianoche en La Paz (UTC-4), no UTC.
 * `new Date("2026-09-08")` da medianoche UTC — con el daemon corriendo en Bolivia eso corre
 * cada fecha ~4h hacia atrás y puede dejar afuera un post que en realidad está dentro de la
 * ventana. Mismo bug documentado en el CLAUDE.md del repo (pisado 4 veces); mismo patrón de
 * offset fijo que `nowInLaPaz` en `journal-capture.ts`. Devuelve null si no matchea el formato
 * o no es una fecha válida — un valor no parseable (fecha relativa tipo "hace 2 días") se trata
 * igual que "sin fecha": se conserva en vez de descartarse.
 */
function parseFechaLaPaz(fecha: string): Date | null {
  if (!ISO_DATE_RE.test(fecha)) return null;
  const d = new Date(`${fecha}T00:00:00-04:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Deja solo los posts dentro de la ventana. Los posts SIN fecha (o con fecha no parseable) se
 * conservan a propósito: las 4 plataformas a veces muestran fechas relativas ilegibles ("2 d") o
 * directamente las ocultan, y descartarlos perdería contenido reciente. El agente ya sabe ignorar
 * lo viejo.
 */
export function filterPostsByTimeframe(posts: SocialPost[], timeframeDias: number, ahora = new Date()): SocialPost[] {
  const desde = new Date(ahora.getTime() - timeframeDias * 24 * 60 * 60 * 1000);
  return posts.filter((p) => {
    if (!p.fecha) return true;
    const d = parseFechaLaPaz(p.fecha);
    return d === null ? true : d >= desde;
  });
}

// Topes de tamaño de formatSocialText — con ~24 cuentas × 8 posts, transcripciones de hasta 5
// minutos y hasta 6 frames por video, el texto sin límite puede llegar a cientos de miles de
// caracteres y desbordar el prompt. Valores en línea con el resto del módulo
// (research-competencia-sources.ts usa slice(0,5000)/slice(0,3000), research-competencia-notion.ts
// usa slice(0,1900)): los campos individuales acotan el peor caso de UN post; MAX_TOTAL_CHARS es
// el techo real para la corrida completa.
const MAX_CAPTION_CHARS = 500;
const MAX_IMAGEN_DESC_CHARS = 400;
const MAX_TRANSCRIPCION_CHARS = 1500;
const MAX_FRAME_DESC_CHARS = 300;
const MAX_TOTAL_CHARS = 20_000;

/**
 * Colapsa saltos de línea a espacio y recorta a `max`. NO es cosmético: `caption`, las
 * descripciones de imagen y la transcripción son contenido scrapeado de terceros insertado tal
 * cual en el bloque de texto. Sin esto, un caption con un `\n\n` seguido de algo como
 * `[tiktok @competidor] https://url-falsa.example\nCaption: "..."` fabrica un post falso
 * indistinguible de uno real para el LLM — rompiendo la garantía de que cada URL citada es
 * verificable. Si el campo no puede contener un salto de línea, no puede fabricar un header nuevo.
 */
function sanitizeField(s: string, max: number): string {
  const oneLine = s.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export const MAX_POSTS_PER_ACCOUNT = 8;
export const MAX_VIDEOS_PER_ACCOUNT = 4;
// Tope de imágenes por post — un carrusel de Instagram admite hasta 10-20 slides, y sin este
// tope UN post dispara 10-20 llamadas de visión. Las primeras 4 ya cubren lo que aporta valor
// competitivo real (flyer/oferta principal + 1-2 variantes); el resto de un carrusel largo suele
// ser relleno (mismo producto desde otro ángulo, detalles menores) con retorno marginal decreciente
// para el análisis. Con MAX_POSTS_PER_ACCOUNT=8 el peor caso por cuenta queda en 32 llamadas de
// visión (8 posts × 4 imágenes) en vez de hasta 160 (8 × 20) sin este tope.
export const MAX_IMAGES_PER_POST = 4;

export interface EnrichDeps {
  describeImageFn?: (url: string) => Promise<string | null>;
  analyzeVideoFn?: (url: string) => Promise<VideoAnalysis | null>;
}

/**
 * Chequeo best-effort de que `posts` viene más-reciente-primero — el contrato del que depende el
 * `slice(0, MAX_POSTS_PER_ACCOUNT)` de `enrichPosts` (ver su comentario). Un scraper futuro que
 * cambie el orden haría que ese slice se quede con los 8 posts equivocados EN SILENCIO, en un cron
 * desatendido — esto no lo arregla (no reordena, no descarta), solo deja la señal. Compara pares
 * consecutivos con fecha parseable únicamente: los posts sin fecha o con fecha no parseable no
 * participan del contrato de orden (mismo criterio que `filterPostsByTimeframe`), así que se
 * ignoran en vez de disparar falsos positivos. Un solo pase O(n), corta en la primera violación —
 * una señal alcanza para saber que hay que mirar el scraper, no hace falta contar cuántas hay.
 */
function warnIfOrderViolated(posts: SocialPost[]): void {
  let prev: Date | null = null;
  for (const p of posts) {
    if (!p.fecha) continue;
    const d = parseFechaLaPaz(p.fecha);
    if (d === null) continue;
    if (prev !== null && d.getTime() > prev.getTime()) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_enrich_order_violation", url: p.url, fecha: p.fecha }));
      return;
    }
    prev = d;
  }
}

/**
 * Descarga y analiza la media de los posts, respetando los topes por cuenta del spec.
 * Los videos que exceden MAX_VIDEOS_PER_ACCOUNT se conservan como post (caption incluido)
 * pero sin análisis de video — el caption sigue teniendo valor. Ídem las imágenes que exceden
 * MAX_IMAGES_PER_POST dentro de un mismo carrusel.
 *
 * El tope de posts (`slice`) NO reordena — toma los primeros N tal cual llegan. El spec pide
 * quedarse con "los más recientes de la ventana", pero acá no hay forma confiable de ordenar:
 * `filterPostsByTimeframe` conserva a propósito los posts sin fecha parseable (ver ese comentario),
 * así que un sort por `fecha` dejaría indeterminado dónde caen esos posts sin castigar el caso común.
 * Responsabilidad del caller (el scraper, `research-competencia-scrapers.ts`): entregar los posts
 * ya en orden más-reciente-primero, que es el orden natural en que las 4 plataformas listan un feed.
 * `warnIfOrderViolated` es la red de seguridad barata contra que ese contrato se rompa sin avisar.
 *
 * ponytail: el pipeline es 100% secuencial (un `await` atrás del otro, sin `Promise.all` ni
 * concurrencia) para posts, imágenes y videos. El scraping previo tiene su propia razón para ser
 * secuencial (huella de automatización); acá las llamadas van a APIs propias de Cal (OpenRouter/
 * ElevenLabs vía research-competencia-media.ts), donde ese argumento no aplica — es una decisión de
 * simplicidad, no de necesidad, tomada porque el tope de MAX_IMAGES_PER_POST de arriba ya acota
 * bastante el volumen y sumar paralelismo ahora es riesgo sin necesidad probada. Techo conocido:
 * con MAX_VIDEOS_PER_ACCOUNT=4 (cada uno hasta ~120s de descarga + hasta 120s de ffmpeg audio +
 * hasta 120s de ffmpeg frames + una llamada de visión por frame, ver los timeouts en
 * research-competencia-media.ts) más hasta 4 posts de imagen restantes (MAX_IMAGES_PER_POST=4
 * c/u), el peor caso de UNA cuenta puede llegar a decenas de minutos. Upgrade si esto llega a
 * doler: paralelizar imágenes/frames DENTRO de un post con `Promise.all` (los posts entre sí
 * pueden seguir secuenciales — más simple) o un límite de concurrencia (`p-limit`) sobre las
 * llamadas de video, que son las más caras.
 */
export async function enrichPosts(posts: SocialPost[], deps: EnrichDeps = {}): Promise<EnrichedPost[]> {
  const describeImageFn = deps.describeImageFn ?? describeImage;
  const analyzeVideoFn = deps.analyzeVideoFn ?? analyzeVideo;

  warnIfOrderViolated(posts);

  const acotados = posts.slice(0, MAX_POSTS_PER_ACCOUNT);
  const enriched: EnrichedPost[] = [];
  let videosAnalizados = 0;

  for (const p of acotados) {
    const item: EnrichedPost = { ...p, imagenes: [] };
    try {
      if (p.esVideo) {
        if (videosAnalizados < MAX_VIDEOS_PER_ACCOUNT && p.mediaUrls[0]) {
          // Incrementa ANTES de llamar a analyzeVideoFn — cuenta el INTENTO, no el éxito. Si
          // contara solo tras un `await` resuelto sin tirar, un analyzeVideoFn que TIRA (posible
          // vía la dep inyectable, aunque el analyzeVideo real de research-competencia-media.ts
          // nunca tira) saltaría directo al catch sin incrementar, y ese intento saldría gratis
          // contra el tope — el tope dejaría de depender de MAX_VIDEOS_PER_ACCOUNT y pasaría a
          // depender de un detalle de implementación ajeno a este archivo.
          videosAnalizados++;
          try {
            const analisis = await analyzeVideoFn(p.mediaUrls[0]);
            if (analisis) item.video = analisis;
          } catch (err) {
            console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_enrich_video_error", url: p.mediaUrls[0], err: String(err) }));
          }
        }
      } else {
        // Try/catch POR URL — sin esto, una imagen rota en medio de un carrusel de 10 aborta el
        // `for` ahí mismo: las imágenes siguientes NUNCA se intentan, y el resultado es
        // indistinguible de "esas imágenes no tenían nada que decir" (silencioso, sin log).
        for (const url of p.mediaUrls.slice(0, MAX_IMAGES_PER_POST)) {
          try {
            const desc = await describeImageFn(url);
            if (desc) item.imagenes.push(desc);
          } catch (err) {
            console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_enrich_image_error", url, err: String(err) }));
          }
        }
      }
    } catch (err) {
      // Red de seguridad general — con los try/catch puntuales de arriba (por imagen, por video)
      // este nivel no debería dispararse en la práctica, pero esto corre en un cron desatendido:
      // mejor un log de más que un post entero perdido en silencio por un error inesperado.
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_enrich_post_error", url: p.url, err: String(err) }));
    }
    enriched.push(item);
  }
  return enriched;
}

/** Consolida los posts enriquecidos a un bloque de texto para el prompt del agente. */
export function formatSocialText(posts: EnrichedPost[]): string {
  if (posts.length === 0) return "";
  const bloques = posts.map((p) => {
    const lineas = [`[${p.platform} @${p.handle}${p.fecha ? ` · ${p.fecha}` : ""}] ${p.url}`];
    if (p.caption) lineas.push(`Caption: ${sanitizeField(p.caption, MAX_CAPTION_CHARS)}`);
    for (const img of p.imagenes) {
      const clean = sanitizeField(img, MAX_IMAGEN_DESC_CHARS);
      if (clean) lineas.push(`Imagen: ${clean}`);
    }
    if (p.video?.transcripcion) {
      lineas.push(`Transcripción del video: ${sanitizeField(p.video.transcripcion, MAX_TRANSCRIPCION_CHARS)}`);
    }
    for (const f of p.video?.frames ?? []) {
      const clean = sanitizeField(f, MAX_FRAME_DESC_CHARS);
      if (clean) lineas.push(`Frame del video: ${clean}`);
    }
    return lineas.join("\n");
  });
  const texto = bloques.join("\n\n");
  return texto.length > MAX_TOTAL_CHARS
    ? `${texto.slice(0, MAX_TOTAL_CHARS)}\n\n[...truncado — se alcanzó el límite de ${MAX_TOTAL_CHARS} caracteres]`
    : texto;
}

export type ScraperFn = (handle: string, context: BrowserContext) => Promise<SocialPost[]>;

export interface FetchSocialDeps {
  scrapers?: Record<SocialPlatform, ScraperFn>;
  /** Sesión de Chrome REAL ya abierta (research-competencia-browser.ts), compartida por las 6
   * entidades de la corrida — el orquestador la abre una vez y la pasa acá. Requerido: sin browser
   * no hay forma de scrapear, y el orquestador ya decide ANTES de llamar a esta función si hay uno
   * disponible (si `openResearchBrowserSession` falló, ni siquiera llama a `fetchSocialText`). */
  context: BrowserContext;
  enrichFn?: (posts: SocialPost[]) => Promise<EnrichedPost[]>;
  ahora?: Date;
  /** Reloj inyectable para el presupuesto de tiempo por entidad — permite tests deterministas
   * (contador manual) sin depender de fake timers ni de esperas reales. Default `Date.now`. */
  nowMs?: () => number;
  /** Override del presupuesto de tiempo por entidad, en ms. Default `PER_ENTITY_BUDGET_MS`. */
  presupuestoMs?: number;
}

// facebook/tiktok vía Apify (research-competencia-apify.ts) desde 2026-09-05 — reemplazan a
// scrapeFacebook/scrapeTikTok (Playwright/Chrome real), bloqueados por scraping directo. Mismo
// tipo `ScraperFn` que instagram/x: reciben `context` pero no lo usan (Apify no necesita browser).
const DEFAULT_SCRAPERS: Record<SocialPlatform, ScraperFn> = {
  instagram: scrapeInstagram,
  tiktok: scrapeTikTokApify,
  facebook: scrapeFacebookApify,
  x: scrapeX,
};

// Presupuesto de tiempo por ENTIDAD, DIVIDIDO EN PARTES IGUALES entre las plataformas que declaran
// al menos un handle — no es un pozo común que la primera plataforma lenta puede vaciar entera.
// Diseño anterior (hasta el 2026-09-06): un solo cronómetro por entidad, compartido por las 4
// plataformas en el orden fijo instagram→tiktok→facebook→x — en una corrida real, Instagram+TikTok
// de una sola entidad (2 cuentas de Instagram con muchas imágenes + 1 cuenta de TikTok con videos
// reales vía Apify) alcanzaron a consumir el presupuesto ENTERO antes de llegar a Facebook, dejando
// esa plataforma —justo la que más costó arreglar (research-competencia-apify.ts)— sin ningún dato
// en 2 de 6 entidades reales. Repartir el presupuesto por plataforma (cada una con su propio
// cronómetro, reiniciado al empezar) garantiza que NINGUNA plataforma con handles configurados
// quede en cero solo por el orden en que le tocó correr — el costo es que una plataforma que
// terminaría rápido no le "presta" su tiempo sobrante a la siguiente, así que el techo real de la
// entidad sigue siendo ~`PER_ENTITY_BUDGET_MS` (nunca más), pero el piso por plataforma es
// `PER_ENTITY_BUDGET_MS / cantidadDePlataformasConHandles` en vez de "lo que sobre".
//
// Es un corte ENTRE handles, no una cancelación real de un await en curso (eso exigiría enhebrar
// AbortController hasta los scrapers de Playwright y hasta research-competencia-media.ts — fuera de
// alcance acá): si UN handle se cuelga sin tirar nunca, este chequeo no lo interrumpe; sí evita
// arrancar handles NUEVOS de esa misma plataforma una vez pasada su porción.
//
// IMPORTANTE 3 (revisión de salud, 2026-09-03, sigue aplicando): este valor tiene que ser MENOR que
// `SOCIAL_TIMEOUT_MS` (research-competencia.ts) con margen real — los dos NO son independientes,
// ver el comentario de `SOCIAL_TIMEOUT_MS` para la relación completa. 15 min (subido de 7 el
// 2026-09-05 cuando Facebook/TikTok empezaron a traer contenido real vía Apify, ver el historial en
// git) contra 20 en `SOCIAL_TIMEOUT_MS` deja margen para que el loop interno termine prolijo antes
// del hachazo externo.
const PER_ENTITY_BUDGET_MS = 15 * 60 * 1000;

/**
 * Reparte los posts recolectados en round-robin por plataforma (instagram/tiktok/facebook/x),
 * preservando el orden relativo dentro de cada plataforma. `formatSocialText` trunca por el FINAL
 * del texto (`MAX_TOTAL_CHARS`) — sin intercalar, el orden fijo de iteración de `fetchSocialText`
 * hace que la ÚLTIMA plataforma recorrida (x) sea siempre la primera en perderse con volumen real
 * (varios handles de Instagram con carruseles/videos), sin que eso refleje relevancia ni recencia:
 * es puro artefacto del orden del loop. Repartir en round-robin distribuye el riesgo de corte entre
 * las 4 en vez de castigar siempre a la misma.
 */
export function interleaveByPlatform<T extends { platform: SocialPlatform }>(posts: T[]): T[] {
  const grupos = new Map<SocialPlatform, T[]>();
  for (const p of posts) {
    const arr = grupos.get(p.platform);
    if (arr) arr.push(p);
    else grupos.set(p.platform, [p]);
  }
  const colas = [...grupos.values()];
  const resultado: T[] = [];
  let i = 0;
  while (resultado.length < posts.length) {
    const cola = colas[i % colas.length];
    if (cola.length > 0) resultado.push(cola.shift() as T);
    i++;
  }
  return resultado;
}

/**
 * Recorre todas las plataformas y handles declarados de una entidad, aplica el filtro de
 * timeframe, enriquece la media y devuelve un bloque de texto listo para el prompt. Devuelve null
 * si la entidad no declara cuentas o si nada trajo contenido.
 *
 * Aislamiento por cuenta: try/catch SEPARADO por ETAPA (scraper, filtro de ventana, enriquecimiento)
 * y por handle — una plataforma bloqueada (ej. TikTok con captcha) o un handle caído no cortan a los
 * demás. Las 3 etapas tienen mensajes de log distintos (`_scrape_error`/`_filter_error`/
 * `_enrich_error`) a propósito: si el scraper anda pero falla el enriquecimiento (visión/
 * transcripción vía OpenRouter/ElevenLabs, ver research-competencia-media.ts), un log genérico
 * sería indistinguible de una cuenta bloqueada — en un cron desatendido eso obliga a leer código
 * para diagnosticar. Todos identifican plataforma+handle.
 *
 * Presupuesto de tiempo (`PER_ENTITY_BUDGET_MS`, ver comentario ahí) dividido EN PARTES IGUALES
 * entre las plataformas con handles configurados — al excederse la porción de UNA plataforma, pasa
 * a la siguiente con su propio cronómetro fresco, en vez de abortar el resto de la entidad.
 *
 * Los topes de enrichPosts (MAX_POSTS_PER_ACCOUNT/MAX_VIDEOS_PER_ACCOUNT) son POR CUENTA, y acá
 * enrichFn se llama una vez por HANDLE (no una vez por entidad con todos los posts juntos) — es la
 * semántica correcta del spec ("8 posts por cuenta, 4 videos por cuenta"), pero implica que el
 * volumen total por ENTIDAD escala con la cantidad de handles: bancosol-altoke declara 6 handles
 * (2 Instagram + 1 TikTok + 2 Facebook + 1 X), así que en el peor caso puede acumular 6×8=48 posts
 * enriquecidos para una sola entidad, no 8. Es la decisión correcta igual: cada cuenta es una
 * fuente independiente (ej. la cuenta corporativa vs. la de producto), y compartir un tope entre
 * cuentas escondería contenido real de la secundaria detrás del volumen de la principal.
 */
export async function fetchSocialText(
  entity: EntityConfig,
  timeframeDias: number,
  deps: FetchSocialDeps,
): Promise<string | null> {
  if (!entity.social) return null;
  const social = entity.social;
  const scrapers = deps.scrapers ?? DEFAULT_SCRAPERS;
  const enrichFn = deps.enrichFn ?? ((posts: SocialPost[]) => enrichPosts(posts));
  const nowFn = deps.nowMs ?? Date.now;
  const presupuestoMs = deps.presupuestoMs ?? PER_ENTITY_BUDGET_MS;

  const plataformasConHandles = (Object.keys(social) as SocialPlatform[]).filter((p) => social[p].length > 0);
  // División pareja del presupuesto — ver el comentario grande de `PER_ENTITY_BUDGET_MS` sobre por
  // qué NO es un pozo común: cada plataforma recibe su propia porción fija, ninguna puede vaciar el
  // presupuesto de las que vienen después. `|| presupuestoMs` cubre el caso imposible en la práctica
  // (0 plataformas con handles ya devolvió `null` más arriba) sin dividir por cero.
  const presupuestoPorPlataformaMs = plataformasConHandles.length > 0 ? presupuestoMs / plataformasConHandles.length : presupuestoMs;

  const todos: EnrichedPost[] = [];
  for (const platform of plataformasConHandles) {
    const handles = social[platform];
    const inicioPlataforma = nowFn();

    for (const handle of handles) {
      if (nowFn() - inicioPlataforma > presupuestoPorPlataformaMs) {
        console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_social_platform_budget_exceeded", entityId: entity.id, platform, handle, elapsedMs: nowFn() - inicioPlataforma }));
        break; // pasa a la PLATAFORMA siguiente (cronómetro propio) — no aborta el resto de la entidad
      }

      let posts: SocialPost[];
      try {
        posts = await scrapers[platform](handle, deps.context);
      } catch (err) {
        console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_social_scrape_error", platform, handle, err: String(err) }));
        continue;
      }

      let enVentana: SocialPost[];
      try {
        enVentana = filterPostsByTimeframe(posts, timeframeDias, deps.ahora);
      } catch (err) {
        console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_social_filter_error", platform, handle, err: String(err) }));
        continue;
      }

      try {
        todos.push(...(await enrichFn(enVentana)));
      } catch (err) {
        console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_social_enrich_error", platform, handle, err: String(err) }));
      }
    }
  }

  const texto = formatSocialText(interleaveByPlatform(todos));
  return texto || null;
}
