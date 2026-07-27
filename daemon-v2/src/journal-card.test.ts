import { describe, it, expect } from "vitest";
import {
  renderMetaCard,
  renderAnimoPicker,
  renderTopicsPicker,
  renderBigThemePicker,
  renderReflexionCard,
  renderSweepSelector,
  renderModeOpen,
  renderModeClosed,
  renderApplied,
} from "./journal-card.js";
import type { MetaProposal, ReflexionProposal } from "./journal-types.js";

function meta(overrides: Partial<MetaProposal> = {}): MetaProposal {
  return {
    kind: "journal-meta",
    entryId: "entry-1",
    titulo: "Miedo a la confrontación en reuniones",
    animo: "😤 Tensionado",
    intensidad: 4,
    topics: [
      { id: "t1", name: "Terapia" },
      { id: "t2", name: "Autoestima" },
    ],
    topicsExcluidos: [],
    bigTheme: { id: "b1", name: "Better Me" },
    extracto: "Hoy en la sesión me di cuenta de que...",
    fechaHora: "2026-07-27T14:32:00-04:00",
    textoCrudo: "Hoy en la sesión me di cuenta de que...",
    reflexion: null,
    messageId: 99,
    ...overrides,
  };
}

function flat(kb: { inline_keyboard: Array<Array<{ callback_data: string }>> }): string[] {
  return kb.inline_keyboard.flat().map((b) => b.callback_data);
}

describe("renderMetaCard", () => {
  it("muestra fecha, hora, extracto y los 4 campos propuestos", () => {
    const { text } = renderMetaCard(meta(), "ab12");
    expect(text).toContain("27/07");
    expect(text).toContain("14:32");
    expect(text).toContain("Miedo a la confrontación en reuniones");
    expect(text).toContain("😤 Tensionado");
    expect(text).toContain("4/5");
    expect(text).toContain("Terapia, Autoestima");
    expect(text).toContain("Better Me");
  });

  it("ofrece aplicar, los 4 ajustes y descartar", () => {
    const { keyboard } = renderMetaCard(meta(), "ab12");
    expect(flat(keyboard)).toEqual([
      "jnl:apply:ab12",
      "jnl:edit-title:ab12",
      "jnl:pick-animo:ab12",
      "jnl:pick-topics:ab12",
      "jnl:pick-theme:ab12",
      "jnl:nometa:ab12",
    ]);
  });

  it("no lista los topics excluidos", () => {
    const { text } = renderMetaCard(meta({ topicsExcluidos: ["t2"] }), "ab12");
    expect(text).toContain("Terapia");
    expect(text).not.toContain("Autoestima");
  });

  it("escapa HTML del texto de Cal", () => {
    const { text } = renderMetaCard(meta({ extracto: "me dijo <jefe> & se fue" }), "ab12");
    expect(text).toContain("&lt;jefe&gt; &amp; se fue");
  });

  it("dice cuando no hay big theme", () => {
    const { text } = renderMetaCard(meta({ bigTheme: null }), "ab12");
    expect(text).toContain("sin asignar");
  });
});

describe("renderAnimoPicker", () => {
  it("ofrece los 5 ánimos y las 5 intensidades", () => {
    const datas = flat(renderAnimoPicker(meta(), "ab12").keyboard);
    expect(datas).toContain("jnl:animo:ab12:0");
    expect(datas).toContain("jnl:animo:ab12:4");
    expect(datas).toContain("jnl:inten:ab12:1");
    expect(datas).toContain("jnl:inten:ab12:5");
    expect(datas).toContain("jnl:back:ab12");
  });

  it("marca el ánimo actual", () => {
    const { text } = renderAnimoPicker(meta(), "ab12");
    expect(text).toContain("😤 Tensionado");
  });
});

describe("renderTopicsPicker", () => {
  it("muestra un toggle por topic con su estado", () => {
    const { keyboard } = renderTopicsPicker(meta({ topicsExcluidos: ["t2"] }), "ab12");
    const botones = keyboard.inline_keyboard.flat();
    expect(botones[0]!.text).toBe("✅ Terapia");
    expect(botones[0]!.callback_data).toBe("jnl:togtopic:ab12:t1");
    expect(botones[1]!.text).toBe("⬜ Autoestima");
  });

  it("cierra con el botón de volver", () => {
    expect(flat(renderTopicsPicker(meta(), "ab12").keyboard)).toContain("jnl:back:ab12");
  });
});

describe("renderBigThemePicker", () => {
  it("lista los temas recibidos y permite quitarlo", () => {
    const themes = [
      { id: "b1", name: "Better Me" },
      { id: "b2", name: "Better Leader" },
    ];
    const datas = flat(renderBigThemePicker(meta(), "ab12", themes).keyboard);
    expect(datas).toContain("jnl:theme:ab12:b1");
    expect(datas).toContain("jnl:theme:ab12:b2");
    expect(datas).toContain("jnl:theme:ab12:none");
  });
});

describe("renderReflexionCard", () => {
  const refl: ReflexionProposal = {
    kind: "journal-reflexion",
    entryId: "entry-1",
    titulo: "Un amigo hombre con quien conversar",
    situacion: "Sesión con Valeria, 27/07",
    topics: [{ id: "t1", name: "Terapia" }],
    bigTheme: { id: "b1", name: "Better Me" },
    fecha: "2026-07-27",
    textoCrudo: "texto",
    messageId: 99,
  };

  it("muestra el título, la situación y el tipo fijo", () => {
    const { text } = renderReflexionCard(refl, "cd34");
    expect(text).toContain("Un amigo hombre con quien conversar");
    expect(text).toContain("Sesión con Valeria, 27/07");
    expect(text).toContain("Reflexion");
    expect(text).toContain("Terapia");
  });

  it("ofrece guardar, editar y posponer", () => {
    expect(flat(renderReflexionCard(refl, "cd34").keyboard)).toEqual([
      "jnl:resonate:cd34",
      "jnl:edit-refl:cd34",
      "jnl:later:cd34",
    ]);
  });
});

describe("renderSweepSelector", () => {
  const entries = [
    { id: "e1", titulo: "Miedo a la confrontación", fecha: "2026-07-22" },
    { id: "e2", titulo: "Culpa con mis papás", fecha: "2026-07-23" },
  ];

  it("enumera las entradas con su fecha", () => {
    const { text } = renderSweepSelector(entries);
    expect(text).toContain("2 pensamientos sin destilar");
    expect(text).toContain("1. Miedo a la confrontación · 22/07");
    expect(text).toContain("2. Culpa con mis papás · 23/07");
  });

  it("ofrece un botón por entrada más revisar todos y descartar", () => {
    const datas = flat(renderSweepSelector(entries).keyboard);
    expect(datas).toEqual(["jnl:sweep:e1", "jnl:sweep:e2", "jnl:sweep:all", "jnl:sweep:none"]);
  });

  it("muestra como máximo 5 entradas pero las cuenta todas", () => {
    const muchas = Array.from({ length: 9 }, (_, i) => ({
      id: `e${i}`,
      titulo: `t${i}`,
      fecha: "2026-07-22",
    }));
    const { text, keyboard } = renderSweepSelector(muchas);
    expect(text).toContain("9 pensamientos sin destilar");
    expect(text).toContain("(y 4 más)");
    expect(flat(keyboard).filter((d) => d.startsWith("jnl:sweep:e"))).toHaveLength(5);
  });
});

describe("renderModeOpen / renderModeClosed / renderApplied", () => {
  it("el modo abierto ofrece cerrar", () => {
    const { text, keyboard } = renderModeOpen();
    expect(text).toContain("Modo journal abierto");
    expect(flat(keyboard)).toEqual(["jnl:mode:close"]);
  });

  it("el cierre resume la tanda sin botones", () => {
    const { text, keyboard } = renderModeClosed(5, 1);
    expect(text).toContain("5 entradas");
    expect(text).toContain("1 reflexión pendiente");
    expect(keyboard.inline_keyboard).toEqual([]);
  });

  it("el cierre usa plural correcto en cero", () => {
    expect(renderModeClosed(1, 0).text).toContain("1 entrada");
    expect(renderModeClosed(1, 0).text).not.toContain("pendiente");
  });

  it("tras aplicar ofrece deshacer", () => {
    const { text, keyboard } = renderApplied(meta(), "entry-1");
    expect(text).toContain("Guardado");
    expect(flat(keyboard)).toEqual(["jnl:undo:entry-1"]);
  });
});
