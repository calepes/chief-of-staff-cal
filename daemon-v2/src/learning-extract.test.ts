import { describe, expect, it } from "vitest";
import { buildExtractPrompt, parseExtractResult } from "./learning-extract.js";
import { parseLearnings } from "./learning-file.js";

describe("buildExtractPrompt", () => {
  const prompt = buildExtractPrompt("CAL: hola\nJANO: hola", parseLearnings("- [2026-07-01] [pref] Ya sé esto\n"));

  it("incluye el transcript", () => {
    expect(prompt).toContain("CAL: hola");
  });

  it("está escrito en español neutro, sin voseo", () => {
    // El propio prompt exige neutro (regla 6) porque estos textos terminan en el system prompt de
    // Jano y el registro se contagia. Estaba redactado en voseo, o sea modelaba lo contrario de lo
    // que pedía. Este test lo ancla.
    expect(prompt).toContain("Eres el módulo de reflexión nocturna");
    expect(prompt).toContain("Devuelve SOLO un array JSON");
    expect(prompt).toContain("Si no encuentras nada que valga la pena");
    expect(prompt).toContain("Escribe SIEMPRE en español NEUTRO");

    // Formas de voseo que no deben aparecer. "podés" se excluye a propósito: aparece UNA vez, como
    // el contraejemplo dentro de la regla 6 ("di 'puedes', nunca 'podés'").
    for (const voseo of ["Sos el", "Devolvé", "Escribí ", "encontrás", "tenés", "querés", "decí "]) {
      expect(prompt).not.toContain(voseo);
    }
  });

  it("le pasa los learnings existentes para que deduplique", () => {
    expect(prompt).toContain("Ya sé esto");
  });

  it("nombra los cuatro tags", () => {
    for (const t of ["pref", "hecho", "err", "flujo"]) expect(prompt).toContain(t);
  });

  it("dice explícitamente que devolver vacío es lo esperado", () => {
    expect(prompt.toLowerCase()).toContain("vacío");
  });

  it("pide español neutro, porque el texto termina en el system prompt de Jano", () => {
    expect(prompt.toLowerCase()).toContain("neutro");
  });
});

describe("parseExtractResult", () => {
  it("parsea una lista de candidatos", () => {
    const out = parseExtractResult(
      JSON.stringify([
        { tag: "pref", text: "Cal quiere el total primero", evidencia: "dijo 'primero el total'" },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe("pref");
  });

  it("tolera fences de markdown", () => {
    expect(parseExtractResult('```json\n[{"tag":"err","text":"algo","evidencia":"x"}]\n```')).toHaveLength(1);
  });

  it("devuelve vacío ante JSON inválido", () => {
    expect(parseExtractResult("no soy json")).toEqual([]);
  });

  it("devuelve vacío ante lista vacía", () => {
    expect(parseExtractResult("[]")).toEqual([]);
  });

  it("descarta candidatos con tag desconocido", () => {
    expect(parseExtractResult('[{"tag":"inventado","text":"algo","evidencia":"x"}]')).toEqual([]);
  });

  it("descarta candidatos sin texto", () => {
    expect(parseExtractResult('[{"tag":"pref","text":"","evidencia":"x"}]')).toEqual([]);
  });

  it("recorta textos larguísimos a 2 líneas de contenido", () => {
    const out = parseExtractResult(JSON.stringify([{ tag: "pref", text: "x".repeat(900), evidencia: "y" }]));
    expect(out[0].text.length).toBeLessThanOrEqual(300);
  });

  it("ignora un objeto suelto en vez de una lista", () => {
    expect(parseExtractResult('{"tag":"pref","text":"algo","evidencia":"x"}')).toEqual([]);
  });
});
