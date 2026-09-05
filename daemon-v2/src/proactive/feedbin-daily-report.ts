// Cron diario: clasifica TODO el backlog de no leídos en Feedbin (sin techo — antes solo miraba
// los últimos 60), lo agrupa por tema en dos tandas ("para abrir" y "marcar leído") usando el
// perfil de temas que refresca `topics-profile-refresh.ts` semanalmente, y ofrece un botón por
// grupo de baja relevancia para marcarlo como leído en bloque. Nunca marca nada por su cuenta —
// la ejecución real solo pasa por tocar un botón (ver feedbin-report-callbacks.ts).

import { readFileSync } from "node:fs";
import { startup } from "@anthropic-ai/claude-agent-sdk";
import { getAllUnreadEntries, getSubscriptions, getTaggings, feedbinEntryUrl, type FeedbinCreds, type FeedbinEntry } from "../tools/feedbin-client.js";
import type { CfKv } from "../cf-kv.js";
import { TOPICS_PROFILE_PATH } from "./topics-profile-refresh.js";
import { sendCronMessage } from "./rich-send.js";
import { groupEntries, type ThemeGroup } from "./feedbin-report-groups.js";
import { renderAbrirSection, selectMarkButtons, buildReportText, buildKeyboard, esc, type Keyboard } from "./feedbin-report-card.js";
import { FeedbinReportStore } from "./feedbin-report-store.js";

const MODEL = "claude-haiku-4-5-20251001";
const CLASSIFY_BATCH_SIZE = 60;
const ABRIR_FALLBACK_LIMIT = 15; // si el agrupado de "abrir" falla, cuántos links planos mostrar

export interface FeedbinDailyReportOpts {
  botToken: string;
  chatId: number;
  feedbin: FeedbinCreds;
  kv: CfKv;
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

/** Clasifica TODO el backlog en lotes de CLASSIFY_BATCH_SIZE — un lote que falla se loguea y se
 * excluye, pero no aborta los siguientes. Reemplaza el viejo techo MAX_TO_CLASSIFY=60. */
async function classifyAllEntries(perfil: string, entries: FeedbinEntry[]): Promise<Recomendacion[]> {
  const all: Recomendacion[] = [];
  for (let i = 0; i < entries.length; i += CLASSIFY_BATCH_SIZE) {
    const batch = entries.slice(i, i + CLASSIFY_BATCH_SIZE);
    try {
      const recs = await classifyEntries(perfil, batch);
      all.push(...recs);
    } catch (err) {
      console.log(JSON.stringify({
        ts: Date.now(),
        msg: "feedbin_daily_report_batch_classify_failed",
        batchIndex: Math.floor(i / CLASSIFY_BATCH_SIZE),
        err: String(err),
      }));
    }
  }
  return all;
}

export async function checkFeedbinDailyReport(opts: FeedbinDailyReportOpts): Promise<void> {
  const { botToken, chatId, feedbin, kv } = opts;

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
  const carpetaLine = [...porCarpeta.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([carpeta, count]) => `${carpeta}: ${count}`)
    .join(" · ");

  const perfil = readTopicsProfile();
  if (!perfil) {
    const text = [
      `📰 <b>Feedbin</b> — ${unread.length} sin leer`,
      carpetaLine,
      "",
      "<i>Sin perfil de temas todavía (corre el domingo) — sin recomendación por ahora.</i>",
    ].join("\n");
    try {
      await sendCronMessage(botToken, { chatId, text });
      console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_sent", unreadCount: unread.length }));
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_send_failed", err: String(err) }));
    }
    return;
  }

  const entryById = new Map(unread.map((e) => [e.id, e]));
  const recomendaciones = await classifyAllEntries(perfil, unread);

  if (recomendaciones.length === 0) {
    const text = [
      `📰 <b>Feedbin</b> — ${unread.length} sin leer`,
      carpetaLine,
      "",
      "<i>No pude clasificar hoy (falló la síntesis) — revisá la lista completa vos.</i>",
    ].join("\n");
    try {
      await sendCronMessage(botToken, { chatId, text });
      console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_sent", unreadCount: unread.length }));
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_send_failed", err: String(err) }));
    }
    return;
  }

  const abrirEntries = recomendaciones
    .filter((r) => r.decision === "abrir")
    .map((r) => entryById.get(r.id))
    .filter((e): e is FeedbinEntry => Boolean(e));
  const saltarEntries = recomendaciones
    .filter((r) => r.decision === "saltar")
    .map((r) => entryById.get(r.id))
    .filter((e): e is FeedbinEntry => Boolean(e));

  let abrirGroups: ThemeGroup[] = [];
  try {
    abrirGroups = await groupEntries(perfil, abrirEntries);
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_group_abrir_failed", err: String(err) }));
  }

  let saltarGroups: ThemeGroup[] = [];
  try {
    saltarGroups = await groupEntries(perfil, saltarEntries);
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_group_saltar_failed", err: String(err) }));
  }

  const headerLines = [`📰 <b>Feedbin</b> — ${unread.length} sin leer`, carpetaLine, ""];
  headerLines.push(`<b>✅ Para abrir</b> (${abrirEntries.length})`);
  if (abrirEntries.length === 0) {
    headerLines.push("<i>Nada para abrir hoy.</i>");
  } else if (abrirGroups.length > 0) {
    headerLines.push(renderAbrirSection(abrirGroups, entryById));
  } else {
    headerLines.push(
      abrirEntries
        .slice(0, ABRIR_FALLBACK_LIMIT)
        .map((e) => `• <a href="${feedbinEntryUrl(e.id)}">${esc(e.title ?? "(sin título)")}</a>`)
        .join("\n"),
    );
  }
  const headerText = headerLines.join("\n");

  let text = headerText;
  let keyboard: Keyboard | undefined;

  if (saltarEntries.length > 0) {
    if (saltarGroups.length > 0) {
      const buttons = selectMarkButtons(saltarGroups);
      const store = new FeedbinReportStore(kv);
      const reportId = await store.createReport({ headerText, buttons });
      text = buildReportText(headerText, buttons);
      keyboard = buildKeyboard(reportId, buttons);
    } else {
      text = `${headerText}\n\n<b>⏭️ Marcar como leído</b> (${saltarEntries.length}) — no pude agrupar, revisalo directo en Feedbin.`;
    }
  }

  try {
    await sendCronMessage(botToken, { chatId, text, replyMarkup: keyboard });
    console.log(JSON.stringify({
      ts: Date.now(),
      msg: "feedbin_daily_report_sent",
      unreadCount: unread.length,
      abrirCount: abrirEntries.length,
      saltarCount: saltarEntries.length,
    }));
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_send_failed", err: String(err) }));
  }
}
