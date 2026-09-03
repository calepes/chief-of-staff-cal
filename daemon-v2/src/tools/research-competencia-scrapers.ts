// tools/research-competencia-scrapers.ts — scrapers headless por plataforma para el research de
// competencia (fase 2, redes sociales). Separado de research-competencia-social.ts a propósito:
// ese archivo se queda con tipos/filtro/formateo/orquestación; acá vive el detalle de Playwright
// por red social (Instagram en esta tarea; TikTok/Facebook se suman en tareas posteriores).
//
// Mismo patrón que design-capture.ts: chromium.launch({headless:true}), cookies inyectadas al
// contexto, try/finally con browser.close(). El LLM no tiene tool de navegación genérica — esto
// es una tool de alto nivel, el detalle de Playwright queda puertas adentro.

import { chromium } from "playwright";
import type { StructuredCookie } from "./cookie-jar.js";
import type { SocialPost } from "./research-competencia-social.js";

/**
 * Convierte un timestamp Unix (segundos) a fecha calendario `YYYY-MM-DD` en La Paz (UTC-4), no
 * UTC — mismo criterio que `parseFechaLaPaz` en research-competencia-social.ts: el daemon corre
 * en Bolivia y un post publicado de noche ahí puede caer en el día siguiente en UTC. Devuelve
 * null si `ts` no es un número usable (Instagram a veces omite el campo).
 */
export function isoDateFromUnix(ts: unknown): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  const d = new Date(ts * 1000 - 4 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Parsea los nodos crudos del timeline de Instagram (extraídos del JSON embebido en un <script>
 * de la página de perfil) a `SocialPost`. Función pura — sin red — para que sea testeable sin
 * levantar un browser.
 */
export function parseInstagramPosts(nodos: unknown[], handle: string): SocialPost[] {
  const posts: SocialPost[] = [];
  for (const raw of nodos) {
    const n = raw as {
      shortcode?: string;
      taken_at_timestamp?: number;
      is_video?: boolean;
      display_url?: string;
      video_url?: string;
      edge_media_to_caption?: { edges?: Array<{ node?: { text?: string } }> };
    };
    if (!n.shortcode) continue;
    const esVideo = n.is_video === true;
    const media = esVideo ? n.video_url : n.display_url;
    posts.push({
      platform: "instagram",
      handle,
      url: `https://www.instagram.com/p/${n.shortcode}/`,
      fecha: isoDateFromUnix(n.taken_at_timestamp),
      caption: n.edge_media_to_caption?.edges?.[0]?.node?.text ?? "",
      mediaUrls: media ? [media] : [],
      esVideo,
    });
  }
  return posts;
}

// Ambiente mínimo SOLO para el body de page.evaluate() (corre en el navegador, no en Node) —
// mismo motivo que design-capture.ts: a propósito no se agrega "DOM" al lib del tsconfig, que
// aplicaría a todo el paquete y podría chocar con los tipos de fetch/Response/Headers de Node.
declare const document: {
  querySelectorAll(selector: "script"): ArrayLike<{ textContent: string | null }>;
};

/**
 * Scrapea el perfil público de Instagram de `handle` y devuelve sus posts recientes. Una sola
 * visita, sin scroll — minimiza la huella de automatización sobre la cuenta que presta las
 * cookies. Cualquier falla (perfil privado, layout cambiado, timeout de red) devuelve `[]` en vez
 * de propagar: esto corre en un cron desatendido, un solo scraper roto no debe tumbar el research
 * completo de las demás cuentas/plataformas.
 */
export async function scrapeInstagram(handle: string, cookies: StructuredCookie[]): Promise<SocialPost[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    if (cookies.length > 0) await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: "networkidle", timeout: 30_000 });

    const nodos = await page.evaluate(() => {
      // Instagram deja el timeline en un <script> con JSON. Se recorre el objeto buscando la
      // colección de posts sin depender de la ruta exacta, que cambia entre despliegues.
      const encontrados: unknown[] = [];
      const visitar = (valor: unknown, profundidad: number): void => {
        if (profundidad > 8 || !valor || typeof valor !== "object") return;
        const obj = valor as Record<string, unknown>;
        if (typeof obj.shortcode === "string" && "is_video" in obj) {
          encontrados.push(obj);
          return;
        }
        for (const v of Object.values(obj)) visitar(v, profundidad + 1);
      };
      for (const script of Array.from(document.querySelectorAll("script"))) {
        const txt = script.textContent ?? "";
        if (!txt.includes("shortcode")) continue;
        const inicio = txt.indexOf("{");
        if (inicio < 0) continue;
        try {
          visitar(JSON.parse(txt.slice(inicio)), 0);
        } catch {
          // Script que no es JSON puro — se ignora.
        }
      }
      return encontrados;
    });

    return parseInstagramPosts(nodos, handle);
  } catch (err) {
    console.log(
      JSON.stringify({ ts: Date.now(), msg: "research_competencia_scrape_instagram_error", handle, err: String(err) })
    );
    return [];
  } finally {
    await browser.close();
  }
}
