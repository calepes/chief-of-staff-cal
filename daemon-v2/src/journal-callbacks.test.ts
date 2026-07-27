import { describe, it, expect } from "vitest";
import {
  isJournalCallback,
  parseJournalCallback,
  applyToggleTopic,
  applyAnimoPick,
} from "./journal-callbacks.js";
import type { MetaProposal } from "./journal-types.js";

function meta(): MetaProposal {
  return {
    kind: "journal-meta",
    entryId: "e1",
    titulo: "T",
    animo: "😐 Neutro",
    intensidad: 3,
    topics: [
      { id: "t1", name: "Terapia" },
      { id: "t2", name: "Foco" },
    ],
    topicsExcluidos: [],
    bigTheme: null,
    extracto: "x",
    fechaHora: "2026-07-27T14:32:00-04:00",
    textoCrudo: "x",
    reflexion: null,
    messageId: 1,
  };
}

describe("isJournalCallback", () => {
  it("reconoce los callbacks del journal", () => {
    expect(isJournalCallback("jnl:apply:ab12")).toBe(true);
    expect(isJournalCallback("jnl:mode:close")).toBe(true);
  });

  it("ignora los demás", () => {
    expect(isJournalCallback("j:resu:save")).toBe(false);
    expect(isJournalCallback(undefined)).toBe(false);
  });
});

describe("parseJournalCallback", () => {
  it("separa acción, shortId y argumento", () => {
    expect(parseJournalCallback("jnl:togtopic:ab12:t1")).toEqual({
      accion: "togtopic",
      shortId: "ab12",
      arg: "t1",
    });
  });

  it("deja arg undefined cuando no hay", () => {
    expect(parseJournalCallback("jnl:apply:ab12")).toEqual({
      accion: "apply",
      shortId: "ab12",
      arg: undefined,
    });
  });

  it("devuelve null si el formato no es válido", () => {
    expect(parseJournalCallback("jnl:")).toBeNull();
    expect(parseJournalCallback("otra:cosa")).toBeNull();
  });
});

describe("applyToggleTopic", () => {
  it("excluye un topic incluido", () => {
    expect(applyToggleTopic(meta(), "t1").topicsExcluidos).toEqual(["t1"]);
  });

  it("vuelve a incluir uno excluido", () => {
    const p = { ...meta(), topicsExcluidos: ["t1"] };
    expect(applyToggleTopic(p, "t1").topicsExcluidos).toEqual([]);
  });

  it("ignora un id que no está en la lista", () => {
    expect(applyToggleTopic(meta(), "zzz").topicsExcluidos).toEqual([]);
  });
});

describe("applyAnimoPick", () => {
  it("cambia el ánimo por índice", () => {
    expect(applyAnimoPick(meta(), "4").animo).toBe("😰 Ansioso");
  });

  it("ignora un índice fuera de rango", () => {
    expect(applyAnimoPick(meta(), "9").animo).toBe("😐 Neutro");
  });
});
