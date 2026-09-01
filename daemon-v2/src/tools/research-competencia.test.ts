import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./research-competencia-sources.js", () => ({
  fetchIosAppInfo: vi.fn(async () => null),
  fetchAndroidAppInfo: vi.fn(async () => null),
  fetchSiteText: vi.fn(async () => null),
  chunkText: (text: string) => [text],
}));
vi.mock("./research-competencia-agent.js", () => ({
  buildEntityPrompt: vi.fn(() => "prompt"),
  runEntityAgent: vi.fn(async () => '{"hallazgos":[],"notas":""}'),
  parseAgentJson: vi.fn((raw: string) => JSON.parse(raw)),
}));
vi.mock("./research-competencia-notion.js", () => ({
  readEntityState: vi.fn(async () => null),
  writeEntityState: vi.fn(async () => {}),
  appendCambios: vi.fn(async () => {}),
  createInformePage: vi.fn(async () => ({ pageId: "page1", url: "https://notion.so/page1" })),
}));

import { readEntityState, writeEntityState, appendCambios, createInformePage } from "./research-competencia-notion.js";
import { runEntityAgent, parseAgentJson } from "./research-competencia-agent.js";
import { runResearchCompetencia, formatSummaryHtml } from "./research-competencia.js";

const mockReadState = vi.mocked(readEntityState);
const mockWriteState = vi.mocked(writeEntityState);
const mockAppendCambios = vi.mocked(appendCambios);
const mockCreateInforme = vi.mocked(createInformePage);
const mockRunAgent = vi.mocked(runEntityAgent);
const mockParseJson = vi.mocked(parseAgentJson);

describe("runResearchCompetencia", () => {
  beforeEach(() => vi.clearAllMocks());

  it("corre las 6 entidades por default y crea la página de informe", async () => {
    const result = await runResearchCompetencia({});
    expect(result.entidades).toHaveLength(6);
    expect(mockCreateInforme).toHaveBeenCalledTimes(1);
    expect(result.informeUrl).toBe("https://notion.so/page1");
  });

  it("primera corrida (sin baseline) no genera hallazgos ni filas en Cambios, aunque el agente devuelva alguno", async () => {
    mockReadState.mockResolvedValue(null);
    mockRunAgent.mockResolvedValue('{"hallazgos":[{"dimension":"Producto","descripcion":"x","fuente":""}],"notas":""}');
    mockParseJson.mockReturnValue({ hallazgos: [{ dimension: "Producto", descripcion: "x", fuente: "" }], notas: "" });

    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });

    expect(result.entidades[0].primeraCorrida).toBe(true);
    expect(result.entidades[0].hallazgos).toEqual([]);
    expect(mockAppendCambios).not.toHaveBeenCalled();
    expect(mockWriteState).toHaveBeenCalledTimes(1);
  });

  it("corrida normal (con baseline) sí propaga los hallazgos del agente", async () => {
    mockReadState.mockResolvedValue({ entityId: "takenos", updatedAt: "2026-08-01T00:00:00Z" });
    mockRunAgent.mockResolvedValue('{"hallazgos":[{"dimension":"GTM","descripcion":"promo nueva","fuente":"https://x.com"}],"notas":""}');
    mockParseJson.mockReturnValue({ hallazgos: [{ dimension: "GTM", descripcion: "promo nueva", fuente: "https://x.com" }], notas: "" });

    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });

    expect(result.entidades[0].hallazgos).toHaveLength(1);
    expect(mockAppendCambios).toHaveBeenCalledWith("takenos", result.entidades[0].hallazgos, "page1", result.fecha);
    expect(result.totalHallazgos).toBe(1);
  });

  it("una entidad que falla no interrumpe a las demás", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("boom"));

    const result = await runResearchCompetencia({ entidadIds: ["takenos", "meru"] });

    expect(result.entidades).toHaveLength(2);
    expect(result.entidades[0].error).toBe("boom");
    expect(result.entidades[1].error).toBeUndefined();
  });

  it("raw vacío del agente (corte por maxTurns) se marca como error, no como sin hallazgos", async () => {
    mockRunAgent.mockResolvedValueOnce("");

    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });

    expect(result.entidades[0].error).toContain("maxTurns");
    expect(result.entidades[0].hallazgos).toEqual([]);
    expect(mockParseJson).not.toHaveBeenCalled();
  });

  it("un id inválido en entidadIds no rompe la corrida completa, otras entidades sí se procesan", async () => {
    const result = await runResearchCompetencia({ entidadIds: ["ganadero", "takenos"] });

    expect(result.entidades).toHaveLength(2);
    expect(result.entidades[0].entityId).toBe("ganadero");
    expect(result.entidades[0].error).toContain("Entidad desconocida: ganadero");
    expect(result.entidades[1].entityId).toBe("takenos");
    expect(result.entidades[1].error).toBeUndefined();
  });
});

describe("formatSummaryHtml", () => {
  it("dice 'sin novedades' cuando no hay hallazgos", () => {
    const html = formatSummaryHtml({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0 });
    expect(html).toContain("Sin novedades relevantes");
  });

  it("incluye el link al informe cuando existe", () => {
    const html = formatSummaryHtml({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0, informeUrl: "https://notion.so/x" });
    expect(html).toContain("https://notion.so/x");
  });

  it("distingue primera corrida (sin comparación) de sin novedades", () => {
    const html = formatSummaryHtml({
      fecha: "2026-08-31",
      timeframeDias: 7,
      totalHallazgos: 0,
      entidades: [
        { entityId: "takenos", entityNombre: "Takenos", primeraCorrida: true, hallazgos: [], snapshot: { entityId: "takenos", updatedAt: "" } },
      ],
    });
    expect(html).toContain("primera corrida");
    expect(html).toContain("Takenos");
  });
});
