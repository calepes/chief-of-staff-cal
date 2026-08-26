// Cron semanal: sintetiza un "perfil de temas actuales" a partir de comportamiento real
// de lectura (leídos + starred en Feedbin, shortlist en Reader) — snapshot en texto plano
// que el cron diario de Feedbin usa para recomendar qué artículos nuevos vale la pena
// abrir. Se REGENERA entero cada semana (no acumula como learnings.md): "intereses
// actuales" caduca, un perfil de hace 2 meses ya no representa lo que Cal lee hoy.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { startup } from "@anthropic-ai/claude-agent-sdk";
import { getRecentReadEntries, getStarredEntries, type FeedbinCreds } from "../tools/feedbin-client.js";
import { readerListDocuments } from "../tools/readwise.js";
import { sendCronMessage } from "./rich-send.js";

const MODEL = "claude-haiku-4-5-20251001";
export const TOPICS_PROFILE_PATH = join(process.env.HOME!, ".cos-agent", "topics-profile.md");

export interface TopicsProfileRefreshOpts {
  botToken: string;
  chatId: number;
  feedbin: FeedbinCreds;
}

interface ReaderDoc { title?: string; summary?: string }
interface ReaderListResult { results?: ReaderDoc[] }

export function buildTopicsProfilePrompt(read: string[], starred: string[], shortlist: string[]): string {
  return [
    "Sos un analista que identifica los temas de interés ACTUALES de una persona a partir de",
    "su comportamiento real de lectura de las últimas semanas — no de lo que dice que le",
    "interesa, sino de lo que efectivamente lee, guarda o marca como \"volver a esto\".",
    "",
    "Señales (de más a menos fuertes):",
    `SHORTLIST en Reader (marcó \"vale la pena volver\"):\n${shortlist.join("\n") || "(vacío)"}`,
    "",
    `STARRED en Feedbin (interés fuerte explícito):\n${starred.join("\n") || "(vacío)"}`,
    "",
    `LEÍDOS recientes en Feedbin (consumo real):\n${read.join("\n") || "(vacío)"}`,
    "",
    "Devolvé una lista de 10-15 temas concretos (no genéricos como \"tecnología\" — específicos",
    "como \"agentes de IA autónomos\", \"estrategia de producto B2B\", \"liderazgo de equipos",
    "remotos\"), cada uno en una línea con el formato:",
    "- <tema>: <una frase de por qué, citando qué lo sugiere>",
    "",
    "Sin introducción ni cierre — solo la lista.",
  ].join("\n");
}

async function synthesizeProfile(read: string[], starred: string[], shortlist: string[]): Promise<string> {
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

  let readTitles: string[] = [];
  let starredTitles: string[] = [];
  let shortlistTitles: string[] = [];

  try {
    const [read, starred] = await Promise.all([
      getRecentReadEntries(feedbin, 300),
      getStarredEntries(feedbin, 100),
    ]);
    readTitles = read.map((e) => e.title).filter((t): t is string => Boolean(t));
    starredTitles = starred.map((e) => e.title).filter((t): t is string => Boolean(t));
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_feedbin_error", err: String(err) }));
  }

  try {
    const shortlist = readerListDocuments({ location: "shortlist", limit: 100 }) as ReaderListResult;
    shortlistTitles = (shortlist.results ?? [])
      .map((d) => (d.title ? `${d.title}${d.summary ? " — " + d.summary : ""}` : null))
      .filter((t): t is string => Boolean(t));
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_reader_error", err: String(err) }));
  }

  if (readTitles.length === 0 && starredTitles.length === 0 && shortlistTitles.length === 0) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_no_signal" }));
    return;
  }

  let perfil: string;
  try {
    perfil = await synthesizeProfile(readTitles, starredTitles, shortlistTitles);
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_synthesize_error", err: String(err) }));
    return;
  }
  if (!perfil) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_empty_result" }));
    return;
  }

  try {
    mkdirSync(dirname(TOPICS_PROFILE_PATH), { recursive: true });
    writeFileSync(TOPICS_PROFILE_PATH, perfil, "utf8");
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_write_error", err: String(err) }));
    return;
  }

  console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_refreshed", readCount: readTitles.length, starredCount: starredTitles.length, shortlistCount: shortlistTitles.length }));

  try {
    await sendCronMessage(botToken, {
      chatId,
      text: `🧭 <b>Perfil de temas actualizado</b>\nBasado en ${readTitles.length} leídos, ${starredTitles.length} starred y ${shortlistTitles.length} en shortlist.\n\n${perfil}`,
    });
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "topics_profile_send_failed", err: String(err) }));
  }
}
