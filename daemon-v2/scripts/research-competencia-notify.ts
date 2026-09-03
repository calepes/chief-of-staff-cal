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

/** Escapa solo `< > &` — mismo criterio HTML del resto del repo (ver `escapeHtml` en `src/index.ts`
 * y `src/tools/resumir.ts`). `err.message` puede traer cualquier texto (ej. el body crudo de un
 * error HTTP), y @ClaudeCalbot usa parse_mode HTML: sin escapar, un mensaje de error con `<`/`>`
 * puede romper el parseo de Telegram y perder el aviso justo cuando más hace falta. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Aviso mínimo por Telegram ante una excepción NO capturada de `main()` en
 * `research-competencia-now.ts` (bloqueante 1 de la revisión de salud, 2026-09-03). Antes, un
 * error que escapara de `runResearchCompetencia()` (ej. un bug fuera del try/catch por entidad, o
 * un fallo en `createInformePage`) caía al `console.error` + `exit(1)` genérico de `main().catch()`
 * — bajo un cron de launchd desatendido, ese log no lo lee nadie, y Cal se quedaba sin resumen NI
 * aviso de que algo salió mal. No depende de haber previsto el 100% de los casos: cualquier
 * `Error` (o valor lanzado) que llegue acá se reporta, sin necesidad de conocer su causa.
 *
 * Extraída del script principal (mismo motivo que `sendNotifySummary`/`wantsNoNotify` de arriba:
 * testeable sin pagar los side effects de import de `research-competencia-now.ts` — loadEnv, delete
 * ANTHROPIC_API_KEY, y el propio `main()` corriendo al importar el módulo).
 */
export async function notifyFatalError(err: unknown, opts: SendNotifySummaryOpts = {}): Promise<NotifyResult> {
  const mensaje = err instanceof Error ? err.message : String(err);
  const html = `⚠️ <b>Research de competencia falló</b>\nExcepción no capturada: ${escapeHtml(mensaje)}`;
  return sendNotifySummary(html, opts);
}
