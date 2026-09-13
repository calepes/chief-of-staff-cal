import { Hono } from "hono";
import { verifySecret } from "@cos/shared";
import type { TelegramUpdate, QueueMessage } from "@cos/shared";
import { handleLightCallback, isLightCallback } from "./callback-router.js";

interface Env {
  INBOX: Queue<QueueMessage>;
  STATE: KVNamespace;
  COS_TELEGRAM_BOT_TOKEN: string;
  COS_WEBHOOK_SECRET: string;
  NOTION_TOKEN: string;
  FUEL_ALERT_SECRET: string;
}

const CAL_CHAT_ID = 94137698;

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("cos-agent-worker v2"));

app.post("/telegram/webhook", async (c) => {
  const headerSecret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? null;
  if (!verifySecret(headerSecret, c.env.COS_WEBHOOK_SECRET)) {
    return c.text("unauthorized", 401);
  }
  const update = (await c.req.json()) as TelegramUpdate;

  // Allowlist de remitente: Jano es un bot 1:1 de Cal, sin soporte de grupos/otros
  // usuarios. El secret token solo prueba que el update viene de Telegram, no de Cal
  // — sin este check, cualquiera que encuentre el bot tiene acceso a las 164 tools
  // (Gmail, Calendar, borrar notas/eventos, datos de documentos de la familia vía QR
  // de aduana). Se descarta con 200 "ok" (no con 401) para que Telegram no reintente.
  const senderId = update.callback_query?.from?.id ?? update.message?.from?.id;
  if (senderId !== undefined && senderId !== CAL_CHAT_ID) {
    console.log(JSON.stringify({ msg: "unauthorized_sender", senderId, ts: Date.now() }));
    return c.text("ok");
  }

  // Spotify callbacks: ack y descartar (Spotify out of scope v2)
  if (update.callback_query?.data?.startsWith("spotify:")) {
    return c.text("ok");
  }

  // Light callback bypass: menu/nav (estáticos), t:d/t:c/t:s/t:sd (Notion direct)
  if (update.callback_query && isLightCallback(update.callback_query.data)) {
    const handled = await handleLightCallback(update.callback_query, {
      COS_TELEGRAM_BOT_TOKEN: c.env.COS_TELEGRAM_BOT_TOKEN,
      NOTION_TOKEN: c.env.NOTION_TOKEN,
    });
    if (handled) return c.text("ok");
    // si menu:section no está en MENU_SECTIONS estáticas, fall through al queue
  }

  const msg: QueueMessage = { kind: "telegram_update", payload: update, ts: Date.now() };
  await c.env.INBOX.send(msg);
  return c.text("ok");
});

// POST /fuel/alert — el worker combustible reporta llegada de gasolina.
// Auth: header X-Fuel-Secret == FUEL_ALERT_SECRET.
app.post("/fuel/alert", async (c) => {
  const secret = c.req.header("X-Fuel-Secret") ?? null;
  if (!secret || secret !== c.env.FUEL_ALERT_SECRET) {
    return c.text("unauthorized", 401);
  }
  let body: { events?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "bad_json" }, 400); }
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length === 0) {
    return c.json({ error: "bad_request" }, 400);
  }
  const msg: QueueMessage = { kind: "fuel_alert", payload: { events } as never, ts: Date.now() };
  await c.env.INBOX.send(msg);
  return c.json({ ok: true });
});

export default app;
