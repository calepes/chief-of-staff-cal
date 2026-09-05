// tools/research-competencia-scrapers.ts — scrapers de Instagram/Facebook/X para el research de
// competencia (fase 2, redes sociales), vía Chrome real + Playwright. TikTok y Facebook YA NO
// viven acá — Facebook se movió a Apify (research-competencia-apify.ts, 2026-09-05: el feed de
// Facebook está ofuscado a nivel DOM para scraping directo) y TikTok también (mismo archivo,
// 2026-09-05: el JSON embebido que leía `extractTikTokNodes` dejó de traer el `itemList` de
// videos en el HTML inicial). Acá queda Instagram (grid DOM, `parseInstagramGridItems`) y X
// (DOM, `collectDomPosts`/`parseDomPosts`, sin alternativa a Apify todavía) — más
// `deriveAuthorFromPermalink`/`RawDomPost`, compartidos por Facebook (vía Apify, no vía DOM) NO,
// solo por X ahora. `handlesMatch`/`sortPostsByFechaDesc`/`isoDateFromUnix` se exportan para que
// research-competencia-apify.ts los reuse — mismo criterio de validación de autoría y de orden que
// el resto del archivo, sin duplicar la lógica.
//
// Chrome REAL vía CDP (research-competencia-browser.ts), NO `chromium.launch()` propio — Chromium
// headless de Playwright se topó con detección de bot en las 4 plataformas (verificado en vivo
// 2026-09-03: con cookie de sesión válida igual devolvía 0 posts). El `BrowserContext` ya viene
// ABIERTO desde el orquestador (una sola sesión de Chrome compartida por las 6 entidades, no una
// por handle) — acá solo se abre/cierra la `Page` de cada llamada. El LLM no tiene tool de
// navegación genérica — esto es una tool de alto nivel, el detalle de Playwright queda puertas
// adentro.

import { chromium, type BrowserContext, type Page } from "playwright";
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
 *
 * Exportada para que research-competencia-apify.ts (Facebook/TikTok) la reuse — mismo criterio de
 * orden, sin duplicar la lógica.
 */
export function sortPostsByFechaDesc(posts: SocialPost[]): SocialPost[] {
  const conFecha = posts.filter((p) => p.fecha !== null);
  const sinFecha = posts.filter((p) => p.fecha === null);
  conFecha.sort((a, b) => (b.fecha as string).localeCompare(a.fecha as string));
  return [...conFecha, ...sinFecha];
}

// ⚠️ GRAVE, encontrado en review (aplicaba originalmente a Instagram/TikTok vía JSON embebido, y
// sigue aplicando a Facebook/X vía DOM): el timeline de un perfil no trae SOLO los posts propios
// de la cuenta — también puede traer contenido recomendado/relacionado o compartido de otra
// cuenta, con exactamente la misma forma. Sin validar de quién es el post, el resultado es una URL
// bien formada pero FALSA, citada después como fuente verificable en el battlecard de research de
// competencia. Por eso `parseDomPosts` (más abajo) exige que el post declare como autor al
// `handle` que se está scrapeando, comparando en minúsculas — un post sin ese campo, o con un
// autor distinto, se descarta aunque matchee la forma. Mismo criterio en
// research-competencia-apify.ts (Facebook/TikTok vía Apify), reusando `handlesMatch`.
//
// `handlesMatch` es el fondo común de toda esa validación: fail-closed ante `null`/`undefined`/
// cualquier tipo que no sea string, Y ante un `handle` vacío — sin ese segundo guard, un nodo con
// autor `""` matchearía contra un `handle` que también llegara vacío (bug señalado en la revisión
// de esta tarea, nunca disparado en producción porque el handle siempre lo pasa el orquestador,
// pero un guard barato de tener). Exportada para que research-competencia-apify.ts la reuse.
export function handlesMatch(valor: unknown, handle: string): boolean {
  return typeof valor === "string" && valor !== "" && handle !== "" && valor.toLowerCase() === handle.toLowerCase();
}

// Ambiente mínimo SOLO para el body de page.evaluate() (corre en el navegador, no en Node) —
// mismo motivo que design-capture.ts: a propósito no se agrega "DOM" al lib del tsconfig, que
// aplicaría a todo el paquete y podría chocar con los tipos de fetch/Response/Headers de Node.
// Necesario para `collectDomPosts`/`collectInstagramGridItems` recorrer nodos genéricos
// (`article`/`img`/`video`/`time`/`a`).
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
  /** Usado por `collectInstagramFollowerTitle` para caminar hacia arriba desde el `span[title]`. */
  parentElement: DomElement | null;
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
 * Extrae el atributo `title` del span de seguidores del header del perfil. Instagram expone ahí el
 * conteo EXACTO sin abreviar (ej. `title="13,794"`) aunque el texto visible muestre la versión
 * abreviada ("13.7K seguidores") — evita tener que parsear sufijos "K"/"mil" con la ambigüedad de
 * redondeo que eso implica. Verificado en vivo 2026-09-05 contra 4 cuentas reales (altoke.bo,
 * bancosol_bolivia, bancoganadero, yolopagoapp): en las 4 hay EXACTAMENTE un `span[title]` en toda
 * la página, y su ancestro directo (nivel 1) siempre contiene el texto "followers"/"seguidores" —
 * se camina hasta 8 niveles hacia arriba por robustez (mismo margen que otros walks de este
 * archivo), no porque haga falta en la práctica observada.
 */
function collectInstagramFollowerTitle(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (const span of Array.from(document.querySelectorAll("span[title]"))) {
      let el: DomElement | null = span;
      for (let i = 0; i <= 8 && el; i++) {
        if (/follower|seguidor/i.test(el.textContent ?? "")) return span.getAttribute("title");
        el = el.parentElement;
      }
    }
    return null;
  });
}

/** Convierte el `title` exacto ("13,794") a `number`. `null` si no hay dígitos — ni una cadena
 * vacía ni un `null` de origen deben leerse como "0 seguidores". */
export function parseInstagramFollowerTitle(raw: string | null): number | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

/**
 * Cuenta de seguidores del handle PRINCIPAL de Instagram de una entidad (Tarea B — seguidores
 * semanales). Navegación aparte de `scrapeInstagram` a propósito: son datos de naturaleza distinta
 * (un escalar por cuenta, no un post) y desacoplarlos evita que un cambio futuro en el grid de
 * posts arrastre el parseo de seguidores, a costa de una segunda carga de la misma página — costo
 * aceptable frente al resto del pipeline (descargas de imagen/video por post, ver
 * research-competencia-social.ts). Reusa la sesión de Chrome COMPARTIDA (mismo motivo que
 * `scrapeInstagram`: Chromium headless propio es detectado como bot). Fail-soft: cualquier falla
 * devuelve `null` y loguea, nunca tira — un dato de tendencia perdido una semana no debe tumbar el
 * research de la entidad.
 */
export async function fetchInstagramFollowers(handle: string, context: BrowserContext): Promise<number | null> {
  let page: Page | undefined;
  try {
    page = await context.newPage();
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: "networkidle", timeout: 30_000 });
    const count = parseInstagramFollowerTitle(await collectInstagramFollowerTitle(page));
    if (count === null) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_followers_empty", platform: "instagram", handle }));
    }
    return count;
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_followers_error", platform: "instagram", handle, err: String(err) }));
    return null;
  } finally {
    await page?.close().catch(() => {});
  }
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
 * mover el parseo de Instagram (`parseInstagramGridItems`) fuera del closure del browser).
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

// Facebook y X nunca llegan a "networkidle" — las dos tienen actividad de red constante en
// segundo plano (chat, notificaciones en vivo, streams) que no para nunca, así que `page.goto`
// con `waitUntil:"networkidle"` siempre tira TimeoutError a los 30s, incluso con sesión real y
// válida. Verificado en vivo 2026-09-05 contra la cuenta real de Cal: con `domcontentloaded` la
// página carga perfecto (sesión logueada, contenido real, sin muro) — el comentario viejo de este
// archivo ("Facebook detecta automatización más agresivamente") era una teoría sin verificar,
// escrita antes de poder probar contra la plataforma real; el síntoma completo era el timeout de
// espera, no un bloqueo. `PAGE_SETTLE_MS` da tiempo a que el feed hidrate (React) después del
// `domcontentloaded` — sin esto, `collectDomPosts`/`collectFacebookFollowerText` corren sobre un
// DOM todavía vacío. Sigue en pie para X y para `fetchFacebookFollowers` (seguidores) aunque
// `scrapeFacebook` (posts orgánicos) se haya movido a Apify — ver research-competencia-apify.ts:
// el bloqueo real de `scrapeFacebook` NO era el timeout de carga, sino que Facebook ofusca el
// TEXTO del feed a nivel DOM (caracteres reordenados + joiners invisibles, ver el comentario
// grande de research-competencia-meta-ads.ts) — un problema de contenido, no de timing, que
// `PAGE_SETTLE_MS` nunca podía resolver.
const PAGE_SETTLE_MS = 2_000;

// Solo cubre el formato verificado en vivo 2026-09-05 contra 6 páginas reales (altoke.bo,
// BancoSolidarioBolivia, banco.economico, YoloPagoApp, bg.com.bo, getmeruapp) — TODAS devolvieron
// "{N} mil seguidores" con N un entero simple ("861 mil", "12 mil", "3 mil"...). Un conteo en
// millones, o por debajo de 1.000 sin el sufijo "mil", no se confirmó contra ninguna página real
// — `parseFacebookFollowerText` cubre esos sufijos de todos modos (mismo costo que no cubrirlos)
// pero sin la misma confianza; si `research_competencia_followers_empty` aparece seguido para una
// entidad puntual, revisar el formato real de esa página antes de asumir que el parser alcanza.
const FB_SEGUIDORES_RE = /^([\d]+(?:[.,]\d+)?)\s*(mil|millones|millón)?\s*seguidores/i;

export function parseFacebookFollowerText(texto: string): number | null {
  const m = FB_SEGUIDORES_RE.exec(texto.trim());
  if (!m) return null;
  const num = Number(m[1].replace(",", "."));
  if (!Number.isFinite(num)) return null;
  const suf = m[2]?.toLowerCase();
  if (suf === "mil") return Math.round(num * 1_000);
  if (suf === "millones" || suf === "millón") return Math.round(num * 1_000_000);
  return Math.round(num);
}

/** Busca el primer `<span>` cuyo texto empieza con un número seguido de "seguidores" — mismo
 * bloque que muestra "Me gusta" al lado, visto en las 6 páginas reales de la verificación. */
function collectFacebookFollowerText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (const span of Array.from(document.querySelectorAll("span"))) {
      const t = (span.textContent ?? "").trim();
      if (/^[\d.,]+\s*(mil|millones|millón)?\s*seguidores/i.test(t)) return t;
    }
    return null;
  });
}

/**
 * Cuenta de seguidores del handle PRINCIPAL de Facebook de una entidad (Tarea B). SIN login, con
 * un browser headless FRESCO (mismo patrón que `fetchMetaAdsQueryReal` en
 * research-competencia-meta-ads.ts) — no la sesión compartida de research-competencia-browser.ts.
 *
 * Verificado en vivo 2026-09-05 contra 6 páginas reales: el bloque de seguidores/"Me gusta" del
 * header del perfil NO tiene la ofuscación de texto que sí bloquea el feed de posts de Facebook
 * (`RawDomPost`/`collectDomPosts` más arriba, y el comentario grande sobre esto en
 * research-competencia-meta-ads.ts) — comparado `textContent` contra `innerText` del mismo nodo en
 * las 6 páginas y coinciden exacto, cuando la ofuscación real (caracteres reordenados + joiners
 * invisibles) los haría divergir. Es un bloque de metadata separado del texto libre del feed, no
 * sujeto al mismo tratamiento — confirmado, no asumido.
 */
export async function fetchFacebookFollowers(handle: string): Promise<number | null> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: "es" });
    const page = await context.newPage();
    await page.goto(`https://www.facebook.com/${handle}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(PAGE_SETTLE_MS);
    const texto = await collectFacebookFollowerText(page);
    const count = texto ? parseFacebookFollowerText(texto) : null;
    if (count === null) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_followers_empty", platform: "facebook", handle }));
    }
    return count;
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_followers_error", platform: "facebook", handle, err: String(err) }));
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * Scrapea el perfil público de X de `handle` y devuelve sus posts recientes.
 *
 * Ver el comentario de `PAGE_SETTLE_MS`: un timeout acá no es necesariamente bloqueo de
 * plataforma, X tampoco llega nunca a "networkidle" real. Sin alternativa vía Apify (a diferencia
 * de Facebook/TikTok) — X sigue devolviendo 403 al scraping directo y no se evaluó un actor de
 * Apify para X en esta pasada.
 */
export async function scrapeX(handle: string, context: BrowserContext): Promise<SocialPost[]> {
  return withBrowserContext("x", handle, context, async (page) => {
    await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(PAGE_SETTLE_MS);
    const crudos = await collectDomPosts(page);
    const conAutor: RawDomPost[] = crudos.map((c) => ({ ...c, autor: deriveAuthorFromPermalink(c.url) }));
    return { items: parseDomPosts(conAutor, "x", handle), diagnostics: { articulosEncontrados: crudos.length } };
  });
}
