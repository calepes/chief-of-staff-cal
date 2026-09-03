import { describe, it, expect } from "vitest";
import { buildEntityPrompt, parseAgentJson } from "./research-competencia-agent.js";
import { getEntity } from "./research-competencia-entities.js";

describe("buildEntityPrompt", () => {
  it("incluye el nombre de la entidad, el timeframe y la query de LinkedIn", () => {
    const entity = getEntity("takenos");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null }, 7);
    expect(prompt).toContain("Takenos");
    expect(prompt).toContain("últimos 7 días");
    expect(prompt).toContain(entity.linkedinQuery);
  });

  it("marca explícito cuando no hay baseline (primera corrida)", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null }, 7);
    expect(prompt).toContain("sin baseline — primera corrida");
  });

  it("incluye el baseline serializado cuando existe", () => {
    const entity = getEntity("meru");
    const baseline = { entityId: "meru", updatedAt: "2026-08-01T00:00:00Z", notas: "vio rol de Growth" };
    const prompt = buildEntityPrompt(entity, baseline, { ios: null, android: null, siteText: null, socialText: null }, 7);
    expect(prompt).toContain("vio rol de Growth");
  });

  it("pide un battlecard con nivel de amenaza para Yape", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null }, 7);
    expect(prompt).toContain("battlecard");
    expect(prompt).toContain("amenaza");
  });

  it("exige que el battlecard nunca quede vacío aunque no haya hallazgos nuevos", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null }, 7);
    expect(prompt).toContain("NUNCA deben quedar vacíos");
  });

  it("pide repetir del baseline las fortalezas/debilidades que siguen vigentes, sin re-verificar", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null }, 7);
    expect(prompt).toContain("REPETILAS tal cual");
  });
});

describe("parseAgentJson", () => {
  it("parsea un JSON limpio", () => {
    const result = parseAgentJson('{"hallazgos":[{"dimension":"Producto","descripcion":"Nueva versión","fuente":"https://x.com"}],"notas":"ok"}');
    expect(result.hallazgos).toEqual([{ dimension: "Producto", descripcion: "Nueva versión", fuente: "https://x.com" }]);
    expect(result.notas).toBe("ok");
  });

  it("extrae el JSON aunque venga rodeado de prosa", () => {
    const result = parseAgentJson('Acá está el resultado:\n{"hallazgos":[],"notas":"nada"}\nListo.');
    expect(result.hallazgos).toEqual([]);
    expect(result.notas).toBe("nada");
  });

  it("descarta hallazgos con dimensión inválida", () => {
    const result = parseAgentJson('{"hallazgos":[{"dimension":"Inventada","descripcion":"x","fuente":""}],"notas":""}');
    expect(result.hallazgos).toEqual([]);
  });

  it("devuelve vacío si no hay JSON parseable", () => {
    const result = parseAgentJson("no hay nada acá");
    expect(result).toEqual({ hallazgos: [], notas: "", battlecard: { resumen: "", fortalezas: [], debilidades: [], amenaza: "media" } });
  });

  it("parsea el battlecard cuando viene completo, con fuente por cada punto", () => {
    const result = parseAgentJson(
      '{"hallazgos":[],"notas":"","battlecard":{"resumen":"Crece rápido en LatAm","fortalezas":[{"texto":"multi-moneda","fuente":"https://x.com"}],"debilidades":[{"texto":"poca marca en Bolivia","fuente":""}],"amenaza":"alta"}}',
    );
    expect(result.battlecard).toEqual({
      resumen: "Crece rápido en LatAm",
      fortalezas: [{ texto: "multi-moneda", fuente: "https://x.com" }],
      debilidades: [{ texto: "poca marca en Bolivia", fuente: "" }],
      amenaza: "alta",
    });
  });

  it("descarta puntos de fortalezas/debilidades sin campo texto", () => {
    const result = parseAgentJson('{"hallazgos":[],"notas":"","battlecard":{"fortalezas":[{"fuente":"https://x.com"}],"debilidades":[],"amenaza":"media"}}');
    expect(result.battlecard.fortalezas).toEqual([]);
  });

  it("si el battlecard viene inválido o ausente, usa defaults seguros (amenaza 'media')", () => {
    const result = parseAgentJson('{"hallazgos":[],"notas":"","battlecard":{"amenaza":"catastrófica"}}');
    expect(result.battlecard).toEqual({ resumen: "", fortalezas: [], debilidades: [], amenaza: "media" });
  });
});
