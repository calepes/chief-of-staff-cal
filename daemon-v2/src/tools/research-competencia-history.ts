import { queryD1, type D1QueryDeps } from "./research-competencia-d1.js";
import type { SocialPlatform } from "./research-competencia-social.js";
import type { VideoAnalysis } from "./research-competencia-media.js";

export interface HistoryPost {
  entityId: string;
  platform: SocialPlatform;
  handle: string;
  url: string;
  fecha: string | null;
  caption: string;
  esVideo: boolean;
  mediaUrls: string[];
  imagenes: string[];
  video?: VideoAnalysis;
}

export interface HistoryRow {
  url: string;
  fecha: string | null;
  caption: string;
  esVideo: boolean;
  mediaUrls: string[];
  imagenes: string[];
  videoTranscripcion: string | null;
  videoFrames: string[];
}

export interface HistoryDeps {
  queryD1Fn?: (sql: string, params: unknown[], deps?: D1QueryDeps) => Promise<Record<string, unknown>[] | null>;
}

function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToHistoryRow(row: Record<string, unknown>): HistoryRow {
  return {
    url: String(row.url),
    fecha: typeof row.fecha === "string" ? row.fecha : null,
    caption: typeof row.caption === "string" ? row.caption : "",
    esVideo: row.es_video === 1,
    mediaUrls: parseJsonArray(row.media_urls),
    imagenes: parseJsonArray(row.imagenes_desc),
    videoTranscripcion: typeof row.video_transcripcion === "string" ? row.video_transcripcion : null,
    videoFrames: parseJsonArray(row.video_frames),
  };
}

/**
 * Consulta D1 por las URLs que YA existen en el histórico. Fail-soft: si D1 no responde, devuelve
 * un Map vacío — `fetchSocialText` trata eso como "nada visto todavía" y enriquece todo igual que
 * hoy (más caro esa semana, nunca se pierde contenido).
 */
export async function findExistingUrls(urls: string[], deps: HistoryDeps = {}): Promise<Map<string, HistoryRow>> {
  if (urls.length === 0) return new Map();
  const queryD1Fn = deps.queryD1Fn ?? queryD1;
  const placeholders = urls.map(() => "?").join(",");
  const rows = await queryD1Fn(`SELECT * FROM posts WHERE url IN (${placeholders})`, urls);
  const map = new Map<string, HistoryRow>();
  for (const row of rows ?? []) {
    const parsed = rowToHistoryRow(row);
    map.set(parsed.url, parsed);
  }
  return map;
}

/**
 * Inserta posts nuevos (ya enriquecidos) al histórico. `INSERT OR IGNORE` — si la URL ya existe
 * (carrera entre dos corridas, o un post que `findExistingUrls` no vio a tiempo), se ignora en vez
 * de tirar. Una query por post — el volumen semanal (≤8×22 en el peor caso) no justifica el modo
 * `batch` de la API todavía; si esto se usa para el backfill grande, ahí sí conviene batchear.
 */
export async function insertPosts(posts: HistoryPost[], runId: string, deps: HistoryDeps = {}): Promise<void> {
  if (posts.length === 0) return;
  const queryD1Fn = deps.queryD1Fn ?? queryD1;
  const nowIso = new Date().toISOString();
  for (const post of posts) {
    try {
      await queryD1Fn(
        `INSERT OR IGNORE INTO posts (entity_id, platform, handle, url, fecha, caption, es_video, media_urls, imagenes_desc, video_transcripcion, video_frames, run_id, first_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          post.entityId,
          post.platform,
          post.handle,
          post.url,
          post.fecha,
          post.caption,
          post.esVideo ? 1 : 0,
          JSON.stringify(post.mediaUrls),
          JSON.stringify(post.imagenes),
          post.video?.transcripcion ?? null,
          JSON.stringify(post.video?.frames ?? []),
          runId,
          nowIso,
        ],
      );
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_history_insert_error", url: post.url, err: String(err) }));
    }
  }
}
