import { describe, it, expect } from "vitest";
import {
  parseMetaFecha,
  extractMetaAdCopy,
  parseMetaAdCards,
  formatMetaAdsText,
  fetchMetaAdsText,
  type RawMetaAdCard,
} from "./research-competencia-meta-ads.js";
import type { EntityConfig } from "./research-competencia-entities.js";

const ENTITY: EntityConfig = {
  id: "bancosol-altoke",
  nombre: "Banco Sol / Altoke",
  linkedinQuery: "x",
  ads: { google: [], meta: ["altoke"] },
};

// Capturado en vivo (2026-09-05) contra la Ad Library real, anuncio de Tigo Bolivia — usado acá
// solo como fixture de forma (no pasa el allowlist de `ENTITY`, ver el test de descarte).
const TIGO_FULL_TEXT =
  "ActivoIdentificador de la biblioteca: 2150741685519050En circulación desde el 4 ago 2026Plataformas" +
  "Abrir menú desplegableVer detalles del anuncioTigo BoliviaPublicidad" +
  "Ahora tus recargas digitales vienen con más. 😎📲Haz tus recargas desde Mi Tigo, Tigo Money, tu app bancaria o billetera móvil favorita y recibe 50% de crédito extra de REGALO + 2 SMS para navegar, llamar y disfrutar más.*Promo no válida si tienes activada la Doble Carga.➡️ Recarga crédito desde tu celular y aprovecha este beneficio.#Recarga #CréditoExtra #TigoBolivia" +
  "Tigo BoliviaMás información";

function tigoCard(overrides: Partial<RawMetaAdCard> = {}): RawMetaAdCard {
  return {
    libraryId: "2150741685519050",
    advertiserName: "Tigo Bolivia",
    circulacionTexto: "4 ago 2026",
    destinoHrefCruda:
      "https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.tigo.com.bo%2Fprepago%3Futm_source%3Dfacebook&h=x",
    imagenUrl: "https://scontent.example/creative.jpg",
    fullText: TIGO_FULL_TEXT,
    ...overrides,
  };
}

describe("parseMetaFecha", () => {
  it("parsea 'D mes YYYY' en español abreviado", () => {
    expect(parseMetaFecha("4 ago 2026")).toBe("2026-08-04");
    expect(parseMetaFecha("19 ago 2026")).toBe("2026-08-19");
    expect(parseMetaFecha("9 jul 2026")).toBe("2026-07-09");
  });

  it("devuelve null ante texto sin el formato esperado", () => {
    expect(parseMetaFecha("")).toBeNull();
    expect(parseMetaFecha("hace 3 días")).toBeNull();
  });
});

describe("extractMetaAdCopy", () => {
  it("recorta el copy real entre 'Publicidad' y el preview de destino final", () => {
    const copy = extractMetaAdCopy(TIGO_FULL_TEXT, "Tigo Bolivia");
    expect(copy).toContain("Ahora tus recargas digitales vienen con más");
    expect(copy).toContain("#TigoBolivia");
    expect(copy).not.toContain("Identificador de la biblioteca");
    expect(copy).not.toContain("Más información");
  });

  it("devuelve el texto completo si no encuentra las marcas (fail-soft)", () => {
    expect(extractMetaAdCopy("texto sin marcas", "Tigo Bolivia")).toBe("texto sin marcas");
  });
});

describe("parseMetaAdCards", () => {
  it("descarta un anunciante que no está en la allowlist de la entidad", () => {
    expect(parseMetaAdCards([tigoCard()], ENTITY)).toEqual([]);
  });

  it("acepta y parsea un anunciante que sí matchea (case-insensitive)", () => {
    const entity: EntityConfig = { ...ENTITY, ads: { google: [], meta: ["tigo bolivia"] } };
    const [ad] = parseMetaAdCards([tigoCard()], entity);
    expect(ad).toMatchObject({
      libraryId: "2150741685519050",
      advertiserName: "Tigo Bolivia",
      desde: "2026-08-04",
      dominio: "www.tigo.com.bo",
      imagenUrl: "https://scontent.example/creative.jpg",
      url: "https://www.facebook.com/ads/library/?id=2150741685519050",
    });
    expect(ad.copy).toContain("recargas digitales");
  });

  it("descarta tarjetas sin libraryId o sin advertiserName", () => {
    const entity: EntityConfig = { ...ENTITY, ads: { google: [], meta: ["tigo bolivia"] } };
    expect(parseMetaAdCards([tigoCard({ libraryId: null })], entity)).toEqual([]);
    expect(parseMetaAdCards([tigoCard({ advertiserName: null })], entity)).toEqual([]);
  });

  it("devuelve dominio null si el href de destino no trae ?u= parseable", () => {
    const entity: EntityConfig = { ...ENTITY, ads: { google: [], meta: ["tigo bolivia"] } };
    const [ad] = parseMetaAdCards([tigoCard({ destinoHrefCruda: null })], entity);
    expect(ad.dominio).toBeNull();
  });
});

describe("formatMetaAdsText", () => {
  const ahora = new Date("2026-09-05T12:00:00Z");
  const ad = {
    libraryId: "1",
    advertiserName: "altoke",
    desde: "2026-08-30",
    dominio: "www.altoke.com.bo",
    imagenUrl: null,
    copy: "Descarga altoke ya",
    url: "https://www.facebook.com/ads/library/?id=1",
  };

  it("devuelve '' con lista vacía", () => {
    expect(formatMetaAdsText([], 7, ahora)).toBe("");
  });

  it("marca CAMPAÑA NUEVA cuando 'desde' cae dentro de la ventana", () => {
    const texto = formatMetaAdsText([ad], 7, ahora);
    expect(texto).toContain("meta-ads · altoke");
    expect(texto).toContain("Descarga altoke ya");
    expect(texto).toContain("CAMPAÑA NUEVA en esta ventana");
  });

  it("no marca CAMPAÑA NUEVA fuera de la ventana", () => {
    const texto = formatMetaAdsText([{ ...ad, desde: "2026-01-01" }], 7, ahora);
    expect(texto).not.toContain("CAMPAÑA NUEVA");
  });
});

describe("fetchMetaAdsText", () => {
  it("devuelve null si la entidad no declara ads.meta", async () => {
    const entity: EntityConfig = { ...ENTITY, ads: { google: [] } };
    const texto = await fetchMetaAdsText(entity, 7, { fetchQuery: async () => [tigoCard()] });
    expect(texto).toBeNull();
  });

  it("dedupea por libraryId entre distintos términos de búsqueda", async () => {
    const entity: EntityConfig = { ...ENTITY, ads: { google: [], meta: ["tigo bolivia", "tigo"] } };
    let llamadas = 0;
    const texto = await fetchMetaAdsText(entity, 7, {
      fetchQuery: async () => {
        llamadas++;
        return [tigoCard()];
      },
      ahora: new Date("2026-09-05T12:00:00Z"),
    });
    expect(llamadas).toBe(2);
    expect(texto?.match(/meta-ads/g)?.length).toBe(1);
  });

  it("devuelve null si ningún creativo pasa el allowlist", async () => {
    const texto = await fetchMetaAdsText(ENTITY, 7, { fetchQuery: async () => [tigoCard()] });
    expect(texto).toBeNull();
  });
});
