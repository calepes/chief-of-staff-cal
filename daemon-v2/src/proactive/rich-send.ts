import { sendMessage, sendRichMessage } from "@cos/shared";

export interface CronMessageOpts {
  chatId: number;
  text: string;
  replyMarkup?: unknown;
}

/**
 * Envío estándar de los crones (contenido generado en código, no prosa libre del LLM):
 * intenta Rich Messages primero, y si Telegram lo rechaza (tag mal formada, etc.) cae a
 * HTML clásico. Sin nivel de texto plano — a diferencia del reply del modelo en index.ts,
 * este HTML lo arma el propio código del cron, así que un fallo acá es un problema real de
 * Telegram/red, no de HTML generado por el LLM.
 */
export async function sendCronMessage(botToken: string, opts: CronMessageOpts): Promise<{ message_id: number }> {
  try {
    return await sendRichMessage(botToken, { chatId: opts.chatId, html: opts.text, replyMarkup: opts.replyMarkup });
  } catch (richErr) {
    console.error(JSON.stringify({ ts: Date.now(), msg: "cron_rich_message_failed", err: String(richErr) }));
    return sendMessage(botToken, {
      chatId: opts.chatId,
      text: opts.text,
      parseMode: "HTML",
      replyMarkup: opts.replyMarkup,
    });
  }
}
