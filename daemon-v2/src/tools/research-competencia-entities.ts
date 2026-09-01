export interface EntityConfig {
  id: string;
  nombre: string;
  ios?: { trackId?: string; searchTerm?: string };
  android?: { packageName: string };
  siteUrl?: string;
  linkedinQuery: string;
}

export const ENTITIES: EntityConfig[] = [
  {
    id: "bancosol-altoke",
    nombre: "Banco Sol / Altoke",
    ios: { trackId: "6479173387" },
    android: { packageName: "com.bancosol.altoke" },
    siteUrl: "https://www.altoke.com.bo",
    linkedinQuery: "BancoSol Altoke Bolivia",
  },
  {
    id: "ganadero-yolopago",
    nombre: "Banco Ganadero / Yolo Pago",
    ios: { trackId: "1582673945" },
    android: { packageName: "bo.com.yolopago" },
    siteUrl: "https://www.bg.com.bo/canales-digitales/yolo-pago/",
    linkedinQuery: "Banco Ganadero Yolo Pago Bolivia",
  },
  {
    // Nombre real del producto: "ZAS" (no "Zaz" — corregido tras verificar con búsqueda web).
    id: "economico-zas",
    nombre: "Banco Económico / ZAS",
    ios: { searchTerm: "ZAS Banco Economico" }, // sin trackId confirmado — resuelve por búsqueda
    android: { packageName: "bec.vdb.direct" },
    siteUrl: "https://www.baneco.com.bo/zas",
    linkedinQuery: "Banco Economico ZAS Bolivia",
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
  },
  {
    id: "meru",
    nombre: "Meru",
    ios: { trackId: "1636697895" },
    android: { packageName: "com.getmeru.app" },
    siteUrl: "https://getmeru.com",
    linkedinQuery: "Meru getmeru fintech Bolivia",
  },
  {
    id: "peso-app",
    nombre: "Peso App",
    ios: { trackId: "6740822281" },
    android: { packageName: "com.latam.peso" },
    siteUrl: "https://www.peso-latam.com",
    linkedinQuery: "Peso Latam app Bolivia",
  },
];

export function getEntity(id: string): EntityConfig {
  const found = ENTITIES.find((e) => e.id === id);
  if (!found) throw new Error(`Entidad desconocida: ${id}`);
  return found;
}
