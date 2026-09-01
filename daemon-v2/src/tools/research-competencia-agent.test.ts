import { describe, it, expect } from "vitest";
import { buildEntityPrompt, parseAgentJson } from "./research-competencia-agent.js";
import { getEntity } from "./research-competencia-entities.js";

describe("buildEntityPrompt", () => {
  it("incluye el nombre de la entidad, el timeframe y la query de LinkedIn", () => {
    const entity = getEntity("takenos");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null }, 7);
    expect(prompt).toContain("Takenos");
    expect(prompt).toContain("últimos 7 días");
    expect(prompt).toContain(entity.linkedinQuery);
  });

  it("marca explícito cuando no hay baseline (primera corrida)", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null }, 7);
    expect(prompt).toContain("sin baseline — primera corrida");
  });

  it("incluye el baseline serializado cuando existe", () => {
    const entity = getEntity("meru");
    const baseline = { entityId: "meru", updatedAt: "2026-08-01T00:00:00Z", notas: "vio rol de Growth" };
    const prompt = buildEntityPrompt(entity, baseline, { ios: null, android: null, siteText: null }, 7);
    expect(prompt).toContain("vio rol de Growth");
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
    expect(result).toEqual({ hallazgos: [], notas: "" });
  });
});
