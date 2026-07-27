/**
 * menu.ts — Menú interactivo de Telegram para Jano (CoS personal de Cal).
 *
 * Convenciones:
 * - callback_data con prefijo "j:" para distinguir de callbacks legacy del worker.
 * - Parse mode: siempre HTML.
 * - Máximo 3 botones por fila, 4 filas totales.
 * - Callbacks de navegación → editMessage con sub-menú (sin LLM).
 * - Callbacks de acción → mensaje sintético en lenguaje natural → LLM.
 */

import { editMessage, answerCallbackQuery, sendMessage } from "@cos/shared";
import type { TelegramUpdate, TelegramCallbackQuery } from "@cos/shared";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface MenuPayload {
  text: string;
  keyboard: InlineKeyboardMarkup;
}

// ---------------------------------------------------------------------------
// Menús
// ---------------------------------------------------------------------------

export function buildMainMenu(): MenuPayload {
  return {
    text: "🎯 <b>¿En qué te ayudo, Cal?</b>",
    keyboard: {
      inline_keyboard: [
        [
          { text: "🏥 Salud", callback_data: "j:health" },
          { text: "💰 Cambio", callback_data: "j:fx" },
          { text: "🚗 Combustible", callback_data: "j:fuel" },
        ],
        [
          { text: "✈️ Vuelos", callback_data: "j:flights" },
          { text: "⚡ Tokens", callback_data: "j:tokens" },
        ],
        [
          { text: "⭐ Starred", callback_data: "j:star" },
          { text: "🎬 Playlist", callback_data: "j:ytpl" },
          { text: "📚 Resumir", callback_data: "j:resumir" },
        ],
        [
          { text: "📓 Journal", callback_data: "j:journal" },
          { text: "📋 Estado", callback_data: "j:estado" },
        ],
      ],
    },
  };
}

// Teclado persistente bajo el campo de texto: un botón "📋 Menú" siempre visible en el chat
// para abrir el menú principal sin escribir /menu. Se fija adjuntándolo a cualquier sendMessage.
export const MENU_REPLY_KEYBOARD = {
  keyboard: [[{ text: "📋 Menú" }]],
  resize_keyboard: true,
  is_persistent: true,
};

export function buildHealthMenu(): MenuPayload {
  return {
    text: "🏥 <b>Salud</b> — ¿Qué datos?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "📊 Resumen", callback_data: "j:health:sum" },
          { text: "📈 Tendencia", callback_data: "j:health:trend" },
          { text: "💪 Workouts", callback_data: "j:health:work" },
        ],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildCambioMenu(): MenuPayload {
  return {
    text: "💰 <b>Tipo de cambio</b> — ¿Qué tasa?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "🏦 BCB", callback_data: "j:fx:bcb" },
          { text: "💹 P2P Binance", callback_data: "j:fx:p2p" },
          { text: "📊 Ambos", callback_data: "j:fx:all" },
        ],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildFlightsMenu(): MenuPayload {
  return {
    text: "✈️ <b>Vuelos</b> — ¿qué aeropuerto?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "Santa Cruz VVI", callback_data: "j:flights:vvi" },
          { text: "La Paz LPB",     callback_data: "j:flights:lpb" },
          { text: "Cochabamba CBB", callback_data: "j:flights:cbb" },
        ],
        [
          { text: "Tarija TJA",     callback_data: "j:flights:tja" },
          { text: "Sucre SRE",      callback_data: "j:flights:sre" },
          { text: "Oruro ORU",      callback_data: "j:flights:oru" },
        ],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

function buildFlightsDirMenu(code: string, name: string): MenuPayload {
  return {
    text: `✈️ <b>${code} · ${name}</b> — ¿salidas o llegadas?`,
    keyboard: {
      inline_keyboard: [
        [
          { text: "🛫 Salidas hoy",  callback_data: `j:flights:${code.toLowerCase()}:dep` },
          { text: "🛬 Llegadas hoy", callback_data: `j:flights:${code.toLowerCase()}:arr` },
        ],
        [{ text: "← Aeropuertos", callback_data: "j:flights" }],
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Mapeo acción → texto natural para el LLM
// ---------------------------------------------------------------------------

const ACTION_TEXT: Record<string, string> = {
  // j:star y j:ytpl son MECÁNICOS (se interceptan en index.ts y editan el mensaje tocado como ancla).
  "j:resumir": "Quiero resumir un link o título de libro; pídeme cuál es.",
  "j:estado": "Dame el estado del resumidor: qué hay en curso y en cola (playlist y starred).",
  "j:resu:tag": "Quiero agregar uno o más tags al resumen pendiente ANTES de guardar. Preguntame en una línea qué tag(s) agregar; cuando responda, llamá mcp__cos-tools__editarPropuestaResumen con addTags. NO guardes todavía.",
  "j:resu:edit": "Quiero editar los highlights o tags del resumen pendiente. Preguntame en una línea qué cambiar; usá mcp__cos-tools__editarPropuestaResumen (setTags / removeHighlights / retag). NO guardes hasta que confirme.",
  "j:health:sum": "Dame un resumen de mi salud",
  "j:health:trend": "Muéstrame la tendencia de mi salud",
  "j:health:work": "Muéstrame mis workouts recientes",
  "j:fx:bcb": "¿Cuál es el tipo de cambio BCB oficial hoy?",
  "j:fx:p2p": "¿Cuál es la tasa P2P de Binance ahora?",
  "j:fx:all": "Dame el tipo de cambio BCB oficial y P2P Binance",
  "j:fuel": "Muéstrame las gasolineras con combustible disponible en Santa Cruz",
  "j:tokens": "¿Cuánto presupuesto de Claude Max llevo hoy?",
  "j:flights:vvi:dep": "Muéstrame las salidas de hoy desde VVI (Viru Viru, Santa Cruz)",
  "j:flights:vvi:arr": "Muéstrame las llegadas de hoy a VVI (Viru Viru, Santa Cruz)",
  "j:flights:lpb:dep": "Muéstrame las salidas de hoy desde LPB (El Alto, La Paz)",
  "j:flights:lpb:arr": "Muéstrame las llegadas de hoy a LPB (El Alto, La Paz)",
  "j:flights:cbb:dep": "Muéstrame las salidas de hoy desde CBB (Cochabamba)",
  "j:flights:cbb:arr": "Muéstrame las llegadas de hoy a CBB (Cochabamba)",
  "j:flights:tja:dep": "Muéstrame las salidas de hoy desde TJA (Tarija)",
  "j:flights:tja:arr": "Muéstrame las llegadas de hoy a TJA (Tarija)",
  "j:flights:sre:dep": "Muéstrame las salidas de hoy desde SRE (Sucre)",
  "j:flights:sre:arr": "Muéstrame las llegadas de hoy a SRE (Sucre)",
  "j:flights:oru:dep": "Muéstrame las salidas de hoy desde ORU (Oruro)",
  "j:flights:oru:arr": "Muéstrame las llegadas de hoy a ORU (Oruro)",
};

// Callbacks de navegación pura (solo editan el mensaje, sin LLM)
const NAV_MENUS: Record<string, () => MenuPayload> = {
  "j:menu": buildMainMenu,
  "j:health": buildHealthMenu,
  "j:fx": buildCambioMenu,
  "j:flights": buildFlightsMenu,
  "j:flights:vvi": () => buildFlightsDirMenu("VVI", "Viru Viru (SCZ)"),
  "j:flights:lpb": () => buildFlightsDirMenu("LPB", "El Alto (LPZ)"),
  "j:flights:cbb": () => buildFlightsDirMenu("CBB", "Jorge Wilstermann"),
  "j:flights:tja": () => buildFlightsDirMenu("TJA", "Oriel Lea Plaza"),
  "j:flights:sre": () => buildFlightsDirMenu("SRE", "Alcantarí"),
  "j:flights:oru": () => buildFlightsDirMenu("ORU", "Juan Méndez"),
};

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

/**
 * Maneja callbacks con prefijo "j:".
 *
 * @param cb              - Objeto callback_query de Telegram.
 * @param token           - Bot token de Jano.
 * @param processMessageFn - Función processMessage de index.ts (para callbacks de acción).
 * @param updateId        - update_id del TelegramUpdate original.
 */
export async function handleMenuCallback(
  cb: TelegramCallbackQuery,
  token: string,
  processMessageFn: (payload: TelegramUpdate, queueWaitMs: number, opts?: { existingPlaceholderId?: number }) => Promise<void>,
  updateId: number,
): Promise<void> {
  const data = cb.data ?? "";
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;

  // Siempre dismissar el spinner de Telegram
  await answerCallbackQuery(token, cb.id);

  // --- Navegación pura ---
  if (data in NAV_MENUS) {
    if (chatId == null || messageId == null) return;
    const menu = NAV_MENUS[data]();
    await editMessage(token, chatId, messageId, menu.text, "HTML", menu.keyboard);
    return;
  }

  // --- Acción → LLM (Option B: el mensaje de menú se convierte en placeholder) ---
  const naturalText = ACTION_TEXT[data];
  if (!naturalText) return;
  if (!cb.message) return;

  const menuMsgId = cb.message.message_id;
  const actionChatId = cb.message.chat.id;

  // 1. El menú se edita a ⏳ (queda como placeholder, sin teclado)
  await editMessage(token, actionChatId, menuMsgId, "⏳ Pensando...", "HTML");

  // 2. Update sintético usando el mismo chat
  const synthetic: TelegramUpdate = {
    update_id: updateId,
    message: {
      message_id: menuMsgId,
      chat: cb.message.chat,
      date: Math.floor(Date.now() / 1000),
      text: naturalText,
      from: cb.from ? { id: cb.from.id, first_name: cb.from.first_name } : undefined,
    },
  };

  // 3. LLM reemplaza el placeholder con la respuesta
  await processMessageFn(synthetic, 0, { existingPlaceholderId: menuMsgId });
}
