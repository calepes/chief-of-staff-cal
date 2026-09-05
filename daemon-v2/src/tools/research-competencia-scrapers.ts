// tools/research-competencia-scrapers.ts — scrapers por plataforma para el research de
// competencia (fase 2, redes sociales). Separado de research-competencia-social.ts a propósito:
// ese archivo se queda con tipos/filtro/formateo/orquestación; acá vive el detalle de Playwright
// por red social: Instagram y TikTok leen JSON embebido (`extractNodes`/`walkForNodes`); Facebook
// y X no exponen eso, así que leen el DOM ya renderizado (`collectDomPosts`/`parseDomPosts`). Las
// cuatro comparten el boilerplate de Playwright vía `withBrowserContext`.
//
// Chrome REAL vía CDP (research-competencia-browser.ts), NO `chromium.launch()` propio — Chromium
// headless de Playwright se topó con detección de bot en las 4 plataformas (verificado en vivo
// 2026-09-03: con cookie de sesión válida igual devolvía 0 posts). El `BrowserContext` ya viene
// ABIERTO desde el orquestador (una sola sesión de Chrome compartida por las 6 entidades, no una
// por handle) — acá solo se abre/cierra la `Page` de cada llamada. El LLM no tiene tool de
// navegación genérica — esto es una tool de alto nivel, el detalle de Playwright queda puertas
// adentro.

import type { BrowserContext, Page } from "playwright";
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
 * Ordena más-reciente-primero — orden que `enrichPosts` (research-competencia-social.ts) asume
 * vía `slice(0, MAX_POSTS_PER_ACCOUNT)` pero que ningún scraper garantizaba explícitamente
 * (IMPORTANTE 4 de la revisión de salud, 2026-09-03): Instagram/TikTok devuelven el orden
 * estructural del JSON embebido, Facebook/X el orden del DOM — ninguno de los 4 es "más reciente
 * primero" por contrato, solo por casualidad de cómo cada plataforma arma su timeline hoy. Sin
 * probar contra páginas reales todavía, ese contrato podía romperse en la primera corrida sin
 * ningún error visible (se quedaría con los 8 posts equivocados, en silencio) — por eso se ordena
 * ACÁ, en las funciones puras de parseo que ya comparten los 4 scrapers, en vez de confiar en que
 * cada uno lo haga bien por su cuenta.
 *
 * Los posts SIN fecha parseable se CONSERVAN (decisión ya tomada, ver `filterPostsByTimeframe`/
 * `warnIfOrderViolated` en research-competencia-social.ts) pero van al FINAL, después de todos los
 * que sí tienen fecha — no hay forma de saber si son más viejos o más nuevos, así que no pueden
 * competir por una posición en el orden por fecha; entre sí conservan su orden relativo original
 * (sort estable de V8, ES2019+).
 *
 * `warnIfOrderViolated` deja de ser la única defensa y pasa a red de seguridad: con esto, el
 * `slice` de `enrichPosts` ya no depende del orden implícito de cada scraper.
 */
function sortPostsByFechaDesc(posts: SocialPost[]): SocialPost[] {
  const conFecha = posts.filter((p) => p.fecha !== null);
  const sinFecha = posts.filter((p) => p.fecha === null);
  conFecha.sort((a, b) => (b.fecha as string).localeCompare(a.fecha as string));
  return [...conFecha, ...sinFecha];
}

// Tope de profundidad del recorrido recursivo de `extractNodes`. TikTok anida el JSON del
// timeline dentro de wrappers que cambian de forma entre despliegues — no hay confirmación de que
// 8 niveles alcancen siempre para la estructura real de producción. Ver el test "no encuentra un
// nodo a más de 8 niveles de profundidad" en el archivo de test: si el tope no alcanza, el
// síntoma es `nodos: []` con `scriptsConPatron > 0` y `scriptsConNodosValidos === 0` en el
// diagnóstico que loguea `withBrowserContext` — esa combinación es la señal de "hay que subir
// MAX_WALK_DEPTH", no de "cambió la sesión".
//
// Ya NO lo usa Instagram (ver `parseInstagramGridItems` más abajo) — Instagram dejó de servir el
// timeline como JSON embebido en un `<script>` (verificado en vivo 2026-09-05: con Chrome real y
// sesión logueada, la página es la real, no un muro, pero el patrón `shortcode`+`is_video` que
// buscaba `extractInstagramNodes` ya no existe en ningún script de la página — Instagram migró a
// su framework "Comet", con otra forma de datos). Se mantiene para TikTok, que SÍ sigue
// embebiendo `__UNIVERSAL_DATA_FOR_REHYDRATION__` como JSON — aunque TikTok tiene su propio
// bloqueo real (ver el comentario de `scrapeTikTok`), no relacionado con esto.
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

function authorUniqueIdMatches(obj: Record<string, unknown>, handle: string): boolean {
  return fieldEqualsHandleCI(obj, ["author", "uniqueId"], handle);
}

// Ambiente mínimo SOLO para el body de page.evaluate() (corre en el navegador, no en Node) —
// mismo motivo que design-capture.ts: a propósito no se agrega "DOM" al lib del tsconfig, que
// aplicaría a todo el paquete y podría chocar con los tipos de fetch/Response/Headers de Node.
// Ampliado al sumar Facebook/X: `collectDomPosts` (más abajo) necesita recorrer nodos genéricos
// (`article`/`img`/`video`/`time`/`a`), no solo `<script>` como hacía `collectScriptsByLiteral`.
interface DomElement {
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  getAttribute(name: string): string | null;
  textContent: string | null;
  href?: string;
  src?: string;
  dateTime?: string;
  /** Solo lo llenan los `<img>` — dimensión REAL renderizada, no el tamaño del atributo `width/height`. */
  naturalWidth?: number;
  naturalHeight?: number;
}
declare const document: {
  querySelectorAll(selector: string): ArrayLike<DomElement>;
};

// px — mismo criterio y mismo valor que `MIN_IMAGE_DIMENSION` de design-capture.ts: filtra
// avatares/íconos (rondan 24-88px), un post real siempre supera esto. Encontrado en review de
// calidad: sin este piso, `querySelectorAll("img")` devuelve en orden de documento, y en X/
// Facebook el avatar del header renderiza ANTES del contenido dentro del mismo `<article>` —
// `mediaUrls[0]` se llevaba el avatar en vez de la foto del post. Umbral sujeto a ajuste en la
// verificación en vivo (tarea 13) — acá no hay forma de confirmar contra el DOM real.
const MIN_DOM_IMAGE_DIMENSION = 200;

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
 * Centraliza el boilerplate compartido por todos los scrapers de este archivo: `context.newPage()`
 * → `scrape(page)` → `page.close()` en `finally`, MÁS el logging de los dos casos que un scraper
 * roto puede producir en silencio:
 *
 * 1. **Excepción real** (timeout, error de red, navegación fallida) → log
 *    `research_competencia_scrape_error` y devuelve `[]`.
 * 2. **"Cero resultados" sin excepción** (`page.goto` resuelve normal pero el parseo no encontró
 *    nada — típico de una sesión vencida que sirve el muro de login, detección de bot, o un cambio
 *    de layout) → log `research_competencia_scrape_empty` con los `diagnostics` que devuelva el
 *    scraper concreto, para poder distinguir "esta cuenta no publicó nada" de "no pudimos leer la
 *    página" sin tener que deducirlo por descarte (ver punto 1 del review que originó este
 *    archivo).
 *
 * Cualquier falla devuelve `[]` en vez de propagar: esto corre en un cron desatendido, un solo
 * scraper roto no debe tumbar el research completo de las demás cuentas/plataformas.
 *
 * Solo cierra la `Page`, NUNCA el `context` — es una sesión de Chrome COMPARTIDA por las 6
 * entidades de la corrida (research-competencia-browser.ts), abierta y cerrada una sola vez por el
 * orquestador. Cerrarla acá dejaría a la entidad/handle siguiente sin browser.
 */
export async function withBrowserContext<T>(
  platform: string,
  handle: string,
  context: BrowserContext,
  scrape: (page: Page) => Promise<ScrapeOutcome<T>>
): Promise<T[]> {
  let page: Page | undefined;
  try {
    page = await context.newPage();
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
    await page?.close().catch(() => {});
  }
}

/** Post crudo tal como lo extrae `collectInstagramGridItems` del grid ya renderizado del perfil. */
export interface RawInstagramGridItem {
  /** Path relativo tal como lo da el DOM, ej. `/altoke.bo/p/DcR5JyFjosl/` o `/altoke.bo/reel/...`. */
  href: string;
  /** Miniatura — para fotos es la imagen real; para reels es un frame/poster, NO el video. */
  imgSrc: string;
  imgAlt: string | null;
}

const IG_MESES: Record<string, string> = {
  January: "01", February: "02", March: "03", April: "04", May: "05", June: "06",
  July: "07", August: "08", September: "09", October: "10", November: "11", December: "12",
};

// El `alt` de una FOTO (no reel) sigue el patrón fijo "Photo by {autor} on {Month DD, YYYY}. ..."
// — es texto de accesibilidad AUTO-GENERADO por Instagram (visión + metadata), no algo que el
// autor escriba. Verificado en vivo 2026-09-05 contra el perfil real de altoke.bo. Es la ÚNICA
// fuente de fecha que el grid expone — no hay `<time>` ni timestamp en ningún atributo.
const IG_PHOTO_ALT_RE = /^Photo by .+ on (January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})\./;

/**
 * Parsea la fecha embebida en el alt de una foto ("Photo by altoke on August 20, 2026. ...") a
 * `YYYY-MM-DD`. Parseo manual de string, NO `new Date(alt)`: es una fecha CALENDARIO tal como la
 * declara Instagram, no un instante que necesite el ajuste de husario -4h que sí aplica a
 * timestamps Unix en otras partes de este archivo — pasarla por `Date` además dependería del
 * timezone del proceso que corre el script, innecesario acá.
 */
export function parseInstagramPhotoAltDate(alt: string): string | null {
  const m = IG_PHOTO_ALT_RE.exec(alt);
  if (!m) return null;
  const [, mes, dia] = m;
  return `${m[3]}-${IG_MESES[mes]}-${dia.padStart(2, "0")}`;
}

/**
 * Parsea los ítems crudos del grid de Instagram a `SocialPost`. Función pura — sin red — mismo
 * criterio que el resto de los parsers de este archivo.
 *
 * Reemplaza a `parseInstagramPosts`/`extractInstagramNodes` (JSON embebido, descartado 2026-09-05
 * — ver el comentario de `MAX_WALK_DEPTH`). El grid expone MUCHA menos estructura que el JSON
 * viejo, y las dos formas de post (foto vs. reel) traen datos casi complementarios — ninguna trae
 * todo:
 *
 * - **Reel** (`href` contiene `/reel/`): el `alt` de la miniatura ES el caption real completo que
 *   escribió la cuenta (con emojis, hashtags, vigencia de promos) — verificado contra 7 reels
 *   reales de altoke.bo. Pero SIN fecha: el patrón de fecha solo aparece en fotos.
 * - **Foto** (`href` contiene `/p/`): el `alt` es una descripción de VISIÓN auto-generada
 *   ("Photo by altoke on {fecha}. May be a meme of...") — no es un caption real, así que acá
 *   `caption` queda vacío a propósito (usarlo confundiría al agente: pensaría que es texto propio
 *   de la marca). Sí trae fecha parseable.
 *
 * `esVideo` se fuerza `false` para AMBOS tipos, aunque el href diga `/reel/`: `mediaUrls` acá
 * SIEMPRE es la miniatura (`imgSrc`), nunca una URL de video real — el grid no la expone, hay que
 * abrir el reel para conseguirla (no implementado, fuera de alcance de esta pasada). Si `esVideo`
 * fuera `true`, `enrichPosts` (research-competencia-social.ts) intentaría descargar esa miniatura
 * JPG con `analyzeVideoFn` como si fuera un archivo de video — fallaría siempre, generando
 * `research_competencia_video_download_error` en cada reel sin aportar nada. Tratarlo como imagen
 * (`esVideo:false`) hace que `enrichPosts` corra `describeImageFn` sobre la miniatura, que sí
 * tiene sentido — se pierde el análisis de video/audio real, pero se gana el caption completo
 * (antes ni eso: 0 posts).
 *
 * NO se ordena con `sortPostsByFechaDesc` a propósito, a diferencia de los demás parsers de este
 * archivo: el grid YA viene más-reciente-primero (orden nativo de Instagram), y como los reels no
 * tienen fecha, aplicar ese sort empujaría TODOS los reels al final — exactamente lo contrario de
 * lo correcto, porque en la muestra real los reels son la mayoría del contenido (7 de 10 ítems) y
 * el que trae el caption real. Preservar el orden del grid mantiene la intercalación
 * foto/reel real; el contrato "sin fecha se conserva" de `filterPostsByTimeframe` sigue aplicando
 * igual aguas abajo.
 */
export function parseInstagramGridItems(items: RawInstagramGridItem[], handle: string): SocialPost[] {
  const posts: SocialPost[] = [];
  for (const item of items) {
    const segmentos = item.href.split("/").filter(Boolean);
    if (!handlesMatch(segmentos[0], handle)) continue; // el grid es de un solo perfil, pero fail-closed igual
    const esReel = item.href.includes("/reel/");
    posts.push({
      platform: "instagram",
      handle,
      url: `https://www.instagram.com${item.href}`,
      fecha: esReel ? null : parseInstagramPhotoAltDate(item.imgAlt ?? ""),
      caption: esReel ? (item.imgAlt ?? "") : "",
      mediaUrls: [item.imgSrc],
      esVideo: false, // ver el comentario grande de arriba — nunca true, no hay URL de video real
    });
  }
  return posts;
}

/**
 * Extrae del grid ya renderizado los `<a>` de post/reel con su miniatura — corre dentro de
 * `page.evaluate` (contexto del browser). El parseo real vive en `parseInstagramGridItems`
 * (Node, testeable). Descarta ítems sin `href`/`imgSrc` (ej. un placeholder todavía cargando).
 */
function collectInstagramGridItems(page: Page): Promise<RawInstagramGridItem[]> {
  return page.evaluate(() => {
    const out: { href: string; imgSrc: string; imgAlt: string | null }[] = [];
    for (const a of Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'))) {
      const href = a.getAttribute("href");
      const img = a.querySelector("img");
      const src = img?.getAttribute("src");
      if (!href || !src) continue;
      out.push({ href, imgSrc: src, imgAlt: img?.getAttribute("alt") ?? null });
    }
    return out;
  });
}

/**
 * Scrapea el perfil público de Instagram de `handle` y devuelve sus posts recientes. Una sola
 * visita, sin scroll — minimiza la huella de automatización sobre la cuenta que presta la sesión.
 */
export async function scrapeInstagram(handle: string, context: BrowserContext): Promise<SocialPost[]> {
  return withBrowserContext("instagram", handle, context, async (page) => {
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: "networkidle", timeout: 30_000 });
    const items = await collectInstagramGridItems(page);
    return { items: parseInstagramGridItems(items, handle), diagnostics: { itemsEnGrid: items.length } };
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
  return sortPostsByFechaDesc(posts);
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
export async function scrapeTikTok(handle: string, context: BrowserContext): Promise<SocialPost[]> {
  return withBrowserContext("tiktok", handle, context, async (page) => {
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

/**
 * `fechaIso` (el `dateTime` de `<time>`, en UTC en X y Facebook) → fecha calendario `YYYY-MM-DD`
 * en La Paz — NUNCA los primeros 10 chars del ISO crudo. Reusa `isoDateFromUnix` (mismo offset fijo
 * -4h que ya aplica Instagram/TikTok) en vez de reimplementar el ajuste: BLOQUEANTE de la revisión
 * de calidad, encontrado porque un post publicado a las 21:00 La Paz llega como
 * `01:00Z` del día siguiente — `.slice(0,10)` sobre eso lo fechaba un día después del real, y esa
 * fecha se propaga al filtro de ventana, al chequeo de orden, y al battlecard. Devuelve `null` si
 * `fechaIso` es `null` o no parsea.
 */
function parseDomDate(fechaIso: string | null): string | null {
  if (!fechaIso) return null;
  const ms = new Date(fechaIso).getTime();
  if (Number.isNaN(ms)) return null;
  return isoDateFromUnix(ms / 1000);
}

/**
 * Deriva el autor de un post de Facebook/X a partir de su URL de permalink — extraída a función
 * pura de Node (importante en la revisión de calidad: antes vivía inline dentro de
 * `page.evaluate`, sin un solo test, pese a ser la lógica que decide si un retweet o un post
 * compartido se descarta — el riesgo central que motivó esta tarea; mismo criterio que llevó a
 * mover `extractNodes`/`walkForNodes` fuera del closure del browser para Instagram/TikTok).
 *
 * Toma el PRIMER segmento de path (`/{autor}/status/{id}` en X, `/{autor}/posts|videos/{id}` en
 * Facebook) — en X esto es estructuralmente robusto ante retweets: el permalink de un retweet en
 * el timeline de `handle` sigue apuntando a `x.com/{autorOriginal}/status/{id}`, no a `handle`,
 * así que `parseDomPosts` ya lo descarta solo con esto. En Facebook es más débil (un post
 * COMPARTIDO por la página puede seguir teniendo permalink bajo la propia página) — si la tarea 13
 * confirma que no alcanza, hay que sumar un selector más específico del nombre visible en el
 * header del post.
 *
 * Casos de borde verificados por test, no supuestos: `/i/web/status/{id}` de X devuelve `"i"` —
 * hoy eso se descarta bien porque ninguna cuenta real se llama "i", pero es un acierto casual del
 * primer-segmento, no una regla de diseño verificada (dejado así, documentado). `permalink.php` de
 * Facebook (`?story_fbid=...&id=...`) NO lleva el autor en el path — el `id` de query es un ID
 * numérico interno, no comparable contra el handle vanity que usa Cal — así que se devuelve `null`
 * explícito en vez de comparar por casualidad contra el literal `"permalink.php"`.
 */
export function deriveAuthorFromPermalink(url: string): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    // Segundo argumento como base: soporta también URLs relativas (`/handle/status/123`), que es
    // lo que devuelve un `href` de anchor relativo si algún día `collectDomPosts` lo captura crudo.
    parsed = new URL(url, "https://dominio-base.invalid");
  } catch {
    return null;
  }
  const primerSegmento = parsed.pathname.split("/").filter(Boolean)[0];
  if (!primerSegmento || primerSegmento === "permalink.php") return null;
  return primerSegmento;
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
  return sortPostsByFechaDesc(posts);
}

/** Forma cruda que devuelve `collectDomPosts` — sin `autor`, a diferencia de `RawDomPost`: acá
 * el autor se deriva DESPUÉS, en Node, vía `deriveAuthorFromPermalink` (ver comentario ahí sobre
 * por qué se movió fuera del closure del browser). */
interface DomPostExtraction {
  url: string;
  texto: string;
  fechaIso: string | null;
  imagenes: string[];
  videos: string[];
}

/**
 * Extrae posts crudos del DOM ya renderizado — compartida por Facebook y X, corre dentro de
 * `page.evaluate` (contexto del browser, no de Node). Deliberadamente NO deriva el autor acá (ver
 * `deriveAuthorFromPermalink`) — solo hace la extracción de DOM en sí.
 *
 * ⚠️ SELECTORES PENDIENTES DE VERIFICACIÓN EN VIVO. Esta tarea no navega a las páginas reales (eso
 * es la tarea 13, con cookies reales) — lo de abajo es el mejor criterio disponible sin poder
 * confirmarlo, no un hecho verificado:
 * - `article, [role="article"]` para encontrar cada post: X marca cada tweet `<article>`,
 *   Facebook usa `role="article"`.
 * - El permalink sale de `a[href*="/status/"]` (X) / `a[href*="/posts/"]`/`a[href*="/videos/"]`
 *   (Facebook).
 * - El texto intenta primero `[data-testid="tweetText"]` (contenedor documentado de X para el
 *   cuerpo del tweet) y solo cae al `textContent` del `<article>` completo si no lo encuentra —
 *   sin esto, el `<article>` entero mezcla nombre de cuenta, handle, timestamp, contadores y
 *   botones ("Me gusta", "Compartir") ANTES del texto real, y como aguas abajo hay un tope de
 *   caracteres por caption, esa basura puede desplazar el contenido real antes del corte.
 *   Facebook no tiene un selector de texto tan documentado — queda en el fallback, pendiente de
 *   afinar en la tarea 13.
 * - Las imágenes filtran por `naturalWidth/naturalHeight >= 200px` (`MIN_DOM_IMAGE_DIMENSION`,
 *   mismo criterio que `design-capture.ts`) — sin esto, el avatar del header (que renderiza ANTES
 *   que el contenido dentro del mismo `<article>` en X/Facebook) se lleva `mediaUrls[0]` en vez de
 *   la foto real del post.
 */
function collectDomPosts(page: Page): Promise<DomPostExtraction[]> {
  return page.evaluate((minDim) => {
    const crudos: DomPostExtraction[] = [];
    for (const art of Array.from(document.querySelectorAll('article, [role="article"]'))) {
      const link = art.querySelector('a[href*="/status/"], a[href*="/posts/"], a[href*="/videos/"]');
      const url = link?.href ?? "";
      const textoEl = art.querySelector('[data-testid="tweetText"]');
      const texto = (textoEl?.textContent ?? art.textContent ?? "").trim();
      const imagenes = Array.from(art.querySelectorAll("img"))
        .filter((img) => (img.src ?? "").startsWith("http") && (img.naturalWidth ?? 0) >= minDim && (img.naturalHeight ?? 0) >= minDim)
        .map((img) => img.src ?? "");
      const videos = Array.from(art.querySelectorAll("video"))
        .map((v) => v.src ?? "")
        .filter((src) => src.startsWith("http"));
      crudos.push({
        url,
        texto,
        fechaIso: art.querySelector("time")?.dateTime ?? null,
        imagenes,
        videos,
      });
    }
    return crudos;
  }, MIN_DOM_IMAGE_DIMENSION);
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
export async function scrapeFacebook(handle: string, context: BrowserContext): Promise<SocialPost[]> {
  return withBrowserContext("facebook", handle, context, async (page) => {
    await page.goto(`https://www.facebook.com/${handle}`, { waitUntil: "networkidle", timeout: 30_000 });
    const crudos = await collectDomPosts(page);
    const conAutor: RawDomPost[] = crudos.map((c) => ({ ...c, autor: deriveAuthorFromPermalink(c.url) }));
    return { items: parseDomPosts(conAutor, "facebook", handle), diagnostics: { articulosEncontrados: crudos.length } };
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
export async function scrapeX(handle: string, context: BrowserContext): Promise<SocialPost[]> {
  return withBrowserContext("x", handle, context, async (page) => {
    await page.goto(`https://x.com/${handle}`, { waitUntil: "networkidle", timeout: 30_000 });
    const crudos = await collectDomPosts(page);
    const conAutor: RawDomPost[] = crudos.map((c) => ({ ...c, autor: deriveAuthorFromPermalink(c.url) }));
    return { items: parseDomPosts(conAutor, "x", handle), diagnostics: { articulosEncontrados: crudos.length } };
  });
}
