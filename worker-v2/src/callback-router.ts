import type { TelegramCallbackQuery } from "@cos/shared";
import { answerCallbackQuery, editMessage } from "@cos/shared";
import { MENU_SECTIONS, buildInlineKeyboard } from "./menu.js";
import { setTaskStatus, setTaskDateToday } from "./notion-light.js";

export interface CallbackEnv {
  COS_TELEGRAM_BOT_TOKEN: string;
  NOTION_TOKEN: string;
}

// Status valor real en DB Tareas Notion para "done": "Listo"
const STATUS_DONE = "Listo";

const LIGHT_PREFIXES = new Set(["menu", "t:d", "t:c", "t:s", "t:sd", "nav"]);

export function isLightCallback(data: string | undefined): boolean {
  if (!data) return false;
  const parts = data.split(":");
  if (parts.length < 2) return false;
  // 2-part: menu:section, nav:section
  // 3-part: t:d:pageId, t:c:pageId, t:s:pageId, t:sd:pageId
  const prefix2 = `${parts[0]}:${parts[1]}`;
  if (LIGHT_PREFIXES.has(prefix2)) return true;
  if (LIGHT_PREFIXES.has(parts[0]!)) return true;
  return false;
}

export async function handleLightCallback(cb: TelegramCallbackQuery, env: CallbackEnv): Promise<boolean> {
  const data = cb.data;
  if (!data || !cb.message) return false;
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const token = env.COS_TELEGRAM_BOT_TOKEN;

  // menu:section — render estático si la sección está en MENU_SECTIONS
  // Si no está, fall through al daemon (heavy, requiere data dinámica)
  if (data.startsWith("menu:")) {
    const section = data.slice(5);
    const sec = MENU_SECTIONS[section];
    if (!sec) return false; // → queue al daemon
    await answerCallbackQuery(token, cb.id);
    await editMessage(token, chatId, messageId, sec.title, "MarkdownV2", buildInlineKeyboard(sec.rows));
    return true;
  }

  // nav:section — alias de menu:
  if (data.startsWith("nav:")) {
    const section = data.slice(4);
    const sec = MENU_SECTIONS[section];
    if (!sec) return false;
    await answerCallbackQuery(token, cb.id);
    await editMessage(token, chatId, messageId, sec.title, "MarkdownV2", buildInlineKeyboard(sec.rows));
    return true;
  }

  // t:d:<pageId32> — mark task done
  if (data.startsWith("t:d:")) {
    const pageId = data.slice(4);
    await answerCallbackQuery(token, cb.id, "Listo ✅");
    try {
      await setTaskStatus({ notionToken: env.NOTION_TOKEN }, pageId, STATUS_DONE);
      await editMessage(token, chatId, messageId, "✅ Tarea marcada como Listo\\.", "MarkdownV2");
    } catch {
      await editMessage(token, chatId, messageId, "⚠️ Error marcando tarea\\. Reintenta\\.", "MarkdownV2");
    }
    return true;
  }

  // t:c:<pageId32> — complete (alias de done)
  if (data.startsWith("t:c:")) {
    const pageId = data.slice(4);
    await answerCallbackQuery(token, cb.id, "Listo ✅");
    try {
      await setTaskStatus({ notionToken: env.NOTION_TOKEN }, pageId, STATUS_DONE);
      await editMessage(token, chatId, messageId, "✅ Tarea completada\\.", "MarkdownV2");
    } catch {
      await editMessage(token, chatId, messageId, "⚠️ Error\\.", "MarkdownV2");
    }
    return true;
  }

  // t:s:<pageId32> — skip (no-op, solo ack)
  if (data.startsWith("t:s:")) {
    await answerCallbackQuery(token, cb.id, "Saltada");
    return true;
  }

  // t:sd:<pageId32> — set date today
  if (data.startsWith("t:sd:")) {
    const pageId = data.slice(5);
    await answerCallbackQuery(token, cb.id, "Fecha: hoy");
    try {
      await setTaskDateToday({ notionToken: env.NOTION_TOKEN }, pageId);
      await editMessage(token, chatId, messageId, "📅 Fecha actualizada a hoy\\.", "MarkdownV2");
    } catch {
      await editMessage(token, chatId, messageId, "⚠️ Error actualizando fecha\\.", "MarkdownV2");
    }
    return true;
  }

  return false;
}
