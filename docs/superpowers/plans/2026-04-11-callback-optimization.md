# Callback Optimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Process mechanical Telegram inline button callbacks (task status, deadlines, Spotify controls) directly in the plugin without passing through the LLM, reducing response time from ~5-10s to ~200ms.

**Architecture:** Add a callback router and Notion client module to the Telegram plugin fork. The router intercepts known mechanical prefixes (t:d, t:c, t:s, t:sd) and executes Notion API calls directly. Unknown callbacks pass through to Claude Code as before.

**Tech Stack:** Bun/TypeScript, Notion API v2022-06-28, Grammy (Telegram bot framework)

---

### Task 1: Create Notion Client Module

**Files:**
- Create: `telegram-plugin/notion-client.ts`

- [ ] **Step 1: Create `notion-client.ts` with config loading**

```ts
// telegram-plugin/notion-client.ts
import { join } from 'path'
import { homedir } from 'os'
import { readFileSync } from 'fs'

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ENV_FILE = join(STATE_DIR, '.env')

function loadEnv(): Record<string, string> {
  try {
    const content = readFileSync(ENV_FILE, 'utf-8')
    const env: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/)
      if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
    }
    return env
  } catch { return {} }
}

const NOTION_API = 'https://api.notion.com/v1'

function getHeaders(): Record<string, string> {
  const env = loadEnv()
  const token = env.NOTION_TOKEN
  if (!token) throw new Error('NOTION_TOKEN not set in .env')
  return {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  }
}

export async function updateTaskStatus(pageId: string, status: string): Promise<{ ok: boolean; error?: string }> {
  const id = pageId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
  try {
    const res = await fetch(`${NOTION_API}/pages/${id}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({
        properties: { Estado: { status: { name: status } } },
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      return { ok: false, error: (body as any).message ?? `HTTP ${res.status}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export async function updateTaskDate(
  pageId: string,
  field: 'Fecha' | 'Deadline',
  date: string
): Promise<{ ok: boolean; error?: string }> {
  const id = pageId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
  try {
    const res = await fetch(`${NOTION_API}/pages/${id}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({
        properties: {
          [field]: { date: { start: date } },
        },
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      return { ok: false, error: (body as any).message ?? `HTTP ${res.status}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
```

- [ ] **Step 2: Verify the module compiles**

Run: `cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal/telegram-plugin && bun build --target=bun notion-client.ts --outdir=/tmp/test-build`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal
git add telegram-plugin/notion-client.ts
git commit -m "feat: add Notion client module for direct task updates"
```

---

### Task 2: Create Callback Router Module

**Files:**
- Create: `telegram-plugin/callback-router.ts`

- [ ] **Step 1: Create `callback-router.ts`**

```ts
// telegram-plugin/callback-router.ts
import { updateTaskStatus, updateTaskDate } from './notion-client'

export interface RouteResult {
  editText: string
  toast?: string
}

export async function routeCallback(data: string): Promise<RouteResult | null> {
  // t:d:{pageId} — mark as "Listo"
  const doneMatch = data.match(/^t:d:([a-f0-9]{32})$/)
  if (doneMatch) {
    const result = await updateTaskStatus(doneMatch[1], 'Listo')
    if (result.ok) {
      return { editText: '✅ Tarea marcada como Listo', toast: '✅ Listo' }
    }
    return { editText: `❌ Error: ${result.error}`, toast: 'Error' }
  }

  // t:c:{pageId} — mark as "Cancelada"
  const cancelMatch = data.match(/^t:c:([a-f0-9]{32})$/)
  if (cancelMatch) {
    const result = await updateTaskStatus(cancelMatch[1], 'Cancelada')
    if (result.ok) {
      return { editText: '❌ Tarea cancelada', toast: '❌ Cancelada' }
    }
    return { editText: `❌ Error: ${result.error}`, toast: 'Error' }
  }

  // t:s:{pageId} — skip (no action, just acknowledge)
  const skipMatch = data.match(/^t:s:([a-f0-9]{32})$/)
  if (skipMatch) {
    return { editText: '⏭ Tarea sin cambios', toast: '⏭' }
  }

  // t:sd:{pageId}:dl:{date} — set deadline
  const dlMatch = data.match(/^t:sd:([a-f0-9]{32}):dl:(\d{4}-\d{2}-\d{2})$/)
  if (dlMatch) {
    const result = await updateTaskDate(dlMatch[1], 'Deadline', dlMatch[2])
    if (result.ok) {
      return { editText: `📅 Deadline actualizado: ${dlMatch[2]}`, toast: '📅 Actualizado' }
    }
    return { editText: `❌ Error: ${result.error}`, toast: 'Error' }
  }

  // t:sd:{pageId}:f:{date} — set fecha
  const fMatch = data.match(/^t:sd:([a-f0-9]{32}):f:(\d{4}-\d{2}-\d{2})$/)
  if (fMatch) {
    const result = await updateTaskDate(fMatch[1], 'Fecha', fMatch[2])
    if (result.ok) {
      return { editText: `📅 Fecha actualizada: ${fMatch[2]}`, toast: '📅 Actualizado' }
    }
    return { editText: `❌ Error: ${result.error}`, toast: 'Error' }
  }

  // Not a mechanical callback — return null to pass through to LLM
  return null
}
```

- [ ] **Step 2: Verify the module compiles**

Run: `cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal/telegram-plugin && bun build --target=bun callback-router.ts --outdir=/tmp/test-build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal
git add telegram-plugin/callback-router.ts
git commit -m "feat: add callback router for mechanical action dispatch"
```

---

### Task 3: Integrate Router into server.ts

**Files:**
- Modify: `telegram-plugin/server.ts:785-829` (callback_query handler)

- [ ] **Step 1: Add import at top of server.ts**

After line 24 (`import { join, extname, sep } from 'path'`), add:

```ts
import { routeCallback } from './callback-router'
```

- [ ] **Step 2: Modify callback_query handler to route mechanical callbacks first**

Replace lines 788-828 (the custom callback block inside `bot.on('callback_query:data', ...)`) with:

```ts
  // Custom interactive callbacks (non-perm:)
  if (!data.startsWith('perm:')) {
    const access = loadAccess()
    const senderId = String(ctx.from.id)
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }

    // Try mechanical routing first (direct Notion updates, ~200ms)
    const routed = await routeCallback(data)
    if (routed) {
      await ctx.answerCallbackQuery({ text: routed.toast ?? '' }).catch(() => {})
      const msg = ctx.callbackQuery.message
      if (msg && 'text' in msg && msg.text) {
        await ctx.api.editMessageText(
          msg.chat.id,
          msg.message_id,
          routed.editText,
        ).catch(() => {})
      }
      return
    }

    // Not mechanical — forward to LLM as before
    await ctx.answerCallbackQuery().catch(() => {})
    const msg = ctx.callbackQuery.message
    if (msg && 'text' in msg && msg.text) {
      const buttonText = msg.reply_markup?.inline_keyboard
        ?.flat()
        ?.find(b => b.callback_data === data)
        ?.text ?? data
      await ctx.api.editMessageText(
        msg.chat.id,
        msg.message_id,
        `${msg.text}\n\nSeleccionado: ${buttonText}`,
      ).catch(() => {})
    }

    const from = ctx.from
    const chat_id = String(ctx.callbackQuery.message?.chat.id ?? ctx.from.id)
    const msgId = ctx.callbackQuery.message?.message_id
    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: `[callback] ${data}`,
        meta: {
          chat_id,
          ...(msgId != null ? { message_id: String(msgId) } : {}),
          user: from.username ?? String(from.id),
          user_id: String(from.id),
          ts: new Date().toISOString(),
        },
      },
    })
    return
  }
```

- [ ] **Step 3: Verify server.ts compiles**

Run: `cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal/telegram-plugin && bun build --target=bun server.ts --outdir=/tmp/test-build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal
git add telegram-plugin/server.ts
git commit -m "feat: integrate callback router into server.ts handler"
```

---

### Task 4: Add Notion Token to .env

**Files:**
- Modify: `~/.claude/channels/telegram/.env`

- [ ] **Step 1: Get Notion integration token**

Cal needs to provide the Notion internal integration token. Check if one already exists:
```bash
grep NOTION_TOKEN ~/.claude/channels/telegram/.env
```

If not found, Cal needs to create one at https://www.notion.so/my-integrations and share the Tareas database with the integration.

- [ ] **Step 2: Add token to .env**

Append to `~/.claude/channels/telegram/.env`:
```
NOTION_TOKEN=ntn_xxxxxxxxxxxxxxxxxxxxx
```

- [ ] **Step 3: Verify .env permissions are restricted**

```bash
chmod 600 ~/.claude/channels/telegram/.env
ls -la ~/.claude/channels/telegram/.env
```
Expected: `-rw-------` permissions (owner only).

---

### Task 5: Deploy and Test

**Files:**
- No new files. Deploy fork to plugin cache.

- [ ] **Step 1: Deploy fork to plugin cache**

```bash
cp ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal/telegram-plugin/server.ts ~/.claude/plugins/cache/claude-plugins-official/telegram/*/server.ts
cp ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal/telegram-plugin/notion-client.ts ~/.claude/plugins/cache/claude-plugins-official/telegram/*/notion-client.ts
cp ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal/telegram-plugin/callback-router.ts ~/.claude/plugins/cache/claude-plugins-official/telegram/*/callback-router.ts
```

- [ ] **Step 2: Restart Claude Code with Telegram channel**

```bash
claude --channels plugin:telegram@claude-plugins-official
```

- [ ] **Step 3: Test mechanical callback — mark task as done**

From Telegram, send a test message with inline buttons that use the new callback format. Claude sends:
```
Test de callback directo
```
With button: `[✅ Listo]` → callback_data: `t:d:88cf414e983e447c8ee5bf78d13017cf` (TEST control task)

Touch button → should update in <1 second, message edits to "✅ Tarea marcada como Listo".

Verify in Notion that the task status changed.

- [ ] **Step 4: Test mechanical callback — set deadline**

Button with callback_data: `t:sd:88cf414e983e447c8ee5bf78d13017cf:dl:2026-04-30`

Touch → message edits to "📅 Deadline actualizado: 2026-04-30".

- [ ] **Step 5: Test non-mechanical callback passes through to LLM**

Button with callback_data: `menu:today`

Touch → should forward to Claude Code as `[callback] menu:today` (existing behavior).

- [ ] **Step 6: Commit final state**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal
git add -A
git commit -m "feat: callback optimization — mechanical actions bypass LLM"
```

---

### Task 6: Update CLAUDE.md and Backlog

**Files:**
- Modify: `BACKLOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update BACKLOG.md — mark callback optimization as done**

Add `[x]` to the relevant items and add a new entry for the completed work.

- [ ] **Step 2: Update CLAUDE.md — document the mechanical callback routing**

Add to the Telegram Plugin Fork section:
```
- **Callback optimization:** Prefijos mecánicos (t:d, t:c, t:s, t:sd) se procesan directo en el plugin via Notion API (~200ms). El resto pasa al LLM.
- **Notion token:** en `~/.claude/channels/telegram/.env` como `NOTION_TOKEN`
```

- [ ] **Step 3: Commit docs**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal
git add BACKLOG.md CLAUDE.md
git commit -m "docs: update backlog and CLAUDE.md with callback optimization"
```
