// backlog-card.ts — render PURO de tarjetas y teclados del backlog.
// Sin red ni estado. Parse mode HTML (skill telegram-bot-ux): escapar solo < > &, bullets •,
// nada de Markdown ni separadores ---.
//
// Emojis de dominio (ninguno decorativo): 📋 backlog · 📝 ítem nuevo · 📁 destino · ☑️ tildar.
//
// Presupuesto de callback_data (Telegram corta a 64 bytes): el peor caso es
// `bklg:destpick:{shortId8}:{key}`, que con la clave más larga de hoy queda holgado.

import type { BacklogMapRow } from "./backlog-types.js";

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

const GROUP_ORDER = ["Raíz", "Agentes", "Apps", "Otros"];

export function renderBacklogMap(rows: BacklogMapRow[]): Card {
  const total = rows.reduce((a, r) => a + r.pending, 0);
  const lines: string[] = [`📋 <b>Mapa de backlogs</b> · ${total} pendientes`];

  for (const group of GROUP_ORDER) {
    const inGroup = rows
      .filter((r) => r.group === group)
      .sort((a, b) => b.pending - a.pending || a.label.localeCompare(b.label));
    if (inGroup.length === 0) continue;
    lines.push("", `<b>${esc(group)}</b>`);
    for (const r of inGroup) lines.push(`• 📋 ${esc(r.label)} — ${r.pending}`);
  }

  return { text: lines.join("\n"), keyboard: { inline_keyboard: [] } };
}

export function renderAddProposal(destino: string, texto: string, shortId: string): Card {
  return {
    text: [
      "📝 <b>Nueva idea para el backlog</b>",
      "",
      `📁 ${esc(destino)}`,
      `«${esc(texto)}»`,
    ].join("\n"),
    keyboard: {
      // Layout del skill telegram-bot-ux (sección "Inline keyboards → Layout recomendado"):
      // la primaria (✅ Guardar, 10 chars) va sola en su fila; "✏️ Editar texto" (15 chars) y
      // "❌ Descartar" (12 chars) entran juntas en la banda 9-15; "📁 Cambiar proyecto" (19
      // chars) supera los 15 y va sola.
      inline_keyboard: [
        [{ text: "✅ Guardar", callback_data: `bklg:save:${shortId}` }],
        [
          { text: "✏️ Editar texto", callback_data: `bklg:edit:${shortId}` },
          { text: "❌ Descartar", callback_data: `bklg:drop:${shortId}` },
        ],
        [{ text: "📁 Cambiar proyecto", callback_data: `bklg:dest:${shortId}` }],
      ],
    },
  };
}

export function renderDoneProposal(destino: string, linea: string, shortId: string): Card {
  return {
    text: [
      "☑️ <b>Marcar como hecho</b>",
      "",
      `📁 ${esc(destino)}`,
      `«${esc(linea)}»`,
    ].join("\n"),
    keyboard: {
      // "✅ Confirmar" (12 chars) y "❌ Descartar" (12 chars) NO son el binario corto ≤8 chars
      // que el skill permite en una sola fila (ej. "✅ Sí"/"❌ No") — acá la acción escribe el
      // archivo y no tiene ↩️ Deshacer, así que cada una va en su propia fila.
      inline_keyboard: [
        [{ text: "✅ Confirmar", callback_data: `bklg:save:${shortId}` }],
        [{ text: "❌ Descartar", callback_data: `bklg:drop:${shortId}` }],
      ],
    },
  };
}

export function renderSaved(destino: string, texto: string, kind: "add" | "done"): Card {
  const head = kind === "add" ? "📝 <b>Anotado</b>" : "☑️ <b>Marcado como hecho</b>";
  return {
    text: [head, "", `📁 ${esc(destino)}`, `«${esc(texto)}»`].join("\n"),
    keyboard: { inline_keyboard: [] },
  };
}

export function renderDiscarded(): Card {
  return { text: "❌ <b>Descartado</b> · no anoté nada.", keyboard: { inline_keyboard: [] } };
}

/**
 * Selector de destino (bloque B3 del framework del skill: picker con escape).
 *
 * Tope DURO de 6 opciones en 3 filas de 2, más la fila de escape = 4 filas / 7 botones.
 * Hay 14 backlogs y creciendo: una fila por proyecto daría 14 filas, muy por encima del
 * límite de 4 filas / 12 botones de Telegram (arriba de eso hay stutter en iOS).
 *
 * Los 6 que se muestran son los de más pendientes — los proyectos activos son los destinos
 * probables. El resto se alcanza por el escape de texto libre, que SIEMPRE está presente.
 */
const DEST_MAX_BOTONES = 6;
/**
 * Los botones van de a 2 por fila — la banda del skill telegram-bot-ux para 2-por-fila es
 * 9-15 chars, no hasta 16 (bajado de 16 a 15 el 2026-07-28, W3+W4 del review de salud).
 */
const DEST_LABEL_MAX = 15;

export function renderDestPicker(rows: BacklogMapRow[], shortId: string): Card {
  const sorted = [...rows].sort((a, b) => b.pending - a.pending || a.label.localeCompare(b.label));
  const visibles = sorted.slice(0, DEST_MAX_BOTONES);

  const filas: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < visibles.length; i += 2) {
    filas.push(
      visibles.slice(i, i + 2).map((r) => ({
        text:
          r.label.length > DEST_LABEL_MAX ? `${r.label.slice(0, DEST_LABEL_MAX - 1)}…` : r.label,
        callback_data: `bklg:destpick:${shortId}:${r.key}`,
      })),
    );
  }
  filas.push([{ text: "✍️ Otro proyecto", callback_data: `bklg:destother:${shortId}` }]);

  const lines = ["📁 <b>¿A qué proyecto lo mando?</b>"];
  if (sorted.length > visibles.length) {
    lines.push("", `<i>Hay ${sorted.length - visibles.length} proyectos más — usa ✍️ y escribe el nombre.</i>`);
  }

  return { text: lines.join("\n"), keyboard: { inline_keyboard: filas } };
}
