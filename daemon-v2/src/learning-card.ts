// learning-card.ts — render PURO de las tarjetas del pase nocturno de self-learning.
// Sin red ni estado: entra una lista de candidatos, sale {text, keyboard}. Parse mode HTML
// (skill telegram-bot-ux): escapar solo < > &, numeración en texto plano, sin Markdown.

import { LEARNING_BUDGET_TOKENS } from "./learning-file.js";
import type { LearningCandidate, LearningTag } from "./learning-types.js";

export interface Keyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface Card {
  text: string;
  keyboard: Keyboard;
}

/** Emoji por tag (lexicon de self-learning, ver skill telegram-bot-ux). */
export const TAG_EMOJI: Record<LearningTag, string> = {
  pref: "🎯",
  hecho: "🧠",
  err: "🔧",
  flujo: "🔁",
};

/**
 * Mismo criterio que SWEEP_MAX_BOTONES del Journal: más de 5 vuelve la tarjeta una
 * pared de texto en mobile.
 *
 * ⚠️ Exportada a propósito: el cron (proactive/learning-reflect.ts) recorta la lista de
 * candidatos a este mismo tope ANTES de guardar el batch, para que lo que se propone sea
 * exactamente lo que se puede aprobar. Antes el recorte era solo de render y `✅ Guardar todos`
 * persistía `batch.candidates` COMPLETO — con 6+ candidatos entraba al system prompt, de forma
 * permanente, texto que Cal nunca vio. Importa especialmente porque el transcript acarrea
 * material no confiable (resúmenes de páginas web vía fetchAsUser / el resumidor entran como
 * bloques `JANO:`). Usar SIEMPRE esta constante en ambos lados; no duplicar el número.
 */
export const BATCH_MAX_VISIBLES = 5;

/**
 * Presupuesto BLANDO por el que avisamos en la tarjeta. Importado de learning-file.ts
 * (no duplicado) para que nunca se desincronice con el semáforo real del archivo.
 */
const BUDGET = LEARNING_BUDGET_TOKENS;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderBatch(cands: LearningCandidate[], batchId: string, tokensActuales: number): Card {
  const visibles = cands.slice(0, BATCH_MAX_VISIBLES);
  const lines = [
    "🌙 <b>Reflexión del día</b>",
    "",
    `${cands.length} ${cands.length === 1 ? "aprendizaje candidato" : "aprendizajes candidatos"}:`,
    "",
    ...visibles.map((c, i) => `${i + 1}. ${TAG_EMOJI[c.tag]} «${esc(c.text)}»`),
  ];
  if (cands.length > visibles.length) {
    lines.push(`(y ${cands.length - visibles.length} más)`);
  }
  if (tokensActuales > BUDGET) {
    lines.push("");
    lines.push("🧹 Los learnings activos ya superan el presupuesto — conviene podar los más viejos.");
  }
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          { text: "✅ Guardar todos", callback_data: `lrn:all:${batchId}` },
          { text: "🔍 Uno a uno", callback_data: `lrn:one:${batchId}` },
        ],
        [{ text: "❌ Ninguno", callback_data: `lrn:none:${batchId}` }],
      ],
    },
  };
}

export function renderOneByOne(cands: LearningCandidate[], cursor: number, batchId: string): Card {
  const c = cands[cursor]!;
  const lines = [
    `🌙 <b>Aprendizaje ${cursor + 1} de ${cands.length}</b>`,
    "",
    `${TAG_EMOJI[c.tag]} «${esc(c.text)}»`,
    `<i>${esc(c.evidencia)}</i>`,
  ];
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          { text: "✅ Guardar", callback_data: `lrn:keep:${batchId}` },
          { text: "⏭️ Saltar", callback_data: `lrn:skip:${batchId}` },
        ],
        [{ text: "⏹️ Terminar", callback_data: `lrn:none:${batchId}` }],
      ],
    },
  };
}

export function renderDone(guardados: number, descartados: number): Card {
  const partes = [`Guardé ${guardados} ${guardados === 1 ? "aprendizaje" : "aprendizajes"}`];
  if (descartados > 0) {
    partes.push(`descarté ${descartados}`);
  }
  return {
    text: `🌙 <b>Reflexión revisada</b>\n${partes.join(" · ")}.`,
    keyboard: { inline_keyboard: [] },
  };
}

export function renderNothing(): Card {
  return {
    text: "🌙 <b>Reflexión revisada</b>\nNo guardé nada esta vez.",
    keyboard: { inline_keyboard: [] },
  };
}
