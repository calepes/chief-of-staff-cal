import { describeImage, analyzeVideo, type VideoAnalysis } from "./research-competencia-media.js";

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

export interface EnrichDeps {
  describeImageFn?: (url: string) => Promise<string | null>;
  analyzeVideoFn?: (url: string) => Promise<VideoAnalysis | null>;
}

/**
 * Descarga y analiza la media de los posts, respetando los topes por cuenta del spec.
 * Los videos que exceden MAX_VIDEOS_PER_ACCOUNT se conservan como post (caption incluido)
 * pero sin análisis de video — el caption sigue teniendo valor.
 *
 * El tope de posts (`slice`) NO reordena — toma los primeros N tal cual llegan. El spec pide
 * quedarse con "los más recientes de la ventana", pero acá no hay forma confiable de ordenar:
 * `filterPostsByTimeframe` conserva a propósito los posts sin fecha parseable (ver ese comentario),
 * así que un sort por `fecha` dejaría indeterminado dónde caen esos posts sin castigar el caso común.
 * Responsabilidad del caller (el scraper, `research-competencia-scrapers.ts`): entregar los posts
 * ya en orden más-reciente-primero, que es el orden natural en que las 4 plataformas listan un feed.
 */
export async function enrichPosts(posts: SocialPost[], deps: EnrichDeps = {}): Promise<EnrichedPost[]> {
  const describeImageFn = deps.describeImageFn ?? describeImage;
  const analyzeVideoFn = deps.analyzeVideoFn ?? analyzeVideo;

  const acotados = posts.slice(0, MAX_POSTS_PER_ACCOUNT);
  const enriched: EnrichedPost[] = [];
  let videosAnalizados = 0;

  for (const p of acotados) {
    const item: EnrichedPost = { ...p, imagenes: [] };
    try {
      if (p.esVideo) {
        if (videosAnalizados < MAX_VIDEOS_PER_ACCOUNT && p.mediaUrls[0]) {
          const analisis = await analyzeVideoFn(p.mediaUrls[0]);
          if (analisis) item.video = analisis;
          videosAnalizados++;
        }
      } else {
        for (const url of p.mediaUrls) {
          const desc = await describeImageFn(url);
          if (desc) item.imagenes.push(desc);
        }
      }
    } catch (err) {
      // Un post cuyo análisis falla se conserva igual (caption + URL siguen sirviendo) — pero
      // esto corre en un cron desatendido, así que la falla queda logueada (mismo criterio que
      // describeImage/analyzeVideo en research-competencia-media.ts).
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
