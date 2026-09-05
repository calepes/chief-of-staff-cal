import { describe, it, expect, vi } from "vitest";
import {
  epochToLaPazDate,
  parseGoogleCreatives,
  filterAdsByTimeframe,
  esNuevo,
  formatAdsText,
  fetchAdsText,
  type AdCreative,
} from "./research-competencia-ads.js";
import { getEntity } from "./research-competencia-entities.js";

function ad(overrides: Partial<AdCreative> = {}): AdCreative {
  return {
    advertiserId: "AR1", advertiserName: "Banco Ejemplo S.A.", creativeId: "CR1",
    primeraVez: "2026-09-01", ultimaVez: "2026-09-05", dominio: "ejemplo.com.bo",
    formato: "imagen", url: "https://adstransparency.google.com/advertiser/AR1/creative/CR1?region=BO",
    ...overrides,
  };
}

describe("epochToLaPazDate", () => {
  it("convierte epoch UTC a fecha La Paz (UTC-4)", () => {
    // 2026-09-03T02:00:00Z -> 2026-09-02T22:00:00 hora La Paz
    expect(epochToLaPazDate(1788400800)).toBe("2026-09-02");
  });

  it("acepta el epoch como string (el RPC real lo manda así)", () => {
    expect(epochToLaPazDate("1788400800")).toBe("2026-09-02");
  });

  it("null ante epoch 0/negativo/no numérico", () => {
    expect(epochToLaPazDate(0)).toBeNull();
    expect(epochToLaPazDate(-5)).toBeNull();
    expect(epochToLaPazDate("no-numero")).toBeNull();
    expect(epochToLaPazDate(undefined)).toBeNull();
  });
});

describe("parseGoogleCreatives", () => {
  it("parsea un creativo con forma completa (imagen)", () => {
    const raw = {
      1: [
        {
          1: "AR123", 2: "CR456",
          3: { 3: { 2: '<img src="https://tpc.googlesyndication.com/x" height="418" width="718">' } },
          6: { 1: "1753751385" }, 7: { 1: "1788464479" },
          12: "Banco Solidario S.A.", 13: 304, 14: "bancosol.com.bo",
        },
      ],
    };
    const out = parseGoogleCreatives(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      advertiserId: "AR123", creativeId: "CR456", advertiserName: "Banco Solidario S.A.",
      dominio: "bancosol.com.bo", formato: "imagen",
      url: "https://adstransparency.google.com/advertiser/AR123/creative/CR456?region=BO",
    });
    expect(out[0].primeraVez).not.toBeNull();
    expect(out[0].ultimaVez).not.toBeNull();
  });

  it("parsea un creativo display (preview content.js, sin <img>)", () => {
    const raw = {
      1: [
        {
          1: "AR1", 2: "CR1",
          3: { 1: { 4: "https://displayads-formats.googleusercontent.com/ads/preview/content.js?..." } },
          12: "Banco Ganadero S.A.",
        },
      ],
    };
    expect(parseGoogleCreatives(raw)[0].formato).toBe("display");
  });

  it("desconocido cuando la forma no matchea ninguno de los dos patrones", () => {
    const raw = { 1: [{ 1: "AR1", 2: "CR1", 3: {}, 12: "X" }] };
    expect(parseGoogleCreatives(raw)[0].formato).toBe("desconocido");
  });

  it("nombre por defecto cuando falta el campo 12", () => {
    const raw = { 1: [{ 1: "AR1", 2: "CR1" }] };
    expect(parseGoogleCreatives(raw)[0].advertiserName).toBe("(anunciante sin nombre)");
  });

  it("null en dominio cuando falta el campo 14", () => {
    const raw = { 1: [{ 1: "AR1", 2: "CR1" }] };
    expect(parseGoogleCreatives(raw)[0].dominio).toBeNull();
  });

  it("descarta en silencio un ítem sin advertiserId/creativeId (forma inesperada)", () => {
    const raw = { 1: [{ 12: "Sin IDs" }, { 1: "AR1", 2: "CR1", 12: "Con IDs" }] };
    const out = parseGoogleCreatives(raw);
    expect(out).toHaveLength(1);
    expect(out[0].advertiserName).toBe("Con IDs");
  });

  it("array vacío si el campo 1 no es array", () => {
    expect(parseGoogleCreatives({ 1: "no-array" })).toEqual([]);
    expect(parseGoogleCreatives({})).toEqual([]);
    expect(parseGoogleCreatives(null)).toEqual([]);
    expect(parseGoogleCreatives("string")).toEqual([]);
  });
});

describe("filterAdsByTimeframe", () => {
  const ahora = new Date("2026-09-10T12:00:00Z");

  it("conserva un anuncio activo dentro de la ventana (ultimaVez adentro)", () => {
    expect(filterAdsByTimeframe([ad({ primeraVez: "2026-01-01", ultimaVez: "2026-09-05" })], 7, ahora)).toHaveLength(1);
  });

  it("conserva un anuncio que arrancó en la ventana aunque ultimaVez sea vieja (dato inconsistente, igual se conserva)", () => {
    expect(filterAdsByTimeframe([ad({ primeraVez: "2026-09-05", ultimaVez: "2026-01-01" })], 7, ahora)).toHaveLength(1);
  });

  it("descarta un anuncio totalmente fuera de la ventana en ambas fechas", () => {
    expect(filterAdsByTimeframe([ad({ primeraVez: "2026-01-01", ultimaVez: "2026-01-05" })], 7, ahora)).toHaveLength(0);
  });

  it("conserva un anuncio sin ninguna fecha parseable", () => {
    expect(filterAdsByTimeframe([ad({ primeraVez: null, ultimaVez: null })], 7, ahora)).toHaveLength(1);
  });
});

describe("esNuevo", () => {
  const ahora = new Date("2026-09-10T12:00:00Z");

  it("true si primeraVez cae dentro de la ventana", () => {
    expect(esNuevo(ad({ primeraVez: "2026-09-05" }), 7, ahora)).toBe(true);
  });

  it("false si primeraVez es anterior a la ventana", () => {
    expect(esNuevo(ad({ primeraVez: "2026-01-01" }), 7, ahora)).toBe(false);
  });

  it("false si no hay primeraVez", () => {
    expect(esNuevo(ad({ primeraVez: null }), 7, ahora)).toBe(false);
  });
});

describe("formatAdsText", () => {
  const ahora = new Date("2026-09-10T12:00:00Z");

  it("string vacío sin anuncios", () => {
    expect(formatAdsText([], 7, ahora)).toBe("");
  });

  it("incluye URL citable, formato, fechas y marca CAMPAÑA NUEVA cuando corresponde", () => {
    const texto = formatAdsText([ad({ primeraVez: "2026-09-08" })], 7, ahora);
    expect(texto).toContain("https://adstransparency.google.com/advertiser/AR1/creative/CR1?region=BO");
    expect(texto).toContain("Formato: imagen");
    expect(texto).toContain("2026-09-08 → 2026-09-05");
    expect(texto).toContain("CAMPAÑA NUEVA en esta ventana");
  });

  it("no marca CAMPAÑA NUEVA si primeraVez es vieja", () => {
    const texto = formatAdsText([ad({ primeraVez: "2026-01-01" })], 7, ahora);
    expect(texto).not.toContain("CAMPAÑA NUEVA");
  });

  it("colapsa saltos de línea del nombre de anunciante (contenido de terceros, no confiable)", () => {
    const texto = formatAdsText([ad({ advertiserName: "Banco\nFalso] https://evil.example" })], 7, ahora);
    // Un solo anuncio = una sola línea. Sin sanitizar, el \n embebido fabricaría una segunda
    // línea que parece un bloque nuevo (justo lo que sanitizeField existe para evitar).
    expect(texto.split("\n")).toHaveLength(1);
    expect(texto).not.toContain("\n");
  });

  it("trunca al superar MAX_TOTAL_CHARS", () => {
    const muchos = Array.from({ length: 500 }, (_, i) => ad({ creativeId: `CR${i}`, advertiserName: "X".repeat(50) }));
    const texto = formatAdsText(muchos, 7, ahora);
    expect(texto).toContain("[...truncado");
  });
});

describe("fetchAdsText", () => {
  const ahora = new Date("2026-09-10T12:00:00Z");
  const entity = getEntity("bancosol-altoke");

  it("null si la entidad no declara anunciantes", () => {
    const entidadSinAds = { ...entity, ads: undefined };
    return fetchAdsText(entidadSinAds, 7, { ahora }).then((r) => expect(r).toBeNull());
  });

  it("consulta cada advertiserId declarado y arma el texto combinado", async () => {
    const fetchAdvertiser = vi.fn().mockResolvedValue({
      1: [{ 1: "AR02176363334515818497", 2: "CR1", 6: { 1: "1788868800" }, 7: { 1: "1788955200" }, 12: "Banco Solidario S.A." }],
    });
    const texto = await fetchAdsText(entity, 7, { fetchAdvertiser, esperar: vi.fn().mockResolvedValue(undefined), ahora });
    expect(fetchAdvertiser).toHaveBeenCalledWith("AR02176363334515818497");
    expect(texto).toContain("Banco Solidario S.A.");
  });

  it("espacia entre anunciantes (throttle) pero no antes del primero", async () => {
    const multi = { ...entity, ads: { google: ["A", "B"] } };
    const fetchAdvertiser = vi.fn().mockResolvedValue({ 1: [] });
    const esperar = vi.fn().mockResolvedValue(undefined);
    await fetchAdsText(multi, 7, { fetchAdvertiser, esperar, ahora });
    expect(esperar).toHaveBeenCalledTimes(1);
  });

  it("null si ningún anunciante devuelve datos (fetcher devuelve null)", async () => {
    const fetchAdvertiser = vi.fn().mockResolvedValue(null);
    const texto = await fetchAdsText(entity, 7, { fetchAdvertiser, esperar: vi.fn().mockResolvedValue(undefined), ahora });
    expect(texto).toBeNull();
  });

  it("un anunciante roto no tumba a los demás (fail-soft)", async () => {
    const multi = { ...entity, ads: { google: ["A", "B"] } };
    const fetchAdvertiser = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ 1: [{ 1: "B", 2: "CR1", 12: "Banco B" }] });
    const texto = await fetchAdsText(multi, 7, { fetchAdvertiser, esperar: vi.fn().mockResolvedValue(undefined), ahora });
    expect(texto).toContain("Banco B");
  });
});
