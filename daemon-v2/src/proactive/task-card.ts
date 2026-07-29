// task-card.ts — render PURO de las tarjetas del pipeline de mails "(Tarea)".
// Sin red ni estado: entran la propuesta + el contexto (cuántos quedan en cola, qué día es hoy)
// y sale {text, keyboard}. Parse mode HTML (skill telegram-bot-ux): escapar solo < > &, bullets
// •, nunca Markdown ni separadores ---.
//
// Emojis (todos verificados contra references/lexicon.md; los 3 de dominio están documentados en
// el CLAUDE.md de Jano y en el lexicon): 📋 tarea · 👤 asignado · 📅 fecha · ⏰ deadline ·
// 📎 adjunto · 📥 cola pendiente · 🚫 quitar valor · ✍️ escribir · ⏭️ posponer · ⬅️ volver ·
// ⌛ expirado · ✅ ❌ ⚠️ estándar.
//
// Presupuesto de callback_data (Telegram corta a 64 bytes): el peor caso es
// `tsk:asgpick:{id8}:{idx}` = 22 bytes.

import { TASK_PEOPLE, type TaskPerson } from "./task-people.js";
import { fridayNextWeek, fridayThisWeek, shortLabel } from "./task-dates.js";
import type { TaskProposal } from "./task-types.js";

export interface Keyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface Card {
  text: string;
  keyboard: Keyboard;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Los botones van de a 2 por fila — banda de 9-15 chars del skill telegram-bot-ux. */
const NAME_LABEL_MAX = 15;

/** 6 por página en 3 filas de 2, más la fila de escape = 4 filas, el techo de Telegram. */
export const PEOPLE_PER_PAGE = 6;

export const PEOPLE_PAGES = Math.ceil(TASK_PEOPLE.length / PEOPLE_PER_PAGE);

function truncName(nombre: string): string {
  return nombre.length > NAME_LABEL_MAX ? `${nombre.slice(0, NAME_LABEL_MAX - 1)}…` : nombre;
}

function fechaLabel(iso: string | null): string {
  return iso ? esc(iso) : "—";
}

export interface ProposalContext {
  /** Cuántos mails quedan esperando detrás de este. */
  pendientes: number;
  proposalId: string;
}

/** Tarjeta principal: lo que se propone crear, con un botón por campo ajustable. */
export function renderProposal(p: TaskProposal, ctx: ProposalContext): Card {
  const lines = [
    "📋 <b>Tarea propuesta</b>",
    `<b>${esc(p.title)}</b>`,
    "",
    `👤 ${esc(p.asignadoNombre)}`,
    `📅 Fecha: ${fechaLabel(p.fecha)}`,
    `⏰ Deadline: ${fechaLabel(p.deadline)}`,
  ];
  if (p.attachments.length > 0) {
    lines.push(`📎 ${p.attachments.length} ${p.attachments.length === 1 ? "adjunto" : "adjuntos"}`);
  }
  lines.push("", `<i>${esc(p.resumen)}</i>`);
  if (p.sinAccionClara) {
    lines.push("", "⚠️ El correo no deja una acción concreta — revísalo antes de crearla.");
  }
  if (p.followupIds.length > 0) {
    lines.push(
      "",
      `💬 ${p.followupIds.length} ${p.followupIds.length === 1 ? "correo posterior" : "correos posteriores"} del mismo hilo se agregan como seguimiento.`,
    );
  }
  if (ctx.pendientes > 0) {
    lines.push("", `📥 Quedan ${ctx.pendientes} en la cola.`);
  }

  const id = ctx.proposalId;
  const filas: Keyboard["inline_keyboard"] = [
    [{ text: "✅ Crear tarea", callback_data: `tsk:ok:${id}` }],
    [
      { text: "👤 Asignado", callback_data: `tsk:asg:${id}:0` },
      { text: "📅 Fecha", callback_data: `tsk:fec:${id}` },
    ],
    [
      { text: "⏰ Deadline", callback_data: `tsk:ded:${id}` },
      // "Después" solo tiene sentido si hay algo más esperando; si no, ocupa lugar sin hacer nada.
      ...(ctx.pendientes > 0
        ? [{ text: "⏭️ Después", callback_data: `tsk:later:${id}` }]
        : []),
    ],
    [{ text: "❌ Descartar", callback_data: `tsk:no:${id}` }],
  ];

  return { text: lines.join("\n"), keyboard: { inline_keyboard: filas } };
}

/**
 * Picker de personas (bloque B3 del skill: opciones + escape SIEMPRE presente).
 * Pagina el snapshot de 20 de a 6 sin tocar Notion; "⏭️ Más" cicla y vuelve a la primera página
 * al llegar al final (sin estado de "última página" que mantener sincronizado).
 */
export function renderPeoplePicker(page: number, proposalId: string): Card {
  const total = PEOPLE_PAGES;
  const safePage = ((page % total) + total) % total;
  const start = safePage * PEOPLE_PER_PAGE;
  const visibles = TASK_PEOPLE.slice(start, start + PEOPLE_PER_PAGE);

  const filas: Keyboard["inline_keyboard"] = [];
  for (let i = 0; i < visibles.length; i += 2) {
    filas.push(
      visibles.slice(i, i + 2).map((p) => ({
        text: truncName(p.nombre),
        callback_data: `tsk:asgpick:${proposalId}:${TASK_PEOPLE.indexOf(p)}`,
      })),
    );
  }
  filas.push([
    { text: "✍️ Otro", callback_data: `tsk:asgw:${proposalId}` },
    { text: "⏭️ Más", callback_data: `tsk:asg:${proposalId}:${safePage + 1}` },
    { text: "⬅️ Atrás", callback_data: `tsk:back:${proposalId}` },
  ]);

  return {
    text: [
      "👤 <b>¿A quién se asigna?</b>",
      "",
      `<i>Página ${safePage + 1} de ${total} · ✍️ Otro busca por nombre en Notion.</i>`,
    ].join("\n"),
    keyboard: { inline_keyboard: filas },
  };
}

/** Picker de fecha, compartido por Fecha y Deadline (cambia el prefijo del callback y el título). */
export function renderDatePicker(
  campo: "fecha" | "deadline",
  todayIso: string,
  proposalId: string,
): Card {
  const set = campo === "fecha" ? "fecs" : "deds";
  const write = campo === "fecha" ? "fecw" : "dedw";
  const vie = fridayThisWeek(todayIso);
  const prox = fridayNextWeek(todayIso);

  const titulo =
    campo === "fecha" ? "📅 <b>¿Cuándo se trabaja?</b>" : "⏰ <b>¿Para cuándo es el deadline?</b>";

  return {
    text: titulo,
    keyboard: {
      inline_keyboard: [
        [
          { text: `📅 Hoy ${shortLabel(todayIso)}`, callback_data: `tsk:${set}:${proposalId}:hoy` },
          { text: `📅 Vie ${shortLabel(vie)}`, callback_data: `tsk:${set}:${proposalId}:vie` },
        ],
        [
          { text: `📅 Vie ${shortLabel(prox)}`, callback_data: `tsk:${set}:${proposalId}:prox` },
          { text: "🚫 Sin fecha", callback_data: `tsk:${set}:${proposalId}:no` },
        ],
        [
          { text: "✍️ Escribir", callback_data: `tsk:${write}:${proposalId}` },
          { text: "⬅️ Atrás", callback_data: `tsk:back:${proposalId}` },
        ],
      ],
    },
  };
}

/**
 * Pregunta de texto libre (bloque B6: tiene que señalizar explícitamente que espera respuesta).
 * Conserva "⬅️ Atrás": si Cal escribe otra cosa, el mensaje sigue al agente y la tarjeta queda
 * usable en vez de trabada sin botones.
 */
export function renderAskInput(campo: "asignado" | "fecha" | "deadline", proposalId: string): Card {
  const cuerpo =
    campo === "asignado"
      ? [
          "✍️ <b>Escribe el nombre</b>",
          "",
          "Ejemplos: <code>Lorena</code> · <code>Maria Elena Canahua</code>",
        ]
      : [
          `✍️ <b>Escribe la ${campo === "fecha" ? "fecha" : "fecha límite"}</b>`,
          "",
          "Ejemplos: <code>15/9</code> · <code>viernes</code> · <code>mañana</code> · <code>sin fecha</code>",
        ];

  return {
    text: cuerpo.join("\n"),
    keyboard: { inline_keyboard: [[{ text: "⬅️ Atrás", callback_data: `tsk:back:${proposalId}` }]] },
  };
}

/**
 * Estado intermedio de "✅ Crear tarea" (regla R2 del skill: el trabajo mecánico que pasa de un
 * segundo necesita placeholder). Además es la protección real contra el doble tap: al quitar el
 * teclado, el botón deja de existir mientras se suben adjuntos y se escribe la página — que puede
 * superar los 60s del lock anti-doble-tap.
 */
export function renderCreating(p: TaskProposal): Card {
  return {
    text: ["⏳ <b>Creando la tarea…</b>", `📋 ${esc(p.title)}`].join("\n"),
    keyboard: { inline_keyboard: [] },
  };
}

export interface CreatedInfo {
  url: string;
  adjuntosSubidos: number;
  adjuntosTotal: number;
  yaExistia?: boolean;
}

export function renderCreated(p: TaskProposal, info: CreatedInfo, pendientes: number): Card {
  const lines = [
    info.yaExistia ? "✅ <b>Esa tarea ya estaba creada</b>" : "✅ <b>Tarea creada</b>",
    `📋 <a href="${esc(info.url)}">${esc(p.title)}</a>`,
    "",
    `👤 ${esc(p.asignadoNombre)}`,
    `📅 Fecha: ${fechaLabel(p.fecha)}`,
    `⏰ Deadline: ${fechaLabel(p.deadline)}`,
  ];
  if (info.adjuntosTotal > 0 && !info.yaExistia) {
    // El conteo real de subidos, no el del correo: uploadAttachments traga el fallo de un adjunto
    // (Notion corta el upload single-part en ~20 MB), y decir "2 adjuntos" con la página vacía
    // haría que Cal los diera por guardados.
    const ok = info.adjuntosSubidos;
    lines.push(
      ok === info.adjuntosTotal
        ? `📎 ${ok} ${ok === 1 ? "adjunto" : "adjuntos"}`
        : `📎 ${ok} de ${info.adjuntosTotal} adjuntos — ${info.adjuntosTotal - ok} no se pudieron subir (siguen en el correo).`,
    );
  }
  if (pendientes > 0) {
    lines.push("", `📥 Sigo con la siguiente · quedan ${pendientes}.`);
  }
  return { text: lines.join("\n"), keyboard: { inline_keyboard: [] } };
}

export function renderDiscarded(p: TaskProposal, pendientes: number): Card {
  const lines = ["❌ <b>Descartada</b>", `📋 ${esc(p.title)}`, "", "No creé nada en Notion."];
  if (pendientes > 0) lines.push("", `📥 Sigo con la siguiente · quedan ${pendientes}.`);
  return { text: lines.join("\n"), keyboard: { inline_keyboard: [] } };
}

export function renderPostponed(p: TaskProposal, pendientes: number): Card {
  return {
    text: [
      "⏭️ <b>La dejo para después</b>",
      `📋 ${esc(p.title)}`,
      "",
      `📥 Vuelve al final de la cola · quedan ${pendientes}.`,
    ].join("\n"),
    keyboard: { inline_keyboard: [] },
  };
}

export function renderExpired(): Card {
  return {
    text: "⌛ <b>Esa propuesta expiró.</b>\nEl correo sigue en tu inbox: reenvíalo si todavía la quieres.",
    keyboard: { inline_keyboard: [] },
  };
}

/** B2c del skill: error en fase intermedia → reintento explícito, la propuesta NO se borra. */
export function renderCreateFailed(p: TaskProposal, err: string, proposalId: string): Card {
  return {
    text: [
      "⚠️ <b>No pude crear la tarea</b>",
      `📋 ${esc(p.title)}`,
      esc(err.slice(0, 200)),
      "",
      "La propuesta sigue viva: vuelve a intentarlo.",
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          { text: "🔄 Reintentar", callback_data: `tsk:ok:${proposalId}` },
          { text: "❌ Descartar", callback_data: `tsk:no:${proposalId}` },
        ],
      ],
    },
  };
}

/** Persona escrita a mano que no se pudo resolver — se le vuelve a preguntar, nunca se adivina. */
export function renderPersonNotFound(query: string, proposalId: string): Card {
  return {
    text: [
      "⚠️ <b>No encontré esa persona</b>",
      `«${esc(query)}»`,
      "",
      "Escribe el nombre completo como figura en Notion, o elige de la lista.",
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          { text: "👤 Ver lista", callback_data: `tsk:asg:${proposalId}:0` },
          { text: "⬅️ Atrás", callback_data: `tsk:back:${proposalId}` },
        ],
      ],
    },
  };
}

export function personByIndex(idx: number): TaskPerson | null {
  return TASK_PEOPLE[idx] ?? null;
}
