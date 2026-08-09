import { sendMessage, sendRichMessage, editMessage, editRichMessage } from "@cos/shared";

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

export interface CronEditMessageOpts {
  chatId: number;
  messageId: number;
  text: string;
  replyMarkup?: unknown;
}

/** Misma lógica que `sendCronMessage` pero para editar in-place (tarjetas ancla por fases). */
export async function editCronMessage(botToken: string, opts: CronEditMessageOpts): Promise<void> {
  try {
    await editRichMessage(botToken, opts.chatId, opts.messageId, opts.text, opts.replyMarkup);
  } catch (richErr) {
    console.error(JSON.stringify({ ts: Date.now(), msg: "cron_rich_message_failed", err: String(richErr) }));
    await editMessage(botToken, opts.chatId, opts.messageId, opts.text, "HTML", opts.replyMarkup);
  }
}

// Fallback cuando Rich Messages Y el HTML clásico fallan los dos (rechazo de Telegram, tag mal
// formada, etc.) — sin esto, reenviar el texto tal cual deja tags <b>/<i>/<table>/etc. crudas
// visibles para Cal en vez de texto plano legible. Las tags de Rich Messages (h1-h6/ul/ol/table/
// details/summary) no las soporta el HTML clásico ni el texto plano — insertamos saltos de
// línea/separadores en los bordes de bloque ANTES de despojar el resto, para que el resultado
// siga siendo legible (ej. una fila de tabla no queda pegada como "FormatoHorario2D14:00").
// Compartido entre index.ts (reply del modelo) y tools/resumir.ts (contenido generado por un
// subproceso `claude` externo, mismo perfil de riesgo que el reply libre).
export function stripHtmlTags(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(h1|h2|h3|h4|h5|h6|p|div|tr|li|details|summary)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/(td|th)>/gi, " · ")
    .replace(/<\/?(table|ul|ol)[^>]*>/gi, "\n");
  return withBreaks
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
