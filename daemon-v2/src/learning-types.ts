// learning-types.ts — tipos compartidos del self-learning.

/** Las cuatro categorías que Cal pidió que Jano aprenda. */
export const LEARNING_TAGS = ["pref", "hecho", "err", "flujo"] as const;
export type LearningTag = (typeof LEARNING_TAGS)[number];

/** Una línea de ~/.cos-agent/learnings.md ya parseada. */
export interface Learning {
  date: string;
  tag: LearningTag;
  text: string;
}

/** Un candidato propuesto por el pase nocturno, todavía sin aprobar. */
export interface LearningCandidate {
  tag: LearningTag;
  text: string;
  /** Cita corta de la conversación que lo justifica. Se muestra, no se guarda. */
  evidencia: string;
}

/** Lo que el cron deja en KV esperando los botones de Cal. */
export interface LearningBatch {
  fecha: string;
  candidates: LearningCandidate[];
  /** Índice del candidato que se está revisando en modo uno-a-uno. */
  cursor: number;
  /** Tokens estimados de los learnings activos al momento de armar el batch. */
  tokensActuales: number;
  /** Cuántos aprobó Cal hasta ahora en el modo uno-a-uno. */
  guardados: number;
  /** Cuántos descartó hasta ahora en el modo uno-a-uno. */
  descartados: number;
}
