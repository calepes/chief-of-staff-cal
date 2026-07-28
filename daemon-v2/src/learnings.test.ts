import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLearningsSection, buildSystemPrompt } from "./learnings.js";

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

describe("buildSystemPrompt", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "learnings-prompt-"));
    path = join(dir, "learnings.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // El bug que este test cubre: el system prompt se calculaba UNA vez, al cargar el módulo
  // (BASE_OPTIONS en index.ts), así que todo lo que escribiera recordarAprendizaje o los
  // callbacks lrn:* quedaba en el archivo sin influir en ningún turno hasta el próximo restart
  // de launchd — semanas, en la práctica. El test simula exactamente eso: dos construcciones
  // consecutivas del prompt con el archivo modificado en el medio, sin recargar el módulo.
  it("recalcula el prompt: dos llamadas con el archivo modificado en el medio dan prompts distintos", () => {
    writeFileSync(path, "- [2026-07-01] [pref] Cal prefiere respuestas cortas\n");
    const primero = buildSystemPrompt("BASE", path);
    expect(primero).toContain("Cal prefiere respuestas cortas");
    expect(primero).not.toContain("Cal odia los emojis en reportes de KPIs");

    // Un learning nuevo aprobado mientras el daemon YA está corriendo.
    appendFileSync(path, "- [2026-07-28] [pref] Cal odia los emojis en reportes de KPIs\n");

    const segundo = buildSystemPrompt("BASE", path);
    expect(segundo).not.toBe(primero);
    expect(segundo).toContain("Cal odia los emojis en reportes de KPIs");
    expect(segundo).toContain("Cal prefiere respuestas cortas");
  });

  it("ve un learning nuevo aunque el archivo no existiera en la primera llamada", () => {
    const inexistente = join(dir, "todavia-no.md");
    const primero = buildSystemPrompt("BASE", inexistente);
    expect(primero).toContain("(Sin learnings todavía)");

    writeFileSync(inexistente, "- [2026-07-28] [err] No mandes tablas <pre> con banderas\n");

    const segundo = buildSystemPrompt("BASE", inexistente);
    expect(segundo).not.toContain("(Sin learnings todavía)");
    expect(segundo).toContain("No mandes tablas <pre> con banderas");
  });

  it("antepone el prompt base y le pega la sección de aprendizajes", () => {
    writeFileSync(path, "- [2026-07-01] [pref] Cal prefiere respuestas cortas\n");
    const prompt = buildSystemPrompt("PROMPT BASE DE JANO", path);
    expect(prompt.startsWith("PROMPT BASE DE JANO")).toBe(true);
    expect(prompt).toContain("## Aprendizajes acumulados");
  });
});
