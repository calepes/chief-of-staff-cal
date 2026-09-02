import { describe, it, expect } from "vitest";
import { buildInformeBlocks, buildBattlecardBlocks } from "./research-competencia-notion.js";
import type { EntityRunResult, EntitySnapshot } from "./research-competencia-types.js";

function entityResult(overrides: Partial<EntityRunResult>): EntityRunResult {
  return {
    entityId: "x", entityNombre: "Entidad X", primeraCorrida: false, hallazgos: [],
    snapshot: { entityId: "x", updatedAt: "2026-08-31T00:00:00Z" },
    ...overrides,
  };
}

function richText(block: any): string {
  const key = block.type;
  return block[key].rich_text.map((t: any) => t.text.content).join("");
}

describe("buildInformeBlocks", () => {
  it("abre cada entidad con un heading con su nombre", () => {
    const blocks = buildInformeBlocks([entityResult({ entityNombre: "Takenos" })]) as any[];
    expect(blocks[0].type).toBe("heading_3");
    expect(richText(blocks[0])).toBe("Takenos");
  });

  it("marca primera corrida sin comparación", () => {
    const blocks = buildInformeBlocks([entityResult({ primeraCorrida: true })]) as any[];
    expect(richText(blocks[1])).toContain("Primera corrida");
  });

  it("primera corrida con hallazgos los muestra igual, marcados como iniciales, como bullets", () => {
    const blocks = buildInformeBlocks([
      entityResult({
        primeraCorrida: true,
        hallazgos: [{ dimension: "Hiring", descripcion: "Nuevo rol de UX abierto", fuente: "https://linkedin.com/x" }],
      }),
    ]) as any[];
    expect(richText(blocks[1])).toContain("Primera corrida");
    expect(blocks[2].type).toBe("bulleted_list_item");
    expect(richText(blocks[2])).toBe("Hiring: Nuevo rol de UX abierto (fuente)");
  });

  it("marca sin novedades cuando no hay hallazgos", () => {
    const blocks = buildInformeBlocks([entityResult({})]) as any[];
    expect(richText(blocks[1])).toContain("Sin novedades");
  });

  it("lista cada hallazgo como bullet, con la dimensión en negrita y la fuente como hipervínculo real", () => {
    const blocks = buildInformeBlocks([
      entityResult({ hallazgos: [{ dimension: "Producto", descripcion: "Nueva versión 3.2", fuente: "https://x.com" }] }),
    ]) as any[];
    const bullet = blocks[1];
    expect(bullet.type).toBe("bulleted_list_item");
    const rt = bullet.bulleted_list_item.rich_text;
    expect(rt[0].annotations.bold).toBe(true);
    expect(rt[0].text.content).toBe("Producto: ");
    const linkPart = rt.find((t: any) => t.text.link);
    expect(linkPart.text.link.url).toBe("https://x.com");
  });

  it("un hallazgo sin fuente no agrega texto de hipervínculo", () => {
    const blocks = buildInformeBlocks([
      entityResult({ hallazgos: [{ dimension: "Producto", descripcion: "Nueva versión 3.2", fuente: "" }] }),
    ]) as any[];
    const rt = blocks[1].bulleted_list_item.rich_text;
    expect(rt.some((t: any) => t.text.link)).toBe(false);
  });

  it("muestra el error si la entidad falló", () => {
    const blocks = buildInformeBlocks([entityResult({ error: "timeout" })]) as any[];
    expect(richText(blocks[1])).toContain("Error en esta corrida: timeout");
  });
});

describe("buildBattlecardBlocks", () => {
  const baseSnapshot: EntitySnapshot = { entityId: "x", updatedAt: "2026-08-31T00:00:00Z" };

  it("sin battlecard no genera bloques", () => {
    expect(buildBattlecardBlocks(baseSnapshot)).toEqual([]);
  });

  it("con battlecard genera heading, amenaza, resumen, fortalezas y debilidades", () => {
    const blocks = buildBattlecardBlocks({
      ...baseSnapshot,
      battlecard: {
        resumen: "Crece rápido en LatAm",
        fortalezas: [{ texto: "multi-moneda", fuente: "https://x.com" }],
        debilidades: [{ texto: "poca marca en Bolivia", fuente: "" }],
        amenaza: "alta",
      },
    }) as any[];

    expect(blocks[0].type).toBe("heading_3");
    expect(richText(blocks[0])).toBe("Battlecard");

    const amenazaBlock = blocks.find((b) => b.type === "paragraph" && richText(b).startsWith("Amenaza:"));
    expect(richText(amenazaBlock)).toBe("Amenaza: alta");

    const resumenBlock = blocks.find((b) => b.type === "paragraph" && richText(b) === "Crece rápido en LatAm");
    expect(resumenBlock).toBeTruthy();

    const fortalezasHeadingIdx = blocks.findIndex((b) => b.type === "heading_3" && richText(b) === "Fortalezas");
    expect(fortalezasHeadingIdx).toBeGreaterThan(-1);
    expect(blocks[fortalezasHeadingIdx + 1].type).toBe("bulleted_list_item");
    expect(richText(blocks[fortalezasHeadingIdx + 1])).toBe("multi-moneda (fuente)");

    const debilidadesHeadingIdx = blocks.findIndex((b) => b.type === "heading_3" && richText(b) === "Debilidades");
    expect(debilidadesHeadingIdx).toBeGreaterThan(-1);
    expect(richText(blocks[debilidadesHeadingIdx + 1])).toBe("poca marca en Bolivia");
  });

  it("un punto de fortaleza/debilidad con fuente muestra un hipervínculo real", () => {
    const blocks = buildBattlecardBlocks({
      ...baseSnapshot,
      battlecard: { resumen: "", fortalezas: [{ texto: "multi-moneda", fuente: "https://x.com" }], debilidades: [], amenaza: "media" },
    }) as any[];
    const bullet = blocks.find((b) => b.type === "bulleted_list_item");
    const linkPart = bullet.bulleted_list_item.rich_text.find((t: any) => t.text.link);
    expect(linkPart.text.link.url).toBe("https://x.com");
  });

  it("sin fortalezas ni debilidades no agrega esos headings", () => {
    const blocks = buildBattlecardBlocks({
      ...baseSnapshot,
      battlecard: { resumen: "", fortalezas: [], debilidades: [], amenaza: "baja" },
    }) as any[];
    expect(blocks.some((b) => b.type === "heading_3" && richText(b) === "Fortalezas")).toBe(false);
    expect(blocks.some((b) => b.type === "heading_3" && richText(b) === "Debilidades")).toBe(false);
  });
});
