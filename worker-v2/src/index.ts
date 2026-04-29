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
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("cos-agent-worker v2"));

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

export default app;
