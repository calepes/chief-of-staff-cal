import { describe, it, expect } from "vitest";
import { nowInLaPaz, buildMetaProposal } from "./journal-capture.js";
import type { EnrichResult, NotionRef } from "./journal-types.js";

describe("nowInLaPaz", () => {
  it("formatea con offset fijo -04:00", () => {
    const iso = nowInLaPaz(new Date("2026-07-27T18:32:05.000Z"));
    expect(iso).toBe("2026-07-27T14:32:05-04:00");
  });

  it("retrocede de día cuando corresponde", () => {
    expect(nowInLaPaz(new Date("2026-07-27T02:00:00.000Z"))).toBe("2026-07-26T22:00:00-04:00");
  });
});

describe("buildMetaProposal", () => {
  const enrich: EnrichResult = {
    titulo: "Miedo a la confrontación",
    animo: "😤 Tensionado",
    intensidad: 4,
    topics: ["Terapia", "Inventado"],
    bigTheme: "Better Me",
    reflexion: { titulo: "R", situacion: "S" },
  };
  const topicIndex = new Map<string, NotionRef>([["terapia", { id: "t1", name: "Terapia" }]]);
  const themeIndex = new Map<string, NotionRef>([["better me", { id: "b1", name: "Better Me" }]]);

  const base = {
    entryId: "e1",
    topicIndex,
    themeIndex,
    fechaHora: "2026-07-27T14:32:05-04:00",
    textoCrudo: "texto crudo",
    messageId: 7,
  };

  it("resuelve topics y big theme a refs reales", () => {
    const p = buildMetaProposal({ ...base, enrich });
    expect(p.topics).toEqual([{ id: "t1", name: "Terapia" }]);
    expect(p.bigTheme).toEqual({ id: "b1", name: "Better Me" });
  });

  it("descarta topics inventados en vez de fallar", () => {
    const p = buildMetaProposal({ ...base, enrich });
    expect(p.topics.map((t) => t.name)).not.toContain("Inventado");
  });

  it("deja bigTheme null si el nombre no existe", () => {
    const p = buildMetaProposal({ ...base, enrich: { ...enrich, bigTheme: "No Existe" } });
    expect(p.bigTheme).toBeNull();
  });

  it("arranca sin topics excluidos y con el extracto derivado del texto", () => {
    const p = buildMetaProposal({ ...base, enrich });
    expect(p.topicsExcluidos).toEqual([]);
    expect(p.extracto).toBe("texto crudo");
    expect(p.kind).toBe("journal-meta");
  });

  it("conserva la reflexión propuesta", () => {
    const p = buildMetaProposal({ ...base, enrich });
    expect(p.reflexion).toEqual({ titulo: "R", situacion: "S" });
  });
});
