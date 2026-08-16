// lending-date-confirm.ts — cuando el cuerpo del mail de "Funnel Yape Lending" no trae la fecha
// del reporte (ej. quien reenvía cambia "cierre de la jornada de AAAA-MM-DD" por una redacción sin
// fecha explícita, como pasó el 2026-08-11), en vez de reintentar en silencio cada 15 min hasta que
// el mail sale de la ventana de búsqueda de Gmail (3 días) sin ningún aviso final, se propone una
// tarjeta con una fecha sugerida y Cal confirma/corrige/ignora — mismo patrón `propose → botones`
// que Tasks/Journal (ver Jano/CLAUDE.md).
//
// Deliberadamente MÁS simple que task-store.ts/task-callbacks.ts: acá no hay cola ni picker de
// personas, solo un valor (la fecha) a confirmar — un solo archivo alcanza.

import type { CfKv } from "../cf-kv.js";
import { addDays, dayOfWeek, parseWrittenDate } from "./task-dates.js";

const PROPOSAL_TTL_SEC = 3 * 24 * 60 * 60; // misma ventana que la búsqueda de Gmail (newer_than:3d)
const PENDING_INPUT_TTL_SEC = 10 * 60;

export interface LendingDateProposal {
  messageId: string;
  suggestedFecha: string;
  subject: string;
}

export interface LendingPendingInput {
  shortId: string;
  /** message_id de la tarjeta que preguntó — se le quita el teclado al resolver por texto libre
   * (mismo motivo que TaskPendingInput.anchorMessageId: la respuesta nace en un mensaje NUEVO). */
  anchorMessageId: number;
}

export class LendingDateStore {
  constructor(private kv: CfKv) {}

  private propKey(chatId: number, shortId: string): string {
    return `jano:lend:prop:${chatId}:${shortId}`;
  }

  private inputKey(chatId: number): string {
    return `jano:lend:input:${chatId}`;
  }

  async createProposal(chatId: number, payload: LendingDateProposal): Promise<string> {
    const shortId = Math.random().toString(36).slice(2, 10);
    await this.kv.set(this.propKey(chatId, shortId), payload, PROPOSAL_TTL_SEC);
    return shortId;
  }

  async getProposal(chatId: number, shortId: string): Promise<LendingDateProposal | null> {
    return await this.kv.get<LendingDateProposal>(this.propKey(chatId, shortId));
  }

  async clearProposal(chatId: number, shortId: string): Promise<void> {
    await this.kv.delete(this.propKey(chatId, shortId));
  }

  async setPendingInput(chatId: number, pending: LendingPendingInput): Promise<void> {
    await this.kv.set(this.inputKey(chatId), pending, PENDING_INPUT_TTL_SEC);
  }

  async getPendingInput(chatId: number): Promise<LendingPendingInput | null> {
    return await this.kv.get<LendingPendingInput>(this.inputKey(chatId));
  }

  async clearPendingInput(chatId: number): Promise<void> {
    await this.kv.delete(this.inputKey(chatId));
  }
}

/** Día hábil anterior (salta fin de semana) — mejor estimación disponible cuando el mail no trae
 * fecha explícita: "cierre de la anterior jornada" se refiere casi siempre al último día hábil
 * antes de armarse el reporte. Es una SUGERENCIA — nunca se escribe a Notion sin que Cal confirme. */
export function previousBusinessDay(iso: string): string {
  let d = addDays(iso, -1);
  while (dayOfWeek(d) === 0 || dayOfWeek(d) === 6) d = addDays(d, -1);
  return d;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface Card {
  text: string;
  keyboard: { inline_keyboard: { text: string; callback_data: string }[][] };
}

export function renderProposeCard(shortId: string, suggestedFecha: string, subject: string): Card {
  return {
    text: [
      "⚠️ <b>No pude leer la fecha del Funnel Yape Lending</b>",
      `Asunto: ${escapeHtml(subject)}`,
      'El cuerpo del mail no trae "cierre de la jornada de AAAA-MM-DD" (¿cambió la redacción?).',
      "",
      `📅 Mi mejor estimación: <b>${escapeHtml(suggestedFecha)}</b> (día hábil anterior al mail)`,
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        [{ text: `✅ Confirmar ${suggestedFecha}`, callback_data: `lend:ok:${shortId}` }],
        [{ text: "✍️ Escribir otra fecha", callback_data: `lend:wr:${shortId}` }],
        [{ text: "🚫 Ignorar este mail", callback_data: `lend:no:${shortId}` }],
      ],
    },
  };
}

function renderAskDate(shortId: string): Card {
  return {
    text: "✍️ Escribime la fecha del reporte (AAAA-MM-DD, dd/mm, o el día de la semana).",
    keyboard: { inline_keyboard: [[{ text: "⬅️ Atrás", callback_data: `lend:back:${shortId}` }]] },
  };
}

function renderIgnored(fecha: string): Card {
  return { text: `🚫 Ignorado — no se cargó el Funnel Lending de ${escapeHtml(fecha)} (estimado).`, keyboard: { inline_keyboard: [] } };
}

function renderExpired(): Card {
  return { text: "⌛ Esta propuesta ya venció.", keyboard: { inline_keyboard: [] } };
}

function renderLoading(fecha: string): Card {
  return { text: `⏳ Cargando el Funnel Lending del ${escapeHtml(fecha)}…`, keyboard: { inline_keyboard: [] } };
}

function renderIngestFailed(fecha: string, motivo: string): Card {
  return { text: `❌ No pude cargar el Funnel Lending del ${escapeHtml(fecha)}: ${escapeHtml(motivo)}`, keyboard: { inline_keyboard: [] } };
}

function renderIngestOk(fecha: string): Card {
  return { text: `✅ Cargado — Funnel Lending del ${escapeHtml(fecha)}.`, keyboard: { inline_keyboard: [] } };
}

export function isLendingDateCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith("lend:");
}

interface ParsedCallback {
  action: string;
  shortId: string;
}

function parseLendingDateCallback(data: string): ParsedCallback | null {
  const parts = data.split(":");
  if (parts[0] !== "lend" || !parts[1] || !parts[2]) return null;
  return { action: parts[1]!, shortId: parts[2]! };
}

export interface LendingDateCallbackDeps {
  store: LendingDateStore;
  /** Baja el mail de nuevo por id, parsea/reconcilia/escribe — igual pipeline que el camino
   * automático. DEBE tirar si el reporte no se pudo cargar (sin PDF adjunto, reconciliación que no
   * cierra, o un error de red/Gmail) — el caller solo pinta "✅ Cargado" cuando esta promesa
   * resuelve sin excepción, así que tragarse un fallo acá pintaría éxito sobre un error real. */
  ingest: (messageId: string, fecha: string) => Promise<void>;
  editCard: (messageId: number, card: Card) => Promise<void>;
  log: (obj: Record<string, unknown>) => void;
}

/** Procesa un callback lend:*. */
export async function handleLendingDateCallback(
  deps: LendingDateCallbackDeps,
  chatId: number,
  messageId: number,
  data: string,
): Promise<void> {
  const parsed = parseLendingDateCallback(data);
  if (!parsed) return;
  const { action, shortId } = parsed;

  const p = await deps.store.getProposal(chatId, shortId);
  if (!p && action !== "no") {
    await deps.editCard(messageId, renderExpired());
    return;
  }

  switch (action) {
    case "back":
      await deps.store.clearPendingInput(chatId);
      await deps.editCard(messageId, renderProposeCard(shortId, p!.suggestedFecha, p!.subject));
      return;

    case "wr":
      await deps.store.setPendingInput(chatId, { shortId, anchorMessageId: messageId });
      await deps.editCard(messageId, renderAskDate(shortId));
      return;

    case "no":
      await deps.store.clearPendingInput(chatId);
      if (p) await deps.store.clearProposal(chatId, shortId);
      deps.log({ msg: "lending_date_proposal_ignored", shortId, messageId: p?.messageId });
      await deps.editCard(messageId, renderIgnored(p?.suggestedFecha ?? "?"));
      return;

    case "ok": {
      await deps.store.clearPendingInput(chatId);
      const fecha = p!.suggestedFecha;
      await deps.editCard(messageId, renderLoading(fecha));
      try {
        await deps.ingest(p!.messageId, fecha);
        await deps.store.clearProposal(chatId, shortId);
        await deps.editCard(messageId, renderIngestOk(fecha));
      } catch (err) {
        deps.log({ msg: "lending_date_confirm_ingest_failed", shortId, err: String(err) });
        await deps.editCard(messageId, renderIngestFailed(fecha, String(err)));
      }
      return;
    }

    default:
      deps.log({ msg: "lending_date_unknown_action", action });
      return;
  }
}

export interface LendingDateInputDeps {
  store: LendingDateStore;
  ingest: (messageId: string, fecha: string) => Promise<void>;
  today: () => string;
  log: (obj: Record<string, unknown>) => void;
  clearKeyboard: (messageId: number) => Promise<void>;
  sendCard: (card: Card) => Promise<void>;
}

const CANCELAR = new Set(["cancelar", "cancela", "olvidalo", "olvídalo", "dejalo", "déjalo"]);

/**
 * Texto libre que responde al botón ✍️ de la tarjeta de confirmación de fecha.
 *
 * Devuelve `true` solo si consumió el mensaje. Si el texto no parsea como fecha, NO lo consume:
 * sigue su curso normal hacia el agente — mismo criterio que applyTaskInput (evita que este estado
 * se trague un pedido real de Cal).
 */
export async function applyLendingDateInput(
  deps: LendingDateInputDeps,
  chatId: number,
  text: string,
  prefetched?: LendingPendingInput | null,
): Promise<boolean> {
  const pending = prefetched !== undefined ? prefetched : await deps.store.getPendingInput(chatId);
  if (!pending) return false;

  const p = await deps.store.getProposal(chatId, pending.shortId);
  if (!p) {
    await deps.store.clearPendingInput(chatId);
    return false;
  }

  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  if (CANCELAR.has(normalized)) {
    await deps.store.clearPendingInput(chatId);
    await deps.clearKeyboard(pending.anchorMessageId);
    await deps.sendCard(renderProposeCard(pending.shortId, p.suggestedFecha, p.subject));
    return true;
  }

  const parsed = parseWrittenDate(text, deps.today());
  if (!parsed || parsed.date == null) return false; // no era una fecha → que lo conteste el agente

  const fecha = parsed.date;
  await deps.store.clearPendingInput(chatId);
  await deps.clearKeyboard(pending.anchorMessageId);
  await deps.sendCard(renderLoading(fecha));
  try {
    await deps.ingest(p.messageId, fecha);
    await deps.store.clearProposal(chatId, pending.shortId);
    await deps.sendCard(renderIngestOk(fecha));
  } catch (err) {
    deps.log({ msg: "lending_date_confirm_ingest_failed", shortId: pending.shortId, err: String(err) });
    await deps.sendCard(renderIngestFailed(fecha, String(err)));
  }
  return true;
}
