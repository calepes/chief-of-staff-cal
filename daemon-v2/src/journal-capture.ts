// journal-capture.ts — orquesta la captura de un pensamiento.
// Paso 1 (mecánico) y paso 2 (LLM) están separados a propósito: el texto se
// persiste ANTES de que el modelo vea nada. Ver el spec, sección 2.

import { editMessage, sendMessage } from "@cos/shared";
import { renderMetaCard } from "./journal-card.js";
import { enrichEntry } from "./journal-enrich.js";
import { buildExtracto } from "./journal-text.js";
import type { JournalStore } from "./journal-store.js";
import type { EnrichResult, MetaProposal, NotionRef, Origen } from "./journal-types.js";
import {
  createRawEntry,
  fetchBigThemesIndex,
  fetchTopicsIndex,
  resolveRefs,
} from "./tools/journal.js";

/** Fecha/hora con el offset fijo de Bolivia (-04:00, sin horario de verano). */
export function nowInLaPaz(now: Date = new Date()): string {
  const laPaz = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return `${laPaz.toISOString().slice(0, 19)}-04:00`;
}

export function buildMetaProposal(input: {
  entryId: string;
  enrich: EnrichResult;
  topicIndex: Map<string, NotionRef>;
  themeIndex: Map<string, NotionRef>;
  fechaHora: string;
  textoCrudo: string;
  messageId: number;
}): MetaProposal {
  const { encontrados: topics } = resolveRefs(input.enrich.topics, input.topicIndex);
  const bigTheme = input.enrich.bigTheme
    ? (resolveRefs([input.enrich.bigTheme], input.themeIndex).encontrados[0] ?? null)
    : null;

  return {
    kind: "journal-meta",
    entryId: input.entryId,
    titulo: input.enrich.titulo,
    animo: input.enrich.animo,
    intensidad: input.enrich.intensidad,
    topics,
    topicsExcluidos: [],
    bigTheme,
    extracto: buildExtracto(input.textoCrudo),
    fechaHora: input.fechaHora,
    textoCrudo: input.textoCrudo,
    reflexion: input.enrich.reflexion,
    messageId: input.messageId,
  };
}

export interface CaptureDeps {
  botToken: string;
  store: JournalStore;
  log: (obj: Record<string, unknown>) => void;
}

/**
 * Guarda un pensamiento y manda la tarjeta.
 * PASO 1 es sincrónico y bloqueante: si falla, Cal se entera al toque.
 * PASO 2 corre después; si falla, la entrada ya está a salvo.
 */
export async function captureThought(
  deps: CaptureDeps,
  chatId: number,
  texto: string,
  origen: Origen,
): Promise<{ guardada: boolean; conReflexion: boolean }> {
  const fechaHora = nowInLaPaz();

  // ---- PASO 1: escritura mecánica, sin LLM ----
  const creada = createRawEntry({ texto, origen, fechaHora });
  if (!creada.ok) {
    deps.log({ msg: "journal_create_failed", err: creada.error });
    await sendMessage(deps.botToken, {
      chatId,
      text: "⚠️ <b>No pude guardar el pensamiento en Notion</b>\nRevisá el log del daemon. Tu texto no se perdió: volvé a mandarlo cuando esté resuelto.",
      parseMode: "HTML",
    }).catch(() => {});
    return { guardada: false, conReflexion: false };
  }

  const ack = await sendMessage(deps.botToken, {
    chatId,
    text: "📓 <b>Guardado</b>\n<i>Buscando de qué se trata...</i>",
    parseMode: "HTML",
  });
  deps.log({ msg: "journal_saved", entryId: creada.entryId, origen, chars: texto.length });

  // ---- PASO 2: enriquecimiento con LLM ----
  let enrich: EnrichResult | null = null;
  let topicIndex = new Map<string, NotionRef>();
  let themeIndex = new Map<string, NotionRef>();
  try {
    topicIndex = fetchTopicsIndex();
    themeIndex = fetchBigThemesIndex();
    enrich = await enrichEntry(
      texto,
      [...topicIndex.values()].map((t) => t.name),
      [...themeIndex.values()].map((t) => t.name),
    );
  } catch (err) {
    deps.log({ msg: "journal_enrich_error", entryId: creada.entryId, err: String(err) });
  }

  if (!enrich) {
    await editMessage(
      deps.botToken,
      chatId,
      ack.message_id,
      "📓 <b>Guardado</b>\nNo pude proponerte metadata esta vez — la entrada quedó sin revisar y te la muestro en el barrido del domingo.",
      "HTML",
      { inline_keyboard: [] },
    ).catch(() => {});
    return { guardada: true, conReflexion: false };
  }

  const proposal = buildMetaProposal({
    entryId: creada.entryId,
    enrich,
    topicIndex,
    themeIndex,
    fechaHora,
    textoCrudo: texto,
    messageId: ack.message_id,
  });
  const shortId = await deps.store.createProposal(chatId, proposal);
  const card = renderMetaCard(proposal, shortId);
  await editMessage(deps.botToken, chatId, ack.message_id, card.text, "HTML", card.keyboard).catch(
    (err) => deps.log({ msg: "journal_card_edit_error", err: String(err) }),
  );

  return { guardada: true, conReflexion: proposal.reflexion != null };
}
