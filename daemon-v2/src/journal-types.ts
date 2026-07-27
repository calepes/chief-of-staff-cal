// journal-types.ts — tipos y constantes compartidas del sistema de Journal.

export const ANIMOS = [
  "😔 Bajo",
  "😐 Neutro",
  "🙂 Bien",
  "😤 Tensionado",
  "😰 Ansioso",
] as const;

export type Animo = (typeof ANIMOS)[number];

export type Origen = "Texto" | "Voz" | "Sesión terapia";

export type Estado = "Sin revisar" | "Destilado" | "Descartado";

/** Referencia a una página de Notion (Topic o Big Theme). */
export interface NotionRef {
  id: string;
  name: string;
}

/** Lo que el LLM propone tras leer el texto crudo. */
export interface EnrichResult {
  titulo: string;
  animo: Animo;
  intensidad: number;
  topics: string[];
  bigTheme: string | null;
  /** null si el pensamiento no contiene una reflexión destilable. */
  reflexion: { titulo: string; situacion: string } | null;
}

/** Propuesta de metadata sobre una entrada ya creada. */
export interface MetaProposal {
  kind: "journal-meta";
  entryId: string;
  titulo: string;
  animo: Animo;
  intensidad: number;
  /** Todos los topics candidatos; los excluidos NO se escriben. */
  topics: NotionRef[];
  topicsExcluidos: string[];
  bigTheme: NotionRef | null;
  extracto: string;
  fechaHora: string;
  textoCrudo: string;
  reflexion: { titulo: string; situacion: string } | null;
  messageId: number;
}

/** Propuesta de fila en Resonate Calendar. */
export interface ReflexionProposal {
  kind: "journal-reflexion";
  entryId: string;
  titulo: string;
  situacion: string;
  topics: NotionRef[];
  bigTheme: NotionRef | null;
  fecha: string;
  textoCrudo: string;
  messageId: number;
}

export type JournalProposal = MetaProposal | ReflexionProposal;

/** Snapshot para deshacer la aplicación de metadata (la entrada queda como recién creada). */
export interface MetaUndo {
  kind: "journal-meta";
  entryId: string;
}

/** Snapshot para deshacer la creación en Resonate (se archiva la fila creada). */
export interface ReflexionUndo {
  kind: "journal-reflexion";
  entryId: string;
  resonateId: string;
}

export type JournalUndo = MetaUndo | ReflexionUndo;

/** Estado del modo journal, persistido en KV. */
export interface JournalMode {
  abiertoEn: number;
  anchorMessageId: number;
  origen: Origen;
  guardadas: number;
  pendientes: number;
}

/** Edición de un campo esperando la respuesta de texto de Cal. */
export interface PendingEdit {
  campo: "titulo" | "reflexion";
  shortId: string;
  messageId: number;
}
