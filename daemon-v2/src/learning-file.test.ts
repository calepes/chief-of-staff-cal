import { describe, expect, it } from "vitest";
import {
  parseLearnings,
  formatLearning,
  estimateTokens,
  dedupeCandidates,
  overBudget,
  LEARNING_BUDGET_TOKENS,
} from "./learning-file.js";
import type { LearningCandidate } from "./learning-types.js";

const LEGACY = `- [2026-05-03] Cuando Cal comparte una foto de uso de Claude, calcular proyección.
- [2026-05-04] Cata está en Inicial y Anto en Primaria en el Colegio Porongo.
`;

const TAGGED = `- [2026-07-28] [pref] Cal quiere el total antes del desglose
- [2026-07-28] [err] notionApi: el body va como objeto, no como string
`;

describe("parseLearnings", () => {
  it("parsea líneas con tag", () => {
    const out = parseLearnings(TAGGED);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      date: "2026-07-28",
      tag: "pref",
      text: "Cal quiere el total antes del desglose",
    });
    expect(out[1].tag).toBe("err");
  });

  it("tolera las líneas viejas sin tag y las marca como hecho", () => {
    const out = parseLearnings(LEGACY);
    expect(out).toHaveLength(2);
    expect(out[0].tag).toBe("hecho");
    expect(out[0].text).toContain("proyección");
  });

  it("ignora líneas vacías y basura", () => {
    expect(parseLearnings("\n\nno es un learning\n")).toHaveLength(0);
  });

  it("ignora un tag desconocido y cae a hecho", () => {
    const out = parseLearnings("- [2026-07-28] [inventado] algo\n");
    expect(out[0].tag).toBe("hecho");
  });
});

describe("formatLearning", () => {
  it("serializa en el formato del archivo", () => {
    expect(formatLearning({ date: "2026-07-28", tag: "pref", text: "Algo" })).toBe(
      "- [2026-07-28] [pref] Algo",
    );
  });

  it("round-trip con parseLearnings", () => {
    const l = { date: "2026-07-28", tag: "err" as const, text: "Algo puntual" };
    expect(parseLearnings(formatLearning(l))[0]).toEqual(l);
  });
});

describe("estimateTokens", () => {
  it("estima por caracteres", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("es 0 para vacío", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("overBudget", () => {
  it("no dispara con pocos learnings", () => {
    expect(overBudget(parseLearnings(TAGGED))).toBe(false);
  });

  it("dispara cuando se pasa el presupuesto", () => {
    const gordo = Array.from({ length: 400 }, (_, i) => `- [2026-07-28] [pref] ${"x".repeat(60)} ${i}`).join("\n");
    expect(overBudget(parseLearnings(gordo))).toBe(true);
  });

  it("el presupuesto es el documentado en el spec", () => {
    expect(LEARNING_BUDGET_TOKENS).toBe(4000);
  });
});

describe("dedupeCandidates", () => {
  const existentes = parseLearnings(TAGGED);

  it("descarta un candidato que repite un learning existente con otras palabras", () => {
    const cands: LearningCandidate[] = [
      { tag: "err", text: "notionApi necesita el body como objeto y no como string", evidencia: "x" },
    ];
    expect(dedupeCandidates(cands, existentes)).toHaveLength(0);
  });

  it("conserva un candidato genuinamente nuevo", () => {
    const cands: LearningCandidate[] = [
      { tag: "hecho", text: "El pediatra de las niñas atiende en Equipetrol", evidencia: "x" },
    ];
    expect(dedupeCandidates(cands, existentes)).toHaveLength(1);
  });

  it("descarta duplicados dentro del propio batch", () => {
    const cands: LearningCandidate[] = [
      { tag: "pref", text: "A Cal le gusta el resumen corto arriba", evidencia: "x" },
      { tag: "pref", text: "Cal prefiere el resumen corto arriba de todo", evidencia: "y" },
    ];
    expect(dedupeCandidates(cands, [])).toHaveLength(1);
  });
});
