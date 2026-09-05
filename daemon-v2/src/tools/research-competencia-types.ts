export type Dimension = "Producto" | "Estrategia" | "GTM" | "Hiring";

export interface Hallazgo {
  dimension: Dimension;
  descripcion: string;
  fuente: string;
}

export type Amenaza = "baja" | "media" | "alta";

export interface BattlecardPunto {
  texto: string;
  // Vacío solo para caracterizaciones generales de posicionamiento (no un hecho puntual). Un hecho
  // específico (fecha, cifra, cambio de política) SIEMPRE debe traer fuente — ver prompt en
  // research-competencia-agent.ts. Encontrado 2026-09-01: sin este campo, el modelo rellenaba
  // fortalezas/debilidades con "lo que sabía" sin citar, indistinguible de un hallazgo investigado.
  fuente: string;
}

export interface Battlecard {
  resumen: string;
  fortalezas: BattlecardPunto[];
  debilidades: BattlecardPunto[];
  amenaza: Amenaza;
}

export interface EntitySnapshot {
  entityId: string;
  updatedAt: string;
  ios?: { trackId?: string; version?: string; rating?: number; ratingCount?: number };
  android?: { version?: string; rating?: number; ratingCount?: number };
  siteSnippet?: string;
  notas?: string;
  battlecard?: Battlecard;
}

export interface EntityRunResult {
  entityId: string;
  entityNombre: string;
  primeraCorrida: boolean;
  hallazgos: Hallazgo[];
  snapshot: EntitySnapshot;
  error?: string;
}

export interface RunResult {
  fecha: string;
  timeframeDias: number;
  entidades: EntityRunResult[];
  totalHallazgos: number;
  informeUrl?: string;
  /**
   * `false` si `openResearchBrowserSession` (research-competencia-browser.ts) falló esta corrida
   * (Chrome no instalado, puerto CDP que nunca respondió, etc.) — en ese caso NINGUNA entidad tuvo
   * scraping social, y `formatSummaryHtml` lo advierte explícito: bajo un cron desatendido, el
   * resumen de Telegram es el único canal que Cal realmente ve (los logs a stdout no los mira
   * nadie bajo launchd). Reemplaza a los contadores `socialCookiesIntentos`/`socialCookiesEncontradas`
   * del diseño anterior (lectura de cookies de Safari) — con Chrome real + perfil dedicado ya no
   * hay cookies que contar, solo "¿pudo abrir el browser o no?". No cubre el caso más sutil de
   * "el browser abrió bien pero cada plataforma devolvió 0 posts por detección de bot" — ese sigue
   * visible solo en el log (`research_competencia_scrape_empty`), a propósito: es indistinguible en
   * agregado de "semana tranquila real" sin una heurística mucho más elaborada.
   */
  socialBrowserAvailable: boolean;
}
