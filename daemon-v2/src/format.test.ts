import { describe, it, expect } from "vitest";
import { sanitizeForTelegram } from "./format.js";

describe("sanitizeForTelegram", () => {
  it("convierte ** a <b> y * a <i>", () => {
    expect(sanitizeForTelegram("**negrita** y *cursiva*")).toBe("<b>negrita</b> y <i>cursiva</i>");
  });

  it("convierte un heading # a <h3> real (no <b>) — hallazgo 2026-08-09", () => {
    expect(sanitizeForTelegram("# Título del resumen")).toBe("<h3>Título del resumen</h3>");
  });

  it("convierte headings de cualquier nivel (##/###) a <h3> por igual", () => {
    expect(sanitizeForTelegram("## Subtítulo")).toBe("<h3>Subtítulo</h3>");
    expect(sanitizeForTelegram("### Otro nivel")).toBe("<h3>Otro nivel</h3>");
  });

  it("convierte una lista con guiones a <ul><li> real, no bullets de texto plano", () => {
    const out = sanitizeForTelegram("- primero\n- segundo\n- tercero");
    expect(out).toBe("<ul><li>primero</li><li>segundo</li><li>tercero</li></ul>");
  });

  it("convierte una lista con asteriscos a <ul><li> real", () => {
    const out = sanitizeForTelegram("* uno\n* dos");
    expect(out).toBe("<ul><li>uno</li><li>dos</li></ul>");
  });

  it("tolera UNA línea en blanco entre items del mismo tipo sin cortar la lista en dos", () => {
    const out = sanitizeForTelegram("- uno\n\n- dos\n\n- tres");
    expect(out).toBe("<ul><li>uno</li><li>dos</li><li>tres</li></ul>");
  });

  it("SÍ cierra la lista si la línea en blanco no está seguida de otro item", () => {
    const out = sanitizeForTelegram("- uno\n- dos\n\ntexto normal");
    expect(out).toBe("<ul><li>uno</li><li>dos</li></ul>\n\ntexto normal");
  });

  it("convierte una lista numerada a <ol><li> real", () => {
    const out = sanitizeForTelegram("1. primero\n2. segundo");
    expect(out).toBe("<ol><li>primero</li><li>segundo</li></ol>");
  });

  it("no confunde una regla horizontal (---) con una lista", () => {
    expect(sanitizeForTelegram("texto\n\n---\n\nmás texto")).toBe("texto\n\nmás texto");
  });

  it("preserva **bold** dentro de un item de lista", () => {
    const out = sanitizeForTelegram("- **importante**: revisar esto");
    expect(out).toBe("<ul><li><b>importante</b>: revisar esto</li></ul>");
  });

  it("sigue convirtiendo tablas Markdown a <table> real", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const out = sanitizeForTelegram(md);
    expect(out).toContain("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");
  });

  it("heading + lista + tabla combinados en un mismo texto", () => {
    const md = "# Resumen\n\n- punto uno\n- punto dos\n\nTexto final.";
    const out = sanitizeForTelegram(md);
    expect(out).toBe("<h3>Resumen</h3>\n\n<ul><li>punto uno</li><li>punto dos</li></ul>\n\nTexto final.");
  });

  it("colapsa 3+ saltos de línea a 2 incluso después de agregar headings", () => {
    const out = sanitizeForTelegram("a\n\n\n\nb");
    expect(out).toBe("a\n\nb");
  });
});
