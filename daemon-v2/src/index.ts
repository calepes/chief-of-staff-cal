import { writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import cron from "node-cron";
import { createSdkMcpServer, startup, type Options, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { runAgent } from "./agent.js";
import { buildSdkTools } from "./agent-tools.js";
import { CLAUDE_AI_COS_TOOLS, DISALLOWED_BUILTINS } from "./agent-options.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { buildLearningsSection } from "./learnings.js";
import { compactHistory } from "./compact.js";
import { sanitizeForTelegram } from "./format.js";
import { QueuePoller } from "./queue-poller.js";
import { CfKv } from "./cf-kv.js";
import { ConversationState } from "./state.js";
import { sendMessage, editMessage, sendChatAction, sendVoice, deleteMessage, answerCallbackQuery, type ChatAction } from "@cos/shared";
import type { TelegramUpdate, QueueMessage } from "@cos/shared";
import { checkFlightCheckin } from "./proactive/flight-checkin.js";
import { scheduleFocoCheckins } from "./proactive/foco-check.js";
import { downloadTelegramFile } from "./tools/telegram-files.js";
import { transcribeAudio } from "./tools/whisper.js";
import { analyzePhoto, analyzePdf } from "./tools/vision.js";
import { buildMainMenu, handleMenuCallback } from "./menu.js";

loadEnv({ path: `${process.env.HOME}/.cos-agent/.env` });
loadEnv({ path: `${process.env.HOME}/.claude/secrets/apps.env` });

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
  SERPAPI_KEY: process.env.SERPAPI_KEY ?? "",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  READWISE_TOKEN: process.env.READWISE_TOKEN ?? "",
  KUBERA_AUTH_TOKEN: process.env.KUBERA_AUTH_TOKEN ?? "",
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN ?? "",
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID ?? "",
  COS_WEBHOOK_URL: process.env.COS_WEBHOOK_URL ?? "https://cos-agent-worker.carlos-cb4.workers.dev/telegram/webhook",
  COS_WEBHOOK_SECRET: process.env.COS_WEBHOOK_SECRET ?? "",
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY ?? "",
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID ?? "",
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY ?? "",
  HOME_PIN: process.env.HOME_PIN ?? "",
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
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

const TG_MAX = 4096;

// Splits text into chunks ≤ maxLen, preferring paragraph/line/word boundaries.
function chunkText(text: string, maxLen = TG_MAX): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= maxLen) { chunks.push(rem); break; }
    let cut = maxLen;
    const para = rem.lastIndexOf("\n\n", maxLen);
    if (para > maxLen / 2) { cut = para + 2; }
    else {
      const line = rem.lastIndexOf("\n", maxLen);
      if (line > maxLen / 2) { cut = line + 1; }
      else {
        const space = rem.lastIndexOf(" ", maxLen);
        if (space > maxLen / 2) { cut = space + 1; }
      }
    }
    chunks.push(rem.slice(0, cut).trimEnd());
    rem = rem.slice(cut).trimStart();
  }
  return chunks.filter(Boolean);
}

/**
 * Genera una línea de contexto de fecha/hora en runtime con timezone America/La_Paz.
 * Se inyecta al inicio de cada turno para evitar que el LLM infiera la fecha
 * desde el historial cacheado (que puede tener referencias de turnos del día anterior).
 */
function runtimeDateContext(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("es-BO", {
    timeZone: "America/La_Paz",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `[Fecha y hora actual: ${fmt.format(now)} (America/La_Paz, UTC-4)]`;
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
  gmapsApiKey: env.GOOGLE_MAPS_API_KEY || undefined,
  homePin: env.HOME_PIN || undefined,
  kv,
  getOptions: () => BASE_OPTIONS,
});

// sdkTools is shared (pure function handlers pointing to stable shared state).
// mcpServer must be created fresh per startup() call — the SDK deregisters the
// in-process MCP server when the WarmQuery is consumed, so a single shared
// mcpServer instance breaks concurrent agents ("No such tool available").
// We expose a factory and call it inside takeWarm() to get an isolated instance.
function createFreshMcpServer() {
  return createSdkMcpServer({
    name: "cos-tools",
    version: "0.1.0",
    tools: sdkTools,
  });
}

const YT_TRANSCRIBE_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/youtube-transcribe/dist/index.js";
const EXCHANGE_RATE_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/exchange-rate-bolivia/dist/index.js";
const NAABOL_FLIGHTS_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/naabol-flights/dist/index.js";
const MCP_REMOTE = "/Users/calepes/.npm-global/bin/mcp-remote";
const HEALTH_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/health/dist/index.js";
const APPLE_REMINDERS_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/apple-reminders/dist/index.js";
const AGENT_LEARNINGS_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/agent-learnings/dist/index.js";
const COMBUSTIBLE_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/combustible/dist/index.js";
const SERPAPI_FLIGHTS_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/serpapi-flights/dist/index.js";
const APPLE_NOTES_BIN =
  "/Users/calepes/.npm-global/lib/node_modules/apple-notes-mcp/build/index.js";
const INVERSIONES_QUERY_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/inversiones-query/dist/index.js";
const SPARK_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/spark/dist/index.js";
const ACHORADAZOS_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/achoradazos/dist/index.js";

const BASE_OPTIONS: Options = {
  systemPrompt: SYSTEM_PROMPT + buildLearningsSection(LEARNINGS_PATH),
  mcpServers: {
    // "cos-tools" is NOT here — injected fresh per startup() call in takeWarm()
    // to avoid shared MCP server deregistration issues with concurrent agents.
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
      command: MCP_REMOTE,
      args: ["https://mcp-feedbin.carlos-cb4.workers.dev/mcp"],
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
    "serpapi-flights": {
      type: "stdio",
      command: "node",
      args: [SERPAPI_FLIGHTS_DIST],
      env: { SERPAPI_KEY: env.SERPAPI_KEY },
    },
    "apple-notes": {
      type: "stdio",
      command: "node",
      args: [APPLE_NOTES_BIN],
    },
    "inversiones-query": {
      type: "stdio",
      command: "node",
      args: [INVERSIONES_QUERY_DIST],
      env: {
        KUBERA_AUTH_TOKEN: env.KUBERA_AUTH_TOKEN,
        AIRTABLE_TOKEN: env.AIRTABLE_TOKEN,
        AIRTABLE_BASE_ID: env.AIRTABLE_BASE_ID,
      },
    },
    "spark": {
      type: "stdio",
      command: "node",
      args: [SPARK_DIST],
    },
    "achoradazos": {
      type: "stdio",
      command: "node",
      args: [ACHORADAZOS_DIST],
      env: { AIRTABLE_TOKEN: env.AIRTABLE_TOKEN },
    },
    // Readwise MCP remoto — bridge stdio via mcp-remote
    "readwise": {
      type: "stdio",
      command: "/Users/calepes/.npm-global/bin/mcp-remote",
      args: [
        "https://mcp2.readwise.io/mcp",
        "--header",
        `Authorization: Token ${process.env.READWISE_TOKEN}`,
      ],
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
//
// Fresh mcpServer per startup(): the in-process cos-tools MCP server is deregistered
// when the WarmQuery is consumed. Sharing one instance across concurrent agents causes
// "No such tool available" errors. Fix: create a new mcpServer per takeWarm() call so
// each agent gets an isolated server lifecycle.
async function takeWarm(): Promise<WarmQuery> {
  const t0 = Date.now();
  const options: Options = {
    ...BASE_OPTIONS,
    mcpServers: {
      ...BASE_OPTIONS.mcpServers,
      "cos-tools": createFreshMcpServer(),
    },
  };
  try {
    const warm = await startup({ options });
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
): Promise<{ analysis: string; localPath: string } | null> {
  try {
    const file = await downloadTelegramFile(token, fileId);
    const result = await analyzePhoto({
      imagePath: file.path,
      mimeType: file.mimeType,
      caption,
      task: "describe",
    });
    log({ msg: "photo_analyzed", chars: result.text.length, path: file.path });
    // No borramos el archivo — el agente puede necesitarlo para uploadReceipt
    return { analysis: result.text, localPath: file.path };
  } catch (err) {
    log({ msg: "photo_analyze_error", err: String(err) });
    return null;
  }
}

async function processDocument(
  token: string,
  doc: { file_id: string; file_name?: string; mime_type?: string; file_size?: number },
  caption: string | undefined,
  onStatus?: (msg: string) => void,
): Promise<{ text: string; localPath?: string } | null> {
  try {
    const file = await downloadTelegramFile(token, doc.file_id);
    const mime = doc.mime_type ?? file.mimeType ?? "";
    const name = (doc.file_name ?? "").toLowerCase();
    const { unlink } = await import("node:fs/promises");

    // ── Image files sent as document (PNG, JPG, HEIC, WebP, etc.) ──
    if (mime.startsWith("image/")) {
      const result = await analyzePhoto({ imagePath: file.path, mimeType: mime, caption, task: "describe" });
      log({ msg: "document_image_analyzed", chars: result.text.length, mime });
      // Keep file alive — agent may need it for uploadReceipt
      return { text: result.text, localPath: file.path };
    }

    // ── PDF ──────────────────────────────────────────────────────────
    if (mime.includes("pdf") || name.endsWith(".pdf")) {
      // Try text extraction first (works for text-based PDFs)
      let text: string | null = null;
      try {
        const require = createRequire(import.meta.url);
        const pdfParse = require("pdf-parse");
        const { readFile } = await import("node:fs/promises");
        const buf = await readFile(file.path);
        const data = await pdfParse(buf);
        text = data.text?.trim() || null;
      } catch {
        // pdf-parse failed — fall through to vision
      }

      if (!text) {
        // Image-based PDF (scanned) → convert pages to images and OCR with vision
        onStatus?.("🔍 PDF escaneado — leyendo con IA...");
        const result = await analyzePdf({ imagePath: file.path, caption, task: "ocr" });
        text = result.text?.trim() || null;
        log({ msg: "pdf_vision_ocr", chars: text?.length ?? 0 });
      } else {
        const MAX = 50_000;
        if (text.length > MAX) text = text.slice(0, MAX) + "\n\n[... truncado a 50.000 chars ...]";
        log({ msg: "pdf_text_extracted", chars: text.length });
      }

      if (!text) {
        await unlink(file.path).catch(() => {});
        return null;
      }
      // Keep file alive — agent may need it for uploadReceipt
      return { text, localPath: file.path };
    }

    // ── Word / DOCX ──────────────────────────────────────────────────
    if (
      mime.includes("wordprocessingml") ||
      mime.includes("msword") ||
      name.endsWith(".docx") ||
      name.endsWith(".doc")
    ) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ path: file.path });
      const text = result.value?.trim();
      await unlink(file.path).catch(() => {});
      if (!text) return null;
      const MAX = 50_000;
      const truncated = text.length > MAX ? text.slice(0, MAX) + "\n\n[... truncado a 50.000 chars ...]" : text;
      log({ msg: "docx_extracted", chars: truncated.length });
      return { text: truncated };
    }

    await unlink(file.path).catch(() => {});
    return null;
  } catch (err) {
    log({ msg: "document_process_error", err: String(err) });
    return null;
  }
}

async function processMessage(payload: TelegramUpdate, queueWaitMs: number, opts?: { existingPlaceholderId?: number }): Promise<void> {
  if (!payload.message && !payload.callback_query) {
    log({ msg: "skip_unsupported_update", update_id: payload.update_id });
    return;
  }

  // Callbacks de Telegram
  if (payload.callback_query) {
    const cb = payload.callback_query;
    if (!cb.message) {
      log({ msg: "callback_no_message", data: cb.data });
      return;
    }

    // Menú interactivo Jano: callbacks con prefijo "j:" se manejan sin LLM
    // (navegación) o con mensaje sintético en lenguaje natural (acciones).
    if (cb.data?.startsWith("j:")) {
      log({ msg: "menu_callback", data: cb.data });
      await handleMenuCallback(cb, env.COS_TELEGRAM_BOT_TOKEN, processMessage, payload.update_id);
      return;
    }

    // build:approve:<id> / build:reject:<id> — mecánico, sin LLM
    if (cb.data?.startsWith("build:approve:") || cb.data?.startsWith("build:reject:")) {
      const parts = cb.data.split(":");
      const subaction = parts[1]; // "approve" | "reject"
      const id = parts[2];
      const proposalsDir = path.join(process.env.HOME!, ".cos-agent", "morning-builds", "proposals");
      const rejectedDir  = path.join(process.env.HOME!, ".cos-agent", "morning-builds", "rejected");
      const proposalFile = path.join(proposalsDir, `${id}.json`);
      if (subaction === "approve") {
        await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id, "🔨 Ejecutando...");
        await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, { chatId: cb.message.chat.id, text: "🔨 Ejecutando morning build..." });
        const executor = path.join(process.env.HOME!, ".cos-agent", "morning-build-execute.sh");
        spawn("/bin/bash", [executor, id], { detached: true, stdio: "ignore" }).unref();
      } else {
        mkdirSync(rejectedDir, { recursive: true });
        if (existsSync(proposalFile)) renameSync(proposalFile, path.join(rejectedDir, `${id}.json`));
        await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id, "🗑️ Descartado");
        await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, { chatId: cb.message.chat.id, text: "🗑️ Propuesta descartada." });
      }
      return;
    }

    // Heavy callbacks legacy: pasar al agent como mensaje sintético
    log({ msg: "heavy_callback_received", data: cb.data });
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

  // /menu command — envía menú principal interactivo
  if (text && text.trim().toLowerCase() === "/menu") {
    const menu = buildMainMenu();
    await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, {
      chatId,
      text: menu.text,
      parseMode: "HTML",
      replyMarkup: menu.keyboard,
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
  const placeholderMsgId: number = opts?.existingPlaceholderId != null
    ? opts.existingPlaceholderId
    : (await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, { chatId, text: initialPlaceholder })).message_id;

  let voiceTranscript: string | undefined;

  // Fire startup() immediately — runs in parallel with vision/transcription preprocessing.
  // We don't await here; we'll await it only when the agent is ready to run.
  const warmPromise = takeWarm();

  try {
    // Fecha/hora en runtime con tz America/La_Paz — se calcula aquí para que sea
    // siempre el momento exacto del mensaje, nunca cacheado desde turnos anteriores.
    const dateCtx = runtimeDateContext();

    // Multimodal preprocessing
    let contextHeader: string | undefined;
    let photoLocalPath: string | undefined;
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
      contextHeader = `${dateCtx}\n(Audio transcrito) chat_type=${chatType}`;
      await editMessage(
        env.COS_TELEGRAM_BOT_TOKEN,
        chatId,
        placeholderMsgId,
        `🎤 <i>"${escapeHtml(transcript)}"</i>\n\n⏳ Procesando...`,
        "HTML",
      );
    } else if (photo) {
      void editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId, "📸 Analizando foto con IA...").catch(() => {});
      const photoData = await processPhoto(env.COS_TELEGRAM_BOT_TOKEN, photo.file_id, caption);
      if (!photoData) {
        await editMessage(
          env.COS_TELEGRAM_BOT_TOKEN,
          chatId,
          placeholderMsgId,
          "⚠️ <b>No pude leer la foto</b>\nReenvíala, por favor.",
          "HTML",
        );
        return;
      }
      photoLocalPath = photoData.localPath;
      text = caption
        ? `${caption}\n\n[Foto adjunta — análisis: ${photoData.analysis}]`
        : `[Foto adjunta — análisis: ${photoData.analysis}]`;
      contextHeader = `${dateCtx}\n(Foto recibida — análisis ya hecho) chat_type=${chatType}\nfoto_local_path=${photoData.localPath}`;
    } else if (document) {
      const mime = document.mime_type ?? "";
      const isPdf = mime.includes("pdf") || (document.file_name ?? "").toLowerCase().endsWith(".pdf");
      const isImg = mime.startsWith("image/");
      const statusMsg = isPdf ? "📄 Leyendo PDF..." : isImg ? "🖼️ Analizando imagen con IA..." : "📄 Extrayendo texto del documento...";
      void editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId, statusMsg).catch(() => {});
      const docResult = await processDocument(
        env.COS_TELEGRAM_BOT_TOKEN, document, caption,
        (msg) => void editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId, msg).catch(() => {}),
      );
      if (!docResult) {
        await editMessage(
          env.COS_TELEGRAM_BOT_TOKEN,
          chatId,
          placeholderMsgId,
          "⚠️ <b>No pude leer el documento</b>\nFormato no soportado o archivo corrupto.",
          "HTML",
        );
        return;
      }
      if (docResult.localPath) photoLocalPath = docResult.localPath;
      const label = document.file_name ?? "documento";
      const docText = docResult.text;
      text = caption
        ? `${caption}\n\n[Documento adjunto: ${label}]\n\n${docText}`
        : `[Documento adjunto: ${label}]\n\n${docText}`;
      contextHeader = docResult.localPath
        ? `${dateCtx}\n(Documento adjunto analizado) chat_type=${chatType}\nfoto_local_path=${docResult.localPath}`
        : `${dateCtx}\n(Documento adjunto leído — texto ya extraído) chat_type=${chatType}`;
    } else {
      contextHeader = `${dateCtx}\nchat_type=${chatType}`;
    }

    if (!text) {
      log({ msg: "no_text_after_preprocessing", chatId });
      return;
    }

    // Keyword-triggered TTS: prefijo 🎤 o frases de audio/voz en el texto
    let wantsVoice = false;
    if (env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID) {
      if (text.trimStart().startsWith("🎤")) {
        wantsVoice = true;
        text = text.replace(/^\s*🎤\s*/, "").trim();
      } else if (/\b(?:en|como|de forma|de manera)\s+(?:audio|voz)\b|l[ée]emelo|cu[eé]ntamelo\b/i.test(text)) {
        wantsVoice = true;
        text = text.replace(/\s*\b(?:en|como|de forma|de manera)\s+(?:audio|voz)\b\s*/gi, " ").trim();
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
    const warm = await warmPromise;
    const warmAcquireMs = Date.now() - t1;

    void editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId, "💭 Pensando...").catch(() => {});

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
      const { reply: rawReply, sdkMs, firstEventMs } = await runAgent(text, {
        warm,
        history,
        contextHeader,
        onProgress: async (progressText) => {
          await editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId, progressText).catch(() => {});
        },
      });
      // Safety net: convert Markdown → HTML before sending and storing.
      const reply = wantsVoice ? rawReply : sanitizeForTelegram(rawReply);
      const totalAgentMs = Date.now() - t2;

      // Limpiar el archivo temporal de la foto una vez que el agente terminó
      if (photoLocalPath) {
        const { unlink } = await import("node:fs/promises");
        await unlink(photoLocalPath).catch(() => {});
      }

      const t3 = Date.now();
      if (wantsVoice) {
        try {
          const { textToVoiceOggChunks } = await import("./tools/tts.js");
          const oggs = await textToVoiceOggChunks(reply, env.ELEVENLABS_API_KEY, env.ELEVENLABS_VOICE_ID);
          await deleteMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId).catch(() => {});
          for (const ogg of oggs) {
            await sendVoice(env.COS_TELEGRAM_BOT_TOKEN, chatId, ogg);
          }
          log({ msg: "tts_sent", chatId, replyLen: reply.length, chunks: oggs.length });
        } catch (ttsErr) {
          log({ msg: "tts_error", chatId, err: String(ttsErr) });
          const textChunks = chunkText(reply);
          for (let i = 0; i < textChunks.length; i++) {
            const chunk = textChunks[i];
            if (i === 0) {
              await editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId, chunk, "HTML").catch(() =>
                editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId, chunk, null),
              );
            } else {
              await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, { chatId, text: chunk, parseMode: "HTML" }).catch(() =>
                sendMessage(env.COS_TELEGRAM_BOT_TOKEN, { chatId, text: chunk }).catch(() => {}),
              );
            }
          }
        }
      } else if (!reply) {
        // LLM devolvió vacío — las tools ya manejaron el output (showMeetingCards, buildApprovalFlow, etc.)
        await deleteMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId).catch(() => {});
      } else {
        const chunks = chunkText(reply);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (i === 0) {
            try {
              await editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId, chunk, "HTML");
            } catch (parseErr) {
              log({ msg: "html_parse_failed", err: String(parseErr) });
              await editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, placeholderMsgId, chunk, null);
            }
          } else {
            try {
              await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, { chatId, text: chunk, parseMode: "HTML" });
            } catch {
              await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, { chatId, text: chunk }).catch(() => {});
            }
          }
        }
      }
      const sendMs = Date.now() - t3;

      const t4 = Date.now();
      await state.append(chatId, { role: "user", content: text });
      if (reply) await state.append(chatId, { role: "assistant", content: reply });
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
    const info = await fetch(`https://api.telegram.org/bot${env.COS_TELEGRAM_BOT_TOKEN}/getWebhookInfo`, { signal: AbortSignal.timeout(10_000) }).then((r) =>
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
      signal: AbortSignal.timeout(10_000),
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

function scheduleFlightCheckin(): void {
  cron.schedule("0,30 7-22 * * *", () => {
    void checkFlightCheckin({
      kv,
      botToken: env.COS_TELEGRAM_BOT_TOKEN,
      chatId: ALERT_CHAT_ID,
      takeWarm,
    });
  }, { timezone: "America/La_Paz" });
  log({ msg: "flight_checkin_scheduled", interval: "every 30min 7-22h" });
}

function scheduleFocoCheckinsLocal(): void {
  scheduleFocoCheckins({
    kv,
    botToken: env.COS_TELEGRAM_BOT_TOKEN,
    chatId: ALERT_CHAT_ID,
    takeWarm,
    setCurrentChatId: (id) => {
      currentChatId = id;
    },
  });
}

async function registerBotCommands(token: string): Promise<void> {
  const commands = [
    { command: "menu", description: "Menú principal" },
    { command: "reset", description: "Limpiar contexto" },
  ];
  const scopes = [
    {},
    { scope: { type: "all_private_chats" } },
  ];
  try {
    for (const scope of scopes) {
      const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands, ...scope }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as { ok: boolean; description?: string };
      if (!data.ok) {
        log({ msg: "bot_commands_failed", scope: JSON.stringify(scope), err: data.description });
      }
    }
    log({ msg: "bot_commands_registered" });
  } catch (err) {
    log({ msg: "bot_commands_error", err: String(err) });
  }
}

async function loop(): Promise<void> {
  const poller = new QueuePoller({
    accountId: env.CF_ACCOUNT_ID,
    queueId: env.CF_QUEUE_ID,
    apiToken: env.CF_API_TOKEN,
  });

  scheduleWebhookWatchdog();
  scheduleFlightCheckin();
  scheduleFocoCheckinsLocal();
  void ensureWebhook();
  void registerBotCommands(env.COS_TELEGRAM_BOT_TOKEN);

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
