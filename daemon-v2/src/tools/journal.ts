// tools/journal.ts — escrituras y lecturas del Journal contra Notion vía `ntn`.
// Las funciones puras (payloads, texto) viven en journal-payloads.ts / journal-text.ts.

import { notionApi } from "./notion-cli.js";
import {
  BIG_THEMES_DB_ID,
  JOURNAL_DB_ID,
  RESONATE_DB_ID,
  TOPICS_DB_ID,
} from "../journal-ids.js";
import {
  buildBodyBlocks,
  buildEntryProperties,
  buildMetadataProperties,
  buildQuoteBlocks,
  buildResonateProperties,
} from "../journal-payloads.js";
import type { Animo, NotionRef, Origen } from "../journal-types.js";

export interface UnreviewedRow {
  id: string;
  titulo: string;
  fecha: string;
}

/** Cache en memoria de los índices nombre→ref. Se refresca cada 10 min. */
const INDEX_TTL_MS = 10 * 60 * 1000;
const indexCache = new Map<string, { at: number; index: Map<string, NotionRef> }>();

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/** Resuelve una lista de nombres contra un índice; separa encontrados de faltantes. */
export function resolveRefs(
  names: string[],
  index: Map<string, NotionRef>,
): { encontrados: NotionRef[]; faltantes: string[] } {
  const encontrados: NotionRef[] = [];
  const faltantes: string[] = [];
  const vistos = new Set<string>();
  for (const raw of names) {
    const key = normalize(raw);
    if (key.length === 0 || vistos.has(key)) continue;
    vistos.add(key);
    const ref = index.get(key);
    if (ref) encontrados.push(ref);
    else faltantes.push(raw.trim());
  }
  return { encontrados, faltantes };
}

/** Lee la respuesta de un query a la DB Journal y devuelve las filas mínimas. */
export function parseUnreviewedRows(res: unknown): UnreviewedRow[] {
  const results = (res as { results?: unknown[] }).results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => {
    const row = r as {
      id: string;
      properties: Record<
        string,
        { title?: Array<{ plain_text: string }>; date?: { start: string } | null }
      >;
    };
    const title = row.properties["Pensamiento"]?.title ?? [];
    const titulo = title.map((t) => t.plain_text).join("").trim();
    return {
      id: row.id,
      titulo: titulo.length > 0 ? titulo : "(sin título)",
      fecha: row.properties["Fecha y hora"]?.date?.start ?? "",
    };
  });
}

export interface CompactRow {
  id: string;
  titulo: string;
  fecha: string;
  animo: string | null;
  intensidad: number | null;
  estado: string | null;
  extracto: string;
}

/**
 * Reduce la respuesta cruda de un query a lo que el LLM necesita leer.
 * Sin esto, 15-50 páginas completas de Notion superan el umbral de ~25 KB que
 * dispara el persisted-output loop del SDK (ver CLAUDE.md).
 */
export function compactJournalRows(res: unknown): CompactRow[] {
  const results = (res as { results?: unknown[] }).results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => {
    const row = r as {
      id: string;
      properties: Record<
        string,
        {
          title?: Array<{ plain_text: string }>;
          rich_text?: Array<{ plain_text: string }>;
          date?: { start: string } | null;
          select?: { name: string } | null;
          number?: number | null;
        }
      >;
    };
    const p = row.properties ?? {};
    const plain = (arr?: Array<{ plain_text: string }>) =>
      (arr ?? []).map((t) => t.plain_text).join("").trim();
    return {
      id: row.id,
      titulo: plain(p["Pensamiento"]?.title) || "(sin título)",
      fecha: p["Fecha y hora"]?.date?.start ?? "",
      animo: p["Ánimo"]?.select?.name ?? null,
      intensidad: p["Intensidad"]?.number ?? null,
      estado: p["Estado"]?.select?.name ?? null,
      extracto: plain(p["Extracto"]?.rich_text),
    };
  });
}

/** Índice nombre→ref de una DB de catálogo (Topics o Big Themes), cacheado 10 min. */
export function fetchIndex(dbId: string): Map<string, NotionRef> {
  const cached = indexCache.get(dbId);
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.index;

  const index = new Map<string, NotionRef>();
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body["start_cursor"] = cursor;
    const res = notionApi("POST", `/v1/databases/${dbId}/query`, body) as {
      results?: Array<{
        id: string;
        properties: Record<string, { type: string; title?: Array<{ plain_text: string }> }>;
      }>;
      has_more?: boolean;
      next_cursor?: string;
    };
    // Fallo de Notion (`{error}`) → NO cachear: un índice vacío cacheado 10 min dejaría
    // todas las capturas de esa ventana sin ningún topic propuesto, y en silencio.
    // Devolvemos lo último bueno que haya, o vacío sin persistirlo.
    if (!Array.isArray(res.results)) return cached?.index ?? new Map();
    for (const row of res.results) {
      const titleProp = Object.values(row.properties).find((p) => p.type === "title");
      const name = (titleProp?.title ?? []).map((t) => t.plain_text).join("").trim();
      if (name.length > 0) index.set(normalize(name), { id: row.id, name });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  indexCache.set(dbId, { at: Date.now(), index });
  return index;
}

export const fetchTopicsIndex = (): Map<string, NotionRef> => fetchIndex(TOPICS_DB_ID);
export const fetchBigThemesIndex = (): Map<string, NotionRef> => fetchIndex(BIG_THEMES_DB_ID);

/** Crea un Topic nuevo y lo agrega al cache para que quede disponible al toque. */
export function createTopic(name: string): NotionRef | null {
  const res = notionApi("POST", "/v1/pages", {
    parent: { database_id: TOPICS_DB_ID },
    properties: { Topic: { title: [{ text: { content: name } }] } },
  }) as { id?: string };
  if (!res.id) return null;
  const ref = { id: res.id, name };
  indexCache.get(TOPICS_DB_ID)?.index.set(normalize(name), ref);
  return ref;
}

/**
 * Escritura MECÁNICA (paso 1): crea la fila con el texto íntegro en el cuerpo.
 * No pasa por el LLM — es lo que garantiza que un pensamiento nunca se pierda.
 */
export function createRawEntry(input: {
  texto: string;
  origen: Origen;
  fechaHora: string;
}): { ok: true; entryId: string } | { ok: false; error: string } {
  const res = notionApi("POST", "/v1/pages", {
    parent: { database_id: JOURNAL_DB_ID },
    properties: buildEntryProperties(input),
    children: buildBodyBlocks(input.texto),
  }) as { id?: string; error?: string; detail?: string };
  if (!res.id) return { ok: false, error: res.detail ?? res.error ?? "Notion no devolvió id" };
  return { ok: true, entryId: res.id };
}

/** Escritura del paso 2: aplica la metadata aprobada. */
export function applyMetadata(
  entryId: string,
  meta: {
    titulo: string;
    animo: Animo;
    intensidad: number;
    topics: NotionRef[];
    bigTheme: NotionRef | null;
  },
): { ok: boolean; error?: string } {
  const res = notionApi("PATCH", `/v1/pages/${entryId}`, {
    properties: buildMetadataProperties(meta),
  }) as { id?: string; error?: string; detail?: string };
  return res.id ? { ok: true } : { ok: false, error: res.detail ?? res.error ?? "PATCH sin id" };
}

/**
 * Undo de applyMetadata: vacía los campos que el paso 2 completó y restaura el
 * título y el estado previos. Sin restaurar el título, el "deshacer" dejaría
 * puesto el que escribió el LLM y el mensaje "volvió a como estaba" sería falso.
 */
export function clearMetadata(
  entryId: string,
  previo: { titulo: string; estado: string },
): { ok: boolean } {
  const res = notionApi("PATCH", `/v1/pages/${entryId}`, {
    properties: {
      Pensamiento: { title: [{ text: { content: previo.titulo } }] },
      Estado: { select: { name: previo.estado } },
      "Ánimo": { select: null },
      Intensidad: { number: null },
      Topics: { relation: [] },
      "Big Themes": { relation: [] },
    },
  }) as { id?: string };
  return { ok: Boolean(res.id) };
}

export function setEstado(entryId: string, estado: string): { ok: boolean } {
  const res = notionApi("PATCH", `/v1/pages/${entryId}`, {
    properties: { Estado: { select: { name: estado } } },
  }) as { id?: string };
  return { ok: Boolean(res.id) };
}

/** Crea la fila en Resonate Calendar con la cita del texto crudo en el cuerpo. */
export function createResonateEntry(input: {
  titulo: string;
  situacion: string;
  fecha: string;
  topics: NotionRef[];
  bigTheme: NotionRef | null;
  entryId: string;
  textoCrudo: string;
}): { ok: true; resonateId: string } | { ok: false; error: string } {
  const res = notionApi("POST", "/v1/pages", {
    parent: { database_id: RESONATE_DB_ID },
    properties: buildResonateProperties(input),
    children: buildQuoteBlocks(input.textoCrudo),
  }) as { id?: string; error?: string; detail?: string };
  if (!res.id) return { ok: false, error: res.detail ?? res.error ?? "Notion no devolvió id" };
  return { ok: true, resonateId: res.id };
}

/** Undo de createResonateEntry: archiva la fila creada. */
export function archiveResonateEntry(resonateId: string): { ok: boolean } {
  const res = notionApi("PATCH", `/v1/pages/${resonateId}`, { in_trash: true }) as { id?: string };
  return { ok: Boolean(res.id) };
}

/** Entradas `Sin revisar` desde una fecha (ISO), más viejas primero. */
export function queryUnreviewed(sinceIso: string): UnreviewedRow[] {
  const res = notionApi("POST", `/v1/databases/${JOURNAL_DB_ID}/query`, {
    filter: {
      and: [
        { property: "Estado", select: { equals: "Sin revisar" } },
        { property: "Fecha y hora", date: { on_or_after: sinceIso } },
      ],
    },
    sorts: [{ property: "Fecha y hora", direction: "ascending" }],
    page_size: 50,
  });
  return parseUnreviewedRows(res);
}

/** Una entrada puntual, para reabrir su checkpoint desde el barrido. */
export function getEntry(
  entryId: string,
): { titulo: string; fecha: string; texto: string } | null {
  const page = notionApi("GET", `/v1/pages/${entryId}`) as {
    id?: string;
    properties?: Record<
      string,
      { title?: Array<{ plain_text: string }>; date?: { start: string } | null }
    >;
  };
  if (!page.id || !page.properties) return null;
  const titulo = (page.properties["Pensamiento"]?.title ?? [])
    .map((t) => t.plain_text)
    .join("")
    .trim();
  const fecha = page.properties["Fecha y hora"]?.date?.start ?? "";

  const blocks = notionApi("GET", `/v1/blocks/${entryId}/children?page_size=100`) as {
    results?: Array<{ type: string; paragraph?: { rich_text: Array<{ plain_text: string }> } }>;
  };
  const texto = (blocks.results ?? [])
    .filter((b) => b.type === "paragraph")
    .map((b) => (b.paragraph?.rich_text ?? []).map((t) => t.plain_text).join(""))
    .join("\n\n");

  return { titulo: titulo || "(sin título)", fecha, texto };
}
