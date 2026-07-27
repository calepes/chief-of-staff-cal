// journal-payloads.ts — builders puros del JSON que consume la API de Notion.
// Separados de tools/journal.ts para poder testearlos sin red.

import { buildExtracto, chunkParagraphs } from "./journal-text.js";
import type { Animo, NotionRef, Origen } from "./journal-types.js";

export type NotionProps = Record<string, unknown>;

export interface NotionBlock {
  object: "block";
  type: string;
  [key: string]: unknown;
}

export function buildEntryProperties(input: {
  texto: string;
  origen: Origen;
  fechaHora: string;
}): NotionProps {
  const extracto = buildExtracto(input.texto);
  return {
    // Título provisional: el enriquecimiento lo reemplaza, pero si ese paso falla
    // la fila igual es identificable en la vista de tabla.
    Pensamiento: { title: [{ text: { content: extracto } }] },
    "Fecha y hora": { date: { start: input.fechaHora } },
    Extracto: { rich_text: [{ text: { content: extracto } }] },
    Origen: { select: { name: input.origen } },
    Estado: { select: { name: "Sin revisar" } },
  };
}

export function buildBodyBlocks(texto: string): NotionBlock[] {
  return chunkParagraphs(texto).map((chunk) => ({
    object: "block" as const,
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
  }));
}

export function buildMetadataProperties(input: {
  titulo: string;
  animo: Animo;
  intensidad: number;
  topics: NotionRef[];
  bigTheme: NotionRef | null;
}): NotionProps {
  return {
    Pensamiento: { title: [{ text: { content: input.titulo } }] },
    "Ánimo": { select: { name: input.animo } },
    Intensidad: { number: input.intensidad },
    Topics: { relation: input.topics.map((t) => ({ id: t.id })) },
    "Big Themes": { relation: input.bigTheme ? [{ id: input.bigTheme.id }] : [] },
  };
}

export function buildResonateProperties(input: {
  titulo: string;
  situacion: string;
  fecha: string;
  topics: NotionRef[];
  bigTheme: NotionRef | null;
  entryId: string;
}): NotionProps {
  const props: NotionProps = {
    Name: { title: [{ text: { content: input.titulo } }] },
    Fecha: { date: { start: input.fecha } },
    Type: { select: { name: "Reflexion" } },
    Tags: { multi_select: [{ name: "Terapia" }] },
    Topics: { relation: input.topics.map((t) => ({ id: t.id })) },
    "Big Themes": { relation: input.bigTheme ? [{ id: input.bigTheme.id }] : [] },
    Journal: { relation: [{ id: input.entryId }] },
  };
  if (input.situacion.trim().length > 0) {
    props["Situacion"] = { rich_text: [{ text: { content: input.situacion } }] };
  }
  return props;
}

export function buildQuoteBlocks(texto: string): NotionBlock[] {
  return chunkParagraphs(texto).map((chunk) => ({
    object: "block" as const,
    type: "quote",
    quote: { rich_text: [{ type: "text", text: { content: chunk } }] },
  }));
}
