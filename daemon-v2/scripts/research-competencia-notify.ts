// Envío del resumen del research de competencia al bot de notificaciones (@ClaudeCalbot),
// separado del script principal para poder testearlo sin pagar sus side effects de import
// (loadEnv, delete ANTHROPIC_API_KEY). `fetchFn` inyectable para no pegarle a la red real en tests.

/** Chat de Cal en @ClaudeCalbot — mismo destino que usan otros scripts/daemons vía NOTIF_BOT_TOKEN. */
export const NOTIF_CHAT_ID = 94137698;

/** `--no-notify` — saltear el envío por Telegram (útil corriendo el script a mano). */
export function wantsNoNotify(argv: string[]): boolean {
  return argv.includes("--no-notify");
}

export type NotifyResult = { ok: true } | { ok: false; reason: string };

export interface SendNotifySummaryOpts {
  token?: string;
  chatId?: number | string;
  fetchFn?: typeof fetch;
}

/**
 * Manda `html` (parse_mode HTML — @ClaudeCalbot NO usa MarkdownV2) al bot de notificaciones.
 * Nunca lanza: un token faltante o un fallo de red/API se reporta en el `reason`, para que el
 * caller pueda seguir imprimiendo por consola y salir con éxito — el research ya corrió y ya
 * escribió en Notion, perder la notificación no invalida ese trabajo.
 */
export async function sendNotifySummary(html: string, opts: SendNotifySummaryOpts = {}): Promise<NotifyResult> {
  const token = opts.token ?? process.env.NOTIF_BOT_TOKEN;
  if (!token) {
    return { ok: false, reason: "NOTIF_BOT_TOKEN no configurado (~/.claude/notifications/.env)" };
  }
  const chatId = opts.chatId ?? NOTIF_CHAT_ID;
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML" }),
    });
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !data.ok) {
      return { ok: false, reason: data.description ?? res.statusText };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
