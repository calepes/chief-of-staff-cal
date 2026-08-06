import { readFileSync, writeFileSync } from "node:fs";
import { sendCronMessage } from "./rich-send.js";
import { gmailAccessToken, searchDailyNoteEmails, getGmailMessage, type GmailCreds } from "./kpi-ingest-gmail.js";
import { hasDnTag, stripDnTag, htmlToMarkdown, createDailyNotePage } from "./daily-note-ingest.js";
import { nowInLaPaz } from "../journal-capture.js";

const ERROR_DEDUP_MS = 2 * 60 * 60 * 1000;
const MAX_PROCESSED = 200;

export interface DailyNoteState {
  processed: string[];
  lastErrorNotified: Record<string, number>;
}

export function defaultDailyNoteStatePath(): string {
  return `${process.env.HOME}/.cos-agent/daily-note-state.json`;
}

export function readDailyNoteState(path: string): DailyNoteState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DailyNoteState>;
    return { processed: parsed.processed ?? [], lastErrorNotified: parsed.lastErrorNotified ?? {} };
  } catch {
    return { processed: [], lastErrorNotified: {} };
  }
}

export function writeDailyNoteState(path: string, state: DailyNoteState): void {
  try {
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch {
    /* noop */
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// nunca toISOString() directo acá: eso da la fecha en UTC, y La Paz es UTC-4 — un mail recibido
// entre las 20:00 y medianoche hora local quedaría fechado al día siguiente. nowInLaPaz() ya
// resuelve el offset fijo -04:00 (ver journal-capture.ts). Mismo bug encontrado y arreglado en
// task-check.ts (2026-07-28) — portado acá por pedido de Cal.
function isoDateFromMillis(ms: number): string {
  return nowInLaPaz(new Date(ms)).slice(0, 10);
}

export interface CheckDailyNotesOpts {
  botToken: string;
  chatId: number;
  notionToken: string;
  gmail: GmailCreds;
  /** Override para tests — default: `~/.cos-agent/daily-note-state.json`. */
  statePath?: string;
}

let running = false;

/**
 * A diferencia de los pipelines de KPIs (kpi-ingest-check.ts), este NO espera ningún reporte
 * "gemelo" — un mail (DN) es una unidad autónoma que Cal reenvió a mano, así que se procesa
 * apenas se detecta, sin el delay de WAIT_MS ni estado "pending". Por eso tampoco comparte
 * `kpi-ingest-state.json` — es un dominio (notas personales, no KPIs) y un ciclo de vida
 * (inmediato, no diferido) distintos.
 */
export async function checkDailyNotes(opts: CheckDailyNotesOpts): Promise<void> {
  if (running) {
    console.error(JSON.stringify({ ts: Date.now(), msg: "daily_note_check_overlap_skipped" }));
    return;
  }
  running = true;
  try {
    const statePath = opts.statePath ?? defaultDailyNoteStatePath();
    const state = readDailyNoteState(statePath);

    let messageIds: string[];
    try {
      const token = await gmailAccessToken(opts.gmail);
      const found = await searchDailyNoteEmails(token);
      messageIds = found.map((m) => m.id);
    } catch (err) {
      console.error(JSON.stringify({ ts: Date.now(), msg: "daily_note_search_error", err: String(err) }));
      return;
    }

    for (const id of messageIds) {
      if (state.processed.includes(id)) continue;
      await processDailyNoteMessage(id, state, opts);
      writeDailyNoteState(statePath, state);
    }

    if (state.processed.length > MAX_PROCESSED) {
      state.processed = state.processed.slice(-MAX_PROCESSED);
      writeDailyNoteState(statePath, state);
    }
  } finally {
    running = false;
  }
}

async function processDailyNoteMessage(id: string, state: DailyNoteState, opts: CheckDailyNotesOpts): Promise<void> {
  const { botToken, chatId, notionToken, gmail } = opts;
  try {
    const token = await gmailAccessToken(gmail);
    const detail = await getGmailMessage(id, token);

    const subject = detail.subject ?? "";
    if (!hasDnTag(subject)) {
      // No debería pasar (searchDailyNoteEmails ya filtra por subject) — pero nunca asumir sin
      // verificar: un false positive de la búsqueda de Gmail no debe crear una nota fantasma.
      // A diferencia de un fallo transitorio (red, Notion caído), este resultado es DETERMINISTA
      // — el subject no va a cambiar en el próximo tick — así que reintentar solo espamearía a
      // Cal cada 2h durante los 3 días de la ventana de búsqueda sin nunca resolverse. Se marca
      // processed de una, se loguea, y NO se notifica por Telegram (no es una falla real).
      console.error(JSON.stringify({ ts: Date.now(), msg: "daily_note_tag_mismatch_skipped", id, subject }));
      markProcessed(state, id);
      return;
    }
    const title = stripDnTag(subject) || `Nota sin asunto (${id})`;
    const fecha = isoDateFromMillis(detail.internalDate);

    const bodyMarkdown = detail.bodyHtml ? htmlToMarkdown(detail.bodyHtml) : (detail.bodyText ?? "").trim();
    if (!bodyMarkdown) {
      throw new Error("el mail no tiene cuerpo de texto legible (ni text/plain ni text/html)");
    }

    const result = await createDailyNotePage(notionToken, { title, fecha, bodyMarkdown });

    console.log(JSON.stringify({ ts: Date.now(), msg: "daily_note_created", id, fecha, title, pageId: result.pageId }));
    await sendReport(botToken, chatId, `✅ <b>Daily Note guardada</b>\n📅 ${escapeHtml(fecha)}\n📝 ${escapeHtml(title)}`);
    markProcessed(state, id);
  } catch (err) {
    const now = Date.now();
    const last = state.lastErrorNotified[id] ?? 0;
    if (now - last >= ERROR_DEDUP_MS) {
      await sendReport(
        botToken,
        chatId,
        `⚠️ <b>No pude guardar la Daily Note</b>\n${escapeHtml(String(err))}\nReintento automático en el próximo tick.`,
      );
      state.lastErrorNotified[id] = now;
    }
    console.error(JSON.stringify({ ts: Date.now(), msg: "daily_note_process_error", id, err: String(err) }));
  }
}

function markProcessed(state: DailyNoteState, id: string): void {
  state.processed.push(id);
  delete state.lastErrorNotified[id];
}

async function sendReport(botToken: string, chatId: number, text: string): Promise<void> {
  try {
    await sendCronMessage(botToken, { chatId, text });
  } catch (err) {
    console.error(JSON.stringify({ ts: Date.now(), msg: "daily_note_report_send_failed", err: String(err) }));
  }
}
