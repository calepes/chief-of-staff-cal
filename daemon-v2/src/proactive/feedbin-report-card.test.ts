import { describe, it, expect, vi } from "vitest";
import { renderAbrirSection, selectMarkButtons, buildMarkSection, buildKeyboard, buildReportText, type FeedbinReportButton } from "./feedbin-report-card.js";
import type { ThemeGroup } from "./feedbin-report-groups.js";
import type { FeedbinEntry } from "../tools/feedbin-client.js";

function entry(id: number, title: string): FeedbinEntry {
  return { id, feed_id: 1, title, url: "u", author: null, summary: null, published: "2026-01-01" };
}

function entryById(entries: FeedbinEntry[]): Map<number, FeedbinEntry> {
  return new Map(entries.map((e) => [e.id, e]));
}

describe("renderAbrirSection", () => {
  it("returns '' for no groups", () => {
    expect(renderAbrirSection([], new Map())).toBe("");
  });

  it("lists up to 5 items per group with a link, largest group first", () => {
    const entries = Array.from({ length: 7 }, (_, i) => entry(i + 1, `Título ${i + 1}`));
    const groups: ThemeGroup[] = [
      { label: "Chico", entryIds: [1] },
      { label: "Grande", entryIds: [2, 3, 4, 5, 6, 7, 100] }, // 100 no resuelve en entryById, se ignora
    ];

    const text = renderAbrirSection(groups, entryById(entries));

    const grandeIdx = text.indexOf("Grande");
    const chicoIdx = text.indexOf("Chico");
    expect(grandeIdx).toBeGreaterThanOrEqual(0);
    expect(grandeIdx).toBeLessThan(chicoIdx);
    expect(text).toContain("Grande</b> (6)"); // 100 se descarta, quedan 6 reales
    expect(text).toContain("...y 1 más");
    expect(text).toContain("Título 2");
    expect(text).not.toContain("Título 7"); // 6to item del grupo grande, fuera del tope de 5
  });

  it("escapes & < > in group labels and titles", () => {
    const entries = [entry(1, "A & B <script>")];
    const groups: ThemeGroup[] = [{ label: "Tema & raro", entryIds: [1] }];

    const text = renderAbrirSection(groups, entryById(entries));

    expect(text).toContain("Tema &amp; raro");
    expect(text).toContain("A &amp; B &lt;script&gt;");
  });
});

describe("selectMarkButtons", () => {
  it("returns one button per group, largest first, when there are 6 or fewer", () => {
    const groups: ThemeGroup[] = [
      { label: "Chico", entryIds: [1] },
      { label: "Grande", entryIds: [2, 3] },
    ];

    const buttons = selectMarkButtons(groups);

    expect(buttons).toEqual([
      { id: "g1", label: "Grande", count: 2, entryIds: [2, 3], markedAt: 0 },
      { id: "g2", label: "Chico", count: 1, entryIds: [1], markedAt: 0 },
    ]);
  });

  it("caps at 6 group buttons and folds the rest into a 'resto' bucket", () => {
    const groups: ThemeGroup[] = Array.from({ length: 8 }, (_, i) => ({
      label: `Tema ${i}`,
      entryIds: [i], // todos tamaño 1, orden estable por label
    }));

    const buttons = selectMarkButtons(groups);

    expect(buttons).toHaveLength(7); // 6 + resto
    expect(buttons[6]).toMatchObject({ id: "resto", count: 2 }); // 2 grupos sobrantes, 1 item c/u
  });

  it("does not add a 'resto' bucket when there are 6 or fewer groups", () => {
    const groups: ThemeGroup[] = Array.from({ length: 6 }, (_, i) => ({ label: `Tema ${i}`, entryIds: [i] }));
    const buttons = selectMarkButtons(groups);
    expect(buttons.find((b) => b.id === "resto")).toBeUndefined();
    expect(buttons).toHaveLength(6);
  });
});

const BTN: FeedbinReportButton = { id: "g1", label: "Rumores Apple", count: 66, entryIds: [1, 2], markedAt: 0 };

describe("buildMarkSection", () => {
  it("returns '' for no buttons", () => {
    expect(buildMarkSection([])).toBe("");
  });

  it("shows the plain label+count when unmarked", () => {
    const text = buildMarkSection([BTN]);
    expect(text).toContain("Rumores Apple (66)");
    expect(text).not.toContain("✅");
  });

  it("shows a struck-through 'marcado' line once marked", () => {
    const text = buildMarkSection([{ ...BTN, markedAt: Date.now() }]);
    expect(text).toContain("✅ <s>Rumores Apple</s> — marcado (66)");
  });
});

describe("buildKeyboard", () => {
  it("emits a mark button per unmarked group, 2 per row", () => {
    const buttons: FeedbinReportButton[] = [
      { id: "g1", label: "Uno", count: 1, entryIds: [1], markedAt: 0 },
      { id: "g2", label: "Dos", count: 1, entryIds: [2], markedAt: 0 },
      { id: "g3", label: "Tres", count: 1, entryIds: [3], markedAt: 0 },
    ];

    const kb = buildKeyboard("r1", buttons);

    expect(kb.inline_keyboard).toEqual([
      [
        { text: "✅ Uno (1)", callback_data: "fbr:mark:r1:g1" },
        { text: "✅ Dos (1)", callback_data: "fbr:mark:r1:g2" },
      ],
      [{ text: "✅ Tres (1)", callback_data: "fbr:mark:r1:g3" }],
    ]);
  });

  it("shows Deshacer within the 10-minute undo window", () => {
    const buttons: FeedbinReportButton[] = [{ ...BTN, markedAt: Date.now() - 60_000 }]; // hace 1 min
    const kb = buildKeyboard("r1", buttons);
    expect(kb.inline_keyboard).toEqual([[{ text: "↩️ Deshacer", callback_data: "fbr:undo:r1:g1" }]]);
  });

  it("drops the button entirely once the undo window expired", () => {
    const buttons: FeedbinReportButton[] = [{ ...BTN, markedAt: Date.now() - 11 * 60_000 }]; // hace 11 min
    const kb = buildKeyboard("r1", buttons);
    expect(kb.inline_keyboard).toEqual([]);
  });
});

describe("buildReportText", () => {
  it("appends the mark section when there are buttons", () => {
    const text = buildReportText("HEADER", [BTN]);
    expect(text).toBe("HEADER\n\n<b>⏭️ Marcar como leído</b>\nRumores Apple (66)");
  });

  it("returns just the header when there are no buttons", () => {
    expect(buildReportText("HEADER", [])).toBe("HEADER");
  });
});
