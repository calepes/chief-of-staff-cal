// learning-callbacks.ts — handlers de los callbacks lrn:* del pase nocturno de self-learning.
// Persisten en ~/.cos-agent/learnings.md, nunca en Notion — sin escritura remota, no son HEAVY
// en el sentido de journal-callbacks.ts, pero sí mutan estado (archivo + batch en KV).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { formatLearning } from "./learning-file.js";
import { renderDone, renderNothing, renderOneByOne, type Card } from "./learning-card.js";
import type { LearningStore } from "./learning-store.js";
import type { LearningCandidate } from "./learning-types.js";

export interface ParsedLearningCallback {
  action: string;
  batchId: string;
}

export function isLearningCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith("lrn:");
}

export function parseLearningCallback(data: string): ParsedLearningCallback | null {
  const parts = data.split(":");
  if (parts[0] !== "lrn" || !parts[1] || !parts[2]) return null;
  return { action: parts[1], batchId: parts[2] };
}

export interface LearningCallbackDeps {
  store: LearningStore;
  /** Path a ~/.cos-agent/learnings.md (o un tmpdir en tests — NUNCA el real en tests). */
  learningsPath: string;
  /** Fecha de hoy en formato YYYY-MM-DD, inyectada para que los tests no dependan del reloj. */
  today: () => string;
  log: (obj: Record<string, unknown>) => void;
  /** Edita la tarjeta ancla. Manda SIEMPRE el keyboard completo (nunca lo omite). */
  editCard: (messageId: number, card: Card) => Promise<void>;
}

/** Apenda los candidatos aprobados al archivo de learnings, con la fecha de hoy. */
function persist(path: string, cands: LearningCandidate[], today: string): void {
  if (cands.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  const lines = cands.map((c) => formatLearning({ date: today, tag: c.tag, text: c.text }));
  appendFileSync(path, `${lines.join("\n")}\n`);
}

/**
 * Procesa un callback lrn:*. El caller ya hizo answerCallbackQuery y tomó el lock
 * anti-doble-tap (mismo patrón que journal-callbacks.ts).
 */
export async function handleLearningCallback(
  deps: LearningCallbackDeps,
  chatId: number,
  messageId: number,
  data: string,
): Promise<void> {
  const parsed = parseLearningCallback(data);
  if (!parsed) return;
  const { action, batchId } = parsed;

  const batch = await deps.store.getBatch(chatId, batchId);
  if (!batch) {
    await deps.editCard(messageId, {
      text: "⌛ <b>Esa tanda expiró.</b> La reflexión de esta noche te va a proponer de nuevo lo que siga valiendo.",
      keyboard: { inline_keyboard: [] },
    });
    return;
  }

  switch (action) {
    case "all": {
      persist(deps.learningsPath, batch.candidates, deps.today());
      await deps.store.clearBatch(chatId, batchId);
      deps.log({ msg: "learning_batch_all", batchId, count: batch.candidates.length });
      await deps.editCard(messageId, renderDone(batch.candidates.length, 0));
      return;
    }

    case "none": {
      await deps.store.clearBatch(chatId, batchId);
      deps.log({ msg: "learning_batch_none", batchId });
      await deps.editCard(messageId, renderNothing());
      return;
    }

    case "one": {
      await deps.editCard(messageId, renderOneByOne(batch.candidates, batch.cursor, batchId));
      return;
    }

    case "keep":
    case "skip": {
      const cand = batch.candidates[batch.cursor];
      if (action === "keep" && cand) persist(deps.learningsPath, [cand], deps.today());

      const guardados = batch.guardados + (action === "keep" ? 1 : 0);
      const descartados = batch.descartados + (action === "skip" ? 1 : 0);
      const cursor = batch.cursor + 1;

      if (cursor >= batch.candidates.length) {
        await deps.store.clearBatch(chatId, batchId);
        deps.log({ msg: "learning_review_done", batchId, guardados, descartados });
        await deps.editCard(messageId, renderDone(guardados, descartados));
        return;
      }

      const next = { ...batch, cursor, guardados, descartados };
      await deps.store.updateBatch(chatId, batchId, next);
      await deps.editCard(messageId, renderOneByOne(next.candidates, next.cursor, batchId));
      return;
    }

    default:
      deps.log({ msg: "learning_unknown_action", action });
      return;
  }
}
