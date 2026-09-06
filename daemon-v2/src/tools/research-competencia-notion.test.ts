import { describe, it, expect } from "vitest";
import { buildInformeBlocks, buildBattlecardBlocks, buildAdsKpisBlocks } from "./research-competencia-notion.js";
import type { EntityRunResult, EntitySnapshot, AdsKpis } from "./research-competencia-types.js";

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

  it("antepone la tabla comparativa de ads si al menos una entidad trae adsKpis", () => {
    const kpis: AdsKpis = { creativosActivos: 3, campanasNuevas: 1, duracionPromedioDias: 5, mixFormato: { imagen: 2, display: 1, desconocido: 0 } };
    const blocks = buildInformeBlocks([entityResult({ adsKpis: kpis })]) as any[];
    expect(blocks[0].type).toBe("heading_3");
    expect(richText(blocks[0])).toBe("Actividad publicitaria — comparativa");
    expect(blocks[1].type).toBe("paragraph");
    expect(richText(blocks[1])).toContain("NO son gasto real");
    expect(blocks[2].type).toBe("table");
  });

  it("sin ninguna entidad con adsKpis, no agrega la tabla comparativa", () => {
    const blocks = buildInformeBlocks([entityResult({})]) as any[];
    expect(blocks.some((b) => b.type === "table")).toBe(false);
  });

  it("muestra la línea de seguidores con delta cuando hay historial de 2+ puntos", () => {
    const blocks = buildInformeBlocks([
      entityResult({
        snapshot: {
          entityId: "x", updatedAt: "2026-09-05T00:00:00Z",
          seguidoresHistorial: [
            { fecha: "2026-08-29", instagram: 4700, facebook: 19000 },
            { fecha: "2026-09-05", instagram: 4712, facebook: 19500 },
          ],
        },
      }),
    ]) as any[];
    expect(richText(blocks[1])).toContain("Instagram: 4.712 (+12 vs. semana pasada)");
    expect(richText(blocks[1])).toContain("Facebook: 19.500 (+500 vs. semana pasada)");
  });

  it("sin historial de seguidores no agrega ninguna línea extra", () => {
    const blocks = buildInformeBlocks([entityResult({})]) as any[];
    expect(blocks[1].type).not.toBe("paragraph_seguidores");
    expect(richText(blocks[1])).toContain("Sin novedades");
  });
});

describe("buildAdsKpisBlocks", () => {
  it("array vacío si ninguna entidad trae adsKpis", () => {
    expect(buildAdsKpisBlocks([entityResult({})])).toEqual([]);
  });

  it("usa '—' para una entidad sin adsKpis cuando OTRA sí lo trae", () => {
    const kpis: AdsKpis = { creativosActivos: 1, campanasNuevas: 0, duracionPromedioDias: null, mixFormato: { imagen: 1, display: 0, desconocido: 0 } };
    const blocks = buildAdsKpisBlocks([entityResult({ entityNombre: "Con datos", adsKpis: kpis }), entityResult({ entityNombre: "Sin datos" })]) as any[];
    const tabla = blocks.find((b) => b.type === "table");
    const filaSinDatos = tabla.table.children[2]; // [0]=header, [1]=Con datos, [2]=Sin datos
    expect(filaSinDatos.table_row.cells.map((c: any) => c[0].text.content)).toEqual(["Sin datos", "—", "—", "—", "—"]);
  });

  it("yapeAdsKpis va como PRIMERA fila de datos, marcada '(referencia)', antes que las entidades", () => {
    const kpisYape: AdsKpis = { creativosActivos: 69, campanasNuevas: 32, duracionPromedioDias: 271.1, mixFormato: { imagen: 17, display: 23, desconocido: 0 } };
    const kpisEntidad: AdsKpis = { creativosActivos: 1, campanasNuevas: 0, duracionPromedioDias: null, mixFormato: { imagen: 1, display: 0, desconocido: 0 } };
    const blocks = buildAdsKpisBlocks([entityResult({ entityNombre: "Un competidor", adsKpis: kpisEntidad })], kpisYape) as any[];
    const tabla = blocks.find((b) => b.type === "table");
    const filaYape = tabla.table.children[1]; // [0]=header, [1]=Yape, [2]=el competidor
    expect(filaYape.table_row.cells.map((c: any) => c[0].text.content)).toEqual(["Yape Bolivia (referencia)", "69", "32", "271.1", "17 / 23 / 0"]);
    const filaCompetidor = tabla.table.children[2];
    expect(filaCompetidor.table_row.cells[0][0].text.content).toBe("Un competidor");
  });

  it("igual arma la tabla si NINGUNA entidad trae adsKpis pero SÍ hay yapeAdsKpis", () => {
    const kpisYape: AdsKpis = { creativosActivos: 5, campanasNuevas: 1, duracionPromedioDias: 10, mixFormato: { imagen: 0, display: 5, desconocido: 0 } };
    const blocks = buildAdsKpisBlocks([entityResult({})], kpisYape) as any[];
    expect(blocks.find((b) => b.type === "table")).toBeDefined();
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
