export interface SocialHandles {
  instagram: string[];
  tiktok: string[];
  facebook: string[];
  x: string[];
}

export interface AdsSources {
  /**
   * IDs de anunciante (`AR...`) en Google Ads Transparency Center, región Bolivia — descubiertos
   * a mano el 2026-09-03 (ver research-competencia-ads.ts) buscando por dominio/nombre y quedándose
   * con el anunciante real que reconcilia (no el primer resultado). Más de un ID cuando Google
   * separa la cuenta corporativa de la del producto (ver ganadero-yolopago) — el consumidor los
   * consulta a todos y junta los creativos. Array vacío = se buscó y no se encontró un anunciante
   * confiable en Bolivia (ver peso-app), no un olvido.
   */
  google: string[];
}

export interface EntityConfig {
  id: string;
  nombre: string;
  ios?: { trackId?: string; searchTerm?: string };
  android?: { packageName: string };
  siteUrl?: string;
  linkedinQuery: string;
  // Handles verificados por búsqueda web el 2026-09-02 (ver spec de Fase 2). Los 4 campos son
  // requeridos: una plataforma sin cuenta oficial confirmada se declara con array vacío en vez
  // de omitirse, para que el consumidor (dispatcher, tarea 9) acceda directo sin encadenar
  // `?? []` en cada punto de uso. Un array vacío es una afirmación explícita ("buscamos y no
  // hay"), distinta de un olvido — nunca se inventa un handle para completar.
  social?: SocialHandles;
  /** Ver AdsSources. Opcional: entidades sin fuente de ads confirmada no lo declaran. */
  ads?: AdsSources;
}

export const ENTITIES: EntityConfig[] = [
  {
    id: "bancosol-altoke",
    nombre: "Banco Sol / Altoke",
    ios: { trackId: "6479173387" },
    android: { packageName: "com.bancosol.altoke" },
    siteUrl: "https://www.altoke.com.bo",
    linkedinQuery: "BancoSol Altoke Bolivia",
    social: {
      instagram: ["altoke.bo", "bancosol_bolivia"],
      tiktok: ["altoke.bo"],
      facebook: ["altoke.bo", "BancoSolidarioBolivia"],
      x: ["bancosol"],
    },
    ads: { google: ["AR02176363334515818497"] }, // Banco Solidario S.A.
  },
  {
    id: "ganadero-yolopago",
    nombre: "Banco Ganadero / Yolo Pago",
    ios: { trackId: "1582673945" },
    android: { packageName: "bo.com.yolopago" },
    siteUrl: "https://www.bg.com.bo/canales-digitales/yolo-pago/",
    linkedinQuery: "Banco Ganadero Yolo Pago Bolivia",
    social: {
      instagram: ["yolopagoapp", "bancoganadero"],
      tiktok: ["yolopagoapp"],
      facebook: ["YoloPagoApp", "bg.com.bo"],
      x: ["yolo_pago"],
    },
    // Dos IDs: Google separa la cuenta corporativa (bg.com.bo) de la del producto (yolopago.app),
    // ambas "Banco Ganadero S.A.".
    ads: { google: ["AR04961682164644052993", "AR14366527289993199617"] },
  },
  {
    // Nombre real del producto: "ZAS" (no "Zaz" — corregido tras verificar con búsqueda web).
    id: "economico-zas",
    nombre: "Banco Económico / ZAS",
    ios: { searchTerm: "ZAS Banco Economico" }, // sin trackId confirmado — resuelve por búsqueda
    android: { packageName: "bec.vdb.direct" },
    siteUrl: "https://www.baneco.com.bo/zas",
    linkedinQuery: "Banco Economico ZAS Bolivia",
    social: {
      instagram: ["banco.economico"],
      tiktok: [],
      facebook: ["banco.economico"],
      x: [],
    },
    ads: { google: ["AR09289408292902141953"] }, // Banco Economico
  },
  {
    id: "takenos",
    nombre: "Takenos",
    ios: { trackId: "6499217598" },
    // Nota: una fuente vio "removida de Google Play en 2026-03" — sin confirmar. Si
    // fetchAndroidAppInfo devuelve null de forma consistente, no es un bug del fetcher.
    android: { packageName: "com.takenos" },
    siteUrl: "https://takenos.com/bolivia",
    linkedinQuery: "Takenos Bolivia",
    social: {
      instagram: ["takenosapp.bo"],
      tiktok: ["takenos_app_bo"],
      facebook: [],
      x: ["takenosapp"],
    },
    // Anunciante real es "GLOBAL FLOW S.A." (razón social detrás de Takenos), no "Takenos" —
    // confirmado buscando por dominio takenos.com y verificando que reconcilia.
    ads: { google: ["AR04876554873455247361"] },
  },
  {
    id: "meru",
    nombre: "Meru",
    ios: { trackId: "1636697895" },
    android: { packageName: "com.getmeru.app" },
    siteUrl: "https://getmeru.com",
    linkedinQuery: "Meru getmeru fintech Bolivia",
    social: {
      instagram: ["meru.app"],
      tiktok: [],
      facebook: ["getmeruapp"],
      x: ["getmeru"],
    },
    // Anunciante real es "R3mit Solutions Inc." (razón social detrás de Meru), no "Meru" —
    // confirmado buscando por dominio getmeru.com.
    ads: { google: ["AR09222401735023132673"] },
  },
  {
    id: "peso-app",
    nombre: "Peso App",
    ios: { trackId: "6740822281" },
    android: { packageName: "com.latam.peso" },
    siteUrl: "https://www.peso-latam.com",
    linkedinQuery: "Peso Latam app Bolivia",
    social: {
      instagram: ["peso.latam"],
      tiktok: ["peso.latam"],
      facebook: [],
      x: [],
    },
    // Sin `ads`: se buscó por "Peso App", "pesoapp.com", "peso.com.bo" y variantes en el
    // Transparency Center (2026-09-03) sin encontrar un anunciante boliviano confiable — no es un
    // olvido, es que no se identificó. Revisar si aparece en una búsqueda futura.
  },
];

export function getEntity(id: string): EntityConfig {
  const found = ENTITIES.find((e) => e.id === id);
  if (!found) throw new Error(`Entidad desconocida: ${id}`);
  return found;
}
