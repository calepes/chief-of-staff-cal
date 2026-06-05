import { spawnSync } from "node:child_process";

const NTN_BIN = "/opt/homebrew/bin/ntn";
export const BOOKS_DB    = "b9222a76e9404e229091b1c0e26c29dd";
export const BOOKS_DS    = "901dba51-1d00-4e3f-95b1-17ba628a0915";
export const TRACKING_DB = "70b1e190-8547-4813-b918-43ce59071d3e";

export type EstadoLibro =
  | "Goal" | "Reading" | "Read" | "Focus"
  | "Stand-By" | "Reference" | "wish list";
export type RatingLibro = "🥱" | "😶" | "😊" | "😍";

export interface BookResult {
  pageId: string;
  url: string;
  name: string;
  estado?: string;
  rating?: string;
  avanceTracking?: number;
  startDate?: string;
  isbn?: string;
}

export function callNtn(
  path: string,
  opts: { method?: "POST" | "PATCH" | "DELETE"; body?: unknown } = {}
): { ok: boolean; data?: unknown; error?: string } {
  const args = ["api"];
  if (opts.method) args.push("-X", opts.method);
  args.push(path);
  if (opts.body !== undefined) args.push("-d", JSON.stringify(opts.body));

  const result = spawnSync(NTN_BIN, args, {
    encoding: "utf8",
    timeout: 15_000,
  });

  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout).trim() };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: true, data: result.stdout.trim() };
  }
}

export async function searchCover(
  isbn?: string,
  title?: string,
  author?: string
): Promise<string | null> {
  // Primary: Open Library by ISBN
  if (isbn) {
    const url = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
    try {
      const res = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok || res.status === 302 || res.redirected) return url;
    } catch {
      // fall through
    }
  }

  // Fallback: Google Books by title + author
  if (title) {
    const q = encodeURIComponent(
      `intitle:${title}${author ? `+inauthor:${author}` : ""}`
    );
    try {
      const res = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=3`,
        { signal: AbortSignal.timeout(8_000) }
      );
      const data = (await res.json()) as {
        items?: Array<{ volumeInfo: { imageLinks?: { thumbnail?: string } } }>;
      };
      const thumb = data?.items?.[0]?.volumeInfo?.imageLinks?.thumbnail;
      if (thumb) return thumb;
    } catch {
      // fall through
    }
  }

  return null;
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
    select?: { name: string };
    title?: Array<{ plain_text: string }>;
    rich_text?: Array<{ plain_text: string }>;
    number?: number;
    date?: { start: string };
  }>;
  return {
    pageId: page.id,
    url: page.url,
    name: props["Name"]?.title?.[0]?.plain_text ?? "(sin título)",
    estado: props["Estado"]?.select?.name,
    rating: props["Rating"]?.select?.name,
    avanceTracking: props["Avance Tracking"]?.number ?? undefined,
    startDate: props["Start Date"]?.date?.start,
    isbn: props["ISBN"]?.rich_text?.[0]?.plain_text,
  };
}

// ── searchBooks ──────────────────────────────────────────────────────────────

export async function searchBooks(
  query?: string,
  estado?: EstadoLibro
): Promise<string> {
  const body: Record<string, unknown> = { page_size: 30 };

  if (estado) {
    body.filter = {
      property: "Estado",
      select: { equals: estado },
    };
  }

  const res = callNtn(`v1/data_sources/${BOOKS_DS}/query`, { body });
  if (!res.ok) return `❌ Error al buscar libros: ${res.error}`;

  const data = res.data as { results?: NotionPage[] };
  let books = (data.results ?? []).map(pageToBookResult);

  if (query) {
    const q = query.toLowerCase();
    books = books.filter((b) => b.name.toLowerCase().includes(q));
  }

  if (books.length === 0) {
    return query
      ? `📚 No se encontraron libros que coincidan con "<b>${esc(query)}</b>"`
      : "📚 No hay libros en la BD.";
  }

  const ESTADO_EMOJI: Record<string, string> = {
    Reading: "📖", Read: "✅", Goal: "🎯", Focus: "🔥",
    "Stand-By": "⏸️", Reference: "📎", "wish list": "💭",
  };

  const lines = books.map((b) => {
    const emoji = ESTADO_EMOJI[b.estado ?? ""] ?? "•";
    const rating = b.rating ? ` ${b.rating}` : "";
    const avance = b.avanceTracking != null ? ` · ${Math.round(b.avanceTracking * 100)}%` : "";
    return `${emoji} <b>${esc(b.name)}</b>${rating}${avance}\n   <a href="${b.url}">ver →</a>`;
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
}

export async function addBook(params: AddBookParams): Promise<string> {
  const {
    name, subtitle, isbn, estado, planningToRead,
    totalPaginas, startDate, finishDate, url,
    fetchCover = true,
  } = params;

  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: name } }] },
    Estado: { select: { name: estado } },
  };
  if (subtitle) properties["Subtitle"] = { rich_text: [{ text: { content: subtitle } }] };
  if (isbn)     properties["ISBN"]     = { rich_text: [{ text: { content: isbn } }] };
  if (planningToRead) properties["Planning to read"] = { select: { name: planningToRead } };
  if (totalPaginas)   properties["Total Páginas"]    = { number: totalPaginas };
  if (startDate)      properties["Start Date"]       = { date: { start: startDate } };
  if (finishDate)     properties["Finish Date"]      = { date: { start: finishDate } };
  if (url)            properties["userDefined:URL"]  = { url };

  const body: Record<string, unknown> = {
    parent: { database_id: BOOKS_DB },
    properties,
  };

  let coverUrl: string | null = null;
  if (fetchCover) {
    coverUrl = await searchCover(isbn, name);
    if (coverUrl) {
      body.cover = { type: "external", external: { url: coverUrl } };
      body.icon  = { type: "external", external: { url: coverUrl } };
    }
  }

  const res = callNtn("v1/pages", { body });
  if (!res.ok) return `❌ Error al crear libro: ${res.error}`;

  const page = res.data as { id: string; url: string };
  const coverLine = coverUrl ? "\n🖼️ Cover: cargado automáticamente" : "";
  const paginasLine = totalPaginas ? ` · ${totalPaginas} págs` : "";

  return (
    `✅ <b>${esc(name)}</b> creado en Notion\n` +
    `📖 ${estado}${paginasLine}${planningToRead ? ` · ${planningToRead}` : ""}` +
    coverLine +
    `\n<a href="${page.url}">Ver en Notion →</a>`
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
}

export async function updateBook(params: UpdateBookParams): Promise<string> {
  const { pageId, estado, rating, startDate, finishDate,
          totalPaginas, isbn, subtitle, url, planningToRead } = params;

  const properties: Record<string, unknown> = {};
  if (estado)       properties["Estado"]            = { select: { name: estado } };
  if (rating)       properties["Rating"]            = { select: { name: rating } };
  if (startDate)    properties["Start Date"]        = { date: { start: startDate } };
  if (finishDate)   properties["Finish Date"]       = { date: { start: finishDate } };
  if (totalPaginas) properties["Total Páginas"]     = { number: totalPaginas };
  if (isbn)         properties["ISBN"]              = { rich_text: [{ text: { content: isbn } }] };
  if (subtitle)     properties["Subtitle"]          = { rich_text: [{ text: { content: subtitle } }] };
  if (url)          properties["userDefined:URL"]   = { url };
  if (planningToRead) properties["Planning to read"] = { select: { name: planningToRead } };

  if (Object.keys(properties).length === 0) {
    return "⚠️ No se especificaron campos para actualizar.";
  }

  const res = callNtn(`v1/pages/${pageId}`, { method: "PATCH", body: { properties } });
  if (!res.ok) return `❌ Error al actualizar libro: ${res.error}`;

  const updated = Object.keys(properties).map((k) => `• ${k}`).join("\n");
  return `✅ Libro actualizado\n${updated}`;
}

// ── logReadingProgress ───────────────────────────────────────────────────────

export interface LogProgressParams {
  pageId: string;
  porcentajeInicial: number;
  porcentajeFinal: number;
  fecha?: string;
}

export async function logReadingProgress(params: LogProgressParams): Promise<string> {
  const { pageId, porcentajeInicial, porcentajeFinal, fecha } = params;
  const today = new Date().toISOString().slice(0, 10);

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

  return (
    `📊 Progreso registrado\n` +
    `${pctI}% → ${pctF}% <i>(+${delta}%)</i>\n` +
    `Fecha: ${fecha ?? today}`
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

  const source = isbn ? "Open Library (ISBN)" : "Google Books";
  return (
    `🖼️ Cover actualizado\n` +
    `Fuente: ${source}\n` +
    `<a href="${coverUrl}">ver imagen →</a>`
  );
}
