// tools/research-competencia-scrapers.ts — scrapers headless por plataforma para el research de
// competencia (fase 2, redes sociales). Separado de research-competencia-social.ts a propósito:
// ese archivo se queda con tipos/filtro/formateo/orquestación; acá vive el detalle de Playwright
// por red social (Instagram en esta tarea; TikTok/Facebook se suman en tareas posteriores, ambos
// vía `withBrowserContext`).
//
// Mismo patrón que design-capture.ts: chromium.launch({headless:true}), cookies inyectadas al
// contexto, try/finally con browser.close(). El LLM no tiene tool de navegación genérica — esto
// es una tool de alto nivel, el detalle de Playwright queda puertas adentro.

import { chromium } from "playwright";
import type { Page } from "playwright";
import type { StructuredCookie } from "./cookie-jar.js";
import type { SocialPost } from "./research-competencia-social.js";

/**
 * Convierte un timestamp Unix (segundos) a fecha calendario `YYYY-MM-DD` en La Paz (UTC-4), no
 * UTC — mismo criterio que `parseFechaLaPaz` en research-competencia-social.ts. Offset FIJO a
 * propósito: Bolivia no tiene horario de verano, así que restar 4h siempre da la hora local real,
 * sin necesidad de una tabla de reglas de DST. El daemon corre en Bolivia y un post publicado de
 * noche ahí (ej. 21:00 La Paz = 01:00 UTC del día siguiente) puede caer en el día siguiente en
 * UTC si no se corrige. Devuelve null si `ts` no es un número usable (Instagram a veces omite el
 * campo).
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

// Tope de profundidad del recorrido recursivo de `extractInstagramNodes`. Instagram anida el
// JSON del timeline dentro de wrappers de webpack/relay que cambian de forma entre despliegues —
// no hay confirmación de que 8 niveles alcancen siempre para la estructura real de producción.
// Ver el test "no encuentra un nodo a más de 8 niveles de profundidad" en el archivo de test: si
// el tope no alcanza, el síntoma es `nodos: []` con `scriptsConPatron > 0` y
// `scriptsConNodosValidos === 0` en el diagnóstico que loguea `withBrowserContext` — esa
// combinación es la señal de "hay que subir MAX_WALK_DEPTH", no de "cambiaron las cookies".
const MAX_WALK_DEPTH = 8;

function walkForInstagramNodes(valor: unknown, profundidad: number, out: unknown[]): void {
  if (profundidad > MAX_WALK_DEPTH || !valor || typeof valor !== "object") return;
  const obj = valor as Record<string, unknown>;
  if (typeof obj.shortcode === "string" && "is_video" in obj) {
    out.push(obj);
    return;
  }
  for (const v of Object.values(obj)) walkForInstagramNodes(v, profundidad + 1, out);
}

export interface InstagramExtraction {
  nodos: unknown[];
  /** Señal diagnóstica para distinguir "no hay posts" de "no pudimos leer la página" — ver withBrowserContext. */
  diagnostics: { scriptsConPatron: number; scriptsConNodosValidos: number };
}

/**
 * Recorre los `<script>` candidatos (ya filtrados por contener el literal "shortcode") buscando
 * los nodos de post embebidos. Movido a Node (fuera de `page.evaluate`) para ser testeable con
 * fixtures — es la parte más frágil del scraper (recorrido recursivo + `JSON.parse` por script) y
 * antes vivía intestable dentro del closure del browser.
 */
export function extractInstagramNodes(scriptTexts: string[]): InstagramExtraction {
  const nodos: unknown[] = [];
  let scriptsConNodosValidos = 0;
  for (const txt of scriptTexts) {
    const inicio = txt.indexOf("{");
    if (inicio < 0) continue;
    try {
      const antes = nodos.length;
      walkForInstagramNodes(JSON.parse(txt.slice(inicio)), 0, nodos);
      if (nodos.length > antes) scriptsConNodosValidos++;
    } catch {
      // Script que no es JSON puro (ej. un script de analytics que también menciona "shortcode"
      // en un comentario) — se ignora, no es un error del scraper.
    }
  }
  return { nodos, diagnostics: { scriptsConPatron: scriptTexts.length, scriptsConNodosValidos } };
}

// Ambiente mínimo SOLO para el body de page.evaluate() (corre en el navegador, no en Node) —
// mismo motivo que design-capture.ts: a propósito no se agrega "DOM" al lib del tsconfig, que
// aplicaría a todo el paquete y podría chocar con los tipos de fetch/Response/Headers de Node.
declare const document: {
  querySelectorAll(selector: "script"): ArrayLike<{ textContent: string | null }>;
};

/**
 * Extrae del DOM los `textContent` crudos de los `<script>` que mencionan "shortcode" — es lo
 * mínimo que `page.evaluate` necesita tocar. El parseo real (recorrido recursivo, `JSON.parse`)
 * vive del lado de Node en `extractInstagramNodes`, testeable sin browser.
 */
function collectCandidateScripts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const textos: string[] = [];
    for (const script of Array.from(document.querySelectorAll("script"))) {
      const txt = script.textContent ?? "";
      if (txt.includes("shortcode")) textos.push(txt);
    }
    return textos;
  });
}

export interface ScrapeOutcome<T> {
  items: T[];
  /** Datos propios de cada scraper para diagnosticar un resultado vacío (ver withBrowserContext). */
  diagnostics?: Record<string, unknown>;
}

/**
 * Centraliza el boilerplate de Playwright compartido por todos los scrapers de este archivo
 * (Instagram hoy; TikTok/Facebook/X se suman en tareas posteriores y reusan esta misma función):
 * `chromium.launch` → `newContext` → `addCookies` → `newPage` → `scrape(page)` → `browser.close()`
 * en `finally`, MÁS el logging de los dos casos que un scraper roto puede producir en silencio:
 *
 * 1. **Excepción real** (timeout, error de red, navegación fallida) → log
 *    `research_competencia_scrape_error` y devuelve `[]`.
 * 2. **"Cero resultados" sin excepción** (`page.goto` resuelve normal pero el parseo no encontró
 *    nada — típico de una cookie vencida que sirve el muro de login, o un cambio de layout) → log
 *    `research_competencia_scrape_empty` con los `diagnostics` que devuelva el scraper concreto,
 *    para poder distinguir "esta cuenta no publicó nada" de "no pudimos leer la página" sin tener
 *    que deducirlo por descarte (ver punto 1 del review que originó este archivo).
 *
 * Cualquier falla devuelve `[]` en vez de propagar: esto corre en un cron desatendido, un solo
 * scraper roto no debe tumbar el research completo de las demás cuentas/plataformas.
 */
export async function withBrowserContext<T>(
  platform: string,
  handle: string,
  cookies: StructuredCookie[],
  scrape: (page: Page) => Promise<ScrapeOutcome<T>>
): Promise<T[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    if (cookies.length > 0) await context.addCookies(cookies);
    const page = await context.newPage();
    const { items, diagnostics } = await scrape(page);
    if (items.length === 0) {
      console.log(
        JSON.stringify({ ts: Date.now(), msg: "research_competencia_scrape_empty", platform, handle, ...diagnostics })
      );
    }
    return items;
  } catch (err) {
    console.log(
      JSON.stringify({ ts: Date.now(), msg: "research_competencia_scrape_error", platform, handle, err: String(err) })
    );
    return [];
  } finally {
    await browser.close();
  }
}

/**
 * Scrapea el perfil público de Instagram de `handle` y devuelve sus posts recientes. Una sola
 * visita, sin scroll — minimiza la huella de automatización sobre la cuenta que presta las
 * cookies.
 */
export async function scrapeInstagram(handle: string, cookies: StructuredCookie[]): Promise<SocialPost[]> {
  return withBrowserContext("instagram", handle, cookies, async (page) => {
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: "networkidle", timeout: 30_000 });
    const scriptTexts = await collectCandidateScripts(page);
    const { nodos, diagnostics } = extractInstagramNodes(scriptTexts);
    return { items: parseInstagramPosts(nodos, handle), diagnostics };
  });
}
