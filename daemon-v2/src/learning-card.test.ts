import { describe, expect, it } from "vitest";
import { renderBatch, renderOneByOne, renderDone, renderNothing, TAG_EMOJI } from "./learning-card.js";
import type { LearningCandidate } from "./learning-types.js";

const CANDS: LearningCandidate[] = [
  { tag: "pref", text: "Cal quiere el total antes del desglose", evidencia: "«primero el total»" },
  { tag: "err", text: "notionApi: el body va como objeto", evidencia: "«invalid_json»" },
  { tag: "hecho", text: "El colegio cierra la última semana de julio", evidencia: "«cierran el 25»" },
];

describe("renderBatch", () => {
  it("numera en texto plano y muestra el emoji de cada tag", () => {
    const { text } = renderBatch(CANDS, "b1", 1200);
    expect(text).toContain("1. ");
    expect(text).toContain(TAG_EMOJI.pref);
    expect(text).toContain(TAG_EMOJI.err);
    expect(text).not.toContain("1️⃣");
  });

  it("lista como máximo 5 y avisa cuántos quedan", () => {
    const muchos: LearningCandidate[] = Array.from({ length: 9 }, (_, i) => ({
      tag: "pref" as const,
      text: `Candidato ${i}`,
      evidencia: "x",
    }));
    const { text } = renderBatch(muchos, "b1", 100);
    expect(text).toContain("Candidato 4");
    expect(text).not.toContain("Candidato 5");
    expect(text).toContain("(y 4 más)");
  });

  it("ofrece los tres botones", () => {
    const datas = renderBatch(CANDS, "b1", 1200).keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).toEqual(["lrn:all:b1", "lrn:one:b1", "lrn:none:b1"]);
  });

  it("no avisa de presupuesto cuando está por debajo", () => {
    expect(renderBatch(CANDS, "b1", 1200).text).not.toContain("presupuesto");
  });

  it("avisa cuando se pasó el presupuesto", () => {
    expect(renderBatch(CANDS, "b1", 4300).text).toContain("presupuesto");
  });

  it("escapa HTML", () => {
    const c: LearningCandidate[] = [{ tag: "pref", text: "usa <b> y & cia", evidencia: "x" }];
    expect(renderBatch(c, "b1", 100).text).toContain("&lt;b&gt;");
  });

  it("ningún botón de más de 15 chars comparte fila", () => {
    for (const fila of renderBatch(CANDS, "b1", 100).keyboard.inline_keyboard) {
      if (fila.some((b) => b.text.length > 15)) expect(fila).toHaveLength(1);
    }
  });
});

describe("renderOneByOne", () => {
  it("muestra el candidato del cursor con su evidencia", () => {
    const { text } = renderOneByOne(CANDS, 1, "b1");
    expect(text).toContain("notionApi");
    expect(text).toContain("invalid_json");
    expect(text).toContain("2 de 3");
  });

  it("ofrece guardar y saltar el actual", () => {
    const datas = renderOneByOne(CANDS, 1, "b1").keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).toEqual(["lrn:keep:b1", "lrn:skip:b1", "lrn:none:b1"]);
  });
});

describe("renderDone / renderNothing", () => {
  it("renderDone resume cuántos se guardaron y deja el teclado vacío", () => {
    const card = renderDone(2, 1);
    expect(card.text).toContain("2");
    expect(card.keyboard.inline_keyboard).toEqual([]);
  });

  it("renderNothing es explícito", () => {
    expect(renderNothing().text).toContain("No guardé");
  });
});
