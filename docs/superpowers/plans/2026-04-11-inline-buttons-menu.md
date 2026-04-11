# Inline Buttons & Menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable main menu with inline buttons, structured task review flows, and quick approvals via Telegram.

**Architecture:** Menu defined in a JSON config file that Claude reads dynamically. Task review and approvals use Claude's existing reply+buttons capability. No plugin changes — all logic lives in Claude's conversation handling.

**Tech Stack:** JSON config, Claude Code reply tool with buttons parameter

---

### Task 1: Create Menu Config File

**Files:**
- Create: `~/.claude/channels/telegram/menu.json`

- [ ] **Step 1: Create menu.json**

```json
{
  "title": "Menu Principal",
  "rows": [
    [
      {"text": "🇧🇴 Bolivia", "callback_data": "menu:briefing:bolivia"},
      {"text": "🇵🇪 Peru", "callback_data": "menu:briefing:peru"}
    ],
    [
      {"text": "☀️ Briefing del dia", "callback_data": "menu:today"}
    ],
    [
      {"text": "📋 Tareas", "callback_data": "menu:tareas"},
      {"text": "📊 Status", "callback_data": "menu:status"}
    ],
    [
      {"text": "🎵 Spotify", "callback_data": "menu:spotify"}
    ]
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add ~/.claude/channels/telegram/menu.json
git commit -m "feat: add configurable Telegram menu definition"
```

---

### Task 2: Create Menu Skill

**Files:**
- Create: `telegram-plugin/skills/menu.md`

- [ ] **Step 1: Create the /menu skill**

```markdown
---
name: menu
description: Show the main interactive menu in Telegram. Use when user sends /menu or "menu" in Telegram.
---

When the user sends /menu or "menu" via Telegram:

1. Read the menu config from `~/.claude/channels/telegram/menu.json`
2. Send a reply with the text from `title` and buttons from `rows`
3. Use the `reply` tool with the `buttons` parameter

Example:
reply(chat_id, "Menu Principal", buttons=rows_from_config)
```

- [ ] **Step 2: Commit**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal
git add telegram-plugin/skills/menu.md
git commit -m "feat: add /menu skill for interactive Telegram menu"
```

---

### Task 3: Document Task Review Flows in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add task review flow documentation**

Add to CLAUDE.md Telegram Bot section:

```markdown
### Flujos de revisión de tareas
- **<10 tareas:** Botones inline uno por uno con estado, asignado, deadline, emojis
- **>10 tareas:** Lotes de 5 + texto libre. Incluir: nombre, estado emoji, 👤 asignado, ⏰ deadline, ⚠️ si vencido
- **Callbacks mecánicos:** Usar pageId completo en callback_data (t:d:{id32}, t:c:{id32}, t:s:{id32})
- **Callbacks que requieren input:** Pasar al LLM (task:date, task:change, etc.)
```

- [ ] **Step 2: Commit**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal
git add CLAUDE.md
git commit -m "docs: add task review flow guidelines to CLAUDE.md"
```

---

### Task 4: Test Menu End-to-End

- [ ] **Step 1: Restart Claude Code with Telegram channel**

```bash
claude --channels plugin:telegram@claude-plugins-official
```

- [ ] **Step 2: Send /menu in Telegram**

Expected: Bot replies with "Menu Principal" and 4 rows of buttons.

- [ ] **Step 3: Tap "🇧🇴 Bolivia"**

Expected: Claude receives `[callback] menu:briefing:bolivia` and executes /briefing-pais Bolivia.

- [ ] **Step 4: Send /menu again, tap "📋 Tareas"**

Expected: Claude receives `[callback] menu:tareas` and starts task review flow.
