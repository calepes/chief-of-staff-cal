import type { VideoAnalysis } from "./research-competencia-media.js";

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

/**
 * Deja solo los posts dentro de la ventana. Los posts SIN fecha se conservan a propósito:
 * las 4 plataformas a veces muestran fechas relativas ilegibles ("2 d") o directamente las
 * ocultan, y descartarlos perdería contenido reciente. El agente ya sabe ignorar lo viejo.
 */
export function filterPostsByTimeframe(posts: SocialPost[], timeframeDias: number, ahora = new Date()): SocialPost[] {
  const desde = new Date(ahora.getTime() - timeframeDias * 24 * 60 * 60 * 1000);
  return posts.filter((p) => {
    if (!p.fecha) return true;
    const d = new Date(p.fecha);
    return Number.isNaN(d.getTime()) ? true : d >= desde;
  });
}

/** Consolida los posts enriquecidos a un bloque de texto para el prompt del agente. */
export function formatSocialText(posts: EnrichedPost[]): string {
  if (posts.length === 0) return "";
  const bloques = posts.map((p) => {
    const lineas = [`[${p.platform} @${p.handle}${p.fecha ? ` · ${p.fecha}` : ""}] ${p.url}`];
    if (p.caption) lineas.push(`Caption: ${p.caption}`);
    for (const img of p.imagenes) lineas.push(`Imagen: ${img}`);
    if (p.video?.transcripcion) lineas.push(`Transcripción del video: ${p.video.transcripcion}`);
    for (const f of p.video?.frames ?? []) lineas.push(`Frame del video: ${f}`);
    return lineas.join("\n");
  });
  return bloques.join("\n\n");
}
