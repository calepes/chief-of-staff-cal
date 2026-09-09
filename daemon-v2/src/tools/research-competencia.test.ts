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
vi.mock("./research-competencia-ads.js", () => ({
  fetchAdsText: vi.fn(async () => ({
    texto: "[google-ads · Banco Solidario S.A.] https://adstransparency.google.com/x",
    creativos: [],
  })),
  computeAdsKpis: vi.fn(() => ({
    creativosActivos: 0, campanasNuevas: 0, duracionPromedioDias: null,
    google: { nuevos: 0, existentes: 0 }, meta: { nuevos: 0, existentes: 0 },
    mixFormato: { imagen: 0, display: 0, desconocido: 0 },
  })),
}));
vi.mock("./research-competencia-meta-ads.js", () => ({
  fetchMetaAdsText: vi.fn(async () => ({ texto: null, creativos: [] })),
}));
vi.mock("./research-competencia-scrapers.js", () => ({
  fetchInstagramFollowers: vi.fn(async () => null),
  fetchFacebookFollowers: vi.fn(async () => null),
}));
vi.mock("./research-competencia-browser.js", () => ({
  openResearchBrowserSession: vi.fn(async () => ({ context: {}, close: vi.fn(async () => {}) })),
}));
vi.mock("./research-competencia-history.js", () => ({
  findExistingUrls: vi.fn().mockResolvedValue(new Map()),
  insertPosts: vi.fn().mockResolvedValue(undefined),
  getAggregateStats: vi.fn().mockResolvedValue(null),
  formatHistoryText: vi.fn((stats) => (stats ? `${stats.total} posts detectados` : null)),
}));

import { readEntityState, writeEntityState, appendCambios, createInformePage } from "./research-competencia-notion.js";
import { buildEntityPrompt, runEntityAgent, parseAgentJson } from "./research-competencia-agent.js";
import { fetchSocialText } from "./research-competencia-social.js";
import { fetchAdsText } from "./research-competencia-ads.js";
import { openResearchBrowserSession } from "./research-competencia-browser.js";
import { getAggregateStats } from "./research-competencia-history.js";
import { runResearchCompetencia, formatSummaryHtml, SOCIAL_TIMEOUT_MS, ADS_TIMEOUT_MS } from "./research-competencia.js";

const mockReadState = vi.mocked(readEntityState);
const mockWriteState = vi.mocked(writeEntityState);
const mockAppendCambios = vi.mocked(appendCambios);
const mockCreateInforme = vi.mocked(createInformePage);
const mockRunAgent = vi.mocked(runEntityAgent);
const mockParseJson = vi.mocked(parseAgentJson);
const mockOpenBrowser = vi.mocked(openResearchBrowserSession);

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

  it("BLOQUEANTE 2: un runEntityAgent colgado no traba el proceso — corta al deadline y marca error explícito", async () => {
    vi.useFakeTimers();
    try {
      mockRunAgent.mockImplementationOnce(() => new Promise(() => {})); // nunca resuelve
      const resultPromise = runResearchCompetencia({ entidadIds: ["takenos", "meru"] });
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      const result = await resultPromise;

      expect(result.entidades[0].error).toMatch(/timeout|no respondió/i);
      // La segunda entidad se procesa igual — el timeout de la primera no aborta la corrida.
      expect(result.entidades[1].entityId).toBe("meru");
      expect(result.entidades[1].error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("BLOQUEANTE 1: un fallo de writeEntityState en el loop de escritura de Notion marca esa entidad como error y sigue con las demás", async () => {
    mockWriteState.mockRejectedValueOnce(new Error("Notion caído"));

    const result = await runResearchCompetencia({ entidadIds: ["takenos", "meru"] });

    expect(result.entidades[0].entityId).toBe("takenos");
    expect(result.entidades[0].error).toBe("Notion caído");
    // La segunda entidad igual llega a escribirse — el fallo de la primera no aborta el loop.
    expect(mockWriteState).toHaveBeenCalledTimes(2);
    expect(result.entidades[1].error).toBeUndefined();
  });

  it("BLOQUEANTE 1: un fallo de appendCambios también se captura y marca la entidad, sin abortar la corrida", async () => {
    mockReadState.mockResolvedValueOnce({ entityId: "takenos", updatedAt: "2026-08-01T00:00:00Z" });
    mockRunAgent.mockResolvedValueOnce('{"hallazgos":[{"dimension":"GTM","descripcion":"x","fuente":""}],"notas":""}');
    mockParseJson.mockReturnValueOnce({
      hallazgos: [{ dimension: "GTM", descripcion: "x", fuente: "" }],
      notas: "",
      battlecard: { resumen: "", fortalezas: [], debilidades: [], amenaza: "media" },
    });
    mockAppendCambios.mockRejectedValueOnce(new Error("Notion rate limit"));

    const result = await runResearchCompetencia({ entidadIds: ["takenos", "meru"] });

    expect(result.entidades[0].error).toBe("Notion rate limit");
    // writeEntityState NUNCA corre para takenos — el throw de appendCambios corta antes; sí corre
    // para meru (1 sola llamada total).
    expect(mockWriteState).toHaveBeenCalledTimes(1);
    expect(result.entidades[1].error).toBeUndefined();
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

  it("pasa el texto de ads al prompt del agente", async () => {
    await runResearchCompetencia({ entidadIds: ["takenos"] });
    const facts = vi.mocked(buildEntityPrompt).mock.calls[0][2];
    expect(facts.adsText).toBe("[google-ads · Banco Solidario S.A.] https://adstransparency.google.com/x");
  });

  it("pasa historyText a MechanicalFacts a partir de getAggregateStats", async () => {
    vi.mocked(getAggregateStats).mockResolvedValue({ total: 5, primeraFecha: "2026-08-01", ultimaFecha: "2026-09-01", promedioSemanal: 1.1 });
    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });
    expect(buildEntityPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ historyText: expect.stringContaining("5 posts") }),
      expect.anything(),
    );
  });

  it("un fallo de getAggregateStats no aborta la entidad — historyText queda null", async () => {
    vi.mocked(getAggregateStats).mockRejectedValue(new Error("d1 down"));
    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });
    expect(result.entidades[0].error).toBeUndefined();
  });

  it("incluye yapeAdsKpis en el resultado — referencia propia, corre en paralelo con el lote de entidades", async () => {
    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });
    expect(result.yapeAdsKpis).toEqual({
      creativosActivos: 0, campanasNuevas: 0, duracionPromedioDias: null,
      google: { nuevos: 0, existentes: 0 }, meta: { nuevos: 0, existentes: 0 },
      mixFormato: { imagen: 0, display: 0, desconocido: 0 },
    });
  });

  it("yapeAdsKpis queda undefined (fail-soft) si el fetch de Yape falla, sin afectar a las entidades", async () => {
    vi.mocked(fetchAdsText).mockImplementation(async (entity) => {
      if (entity.id === "yape-bolivia") throw new Error("boom");
      return { texto: "[google-ads · Banco Solidario S.A.] https://adstransparency.google.com/x", creativos: [] };
    });
    try {
      const result = await runResearchCompetencia({ entidadIds: ["takenos"] });
      expect(result.yapeAdsKpis).toBeUndefined();
      expect(result.entidades[0].error).toBeUndefined();
    } finally {
      vi.mocked(fetchAdsText).mockImplementation(async () => ({
        texto: "[google-ads · Banco Solidario S.A.] https://adstransparency.google.com/x",
        creativos: [],
      }));
    }
  });

  it("una falla del bloque de ads no corta la corrida de la entidad", async () => {
    // Por entity.id, no `mockRejectedValueOnce` — ver el comentario del test de "colgado" más
    // abajo sobre por qué el fetch de Yape Bolivia (que corre primero) se comería un rechazo
    // por-orden-de-llamada en vez de la entidad bajo prueba.
    vi.mocked(fetchAdsText).mockImplementation(async (entity) => {
      if (entity.id === "takenos") throw new Error("boom");
      return { texto: null, creativos: [] };
    });
    try {
      const result = await runResearchCompetencia({ entidadIds: ["takenos"] });
      expect(result.entidades[0].error).toBeUndefined();
    } finally {
      vi.mocked(fetchAdsText).mockImplementation(async () => ({
        texto: "[google-ads · Banco Solidario S.A.] https://adstransparency.google.com/x",
        creativos: [],
      }));
    }
  });

  it("un bloque de ads colgado no traba la entidad — corta al deadline y sigue con adsText null", async () => {
    vi.useFakeTimers();
    try {
      // `mockImplementationOnce` no alcanza: `runResearchCompetencia` también dispara un fetch de
      // ads para Yape Bolivia (referencia propia) EN PARALELO con el de la entidad — si el "nunca
      // resuelve" fuera por-orden-de-llamada, podía tocarle a Yape en vez de a takenos, dejando la
      // entidad con ads reales y el test roto. Colgar específicamente por `entity.id` es robusto a
      // cuál de los dos fetches gane la carrera por ejecutarse primero.
      vi.mocked(fetchAdsText).mockImplementation((entity) =>
        entity.id === "takenos" ? new Promise(() => {}) : Promise.resolve({ texto: null, creativos: [] }),
      );
      const resultPromise = runResearchCompetencia({ entidadIds: ["takenos"] });
      await vi.advanceTimersByTimeAsync(ADS_TIMEOUT_MS + 1);
      const result = await resultPromise;

      expect(result.entidades[0].error).toBeUndefined();
      const facts = vi.mocked(buildEntityPrompt).mock.calls[0][2];
      expect(facts.adsText).toBeNull();
    } finally {
      vi.useRealTimers();
      // `mockImplementation` (a diferencia de `mockImplementationOnce`) PERSISTE entre tests —
      // `clearAllMocks` en el `beforeEach` de este archivo limpia calls/instances, no la
      // implementation. Sin restaurar acá, el "cuelgue condicional por entity.id" de arriba se
      // filtraba al siguiente test y lo colgaba a ÉL también (encontrado en vivo: rompía 9 tests
      // más, todos con "ya hay un research en curso" porque el guard nunca se liberaba).
      vi.mocked(fetchAdsText).mockImplementation(async () => ({
        texto: "[google-ads · Banco Solidario S.A.] https://adstransparency.google.com/x",
        creativos: [],
      }));
    }
  });

  it("abre el browser UNA vez para toda la corrida (no una por entidad) y lo cierra al terminar", async () => {
    await runResearchCompetencia({ entidadIds: ["takenos", "meru"] });
    expect(mockOpenBrowser).toHaveBeenCalledTimes(1);
    const session = await mockOpenBrowser.mock.results[0].value;
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("pasa el mismo context de la sesión a cada llamada de fetchSocialText", async () => {
    await runResearchCompetencia({ entidadIds: ["takenos", "meru"] });
    const session = await mockOpenBrowser.mock.results[0].value;
    const contexts = vi.mocked(fetchSocialText).mock.calls.map(([, , deps]) => deps.context);
    expect(contexts).toEqual([session.context, session.context]);
  });

  it("resultado trae socialBrowserAvailable:true cuando el browser abrió bien", async () => {
    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });
    expect(result.socialBrowserAvailable).toBe(true);
  });

  it("si el browser no puede abrirse, la corrida sigue sin social pero el resto funciona", async () => {
    mockOpenBrowser.mockRejectedValueOnce(new Error("Chrome no encontrado"));
    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });

    expect(result.socialBrowserAvailable).toBe(false);
    expect(result.entidades[0].error).toBeUndefined();
    expect(fetchSocialText).not.toHaveBeenCalled();
    const facts = vi.mocked(buildEntityPrompt).mock.calls[0][2];
    expect(facts.socialText).toBeNull();
  });

  it("cierra el browser aunque una entidad falle en el medio", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("boom"));
    await runResearchCompetencia({ entidadIds: ["takenos", "meru"] });
    const session = await mockOpenBrowser.mock.results[0].value;
    expect(session.close).toHaveBeenCalledTimes(1);
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
      await vi.advanceTimersByTimeAsync(SOCIAL_TIMEOUT_MS + 1);
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

  it("Tarea 3: procesa entidades en simultáneo (concurrencia), no una por una", async () => {
    vi.useFakeTimers();
    try {
      const inicios: Record<string, number> = {};
      mockRunAgent.mockImplementation(async (_prompt: string, entityId = "?") => {
        inicios[entityId] = Date.now();
        await new Promise((r) => setTimeout(r, 1000));
        return '{"hallazgos":[],"notas":""}';
      });

      const resultPromise = runResearchCompetencia({ entidadIds: ["takenos", "meru", "bancosol-altoke"] });
      await vi.advanceTimersByTimeAsync(1000 + 1);
      const result = await resultPromise;

      expect(result.entidades).toHaveLength(3);
      // Si el `for` fuera secuencial, el 3er `runEntityAgent` arrancaría ~2000ms después del
      // primero (2 esperas de 1000ms de por medio, una por cada entidad ya procesada). Corriendo
      // las 3 en la misma tanda (`CONCURRENCY=3`), los 3 arrancan casi juntos.
      const tiempos = Object.values(inicios);
      expect(tiempos).toHaveLength(3);
      expect(Math.max(...tiempos) - Math.min(...tiempos)).toBeLessThan(500);
    } finally {
      vi.useRealTimers();
      mockRunAgent.mockImplementation(async () => '{"hallazgos":[],"notas":""}');
    }
  });
});

// Browser "sano" por default — así cada test de abajo que no le importa la advertencia de Chrome
// no la dispara sin querer.
const BROWSER_OK = { socialBrowserAvailable: true };

describe("formatSummaryHtml", () => {
  it("dice 'sin novedades' cuando no hay hallazgos", () => {
    const html = formatSummaryHtml({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0, ...BROWSER_OK });
    expect(html).toContain("Sin novedades relevantes");
  });

  it("incluye el link al informe cuando existe", () => {
    const html = formatSummaryHtml({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0, informeUrl: "https://notion.so/x", ...BROWSER_OK });
    expect(html).toContain("https://notion.so/x");
  });

  it("distingue primera corrida (sin comparación) de sin novedades", () => {
    const html = formatSummaryHtml({
      fecha: "2026-08-31",
      timeframeDias: 7,
      totalHallazgos: 0,
      ...BROWSER_OK,
      entidades: [
        { entityId: "takenos", entityNombre: "Takenos", primeraCorrida: true, hallazgos: [], snapshot: { entityId: "takenos", updatedAt: "" } },
      ],
    });
    expect(html).toContain("primera corrida");
    expect(html).toContain("Takenos");
  });

  it("sin advertencia de browser cuando abrió bien", () => {
    const html = formatSummaryHtml({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0, socialBrowserAvailable: true });
    expect(html).not.toContain("No se pudo abrir Chrome");
  });

  it("advierte cuando el browser no pudo abrirse (bloqueante 2, adaptado a Chrome real)", () => {
    const html = formatSummaryHtml({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0, socialBrowserAvailable: false });
    expect(html).toContain("No se pudo abrir Chrome");
  });

  it("la advertencia de browser aparece aunque también haya hallazgos reales", () => {
    const html = formatSummaryHtml({
      fecha: "2026-08-31",
      timeframeDias: 7,
      totalHallazgos: 1,
      socialBrowserAvailable: false,
      entidades: [
        { entityId: "takenos", entityNombre: "Takenos", primeraCorrida: false, hallazgos: [{ dimension: "Producto", descripcion: "x", fuente: "" }], snapshot: { entityId: "takenos", updatedAt: "" } },
      ],
    });
    expect(html).toContain("No se pudo abrir Chrome");
    expect(html).toContain("1 hallazgo");
  });
});
