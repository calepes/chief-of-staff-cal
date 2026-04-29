const TG_API = "https://api.telegram.org";

export interface SendMessageOpts {
  chatId: number | string;
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  replyMarkup?: unknown;
  replyToMessageId?: number;
}

export async function sendMessage(token: string, opts: SendMessageOpts): Promise<{ message_id: number }> {
  const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: opts.chatId,
      text: opts.text,
      parse_mode: opts.parseMode,
      reply_markup: opts.replyMarkup,
      reply_to_message_id: opts.replyToMessageId,
    }),
  });
  const data = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
  if (!data.ok || !data.result) {
    throw new Error(`Telegram sendMessage failed: ${data.description ?? "unknown"}`);
  }
  return { message_id: data.result.message_id };
}

export async function editMessage(
  token: string,
  chatId: number | string,
  messageId: number,
  text: string,
  parseMode: "HTML" | "MarkdownV2" = "MarkdownV2",
  replyMarkup?: unknown,
): Promise<void> {
  const res = await fetch(`${TG_API}/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode,
      reply_markup: replyMarkup,
    }),
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`editMessage failed: ${data.description ?? "unknown"}`);
}

export async function editMessageReplyMarkup(
  token: string,
  chatId: number | string,
  messageId: number,
  replyMarkup: unknown,
): Promise<void> {
  await fetch(`${TG_API}/bot${token}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }),
  });
}

export async function answerCallbackQuery(token: string, callbackId: string, text?: string): Promise<void> {
  await fetch(`${TG_API}/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  });
}

export type ChatAction = "typing" | "upload_photo" | "record_voice" | "upload_voice" | "upload_document";

export async function sendChatAction(token: string, chatId: number | string, action: ChatAction = "typing"): Promise<void> {
  try {
    await fetch(`${TG_API}/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch {
    // best-effort
  }
}

export function escapeMarkdownV2(s: string): string {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export function verifySecret(headerValue: string | null, expected: string): boolean {
  return headerValue === expected;
}
