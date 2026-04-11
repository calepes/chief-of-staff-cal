---
name: menu
description: Show the main interactive menu in Telegram. Use when user sends /menu or "menu" in Telegram.
---

When the user sends `/menu` or `menu` via Telegram:

1. Read the menu config from `~/.claude/channels/telegram/menu.json`
2. Parse the JSON to get `title` and `rows`
3. Send a reply using the Telegram reply tool with:
   - `text`: the `title` from the config
   - `buttons`: the `rows` from the config (each row is an array of {text, callback_data} objects)

The menu is configurable — Cal can edit menu.json to add/remove/reorder options without touching code.
