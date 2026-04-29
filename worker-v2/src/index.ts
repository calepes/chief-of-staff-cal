import { Hono } from "hono";
import { verifySecret } from "@cos/shared";
import type { TelegramUpdate, QueueMessage } from "@cos/shared";

interface Env {
  INBOX: Queue<QueueMessage>;
  STATE: KVNamespace;
  COS_TELEGRAM_BOT_TOKEN: string;
  COS_WEBHOOK_SECRET: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("cos-agent-worker v2"));

app.post("/telegram/webhook", async (c) => {
  const headerSecret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? null;
  if (!verifySecret(headerSecret, c.env.COS_WEBHOOK_SECRET)) {
    return c.text("unauthorized", 401);
  }
  const update = (await c.req.json()) as TelegramUpdate;
  // TODO Phase 2: light callback bypass before queueing
  const msg: QueueMessage = { kind: "telegram_update", payload: update, ts: Date.now() };
  await c.env.INBOX.send(msg);
  return c.text("ok");
});

export default app;
