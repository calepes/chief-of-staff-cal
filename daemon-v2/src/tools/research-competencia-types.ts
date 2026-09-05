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

/** Un punto semanal de la serie histórica de seguidores — ver `EntitySnapshot.seguidoresHistorial`.
 * `null` en una plataforma puntual significa "no se pudo leer esta corrida" (bloqueo, cambio de
 * layout, cuenta sin declarar), no "cero seguidores" — se conserva el punto igual para no perder
 * la cadencia semanal de la serie. */
export interface FollowerPoint {
  fecha: string; // YYYY-MM-DD
  instagram: number | null;
  facebook: number | null;
}

export interface EntitySnapshot {
  entityId: string;
  updatedAt: string;
  ios?: { trackId?: string; version?: string; rating?: number; ratingCount?: number };
  android?: { version?: string; rating?: number; ratingCount?: number };
  siteSnippet?: string;
  notas?: string;
  battlecard?: Battlecard;
  /** Serie semanal de seguidores (Instagram/Facebook, handle PRINCIPAL de cada plataforma —
   * `entity.social.instagram[0]`/`facebook[0]`), un punto por corrida. Campo aditivo: un snapshot
   * guardado antes de esto simplemente no lo trae, y `readEntityState` lo tolera igual (JSON.parse
   * normal, sin schema estricto). Acotado a las últimas 104 corridas (~2 años semanales) como techo
   * defensivo contra crecimiento sin límite del JSON persistido en Notion — no hay pedido de podar
   * más agresivo todavía. */
  seguidoresHistorial?: FollowerPoint[];
}

/**
 * KPIs de actividad publicitaria comparables entre las 6 entidades — PROXIES de volumen/actividad,
 * NUNCA de gasto real ni de impresiones/alcance: ni Google Ads Transparency Center ni Meta Ad
 * Library exponen esos datos gratis para anuncios comerciales (ver research-competencia-ads.ts).
 * `duracionPromedioDias` y `mixFormato` son SOLO de Google (Meta no expone fecha de fin ni formato,
 * ver research-competencia-meta-ads.ts) — `duracionPromedioDias` es `null` si ningún creativo de
 * Google trae ambas fechas.
 */
export interface AdsKpis {
  /** Creativos recuperados en la ventana, Google + Meta combinados. */
  creativosActivos: number;
  /** Cuántos de esos creativos ARRANCARON dentro de la ventana (señal de campaña nueva). */
  campanasNuevas: number;
  duracionPromedioDias: number | null;
  mixFormato: { imagen: number; display: number; desconocido: number };
}

export interface EntityRunResult {
  entityId: string;
  entityNombre: string;
  primeraCorrida: boolean;
  hallazgos: Hallazgo[];
  snapshot: EntitySnapshot;
  /** Ausente si la entidad falló antes de llegar al bloque de ads (ver `r.error`) — presente
   * (incluso con todo en cero) en cualquier otro caso, porque "cero actividad" es un dato válido
   * para la tabla comparativa. */
  adsKpis?: AdsKpis;
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
