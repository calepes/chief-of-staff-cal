// journal-callbacks.ts — handlers de los callbacks jnl:*. Todos son HEAVY
// (escriben en Notion) y corren en el daemon, nunca en el worker.

import { answerCallbackQuery, editMessage, sendMessage } from "@cos/shared";
import {
  renderAnimoPicker,
  renderApplied,
  renderBigThemePicker,
  renderMetaCard,
  renderReflexionCard,
  renderTopicsPicker,
} from "./journal-card.js";
import { buildMetaProposal } from "./journal-capture.js";
import { enrichEntry } from "./journal-enrich.js";
import { sevenDaysAgo as sevenDaysAgoIso } from "./proactive/journal-sweep.js";
import type { JournalStore } from "./journal-store.js";
import { ANIMOS, type MetaProposal, type ReflexionProposal } from "./journal-types.js";
import {
  applyMetadata,
  archiveResonateEntry,
  clearMetadata,
  createResonateEntry,
  fetchBigThemesIndex,
  fetchTopicsIndex,
  getEntry,
  queryUnreviewed,
  setEstado,
} from "./tools/journal.js";

export interface ParsedCallback {
  accion: string;
  shortId: string;
  arg: string | undefined;
}

export function isJournalCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith("jnl:");
}

export function parseJournalCallback(data: string): ParsedCallback | null {
  const parts = data.split(":");
  if (parts[0] !== "jnl" || !parts[1] || !parts[2]) return null;
  return { accion: parts[1], shortId: parts[2], arg: parts[3] };
}

export function applyToggleTopic(p: MetaProposal, topicId: string): MetaProposal {
  if (!p.topics.some((t) => t.id === topicId)) return p;
  const fuera = new Set(p.topicsExcluidos);
  if (fuera.has(topicId)) fuera.delete(topicId);
  else fuera.add(topicId);
  return { ...p, topicsExcluidos: [...fuera] };
}

export function applyAnimoPick(p: MetaProposal, idxRaw: string): MetaProposal {
  const idx = Number(idxRaw);
  if (!Number.isInteger(idx) || idx < 0 || idx >= ANIMOS.length) return p;
  return { ...p, animo: ANIMOS[idx]! };
}

export interface JournalCallbackDeps {
  botToken: string;
  store: JournalStore;
  log: (obj: Record<string, unknown>) => void;
}

function topicsIncluidos(p: MetaProposal) {
  const fuera = new Set(p.topicsExcluidos);
  return p.topics.filter((t) => !fuera.has(t.id));
}

/**
 * Procesa un callback jnl:*. Devuelve true si lo manejó.
 * El caller ya hizo answerCallbackQuery y tomó el lock anti-doble-tap.
 */
export async function handleJournalCallback(
  deps: JournalCallbackDeps,
  chatId: number,
  messageId: number,
  data: string,
): Promise<boolean> {
  const parsed = parseJournalCallback(data);
  if (!parsed) return false;
  const { accion, shortId, arg } = parsed;

  // ↩️ Deshacer usa el entryId, no un shortId de propuesta.
  if (accion === "undo") {
    const snapshot = await deps.store.getUndo(chatId, shortId);
    if (!snapshot) {
      await editMessage(deps.botToken, chatId, messageId, "⌛ La ventana para deshacer ya pasó.", "HTML", { inline_keyboard: [] }).catch(() => {});
      return true;
    }
    if (snapshot.kind === "journal-meta") {
      clearMetadata(snapshot.entryId);
    } else {
      archiveResonateEntry(snapshot.resonateId);
      setEstado(snapshot.entryId, "Sin revisar");
    }
    await deps.store.clearUndo(chatId, shortId);
    await editMessage(deps.botToken, chatId, messageId, "↩️ <b>Deshecho</b>\nLa entrada volvió a como estaba.", "HTML", { inline_keyboard: [] }).catch(() => {});
    return true;
  }

  // Selector del barrido dominical: jnl:sweep:{entryId|all|none}
  if (accion === "sweep") {
    if (shortId === "none") {
      await editMessage(deps.botToken, chatId, messageId, "👍 Los dejo para la próxima.", "HTML", { inline_keyboard: [] }).catch(() => {});
      return true;
    }
    const ids = shortId === "all" ? queryUnreviewed(sevenDaysAgoIso()).map((e) => e.id) : [shortId];
    if (ids.length === 0) {
      await editMessage(deps.botToken, chatId, messageId, "✅ No quedó nada sin destilar.", "HTML", { inline_keyboard: [] }).catch(() => {});
      return true;
    }
    await editMessage(
      deps.botToken,
      chatId,
      messageId,
      `📓 Reviso ${ids.length === 1 ? "el pensamiento" : `los ${ids.length} pensamientos`}...`,
      "HTML",
      { inline_keyboard: [] },
    ).catch(() => {});
    for (const id of ids) {
      const entry = getEntry(id);
      if (!entry) continue;
      await reopenCheckpoint(deps, chatId, id, entry);
    }
    return true;
  }

  const proposal = await deps.store.getProposal(chatId, shortId);
  if (!proposal) {
    await editMessage(deps.botToken, chatId, messageId, "⌛ Esta propuesta expiró. La entrada quedó guardada sin revisar — te la muestro en el barrido del domingo.", "HTML", { inline_keyboard: [] }).catch(() => {});
    return true;
  }

  // --- Propuesta de metadata ---
  if (proposal.kind === "journal-meta") {
    const p = proposal;

    const repaint = async (next: MetaProposal) => {
      await deps.store.updateProposal(chatId, shortId, next);
      const card = renderMetaCard(next, shortId);
      await editMessage(deps.botToken, chatId, messageId, card.text, "HTML", card.keyboard).catch(() => {});
    };

    switch (accion) {
      case "pick-animo": {
        const card = renderAnimoPicker(p, shortId);
        await editMessage(deps.botToken, chatId, messageId, card.text, "HTML", card.keyboard).catch(() => {});
        return true;
      }
      case "pick-topics": {
        const card = renderTopicsPicker(p, shortId);
        await editMessage(deps.botToken, chatId, messageId, card.text, "HTML", card.keyboard).catch(() => {});
        return true;
      }
      case "pick-theme": {
        const themes = [...fetchBigThemesIndex().values()];
        const card = renderBigThemePicker(p, shortId, themes);
        await editMessage(deps.botToken, chatId, messageId, card.text, "HTML", card.keyboard).catch(() => {});
        return true;
      }
      case "animo":
        await repaint(applyAnimoPick(p, arg ?? ""));
        return true;
      case "inten": {
        const n = Number(arg);
        if (Number.isInteger(n) && n >= 1 && n <= 5) await repaint({ ...p, intensidad: n });
        return true;
      }
      case "togtopic":
        await repaint(applyToggleTopic(p, arg ?? ""));
        return true;
      case "theme": {
        if (arg === "none") await repaint({ ...p, bigTheme: null });
        else {
          const ref = [...fetchBigThemesIndex().values()].find((t) => t.id === arg) ?? null;
          await repaint({ ...p, bigTheme: ref });
        }
        return true;
      }
      case "back":
        await repaint(p);
        return true;
      case "edit-title": {
        await deps.store.setPendingEdit(chatId, { campo: "titulo", shortId, messageId });
        await editMessage(deps.botToken, chatId, messageId, "✏️ <b>Mandame el título que querés</b>\nRespondé con el texto y lo aplico a la propuesta.", "HTML", { inline_keyboard: [] }).catch(() => {});
        return true;
      }
      case "nometa": {
        await deps.store.clearProposal(chatId, shortId);
        await editMessage(deps.botToken, chatId, messageId, "📓 <b>Guardado sin metadata</b>\nQueda sin revisar para el barrido del domingo.", "HTML", { inline_keyboard: [] }).catch(() => {});
        return true;
      }
      case "apply": {
        const incluidos = topicsIncluidos(p);
        const res = applyMetadata(p.entryId, {
          titulo: p.titulo,
          animo: p.animo,
          intensidad: p.intensidad,
          topics: incluidos,
          bigTheme: p.bigTheme,
        });
        if (!res.ok) {
          deps.log({ msg: "journal_apply_failed", entryId: p.entryId, err: res.error });
          await editMessage(deps.botToken, chatId, messageId, "⚠️ No pude escribir la metadata en Notion. La entrada sigue guardada con su texto.", "HTML", { inline_keyboard: [] }).catch(() => {});
          return true;
        }
        await deps.store.setUndo(chatId, p.entryId, { kind: "journal-meta", entryId: p.entryId });
        await deps.store.clearProposal(chatId, shortId);

        // Si había reflexión, la MISMA tarjeta se transforma en el checkpoint de Resonate.
        if (p.reflexion) {
          const refl: ReflexionProposal = {
            kind: "journal-reflexion",
            entryId: p.entryId,
            titulo: p.reflexion.titulo,
            situacion: p.reflexion.situacion,
            topics: incluidos,
            bigTheme: p.bigTheme,
            fecha: p.fechaHora.slice(0, 10),
            textoCrudo: p.textoCrudo,
            messageId,
          };
          const reflShortId = await deps.store.createProposal(chatId, refl);
          const card = renderReflexionCard(refl, reflShortId);
          await editMessage(deps.botToken, chatId, messageId, card.text, "HTML", card.keyboard).catch(() => {});
          return true;
        }

        const done = renderApplied(p, p.entryId);
        await editMessage(deps.botToken, chatId, messageId, done.text, "HTML", done.keyboard).catch(() => {});
        return true;
      }
      default:
        return false;
    }
  }

  // --- Propuesta de reflexión ---
  const r = proposal;
  switch (accion) {
    case "later": {
      await deps.store.clearProposal(chatId, shortId);
      await editMessage(deps.botToken, chatId, messageId, "⏭️ <b>Queda sin destilar</b>\nTe la vuelvo a mostrar en el barrido del domingo.", "HTML", { inline_keyboard: [] }).catch(() => {});
      return true;
    }
    case "edit-refl": {
      await deps.store.setPendingEdit(chatId, { campo: "reflexion", shortId, messageId });
      await editMessage(deps.botToken, chatId, messageId, "✏️ <b>Mandame el título de la reflexión</b>\nRespondé con el texto y lo aplico antes de guardar.", "HTML", { inline_keyboard: [] }).catch(() => {});
      return true;
    }
    case "resonate": {
      const res = createResonateEntry({
        titulo: r.titulo,
        situacion: r.situacion,
        fecha: r.fecha,
        topics: r.topics,
        bigTheme: r.bigTheme,
        entryId: r.entryId,
        textoCrudo: r.textoCrudo,
      });
      if (!res.ok) {
        deps.log({ msg: "journal_resonate_failed", entryId: r.entryId, err: res.error });
        await editMessage(deps.botToken, chatId, messageId, "⚠️ No pude crear la reflexión en Resonate. La entrada quedó sin revisar.", "HTML", { inline_keyboard: [] }).catch(() => {});
        return true;
      }
      setEstado(r.entryId, "Destilado");
      await deps.store.setUndo(chatId, r.entryId, {
        kind: "journal-reflexion",
        entryId: r.entryId,
        resonateId: res.resonateId,
      });
      await deps.store.clearProposal(chatId, shortId);
      await editMessage(
        deps.botToken,
        chatId,
        messageId,
        `🌟 <b>${r.titulo}</b>\nGuardada en Resonate Calendar.`,
        "HTML",
        { inline_keyboard: [[{ text: "↩️ Deshacer", callback_data: `jnl:undo:${r.entryId}` }]] },
      ).catch(() => {});
      return true;
    }
    default:
      return false;
  }
}

/** Re-corre el enriquecimiento sobre una entrada vieja y manda su tarjeta. */
async function reopenCheckpoint(
  deps: JournalCallbackDeps,
  chatId: number,
  entryId: string,
  entry: { titulo: string; fecha: string; texto: string },
): Promise<void> {
  const topicIndex = fetchTopicsIndex();
  const themeIndex = fetchBigThemesIndex();
  const enrich = await enrichEntry(
    entry.texto,
    [...topicIndex.values()].map((t) => t.name),
    [...themeIndex.values()].map((t) => t.name),
  ).catch(() => null);
  if (!enrich) {
    deps.log({ msg: "journal_sweep_enrich_failed", entryId });
    return;
  }
  const anchor = await sendMessage(deps.botToken, {
    chatId,
    text: "📓 <i>Revisando...</i>",
    parseMode: "HTML",
  });
  const proposal = buildMetaProposal({
    entryId,
    enrich,
    topicIndex,
    themeIndex,
    fechaHora: entry.fecha,
    textoCrudo: entry.texto,
    messageId: anchor.message_id,
  });
  const shortId = await deps.store.createProposal(chatId, proposal);
  const card = renderMetaCard(proposal, shortId);
  await editMessage(deps.botToken, chatId, anchor.message_id, card.text, "HTML", card.keyboard).catch(() => {});
}

/**
 * Consume un mensaje de texto de Cal como la edición pendiente de un botón ✏️.
 * Devuelve true si lo consumió (el caller NO debe seguir procesando el mensaje).
 */
export async function applyPendingEdit(
  deps: JournalCallbackDeps,
  chatId: number,
  texto: string,
): Promise<boolean> {
  const pending = await deps.store.getPendingEdit(chatId);
  if (!pending) return false;
  await deps.store.clearPendingEdit(chatId);

  const proposal = await deps.store.getProposal(chatId, pending.shortId);
  if (!proposal) {
    await editMessage(deps.botToken, chatId, pending.messageId, "⌛ Esa propuesta expiró; no pude aplicar el cambio.", "HTML", { inline_keyboard: [] }).catch(() => {});
    return true;
  }

  const nuevo = texto.trim().slice(0, 200);
  if (pending.campo === "titulo" && proposal.kind === "journal-meta") {
    const next = { ...proposal, titulo: nuevo };
    await deps.store.updateProposal(chatId, pending.shortId, next);
    const card = renderMetaCard(next, pending.shortId);
    await editMessage(deps.botToken, chatId, pending.messageId, card.text, "HTML", card.keyboard).catch(() => {});
    return true;
  }
  if (pending.campo === "reflexion" && proposal.kind === "journal-reflexion") {
    const next = { ...proposal, titulo: nuevo };
    await deps.store.updateProposal(chatId, pending.shortId, next);
    const card = renderReflexionCard(next, pending.shortId);
    await editMessage(deps.botToken, chatId, pending.messageId, card.text, "HTML", card.keyboard).catch(() => {});
    return true;
  }

  // El tipo de propuesta cambió bajo los pies (ej. la metadata ya se aplicó y
  // pasó a ser una propuesta de reflexión) — no aplicamos nada y lo decimos.
  await editMessage(deps.botToken, chatId, pending.messageId, "⚠️ Esa edición ya no aplica a la tarjeta actual.", "HTML", { inline_keyboard: [] }).catch(() => {});
  return true;
}

/** Ack corto para los callbacks que Telegram espera responder rápido. */
export async function ackJournal(botToken: string, callbackId: string, texto?: string): Promise<void> {
  await answerCallbackQuery(botToken, callbackId, texto).catch(() => {});
}
