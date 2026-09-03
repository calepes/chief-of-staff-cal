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
   * Cuántas veces se pidieron cookies de redes sociales durante la corrida (una vez por
   * plataforma con handles configurados, por entidad) y en cuántas de esas se obtuvo al menos
   * una cookie. Señal para `formatSummaryHtml`: si `socialCookiesIntentos > 0` y
   * `socialCookiesEncontradas === 0`, TODAS las plataformas corrieron sin sesión — lectura de
   * cookies rota (falta FDA, sesión de Safari vencida), no "semana tranquila". Ver el comentario
   * en runResearchCompetencia (research-competencia.ts) para por qué se mide acá y no en
   * research-competencia-social.ts.
   */
  socialCookiesIntentos: number;
  socialCookiesEncontradas: number;
}
