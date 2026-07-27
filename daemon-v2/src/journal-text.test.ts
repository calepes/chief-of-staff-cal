import { describe, it, expect } from "vitest";
import { parseJournalPrefix, buildExtracto, chunkParagraphs } from "./journal-text.js";

describe("parseJournalPrefix", () => {
  it("detecta 'journal:' y devuelve el resto", () => {
    expect(parseJournalPrefix("journal: hoy me sentí raro")).toBe("hoy me sentí raro");
  });

  it("detecta 'diario:' y no distingue mayúsculas", () => {
    expect(parseJournalPrefix("Diario: algo")).toBe("algo");
    expect(parseJournalPrefix("DIARIO:algo")).toBe("algo");
  });

  it("acepta el prefijo sin espacio después de los dos puntos", () => {
    expect(parseJournalPrefix("journal:sin espacio")).toBe("sin espacio");
  });

  it("devuelve null si no hay prefijo", () => {
    expect(parseJournalPrefix("qué vuelos hay mañana")).toBeNull();
  });

  it("devuelve null si el prefijo está en el medio", () => {
    expect(parseJournalPrefix("le dije journal: nada")).toBeNull();
  });

  it("devuelve null si después del prefijo no hay texto", () => {
    expect(parseJournalPrefix("journal:   ")).toBeNull();
  });

  it("conserva el texto literal, incluidos saltos de línea", () => {
    expect(parseJournalPrefix("journal: línea 1\nlínea 2")).toBe("línea 1\nlínea 2");
  });
});

describe("buildExtracto", () => {
  it("devuelve el texto entero si es corto", () => {
    expect(buildExtracto("corto")).toBe("corto");
  });

  it("corta en el último espacio antes del límite y agrega elipsis", () => {
    const texto = "a".repeat(150) + " " + "b".repeat(100);
    const out = buildExtracto(texto);
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("b");
  });

  it("corta duro si no hay espacios", () => {
    const out = buildExtracto("x".repeat(500));
    expect(out).toBe("x".repeat(200) + "…");
  });

  it("colapsa saltos de línea en espacios", () => {
    expect(buildExtracto("uno\ndos")).toBe("uno dos");
  });
});

describe("chunkParagraphs", () => {
  it("un texto corto es un solo bloque", () => {
    expect(chunkParagraphs("hola")).toEqual(["hola"]);
  });

  it("parte por párrafos cuando el texto los tiene", () => {
    expect(chunkParagraphs("uno\n\ndos")).toEqual(["uno", "dos"]);
  });

  it("ningún chunk supera 1900 caracteres", () => {
    const largo = "palabra ".repeat(1000);
    const chunks = chunkParagraphs(largo);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1900);
  });

  it("no pierde texto al partir", () => {
    const largo = "palabra ".repeat(1000).trim();
    const chunks = chunkParagraphs(largo);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(largo.replace(/\s+/g, " "));
  });

  it("parte un párrafo sin espacios más largo que el límite", () => {
    const chunks = chunkParagraphs("z".repeat(4000));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.length).toBe(1900);
  });

  it("un texto vacío devuelve un array vacío", () => {
    expect(chunkParagraphs("   ")).toEqual([]);
  });
});
