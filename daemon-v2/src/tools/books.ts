import { callNtn, NTN_BIN } from "../shared/ntn.js";
import { addPendingRelation, consumePendingRelation } from "./book-relation-pending.js";
import { nowInLaPaz } from "../journal-capture.js";
export const BOOKS_DB    = "b9222a76e9404e229091b1c0e26c29dd";
export const BOOKS_DS    = "901dba51-1d00-4e3f-95b1-17ba628a0915";
export const TRACKING_DB = "70b1e190-8547-4813-b918-43ce59071d3e";
export const TRACKING_DS = "908f96f0-f573-4945-8da8-172641151265";
// Relaciones: Author apunta a la DB genérica de Personas (misma que Meetings/Tareas/Journal).
export const AUTHOR_DB    = "57e58779c09c4dea8a61023fb6c9a0a0";
export const AUTHOR_DS    = "d9b5e172-edd2-4f08-bf2e-9a2f5f39c92f";
export const TAGS_DB      = "39fdd6fdabe54971ab1e0ecc0e8528d7";
export const TAGS_DS      = "584cde40-02dc-400e-94df-cf2c56b582fc";
export const BIGTHEMES_DB = "0235e414576a45319ed6535867f7172a";
export const BIGTHEMES_DS = "e1645fda-bbb5-4dfd-87fd-76d48011bb21";

export type EstadoLibro =
  | "Not started" | "Goal" | "Reading" | "Read" | "Focus"
  | "Stand-By" | "Reference" | "wish list" | "Por comprar";
export type RatingLibro = "🥱" | "😶" | "😊" | "😍";

export interface BookResult {
  pageId: string;
  url: string;
  name: string;
  estado?: string;
  rating?: string;
  avanceTracking?: number;
  totalPaginas?: number;
  startDate?: string;
  isbn?: string;
}

interface BookMetadata {
  coverUrl: string | null;
  totalPaginas?: number;
}

async function searchBookMetadata(
  isbn?: string,
  title?: string,
  author?: string
): Promise<BookMetadata> {
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  let totalPaginas: number | undefined;

  // Primary: Google Books API (higher quality, reliable)
  const gbQuery = isbn
    ? `isbn:${isbn}`
    : title
    ? `intitle:${title}${author ? `+inauthor:${author}` : ""}`
    : null;

  if (gbQuery && apiKey) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(gbQuery)}&maxResults=3&key=${apiKey}`,
        { signal: AbortSignal.timeout(8_000) }
      );
      const data = (await res.json()) as {
        items?: Array<{ volumeInfo: { pageCount?: number; imageLinks?: { thumbnail?: string } } }>;
      };
      const volumeInfo = data?.items?.[0]?.volumeInfo;
      const thumb = volumeInfo?.imageLinks?.thumbnail;
      const pageCount = volumeInfo?.pageCount;
      if (typeof pageCount === "number" && Number.isInteger(pageCount) && pageCount > 0) {
        totalPaginas = pageCount;
      }
      if (thumb) {
        // zoom=6 = large image; strip curl effect. Replace https fallback (Notion blocks HTTP).
        return {
          coverUrl: thumb.replace("zoom=1", "zoom=6").replace("&edge=curl", "").replace("http://", "https://"),
          totalPaginas,
        };
      }
    } catch {
      // fall through to Open Library
    }
  }

  // Fallback 1: Open Library by ISBN (?default=false devuelve 404 si no hay cover real)
  if (isbn) {
    const url = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
    try {
      const res = await fetch(`${url}?default=false`, {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return { coverUrl: url, totalPaginas };
    } catch {
      // fall through to Goodreads
    }
  }

  // Fallback 2: Goodreads search — usa Amazon CDN, alta calidad
  const grQuery = isbn ?? title;
  if (grQuery) {
    try {
      const grRes = await fetch(
        `https://www.goodreads.com/search?q=${encodeURIComponent(grQuery)}`,
        {
          signal: AbortSignal.timeout(10_000),
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          redirect: "follow",
        }
      );
      const html = await grRes.text();
      const match = html.match(
        /https?:\/\/[^"'\s]*compressed\.photo\.goodreads\.com\/books\/\d+i\/\d+\.[a-z]+/i
      );
      if (match) return { coverUrl: match[0].replace(/^http:/, "https:"), totalPaginas };
    } catch {
      // no cover found
    }
  }

  return { coverUrl: null, totalPaginas };
}

export async function searchCover(
  isbn?: string,
  title?: string,
  author?: string
): Promise<string | null> {
  return (await searchBookMetadata(isbn, title, author)).coverUrl;
}

// ── Private helpers ──────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, unknown>;
}

function pageToBookResult(page: NotionPage): BookResult {
  const props = page.properties as Record<string, {
    status?: { name: string };
    select?: { name: string };
    title?: Array<{ plain_text: string }>;
    rich_text?: Array<{ plain_text: string }>;
    number?: number;
    date?: { start: string };
    rollup?: { number?: number };
  }>;
  return {
    pageId: page.id,
    url: page.url,
    name: props["Name"]?.title?.[0]?.plain_text ?? "(sin título)",
    estado: props["Estado"]?.status?.name,
    rating: props["Rating"]?.select?.name,
    avanceTracking: props["Avance Tracking"]?.rollup?.number ?? undefined,
    totalPaginas: props["Total Páginas"]?.number ?? undefined,
    startDate: props["Start Date"]?.date?.start,
    isbn: props["ISBN"]?.rich_text?.[0]?.plain_text,
  };
}

function getExistingRelationIds(page: NotionPage, prop: string): string[] {
  const props = page.properties as Record<string, { relation?: Array<{ id: string }> }>;
  return (props[prop]?.relation ?? []).map((r) => r.id);
}

// ── Relaciones (Author/Tags/Big Themes) ───────────────────────────────────────

export interface RelationMatch { pageId: string; name: string }
export type RelationResolution =
  | { status: "found"; pageId: string; name: string }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: RelationMatch[] };

function resolveRelation(dsId: string, titleProp: string, name: string): RelationResolution {
  const res = callNtn(`v1/data_sources/${dsId}/query`, {
    method: "POST",
    body: { filter: { property: titleProp, title: { contains: name } }, page_size: 20 },
  });
  if (!res.ok) return { status: "not_found" };

  const data = res.data as { results?: NotionPage[] };
  const results = data.results ?? [];
  const matches: RelationMatch[] = results.map((p) => {
    const props = p.properties as Record<string, { title?: Array<{ plain_text: string }> }>;
    return { pageId: p.id, name: props[titleProp]?.title?.[0]?.plain_text ?? "(sin título)" };
  });

  if (matches.length === 0) return { status: "not_found" };

  const q = name.trim().toLowerCase();
  const exact = matches.filter((m) => m.name.trim().toLowerCase() === q);
  if (exact.length === 1) return { status: "found", pageId: exact[0].pageId, name: exact[0].name };

  return { status: "ambiguous", candidates: (exact.length > 1 ? exact : matches).slice(0, 5) };
}

export type RelationTipo = "author" | "tag" | "bigTheme";

interface RelationConfig { db: string; ds: string; titleProp: string; bookProp: string; label: string }

const RELATION_CONFIG: Record<RelationTipo, RelationConfig> = {
  author:   { db: AUTHOR_DB,    ds: AUTHOR_DS,    titleProp: "Name",  bookProp: "Author",     label: "Autor" },
  tag:      { db: TAGS_DB,      ds: TAGS_DS,      titleProp: "Topic", bookProp: "Tags",       label: "Tag" },
  bigTheme: { db: BIGTHEMES_DB, ds: BIGTHEMES_DS, titleProp: "Name",  bookProp: "Big Themes", label: "Big Theme" },
};

interface UnresolvedRelation { tipo: RelationTipo; nombre: string; noteFragment: string }

/** Resuelve un nombre a un pageId, o arma la nota + el registro pendiente estructurado (SIN el
 * pageId del libro — el caller lo completa una vez que lo tiene, para addBook y updateBook por
 * igual, y es quien decide si registrarlo en book-relation-pending). */
function resolveOrNote(tipo: RelationTipo, nombre: string): { pageId?: string; pending?: UnresolvedRelation } {
  const cfg = RELATION_CONFIG[tipo];
  const label = cfg.label.toLowerCase();
  const r = resolveRelation(cfg.ds, cfg.titleProp, nombre);
  if (r.status === "found") return { pageId: r.pageId };
  if (r.status === "not_found") {
    return { pending: { tipo, nombre, noteFragment: `⚠️ No encontré "<b>${esc(nombre)}</b>" como ${label}. Decime si lo creo.` } };
  }
  return { pending: { tipo, nombre, noteFragment: `⚠️ "${esc(nombre)}" es ambiguo como ${label} — encontré: ${r.candidates.map((c) => esc(c.name)).join(", ")}.` } };
}

function withBookPageId(fragments: string[], pageId: string): string {
  if (!fragments.length) return "";
  return `\n\n${fragments.join("\n")}\n<i>(pageId del libro: ${pageId})</i>`;
}

export interface ConfirmCreateRelationParams {
  tipo: RelationTipo;
  nombre: string;
  bookPageId: string;
}

export async function confirmCreateBookRelation(params: ConfirmCreateRelationParams): Promise<string> {
  const { tipo, nombre, bookPageId } = params;
  const cfg = RELATION_CONFIG[tipo];

  // Gate técnico real: solo ejecuta si addBook/updateBook registró ESTA propuesta exacta
  // (mismo libro + tipo + nombre) — nunca confiar solo en que el modelo diga "Cal confirmó".
  if (!consumePendingRelation(bookPageId, tipo, nombre)) {
    return `❌ No hay ninguna propuesta pendiente para "${esc(nombre)}" como ${cfg.label.toLowerCase()} en este libro (o ya venció) — no lo creo. Probá primero con addBook/updateBook.`;
  }

  const createRes = callNtn("v1/pages", {
    method: "POST",
    body: {
      parent: { database_id: cfg.db },
      properties: { [cfg.titleProp]: { title: [{ text: { content: nombre } }] } },
    },
  });
  if (!createRes.ok) return `❌ Error al crear "${esc(nombre)}": ${createRes.error}`;
  const newPage = createRes.data as { id: string };

  const pageRes = callNtn(`v1/pages/${bookPageId}`);
  if (!pageRes.ok) {
    return `⚠️ ${cfg.label} "${esc(nombre)}" creado, pero no pude leer el libro para vincularlo (reintentá el vínculo, no perdiste la página creada).`;
  }
  const existingIds = getExistingRelationIds(pageRes.data as NotionPage, cfg.bookProp);
  const merged = Array.from(new Set([...existingIds, newPage.id]));

  const linkRes = callNtn(`v1/pages/${bookPageId}`, {
    method: "PATCH",
    body: { properties: { [cfg.bookProp]: { relation: merged.map((id) => ({ id })) } } },
  });
  if (!linkRes.ok) return `❌ ${cfg.label} "${esc(nombre)}" creado, pero no pude vincularlo al libro: ${linkRes.error}`;

  return `✅ ${cfg.label} "${esc(nombre)}" creado y vinculado al libro.`;
}

// ── searchBooks ──────────────────────────────────────────────────────────────

export interface SearchBooksParams {
  query?: string;
  estado?: EstadoLibro;
  rating?: RatingLibro;
  planningToRead?: string;
  isbn?: string;
  totalPaginasMin?: number;
  totalPaginasMax?: number;
  startDateFrom?: string;
  startDateTo?: string;
  finishDateFrom?: string;
  finishDateTo?: string;
  avanceTrackingMin?: number; // 0.0–1.0
  avanceTrackingMax?: number;
  ultimaLecturaFrom?: string;
  ultimaLecturaTo?: string;
  author?: string;
  tag?: string;
  bigTheme?: string;
}

function dateRange(from?: string, to?: string): { on_or_after?: string; on_or_before?: string } | null {
  if (!from && !to) return null;
  const r: { on_or_after?: string; on_or_before?: string } = {};
  if (from) r.on_or_after = from;
  if (to) r.on_or_before = to;
  return r;
}

function numberRange(min?: number, max?: number): { greater_than_or_equal_to?: number; less_than_or_equal_to?: number } | null {
  if (min == null && max == null) return null;
  const r: { greater_than_or_equal_to?: number; less_than_or_equal_to?: number } = {};
  if (min != null) r.greater_than_or_equal_to = min;
  if (max != null) r.less_than_or_equal_to = max;
  return r;
}

export async function searchBooks(params: SearchBooksParams = {}): Promise<string> {
  const {
    query, estado, rating, planningToRead, isbn,
    totalPaginasMin, totalPaginasMax, startDateFrom, startDateTo,
    finishDateFrom, finishDateTo, avanceTrackingMin, avanceTrackingMax,
    ultimaLecturaFrom, ultimaLecturaTo, author, tag, bigTheme,
  } = params;

  const conditions: Record<string, unknown>[] = [];
  if (estado)         conditions.push({ property: "Estado", status: { equals: estado } });
  if (rating)         conditions.push({ property: "Rating", select: { equals: rating } });
  if (planningToRead) conditions.push({ property: "Planning to read", select: { equals: planningToRead } });
  if (isbn)           conditions.push({ property: "ISBN", rich_text: { contains: isbn } });

  const paginas = numberRange(totalPaginasMin, totalPaginasMax);
  if (paginas) conditions.push({ property: "Total Páginas", number: paginas });

  const startRange = dateRange(startDateFrom, startDateTo);
  if (startRange) conditions.push({ property: "Start Date", date: startRange });

  const finishRange = dateRange(finishDateFrom, finishDateTo);
  if (finishRange) conditions.push({ property: "Finish Date", date: finishRange });

  const avanceRange = numberRange(avanceTrackingMin, avanceTrackingMax);
  if (avanceRange) conditions.push({ property: "Avance Tracking", rollup: { number: avanceRange } });

  const ultimaRange = dateRange(ultimaLecturaFrom, ultimaLecturaTo);
  if (ultimaRange) conditions.push({ property: "Ultima lectura", rollup: { date: ultimaRange } });

  for (const [tipo, nombre, bookProp] of [
    ["author", author, "Author"],
    ["tag", tag, "Tags"],
    ["bigTheme", bigTheme, "Big Themes"],
  ] as const) {
    if (!nombre) continue;
    const cfg = RELATION_CONFIG[tipo];
    const r = resolveRelation(cfg.ds, cfg.titleProp, nombre);
    if (r.status === "found") {
      conditions.push({ property: bookProp, relation: { contains: r.pageId } });
    } else if (r.status === "not_found") {
      return `⚠️ No encontré "<b>${esc(nombre)}</b>" como ${cfg.label.toLowerCase()} — no hay filtro que aplicar.`;
    } else {
      return `⚠️ "${esc(nombre)}" es ambiguo como ${cfg.label.toLowerCase()} — encontré: ${r.candidates.map((c) => esc(c.name)).join(", ")}. ¿Cuál?`;
    }
  }

  const body: Record<string, unknown> = { page_size: 100 };
  if (conditions.length === 1) body.filter = conditions[0];
  else if (conditions.length > 1) body.filter = { and: conditions };

  const res = queryAllPages(BOOKS_DS, body);
  if (!res.ok) return `❌ Error al buscar libros: ${res.error}`;

  let books = res.results.map(pageToBookResult);

  if (query) {
    const q = query.toLowerCase();
    books = books.filter((b) => b.name.toLowerCase().includes(q));
  }

  if (books.length === 0) {
    return query
      ? `📚 No se encontraron libros que coincidan con "<b>${esc(query)}</b>"`
      : "📚 No hay libros que coincidan con esos filtros.";
  }

  const ESTADO_EMOJI: Record<string, string> = {
    Reading: "📖", Read: "✅", Goal: "🎯", Focus: "🔥",
    "Stand-By": "⏸️", Reference: "📎", "wish list": "💭",
    "Not started": "⬜", "Por comprar": "🛒",
  };

  const lines = books.map((b) => {
    const emoji = ESTADO_EMOJI[b.estado ?? ""] ?? "•";
    const rating = b.rating ? ` ${b.rating}` : "";
    const avance = b.avanceTracking != null ? ` · ${Math.round(b.avanceTracking * 100)}%` : "";
    const paginas = b.totalPaginas != null ? ` · ${b.totalPaginas} págs` : "";
    return `${emoji} <b>${esc(b.name)}</b>${rating}${avance}${paginas}\n   <a href="${b.url}">ver →</a>`;
  });

  const titulo = estado
    ? `📚 <b>${books.length} libro${books.length !== 1 ? "s" : ""} — ${estado}</b>`
    : `📚 <b>${books.length} libro${books.length !== 1 ? "s" : ""}</b>`;

  return `${titulo}\n\n${lines.join("\n\n")}`;
}

// ── addBook ──────────────────────────────────────────────────────────────────

export interface AddBookParams {
  name: string;
  subtitle?: string;
  isbn?: string;
  estado: EstadoLibro;
  planningToRead?: string;
  totalPaginas?: number;
  startDate?: string;
  finishDate?: string;
  url?: string;
  fetchCover?: boolean;
  author?: string;
  tags?: string[];
  bigThemes?: string[];
}

export async function addBook(params: AddBookParams): Promise<string> {
  const {
    name, subtitle, isbn, estado, planningToRead,
    totalPaginas, startDate, finishDate, url,
    fetchCover = true, author, tags, bigThemes,
  } = params;

  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: name } }] },
    Estado: { status: { name: estado } },
  };
  if (subtitle) properties["Subtitle"] = { rich_text: [{ text: { content: subtitle } }] };
  if (isbn)     properties["ISBN"]     = { rich_text: [{ text: { content: isbn } }] };
  if (planningToRead) properties["Planning to read"] = { select: { name: planningToRead } };
  if (totalPaginas)   properties["Total Páginas"]    = { number: totalPaginas };
  if (startDate)      properties["Start Date"]       = { date: { start: startDate } };
  if (finishDate)     properties["Finish Date"]      = { date: { start: finishDate } };
  if (url)            properties["URL"]              = { url };

  // Al crear no hay pageId todavía — el registro pendiente (para el gate de confirmCreateBookRelation)
  // se escribe DESPUÉS de crear, una vez que existe el pageId real del libro.
  const pending: UnresolvedRelation[] = [];
  if (author) {
    const r = resolveOrNote("author", author);
    if (r.pageId) properties["Author"] = { relation: [{ id: r.pageId }] };
    else if (r.pending) pending.push(r.pending);
  }
  const tagIds: string[] = [];
  for (const t of tags ?? []) {
    const r = resolveOrNote("tag", t);
    if (r.pageId) tagIds.push(r.pageId);
    else if (r.pending) pending.push(r.pending);
  }
  if (tagIds.length) properties["Tags"] = { relation: tagIds.map((id) => ({ id })) };
  const bigThemeIds: string[] = [];
  for (const bt of bigThemes ?? []) {
    const r = resolveOrNote("bigTheme", bt);
    if (r.pageId) bigThemeIds.push(r.pageId);
    else if (r.pending) pending.push(r.pending);
  }
  if (bigThemeIds.length) properties["Big Themes"] = { relation: bigThemeIds.map((id) => ({ id })) };

  const body: Record<string, unknown> = {
    parent: { database_id: BOOKS_DB },
    properties,
  };

  let coverUrl: string | null = null;
  let resolvedTotalPaginas = totalPaginas;
  if (fetchCover) {
    const metadata = await searchBookMetadata(isbn, name, author);
    coverUrl = metadata.coverUrl;
    resolvedTotalPaginas ??= metadata.totalPaginas;
    if (resolvedTotalPaginas) properties["Total Páginas"] = { number: resolvedTotalPaginas };
    if (coverUrl) {
      body.cover = { type: "external", external: { url: coverUrl } };
      body.icon  = { type: "external", external: { url: coverUrl } };
    }
  }

  const res = callNtn("v1/pages", { body });
  if (!res.ok) return `❌ Error al crear libro: ${res.error}`;

  const page = res.data as { id: string; url: string };
  const coverLine = coverUrl ? "\n🖼️ Cover: cargado automáticamente" : "";
  const paginasLine = resolvedTotalPaginas ? ` · ${resolvedTotalPaginas} págs` : "";

  for (const p of pending) addPendingRelation(page.id, p.tipo, p.nombre);

  return (
    `✅ <b>${esc(name)}</b> creado en Notion\n` +
    `📖 ${estado}${paginasLine}${planningToRead ? ` · ${planningToRead}` : ""}` +
    coverLine +
    `\n<a href="${page.url}">Ver en Notion →</a>` +
    withBookPageId(pending.map((p) => p.noteFragment), page.id)
  );
}

// ── updateBook ───────────────────────────────────────────────────────────────

export interface UpdateBookParams {
  pageId: string;
  estado?: EstadoLibro;
  rating?: RatingLibro;
  startDate?: string;
  finishDate?: string;
  totalPaginas?: number;
  isbn?: string;
  subtitle?: string;
  url?: string;
  planningToRead?: string;
  /** Vacía el campo "Planning to read" (Notion no distingue "no cambiar" de "vaciar" con un
   * simple string vacío en un select — hace falta un flag explícito). Ignora `planningToRead`
   * si ambos vienen juntos. */
  clearPlanningToRead?: boolean;
  author?: string;
  tags?: string[];
  bigThemes?: string[];
}

export async function updateBook(params: UpdateBookParams): Promise<string> {
  const { pageId, estado, rating, startDate, finishDate,
          totalPaginas, isbn, subtitle, url, planningToRead, clearPlanningToRead,
          author, tags, bigThemes } = params;

  const properties: Record<string, unknown> = {};
  if (estado)       properties["Estado"]            = { status: { name: estado } };
  if (rating)       properties["Rating"]            = { select: { name: rating } };
  if (startDate)    properties["Start Date"]        = { date: { start: startDate } };
  if (finishDate)   properties["Finish Date"]       = { date: { start: finishDate } };
  if (totalPaginas) properties["Total Páginas"]     = { number: totalPaginas };
  if (isbn)         properties["ISBN"]              = { rich_text: [{ text: { content: isbn } }] };
  if (subtitle)     properties["Subtitle"]          = { rich_text: [{ text: { content: subtitle } }] };
  if (url)          properties["URL"]               = { url };
  if (clearPlanningToRead) properties["Planning to read"] = { select: null };
  else if (planningToRead) properties["Planning to read"] = { select: { name: planningToRead } };

  // Author es single-value: "el autor es Y" REEMPLAZA (no mergea) — a diferencia de Tags/Big
  // Themes, que son legítimamente multi-valor y sí deben conservar lo existente. No necesita
  // leer el libro primero, así que corre independiente del bloque de merge de abajo.
  const pending: UnresolvedRelation[] = [];
  if (author) {
    const r = resolveOrNote("author", author);
    if (r.pageId) properties["Author"] = { relation: [{ id: r.pageId }] };
    else if (r.pending) pending.push(r.pending);
  }

  // Tags/Big Themes: mergear con lo ya existente para no perder los que ya tenía.
  const extraNotes: string[] = [];
  const needsExisting = Boolean(tags?.length) || Boolean(bigThemes?.length);
  let existingPage: NotionPage | null = null;
  let existingFetchFailed = false;
  if (needsExisting) {
    const pageRes = callNtn(`v1/pages/${pageId}`);
    if (pageRes.ok) {
      existingPage = pageRes.data as NotionPage;
    } else {
      // No sabemos qué relaciones tenía el libro — escribir igual reemplazaría el array
      // completo y perdería lo existente. Más seguro: no tocar Tags/Big Themes este turno.
      existingFetchFailed = true;
      extraNotes.push("⚠️ No pude leer el estado actual del libro, así que no toqué Tags/Big Themes para no perder lo que ya tenías — reintentá.");
    }
  }

  if (tags?.length && !existingFetchFailed) {
    const existingIds = getExistingRelationIds(existingPage!, "Tags");
    const newIds: string[] = [];
    for (const t of tags) {
      const r = resolveOrNote("tag", t);
      if (r.pageId) newIds.push(r.pageId);
      else if (r.pending) pending.push(r.pending);
    }
    const merged = Array.from(new Set([...existingIds, ...newIds]));
    if (merged.length) properties["Tags"] = { relation: merged.map((id) => ({ id })) };
  }
  if (bigThemes?.length && !existingFetchFailed) {
    const existingIds = getExistingRelationIds(existingPage!, "Big Themes");
    const newIds: string[] = [];
    for (const bt of bigThemes) {
      const r = resolveOrNote("bigTheme", bt);
      if (r.pageId) newIds.push(r.pageId);
      else if (r.pending) pending.push(r.pending);
    }
    const merged = Array.from(new Set([...existingIds, ...newIds]));
    if (merged.length) properties["Big Themes"] = { relation: merged.map((id) => ({ id })) };
  }

  for (const p of pending) addPendingRelation(pageId, p.tipo, p.nombre);
  const pendingFragments = [...extraNotes, ...pending.map((p) => p.noteFragment)];

  if (Object.keys(properties).length === 0) {
    return pendingFragments.length
      ? `⚠️ No pude actualizar ningún campo.${withBookPageId(pendingFragments, pageId)}`
      : "⚠️ No se especificaron campos para actualizar.";
  }

  const res = callNtn(`v1/pages/${pageId}`, { method: "PATCH", body: { properties } });
  if (!res.ok) return `❌ Error al actualizar libro: ${res.error}`;

  const updated = Object.keys(properties).map((k) => `• ${k}`).join("\n");
  return `✅ Libro actualizado\n${updated}${withBookPageId(pendingFragments, pageId)}`;
}

// ── logReadingProgress ───────────────────────────────────────────────────────

async function getLastReadingRecord(bookPageId: string): Promise<{ porcentajeFinal: number } | null> {
  const res = callNtn(`v1/data_sources/${TRACKING_DS}/query`, {
    body: {
      filter: {
        property: "Book",
        relation: { contains: bookPageId },
      },
      sorts: [{ property: "Fecha", direction: "descending" }],
      page_size: 1,
    },
  });

  if (!res.ok) return null;
  const data = res.data as {
    results?: Array<{ properties: Record<string, { number?: number }> }>;
  };
  const last = data.results?.[0];
  if (!last) return null;

  const pctFinal = last.properties["% Final"]?.number;
  if (pctFinal == null) return null;

  return { porcentajeFinal: pctFinal };
}

export interface LogProgressParams {
  pageId: string;
  porcentajeInicial?: number; // opcional: se auto-detecta del último registro existente
  porcentajeFinal: number;
  fecha?: string;
}

export async function logReadingProgress(params: LogProgressParams): Promise<string> {
  const { pageId, porcentajeFinal, fecha } = params;
  const today = nowInLaPaz().slice(0, 10);

  // Auto-detectar % Inicial del último registro; si no existe, arrancar en 0
  let porcentajeInicial = params.porcentajeInicial;
  let autoDetected = false;
  if (porcentajeInicial == null) {
    const last = await getLastReadingRecord(pageId);
    porcentajeInicial = last?.porcentajeFinal ?? 0;
    autoDetected = true;
  }

  const body = {
    parent: { database_id: TRACKING_DB },
    properties: {
      Book:        { relation: [{ id: pageId }] },
      Fecha:       { date: { start: fecha ?? today } },
      "% Inicial": { number: porcentajeInicial },
      "% Final":   { number: porcentajeFinal },
    },
  };

  const res = callNtn("v1/pages", { body });
  if (!res.ok) return `❌ Error al registrar progreso: ${res.error}`;

  const delta = Math.round((porcentajeFinal - porcentajeInicial) * 100);
  const pctI  = Math.round(porcentajeInicial * 100);
  const pctF  = Math.round(porcentajeFinal * 100);
  const autoLine = autoDetected ? ` <i>(inicio auto-detectado)</i>` : "";

  const bookRes = callNtn(`v1/pages/${pageId}`);
  const bookName = bookRes.ok
    ? pageToBookResult(bookRes.data as NotionPage).name
    : null;

  return (
    `📖 ${bookName ? `<b>${esc(bookName)}</b>` : "<b>Progreso de lectura</b>"}\n` +
    `${pctI}% → ${pctF}% <i>(+${delta}%)</i>${autoLine} · ${fecha ?? today}`
  );
}

// ── setBookCover ─────────────────────────────────────────────────────────────

export interface SetCoverParams {
  pageId: string;
  isbn?: string;
  title?: string;
  author?: string;
}

export async function setBookCover(params: SetCoverParams): Promise<string> {
  const { pageId, isbn, title, author } = params;

  const coverUrl = await searchCover(isbn, title, author);
  if (!coverUrl) {
    return (
      "❌ No se encontró cover para este libro.\n" +
      "Intenta proveer ISBN o asegúrate de que el título sea exacto."
    );
  }

  const res = callNtn(`v1/pages/${pageId}`, {
    method: "PATCH",
    body: {
      cover: { type: "external", external: { url: coverUrl } },
      icon:  { type: "external", external: { url: coverUrl } },
    },
  });

  if (!res.ok) return `❌ Error al actualizar cover: ${res.error}`;

  const source = coverUrl.includes("googleapis.com") ? "Google Books"
    : coverUrl.includes("openlibrary.org") ? "Open Library"
    : coverUrl.includes("goodreads") ? "Goodreads"
    : "web";
  return (
    `🖼️ Cover actualizado\n` +
    `Fuente: ${source}\n` +
    `<a href="${coverUrl}">ver imagen →</a>`
  );
}

// ── getReadingHistory ────────────────────────────────────────────────────────

/** Pagina un query a un data source hasta agotar has_more — necesario acá porque busca
 * por nombre en TODA la biblioteca (135+ libros), no solo la primera página de 100. */
function queryAllPages(dsId: string, body: Record<string, unknown>): { ok: boolean; results: NotionPage[]; error?: string } {
  const results: NotionPage[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) { // techo defensivo: 20 páginas = 2000 filas, más que de sobra
    const res = callNtn(`v1/data_sources/${dsId}/query`, {
      method: "POST",
      body: cursor ? { ...body, start_cursor: cursor } : body,
    });
    if (!res.ok) return { ok: false, results, error: res.error };
    const data = res.data as { results?: NotionPage[]; has_more?: boolean; next_cursor?: string };
    results.push(...(data.results ?? []));
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return { ok: true, results };
}

export async function getReadingHistory(query: string): Promise<string> {
  const res = queryAllPages(BOOKS_DS, { page_size: 100 });
  if (!res.ok) return `❌ Error al buscar libros: ${res.error}`;

  const books = res.results.map(pageToBookResult);
  const q = query.toLowerCase();
  const matches = books.filter((b) => b.name.toLowerCase().includes(q));

  if (matches.length === 0) {
    return `📚 No se encontró ningún libro que coincida con "<b>${esc(query)}</b>"`;
  }
  if (matches.length > 1) {
    const list = matches.map((b) => `• ${esc(b.name)}`).join("\n");
    return `📚 Encontré varios libros que coinciden con "<b>${esc(query)}</b>" — ¿cuál?\n${list}`;
  }

  const book = matches[0];
  const trackRes = callNtn(`v1/data_sources/${TRACKING_DS}/query`, {
    method: "POST",
    body: {
      filter: { property: "Book", relation: { contains: book.pageId } },
      sorts: [{ property: "Fecha", direction: "ascending" }],
      page_size: 100,
    },
  });
  if (!trackRes.ok) return `❌ Error al buscar historial: ${trackRes.error}`;

  const trackData = trackRes.data as { results?: NotionPage[] };
  const records = trackData.results ?? [];

  if (records.length === 0) {
    return `📖 <b>${esc(book.name)}</b>\nNo hay sesiones de lectura registradas todavía.`;
  }

  const lines = records.map((r) => {
    const props = r.properties as Record<string, { number?: number; date?: { start: string }; formula?: { number?: number } }>;
    const fecha = props["Fecha"]?.date?.start ?? "?";
    const pi = props["% Inicial"]?.number;
    const pf = props["% Final"]?.number;
    const paginas = props["Avance (pag)"]?.formula?.number;
    const piPct = pi != null ? `${Math.round(pi * 100)}%` : "?";
    const pfPct = pf != null ? `${Math.round(pf * 100)}%` : "?";
    const paginasLine = paginas != null ? ` — ${paginas} págs` : "";
    return `${fecha}: ${piPct} → ${pfPct}${paginasLine}`;
  });

  const currentPct = book.avanceTracking != null ? `${Math.round(book.avanceTracking * 100)}%` : null;
  const totalPaginas = book.totalPaginas != null ? ` de ${book.totalPaginas} págs` : "";
  const sesiones = `${records.length} sesion${records.length !== 1 ? "es" : ""}`;
  const header = currentPct
    ? `📖 <b>${esc(book.name)}</b> — ${currentPct}${totalPaginas} (${sesiones})`
    : `📖 <b>${esc(book.name)}</b> — ${sesiones}`;

  return `${header}\n\n${lines.join("\n")}`;
}
