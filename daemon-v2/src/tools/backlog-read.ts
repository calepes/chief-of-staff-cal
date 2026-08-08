// tools/backlog-read.ts — lectura de backlogs: conteo, mapa y vista compacta.
//
// La vista es COMPACTA a propósito. El BACKLOG.md de Jano son 287 líneas (~30 KB), por encima
// del umbral de ~25 KB en el que el SDK persiste el tool result a disco y el modelo entra en el
// loop de reintentos (gotcha documentado en CLAUDE.md). Mismo criterio que compactJournalRows.

import { readFileSync } from "node:fs";
import type { BacklogEntry, BacklogMapRow, CompactBacklog, BacklogItem } from "../backlog-types.js";

const PENDING_RE = /^\s*-\s\[ \]\s?(.*)$/;
const DONE_RE = /^\s*-\s\[[xX]\]/;
const SECTION_RE = /^###\s+(.*)$/;
/** Tope por ítem. Suficiente para reconocerlo y decidir, sin arrastrar párrafos enteros. */
const MAX_ITEM_CHARS = 200;
/** Tope de cantidad de ítems devueltos. Mismo criterio que MAX_ITEM_CHARS — un backlog con
 *  decenas de pendientes no necesita venir completo para que el modelo lo pueda discutir. */
const MAX_ITEMS = 40;

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
}

export function countPending(path: string): number {
  return readLines(path).filter((l) => PENDING_RE.test(l)).length;
}

export function readBacklogCompact(path: string, key: string, label: string): CompactBacklog {
  const items: BacklogItem[] = [];
  let section = "";

  for (const line of readLines(path)) {
    const sec = SECTION_RE.exec(line);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    if (DONE_RE.test(line)) continue;
    const m = PENDING_RE.exec(line);
    if (!m) continue;
    const raw = m[1].trim();
    items.push({
      section,
      text: raw.length > MAX_ITEM_CHARS ? `${raw.slice(0, MAX_ITEM_CHARS)}…` : raw,
    });
  }

  const total = items.length;
  const sliced = items.slice(0, MAX_ITEMS);
  return { key, label, total, items: sliced, truncated: sliced.length < total };
}

export function buildBacklogMap(entries: BacklogEntry[]): BacklogMapRow[] {
  return entries
    .map((e) => ({ ...e, pending: countPending(e.path) }))
    .filter((r) => r.pending > 0);
}
