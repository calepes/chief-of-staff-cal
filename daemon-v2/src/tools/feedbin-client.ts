// Cliente HTTP directo a la API de Feedbin — para crons mecánicos que no pasan por el
// Agent SDK/MCP. El MCP real de Jano (`mcp-feedbin.carlos-cb4.workers.dev`) solo es
// alcanzable vía protocolo MCP desde el LLM; un cron sin LLM llama la API real directo,
// mismo patrón que el resto de los crons mecánicos de este repo (fetch directo a la
// fuente, nunca a través de un MCP). Réplica 1:1 de las llamadas que ya hace
// `servers/feedbin/src/worker.ts` (mismos endpoints/params) — no reinventar ahí si cambia.

const BASE = "https://api.feedbin.com/v2";

export interface FeedbinCreds {
  username: string;
  password: string;
}

export interface FeedbinEntry {
  id: number;
  feed_id: number;
  title: string | null;
  url: string;
  author: string | null;
  summary: string | null;
  published: string;
}

export interface FeedbinSubscription {
  id: number;
  feed_id: number;
  title: string;
}

export interface FeedbinTagging {
  feed_id: number;
  name: string;
}

async function apiFetch(path: string, creds: FeedbinCreds): Promise<unknown> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    // 25s: con backlogs grandes (ej. 733 no leídos) un solo page de per_page=1000 puede tardar
    // >10s del lado de Feedbin — medido en vivo 2026-08-25, 10.3s reales.
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Feedbin API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function getSubscriptions(creds: FeedbinCreds): Promise<FeedbinSubscription[]> {
  return (await apiFetch("/subscriptions.json", creds)) as FeedbinSubscription[];
}

export async function getTaggings(creds: FeedbinCreds): Promise<FeedbinTagging[]> {
  return (await apiFetch("/taggings.json", creds)) as FeedbinTagging[];
}

/** Todos los no leídos con detalle (título/resumen/feed), paginado hasta agotar — a
 * diferencia de `getUnreadEntries` del MCP (solo IDs), esto trae lo necesario para
 * clasificar en una sola pasada. */
export async function getAllUnreadEntries(creds: FeedbinCreds): Promise<FeedbinEntry[]> {
  const all: FeedbinEntry[] = [];
  for (let page = 1; page <= 20; page++) { // techo defensivo, igual criterio que queryAllPages de books.ts
    const entries = (await apiFetch(`/entries.json?read=false&per_page=1000&page=${page}`, creds)) as FeedbinEntry[];
    if (entries.length === 0) break;
    all.push(...entries);
    if (entries.length < 1000) break;
  }
  return all;
}

/** Leídos recientes de TODA la cuenta (no por feed/tag) — para alimentar el perfil de
 * temas semanal sin iterar feed por feed (podrían ser decenas de suscripciones). */
export async function getRecentReadEntries(creds: FeedbinCreds, maxEntries = 300): Promise<FeedbinEntry[]> {
  const all: FeedbinEntry[] = [];
  for (let page = 1; page <= 10 && all.length < maxEntries; page++) {
    const entries = (await apiFetch(`/entries.json?read=true&per_page=100&page=${page}`, creds)) as FeedbinEntry[];
    if (entries.length === 0) break;
    all.push(...entries);
  }
  return all.slice(0, maxEntries);
}

export async function getReadEntriesByFeed(creds: FeedbinCreds, feedId: number, limit = 50, page = 1): Promise<FeedbinEntry[]> {
  return (await apiFetch(`/entries.json?read=true&feed_id=${feedId}&per_page=${Math.min(limit, 1000)}&page=${page}`, creds)) as FeedbinEntry[];
}

export async function getReadEntriesByTag(creds: FeedbinCreds, tag: string, limit = 50): Promise<FeedbinEntry[]> {
  const taggings = await getTaggings(creds);
  const tagLower = tag.toLowerCase();
  const feedIds = taggings.filter((t) => t.name.toLowerCase().includes(tagLower)).map((t) => t.feed_id);
  const results: FeedbinEntry[] = [];
  for (const feedId of feedIds) {
    results.push(...(await getReadEntriesByFeed(creds, feedId, limit)));
  }
  return results.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());
}

export async function getStarredEntries(creds: FeedbinCreds, limit = 50): Promise<FeedbinEntry[]> {
  const ids = (await apiFetch("/starred_entries.json", creds)) as number[];
  if (ids.length === 0) return [];
  const entries: FeedbinEntry[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    entries.push(...((await apiFetch(`/entries.json?ids=${chunk.join(",")}&per_page=100`, creds)) as FeedbinEntry[]));
  }
  entries.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());
  return entries.slice(0, limit);
}
