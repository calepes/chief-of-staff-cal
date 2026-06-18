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

const MINI_APP_ORIGIN = "https://apps.lepesqueur.net";
const CAL_CHAT_ID = 94137698;

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("cos-agent-worker v2"));

// CORS preflight for mini app requests
app.options("/panini/register", (c) => {
  c.header("Access-Control-Allow-Origin", MINI_APP_ORIGIN);
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  return c.text("", 204);
});

// POST /panini/register — called from the Panini mini app (menu button context)
// No initData auth: CORS restricts origin to MINI_APP_ORIGIN; CAL_CHAT_ID is hardcoded.
app.post("/panini/register", async (c) => {
  c.header("Access-Control-Allow-Origin", MINI_APP_ORIGIN);

  const body = await c.req.json<{ codes?: string[] }>();
  const { codes } = body;

  if (!Array.isArray(codes) || codes.length === 0) {
    return c.json({ error: "bad_request" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const msg: QueueMessage = {
    kind: "telegram_update",
    payload: {
      update_id: Date.now(),
      message: {
        message_id: Date.now(),
        from: { id: CAL_CHAT_ID },
        chat: { id: CAL_CHAT_ID, type: "private" },
        date: now,
        web_app_data: { data: JSON.stringify({ codes }), button_text: "Álbum Panini 2026" },
      },
    },
    ts: Date.now(),
  };
  await c.env.INBOX.send(msg);
  return c.json({ ok: true });
});

app.post("/telegram/webhook", async (c) => {
  const headerSecret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? null;
  if (!verifySecret(headerSecret, c.env.COS_WEBHOOK_SECRET)) {
    return c.text("unauthorized", 401);
  }
  const update = (await c.req.json()) as TelegramUpdate;

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
