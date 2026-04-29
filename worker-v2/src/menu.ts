import type { TelegramCallbackQuery } from "@cos/shared";

export interface MenuItem {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface MenuSection {
  title: string;
  rows: MenuItem[][];
}

// Static menu definition. Mirror de ~/.claude/channels/telegram/menu.json
// hardcoded acá para evitar fetch a disco en el edge.
export const MENU_SECTIONS: Record<string, MenuSection> = {
  root: {
    title: "📋 *Menú Principal*",
    rows: [
      [
        { text: "🇧🇴 Bolivia", callback_data: "menu:briefing_bolivia" },
        { text: "🇵🇪 Perú", callback_data: "menu:briefing_peru" },
      ],
      [{ text: "☀️ Hoy", callback_data: "menu:today" }],
      [
        { text: "📋 Tareas", callback_data: "menu:tareas" },
        { text: "📊 Status", callback_data: "menu:status" },
      ],
      [{ text: "🏥 Salud", callback_data: "menu:salud" }],
    ],
  },
  // Otras secciones (tareas, today, status) se renderizan dinámicamente desde
  // el daemon — el worker solo enruta al daemon vía queue para esas.
};

export function buildInlineKeyboard(rows: MenuItem[][]): unknown {
  return { inline_keyboard: rows };
}
