import { chromium, type Page } from "playwright";
import type { EntityConfig } from "./research-competencia-entities.js";

/**
 * Meta Ad Library (Facebook/Instagram) — fuente de publicidad COMPLEMENTARIA a
 * research-competencia-ads.ts (Google Ads Transparency). Se agregó el 2026-09-05 tras confirmar
 * en vivo que el scraping orgánico de Facebook (research-competencia-scrapers.ts) queda bloqueado
 * por ofuscación de texto del propio Facebook (caracteres reordenados + joiners invisibles en el
 * feed de perfil) — la Ad Library, en cambio, es pública, sin login, y SIN esa ofuscación
 * (verificado con Chromium headless FRESCO, sin la sesión logueada de research-competencia-browser.ts:
 * no hace falta login para "Todos los anuncios").
 *
 * A diferencia del RPC no oficial de Google, esto lee el DOM ya renderizado — la Ad Library es una
 * SPA de React sin un endpoint JSON público conocido, así que hace falta un browser real (headless
 * alcanza). `locale:"es"` fijo en el contexto: todo el parseo de acá depende de literales en
 * español ("Identificador de la biblioteca", "En circulación desde el ...") — sin fijarlo, el
 * locale del proceso que corre el cron decide el idioma servido y el parser se rompe en silencio.
 *
 * Búsqueda por PALABRA CLAVE (`q=`), no por ID de anunciante como Google — Meta no expone un ID de
 * anunciante buscable sin abrir cada página a mano. Verificado en vivo (2026-09-05): buscar
 * "altoke" también devolvió anuncios de una cuenta sin relación (Tigo Bolivia), y buscar "takenos"/
 * "meru"/"peso app bolivia" devolvió puro ruido (negocios sin relación) — la Ad Library no filtra
 * por coincidencia real de anunciante. Por eso `entity.ads.meta` cumple DOBLE función: términos de
 * búsqueda Y allowlist de nombres de página aceptados (`advertiserNameMatches` más abajo) — un
 * creativo cuyo anunciante no aparece en esa lista se descarta, mismo criterio fail-closed que
 * `handlesMatch` en research-competencia-scrapers.ts (mismo riesgo: atribuir a una entidad un
 * anuncio ajeno).
 *
 * Solo `active_status=active`: no hay forma simple de distinguir en el listado "hasta cuándo
 * circuló" un anuncio ya detenido (la Ad Library usa otra redacción para esos, no confirmada en
 * vivo) — limitación aceptada a propósito, mismo espíritu que el riesgo de rate-limit sin mitigar
 * de Google Ads: cubre la pregunta que más importa (qué está corriendo AHORA / qué es nuevo), no
 * el historial completo de campañas detenidas dentro de la ventana.
 */

const ADS_LIBRARY_BASE = "https://www.facebook.com/ads/library/";
const COUNTRY_BOLIVIA = "BO";
const PAGE_SETTLE_MS = 4_000;

const MAX_TOTAL_CHARS = 8_000; // mismo presupuesto que research-competencia-ads.ts
const MAX_FIELD_CHARS = 200;
const MAX_COPY_CHARS = 400; // el copy real del anuncio es el valor agregado sobre Google (que no lo tiene)

/** Mismo criterio que MIN_DOM_IMAGE_DIMENSION en research-competencia-scrapers.ts: filtra el
 * avatar de la página (60x60) para no confundirlo con la imagen real del creativo. */
const MIN_DOM_IMAGE_DIMENSION = 200;

export interface MetaAdCreative {
  libraryId: string;
  advertiserName: string;
  /** ISO (YYYY-MM-DD) en hora Bolivia — fecha en que arrancó a circular; null si no parseó. */
  desde: string | null;
  /** Hostname del destino del anuncio (decodificado del link `l.facebook.com/l.php?u=...`). */
  dominio: string | null;
  imagenUrl: string | null;
  /** Texto real del anuncio — a diferencia de Google Ads, acá SÍ está disponible. */
  copy: string;
  url: string;
}

const META_MESES: Record<string, string> = {
  ene: "01", feb: "02", mar: "03", abr: "04", may: "05", jun: "06",
  jul: "07", ago: "08", sep: "09", oct: "10", nov: "11", dic: "12",
};

// Formato observado en vivo: "4 ago 2026", "19 ago 2026" — día, mes abreviado en español sin
// punto, año. Sin period ni hora: la Ad Library solo da fecha calendario, no un instante.
const META_FECHA_RE = /^(\d{1,2}) ([a-záéíóúñ]{3})\.? (\d{4})$/i;

export function parseMetaFecha(texto: string): string | null {
  const m = META_FECHA_RE.exec(texto.trim());
  if (!m) return null;
  const mes = META_MESES[m[2].toLowerCase()];
  if (!mes) return null;
  return `${m[3]}-${mes}-${m[1].padStart(2, "0")}`;
}

/**
 * Extrae el copy real del anuncio del `textContent` completo de la tarjeta — la Ad Library no
 * separa el cuerpo del anuncio del resto de la metadata en ningún selector estable, así que se
 * recorta por los literales fijos que lo rodean: arranca después de `{advertiserName}Publicidad`
 * (fin del bloque de metadata + label "Publicidad") y termina antes de la ÚLTIMA aparición de
 * `{advertiserName}Más información` (la tarjeta de preview del destino, al pie). Verificado contra
 * un anuncio real completo (Tigo Bolivia, 2026-09-05) — función pura, testeada con ese fixture.
 */
export function extractMetaAdCopy(fullText: string, advertiserName: string): string {
  const marcaInicio = `${advertiserName}Publicidad`;
  const idxInicio = fullText.lastIndexOf(marcaInicio);
  let cuerpo = idxInicio >= 0 ? fullText.slice(idxInicio + marcaInicio.length) : fullText;
  const marcaFin = `${advertiserName}Más información`;
  const idxFin = cuerpo.lastIndexOf(marcaFin);
  if (idxFin >= 0) cuerpo = cuerpo.slice(0, idxFin);
  return cuerpo.trim();
}

/** Compara case-insensitive, sin asumir normalización de acentos — los nombres en `allowlist` se
 * cargan a mano en research-competencia-entities.ts ya con la tilde real verificada en vivo. */
function advertiserNameMatches(nombre: string, allowlist: string[]): boolean {
  const norm = nombre.trim().toLowerCase();
  return allowlist.some((a) => a.trim().toLowerCase() === norm);
}

function extraerDominioDestino(hrefCrudo: string | null): string | null {
  if (!hrefCrudo) return null;
  try {
    const destino = new URL(hrefCrudo).searchParams.get("u");
    return destino ? new URL(destino).hostname : null;
  } catch {
    return null;
  }
}

/** Forma cruda tal como la extrae `collectMetaAdCards` del DOM — parseo real en `parseMetaAdCards` (Node, testeable). */
export interface RawMetaAdCard {
  libraryId: string | null;
  advertiserName: string | null;
  /** Texto crudo "En circulación desde el ..." — se parsea a ISO en Node vía `parseMetaFecha`. */
  circulacionTexto: string | null;
  /** href crudo del link `l.facebook.com/l.php?u=...` — se decodifica en Node. */
  destinoHrefCruda: string | null;
  imagenUrl: string | null;
  fullText: string;
}

export function parseMetaAdCards(crudos: RawMetaAdCard[], entity: EntityConfig): MetaAdCreative[] {
  const allowlist = entity.ads?.meta ?? [];
  const out: MetaAdCreative[] = [];
  for (const c of crudos) {
    if (!c.libraryId || !c.advertiserName) continue;
    if (!advertiserNameMatches(c.advertiserName, allowlist)) continue;
    out.push({
      libraryId: c.libraryId,
      advertiserName: c.advertiserName,
      desde: c.circulacionTexto ? parseMetaFecha(c.circulacionTexto) : null,
      dominio: extraerDominioDestino(c.destinoHrefCruda),
      imagenUrl: c.imagenUrl,
      copy: extractMetaAdCopy(c.fullText, c.advertiserName),
      url: `${ADS_LIBRARY_BASE}?id=${c.libraryId}`,
    });
  }
  return out;
}

function sanitizeField(s: string, max = MAX_FIELD_CHARS): string {
  const oneLine = s.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Todo resultado viene de `active_status=active` — por construcción, TODOS están vivos ahora
 * mismo; "nuevo" acá significa que además arrancó dentro de la ventana (mismo criterio que
 * `esNuevo` en research-competencia-ads.ts, sin el complemento de `ultimaVez` que Meta no expone). */
export function formatMetaAdsText(ads: MetaAdCreative[], timeframeDias: number, ahora = new Date()): string {
  if (ads.length === 0) return "";
  const desdeCorte = new Date(ahora.getTime() - timeframeDias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const lineas = ads.map((a) => {
    const partes = [
      `[meta-ads · ${sanitizeField(a.advertiserName)}${a.dominio ? ` · ${sanitizeField(a.dominio, 80)}` : ""}] ${a.url}`,
      `Copy: ${sanitizeField(a.copy, MAX_COPY_CHARS) || "(sin texto — probablemente un anuncio de solo imagen/video)"}`,
      `En circulación desde: ${a.desde ?? "?"}`,
    ];
    if (a.desde && a.desde >= desdeCorte) partes.push("CAMPAÑA NUEVA en esta ventana");
    return partes.join(" · ");
  });
  const texto = lineas.join("\n");
  return texto.length > MAX_TOTAL_CHARS
    ? `${texto.slice(0, MAX_TOTAL_CHARS)}\n[...truncado — se alcanzó el límite de ${MAX_TOTAL_CHARS} caracteres]`
    : texto;
}

// Ambiente mínimo SOLO para el body de page.evaluate() — mismo motivo y mismo patrón que
// `DomElement` en research-competencia-scrapers.ts (evitar agregar "DOM" al lib del tsconfig). No
// se reusa esa interfaz: acá hace falta `children`/`parentElement` para subir del nodo de texto al
// contenedor de la tarjeta, que scrapers.ts no necesita.
interface MetaDomElement {
  querySelector(selector: string): MetaDomElement | null;
  querySelectorAll(selector: string): ArrayLike<MetaDomElement>;
  getAttribute(name: string): string | null;
  textContent: string | null;
  children: { length: number };
  parentElement: MetaDomElement | null;
  naturalWidth?: number;
  naturalHeight?: number;
}
declare const document: {
  querySelectorAll(selector: string): ArrayLike<MetaDomElement>;
};

/**
 * Extrae del DOM ya renderizado una tarjeta cruda por anuncio. Corre dentro de `page.evaluate`
 * (contexto del browser). Estrategia de límite de tarjeta verificada en vivo (2026-09-05): subir
 * desde el nodo de texto "Identificador de la biblioteca" hasta el primer ancestro que tenga a la
 * vez una `<img>` Y un link `http` — ese es el contenedor mínimo que engloba metadata + creativo
 * completo (confirmado con 2 tarjetas reales, misma profundidad en ambas). No hay ningún `role`
 * ARIA estable para esto, a diferencia de lo que se esperaba de Facebook/X en
 * research-competencia-scrapers.ts.
 */
function collectMetaAdCards(page: Page): Promise<RawMetaAdCard[]> {
  return page.evaluate((minDim) => {
    const idLeaves = Array.from(document.querySelectorAll("*")).filter(
      (el) => (el.textContent ?? "").includes("Identificador de la biblioteca") && el.children.length === 0
    );
    const cards = new Set<MetaDomElement>();
    for (const leaf of idLeaves) {
      let el: MetaDomElement | null = leaf;
      for (let i = 0; i < 10 && el; i++) {
        if (el.querySelector("img") && el.querySelector('a[href^="http"]')) break;
        el = el.parentElement;
      }
      if (el) cards.add(el);
    }
    const out: RawMetaAdCard[] = [];
    for (const card of cards) {
      const fullText = (card.textContent ?? "").replace(/​/g, "").trim();
      const idMatch = /Identificador de la biblioteca: (\d+)/.exec(fullText);
      const circMatch = /En circulación desde el (.+?)Plataformas/.exec(fullText);
      const pageLink = card.querySelector('a[href^="https://www.facebook.com/"]');
      const destLink = card.querySelector('a[href*="l.facebook.com/l.php"]');
      let imagenUrl: string | null = null;
      for (const img of Array.from(card.querySelectorAll("img"))) {
        if ((img.naturalWidth ?? 0) >= minDim && (img.naturalHeight ?? 0) >= minDim) {
          imagenUrl = img.getAttribute("src");
          break;
        }
      }
      out.push({
        libraryId: idMatch ? idMatch[1] : null,
        advertiserName: pageLink?.textContent?.trim() ?? null,
        circulacionTexto: circMatch ? circMatch[1].trim() : null,
        destinoHrefCruda: destLink?.getAttribute("href") ?? null,
        imagenUrl,
        fullText,
      });
    }
    return out;
  }, MIN_DOM_IMAGE_DIMENSION);
}

export type MetaAdsFetcher = (query: string) => Promise<RawMetaAdCard[]>;

/**
 * Consulta real: un browser headless FRESCO (no la sesión logueada compartida de
 * research-competencia-browser.ts, no hace falta) por cada término de búsqueda. Fail-soft completo
 * — cualquier falla (Chromium no instalado, timeout, cambio de layout) devuelve `[]` y loguea, sin
 * tirar: este bloque es complementario, igual que research-competencia-ads.ts.
 */
async function fetchMetaAdsQueryReal(query: string): Promise<RawMetaAdCard[]> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: "es" });
    const page = await context.newPage();
    const url = `${ADS_LIBRARY_BASE}?active_status=active&ad_type=all&country=${COUNTRY_BOLIVIA}&q=${encodeURIComponent(query)}&search_type=keyword_unordered`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(PAGE_SETTLE_MS);
    return await collectMetaAdCards(page);
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_meta_ads_error", query, err: String(err) }));
    return [];
  } finally {
    await browser?.close().catch(() => {});
  }
}

export interface FetchMetaAdsDeps {
  /** Inyectable para testear sin red/browser. Default: Chromium headless real. */
  fetchQuery?: MetaAdsFetcher;
  ahora?: Date;
}

export interface FetchMetaAdsResult {
  texto: string | null;
  /** Creativos ya deduplicados por `libraryId` — mismo dato que arma `texto`, expuesto aparte para
   * `computeAdsKpis` (research-competencia-ads.ts) sin repetir el fetch de red/browser. */
  creativos: MetaAdCreative[];
}

/**
 * Bloque de texto de Meta Ads para una entidad, más los creativos crudos — mismo contrato que
 * `fetchAdsText` (Google): `texto` es null si la entidad no declara `ads.meta` o si no se recuperó
 * ningún anuncio verificado; `creativos` siempre es un array. Dedupea por `libraryId` entre los
 * distintos términos de búsqueda de la misma entidad (ej. "Banco Ganadero" y "YOLO pago" pueden
 * traer el mismo anuncio si ambas cuentas lo republican).
 */
export async function fetchMetaAdsText(
  entity: EntityConfig,
  timeframeDias: number,
  deps: FetchMetaAdsDeps = {},
): Promise<FetchMetaAdsResult> {
  const queries = entity.ads?.meta ?? [];
  if (queries.length === 0) return { texto: null, creativos: [] };

  const fetchQuery = deps.fetchQuery ?? fetchMetaAdsQueryReal;
  const ahora = deps.ahora ?? new Date();

  const todos: MetaAdCreative[] = [];
  const vistos = new Set<string>();
  for (const query of queries) {
    const crudos = await fetchQuery(query);
    for (const ad of parseMetaAdCards(crudos, entity)) {
      if (vistos.has(ad.libraryId)) continue;
      vistos.add(ad.libraryId);
      todos.push(ad);
    }
  }
  return { texto: formatMetaAdsText(todos, timeframeDias, ahora) || null, creativos: todos };
}
