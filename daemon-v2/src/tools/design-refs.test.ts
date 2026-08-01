import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDesignCritique, slugify, writeDesignRef } from "./design-refs.js";

describe("parseDesignCritique", () => {
  it("parsea los 5 campos de una respuesta bien formada", () => {
    const text = [
      "TITULO: Linear — paleta de comandos",
      "TIPO: dashboard",
      "QUE_ES: paleta de comandos con búsqueda difusa",
      "POR_QUE_FUNCIONA: la jerarquía tipográfica separa acción de contexto.",
      "Además el spacing vertical es generoso pese a la densidad.",
      "TAGS: dark-mode, data-density, glass",
    ].join("\n");

    const result = parseDesignCritique(text);

    expect(result.titulo).toBe("Linear — paleta de comandos");
    expect(result.tipo).toBe("dashboard");
    expect(result.queEs).toBe("paleta de comandos con búsqueda difusa");
    expect(result.porQueFunciona).toBe(
      "la jerarquía tipográfica separa acción de contexto.\nAdemás el spacing vertical es generoso pese a la densidad.",
    );
    expect(result.tags).toEqual(["dark-mode", "data-density", "glass"]);
  });

  it("cae a 'otro' si TIPO no es uno de los válidos", () => {
    const result = parseDesignCritique("TITULO: X\nTIPO: infografia\nQUE_ES: y\nPOR_QUE_FUNCIONA: z\nTAGS: a");
    expect(result.tipo).toBe("otro");
  });

  it("nunca tira excepción con texto sin ninguna etiqueta", () => {
    const result = parseDesignCritique("esto no tiene el formato esperado para nada");
    expect(result.titulo).toBe("Referencia sin título");
    expect(result.tipo).toBe("otro");
    expect(result.tags).toEqual([]);
    expect(result.queEs).toContain("esto no tiene el formato esperado");
  });
});

describe("slugify", () => {
  it("normaliza tildes, mayúsculas y símbolos", () => {
    expect(slugify("Linear — Paleta de Comandos")).toBe("linear-paleta-de-comandos");
  });

  it("colapsa espacios/símbolos repetidos y recorta guiones en los bordes", () => {
    expect(slugify("  ¿Qué tal esto?!  ")).toBe("que-tal-esto");
  });
});

describe("writeDesignRef", () => {
  const ROOT = join(tmpdir(), "jano-test-design-refs");

  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  function fakeScreenshot(): string {
    const src = join(tmpdir(), `jano-test-shot-${process.pid}.png`);
    writeFileSync(src, Buffer.from("fake-png"));
    return src;
  }

  it("escribe la ficha, copia el screenshot y prepende la línea en INDEX.md", () => {
    const result = writeDesignRef(
      {
        fuente: "https://x.com/usuario/status/123",
        fecha: "2026-07-31",
        critique: {
          titulo: "Linear — paleta de comandos",
          tipo: "dashboard",
          queEs: "paleta de comandos",
          porQueFunciona: "jerarquía clara",
          tags: ["dark-mode", "glass"],
        },
      },
      fakeScreenshot(),
      ROOT,
    );

    expect(result.slug).toBe("linear-paleta-de-comandos");
    expect(existsSync(result.fichaPath)).toBe(true);
    expect(existsSync(result.shotPath)).toBe(true);

    const ficha = readFileSync(result.fichaPath, "utf8");
    expect(ficha).toContain("fuente: https://x.com/usuario/status/123");
    expect(ficha).toContain("tipo: dashboard");
    expect(ficha).toContain("**Qué es:** paleta de comandos");
    expect(ficha).toContain("**Por qué funciona:** jerarquía clara");

    const index = readFileSync(join(ROOT, "INDEX.md"), "utf8");
    expect(index).toContain(
      "- [2026-07-31] **Linear — paleta de comandos** · `dashboard` · dark-mode, glass — [ficha](refs/2026-07-31-linear-paleta-de-comandos.md)",
    );
  });

  it("agrega Aplicable a solo si viene en el input", () => {
    const result = writeDesignRef(
      {
        fuente: "https://ejemplo.com",
        fecha: "2026-07-31",
        critique: { titulo: "Algo", tipo: "otro", queEs: "x", porQueFunciona: "y", tags: [] },
        aplicableA: "Combustible",
      },
      fakeScreenshot(),
      ROOT,
    );
    expect(readFileSync(result.fichaPath, "utf8")).toContain("**Aplicable a:** Combustible");
  });

  it("resuelve colisión del mismo día con sufijo -2", () => {
    const critique = { titulo: "Mismo Título", tipo: "otro" as const, queEs: "x", porQueFunciona: "y", tags: [] };
    const r1 = writeDesignRef({ fuente: "https://a.com", fecha: "2026-07-31", critique }, fakeScreenshot(), ROOT);
    const r2 = writeDesignRef({ fuente: "https://b.com", fecha: "2026-07-31", critique }, fakeScreenshot(), ROOT);
    expect(r1.slug).toBe("mismo-titulo");
    expect(r2.slug).toBe("mismo-titulo-2");
  });

  it("la entrada más nueva queda primero en INDEX.md", () => {
    const critique = { titulo: "Uno", tipo: "otro" as const, queEs: "x", porQueFunciona: "y", tags: [] };
    writeDesignRef({ fuente: "https://a.com", fecha: "2026-07-30", critique: { ...critique, titulo: "Primero" } }, fakeScreenshot(), ROOT);
    writeDesignRef({ fuente: "https://b.com", fecha: "2026-07-31", critique: { ...critique, titulo: "Segundo" } }, fakeScreenshot(), ROOT);
    const index = readFileSync(join(ROOT, "INDEX.md"), "utf8");
    expect(index.indexOf("Segundo")).toBeLessThan(index.indexOf("Primero"));
  });

  it("crea INDEX.md con el marcador si todavía no existe", () => {
    mkdirSync(ROOT, { recursive: true });
    const critique = { titulo: "Primera", tipo: "otro" as const, queEs: "x", porQueFunciona: "y", tags: [] };
    writeDesignRef({ fuente: "https://a.com", fecha: "2026-07-31", critique }, fakeScreenshot(), ROOT);
    const index = readFileSync(join(ROOT, "INDEX.md"), "utf8");
    expect(index).toContain("<!-- ENTRIES -->");
    expect(index).toContain("Primera");
  });
});
