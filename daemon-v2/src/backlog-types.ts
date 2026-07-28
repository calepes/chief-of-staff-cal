// backlog-types.ts — tipos compartidos de las tools de backlog.
// Sin lógica: lo importan discovery, read, write, card, store y callbacks.

/** Un backlog descubierto en el árbol de Cal. */
export interface BacklogEntry {
  /** Clave estable que usa el modelo, ej. "jano", "aeropuertos-bolivia". */
  key: string;
  /** Path absoluto REAL tal como lo devolvió el find (respeta mayúsculas del disco). */
  path: string;
  /** Nombre legible para Telegram, ej. "Aeropuertos Bolivia". */
  label: string;
  /** Agrupador para el mapa: "Raíz" | "Agentes" | "Apps" | "Otros". */
  group: string;
}

/** Una fila del mapa: un backlog con su conteo de pendientes. */
export interface BacklogMapRow extends BacklogEntry {
  pending: number;
}

/** Un ítem pendiente dentro de un backlog. */
export interface BacklogItem {
  /** Sección `###` que lo contiene, o "" si está suelto. */
  section: string;
  /** Texto del ítem, ya truncado para el contexto. */
  text: string;
}

/** Vista compacta de un backlog — lo que ve el modelo, nunca el archivo crudo. */
export interface CompactBacklog {
  key: string;
  label: string;
  total: number;
  items: BacklogItem[];
}

/** Resultado de intentar tildar un ítem. */
export type MarkResult =
  | { ok: true; line: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; candidates: string[] };

/** Propuesta pendiente de confirmación, guardada en CF KV. */
export interface BacklogProposal {
  kind: "add" | "done";
  /** Clave del backlog destino. */
  key: string;
  /** Texto del ítem a agregar, o texto que localiza el ítem a tildar. */
  text: string;
}
