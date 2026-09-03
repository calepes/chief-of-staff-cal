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
vi.mock("./research-competencia-social.js", () => ({
  fetchSocialText: vi.fn(async () => "[instagram @altoke.bo] Promo nueva"),
}));

import { readEntityState, writeEntityState, appendCambios, createInformePage } from "./research-competencia-notion.js";
import { buildEntityPrompt, runEntityAgent, parseAgentJson } from "./research-competencia-agent.js";
import { fetchSocialText } from "./research-competencia-social.js";
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

  it("primera corrida (sin baseline) no genera filas en Cambios, pero sí propaga los hallazgos del agente al resultado", async () => {
    mockReadState.mockResolvedValue(null);
    mockRunAgent.mockResolvedValue('{"hallazgos":[{"dimension":"Producto","descripcion":"x","fuente":""}],"notas":""}');
    mockParseJson.mockReturnValue({
      hallazgos: [{ dimension: "Producto", descripcion: "x", fuente: "" }],
      notas: "",
      battlecard: { resumen: "", fortalezas: [], debilidades: [], amenaza: "media" },
    });

    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });

    expect(result.entidades[0].primeraCorrida).toBe(true);
    expect(result.entidades[0].hallazgos).toEqual([{ dimension: "Producto", descripcion: "x", fuente: "" }]);
    expect(mockAppendCambios).not.toHaveBeenCalled();
    expect(mockWriteState).toHaveBeenCalledTimes(1);
  });

  it("corrida normal (con baseline) sí propaga los hallazgos del agente", async () => {
    mockReadState.mockResolvedValue({ entityId: "takenos", updatedAt: "2026-08-01T00:00:00Z" });
    mockRunAgent.mockResolvedValue('{"hallazgos":[{"dimension":"GTM","descripcion":"promo nueva","fuente":"https://x.com"}],"notas":""}');
    mockParseJson.mockReturnValue({
      hallazgos: [{ dimension: "GTM", descripcion: "promo nueva", fuente: "https://x.com" }],
      notas: "",
      battlecard: { resumen: "Crece rápido", fortalezas: [{ texto: "multi-moneda", fuente: "https://x.com" }], debilidades: [], amenaza: "alta" },
    });

    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });

    expect(result.entidades[0].hallazgos).toHaveLength(1);
    expect(mockAppendCambios).toHaveBeenCalledWith("takenos", result.entidades[0].hallazgos, "page1", result.fecha);
    expect(result.totalHallazgos).toBe(1);
    expect(result.entidades[0].snapshot.battlecard).toEqual({ resumen: "Crece rápido", fortalezas: [{ texto: "multi-moneda", fuente: "https://x.com" }], debilidades: [], amenaza: "alta" });
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

  it("pasa el texto de RRSS al prompt del agente", async () => {
    await runResearchCompetencia({ entidadIds: ["takenos"] });
    const facts = vi.mocked(buildEntityPrompt).mock.calls[0][2];
    expect(facts.socialText).toBe("[instagram @altoke.bo] Promo nueva");
  });

  it("sin getCookies en opts, no cuenta intentos de cookies (bloqueante 2)", async () => {
    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });
    expect(result.socialCookiesIntentos).toBe(0);
    expect(result.socialCookiesEncontradas).toBe(0);
  });

  it("cuenta intentos y hallazgos de cookies sociales a través de todos los llamados a getCookies (bloqueante 2)", async () => {
    const getCookies = vi.fn(async (hostname: string) =>
      hostname === "instagram.com" ? [{ name: "a", value: "b", domain: ".instagram.com", path: "/" }] : [],
    );
    vi.mocked(fetchSocialText).mockImplementationOnce(async (_entity, _timeframeDias, deps) => {
      await deps?.getCookies?.("instagram.com");
      await deps?.getCookies?.("tiktok.com");
      return "texto";
    });

    const result = await runResearchCompetencia({ entidadIds: ["takenos"], getCookies });

    expect(result.socialCookiesIntentos).toBe(2);
    expect(result.socialCookiesEncontradas).toBe(1);
  });

  it("un getCookies que tira sigue contando el intento pero no el hallazgo", async () => {
    const getCookies = vi.fn(async () => {
      throw new Error("FDA rota");
    });
    vi.mocked(fetchSocialText).mockImplementationOnce(async (_entity, _timeframeDias, deps) => {
      await deps?.getCookies?.("instagram.com").catch(() => []);
      return null;
    });

    const result = await runResearchCompetencia({ entidadIds: ["takenos"], getCookies });

    expect(result.socialCookiesIntentos).toBe(1);
    expect(result.socialCookiesEncontradas).toBe(0);
  });

  it("una falla del scraping social no corta la corrida de la entidad", async () => {
    vi.mocked(fetchSocialText).mockRejectedValueOnce(new Error("boom"));
    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });
    expect(result.entidades[0].error).toBeUndefined();
  });

  it("un scraping social colgado no traba la entidad — corta al deadline y sigue con socialText null", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchSocialText).mockImplementationOnce(() => new Promise(() => {})); // nunca resuelve
      const resultPromise = runResearchCompetencia({ entidadIds: ["takenos"] });
      await vi.advanceTimersByTimeAsync(8 * 60 * 1000 + 1);
      const result = await resultPromise;

      expect(result.entidades[0].error).toBeUndefined();
      const facts = vi.mocked(buildEntityPrompt).mock.calls[0][2];
      expect(facts.socialText).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("no arranca una segunda corrida si ya hay una en curso (guard en proceso)", async () => {
    const first = runResearchCompetencia({ entidadIds: ["takenos"] });
    await expect(runResearchCompetencia({ entidadIds: ["meru"] })).rejects.toThrow(/en curso/i);
    await first; // dejar terminar la primera para no colgar el flag entre tests
  });

  it("libera el guard al terminar, permitiendo una corrida posterior", async () => {
    await runResearchCompetencia({ entidadIds: ["takenos"] });
    await expect(runResearchCompetencia({ entidadIds: ["meru"] })).resolves.toBeTruthy();
  });
});

// Campos de cookies con valores "sanos" por default (hubo intentos, y encontraron cookies) — así
// cada test de abajo que no le importa el bloqueante 2 no dispara la advertencia sin querer.
const COOKIES_OK = { socialCookiesIntentos: 4, socialCookiesEncontradas: 4 };

describe("formatSummaryHtml", () => {
  it("dice 'sin novedades' cuando no hay hallazgos", () => {
    const html = formatSummaryHtml({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0, ...COOKIES_OK });
    expect(html).toContain("Sin novedades relevantes");
  });

  it("incluye el link al informe cuando existe", () => {
    const html = formatSummaryHtml({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0, informeUrl: "https://notion.so/x", ...COOKIES_OK });
    expect(html).toContain("https://notion.so/x");
  });

  it("distingue primera corrida (sin comparación) de sin novedades", () => {
    const html = formatSummaryHtml({
      fecha: "2026-08-31",
      timeframeDias: 7,
      totalHallazgos: 0,
      ...COOKIES_OK,
      entidades: [
        { entityId: "takenos", entityNombre: "Takenos", primeraCorrida: true, hallazgos: [], snapshot: { entityId: "takenos", updatedAt: "" } },
      ],
    });
    expect(html).toContain("primera corrida");
    expect(html).toContain("Takenos");
  });

  it("sin advertencia de cookies cuando encontró al menos una", () => {
    const html = formatSummaryHtml({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0, socialCookiesIntentos: 4, socialCookiesEncontradas: 1 });
    expect(html).not.toContain("0 cookies de sesión");
  });

  it("sin advertencia de cookies cuando no hubo ningún intento (caller sin getCookies)", () => {
    const html = formatSummaryHtml({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0, socialCookiesIntentos: 0, socialCookiesEncontradas: 0 });
    expect(html).not.toContain("0 cookies de sesión");
  });

  it("advierte cuando hubo intentos de cookies pero ninguno encontró sesión (bloqueante 2)", () => {
    const html = formatSummaryHtml({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0, socialCookiesIntentos: 6, socialCookiesEncontradas: 0 });
    expect(html).toContain("0 cookies de sesión");
    expect(html).toContain("Full Disk Access");
  });

  it("la advertencia de cookies aparece aunque también haya hallazgos reales", () => {
    const html = formatSummaryHtml({
      fecha: "2026-08-31",
      timeframeDias: 7,
      totalHallazgos: 1,
      socialCookiesIntentos: 6,
      socialCookiesEncontradas: 0,
      entidades: [
        { entityId: "takenos", entityNombre: "Takenos", primeraCorrida: false, hallazgos: [{ dimension: "Producto", descripcion: "x", fuente: "" }], snapshot: { entityId: "takenos", updatedAt: "" } },
      ],
    });
    expect(html).toContain("0 cookies de sesión");
    expect(html).toContain("1 hallazgo");
  });
});
