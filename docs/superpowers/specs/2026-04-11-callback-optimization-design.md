# Callback Optimization — Design Spec

## Objetivo
Procesar callbacks mecánicos de botones inline directamente en el plugin de Telegram (~200ms), sin pasar por el LLM (~5-10s). Solo callbacks que requieren razonamiento se reenvían a Claude Code.

## Decisiones
- **Alcance:** Solo acciones mecánicas (cambiar estado, cambiar deadline). Lo que requiere inteligencia sigue al LLM.
- **Secrets:** Token de Notion en `.env` del plugin. Migración a 1Password CLI como mejora futura.
- **PageId:** Incluido completo (32 hex chars sin guiones) en el `callback_data`, stateless.

## Arquitectura

```
Botón tocado
  → Plugin recibe callback_query
  → callback-router.ts evalúa prefijo
  → Si mecánico (t:d, t:c, t:s):
      → notion-client.ts → PATCH Notion API
      → editMessageText (confirmación)
      → answerCallbackQuery
      → Fin (~200ms)
  → Si no mecánico:
      → Flujo normal → LLM
```

## Prefijos mecánicos

| Prefijo | Acción | Ejemplo callback_data |
|---------|--------|-----------------------|
| `t:d:{id}` | Marcar como "Listo" | `t:d:310c487609dd80cb92b9dee266245519` |
| `t:c:{id}` | Marcar como "Cancelada" | `t:c:310c487609dd80cb92b9dee266245519` |
| `t:s:{id}` | Skip (no hacer nada) | `t:s:310c487609dd80cb92b9dee266245519` |
| `t:sd:{id}:dl:{fecha}` | Set deadline | `t:sd:310c487609dd80cb92b9dee266245519:dl:2026-04-30` (51 chars) |
| `t:sd:{id}:f:{fecha}` | Set fecha | `t:sd:310c487609dd80cb92b9dee266245519:f:2026-04-30` (50 chars) |
| `spotify:pause` | Pause Spotify | `spotify:pause` |
| `spotify:play` | Play Spotify | `spotify:play` |
| `spotify:skip` | Skip track | `spotify:skip` |
| `spotify:back` | Previous track | `spotify:back` |

Todo lo demás (menu:*, approve:*, task:date:*, task:change:*) → LLM.

## Componentes

### 1. `callback-router.ts`
- Recibe `callback_data` string
- Determina si es mecánico o no
- Si mecánico: ejecuta la acción y retorna respuesta para editMessage
- Si no: retorna null (plugin sigue flujo normal al LLM)

### 2. `notion-client.ts`
- `updateTaskStatus(pageId: string, status: string)` — actualiza Estado de la tarea
- `updateTaskDate(pageId: string, field: "Fecha" | "Deadline", date: string)` — actualiza fecha o deadline
- Usa Notion API v2022-06-28 con token del .env
- Page ID completo (32 hex chars sin guiones), no requiere lookup

### 3. `spotify-client.ts` (fase Spotify)
- `pause()`, `play()`, `skipNext()`, `skipPrevious()`
- Usa Spotify Web API con token refrescado desde Cloudflare Worker

### 4. `.env` — nuevas variables
```
NOTION_TOKEN=ntn_xxx
NOTION_TASKS_DB_ID=1f2c4876-09dd-80d2-8c0c-000b7f35059b
```

## Modificación en `server.ts`

En el handler `bot.on('callback_query:data', ...)`, antes del reenvío al LLM:

```ts
import { routeCallback } from './callback-router'

// Dentro del handler, después de auth check:
const result = await routeCallback(data)
if (result) {
  await ctx.answerCallbackQuery({ text: result.toast ?? '' })
  if (result.editText) {
    await ctx.api.editMessageText(chat_id, msgId, result.editText)
  }
  return // No reenviar al LLM
}

// Si no fue mecánico, continuar con flujo normal al LLM...
```

## Resolución de Page ID por prefijo

El callback_data tiene límite de 64 bytes, así que usamos un prefijo de 6 caracteres del page ID. Para resolver:
- Opción A: Query a Notion API buscando por ID prefix (no hay API para esto)
- Opción B: Usar el page ID completo pero sin guiones, son 32 chars hex → cabe en 64 bytes con el prefijo

**Decisión: usar page ID completo sin guiones.** Ejemplo: `t:d:310c487609dd80cb92b9dee266245519` = 36 chars, cabe en 64 bytes.

## Seguridad
- Auth check: el callback debe venir de un usuario en allowFrom (ya implementado)
- Notion token: solo accesible en el .env del plugin, permisos de archivo restringidos al usuario

## Testing
1. Enviar mensaje con botones que incluyan pageId completo
2. Tocar botón → verificar que Notion se actualiza sin pasar por Claude
3. Verificar que el mensaje se edita con confirmación
4. Verificar que callbacks no mecánicos siguen llegando al LLM
