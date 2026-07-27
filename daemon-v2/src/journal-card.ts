// journal-card.ts — render PURO de las tarjetas y teclados del Journal.
// Sin red ni estado: entra una propuesta, sale {text, keyboard}. Parse mode HTML
// (skill telegram-bot-ux): escapar solo < > &, bullets •, sin Markdown.
//
// Presupuesto de callback_data (Telegram corta a 64 bytes): el peor caso es
// `jnl:togtopic:{shortId8}:{uuid36}` = 58 bytes. Si alargás el prefijo o el
// shortId, rehacé la cuenta — Telegram no avisa, el botón simplemente deja de andar.

import { ANIMOS, type MetaProposal, type NotionRef, type ReflexionProposal } from "./journal-types.js";

export interface Keyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface Card {
  text: string;
  keyboard: Keyboard;
}

const SWEEP_MAX_BOTONES = 5;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "2026-07-27T14:32:00-04:00" → "27/07" */
function ddmm(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}`;
}

/** "2026-07-27T14:32:00-04:00" → "14:32" */
function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

function topicsIncluidos(p: MetaProposal): NotionRef[] {
  const fuera = new Set(p.topicsExcluidos);
  return p.topics.filter((t) => !fuera.has(t.id));
}

export function renderMetaCard(p: MetaProposal, shortId: string): Card {
  const incluidos = topicsIncluidos(p);
  const lines = [
    `📓 <b>Guardado</b> — ${ddmm(p.fechaHora)} · ${hhmm(p.fechaHora)}`,
    "",
    `<i>"${esc(p.extracto)}"</i>`,
    "",
    "Propongo completar:",
    `• Título — ${esc(p.titulo)}`,
    `• Ánimo — ${p.animo} · Intensidad ${p.intensidad}/5`,
    `• Topics — ${incluidos.length > 0 ? esc(incluidos.map((t) => t.name).join(", ")) : "ninguno"}`,
    `• Big Theme — ${p.bigTheme ? esc(p.bigTheme.name) : "sin asignar"}`,
  ];
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          { text: "✅ Aplicar", callback_data: `jnl:apply:${shortId}` },
          { text: "✏️ Título", callback_data: `jnl:edit-title:${shortId}` },
        ],
        [
          { text: "🎭 Ánimo", callback_data: `jnl:pick-animo:${shortId}` },
          { text: "🏷️ Topics", callback_data: `jnl:pick-topics:${shortId}` },
        ],
        [
          { text: "🎯 Big Theme", callback_data: `jnl:pick-theme:${shortId}` },
          { text: "❌ Sin metadata", callback_data: `jnl:nometa:${shortId}` },
        ],
      ],
    },
  };
}

export function renderAnimoPicker(p: MetaProposal, shortId: string): Card {
  const animoRows: Array<Array<{ text: string; callback_data: string }>> = [];
  ANIMOS.forEach((a, i) => {
    const marca = a === p.animo ? "✅ " : "";
    const fila = Math.floor(i / 2);
    animoRows[fila] ??= [];
    animoRows[fila]!.push({ text: `${marca}${a}`, callback_data: `jnl:animo:${shortId}:${i}` });
  });
  const intensidadRow = [1, 2, 3, 4, 5].map((n) => ({
    text: n === p.intensidad ? `[${n}]` : String(n),
    callback_data: `jnl:inten:${shortId}:${n}`,
  }));
  return {
    text: `🎭 <b>Ánimo e intensidad</b>\nActual: ${p.animo} · ${p.intensidad}/5`,
    keyboard: {
      inline_keyboard: [
        ...animoRows,
        intensidadRow,
        [{ text: "⬅️ Volver", callback_data: `jnl:back:${shortId}` }],
      ],
    },
  };
}

export function renderTopicsPicker(p: MetaProposal, shortId: string): Card {
  const fuera = new Set(p.topicsExcluidos);
  const rows = p.topics.map((t) => [
    {
      text: `${fuera.has(t.id) ? "⬜" : "✅"} ${t.name}`,
      callback_data: `jnl:togtopic:${shortId}:${t.id}`,
    },
  ]);
  rows.push([{ text: "⬅️ Volver", callback_data: `jnl:back:${shortId}` }]);
  return {
    text: "🏷️ <b>Topics</b>\nToca para incluir o excluir.",
    keyboard: { inline_keyboard: rows },
  };
}

export function renderBigThemePicker(p: MetaProposal, shortId: string, themes: NotionRef[]): Card {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  themes.forEach((t, i) => {
    const fila = Math.floor(i / 2);
    rows[fila] ??= [];
    const marca = p.bigTheme?.id === t.id ? "✅ " : "";
    rows[fila]!.push({ text: `${marca}${t.name}`, callback_data: `jnl:theme:${shortId}:${t.id}` });
  });
  rows.push([
    { text: "🚫 Sin big theme", callback_data: `jnl:theme:${shortId}:none` },
    { text: "⬅️ Volver", callback_data: `jnl:back:${shortId}` },
  ]);
  return {
    text: "🎯 <b>Big Theme</b>\nElige uno.",
    keyboard: { inline_keyboard: rows },
  };
}

export function renderReflexionCard(p: ReflexionProposal, shortId: string): Card {
  const lines = [
    "🌟 <b>Aquí hay una reflexión</b>",
    "",
    `• Título — ${esc(p.titulo)}`,
    `• Situación — ${esc(p.situacion) || "—"}`,
    "• Type — Reflexion · Tags — Terapia",
    `• Topics — ${p.topics.length > 0 ? esc(p.topics.map((t) => t.name).join(", ")) : "ninguno"}`,
    `• Big Theme — ${p.bigTheme ? esc(p.bigTheme.name) : "sin asignar"}`,
  ];
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [{ text: "✅ Guardar en Resonate", callback_data: `jnl:resonate:${shortId}` }],
        [
          { text: "✏️ Editar", callback_data: `jnl:edit-refl:${shortId}` },
          { text: "⏭️ Ahora no", callback_data: `jnl:later:${shortId}` },
        ],
      ],
    },
  };
}

export function renderSweepSelector(
  entries: Array<{ id: string; titulo: string; fecha: string }>,
): Card {
  const visibles = entries.slice(0, SWEEP_MAX_BOTONES);
  const lines = [
    `📓 <b>${entries.length} ${entries.length === 1 ? "pensamiento" : "pensamientos"} sin destilar</b>`,
    "",
    ...visibles.map((e, i) => `${i + 1}. ${esc(e.titulo)} · ${ddmm(e.fecha)}`),
  ];
  if (entries.length > visibles.length) {
    lines.push(`(y ${entries.length - visibles.length} más)`);
  }
  const numeros = visibles.map((e, i) => ({
    text: String(i + 1),
    callback_data: `jnl:sweep:${e.id}`,
  }));
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        numeros,
        [
          { text: "✅ Revisar todos", callback_data: "jnl:sweep:all" },
          { text: "❌ Ahora no", callback_data: "jnl:sweep:none" },
        ],
      ],
    },
  };
}

export function renderModeOpen(): Card {
  return {
    text: "📓 <b>Modo journal abierto</b>\nTodo lo que envíes —texto o voz— se guarda tal cual.",
    keyboard: { inline_keyboard: [[{ text: "⏹️ Cerrar", callback_data: "jnl:mode:close" }]] },
  };
}

export function renderModeClosed(guardadas: number, pendientes: number): Card {
  const partes = [`Guardadas ${guardadas} ${guardadas === 1 ? "entrada" : "entradas"}`];
  if (pendientes > 0) {
    partes.push(`${pendientes} ${pendientes === 1 ? "reflexión pendiente" : "reflexiones pendientes"}`);
  }
  return {
    text: `📓 <b>Modo journal cerrado</b>\n${partes.join(" · ")}.`,
    keyboard: { inline_keyboard: [] },
  };
}

/**
 * Teclado de una tarjeta ya guardada. El botón de cerrar el modo solo aparece si
 * el modo journal está abierto — con el prefijo `journal:` no hay nada que cerrar
 * y ofrecerlo sería mentira.
 */
export function buildSavedKeyboard(entryId: string, modoAbierto: boolean): Keyboard {
  const rows = [[{ text: "↩️ Deshacer", callback_data: `jnl:undo:${entryId}` }]];
  if (modoAbierto) {
    rows.push([{ text: "⏹️ Cerrar journal", callback_data: `jnl:mode:close:${entryId}` }]);
  }
  return { inline_keyboard: rows };
}

export function renderApplied(p: MetaProposal, entryId: string, modoAbierto = false): Card {
  const incluidos = topicsIncluidos(p);
  const lines = [
    `📓 <b>Guardado</b> — ${ddmm(p.fechaHora)} · ${hhmm(p.fechaHora)}`,
    "",
    `<b>${esc(p.titulo)}</b>`,
    `${p.animo} · Intensidad ${p.intensidad}/5`,
    `🏷️ ${incluidos.length > 0 ? esc(incluidos.map((t) => t.name).join(", ")) : "sin topics"}`,
    `🎯 ${p.bigTheme ? esc(p.bigTheme.name) : "sin big theme"}`,
  ];
  return { text: lines.join("\n"), keyboard: buildSavedKeyboard(entryId, modoAbierto) };
}
