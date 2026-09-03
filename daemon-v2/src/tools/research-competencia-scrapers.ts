// tools/research-competencia-scrapers.ts — scrapers headless por plataforma para el research de
// competencia (fase 2, redes sociales). Separado de research-competencia-social.ts a propósito:
// ese archivo se queda con tipos/filtro/formateo/orquestación; acá vive el detalle de Playwright
// por red social: Instagram y TikTok leen JSON embebido (`extractNodes`/`walkForNodes`); Facebook
// y X no exponen eso, así que leen el DOM ya renderizado (`collectDomPosts`/`parseDomPosts`). Las
// cuatro comparten el boilerplate de Playwright vía `withBrowserContext`.
//
// Mismo patrón que design-capture.ts: chromium.launch({headless:true}), cookies inyectadas al
// contexto, try/finally con browser.close(). El LLM no tiene tool de navegación genérica — esto
// es una tool de alto nivel, el detalle de Playwright queda puertas adentro.

import { chromium } from "playwright";
import type { Page } from "playwright";
import type { StructuredCookie } from "./cookie-jar.js";
import type { SocialPlatform, SocialPost } from "./research-competencia-social.js";

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

// Tope de profundidad del recorrido recursivo de `extractNodes`. Instagram/TikTok anidan el JSON
// del timeline dentro de wrappers de webpack/relay que cambian de forma entre despliegues — no
// hay confirmación de que 8 niveles alcancen siempre para la estructura real de producción.
// Ver el test "no encuentra un nodo a más de 8 niveles de profundidad" en el archivo de test: si
// el tope no alcanza, el síntoma es `nodos: []` con `scriptsConPatron > 0` y
// `scriptsConNodosValidos === 0` en el diagnóstico que loguea `withBrowserContext` — esa
// combinación es la señal de "hay que subir MAX_WALK_DEPTH", no de "cambiaron las cookies".
const MAX_WALK_DEPTH = 8;

type NodePredicate = (obj: Record<string, unknown>) => boolean;

/**
 * Recorrido recursivo genérico compartido por todos los extractores de este archivo (Instagram,
 * TikTok, y Facebook/X en tareas posteriores) — antes había una copia por plataforma, idéntica
 * salvo el predicado de match. `predicado` decide si un nodo matchea; ver los comentarios sobre
 * `ownerUsernameMatches`/`authorUniqueIdMatches` más abajo sobre por qué el predicado tiene que
 * validar autoría, no solo forma.
 */
function walkForNodes(valor: unknown, predicado: NodePredicate, profundidad: number, out: unknown[]): void {
  if (profundidad > MAX_WALK_DEPTH || !valor || typeof valor !== "object") return;
  const obj = valor as Record<string, unknown>;
  if (predicado(obj)) {
    out.push(obj);
    return;
  }
  for (const v of Object.values(obj)) walkForNodes(v, predicado, profundidad + 1, out);
}

interface NodeExtraction {
  nodos: unknown[];
  /** Señal diagnóstica para distinguir "no hay posts" de "no pudimos leer la página" — ver withBrowserContext. */
  diagnostics: { scriptsConPatron: number; scriptsConNodosValidos: number };
}

/**
 * Recorre los `<script>` candidatos aplicando `predicado` en cada nodo del recorrido recursivo.
 * Movido a Node (fuera de `page.evaluate`) para ser testeable con fixtures — es la parte más
 * frágil del scraper (recorrido recursivo + `JSON.parse` por script) y antes vivía intestable
 * dentro del closure del browser. `extractInstagramNodes`/`extractTikTokNodes` son wrappers de
 * una línea sobre esto, cada uno con su propio predicado.
 */
function extractNodes(scriptTexts: string[], predicado: NodePredicate): NodeExtraction {
  const nodos: unknown[] = [];
  let scriptsConNodosValidos = 0;
  for (const txt of scriptTexts) {
    const inicio = txt.indexOf("{");
    if (inicio < 0) continue;
    try {
      const antes = nodos.length;
      walkForNodes(JSON.parse(txt.slice(inicio)), predicado, 0, nodos);
      if (nodos.length > antes) scriptsConNodosValidos++;
    } catch {
      // Script que no es JSON puro (ej. un script de analytics que también menciona el literal
      // buscado en un comentario) — se ignora, no es un error del scraper.
    }
  }
  return { nodos, diagnostics: { scriptsConPatron: scriptTexts.length, scriptsConNodosValidos } };
}

// ⚠️ GRAVE, encontrado en review: el payload de rehidratación de un perfil (Instagram o TikTok)
// no trae SOLO los posts propios de la cuenta — también trae módulos de contenido
// recomendado/relacionado precargado, con nodos de EXACTAMENTE la misma forma (mismos campos:
// shortcode+is_video en Instagram, id+desc+video en TikTok). Sin validar de quién es el post, el
// matcher por forma puede levantar un video/post de OTRA cuenta y `parseInstagramPosts`/
// `parseTikTokPosts` lo atribuyen igual al `handle` scrapeado (el handle se pasa por afuera, no
// se lee del nodo) — el resultado es una URL bien formada pero FALSA, citada después como fuente
// verificable en el battlecard de research de competencia. Por eso el predicado de cada
// plataforma exige que el nodo declare como autor al `handle` que se está scrapeando, comparando
// en minúsculas — un nodo sin ese campo, o con un autor distinto, se descarta aunque matchee la
// forma. Mismo riesgo (y más probable todavía) en Facebook/X — ver `parseDomPosts` más abajo.
//
// `handlesMatch` es el fondo común de toda esa validación: fail-closed ante `null`/`undefined`/
// cualquier tipo que no sea string, Y ante un `handle` vacío — sin ese segundo guard, un nodo con
// autor `""` matchearía contra un `handle` que también llegara vacío (bug señalado en la revisión
// de esta tarea, nunca disparado en producción porque el handle siempre lo pasa el orquestador,
// pero un guard barato de tener).
function handlesMatch(valor: unknown, handle: string): boolean {
  return typeof valor === "string" && valor !== "" && handle !== "" && valor.toLowerCase() === handle.toLowerCase();
}

/**
 * Generaliza `ownerUsernameMatches`/`authorUniqueIdMatches` (Instagram/TikTok) — las dos leían un
 * campo anidado y comparaban contra `handle` en minúsculas, idénticas salvo el path. Factorizado
 * al sumar Facebook/X (nota de diseño de la revisión anterior): un path de campos anidados +
 * `handlesMatch` sobre el valor final.
 */
function fieldEqualsHandleCI(obj: Record<string, unknown>, path: readonly string[], handle: string): boolean {
  let valor: unknown = obj;
  for (const key of path) {
    if (!valor || typeof valor !== "object") return false;
    valor = (valor as Record<string, unknown>)[key];
  }
  return handlesMatch(valor, handle);
}

function ownerUsernameMatches(obj: Record<string, unknown>, handle: string): boolean {
  return fieldEqualsHandleCI(obj, ["owner", "username"], handle);
}

function authorUniqueIdMatches(obj: Record<string, unknown>, handle: string): boolean {
  return fieldEqualsHandleCI(obj, ["author", "uniqueId"], handle);
}

export interface InstagramExtraction {
  nodos: unknown[];
  /** Señal diagnóstica para distinguir "no hay posts" de "no pudimos leer la página" — ver withBrowserContext. */
  diagnostics: { scriptsConPatron: number; scriptsConNodosValidos: number };
}

/**
 * Extrae los nodos de post de Instagram que pertenecen a `handle` — ver el comentario sobre
 * `ownerUsernameMatches` arriba sobre por qué la validación de autoría es obligatoria, no un
 * extra: sin ella, un post recomendado de otra cuenta embebido en el mismo payload matchearía
 * igual de bien.
 */
export function extractInstagramNodes(scriptTexts: string[], handle: string): InstagramExtraction {
  return extractNodes(
    scriptTexts,
    (obj) => typeof obj.shortcode === "string" && "is_video" in obj && ownerUsernameMatches(obj, handle)
  );
}

// Ambiente mínimo SOLO para el body de page.evaluate() (corre en el navegador, no en Node) —
// mismo motivo que design-capture.ts: a propósito no se agrega "DOM" al lib del tsconfig, que
// aplicaría a todo el paquete y podría chocar con los tipos de fetch/Response/Headers de Node.
// Ampliado al sumar Facebook/X: `collectDomPosts` (más abajo) necesita recorrer nodos genéricos
// (`article`/`img`/`video`/`time`/`a`), no solo `<script>` como hacía `collectScriptsByLiteral`.
interface DomElement {
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  textContent: string | null;
  href?: string;
  src?: string;
  dateTime?: string;
}
declare const document: {
  querySelectorAll(selector: string): ArrayLike<DomElement>;
};

/**
 * Extrae del DOM los `textContent` crudos de los `<script>` que contienen `literal` — es lo
 * mínimo que `page.evaluate` necesita tocar. El parseo real (recorrido recursivo, `JSON.parse`)
 * vive del lado de Node en `extractNodes`. Compartido por Instagram ("shortcode") y TikTok
 * ("desc") — antes eran dos copias idénticas que solo diferían en el literal buscado.
 */
function collectScriptsByLiteral(page: Page, literal: string): Promise<string[]> {
  return page.evaluate((lit) => {
    const textos: string[] = [];
    for (const script of Array.from(document.querySelectorAll("script"))) {
      const txt = script.textContent ?? "";
      if (txt.includes(lit)) textos.push(txt);
    }
    return textos;
  }, literal);
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
    const scriptTexts = await collectScriptsByLiteral(page, "shortcode");
    const { nodos, diagnostics } = extractInstagramNodes(scriptTexts, handle);
    return { items: parseInstagramPosts(nodos, handle), diagnostics };
  });
}

/**
 * Parsea los items crudos del feed de TikTok (extraídos del JSON embebido en el script de
 * rehidratación `#__UNIVERSAL_DATA_FOR_REHYDRATION__` de la página de perfil) a `SocialPost`.
 * Función pura — sin red — mismo criterio que `parseInstagramPosts`. Todo post de TikTok es
 * video, así que `esVideo` es siempre `true` (no hay campo equivalente a `is_video` que leer).
 */
export function parseTikTokPosts(items: unknown[], handle: string): SocialPost[] {
  const posts: SocialPost[] = [];
  for (const raw of items) {
    const n = raw as { id?: string; desc?: string; createTime?: number; video?: { playAddr?: string } };
    if (!n.id) continue;
    posts.push({
      platform: "tiktok",
      handle,
      url: `https://www.tiktok.com/@${handle}/video/${n.id}`,
      fecha: isoDateFromUnix(n.createTime),
      caption: n.desc ?? "",
      mediaUrls: n.video?.playAddr ? [n.video.playAddr] : [],
      esVideo: true,
    });
  }
  return posts;
}

export interface TikTokExtraction {
  nodos: unknown[];
  /** Señal diagnóstica, mismo criterio que `InstagramExtraction` — ver withBrowserContext. */
  diagnostics: { scriptsConPatron: number; scriptsConNodosValidos: number };
}

/**
 * Extrae los items de video de TikTok que pertenecen a `handle` — ver el comentario sobre
 * `authorUniqueIdMatches` más arriba sobre por qué la validación de autoría es obligatoria: el
 * payload de rehidratación de un perfil trae también videos recomendados de otras cuentas, con
 * exactamente la misma forma (`id`+`desc`+`video`).
 */
export function extractTikTokNodes(scriptTexts: string[], handle: string): TikTokExtraction {
  return extractNodes(
    scriptTexts,
    (obj) =>
      typeof obj.id === "string" && "desc" in obj && "video" in obj && authorUniqueIdMatches(obj, handle)
  );
}

/**
 * Scrapea el perfil público de TikTok de `handle` y devuelve sus videos recientes.
 *
 * TikTok detecta automatización de forma más agresiva que Instagram (fingerprinting de browser,
 * challenges anti-bot) — si esto devuelve sistemáticamente `[]` (ver `diagnostics` en el log
 * `research_competencia_scrape_empty`), es señal de bloqueo de plataforma, no un bug del parser.
 * Este comportamiento está anticipado en el diseño: `withBrowserContext` degrada a `[]` sin
 * romper el research completo de las demás cuentas/plataformas.
 *
 * `mediaUrls` (el `playAddr` de TikTok) es una URL FIRMADA y de vida corta, atada a la sesión que
 * la generó — no es un link permanente como el `display_url`/`video_url` de Instagram. Si quien
 * cablea la orquestación llega a separar "scrapear todo" de "enriquecer todo" (`enrichPosts`
 * descarga esta URL más tarde, en `research-competencia-social.ts`), esas URLs pueden estar
 * muertas para cuando les toque el turno de descargarse — no asumir que sobreviven más allá del
 * mismo ciclo de research.
 */
export async function scrapeTikTok(handle: string, cookies: StructuredCookie[]): Promise<SocialPost[]> {
  return withBrowserContext("tiktok", handle, cookies, async (page) => {
    await page.goto(`https://www.tiktok.com/@${handle}`, { waitUntil: "networkidle", timeout: 30_000 });
    const scriptTexts = await collectScriptsByLiteral(page, "desc");
    const { nodos, diagnostics } = extractTikTokNodes(scriptTexts, handle);
    return { items: parseTikTokPosts(nodos, handle), diagnostics };
  });
}

/**
 * Post crudo tal como lo extrae `collectDomPosts` del DOM ya renderizado de Facebook/X — a
 * diferencia de Instagram/TikTok, ninguna de las dos expone un JSON embebido estable, así que acá
 * el timeline se lee directamente del árbol de nodos. `autor` es `string | null` (no siempre hay
 * forma de identificarlo) para que `parseDomPosts` pueda aplicar el mismo criterio fail-closed que
 * `ownerUsernameMatches`/`authorUniqueIdMatches`.
 */
export interface RawDomPost {
  url: string;
  texto: string;
  fechaIso: string | null;
  imagenes: string[];
  videos: string[];
  autor: string | null;
}

/** `fechaIso` → `YYYY-MM-DD` (los primeros 10 chars) si parsea como fecha válida; `null` si no. */
function parseDomDate(fechaIso: string | null): string | null {
  if (!fechaIso) return null;
  return Number.isNaN(new Date(fechaIso).getTime()) ? null : fechaIso.slice(0, 10);
}

/**
 * Normaliza los posts crudos del DOM de Facebook/X a `SocialPost` — función pura, sin red, mismo
 * criterio que `parseInstagramPosts`/`parseTikTokPosts`. Descarta sin `url`, y descarta sin autor
 * verificado contra `handle` (fail-closed vía `handlesMatch`, ver comentario grande más arriba):
 * el timeline de X trae retweets/quote-tweets de otras cuentas, y una página de Facebook muestra
 * posts compartidos de otras páginas — mismo riesgo que llevó a validar autoría en Instagram/
 * TikTok, y más probable acá.
 */
export function parseDomPosts(crudos: RawDomPost[], platform: SocialPlatform, handle: string): SocialPost[] {
  const posts: SocialPost[] = [];
  for (const crudo of crudos) {
    if (!crudo.url) continue;
    if (!handlesMatch(crudo.autor, handle)) continue;
    const esVideo = crudo.videos.length > 0;
    const mediaUrls = esVideo ? [crudo.videos[0]] : crudo.imagenes.length > 0 ? [crudo.imagenes[0]] : [];
    posts.push({
      platform,
      handle,
      url: crudo.url,
      fecha: parseDomDate(crudo.fechaIso),
      caption: crudo.texto,
      mediaUrls,
      esVideo,
    });
  }
  return posts;
}

/**
 * Extrae posts crudos del DOM ya renderizado — compartida por Facebook y X, corre dentro de
 * `page.evaluate` (contexto del browser, no de Node).
 *
 * ⚠️ SELECTORES PENDIENTES DE VERIFICACIÓN EN VIVO. Esta tarea no navega a las páginas reales (eso
 * es la tarea 13, con cookies reales) — lo de abajo es el mejor criterio disponible sin poder
 * confirmarlo, no un hecho verificado:
 * - `article, [role="article"]` para encontrar cada post: X marca cada tweet `<article>`,
 *   Facebook usa `role="article"`.
 * - El permalink sale de `a[href*="/status/"]` (X) / `a[href*="/posts/"]`/`a[href*="/videos/"]`
 *   (Facebook).
 * - El autor se deriva del PRIMER segmento de path de ESE permalink (`/{autor}/status/{id}` en X,
 *   `/{autor}/posts|videos/{id}` en Facebook) — en X esto es estructuralmente robusto ante
 *   retweets: el permalink de un retweet en el timeline de `handle` sigue apuntando a
 *   `x.com/{autorOriginal}/status/{id}`, no a `handle`, así que `parseDomPosts` ya lo descarta
 *   solo con esto. En Facebook es más débil (un post COMPARTIDO por la página puede seguir
 *   teniendo permalink bajo la propia página) — si la tarea 13 confirma que no alcanza, hay que
 *   sumar un selector más específico del nombre visible en el header del post.
 */
function collectDomPosts(page: Page): Promise<RawDomPost[]> {
  return page.evaluate(() => {
    const crudos: RawDomPost[] = [];
    for (const art of Array.from(document.querySelectorAll('article, [role="article"]'))) {
      const link = art.querySelector('a[href*="/status/"], a[href*="/posts/"], a[href*="/videos/"]');
      const url = link?.href ?? "";
      let autor: string | null = null;
      if (url) {
        try {
          autor = new URL(url).pathname.split("/").filter(Boolean)[0] ?? null;
        } catch {
          autor = null;
        }
      }
      const imagenes = Array.from(art.querySelectorAll("img"))
        .map((img) => img.src ?? "")
        .filter((src) => src.startsWith("http"));
      const videos = Array.from(art.querySelectorAll("video"))
        .map((v) => v.src ?? "")
        .filter((src) => src.startsWith("http"));
      crudos.push({
        url,
        texto: art.textContent?.trim() ?? "",
        fechaIso: art.querySelector("time")?.dateTime ?? null,
        imagenes,
        videos,
        autor,
      });
    }
    return crudos;
  });
}

/**
 * Scrapea la página pública de Facebook de `handle` y devuelve sus posts recientes.
 *
 * Facebook detecta automatización de forma más agresiva que Instagram (fingerprinting de browser,
 * challenges anti-bot, muro de login más insistente) — mismo comportamiento ya documentado para
 * TikTok en `scrapeTikTok`. Si esto devuelve sistemáticamente `[]` (ver `diagnostics` en el log
 * `research_competencia_scrape_empty`), es señal de bloqueo de plataforma, no un bug del parser:
 * está anticipado en el spec y el diseño degrada sin romper el research completo de las demás
 * cuentas/plataformas (ver `withBrowserContext`).
 */
export async function scrapeFacebook(handle: string, cookies: StructuredCookie[]): Promise<SocialPost[]> {
  return withBrowserContext("facebook", handle, cookies, async (page) => {
    await page.goto(`https://www.facebook.com/${handle}`, { waitUntil: "networkidle", timeout: 30_000 });
    const crudos = await collectDomPosts(page);
    return { items: parseDomPosts(crudos, "facebook", handle), diagnostics: { articulosEncontrados: crudos.length } };
  });
}

/**
 * Scrapea el perfil público de X de `handle` y devuelve sus posts recientes.
 *
 * Facebook detecta automatización de forma más agresiva que Instagram — TikTok también, ver
 * `scrapeTikTok` — y lo mismo aplica acá: si esto devuelve sistemáticamente `[]`, es señal de
 * bloqueo de plataforma, no un bug del parser. Diseño anticipado, degrada sin romper el research
 * completo de las demás cuentas/plataformas (ver `withBrowserContext`).
 */
export async function scrapeX(handle: string, cookies: StructuredCookie[]): Promise<SocialPost[]> {
  return withBrowserContext("x", handle, cookies, async (page) => {
    await page.goto(`https://x.com/${handle}`, { waitUntil: "networkidle", timeout: 30_000 });
    const crudos = await collectDomPosts(page);
    return { items: parseDomPosts(crudos, "x", handle), diagnostics: { articulosEncontrados: crudos.length } };
  });
}
