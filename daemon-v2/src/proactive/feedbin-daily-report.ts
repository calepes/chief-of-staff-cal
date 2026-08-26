// Cron diario: cuántos no leídos hay en Feedbin, agrupados por carpeta, y una recomendación
// de qué artículos de hoy vale la pena abrir vs marcar como leído sin abrir — usando el
// perfil de temas que refresca `topics-profile-refresh.ts` semanalmente. Solo SUGIERE,
// nunca marca nada como leído por su cuenta (decisión explícita de Cal).

import { readFileSync } from "node:fs";
import { startup } from "@anthropic-ai/claude-agent-sdk";
import { getAllUnreadEntries, getSubscriptions, getTaggings, type FeedbinCreds, type FeedbinEntry } from "../tools/feedbin-client.js";
import { TOPICS_PROFILE_PATH } from "./topics-profile-refresh.js";
import { sendCronMessage } from "./rich-send.js";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TO_CLASSIFY = 60; // techo de costo — si hay más no leídos, se clasifican los más recientes

export interface FeedbinDailyReportOpts {
  botToken: string;
  chatId: number;
  feedbin: FeedbinCreds;
}

export interface Recomendacion { id: number; decision: "abrir" | "saltar" }

export function parseClassifyResult(raw: string): Recomendacion[] {
  const limpio = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(limpio) as { recomendaciones?: unknown };
    if (!Array.isArray(parsed.recomendaciones)) return [];
    return (parsed.recomendaciones as Array<Record<string, unknown>>)
      .filter((r) => typeof r.id === "number" && (r.decision === "abrir" || r.decision === "saltar"))
      .map((r) => ({ id: r.id as number, decision: r.decision as "abrir" | "saltar" }));
  } catch {
    return [];
  }
}

function readTopicsProfile(): string | null {
  try {
    const raw = readFileSync(TOPICS_PROFILE_PATH, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function buildClassifyPrompt(perfil: string, entries: FeedbinEntry[]): string {
  const lista = entries
    .map((e) => `${e.id} | ${e.title ?? "(sin título)"} | ${(e.summary ?? "").slice(0, 200)}`)
    .join("\n");
  return [
    "Perfil de temas de interés actuales de la persona:",
    perfil,
    "",
    "Artículos sin leer de hoy (id | título | resumen):",
    lista,
    "",
    "Para CADA artículo decidí si vale la pena abrirlo (relevante para el perfil) o si es de",
    "baja relevancia y puede marcarse como leído sin abrir. Ante la duda, preferí \"abrir\"",
    "(el costo de abrir algo irrelevante es bajo; el de perderse algo relevante no).",
    "",
    "Devolvé SOLO un JSON, sin explicación ni fences:",
    '{"recomendaciones":[{"id":N,"decision":"abrir"|"saltar"}, ...]}',
  ].join("\n");
}

async function classifyEntries(perfil: string, entries: FeedbinEntry[]): Promise<Recomendacion[]> {
  const handle = await startup({ options: { model: MODEL, maxTurns: 1, allowedTools: [] } });
  let out = "";
  try {
    for await (const event of handle.query(buildClassifyPrompt(perfil, entries))) {
      const e = event as { type?: string; subtype?: string; result?: string };
      if (e.type === "result" && e.subtype === "success") {
        out = e.result ?? "";
        break;
      }
    }
  } finally {
    try { await handle.close(); } catch { /* best-effort */ }
  }

  return parseClassifyResult(out);
}

export async function checkFeedbinDailyReport(opts: FeedbinDailyReportOpts): Promise<void> {
  const { botToken, chatId, feedbin } = opts;

  let unread: FeedbinEntry[];
  let subs: Awaited<ReturnType<typeof getSubscriptions>>;
  let taggings: Awaited<ReturnType<typeof getTaggings>>;
  try {
    [unread, subs, taggings] = await Promise.all([
      getAllUnreadEntries(feedbin),
      getSubscriptions(feedbin),
      getTaggings(feedbin),
    ]);
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_fetch_error", err: String(err) }));
    return;
  }

  if (unread.length === 0) {
    try {
      await sendCronMessage(botToken, { chatId, text: "📰 <b>Feedbin</b>\nSin artículos sin leer." });
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_send_failed", err: String(err) }));
    }
    return;
  }

  const feedTagName = new Map<number, string>();
  for (const t of taggings) feedTagName.set(t.feed_id, t.name);
  const feedTitle = new Map<number, string>();
  for (const s of subs) feedTitle.set(s.feed_id, s.title);

  const porCarpeta = new Map<string, number>();
  for (const e of unread) {
    const carpeta = feedTagName.get(e.feed_id) ?? feedTitle.get(e.feed_id) ?? "(sin carpeta)";
    porCarpeta.set(carpeta, (porCarpeta.get(carpeta) ?? 0) + 1);
  }

  const lines: string[] = [`📰 <b>Feedbin</b> — ${unread.length} sin leer`];
  const carpetaLine = [...porCarpeta.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([carpeta, count]) => `${carpeta}: ${count}`)
    .join(" · ");
  lines.push(carpetaLine);

  const perfil = readTopicsProfile();
  if (!perfil) {
    lines.push("");
    lines.push("<i>Sin perfil de temas todavía (corre el domingo) — sin recomendación por ahora.</i>");
  } else {
    const sorted = [...unread].sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());
    const truncated = sorted.length > MAX_TO_CLASSIFY;
    const toClassify = sorted.slice(0, MAX_TO_CLASSIFY);

    let recomendaciones: Recomendacion[] = [];
    try {
      recomendaciones = await classifyEntries(perfil, toClassify);
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_classify_error", err: String(err) }));
    }

    const abrirIds = new Set(recomendaciones.filter((r) => r.decision === "abrir").map((r) => r.id));
    const entryById = new Map(toClassify.map((e) => [e.id, e]));
    const recomendados = [...abrirIds].map((id) => entryById.get(id)).filter((e): e is FeedbinEntry => Boolean(e));
    const saltablesCount = recomendaciones.length - recomendados.length;

    lines.push("");
    if (recomendados.length === 0 && recomendaciones.length === 0) {
      lines.push("<i>No pude clasificar hoy (falló la síntesis) — revisá la lista completa vos.</i>");
    } else {
      lines.push(`✅ <b>Para abrir</b> (${recomendados.length}${truncated ? `, de los ${MAX_TO_CLASSIFY} más recientes` : ""})`);
      for (const e of recomendados.slice(0, 15)) {
        lines.push(`• <a href="${e.url}">${e.title ?? "(sin título)"}</a>`);
      }
      if (saltablesCount > 0) lines.push(`\n⏭️ ${saltablesCount} de baja relevancia — no los toqué, decisión tuya.`);
    }
  }

  try {
    await sendCronMessage(botToken, { chatId, text: lines.join("\n") });
    console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_sent", unreadCount: unread.length }));
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_send_failed", err: String(err) }));
  }
}
