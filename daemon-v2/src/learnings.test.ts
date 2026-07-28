import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLearningsSection } from "./learnings.js";

describe("buildLearningsSection", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "learnings-"));
    path = join(dir, "learnings.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("agrupa por categoría con títulos legibles, en orden pref → err → flujo → hecho", () => {
    writeFileSync(
      path,
      [
        "- [2026-07-01] [hecho] El colegio cierra la última semana de julio",
        "- [2026-07-02] [flujo] Cal pide el KPI card apenas llega el mail de BCP",
        "- [2026-07-03] [pref] Cal prefiere separador de miles en cifras de dinero",
        "- [2026-07-04] [err] notionApi: el body va como objeto, no como string",
      ].join("\n"),
    );

    const section = buildLearningsSection(path);

    expect(section).toContain("## Aprendizajes acumulados");
    expect(section).toContain("### Preferencias de Cal");
    expect(section).toContain("### Errores a evitar");
    expect(section).toContain("### Flujos que Cal repite");
    expect(section).toContain("### Hechos sobre Cal y su contexto");

    // Orden de bloques: pref antes que err, err antes que flujo, flujo antes que hecho.
    const iPref = section.indexOf("### Preferencias de Cal");
    const iErr = section.indexOf("### Errores a evitar");
    const iFlujo = section.indexOf("### Flujos que Cal repite");
    const iHecho = section.indexOf("### Hechos sobre Cal y su contexto");
    expect(iPref).toBeLessThan(iErr);
    expect(iErr).toBeLessThan(iFlujo);
    expect(iFlujo).toBeLessThan(iHecho);

    expect(section).toContain("Cal prefiere separador de miles en cifras de dinero");
    expect(section).toContain("notionApi: el body va como objeto, no como string");
    expect(section).toContain("Cal pide el KPI card apenas llega el mail de BCP");
    expect(section).toContain("El colegio cierra la última semana de julio");
  });

  it("omite bloques de categorías sin entries", () => {
    writeFileSync(path, "- [2026-07-01] [pref] Cal prefiere respuestas cortas\n");
    const section = buildLearningsSection(path);
    expect(section).toContain("### Preferencias de Cal");
    expect(section).not.toContain("### Errores a evitar");
    expect(section).not.toContain("### Flujos que Cal repite");
    expect(section).not.toContain("### Hechos sobre Cal y su contexto");
  });

  it("archivo vacío devuelve la sección con 'Sin learnings todavía'", () => {
    writeFileSync(path, "");
    const section = buildLearningsSection(path);
    expect(section).toContain("## Aprendizajes acumulados");
    expect(section).toContain("(Sin learnings todavía)");
  });

  it("archivo inexistente devuelve la sección con 'Sin learnings todavía'", () => {
    const section = buildLearningsSection(join(dir, "no-existe.md"));
    expect(section).toContain("(Sin learnings todavía)");
  });

  it("líneas viejas sin tag las mapea parseLearnings a 'hecho' y las incluye", () => {
    writeFileSync(path, "- [2026-05-01] Cal vive en Santa Cruz, Bolivia\n");
    const section = buildLearningsSection(path);
    expect(section).toContain("### Hechos sobre Cal y su contexto");
    expect(section).toContain("Cal vive en Santa Cruz, Bolivia");
  });

  it("ya no menciona addLearning", () => {
    writeFileSync(path, "- [2026-07-01] [pref] Cal prefiere respuestas cortas\n");
    const withContent = buildLearningsSection(path);
    expect(withContent).not.toContain("addLearning");

    const empty = buildLearningsSection(join(dir, "no-existe.md"));
    expect(empty).not.toContain("addLearning");
  });
});
