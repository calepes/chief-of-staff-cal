import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { config as loadEnv } from "dotenv";
import cron from "node-cron";
import { createSdkMcpServer, startup, type Options, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { runAgent } from "./agent.js";
import { buildSdkTools } from "./agent-tools.js";
import { CLAUDE_AI_COS_TOOLS, DISALLOWED_BUILTINS } from "./agent-options.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { buildLearningsSection } from "./learnings.js";
import { compactHistory } from "./compact.js";
import { QueuePoller } from "./queue-poller.js";
import { CfKv } from "./cf-kv.js";
import { ConversationState } from "./state.js";
import { sendMessage, editMessage, sendChatAction, sendVoice, deleteMessage, type ChatAction } from "@cos/shared";
import type { TelegramUpdate, QueueMessage } from "@cos/shared";
import { downloadTelegramFile } from "./tools/telegram-files.js";
import { transcribeAudio } from "./tools/whisper.js";
import { analyzePhoto } from "./tools/vision.js";

loadEnv({ path: `${process.env.HOME}/.cos-agent/.env` });

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
}

const env = {
  CF_ACCOUNT_ID: requireEnv("CF_ACCOUNT_ID"),
  CF_QUEUE_ID: requireEnv("CF_QUEUE_ID"),
  CF_KV_NAMESPACE_ID: requireEnv("CF_KV_NAMESPACE_ID"),
  CF_API_TOKEN: requireEnv("CF_API_TOKEN"),
  COS_TELEGRAM_BOT_TOKEN: requireEnv("COS_TELEGRAM_BOT_TOKEN"),
  NOTION_TOKEN: requireEnv("NOTION_TOKEN"),
  NOTION_TAREAS_DB_ID: requireEnv("NOTION_TAREAS_DB_ID"),
  NOTION_PEOPLE_DB_ID: requireEnv("NOTION_PEOPLE_DB_ID"),
  HEALTH_API_KEY: process.env.HEALTH_API_KEY ?? "",
  FEEDBIN_USERNAME: process.env.FEEDBIN_USERNAME ?? "",
  FEEDBIN_PASSWORD: process.env.FEEDBIN_PASSWORD ?? "",
  ANTHROPIC_API_KEY: requireEnv("ANTHROPIC_API_KEY"),
  COS_WEBHOOK_URL: process.env.COS_WEBHOOK_URL ?? "https://cos-agent-worker.carlos-cb4.workers.dev/telegram/webhook",
  COS_WEBHOOK_SECRET: process.env.COS_WEBHOOK_SECRET ?? "",
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY ?? "",
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID ?? "",
};

// Force SDK to use OAuth Max instead of API key (Tier 1 rate limited).
// Spawned subprocess inherits env and prefers ANTHROPIC_API_KEY over credentials.
delete process.env.ANTHROPIC_API_KEY;

const HEARTBEAT_PATH = `${process.env.HOME}/.cos-agent/heartbeat`;
const LEARNINGS_PATH = `${process.env.HOME}/.cos-agent/learnings.md`;
const ALERT_CHAT_ID = 94137698;
const ALERT_THRESHOLD = 3;
const BACKOFF_MAX_MS = 120_000;

function log(obj: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: Date.now(), ...obj }));
}

function heartbeat() {
  try {
    writeFileSync(HEARTBEAT_PATH, JSON.stringify({ ts: Date.now(), pid: process.pid }));
  } catch (err) {
    log({ msg: "heartbeat_error", err: String(err) });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const kv = new CfKv({
  accountId: env.CF_ACCOUNT_ID,
  namespaceId: env.CF_KV_NAMESPACE_ID,
  apiToken: env.CF_API_TOKEN,
});
const state = new ConversationState(kv, compactHistory);

// chatId del turno actual — los tools que necesitan saber a qué chat responder
// (ej. runBriefing, que dispara un subprocess que después manda follow-up) lo
// leen via getCurrentChatId(). Se setea al inicio de cada processMessage.
// Safe porque el daemon procesa mensajes serialmente (1 worker en queue).
let currentChatId = 0;

const sdkTools = buildSdkTools({
  botToken: env.COS_TELEGRAM_BOT_TOKEN,
  getCurrentChatId: () => currentChatId,
});
const mcpServer = createSdkMcpServer({
  name: "cos-tools",
  version: "0.1.0",
  tools: sdkTools,
});

const YT_TRANSCRIBE_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/youtube-transcribe/dist/index.js";
const EXCHANGE_RATE_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/exchange-rate-bolivia/dist/index.js";
const NAABOL_FLIGHTS_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/naabol-flights/dist/index.js";
const FEEDBIN_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/feedbin/dist/index.js";
const HEALTH_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/health/dist/index.js";
const APPLE_REMINDERS_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/apple-reminders/dist/index.js";
const AGENT_LEARNINGS_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/agent-learnings/dist/index.js";
const COMBUSTIBLE_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/combustible/dist/index.js";

const BASE_OPTIONS: Options = {
  systemPrompt: SYSTEM_PROMPT + buildLearningsSection(LEARNINGS_PATH),
  mcpServers: {
    "cos-tools": mcpServer,
    // External stdio MCPs — el SDK librería NO lee ~/.claude/.mcp.json automáticamente,
    // hay que registrar custom MCPs aquí explícitamente.
    "youtube-transcribe": {
      type: "stdio",
      command: "node",
      args: [YT_TRANSCRIBE_DIST],
    },
    "exchange-rate-bolivia": {
      type: "stdio",
      command: "node",
      args: [EXCHANGE_RATE_DIST],
    },
    "naabol-flights": {
      type: "stdio",
      command: "node",
      args: [NAABOL_FLIGHTS_DIST],
    },
    "feedbin": {
      type: "stdio",
      command: "node",
      args: [FEEDBIN_DIST],
      env: {
        FEEDBIN_USERNAME: env.FEEDBIN_USERNAME,
        FEEDBIN_PASSWORD: env.FEEDBIN_PASSWORD,
      },
    },
    "health": {
      type: "stdio",
      command: "node",
      args: [HEALTH_DIST],
      env: { HEALTH_API_KEY: env.HEALTH_API_KEY },
    },
    "apple-reminders": {
      type: "stdio",
      command: "node",
      args: [APPLE_REMINDERS_DIST],
    },
    "agent-learnings": {
      type: "stdio",
      command: "node",
      args: [AGENT_LEARNINGS_DIST],
    },
    "combustible": {
      type: "stdio",
      command: "node",
      args: [COMBUSTIBLE_DIST],
    },
  },
  allowedTools: [...sdkTools.map((t) => `mcp__cos-tools__${t.name}`), ...CLAUDE_AI_COS_TOOLS],
  disallowedTools: DISALLOWED_BUILTINS,
  maxTurns: 12,
  model: "claude-sonnet-4-6",
};

// NOT using a warm pool. Pecunia v2 / Vesta v2 documented "Warm pool stale rompe
// MCP custom" — if we reuse a WarmQuery prefetched from a previous startup(),
// the in-process MCP server gets unregistered when the handle is consumed.
// Fix: fresh startup() per invocation. Cost ~3-5s per turn, tools register reliably.
async function takeWarm(): Promise<WarmQuery> {
  const t0 = Date.now();
  try {
    const warm = await startup({ options: BASE_OPTIONS });
    log({ msg: "warm_startup", ms: Date.now() - t0 });
    return warm;
  } catch (err) {
    log({ msg: "warm_startup_error", err: String(err) });
    throw err;
  }
}

async function processVoice(token: string, fileId: string): Promise<string | null> {
  try {
    const file = await downloadTelegramFile(token, fileId);
    const text = await transcribeAudio(file.path, "es", env.ELEVENLABS_API_KEY || undefined);
    log({ msg: "voice_transcribed", stt: env.ELEVENLABS_API_KEY ? "elevenlabs" : "whisper", chars: text.length, preview: text.slice(0, 80) });
    return text;
  } catch (err) {
    log({ msg: "voice_transcribe_error", err: String(err) });
    return null;
  }
}

async function processPhoto(
  token: string,
  fileId: string,
  caption: string | undefined,
  apiKey: string,
): Promise<string | null> {
  try {
    const file = await downloadTelegramFile(token, fileId);
    const analysis = await analyzePhoto({
      apiKey,
      imagePath: file.path,
      mimeType: file.mimeType,
      caption,
      task: "describe",
    });
    log({ msg: "photo_analyzed", chars: analysis.text.length });
    return analysis.text;
  } catch (err) {
    log({ msg: "photo_analyze_error", err: String(err) });
    return null;
  }
}

async function processDocument(
  token: string,
  doc: { file_id: string; file_name?: string; mime_type?: string; file_size?: number },
  caption: string | undefined,
): Promise<string | null> {
  try {
    const file = await downloadTelegramFile(token, doc.file_id);
    const mime = doc.mime_type ?? file.mimeType ?? "";
    const name = (doc.file_name ?? "").toLowerCase();

    let text: string | null = null;

    if (mime.includes("pdf") || name.endsWith(".pdf")) {
      const require = createRequire(import.meta.url);
      const { PDFParse } = require("pdf-parse") as { PDFParse: new (opts: { data: Uint8Array }) => { getText(): Promise<{ text: string }> } };
      const { readFile } = await import("node:fs/promises");
      const buf = await readFile(file.path);
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      const data = await parser.getText();
      text = data.text;
    } else if (
      mime.includes("wordprocessingml") ||
      mime.includes("msword") ||
      name.endsWith(".docx") ||
      name.endsWith(".doc")
    ) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ path: file.path });
      text = result.value;
    }

    // Clean up temp file
    const { unlink } = await import("node:fs/promises");
    await unlink(file.path).catch(() => {});

    if (!text?.trim()) return null;

    const MAX = 50_000;
    if (text.length > MAX) {
      text = text.slice(0, MAX) + "\n\n[... documento truncado a 50.000 caracteres ...]";
    }
    log({ msg: "document_extracted", chars: text.length, mime, fileName: doc.file_name });
    return text.trim();
  } catch (err) {
    log({ msg: "document_process_error", err: String(err) });
    return null;
  }
}

async function processMessage(payload: TelegramUpdate, queueWaitMs: number): Promise<void> {
  if (!payload.message && !payload.callback_query) {
    log({ msg: "skip_unsupported_update", update_id: payload.update_id });
    return;
  }

  // Heavy callbacks: por ahora pasamos el data como mensaje para que el agent
  // lo interprete (ej. task:date:<pageId>, task:change:<pageId>). Phase futura
  // puede agregar lógica específica.
  if (payload.callback_query) {
    const cb = payload.callback_query;
    if (!cb.message) {
      log({ msg: "callback_no_message", data: cb.data });
      return;
    }
    log({ msg: "heavy_callback_received", data: cb.data });
    // Por simplicidad, procesamos como un mensaje sintético en el chat de origen
    const synthetic: TelegramUpdate = {
      update_id: payload.update_id,
      message: {
        ...cb.message,
        text: `[callback] ${cb.data ?? ""}`,
        from: cb.from ? { id: cb.from.id, first_name: cb.from.first_name } : undefined,
      },
    };
    await processMessage(synthetic, queueWaitMs);
    return;
  }

  const m = payload.message!;
  const chatId = m.chat.id;
  const chatType = m.chat.type;
  currentChatId = chatId;

  let text = m.text;
  const caption = m.caption;
  const voice = m.voice;
  const photo = m.photo && m.photo.length > 0 ? m.photo[m.photo.length - 1] : undefined;
  const document = m.document;
  const location = m.location;

  // Pasar coordenadas al agent — él decide qué hacer según el contexto
  if (location && !text) {
    text = `[ubicación GPS compartida: lat=${location.latitude}, lon=${location.longitude}]${caption ? ` — ${caption}` : ""}`;
  } else if (location && text) {
    text = `[ubicación GPS: lat=${location.latitude}, lon=${location.longitude}] ${text}`;
  }

  if (!text && !voice && !photo && !document) {
    log({ msg: "skip_message", reason: "unsupported kind", update_id: payload.update_id });
    return;
  }

  // /reset command
  if (text && text.trim().toLowerCase() === "/reset") {
    await state.clear(chatId);
    await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, {
      chatId,
      text: "🧹 Contexto limpiado.",
    });
    return;
  }

  // Typing indicator + placeholder en <1s
  const initialAction: ChatAction = voice ? "typing" : photo ? "upload_photo" : document ? "upload_document" : "typing";
  void sendChatAction(env.COS_TELEGRAM_BOT_TOKEN, chatId, initialAction);
  const typingInterval = setInterval(() => {
    void sendChatAction(env.COS_TELEGRAM_BOT_TOKEN, chatId, "typing");
  }, 4000);

  const initialPlaceholder = voice
    ? "🎤 Transcribiendo audio..."
    : photo
      ? "📸 Mirando foto..."
      : document
        ? "📄 Leyendo documento..."
        : "⏳ Pensando...";
  const placeholder = await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, {
    chatId,
    text: initialPlaceholder,
  });
  const placeholderMsgId = placeholder.message_id;

  let voiceTranscript: string | undefined;

  try {
    // Multimodal preprocessing
    let contextHeader: string | undefined;
    if (voice) {
      const transcript = await processVoice(env.COS_TELEGRAM_BOT_TOKEN, voice.file_id);
      if (!transcript) {
        await editMessage(
          env.COS_TELEGRAM_BOT_TOKEN,
          chatId,
          placeholderMsgId,
          "⚠️ <b>No pude transcribir el audio</b>\nReintenta o escríbelo, por favor.",
          "HTML",
        );
        return;
      }
      text = transcript;
      voiceTranscript = transcript;
      contextHeader = `(Audio transcrito) chat_type=${chatType}`;
      await editMessage(
        env.COS_TELEGRAM_BOT_TOKEN,
        chatId,
        placeholderMsgId,
        `🎤 <i>"${escapeHtml(transcript)}"</i>\n\n⏳ Procesando...`,
        "HTML",
      );
    } else if (photo) {
      const analysis = await processPhoto(env.COS_TELEGRAM_BOT_TOKEN, photo.file_id, caption, env.ANTHROPIC_API_KEY);
      if (!analysis) {
        await editMessage(
          env.COS_TELEGRAM_BOT_TOKEN,
          chatId,
          placeholderMsgId,
          "⚠️ <b>No pude leer la foto</b>\nReenvíala, por favor.",
          "HTML",
        );
        return;
      }
      text = caption ? `${caption}\n\n[Foto adjunta — análisis: ${analysis}]` : `[Foto adjunta — análisis: ${analysis}]`;
      contextHeader = `(Foto recibida — análisis ya hecho) chat_type=${chatType}`;
    } else if (document) {
      const docText = await processDocument(env.COS_TELEGRAM_BOT_TOKEN, document, caption);
      if (!docText) {
        await editMessage(
          env.COS_TELEGRAM_BOT_TOKEN,
          chatId,
          placeholderMsgId,
          "⚠️ <b>No pude leer el documento</b>\nFormato no soportado o archivo corrupto.",
          "HTML",
        );
        return;
      }
      const label = document.file_name ?? "documento";
      text = caption
        ? `${caption}\n\n[Documento adjunto: ${label}]\n\n${docText}`
        : `[Documento adjunto: ${label}]\n\n${docText}`;
      contextHeader = `(Documento adjunto leído — texto ya extraído) chat_type=${chatType}`;
    } else {
      contextHeader = `chat_type=${chatType}`;
    }

    if (!text) {
      log({ msg: "no_text_after_preprocessing", chatId });
      return;
    }

    // Keyword-triggered TTS: prefijo 🎤 o "en audio"/"en voz" en el texto
    let wantsVoice = false;
    if (env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID) {
      if (text.trimStart().startsWith("🎤")) {
        wantsVoice = true;
        text = text.replace(/^\s*🎤\s*/, "").trim();
      } else if (/\ben (audio|voz)\b/i.test(text)) {
        wantsVoice = true;
        text = text.replace(/\s*\ben (audio|voz)\b\s*/gi, " ").trim();
      }
    }
    if (wantsVoice) {
      contextHeader = (contextHeader ?? "") +
        "\n[MODO AUDIO: responde en estilo conversacional hablado. Usa horas naturales (di '8 de la mañana', no '08:00'). Sin bullets, sin asteriscos, sin formato visual. Frases cortas y fluidas, máx 4 oraciones. Habla como si estuvieras conversando, con la personalidad de Jano.]";
    }

    const t0 = Date.now();
    const history = await state.load(chatId);
    const kvLoadMs = Date.now() - t0;

    const t1 = Date.now();
    const warm = await takeWarm();
    const warmAcquireMs = Date.now() - t1;

    log({
      msg: "agent_run_start",
      chatId,
      chatType,
      historyLen: history.length,
      queueWaitMs,
      kvLoadMs,
      warmAcquireMs,
    });

    try {
      const t2 = Date.now();
      const { reply, sdkMs, firstEventMs } = await runAgent(text, { warm, history, contextHeader });
      const totalAgentMs = Date.now() - t2;

      const t3 = Date.now();
      if (wantsVoice) {
        try {
          const { textToVoiceOgg } = await import("./tools/tts.js");
          const ogg = await textToVoiceOgg(reply, env.ELEVENLABS_API_KEY, env.ELEVENLABS_VOICE_ID);
          await deleteMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId).catch(() => {});
          await sendVoice(env.COS_TELEGRAM_BOT_TOKEN, chatId, ogg);
          log({ msg: "tts_sent", chatId, replyLen: reply.length });
        } catch (ttsErr) {
          log({ msg: "tts_error", chatId, err: String(ttsErr) });
          await editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId, reply, "HTML").catch(() =>
            editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId, reply, null),
          );
        }
      } else {
        try {
          await editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId, reply, "HTML");
        } catch (parseErr) {
          log({ msg: "html_parse_failed", err: String(parseErr) });
          await editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId, reply, null);
        }
      }
      const sendMs = Date.now() - t3;

      const t4 = Date.now();
      await state.append(chatId, { role: "user", content: text });
      await state.append(chatId, { role: "assistant", content: reply });
      const stateSaveMs = Date.now() - t4;

      log({
        msg: "agent_run_done",
        chatId,
        replyLen: reply.length,
        timing: { queueWaitMs, kvLoadMs, warmAcquireMs, sdkMs, firstEventMs, totalAgentMs, sendMs, stateSaveMs, totalMs: Date.now() - t0 },
      });
    } catch (err) {
      log({ msg: "agent_error", chatId, err: String(err) });
      await editMessage(
        env.COS_TELEGRAM_BOT_TOKEN,
        chatId,
        placeholderMsgId,
        "⚠️ <b>No pude procesar tu mensaje</b>\nHubo un error interno. Intenta de nuevo o usa <code>/reset</code>.",
        "HTML",
      );
    }
  } finally {
    clearInterval(typingInterval);
  }
}

async function ensureWebhook(): Promise<void> {
  if (!env.COS_WEBHOOK_SECRET || !env.COS_WEBHOOK_URL) return;
  try {
    const info = await fetch(`https://api.telegram.org/bot${env.COS_TELEGRAM_BOT_TOKEN}/getWebhookInfo`).then((r) =>
      r.json() as Promise<{ ok: boolean; result?: { url?: string } }>,
    );
    const currentUrl = info.result?.url ?? "";
    if (currentUrl === env.COS_WEBHOOK_URL) return;
    log({ msg: "webhook_drift_detected", currentUrl, expected: env.COS_WEBHOOK_URL });
    const res = await fetch(`https://api.telegram.org/bot${env.COS_TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: env.COS_WEBHOOK_URL,
        secret_token: env.COS_WEBHOOK_SECRET,
        drop_pending_updates: false,
        allowed_updates: ["message", "callback_query", "edited_message"],
      }),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (data.ok) {
      log({ msg: "webhook_restored" });
    } else {
      log({ msg: "webhook_restore_failed", err: data.description });
    }
  } catch (err) {
    log({ msg: "webhook_check_error", err: String(err) });
  }
}

function scheduleWebhookWatchdog(): void {
  cron.schedule("* * * * *", () => {
    void ensureWebhook();
  }, { timezone: "America/La_Paz" });
  log({ msg: "webhook_watchdog_scheduled", interval: "1min" });
}

async function loop(): Promise<void> {
  const poller = new QueuePoller({
    accountId: env.CF_ACCOUNT_ID,
    queueId: env.CF_QUEUE_ID,
    apiToken: env.CF_API_TOKEN,
  });

  scheduleWebhookWatchdog();
  void ensureWebhook();

  log({ msg: "cos-daemon-v2 ready", queueId: env.CF_QUEUE_ID });

  let lastMessageAt = 0;
  let consecutiveErrors = 0;
  let alertedThisEpisode = false;

  while (true) {
    try {
      const pollStart = Date.now();
      const messages = await poller.pull(10);
      heartbeat();

      if (consecutiveErrors > 0) {
        if (alertedThisEpisode) {
          await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, {
            chatId: ALERT_CHAT_ID,
            text: `✅ CoS recuperado después de ${consecutiveErrors} errores consecutivos.`,
          }).catch(() => {});
        }
        log({ msg: "loop_recovered", consecutiveErrors });
        consecutiveErrors = 0;
        alertedThisEpisode = false;
      }

      if (messages.length === 0) {
        const idleMs = Date.now() - lastMessageAt;
        const sleepMs = idleMs < 30_000 ? 50 : idleMs < 120_000 ? 800 : 2000;
        await sleep(sleepMs);
        continue;
      }

      const queueWaitMs = Date.now() - pollStart;
      lastMessageAt = Date.now();

      const acks: string[] = [];
      for (const { leaseId, body } of messages) {
        const msg = body as QueueMessage;
        if (msg.kind === "telegram_update") {
          try {
            await processMessage(msg.payload as TelegramUpdate, queueWaitMs);
            acks.push(leaseId);
          } catch (err) {
            log({ msg: "process_error", err: String(err), leaseId });
          }
        } else {
          log({ msg: "skip_kind", kind: msg.kind });
          acks.push(leaseId);
        }
      }

      if (acks.length) await poller.ack(acks);
    } catch (err) {
      consecutiveErrors++;
      const backoffMs = Math.min(BACKOFF_MAX_MS, 5000 * Math.pow(2, consecutiveErrors - 1));
      log({ msg: "loop_error", err: String(err), consecutiveErrors, backoffMs });

      if (consecutiveErrors >= ALERT_THRESHOLD && !alertedThisEpisode) {
        alertedThisEpisode = true;
        const errPreview = String(err).slice(0, 200);
        await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, {
          chatId: ALERT_CHAT_ID,
          text: `⚠️ CoS: ${consecutiveErrors} errores seguidos en CF Queue.\n\nÚltimo: ${errPreview}\n\nEntrando en backoff. Te aviso cuando se recupere.`,
        }).catch(() => {});
      }

      await sleep(backoffMs);
    }
  }
}

loop().catch((err) => {
  log({ msg: "fatal", err: String(err) });
  process.exit(1);
});
