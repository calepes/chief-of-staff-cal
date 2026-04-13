---
name: menu
description: Show the main interactive menu in Telegram. Use when user sends /menu, "menu", or a menu callback.
---

When the user sends `/menu` or `menu` via Telegram:

1. Read the menu config from `~/.claude/channels/telegram/menu.json`
2. Parse the JSON to get `title` and `rows`
3. Send a reply using the Telegram reply tool with:
   - `text`: the `title` from the config
   - `buttons`: the `rows` from the config (each row is an array of {text, callback_data} objects)

## Navegación con edit (evitar clutter)

Cuando recibes un **callback** tipo `[callback] menu:*` que viene con un `message_id` en el meta:

- Usa `edit_message` (no `reply`) para actualizar el mensaje existente con el nuevo contenido y botones.
- Esto aplica a cualquier respuesta que genere botones inline como resultado de un callback de menú.
- Solo usa `reply` (mensaje nuevo) si el contenido es largo (>200 chars) o no tiene botones.

Ejemplo de flujo:
1. Cal toca "📋 Tareas" en el menú → llega `[callback] menu:tareas` con `message_id: "123"`
2. Claude procesa las tareas y responde usando `edit_message` con `message_id: "123"`, texto actualizado, y botones de acción + un botón "⬅️ Menu" (`callback_data: "menu:main"`)
3. Cal toca "⬅️ Menu" → llega `[callback] menu:main` con el mismo `message_id`
4. Claude lee menu.json y usa `edit_message` para restaurar el menú principal

### Botón de regreso
Siempre incluir un botón "⬅️ Menu" con `callback_data: "menu:main"` como última fila cuando se muestra contenido de un sub-menú.

La menu config es editable — Cal puede modificar menu.json sin tocar código.
