// Pure module: builds the tappable fuel-monitor menu (text + inline keyboard).
// No I/O. Used by the daemon (initial render) and the CF worker (callbacks).

export interface FuelStation {
  name: string;
  company: string;
  enabled: boolean;
  minLitros: number;
  litros: number;
  available: boolean;
  since: number | null;
}

export const FUEL_COMPANIES = ["Genex", "Biopetrol", "Orsa", "Rivero"];

const PAGE_SIZE = 8;

interface InlineButton {
  text: string;
  callback_data: string;
}
interface Keyboard {
  inline_keyboard: InlineButton[][];
}

function litrosCompact(litros: number): string {
  if (litros >= 1000) return `${Math.round(litros / 100) / 10}k`;
  return String(litros);
}

function truncName(name: string, max = 14): string {
  if (name.length <= max) return name;
  return name.slice(0, max - 1) + "…";
}

function stationLabel(s: FuelStation): string {
  return `${s.enabled ? "✅" : "⬜"} ${truncName(s.name)} ${litrosCompact(s.litros)}`;
}

function escapeHtmlLocal(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildFuelMenu(
  stations: FuelStation[],
  view: string,
): { text: string; keyboard: Keyboard } {
  const parts = (view || "r").split(":");
  const kind = parts[0];

  // ── Root view ──────────────────────────────────────────────────────────────
  if (kind === "r" || (kind !== "c" && kind !== "m")) {
    const enabled = stations.filter((s) => s.enabled);
    const enabledNames = enabled.length > 0 ? enabled.map((s) => s.name).join(", ") : "ninguna";
    const text = [
      "⛽ <b>Monitor de combustible</b>",
      `Activas: ${escapeHtmlLocal(enabledNames)}`,
      "Umbral por estación · toca una empresa",
    ].join("\n");

    const rows: InlineButton[][] = [];
    for (let i = 0; i < FUEL_COMPANIES.length; i += 2) {
      const row: InlineButton[] = [
        { text: FUEL_COMPANIES[i], callback_data: `jf:c:${i}` },
      ];
      if (i + 1 < FUEL_COMPANIES.length) {
        row.push({ text: FUEL_COMPANIES[i + 1], callback_data: `jf:c:${i + 1}` });
      }
      rows.push(row);
    }
    rows.push([{ text: `✅ Monitoreadas (${enabled.length})`, callback_data: "jf:m" }]);

    return { text, keyboard: { inline_keyboard: rows } };
  }

  // ── Company view ─────────────────────────────────────────────────────────────
  if (kind === "c") {
    const ci = Number(parts[1]) || 0;
    const page = Number(parts[2]) || 0;
    const company = FUEL_COMPANIES[ci] ?? FUEL_COMPANIES[0];

    const text = `⛽ <b>${escapeHtmlLocal(company)}</b> — toca para activar/desactivar`;

    // Keep global indices for toggle callbacks.
    const matches = stations
      .map((s, idx) => ({ s, idx }))
      .filter(({ s }) => s.company === FUEL_COMPANIES[ci]);

    const start = page * PAGE_SIZE;
    const pageItems = matches.slice(start, start + PAGE_SIZE);
    const hasMore = start + PAGE_SIZE < matches.length;

    const rows: InlineButton[][] = pageItems.map(({ s, idx }) => [
      { text: stationLabel(s), callback_data: `jf:t:${idx}:c:${ci}:${page}` },
    ]);

    const nav: InlineButton[] = [{ text: "⬅️ Atrás", callback_data: "jf:r" }];
    if (page > 0) nav.push({ text: "‹", callback_data: `jf:c:${ci}:${page - 1}` });
    if (hasMore) nav.push({ text: "›", callback_data: `jf:c:${ci}:${page + 1}` });
    rows.push(nav);

    return { text, keyboard: { inline_keyboard: rows } };
  }

  // ── Monitored view ───────────────────────────────────────────────────────────
  // kind === "m"
  const monitored = stations
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => s.enabled === true);

  if (monitored.length === 0) {
    return {
      text: "⛽ <b>Monitoreadas</b>\nNo hay estaciones monitoreadas.",
      keyboard: { inline_keyboard: [[{ text: "⬅️ Atrás", callback_data: "jf:r" }]] },
    };
  }

  const text = "⛽ <b>Monitoreadas</b> — toca para desactivar";
  const rows: InlineButton[][] = monitored.map(({ s, idx }) => [
    { text: stationLabel(s), callback_data: `jf:t:${idx}:m` },
  ]);
  rows.push([{ text: "⬅️ Atrás", callback_data: "jf:r" }]);

  return { text, keyboard: { inline_keyboard: rows } };
}
