import { describe, it, expect } from "vitest";
import { sanitizeForTelegram } from "./format.js";

describe("sanitizeForTelegram", () => {
  it("convierte ** a <b> y * a <i>", () => {
    expect(sanitizeForTelegram("**negrita** y *cursiva*")).toBe("<b>negrita</b> y <i>cursiva</i>");
  });

  it("convierte un heading # a título en negrilla <b> (NO <h1>-<h6>) — decisión de Cal 2026-08-09", () => {
    expect(sanitizeForTelegram("# Título del resumen")).toBe("<b>Título del resumen</b>");
  });

  it("convierte headings de cualquier nivel (##/###) a <b> por igual", () => {
    expect(sanitizeForTelegram("## Subtítulo")).toBe("<b>Subtítulo</b>");
    expect(sanitizeForTelegram("### Otro nivel")).toBe("<b>Otro nivel</b>");
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
    // <b> es inline (a diferencia de un heading de bloque) — no se toca el \n original de
    // la línea, se preserva la separación normal que ya trae el Markdown fuente.
    expect(out).toBe("<b>Resumen</b>\n\n<ul><li>punto uno</li><li>punto dos</li></ul>\n\nTexto final.");
  });

  it("colapsa 3+ saltos de línea a 2 incluso después de agregar headings", () => {
    const out = sanitizeForTelegram("a\n\n\n\nb");
    expect(out).toBe("a\n\nb");
  });

  it("varios headings ## seguidos (forma real de un resumen: TL;DR + secciones) quedan como títulos en negrilla normales, sin margen de bloque acumulado — decisión de Cal 2026-08-09", () => {
    const md = "## TL;DR\n\nTexto breve.\n\n## Contexto\n\nMás texto.\n\n## Fuente\n\nLink.";
    const out = sanitizeForTelegram(md);
    // <b> no tiene margen propio de bloque (a diferencia de <h3>/<h4>, probados y
    // descartados el mismo día): separación normal de párrafo, una línea en blanco,
    // sin importar cuántos títulos seguidos tenga el resumen.
    expect(out).toBe(
      "<b>TL;DR</b>\n\nTexto breve.\n\n<b>Contexto</b>\n\nMás texto.\n\n<b>Fuente</b>\n\nLink."
    );
  });
});
