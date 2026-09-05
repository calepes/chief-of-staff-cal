// feedbin-report-callbacks.ts — handlers de los callbacks fbr:mark:*/fbr:undo:* de la tarjeta
// del reporte diario de Feedbin. HEAVY (llaman a la API real de Feedbin), mismo lock
// anti-doble-tap que jnl:*/bklg:*/lrn:*/tsk:* en index.ts.

import type { FeedbinCreds } from "../tools/feedbin-client.js";
import { buildKeyboard, buildReportText, type Card } from "./feedbin-report-card.js";
import type { FeedbinReportStore } from "./feedbin-report-store.js";

const UNDO_TTL_MS = 10 * 60 * 1000;

export interface ParsedFeedbinReportCallback {
  action: "mark" | "undo";
  reportId: string;
  buttonId: string;
}

export function isFeedbinReportCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith("fbr:");
}

export function parseFeedbinReportCallback(data: string): ParsedFeedbinReportCallback | null {
  const parts = data.split(":");
  if (parts[0] !== "fbr" || (parts[1] !== "mark" && parts[1] !== "undo") || !parts[2] || !parts[3]) return null;
  return { action: parts[1], reportId: parts[2], buttonId: parts[3] };
}

export interface FeedbinReportCallbackDeps {
  store: FeedbinReportStore;
  feedbin: FeedbinCreds;
  markEntriesRead: (creds: FeedbinCreds, ids: number[]) => Promise<void>;
  markEntriesUnread: (creds: FeedbinCreds, ids: number[]) => Promise<void>;
  log: (obj: Record<string, unknown>) => void;
  editCard: (messageId: number, card: Card) => Promise<void>;
}

export async function handleFeedbinReportCallback(
  deps: FeedbinReportCallbackDeps,
  messageId: number,
  data: string,
): Promise<void> {
  const parsed = parseFeedbinReportCallback(data);
  if (!parsed) return;
  const { action, reportId, buttonId } = parsed;

  const proposal = await deps.store.getReport(reportId);
  if (!proposal) {
    await deps.editCard(messageId, { text: "⏳ Esto expiró, corré el reporte de nuevo.", keyboard: { inline_keyboard: [] } });
    return;
  }

  const button = proposal.buttons.find((b) => b.id === buttonId);
  if (!button) return;

  if (action === "mark") {
    try {
      await deps.markEntriesRead(deps.feedbin, button.entryIds);
    } catch (err) {
      deps.log({ msg: "feedbin_report_mark_failed", reportId, buttonId, err: String(err) });
      await deps.editCard(messageId, {
        text: `${buildReportText(proposal.headerText, proposal.buttons)}\n\n⚠️ No pude marcar "${button.label}" — reintentá tocando el botón de nuevo.`,
        keyboard: buildKeyboard(reportId, proposal.buttons),
      });
      return;
    }
    button.markedAt = Date.now();
    await deps.store.updateReport(reportId, proposal);
    await deps.editCard(messageId, {
      text: buildReportText(proposal.headerText, proposal.buttons),
      keyboard: buildKeyboard(reportId, proposal.buttons),
    });
    return;
  }

  // action === "undo"
  if (button.markedAt > 0 && Date.now() - button.markedAt < UNDO_TTL_MS) {
    try {
      await deps.markEntriesUnread(deps.feedbin, button.entryIds);
      button.markedAt = 0;
      await deps.store.updateReport(reportId, proposal);
    } catch (err) {
      deps.log({ msg: "feedbin_report_undo_failed", reportId, buttonId, err: String(err) });
    }
  } else {
    deps.log({ msg: "feedbin_report_undo_expired_or_missing", reportId, buttonId });
  }

  // Re-renderiza siempre — si la ventana de deshacer venció, buildKeyboard ya omite ese botón
  // por su cuenta, así la tarjeta queda consistente con el estado real sin un mensaje aparte.
  await deps.editCard(messageId, {
    text: buildReportText(proposal.headerText, proposal.buttons),
    keyboard: buildKeyboard(reportId, proposal.buttons),
  });
}
