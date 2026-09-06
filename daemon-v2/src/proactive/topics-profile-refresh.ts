// Cron semanal: sintetiza un "perfil de temas actuales" a partir de comportamiento real
// de lectura (leídos + starred en Feedbin, shortlist en Reader) — snapshot en texto plano
// que el cron diario de Feedbin usa para recomendar qué artículos nuevos vale la pena
// abrir. Se REGENERA entero cada semana (no acumula como learnings.md): "intereses
// actuales" caduca, un perfil de hace 2 meses ya no representa lo que Cal lee hoy.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { startup } from "@anthropic-ai/claude-agent-sdk";
import { sendMessage } from "@cos/shared";
import { getRecentReadEntries, getStarredEntries, feedbinEntryUrl, type FeedbinCreds } from "../tools/feedbin-client.js";
import { readerListDocuments } from "../tools/readwise.js";
import { sendCronMessage, stripHtmlTags } from "./rich-send.js";
import { sanitizeForTelegram } from "../format.js";

const MODEL = "claude-haiku-4-5-20251001";
export const TOPICS_PROFILE_PATH = join(process.env.HOME!, ".cos-agent", "topics-profile.md");

export interface TopicsProfileRefreshOpts {
  botToken: string;
  chatId: number;
  feedbin: FeedbinCreds;
}

interface ReaderDoc { title?: string; summary?: string; url?: string; source_url?: string }
interface ReaderListResult { results?: ReaderDoc[] }

/** Un ítem de lectura con URL real, etiquetado con un ID corto y estable (ej. "R3") para que
 * Haiku pueda citarlo sin que nosotros tengamos que confiar en una URL que el modelo escriba
 * (alucinable) — el link final siempre sale de ESTA lista, nunca de texto generado. */
export interface TopicSource { id: string; title: string; url: string; summary?: string }

function labelSources(prefix: string, items: Array<{ title: string; url: string; summary?: string }>): TopicSource[] {
  return items.map((item, i) => ({ id: `${prefix}${i + 1}`, ...item }));
}

/** Matchea el/los ID(s) de cita que Haiku agrega al final de cada línea, ej. "[R3]" o "[L2, S1]". */
const CITATION_RE = /\s*\[([A-Za-z]\d+(?:\s*,\s*[A-Za-z]\d+)*)\]/g;

function sourceLines(sources: TopicSource[]): string {
  return sources.map((s) => `[${s.id}] ${s.title}${s.summary ? " — " + s.summary : ""}`).join("\n") || "(vacío)";
}

export function buildTopicsProfilePrompt(read: TopicSource[], starred: TopicSource[], shortlist: TopicSource[]): string {
  return [
    "Sos un analista que identifica los temas de interés ACTUALES de una persona a partir de",
    "su comportamiento real de lectura de las últimas semanas — no de lo que dice que le",
    "interesa, sino de lo que efectivamente lee, guarda o marca como \"volver a esto\".",
    "",
    "Cada ítem de las listas de abajo empieza con un ID entre corchetes, ej. \"[R3] Título\".",
    "",
    "Señales (de más a menos fuertes):",
    `SHORTLIST en Reader (marcó \"vale la pena volver\"):\n${sourceLines(shortlist)}`,
    "",
    `STARRED en Feedbin (interés fuerte explícito):\n${sourceLines(starred)}`,
    "",
    `LEÍDOS recientes en Feedbin (consumo real):\n${sourceLines(read)}`,
    "",
    "Devolvé una lista de 10-15 temas concretos (no genéricos como \"tecnología\" — específicos",
    "como \"agentes de IA autónomos\", \"estrategia de producto B2B\", \"liderazgo de equipos",
    "remotos\"), cada uno en una línea con el formato:",
    "- <tema>: <una frase de por qué, citando qué lo sugiere> [ID] o [ID, ID]",
    "",
    "El [ID] (o varios separados por coma) va SIEMPRE al final de la línea, y tiene que ser",
    "EXACTAMENTE uno de los IDs que aparecen entre corchetes en las listas de arriba — nunca",
    "inventes un ID que no exista ahí, y nunca omitas el corchete final.",
    "",
    "Sin introducción ni cierre — solo la lista.",
  ].join("\n");
}

async function synthesizeProfile(read: TopicSource[], starred: TopicSource[], shortlist: TopicSource[]): Promise<string> {
  const handle = await startup({ options: { model: MODEL, maxTurns: 1, allowedTools: [] } });
  let out = "";
  try {
    for await (const event of handle.query(buildTopicsProfilePrompt(read, starred, shortlist))) {
      const e = event as { type?: string; subtype?: string; result?: string };
      if (e.type === "result" && e.subtype === "success") {
        out = e.result ?? "";
        break;
      }
    }
  } finally {
    try { await handle.close(); } catch { /* best-effort */ }
  }
  return out.trim();
}

export async function refreshTopicsProfile(opts: TopicsProfileRefreshOpts): Promise<void> {
  const { botToken, chatId, feedbin } = opts;

  let readSources: TopicSource[] = [];
  let starredSources: TopicSource[] = [];
  let shortlistSources: TopicSource[] = [];

  try {
    const [read, starred] = await Promise.all([
      getRecentReadEntries(feedbin, 300),
      getStarredEntries(feedbin, 100),
    ]);
    // feedbinEntryUrl (no e.url): que el link abra la entrada DENTRO de Feedbin, no el artículo
    // original — así abrirlo desde el chat sí marca la entrada como leída del lado de Feedbin.
    readSources = labelSources("L", read.filter((e) => Boolean(e.title)).map((e) => ({ title: e.title as string, url: feedbinEntryUrl(e.id) })));
    starredSources = labelSources("S", starred.filter((e) => Boolean(e.title)).map((e) => ({ title: e.title as string, url: feedbinEntryUrl(e.id) })));
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_feedbin_error", err: String(err) }));
  }

  try {
    const shortlist = readerListDocuments({ location: "shortlist", limit: 100 }) as ReaderListResult;
    shortlistSources = labelSources(
      "R",
      (shortlist.results ?? [])
        .filter((d) => Boolean(d.title) && Boolean(d.source_url ?? d.url))
        .map((d) => ({ title: d.title as string, url: (d.source_url ?? d.url) as string, summary: d.summary })),
    );
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_reader_error", err: String(err) }));
  }

  if (readSources.length === 0 && starredSources.length === 0 && shortlistSources.length === 0) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_no_signal" }));
    return;
  }

  let perfil: string;
  try {
    perfil = await synthesizeProfile(readSources, starredSources, shortlistSources);
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_synthesize_error", err: String(err) }));
    return;
  }
  if (!perfil) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_empty_result" }));
    return;
  }

  // El archivo en disco lo lee OTRO prompt (feedbin-daily-report.ts) — queda limpio, sin los
  // marcadores de cita [ID] (ruido para ese consumo, no para Cal).
  const perfilLimpio = perfil.replace(CITATION_RE, "");
  try {
    mkdirSync(dirname(TOPICS_PROFILE_PATH), { recursive: true });
    writeFileSync(TOPICS_PROFILE_PATH, perfilLimpio, "utf8");
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_write_error", err: String(err) }));
    return;
  }

  console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_refreshed", readCount: readSources.length, starredCount: starredSources.length, shortlistCount: shortlistSources.length }));

  const urlById = new Map<string, string>();
  for (const s of [...readSources, ...starredSources, ...shortlistSources]) urlById.set(s.id, s.url);

  // `perfil` es texto de Haiku (markdown, "- **tema**: frase [ID]") — nunca HTML real (el prompt
  // no lo pide), así que es seguro escapar `&`/`<`/`>` ANTES de convertir markdown→HTML y de
  // insertar los links reales: sin el escape, un nombre de tema con un ampersand literal
  // ("IA & startups") rompía el parseo de Telegram (400 "can't parse entities") y perdía el
  // mensaje entero. El [ID] se reemplaza DESPUÉS del escape por el <a href> real (la URL sale
  // SIEMPRE de `urlById`, nunca de texto que escribió el modelo — sin superficie de link
  // arbitrario). sanitizeForTelegram (mismo safety net que el reply libre del modelo) recién
  // al final convierte `**bold**`/listas a tags reales — sin esto Cal veía los asteriscos
  // literales ("cero formateo").
  const perfilEscapado = perfil.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const perfilConLinks = perfilEscapado.replace(CITATION_RE, (_match, idsRaw: string) => {
    const links = idsRaw
      .split(",")
      .map((id) => id.trim())
      .map((id) => urlById.get(id))
      .filter((u): u is string => Boolean(u));
    return links.length > 0 ? " " + links.map((u) => `<a href="${u.replace(/&/g, "&amp;")}">🔗</a>`).join(" ") : "";
  });
  const text = `🧭 <b>Perfil de temas actualizado</b>\nBasado en ${readSources.length} leídos, ${starredSources.length} starred y ${shortlistSources.length} en shortlist.\n\n${sanitizeForTelegram(perfilConLinks)}`;

  try {
    await sendCronMessage(botToken, { chatId, text });
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_rich_send_failed", err: String(err) }));
    // 3er nivel (texto plano) — mismo patrón que sendResumenMessage en tools/resumir.ts: si Rich
    // Message Y HTML clásico fallan los dos, no abandonar en silencio (el perfil semanal es
    // notificación única, no hay otra forma de que Cal se entere de que se actualizó).
    try {
      await sendMessage(botToken, { chatId, text: stripHtmlTags(text) });
    } catch (err2) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_send_failed", err: String(err2) }));
    }
  }
}
