import { describe, expect, it } from "vitest";
import { renderBacklogMap, renderAddProposal, renderDoneProposal, renderSaved, renderDiscarded, renderDestPicker } from "./backlog-card.js";
import type { BacklogMapRow } from "./backlog-types.js";

const ROWS: BacklogMapRow[] = [
  { key: "claude-projects", path: "/x/BACKLOG.md", label: "General", group: "Raíz", pending: 3 },
  { key: "jano", path: "/x/j/BACKLOG.md", label: "Jano", group: "Agentes", pending: 12 },
  { key: "vesta", path: "/x/v/BACKLOG.md", label: "Vesta", group: "Agentes", pending: 0 },
  { key: "readwise", path: "/x/r/BACKLOG.md", label: "Readwise", group: "Apps", pending: 6 },
];

describe("renderBacklogMap", () => {
  it("muestra el total y agrupa por categoría", () => {
    const { text } = renderBacklogMap(ROWS);
    expect(text).toContain("21 pendientes");
    expect(text).toContain("<b>Raíz</b>");
    expect(text).toContain("<b>Agentes</b>");
    expect(text).toContain("<b>Apps</b>");
  });

  it("incluye los proyectos en cero", () => {
    expect(renderBacklogMap(ROWS).text).toContain("Vesta");
  });

  it("ordena cada grupo por cantidad de pendientes", () => {
    const { text } = renderBacklogMap(ROWS);
    expect(text.indexOf("Jano")).toBeLessThan(text.indexOf("Vesta"));
  });

  it("no usa bloques <pre> ni Markdown", () => {
    const { text } = renderBacklogMap(ROWS);
    expect(text).not.toContain("<pre>");
    expect(text).not.toContain("**");
    expect(text).not.toContain("---");
  });
});

describe("renderAddProposal", () => {
  it("muestra destino, texto y los cuatro botones", () => {
    const card = renderAddProposal("Jano", "Tool nueva", "abc123");
    expect(card.text).toContain("Jano");
    expect(card.text).toContain("Tool nueva");
    const datas = card.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).toEqual([
      "bklg:save:abc123",
      "bklg:edit:abc123",
      "bklg:dest:abc123",
      "bklg:drop:abc123",
    ]);
  });

  it("escapa HTML del texto de Cal", () => {
    expect(renderAddProposal("Jano", "usar <script> & cia", "abc123").text).toContain(
      "usar &lt;script&gt; &amp; cia",
    );
  });

  it("mantiene el callback_data bajo el límite de 64 bytes de Telegram", () => {
    const card = renderAddProposal("Jano", "x", "abcd1234");
    for (const b of card.keyboard.inline_keyboard.flat()) {
      expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});

describe("renderDoneProposal", () => {
  it("muestra la línea exacta que se va a tildar", () => {
    const card = renderDoneProposal("Jano", "Ítem viejo", "abc123");
    expect(card.text).toContain("Ítem viejo");
    const datas = card.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).toEqual(["bklg:save:abc123", "bklg:drop:abc123"]);
  });
});

describe("renderSaved / renderDiscarded", () => {
  it("dejan el teclado vacío", () => {
    expect(renderSaved("Jano", "Tool nueva", "add").keyboard.inline_keyboard).toEqual([]);
    expect(renderDiscarded().keyboard.inline_keyboard).toEqual([]);
  });
});

describe("renderDestPicker", () => {
  // 14 proyectos: el caso real de hoy, que es justo el que rompía el límite de Telegram.
  const MUCHOS: BacklogMapRow[] = Array.from({ length: 14 }, (_, i) => ({
    key: `p${i}`,
    path: `/x/${i}/BACKLOG.md`,
    label: `Proyecto ${i}`,
    group: "Apps",
    pending: i,
  }));

  it("respeta el límite de Telegram: máx 4 filas y 12 botones", () => {
    const kb = renderDestPicker(MUCHOS, "abc12345").keyboard.inline_keyboard;
    expect(kb.length).toBeLessThanOrEqual(4);
    expect(kb.flat().length).toBeLessThanOrEqual(12);
  });

  it("muestra los 6 con más pendientes", () => {
    const { text, keyboard } = renderDestPicker(MUCHOS, "abc12345");
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain("Proyecto 13");
    expect(labels).not.toContain("Proyecto 0");
    expect(text).toContain("8 proyectos más");
  });

  it("siempre ofrece el escape de texto libre", () => {
    const datas = renderDestPicker(MUCHOS, "abc12345").keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas.at(-1)).toBe("bklg:destother:abc12345");
  });

  it("trunca labels largos para que no hagan wrap en mobile", () => {
    const largo: BacklogMapRow[] = [
      { key: "x", path: "/x/BACKLOG.md", label: "Aeropuertos Bolivia Internacional", group: "Apps", pending: 1 },
    ];
    const label = renderDestPicker(largo, "abc12345").keyboard.inline_keyboard[0][0].text;
    expect(label.length).toBeLessThanOrEqual(16);
    expect(label.endsWith("…")).toBe(true);
  });

  it("no menciona proyectos extra cuando entran todos", () => {
    expect(renderDestPicker(ROWS, "abc12345").text).not.toContain("más");
  });

  it("mantiene el callback_data bajo 64 bytes con la clave más larga", () => {
    const largo: BacklogMapRow[] = [
      { key: "aeropuertos-bolivia-internacional", path: "/x/BACKLOG.md", label: "X", group: "Apps", pending: 1 },
    ];
    for (const b of renderDestPicker(largo, "abcd1234").keyboard.inline_keyboard.flat()) {
      expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});
