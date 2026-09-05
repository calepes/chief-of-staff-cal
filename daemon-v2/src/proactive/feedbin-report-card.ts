// feedbin-report-card.ts — render PURO de la tarjeta del reporte diario de Feedbin: la sección
// "para abrir" (informativa, sin botones) y la de "marcar leído" (con botones por grupo). Sin
// red ni estado — entran grupos ya resueltos, sale texto/teclado. Parse mode HTML (skill
// telegram-bot-ux): escapar solo < > &, sin Markdown.

import type { FeedbinEntry } from "../tools/feedbin-client.js";
import { feedbinEntryUrl } from "../tools/feedbin-client.js";
import type { ThemeGroup } from "./feedbin-report-groups.js";

export interface Keyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface Card {
  text: string;
  keyboard: Keyboard;
}

/** Un grupo de "marcar leído" con botón propio. `markedAt` 0 = sin marcar; si no, epoch ms de
 * cuándo se marcó (para saber si el `↩️ Deshacer` sigue dentro de su ventana de 10 min). */
export interface FeedbinReportButton {
  id: string;
  label: string;
  count: number;
  entryIds: number[];
  markedAt: number;
}

const ABRIR_ITEMS_PER_GROUP = 5;
const MAX_MARK_BUTTONS = 6;
const UNDO_TTL_MS = 10 * 60 * 1000;
const BUTTON_LABEL_MAX = 18;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateLabel(label: string): string {
  return label.length > BUTTON_LABEL_MAX ? `${label.slice(0, BUTTON_LABEL_MAX - 1)}…` : label;
}

/** Grupos más grandes primero; empate por label para un orden estable/testeable. */
function sortBySize(groups: ThemeGroup[]): ThemeGroup[] {
  return [...groups].sort((a, b) => b.entryIds.length - a.entryIds.length || a.label.localeCompare(b.label));
}

/** Sección "✅ Para abrir": TODOS los grupos, cada uno con hasta 5 links + "...y N más". */
export function renderAbrirSection(groups: ThemeGroup[], entryById: Map<number, FeedbinEntry>): string {
  if (groups.length === 0) return "";

  const lines: string[] = [];
  for (const group of sortBySize(groups)) {
    const entries = group.entryIds.map((id) => entryById.get(id)).filter((e): e is FeedbinEntry => Boolean(e));
    if (entries.length === 0) continue;
    lines.push(`<b>${esc(group.label)}</b> (${entries.length})`);
    for (const e of entries.slice(0, ABRIR_ITEMS_PER_GROUP)) {
      lines.push(`• <a href="${feedbinEntryUrl(e.id)}">${esc(e.title ?? "(sin título)")}</a>`);
    }
    if (entries.length > ABRIR_ITEMS_PER_GROUP) {
      lines.push(`<i>...y ${entries.length - ABRIR_ITEMS_PER_GROUP} más</i>`);
    }
  }
  return lines.join("\n");
}

/** Hasta MAX_MARK_BUTTONS grupos con botón propio (los más grandes); el resto se pliega en un
 * único botón "resto" si sobra algo. */
export function selectMarkButtons(groups: ThemeGroup[]): FeedbinReportButton[] {
  const sorted = sortBySize(groups);
  const top = sorted.slice(0, MAX_MARK_BUTTONS);
  const overflow = sorted.slice(MAX_MARK_BUTTONS);

  const buttons: FeedbinReportButton[] = top.map((g, i) => ({
    id: `g${i + 1}`,
    label: g.label,
    count: g.entryIds.length,
    entryIds: g.entryIds,
    markedAt: 0,
  }));

  if (overflow.length > 0) {
    buttons.push({
      id: "resto",
      label: "el resto",
      count: overflow.reduce((sum, g) => sum + g.entryIds.length, 0),
      entryIds: overflow.flatMap((g) => g.entryIds),
      markedAt: 0,
    });
  }

  return buttons;
}

/** Texto de la sección "⏭️ Marcar como leído" — refleja el estado actual (marcado o no). */
export function buildMarkSection(buttons: FeedbinReportButton[]): string {
  if (buttons.length === 0) return "";
  const lines = ["<b>⏭️ Marcar como leído</b>"];
  for (const b of buttons) {
    lines.push(
      b.markedAt > 0
        ? `✅ <s>${esc(b.label)}</s> — marcado (${b.count})`
        : `${esc(b.label)} (${b.count})`,
    );
  }
  return lines.join("\n");
}

/** Teclado inline: un botón "✅" por grupo sin marcar, "↩️ Deshacer" si se marcó hace <10 min,
 * y nada (fila más corta) si ya venció la ventana de deshacer. 2 botones por fila. */
export function buildKeyboard(reportId: string, buttons: FeedbinReportButton[]): Keyboard {
  const now = Date.now();
  const cells = buttons
    .map((b): { text: string; callback_data: string } | null => {
      if (b.markedAt === 0) {
        return { text: `✅ ${truncateLabel(b.label)} (${b.count})`, callback_data: `fbr:mark:${reportId}:${b.id}` };
      }
      if (now - b.markedAt < UNDO_TTL_MS) {
        return { text: "↩️ Deshacer", callback_data: `fbr:undo:${reportId}:${b.id}` };
      }
      return null;
    })
    .filter((c): c is { text: string; callback_data: string } => c !== null);

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(cells.slice(i, i + 2));
  return { inline_keyboard: rows };
}

/** Arma el texto completo del mensaje: header fijo (para abrir, ya renderizado) + la sección de
 * marcar leído (que sí cambia con cada mark/undo). */
export function buildReportText(headerText: string, buttons: FeedbinReportButton[]): string {
  const markSection = buildMarkSection(buttons);
  return markSection ? `${headerText}\n\n${markSection}` : headerText;
}
