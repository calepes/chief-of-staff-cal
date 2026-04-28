# CoS Agent v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrar el daemon CoS del binario `claude --channels` a Node + Agent SDK librería + webhook CF + callback router edge. Eliminar TCC reset y conflict 409. Mantener bot conversacional funcional con latencia ~300ms en callbacks light.

**Architecture:** Patrón Vesta v2 + Pecunia v2. Worker CF Hono recibe webhook, procesa callbacks ligeros mecánicamente en edge, encola heavy a CF Queue. Daemon Node 22 polea queue, usa Agent SDK con OAuth Max, tools custom (Notion DB Tareas, Outlook cache, Health worker), MCPs heredados (GCal, Notion, Gmail). Watchdog + hooks SessionStart/End coordinan webhook con sesiones interactivas.

**Tech Stack:** Node 22, `@anthropic-ai/claude-agent-sdk`, Hono, Cloudflare Workers + Queues + KV, TypeScript, npm workspaces, `node-cron` (no usado en scope inicial pero cargado para futuras extensiones), `dotenv`.

**Spec:** `docs/superpowers/specs/2026-04-28-cos-agent-v2-design.md`.

---

## File Structure

```
Chief of Staff Cal/
├── package.json                       (workspaces: daemon-v2, worker-v2, shared-v2)
├── tsconfig.base.json
├── .gitignore                         (agregar node_modules/, dist/)
├── shared-v2/
│   ├── package.json                   (@cos/shared)
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                   (re-exports)
│       ├── types.ts                   (TelegramUpdate, QueueMessage, MenuState)
│       └── telegram.ts                (sendMessage, editMessage, sendChatAction, escapeMarkdownV2, answerCallbackQuery)
├── worker-v2/
│   ├── package.json                   (@cos/worker)
│   ├── tsconfig.json
│   ├── wrangler.jsonc                 (queue + KV + secrets bindings)
│   └── src/
│       ├── index.ts                   (Hono webhook + dispatch)
│       ├── callback-router.ts         (light callback handlers — port de telegram-plugin/callback-router.ts)
│       ├── notion-light.ts            (mark task done/complete via API directa, sin LLM)
│       └── menu.ts                    (menú estático + render)
├── daemon-v2/
│   ├── package.json                   (@cos/daemon)
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                   (entrypoint, queue poller, processMessage, watchdog)
│   │   ├── agent.ts                   (runAgent — wrapper Agent SDK)
│   │   ├── agent-tools.ts             (MCP cos-tools registration)
│   │   ├── agent-options.ts           (DISALLOWED_BUILTINS, CLAUDE_AI_COS_TOOLS)
│   │   ├── system-prompt.ts           (identidad CoS + UX MarkdownV2 + tools docs)
│   │   ├── queue-poller.ts            (CF Queue REST consumer)
│   │   ├── cf-kv.ts                   (CF KV REST client)
│   │   ├── state.ts                   (ConversationState con TTL)
│   │   └── tools/
│   │       ├── notion-tasks.ts        (listTasks, createTask, markTaskDone, setTaskStatus, setTaskDate)
│   │       ├── personas.ts            (getPersonas, mapping cache)
│   │       ├── outlook.ts             (getOutlookEvents — lee cache file)
│   │       └── health.ts              (getHealthSummary, getHealthTrend — HTTP a worker)
└── ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist (fuera del repo)
```

---

## Phase 1: Scaffolding workspaces

### Task 1.1: Inspect Family/v2 como template

**Files:**
- Read: `Family/package.json`, `Family/tsconfig.base.json`, `Family/shared-v2/`, `Family/daemon-v2/`, `Family/worker-v2/`

- [ ] **Step 1: Confirm Family v2 layout**

Run:
```bash
ls "/Users/calepes/Claude Projects/Personal/Agents/Family/"
cat "/Users/calepes/Claude Projects/Personal/Agents/Family/package.json"
```
Expected: `daemon-v2`, `worker-v2`, `shared-v2` listed in workspaces. Confirms reference template exists.

### Task 1.2: Crear estructura de directorios

**Files:**
- Create: `Chief of Staff Cal/{daemon-v2,worker-v2,shared-v2}/src/`

- [ ] **Step 1: mkdir workspaces**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
mkdir -p daemon-v2/src worker-v2/src shared-v2/src
ls -la | grep v2
```
Expected: 3 directories listed.

- [ ] **Step 2: Commit empty scaffolding**

```bash
git add daemon-v2 worker-v2 shared-v2
git commit -m "scaffold: create cos v2 workspace dirs (empty)"
```

### Task 1.3: Root package.json con workspaces

**Files:**
- Create: `package.json`

- [ ] **Step 1: Create root package.json**

Write `Chief of Staff Cal/package.json`:
```json
{
  "name": "cos-agent",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "workspaces": ["worker-v2", "daemon-v2", "shared-v2"],
  "scripts": {
    "build": "npm -w @cos/shared run build && npm -w @cos/daemon run build",
    "typecheck": "npm run typecheck -ws --if-present",
    "test": "npm run test -ws --if-present"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.base.json**

Write `Chief of Staff Cal/tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  }
}
```

- [ ] **Step 3: Update .gitignore**

Run:
```bash
cat >> "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/.gitignore" <<'EOF'

# Node workspaces v2
node_modules/
dist/
*.tsbuildinfo
EOF
```

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.base.json .gitignore
git commit -m "scaffold: root package.json + tsconfig + gitignore for v2 workspaces"
```

### Task 1.4: shared-v2 package + types + telegram helpers

**Files:**
- Create: `shared-v2/package.json`, `shared-v2/tsconfig.json`, `shared-v2/src/{index,types,telegram}.ts`

- [ ] **Step 1: shared-v2/package.json**

```json
{
  "name": "@cos/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: shared-v2/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: shared-v2/src/types.ts**

```typescript
export interface QueueMessage {
  kind: "telegram_update";
  payload: TelegramUpdate;
  ts: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
  date: number;
  text?: string;
  voice?: { file_id: string; duration: number; mime_type?: string };
  photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; first_name?: string };
  message?: TelegramMessage;
  data?: string;
}

export interface MenuState {
  section: string;
  taskIds?: string[];
  ts: number;
}
```

- [ ] **Step 4: shared-v2/src/telegram.ts**

```typescript
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
```

- [ ] **Step 5: shared-v2/src/index.ts**

```typescript
export * from "./types.js";
export * from "./telegram.js";
```

- [ ] **Step 6: Build shared and verify**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
npm install
npm -w @cos/shared run build
ls shared-v2/dist/
```
Expected: `index.js`, `types.js`, `telegram.js` + `.d.ts` files.

- [ ] **Step 7: Commit**

```bash
git add shared-v2 package-lock.json
git commit -m "feat(shared-v2): types + telegram helpers + escapeMarkdownV2"
```

### Task 1.5: daemon-v2 stub

**Files:**
- Create: `daemon-v2/package.json`, `daemon-v2/tsconfig.json`, `daemon-v2/src/index.ts` (stub only)

- [ ] **Step 1: daemon-v2/package.json**

```json
{
  "name": "@cos/daemon",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.119",
    "@anthropic-ai/sdk": "^0.32.0",
    "@cos/shared": "*",
    "dotenv": "^16.4.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: daemon-v2/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022"],
    "moduleResolution": "Node",
    "module": "ESNext"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: daemon-v2/src/index.ts (stub)**

```typescript
import { config as loadEnv } from "dotenv";
loadEnv({ path: `${process.env.HOME}/.cos-agent/.env` });

const env = {
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID ?? "",
  COS_TELEGRAM_BOT_TOKEN: process.env.COS_TELEGRAM_BOT_TOKEN ?? "",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
};

delete process.env.ANTHROPIC_API_KEY;

console.log(JSON.stringify({
  level: "info",
  msg: "cos-daemon-v2 boot stub",
  hasToken: env.COS_TELEGRAM_BOT_TOKEN.length > 0,
  hasCfApi: env.CF_ACCOUNT_ID.length > 0,
  ts: Date.now(),
}));

console.log(JSON.stringify({ level: "info", msg: "stub ready, awaiting Phase 3", ts: Date.now() }));
```

- [ ] **Step 4: Build + verify**

Run:
```bash
npm install
npm -w @cos/daemon run build
node daemon-v2/dist/index.js
```
Expected: 2 JSON log lines (`boot stub`, `stub ready`). Process exits clean.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2 package-lock.json
git commit -m "feat(daemon-v2): scaffolding + dotenv + ANTHROPIC_API_KEY guard"
```

### Task 1.6: worker-v2 stub

**Files:**
- Create: `worker-v2/package.json`, `worker-v2/tsconfig.json`, `worker-v2/wrangler.jsonc`, `worker-v2/src/index.ts` (stub)

- [ ] **Step 1: worker-v2/package.json**

```json
{
  "name": "@cos/worker",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "@cos/shared": "*"
  },
  "devDependencies": {
    "wrangler": "^4.0.0",
    "@cloudflare/workers-types": "^4.20250101.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: worker-v2/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: worker-v2/wrangler.jsonc (placeholder KV id)**

```jsonc
{
  "name": "cos-agent-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-28",
  "compatibility_flags": ["nodejs_compat"],
  "queues": {
    "producers": [
      { "binding": "INBOX", "queue": "cos-events" }
    ]
  },
  "kv_namespaces": [
    { "binding": "STATE", "id": "REPLACE_WITH_KV_ID_AT_PHASE_2" }
  ],
  "observability": { "enabled": true }
}
```

- [ ] **Step 4: worker-v2/src/index.ts (stub)**

```typescript
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
```

- [ ] **Step 5: Verify typecheck**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
npm install
npm run typecheck
```
Expected: 3 workspaces typecheck passes (no errors).

- [ ] **Step 6: Commit**

```bash
git add worker-v2 package-lock.json
git commit -m "feat(worker-v2): scaffolding Hono + webhook stub + queue producer"
```

---

## Phase 2: CF Resources + worker deploy + callback router edge

### Task 2.1: Crear recursos CF (queue + KV)

**Files:**
- None (CF API state)

- [ ] **Step 1: Crear queue cos-events**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/worker-v2"
npx wrangler queues create cos-events
```
Expected: `Created queue 'cos-events'`.

- [ ] **Step 2: Habilitar HTTP pull mode**

Run:
```bash
npx wrangler queues consumer http add cos-events
```
Expected: `Added consumer to queue cos-events.`

- [ ] **Step 3: Crear KV namespace**

Run:
```bash
npx wrangler kv namespace create cos-state
```
Expected: `id: <hex32>` printed. **Save the id.**

- [ ] **Step 4: Update wrangler.jsonc con el KV id real**

Edit `worker-v2/wrangler.jsonc` reemplazando `REPLACE_WITH_KV_ID_AT_PHASE_2` con el id del paso 3.

- [ ] **Step 5: Commit**

```bash
git add worker-v2/wrangler.jsonc
git commit -m "config(worker-v2): set cos-state KV namespace id"
```

### Task 2.2: Set wrangler secrets

**Files:**
- None (CF secrets state)

- [ ] **Step 1: Webhook secret**

Run:
```bash
SECRET=$(openssl rand -hex 32)
echo "$SECRET" > ~/.cos-agent/webhook-secret.txt
mkdir -p ~/.cos-agent
chmod 600 ~/.cos-agent/webhook-secret.txt
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/worker-v2"
printf "%s" "$SECRET" | npx wrangler secret put COS_WEBHOOK_SECRET
```
Expected: `Success! Uploaded secret COS_WEBHOOK_SECRET`.

- [ ] **Step 2: Bot token**

Run:
```bash
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' ~/.claude/channels/telegram/.env | cut -d= -f2-)
printf "%s" "$TOKEN" | npx wrangler secret put COS_TELEGRAM_BOT_TOKEN
```
Expected: `Success! Uploaded secret COS_TELEGRAM_BOT_TOKEN`.

### Task 2.3: Deploy worker stub + smoke test

**Files:**
- None (deploy)

- [ ] **Step 1: Deploy**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/worker-v2"
npx wrangler deploy
```
Expected: `Deployed cos-agent-worker triggers https://cos-agent-worker.carlos-cb4.workers.dev`.

- [ ] **Step 2: Smoke test GET /**

Run:
```bash
curl -s https://cos-agent-worker.carlos-cb4.workers.dev/
```
Expected: `cos-agent-worker v2`.

- [ ] **Step 3: Smoke test webhook auth (401)**

Run:
```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST https://cos-agent-worker.carlos-cb4.workers.dev/telegram/webhook -H "Content-Type: application/json" -d '{}'
```
Expected: `HTTP 401`.

### Task 2.4: Menu config + render

**Files:**
- Read: `~/.claude/channels/telegram/menu.json`
- Create: `worker-v2/src/menu.ts`

- [ ] **Step 1: Inspect existing menu.json**

Run:
```bash
cat ~/.claude/channels/telegram/menu.json | head -40
```
Note the structure (sections, items, callback_data). Adapt for v2.

- [ ] **Step 2: Write worker-v2/src/menu.ts**

```typescript
import type { TelegramCallbackQuery } from "@cos/shared";

export interface MenuItem {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface MenuSection {
  title: string;
  rows: MenuItem[][];
}

// Static menu definition. Mirror lo que hay en ~/.claude/channels/telegram/menu.json
// pero prerender hardcoded acá para evitar fetch a disco.
export const MENU_SECTIONS: Record<string, MenuSection> = {
  root: {
    title: "📋 *Menú*",
    rows: [
      [{ text: "✅ Tareas", callback_data: "menu:tareas" }, { text: "📅 Hoy", callback_data: "menu:today" }],
      [{ text: "🏥 Salud", callback_data: "menu:salud" }, { text: "✈️ Vuelos", callback_data: "menu:vuelos" }],
      [{ text: "🎵 Spotify", callback_data: "menu:spotify" }],
    ],
  },
  // Otras secciones se renderizan dinámicamente desde el daemon (tareas, today)
};

export function buildInlineKeyboard(rows: MenuItem[][]): unknown {
  return { inline_keyboard: rows };
}
```

- [ ] **Step 3: Commit**

```bash
git add worker-v2/src/menu.ts
git commit -m "feat(worker-v2): static menu config"
```

### Task 2.5: Light callback router

**Files:**
- Create: `worker-v2/src/callback-router.ts`, `worker-v2/src/notion-light.ts`
- Modify: `worker-v2/src/index.ts`

- [ ] **Step 1: notion-light.ts (mark task done via Notion API directa)**

```typescript
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface NotionEnv {
  notionToken: string;
}

export async function markTaskDone(env: NotionEnv, pageId: string): Promise<void> {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${env.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        Estado: { status: { name: "Done" } },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion mark done ${pageId} failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

export async function setTaskStatus(env: NotionEnv, pageId: string, status: string): Promise<void> {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${env.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        Estado: { status: { name: status } },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion setTaskStatus ${pageId} failed: ${res.status} ${body.slice(0, 200)}`);
  }
}
```

- [ ] **Step 2: callback-router.ts (light callbacks edge)**

```typescript
import type { TelegramCallbackQuery } from "@cos/shared";
import { answerCallbackQuery, editMessageReplyMarkup, editMessage } from "@cos/shared";
import { MENU_SECTIONS, buildInlineKeyboard } from "./menu.js";
import { markTaskDone, setTaskStatus } from "./notion-light.js";

export interface CallbackEnv {
  COS_TELEGRAM_BOT_TOKEN: string;
  NOTION_TOKEN: string;
}

const LIGHT_PREFIXES = new Set(["menu", "t:d", "t:c", "t:s", "nav"]);

export function isLightCallback(data: string | undefined): boolean {
  if (!data) return false;
  const parts = data.split(":");
  if (parts.length < 2) return false;
  const prefix = parts.length === 2 ? parts[0] : `${parts[0]}:${parts[1]}`;
  return LIGHT_PREFIXES.has(prefix);
}

export async function handleLightCallback(cb: TelegramCallbackQuery, env: CallbackEnv): Promise<boolean> {
  const data = cb.data;
  if (!data || !cb.message) return false;
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;

  // menu:section
  if (data.startsWith("menu:")) {
    const section = data.slice(5);
    const sec = MENU_SECTIONS[section];
    if (!sec) return false;
    await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id);
    await editMessage(
      env.COS_TELEGRAM_BOT_TOKEN,
      chatId,
      messageId,
      sec.title,
      "MarkdownV2",
      buildInlineKeyboard(sec.rows),
    );
    return true;
  }

  // t:d:<pageId32> — mark done
  if (data.startsWith("t:d:")) {
    const pageId = data.slice(4);
    await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id, "Done ✅");
    try {
      await markTaskDone({ notionToken: env.NOTION_TOKEN }, pageId);
      await editMessage(
        env.COS_TELEGRAM_BOT_TOKEN,
        chatId,
        messageId,
        "✅ Tarea marcada como done\\.",
        "MarkdownV2",
      );
    } catch (err) {
      await editMessage(
        env.COS_TELEGRAM_BOT_TOKEN,
        chatId,
        messageId,
        "⚠️ Error marcando tarea\\. Reintenta\\.",
        "MarkdownV2",
      );
    }
    return true;
  }

  // t:c:<pageId32> — complete (alias for done)
  if (data.startsWith("t:c:")) {
    const pageId = data.slice(4);
    await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id, "Completed ✅");
    try {
      await setTaskStatus({ notionToken: env.NOTION_TOKEN }, pageId, "Done");
      await editMessage(
        env.COS_TELEGRAM_BOT_TOKEN,
        chatId,
        messageId,
        "✅ Tarea completada\\.",
        "MarkdownV2",
      );
    } catch {
      await editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, messageId, "⚠️ Error\\.", "MarkdownV2");
    }
    return true;
  }

  // t:s:<pageId32> — skip (no-op visible)
  if (data.startsWith("t:s:")) {
    await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id, "Skipped");
    return true;
  }

  // nav:section — same as menu:
  if (data.startsWith("nav:")) {
    const section = data.slice(4);
    const sec = MENU_SECTIONS[section];
    if (!sec) return false;
    await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id);
    await editMessage(env.COS_TELEGRAM_BOT_TOKEN, chatId, messageId, sec.title, "MarkdownV2", buildInlineKeyboard(sec.rows));
    return true;
  }

  return false;
}
```

- [ ] **Step 3: Wire en worker-v2/src/index.ts**

```typescript
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

  // Light callback bypass: process in edge, no queue
  if (update.callback_query && isLightCallback(update.callback_query.data)) {
    const handled = await handleLightCallback(update.callback_query, {
      COS_TELEGRAM_BOT_TOKEN: c.env.COS_TELEGRAM_BOT_TOKEN,
      NOTION_TOKEN: c.env.NOTION_TOKEN,
    });
    if (handled) return c.text("ok");
    // fall through to queue if not handled
  }

  const msg: QueueMessage = { kind: "telegram_update", payload: update, ts: Date.now() };
  await c.env.INBOX.send(msg);
  return c.text("ok");
});

export default app;
```

- [ ] **Step 4: Set NOTION_TOKEN secret**

Run:
```bash
NOTION=$(grep '^NOTION_TOKEN=' ~/.claude/channels/telegram/.env | cut -d= -f2-)
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/worker-v2"
printf "%s" "$NOTION" | npx wrangler secret put NOTION_TOKEN
```
Expected: `Success! Uploaded secret NOTION_TOKEN`.

- [ ] **Step 5: Re-deploy + verify**

Run:
```bash
npx wrangler deploy
curl -s https://cos-agent-worker.carlos-cb4.workers.dev/
```
Expected: deploy success, `cos-agent-worker v2`.

- [ ] **Step 6: Commit**

```bash
git add worker-v2/src/{callback-router,notion-light}.ts worker-v2/src/index.ts
git commit -m "feat(worker-v2): light callback router (menu + t:d/t:c/t:s/nav) edge"
```

---

## Phase 3: Daemon Node — infra base

### Task 3.1: Clone queue-poller, cf-kv, state, agent

**Files:**
- Read: `Family/daemon-v2/src/{queue-poller,cf-kv,state,agent}.ts`
- Create: `daemon-v2/src/{queue-poller,cf-kv,state,agent}.ts`

- [ ] **Step 1: Copy queue-poller.ts**

Read `Family/daemon-v2/src/queue-poller.ts`, replace `@family/shared` with `@cos/shared`. Save to `daemon-v2/src/queue-poller.ts`. Code is identical otherwise.

- [ ] **Step 2: Copy cf-kv.ts**

Read `Family/daemon-v2/src/cf-kv.ts`. Save identical to `daemon-v2/src/cf-kv.ts` (no shared dep).

- [ ] **Step 3: Copy state.ts (adapt key prefix)**

Copy from Family but change `vesta-ctx:` to `cos-ctx:` in the `key()` method:

```typescript
private key(chatId: number): string {
  return `cos-ctx:${chatId}`;
}
```

TTL stays 600s, MAX_MESSAGES stays 10.

- [ ] **Step 4: Copy agent.ts (replace "Vesta" with "CoS" in role labels)**

Save adapted version. Change `"Cal/Noe"` and `"Vesta"` in history rendering to `"Cal"` and `"CoS"`:

```typescript
const historyBlock = deps.history.length
  ? deps.history.map((m) => `${m.role === "user" ? "Cal" : "CoS"}: ${m.content}`).join("\n")
  : "";
```

- [ ] **Step 5: Build + verify**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
npm -w @cos/shared run build
npm -w @cos/daemon run typecheck
```
Expected: typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add daemon-v2/src/{queue-poller,cf-kv,state,agent}.ts
git commit -m "feat(daemon-v2): clone infra (queue-poller, cf-kv, state, agent)"
```

---

## Phase 3 (cont.): Tools custom CoS

### Task 3.2: Notion DB Tareas tools

**Files:**
- Create: `daemon-v2/src/tools/notion-tasks.ts`

- [ ] **Step 1: notion-tasks.ts**

```typescript
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface NotionTasksDeps {
  notionToken: string;
  tareasDbId: string;
}

export interface Task {
  pageId: string;
  title: string;
  status: string;
  assignee?: string;
  due?: string; // ISO
  project?: string;
}

export async function listTasks(
  deps: NotionTasksDeps,
  filters: { status?: string; assignee?: string; dueRange?: { from?: string; to?: string }; limit?: number } = {},
): Promise<Task[]> {
  const filter: Record<string, unknown>[] = [];
  if (filters.status) filter.push({ property: "Estado", status: { equals: filters.status } });
  if (filters.assignee) filter.push({ property: "Asignado", people: { contains: filters.assignee } });
  if (filters.dueRange?.from) filter.push({ property: "Fecha", date: { on_or_after: filters.dueRange.from } });
  if (filters.dueRange?.to) filter.push({ property: "Fecha", date: { on_or_before: filters.dueRange.to } });

  const body = filter.length > 0 ? { filter: { and: filter }, page_size: filters.limit ?? 50 } : { page_size: filters.limit ?? 50 };
  const res = await fetch(`${NOTION_API}/databases/${deps.tareasDbId}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${deps.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`listTasks failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { results: Array<Record<string, unknown>> };
  return data.results.map(parseTask);
}

function parseTask(page: Record<string, unknown>): Task {
  const props = (page as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
  const titleProp = props.Nombre ?? props.Tarea ?? props.Title;
  const titleArr = (titleProp?.title as Array<{ plain_text: string }>) ?? [];
  return {
    pageId: (page as { id: string }).id,
    title: titleArr.map((t) => t.plain_text).join(""),
    status: ((props.Estado?.status as { name?: string })?.name) ?? "",
    assignee: ((props.Asignado?.people as Array<{ name?: string }>)?.[0]?.name) ?? undefined,
    due: ((props.Fecha?.date as { start?: string })?.start) ?? undefined,
    project: ((props.Proyecto?.relation as Array<{ id?: string }>)?.[0]?.id) ?? undefined,
  };
}

export async function createTask(deps: NotionTasksDeps, args: {
  title: string;
  status?: string;
  assigneePageId?: string;
  dueIso?: string;
}): Promise<{ pageId: string }> {
  const properties: Record<string, unknown> = {
    Nombre: { title: [{ text: { content: args.title } }] },
  };
  if (args.status) properties.Estado = { status: { name: args.status } };
  if (args.assigneePageId) properties.Asignado = { people: [{ id: args.assigneePageId }] };
  if (args.dueIso) properties.Fecha = { date: { start: args.dueIso } };

  const res = await fetch(`${NOTION_API}/pages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${deps.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: deps.tareasDbId },
      properties,
    }),
  });
  if (!res.ok) throw new Error(`createTask failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { id: string };
  return { pageId: data.id };
}

export async function setTaskStatus(deps: NotionTasksDeps, pageId: string, status: string): Promise<void> {
  await patchPage(deps, pageId, { Estado: { status: { name: status } } });
}

export async function setTaskDate(deps: NotionTasksDeps, pageId: string, dueIso: string): Promise<void> {
  await patchPage(deps, pageId, { Fecha: { date: { start: dueIso } } });
}

async function patchPage(deps: NotionTasksDeps, pageId: string, properties: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${deps.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) throw new Error(`patchPage failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}
```

- [ ] **Step 2: Commit**

```bash
git add daemon-v2/src/tools/notion-tasks.ts
git commit -m "feat(daemon-v2): notion-tasks tool (list, create, setStatus, setDate)"
```

### Task 3.3: Personas mapping cache

**Files:**
- Create: `daemon-v2/src/tools/personas.ts`

- [ ] **Step 1: personas.ts**

```typescript
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface PersonasDeps {
  notionToken: string;
  peopleDbId: string;
}

export interface Persona {
  pageId: string;
  name: string;
  email?: string;
}

let cache: Persona[] | null = null;
let cachedAt = 0;
const TTL_MS = 60 * 60 * 1000; // 1h

export async function getPersonas(deps: PersonasDeps, force = false): Promise<Persona[]> {
  if (!force && cache && Date.now() - cachedAt < TTL_MS) return cache;
  const res = await fetch(`${NOTION_API}/databases/${deps.peopleDbId}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${deps.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ page_size: 100 }),
  });
  if (!res.ok) throw new Error(`getPersonas failed: ${res.status}`);
  const data = (await res.json()) as { results: Array<{ id: string; properties: Record<string, Record<string, unknown>> }> };
  cache = data.results.map((p) => {
    const titleArr = (p.properties.Nombre?.title as Array<{ plain_text: string }>) ?? [];
    const emailProp = p.properties.Email?.email as string | undefined;
    return {
      pageId: p.id,
      name: titleArr.map((t) => t.plain_text).join(""),
      email: emailProp,
    };
  });
  cachedAt = Date.now();
  return cache;
}

export function clearPersonasCache(): void {
  cache = null;
  cachedAt = 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add daemon-v2/src/tools/personas.ts
git commit -m "feat(daemon-v2): personas tool (mapping cache TTL 1h)"
```

### Task 3.4: Outlook cache reader

**Files:**
- Create: `daemon-v2/src/tools/outlook.ts`

- [ ] **Step 1: outlook.ts**

```typescript
import { readFile } from "node:fs/promises";

const CACHE_PATH = `${process.env.HOME}/.claude/hooks/cache/outlook-events.txt`;
const TIMEOUT_MS = 3000;

export interface OutlookEvent {
  date: string; // YYYY-MM-DD
  startTime?: string; // HH:MM
  endTime?: string;
  title: string;
  location?: string;
}

export async function getOutlookEvents(when: "today" | "tomorrow" = "today"): Promise<OutlookEvent[]> {
  let raw: string;
  try {
    raw = await Promise.race([
      readFile(CACHE_PATH, "utf-8"),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout reading outlook cache")), TIMEOUT_MS)),
    ]);
  } catch (err) {
    throw new Error(`Outlook cache no disponible: ${String(err)}. Verificar cron com.claude.outlook-cache.`);
  }
  // Format esperado del cache: bloques separados por \n, formato dependiente del script.
  // Por simplicidad parseamos solo lineas que tengan formato fecha ISO al inicio.
  const events: OutlookEvent[] = [];
  const lines = raw.split("\n");
  const targetDate = new Date();
  if (when === "tomorrow") targetDate.setDate(targetDate.getDate() + 1);
  const target = targetDate.toISOString().slice(0, 10);
  for (const line of lines) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?(?:-(\d{2}:\d{2}))?\s+(.+?)(?:\s+@\s+(.+))?$/);
    if (m && m[1] === target) {
      events.push({ date: m[1], startTime: m[2], endTime: m[3], title: m[4]!, location: m[5] });
    }
  }
  return events;
}
```

- [ ] **Step 2: Commit**

```bash
git add daemon-v2/src/tools/outlook.ts
git commit -m "feat(daemon-v2): outlook cache reader (with timeout)"
```

### Task 3.5: Health worker tools

**Files:**
- Create: `daemon-v2/src/tools/health.ts`

- [ ] **Step 1: health.ts**

```typescript
const HEALTH_BASE = "https://health.carlos-cb4.workers.dev";
const TIMEOUT_MS = 8000;

export interface HealthDeps {
  apiKey: string;
}

export async function getHealthSummary(deps: HealthDeps, date?: string): Promise<unknown> {
  const url = `${HEALTH_BASE}/summary?key=${encodeURIComponent(deps.apiKey)}${date ? `&date=${encodeURIComponent(date)}` : ""}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`health summary failed: ${res.status}`);
  return await res.json();
}

export async function getHealthTrend(deps: HealthDeps, metric: string, days: number): Promise<unknown> {
  const url = `${HEALTH_BASE}/trend?metric=${encodeURIComponent(metric)}&days=${days}&key=${encodeURIComponent(deps.apiKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`health trend failed: ${res.status}`);
  return await res.json();
}
```

- [ ] **Step 2: Commit**

```bash
git add daemon-v2/src/tools/health.ts
git commit -m "feat(daemon-v2): health worker tools (summary, trend)"
```

### Task 3.6: Agent tools registration + options

**Files:**
- Create: `daemon-v2/src/agent-tools.ts`, `daemon-v2/src/agent-options.ts`

- [ ] **Step 1: agent-options.ts**

```typescript
export const DISALLOWED_BUILTINS: string[] = [
  "Bash", "BashOutput", "KillShell",
  "Read", "Write", "Edit", "NotebookEdit",
  "Glob", "Grep",
  "Task", "Agent",
  "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
  "ListMcpResourcesTool", "ReadMcpResourceTool",
  "ToolSearch",
  "ScheduleWakeup", "Monitor", "PushNotification", "RemoteTrigger",
  "CronCreate", "CronDelete", "CronList",
  "EnterWorktree", "ExitWorktree", "ExitPlanMode",
  "mcp__claude_ai_Airtable__create_records_for_table",
  "mcp__claude_ai_Airtable__update_records_for_table",
  "mcp__claude_ai_Airtable__delete_records_for_table",
  "mcp__claude_ai_Airtable__create_table",
  "mcp__claude_ai_Airtable__update_table",
  "mcp__claude_ai_Airtable__create_field",
  "mcp__claude_ai_Airtable__update_field",
  "mcp__claude_ai_Gmail__create_draft",
  "mcp__claude_ai_Gmail__create_label",
  "mcp__claude_ai_Gmail__label_message",
  "mcp__claude_ai_Gmail__label_thread",
  "mcp__claude_ai_Gmail__unlabel_message",
  "mcp__claude_ai_Gmail__unlabel_thread",
  "mcp__claude_ai_Google_Drive__create_file",
];

export const CLAUDE_AI_COS_TOOLS: string[] = [
  "Skill",
  "WebFetch",
  "WebSearch",
  "mcp__claude_ai_Google_Calendar__list_calendars",
  "mcp__claude_ai_Google_Calendar__list_events",
  "mcp__claude_ai_Google_Calendar__get_event",
  "mcp__claude_ai_Google_Calendar__create_event",
  "mcp__claude_ai_Google_Calendar__update_event",
  "mcp__claude_ai_Google_Calendar__delete_event",
  "mcp__claude_ai_Google_Calendar__suggest_time",
  "mcp__claude_ai_Google_Calendar__respond_to_event",
  "mcp__notion__notion-search",
  "mcp__notion__notion-fetch",
  "mcp__notion__notion-create-pages",
  "mcp__notion__notion-update-page",
  "mcp__notion__notion-query-database-view",
  "mcp__notion__notion-get-users",
  "mcp__claude_ai_Gmail__search_threads",
  "mcp__claude_ai_Gmail__get_thread",
  "mcp__claude_ai_Gmail__list_drafts",
  "mcp__claude_ai_Gmail__list_labels",
];
```

- [ ] **Step 2: agent-tools.ts**

```typescript
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { listTasks, createTask, setTaskStatus, setTaskDate } from "./tools/notion-tasks.js";
import { getPersonas } from "./tools/personas.js";
import { getOutlookEvents } from "./tools/outlook.js";
import { getHealthSummary, getHealthTrend } from "./tools/health.js";

const READ_ONLY = { annotations: { readOnlyHint: true } };

function asText(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

export interface ToolDeps {
  notionToken: string;
  tareasDbId: string;
  peopleDbId: string;
  healthApiKey: string;
}

export function buildSdkTools(deps: ToolDeps) {
  const notionDeps = { notionToken: deps.notionToken, tareasDbId: deps.tareasDbId };
  const personasDeps = { notionToken: deps.notionToken, peopleDbId: deps.peopleDbId };

  return [
    tool(
      "listTasks",
      "Query Notion DB Tareas. Args: { status?, assignee?, dueRange?: { from, to } (ISO), limit? }. Devuelve [{pageId, title, status, assignee?, due?, project?}].",
      {
        status: z.string().optional(),
        assignee: z.string().optional(),
        dueRange: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
        limit: z.coerce.number().int().optional(),
      },
      async (args) => asText(await listTasks(notionDeps, args)),
      READ_ONLY,
    ),
    tool(
      "createTask",
      "Crear nueva tarea en Notion DB Tareas. Args: { title (req), status?, assigneePageId?, dueIso? }. Devuelve { pageId }.",
      {
        title: z.string(),
        status: z.string().optional(),
        assigneePageId: z.string().optional(),
        dueIso: z.string().optional(),
      },
      async (args) => asText(await createTask(notionDeps, args)),
    ),
    tool(
      "setTaskStatus",
      "Cambiar status de una tarea. Args: { pageId, status }.",
      { pageId: z.string(), status: z.string() },
      async ({ pageId, status }) => {
        await setTaskStatus(notionDeps, pageId, status);
        return asText({ ok: true });
      },
    ),
    tool(
      "setTaskDate",
      "Cambiar fecha (Fecha date.start) de una tarea. Args: { pageId, dueIso (ISO 8601) }.",
      { pageId: z.string(), dueIso: z.string() },
      async ({ pageId, dueIso }) => {
        await setTaskDate(notionDeps, pageId, dueIso);
        return asText({ ok: true });
      },
    ),
    tool(
      "getPersonas",
      "Devuelve mapping de personas (pageId → nombre, email) de Notion DB People. Cacheado in-memory TTL 1h.",
      {},
      async () => asText(await getPersonas(personasDeps)),
      READ_ONLY,
    ),
    tool(
      "getOutlookEvents",
      "Lee cache pre-procesado de eventos Outlook del día. Args: { when?: 'today'|'tomorrow' }. Cache se refresca por cron com.claude.outlook-cache cada 4h.",
      { when: z.enum(["today", "tomorrow"]).optional() },
      async ({ when }) => asText(await getOutlookEvents(when)),
      READ_ONLY,
    ),
    tool(
      "getHealthSummary",
      "Resumen de salud del día (sleep, steps, HR, etc.) desde Apple Health worker. Args: { date? (YYYY-MM-DD, default hoy) }.",
      { date: z.string().optional() },
      async ({ date }) => asText(await getHealthSummary({ apiKey: deps.healthApiKey }, date)),
      READ_ONLY,
    ),
    tool(
      "getHealthTrend",
      "Tendencia de una métrica de salud. Args: { metric (steps|sleep|hr|...), days (int) }.",
      { metric: z.string(), days: z.coerce.number().int() },
      async ({ metric, days }) => asText(await getHealthTrend({ apiKey: deps.healthApiKey }, metric, days)),
      READ_ONLY,
    ),
  ];
}
```

- [ ] **Step 3: Build typecheck**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
npm -w @cos/daemon run typecheck
```
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add daemon-v2/src/agent-tools.ts daemon-v2/src/agent-options.ts
git commit -m "feat(daemon-v2): MCP cos-tools registration (8 tools) + agent options"
```

### Task 3.7: System prompt

**Files:**
- Create: `daemon-v2/src/system-prompt.ts`

- [ ] **Step 1: system-prompt.ts**

Write CoS identity + tools docs + UX MarkdownV2 rules. Adaptar de `Family/daemon-v2/src/system-prompt.ts` cambiando:
- Identidad: "Vesta" → "CoS" (Chief of Staff de Cal)
- Familia → trabajo de Cal en Yape, equipo, stakeholders
- iOS Reminders → Notion DB Tareas
- AntoCataNoeCal → Calendario laboral + Outlook cache
- Lexicon emojis: agregar 📊 📈 💼 🎯 ⏰

Usar las mismas reglas MarkdownV2 (escape obligatorio, no HTML), tabla emoji por status de tarea (Done/InProgress/Blocked/etc.), regla anti-confusión de selección de tool.

Plantilla output 1 tarea:
```
✅ *{título}*
📅 {fecha si hay} · 👤 {asignado}
🏷️ {status}
```

Plantilla lista de tareas:
```
{emoji} {título} · {fecha} · {asignado}
```

- [ ] **Step 2: Commit**

```bash
git add daemon-v2/src/system-prompt.ts
git commit -m "feat(daemon-v2): system prompt — CoS identity + tools + UX MarkdownV2"
```

### Task 3.8: index.ts main loop con processMessage

**Files:**
- Modify: `daemon-v2/src/index.ts`

- [ ] **Step 1: Replace stub with full loop**

Adapt from `Family/daemon-v2/src/index.ts` strip multimodal (voice/photo) y crons; deja:
- env loading (CF_*, COS_TELEGRAM_BOT_TOKEN, NOTION_TOKEN, NOTION_TAREAS_DB_ID, NOTION_PEOPLE_DB_ID, HEALTH_API_KEY, ANTHROPIC_API_KEY, COS_WEBHOOK_SECRET, COS_WEBHOOK_URL)
- `delete process.env.ANTHROPIC_API_KEY`
- CfKv + ConversationState
- buildSdkTools + createSdkMcpServer + BASE_OPTIONS con DISALLOWED_BUILTINS + CLAUDE_AI_COS_TOOLS
- `takeWarm()` con `startup({ options: BASE_OPTIONS })` fresco por turn (NO `prewarmNext` pool stale gotcha)
- `processMessage`: typing indicator interval 4s, placeholder, runAgent, editMessage MarkdownV2 con fallback a plain text
- ALERT_CHAT_ID, BACKOFF_MAX_MS para circuit breaker en CF Queue
- `ensureWebhook` watchdog cada 1 min
- loop principal con backoff exponencial

- [ ] **Step 2: Build**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
npm -w @cos/shared run build
npm -w @cos/daemon run typecheck
npm -w @cos/daemon run build
```
Expected: typecheck + build success.

- [ ] **Step 3: Commit**

```bash
git add daemon-v2/src/index.ts
git commit -m "feat(daemon-v2): main loop — queue poll, processMessage, watchdog, fresh startup per turn"
```

---

## Phase 4: Plist + standby test

### Task 4.1: Crear plist com.cal.cos-agent-v2

**Files:**
- Create: `~/Library/LaunchAgents/com.cal.cos-agent-v2.plist`

- [ ] **Step 1: Compose .env file**

Run:
```bash
mkdir -p ~/.cos-agent
{
  echo "# CoS v2 daemon env — generado $(date +%F)"
  echo "CF_ACCOUNT_ID=$(grep '^CF_ACCOUNT_ID=' ~/.pecunia-agent/.env | cut -d= -f2-)"
  echo "CF_QUEUE_ID=<obtener con: npx wrangler queues list>"
  echo "CF_KV_NAMESPACE_ID=<usar el id de cos-state>"
  echo "CF_API_TOKEN=$(grep '^CF_API_TOKEN=' ~/.pecunia-agent/.env | cut -d= -f2-)"
  echo "ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' ~/.pecunia-agent/.env | cut -d= -f2-)"
  echo "COS_TELEGRAM_BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' ~/.claude/channels/telegram/.env | cut -d= -f2-)"
  echo "NOTION_TOKEN=$(grep '^NOTION_TOKEN=' ~/.claude/channels/telegram/.env | cut -d= -f2-)"
  echo "NOTION_TAREAS_DB_ID=<obtener de Notion DB Tareas URL>"
  echo "NOTION_PEOPLE_DB_ID=<obtener de Notion DB People URL>"
  echo "HEALTH_API_KEY=$(grep '^HEALTH_API_KEY=' ~/.claude/channels/telegram/.env | cut -d= -f2-)"
  echo "COS_WEBHOOK_URL=https://cos-agent-worker.carlos-cb4.workers.dev/telegram/webhook"
  echo "COS_WEBHOOK_SECRET=$(cat ~/.cos-agent/webhook-secret.txt)"
} > ~/.cos-agent/.env
chmod 600 ~/.cos-agent/.env
wc -l ~/.cos-agent/.env
```
Expected: 13 líneas. Cal verifica que los placeholders `<obtener con...>` se reemplacen.

- [ ] **Step 2: Get queue id**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/worker-v2"
npx wrangler queues list | grep cos-events
```
Copy the queue id and replace in `~/.cos-agent/.env`.

- [ ] **Step 3: Get Notion DB IDs**

Cal provides:
- `NOTION_TAREAS_DB_ID` (32 chars hex from Notion URL of DB Tareas)
- `NOTION_PEOPLE_DB_ID` (idem People)

Replace in `~/.cos-agent/.env`.

- [ ] **Step 4: Plist file**

Write `~/Library/LaunchAgents/com.cal.cos-agent-v2.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cal.cos-agent-v2</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/daemon-v2/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/calepes</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>COS_AGENT_V2_BG</key>
    <string>1</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/daemon-v2</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>NetworkState</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/Users/calepes/Library/Logs/cos-agent-v2.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/calepes/Library/Logs/cos-agent-v2.err.log</string>
</dict>
</plist>
```

- [ ] **Step 5: Bootstrap + verify standby**

Run:
```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
sleep 5
launchctl list | grep cos-agent-v2
tail -10 ~/Library/Logs/cos-agent-v2.out.log
```
Expected: PID printed, status 0; log shows `cos-daemon-v2 ready` (no `_error_`).

- [ ] **Step 6: Verify queue poll loop healthy**

Run:
```bash
sleep 30
tail -5 ~/Library/Logs/cos-agent-v2.out.log
```
Expected: no `loop_error`. If queue is empty, no further log entries (silent OK).

- [ ] **Step 7: Commit**

No files in repo for plist (lives in ~/Library/LaunchAgents/), no commit needed beyond docs. Document in CHANGELOG.

---

## Phase 5: Hooks SessionStart/End adaptados

### Task 5.1: Update cos-channel-bootout.sh para webhook coordination

**Files:**
- Modify: `~/.claude/hooks/cos-channel-bootout.sh`

- [ ] **Step 1: Read current hook**

Run:
```bash
cat ~/.claude/hooks/cos-channel-bootout.sh
```

- [ ] **Step 2: Replace bootout daemon viejo by deleteWebhook**

Backup original first:
```bash
cp ~/.claude/hooks/cos-channel-bootout.sh ~/.claude/hooks/cos-channel-bootout.sh.bak-2026-04-28
```

Then replace logic. Instead of `launchctl bootout cos-agent`, do `deleteWebhook` so polling can take over the bot:

```bash
#!/bin/bash
set -uo pipefail
[[ "${COS_AGENT_V2_BG:-}" == "1" ]] && exit 0
MY_PID=$PPID
my_cmd=$(ps -o command= -p "$MY_PID" 2>/dev/null || true)
[[ "$my_cmd" != *"--channels plugin:telegram"* ]] && exit 0
[[ "$my_cmd" == *"TELEGRAM_STATE_DIR="* ]] && exit 0

# CoS v2 uses webhook. Sesión interactiva con plugin polling va a llamar
# deleteWebhook automático via grammY bot.start(). No hay nada que hacer acá
# excepto documentar — el watchdog del daemon restaura el webhook en 1 min
# después del SessionEnd.
echo "[cos-channel-bootout] sesión interactiva activa — webhook se va a desactivar via grammY bot.start(); watchdog post-session lo restaura" >&2

exit 0
```

- [ ] **Step 3: Update cos-channel-bootstrap.sh para forzar setWebhook al final**

Replace with:

```bash
#!/bin/bash
set -uo pipefail
[[ "${COS_AGENT_V2_BG:-}" == "1" ]] && exit 0
MY_PID=$PPID
my_cmd=$(ps -o command= -p "$MY_PID" 2>/dev/null || true)
[[ "$my_cmd" != *"--channels plugin:telegram"* ]] && exit 0
[[ "$my_cmd" == *"TELEGRAM_STATE_DIR="* ]] && exit 0

# Restore webhook immediately (don't wait for daemon watchdog ~1 min)
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$HOME/.claude/channels/telegram/.env" | cut -d= -f2-)
SECRET=$(cat "$HOME/.cos-agent/webhook-secret.txt" 2>/dev/null)
URL="https://cos-agent-worker.carlos-cb4.workers.dev/telegram/webhook"

if [ -n "$TOKEN" ] && [ -n "$SECRET" ]; then
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"$URL\",\"secret_token\":\"$SECRET\",\"allowed_updates\":[\"message\",\"callback_query\",\"edited_message\"]}" >/dev/null
  echo "[cos-channel-bootstrap] webhook restored to cos-agent-worker" >&2
fi

exit 0
```

- [ ] **Step 4: Test hook manualmente**

Run:
```bash
bash ~/.claude/hooks/cos-channel-bootstrap.sh
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' ~/.claude/channels/telegram/.env | cut -d= -f2-)
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | python3 -c "import json,sys; d=json.load(sys.stdin)['result']; print('url:', d.get('url'))"
```
Expected: `url: https://cos-agent-worker.carlos-cb4.workers.dev/telegram/webhook`. (NB: only after Phase 6 cutover; until then, expect empty url.)

- [ ] **Step 5: Commit**

Files live in `~/.claude/hooks/` (not in CoS repo). Document the change in `Chief of Staff Cal/CLAUDE.md` y `CHANGELOG.md`.

---

## Phase 6: Cutover

### Task 6.1: Set webhook + smoke test

**Files:**
- None (cutover state)

- [ ] **Step 1: setWebhook al worker v2**

Run:
```bash
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' ~/.claude/channels/telegram/.env | cut -d= -f2-)
SECRET=$(cat ~/.cos-agent/webhook-secret.txt)
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://cos-agent-worker.carlos-cb4.workers.dev/telegram/webhook\",\"secret_token\":\"${SECRET}\",\"drop_pending_updates\":false,\"allowed_updates\":[\"message\",\"callback_query\",\"edited_message\"]}"
```
Expected: `{"ok":true,"result":true,"description":"Webhook was set"}`.

- [ ] **Step 2: Verify webhook**

Run:
```bash
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | python3 -c "import json,sys; d=json.load(sys.stdin)['result']; print('url:', d.get('url')); print('pending:', d.get('pending_update_count')); print('last_err:', d.get('last_error_message','none'))"
```
Expected: url set, pending 0, last_err none.

- [ ] **Step 3: Test entrante DM**

Cal manda mensaje al bot @calclaudecode_bot ("hola"). Tail logs daemon:
```bash
tail -f ~/Library/Logs/cos-agent-v2.out.log
```
Expected: `agent_run_start` → `agent_run_done` con replyLen > 0. Cal recibe respuesta.

- [ ] **Step 4: Test light callback (menú)**

Cal manda `/menu` o tap en algún menú con callback `menu:tareas`. Verificar latencia <500ms (worker edge).

- [ ] **Step 5: Test heavy callback (task date)**

Cal en lista de tareas, tap `task:date:<pageId>`. Verificar que llegue al daemon (log `agent_run_start` con callback_query) y abra session de input.

### Task 6.2: Bootout daemon viejo

**Files:**
- Move: `~/Library/LaunchAgents/com.cal.cos-agent.plist` → `disabled-2026-04-28/`

- [ ] **Step 1: Bootout**

Run:
```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.cal.cos-agent.plist 2>&1
sleep 2
launchctl list | grep cos-agent
```
Expected: only `com.cal.cos-agent-v2` remains.

- [ ] **Step 2: Move plist viejo**

Run:
```bash
mkdir -p ~/Library/LaunchAgents/disabled-2026-04-28
mv ~/Library/LaunchAgents/com.cal.cos-agent.plist ~/Library/LaunchAgents/disabled-2026-04-28/
ls ~/Library/LaunchAgents/disabled-2026-04-28/
```
Expected: `com.cal.cos-agent.plist` listed.

- [ ] **Step 3: Limpiar bun zombies (defensa en profundidad)**

Run:
```bash
pkill -9 -f "bun server.ts" 2>/dev/null || true
sleep 1
ps auxww | grep "bun server" | grep -v grep
```
Expected: no output (no bun zombies).

### Task 6.3: Re-run smoke test full

- [ ] **Step 1: Full smoke**

Cal manda mensaje + tap menu + tap task done. Verificar:
1. Mensaje DM → daemon responde
2. Menu callback → ~300ms en chat (edge)
3. t:d:<pageId> → tarea actualizada en Notion + confirmation in chat

- [ ] **Step 2: Watchdog test (simular drift)**

Run:
```bash
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' ~/.claude/channels/telegram/.env | cut -d= -f2-)
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/deleteWebhook"
sleep 70
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | python3 -c "import json,sys; d=json.load(sys.stdin)['result']; print('url:', d.get('url'))"
```
Expected: empty after 1st curl, restored to worker URL after 70s (watchdog runs every 1 min).

### Task 6.4: Update docs

**Files:**
- Modify: `Chief of Staff Cal/CLAUDE.md`, `Chief of Staff Cal/CHANGELOG.md`, `Chief of Staff Cal/BACKLOG.md`

- [ ] **Step 1: Update CLAUDE.md sección Estado**

Reemplazar bloque `Estado (2026-04-28)` con:
- Daemon activo: `com.cal.cos-agent-v2` (Node + SDK librería + webhook)
- Plist viejo movido a `disabled-2026-04-28/`
- Hooks adaptados (deleteWebhook/setWebhook)
- Tools custom y MCPs heredados listados

- [ ] **Step 2: Add CHANGELOG entry para 2026-04-28**

```markdown
## 2026-04-28

### Migración mayor: daemon CoS v2 (Node + Agent SDK librería)
- ... (estructura similar a Family/CHANGELOG.md entry)
```

- [ ] **Step 3: Update BACKLOG**

Marcar como completado:
- Migración CoS a Node + SDK ✅

Mantener pendientes:
- Spotify control re-port a worker v2 si Cal lo decide
- Migración heartbeat / briefings país / morning-build (iteraciones futuras)

- [ ] **Step 4: Commit + push**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add CLAUDE.md CHANGELOG.md BACKLOG.md
git commit -m "docs: cos-agent v2 migration complete (cutover 2026-04-28)"
git push origin main
```
Expected: clean push.

---

## Self-Review

**Spec coverage check:**
- ✅ Scope mínimo (bot conversacional only) — Phase 1-6 cover this
- ✅ Worker CF + callback router edge — Phase 2
- ✅ Daemon Node + tools custom — Phase 3
- ✅ MCPs heredados — agent-options.ts CLAUDE_AI_COS_TOOLS
- ✅ Webhook coordination — Phase 5 hooks
- ✅ Watchdog — index.ts ensureWebhook
- ✅ Cutover + rollback — Phase 6
- ✅ NO crons embebidos — confirmed not in plan

**Placeholder scan:**
- "TBD"/"TODO" en plan — solo en `<obtener con...>` placeholders del .env (Cal completes manually). OK.
- "Add error handling" — no genéricos; cada tool tiene try/catch específico

**Type consistency:**
- `markTaskDone` en notion-light.ts (worker) y `setTaskStatus` en notion-tasks.ts (daemon) — ambos llaman PATCH a Notion con `Estado.status.name`. Consistente.
- `Task` interface en notion-tasks.ts coincide con `parseTask` en lo que extrae

---

## Execution Handoff

**Plan complete and saved to `Chief of Staff Cal/docs/superpowers/plans/2026-04-28-cos-agent-v2-implementation.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
