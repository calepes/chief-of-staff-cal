# Telegram Interactive Buttons — Design Spec

## Objetivo
Habilitar botones inline interactivos en el bot de Telegram de Claude Code, permitiendo menús, revisión de tareas, aprobaciones rápidas y control de Spotify sin escribir texto.

## Approach
Fork local del plugin oficial de Telegram (`telegram@claude-plugins-official` v0.0.5). Modificar el handler de `callback_query` para reenviar callbacks custom como mensajes de texto al channel de Claude Code.

## Arquitectura

```
Usuario toca botón inline
  → Telegram envía callback_query al bot
  → Plugin local (fork) recibe callback
  → answerCallbackQuery() (feedback visual inmediato)
  → Reenvía como mensaje de texto al channel: "[callback] prefix:action:context"
  → Claude Code recibe como mensaje de texto
  → Claude procesa la acción (Notion API, Spotify API, generar briefing, etc.)
  → Claude responde via reply tool
```

## Componentes

### 1. Fork del Plugin

**Origen:** `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.5/`
**Destino:** `~/Documents/Claude Projects/Personal/Agents/Chief of Staff Cal/telegram-plugin/`

**Cambio en `server.ts`:** Extender el handler `bot.on('callback_query:data', ...)` para que, antes del check de `perm:*`, detecte callbacks custom y los reenvíe como mensaje de texto al channel.

```ts
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data

  // Custom callbacks → reenviar como texto al channel
  if (!data.startsWith('perm:')) {
    await ctx.answerCallbackQuery({ text: 'Procesando...' })
    // Emit as if user sent a text message
    // Use the existing message delivery mechanism to Claude Code
    emitToChannel(`[callback] ${data}`, ctx)
    return
  }

  // existing perm: logic...
})
```

La función `emitToChannel` debe usar el mismo mecanismo que `bot.on('message:text')` para entregar el mensaje a Claude Code, incluyendo metadata del usuario y chat_id.

### 2. Callback Data Format

```
prefix:action[:context]
```

| Prefix | Acciones | Ejemplo |
|--------|----------|---------|
| `menu` | `briefing`, `today`, `status`, `tareas`, `spotify` | `menu:briefing:bolivia` |
| `task` | `complete`, `cancel`, `reprogram`, `keep`, `skip` | `task:complete:ea6f4c60` |
| `approve` | `yes`, `no` | `approve:yes:request123` |
| `spotify` | `play`, `pause`, `skip`, `back`, `volup`, `voldown` | `spotify:pause` |
| `nav` | `back`, `home` | `nav:back` |

### 3. Menú Principal

Trigger: usuario escribe `/menu` o `menu`.
Claude envía mensaje con inline keyboard via Telegram API:

```
Fila 1: [Bolivia]           [Perú]        [Colombia]
Fila 2: [Briefing del día]
Fila 3: [Estado proyectos]  [Tareas]
Fila 4: [Spotify]
```

Callback data:
- `menu:briefing:bolivia`, `menu:briefing:peru`, `menu:briefing:colombia`
- `menu:today`
- `menu:status`, `menu:tareas`
- `menu:spotify`

### 4. Flujos Interactivos

**Revisión de tareas:**
```
[Completada]  [Cancelar]
[Reprogramar] [Mantener]
[Siguiente >>]
```
Callback: `task:{action}:{page_id_short}`

**Spotify (futuro — requiere Spotify API):**
```
[<< Back]  [Play/Pause]  [Skip >>]
[Vol -]    [Vol +]
```
Callback: `spotify:{action}`

**Aprobaciones:**
```
[Sí]  [No]
```
Callback: `approve:{yes|no}:{request_id}`

### 5. Configuración del Channel

Apuntar la config del channel de Telegram al fork local en lugar del plugin cacheado.

Archivo: `~/.claude/channels/telegram/channel.json` (o equivalente)
Cambiar la ruta del server al fork local.

### 6. CLAUDE.md Global — Mantenimiento del Fork

Agregar sección en `~/.claude/CLAUDE.md`:

```
## Telegram Plugin Fork
- Fork local del plugin en: ~/Documents/Claude Projects/Personal/Agents/Chief of Staff Cal/telegram-plugin/
- Original: ~/.claude/plugins/cache/claude-plugins-official/telegram/
- Cambio: callback_query handler extendido para botones inline interactivos
- Mantenimiento: cuando el plugin oficial se actualice, comparar server.ts del cache vs fork y mergear cambios nuevos preservando el handler custom
- Verificar versión actual del plugin oficial vs fork con: diff entre ambos directorios
```

## Limitaciones conocidas

- Telegram limita callback_data a 64 bytes. El formato `prefix:action:context` debe ser conciso.
- answerCallbackQuery tiene timeout de 10 segundos. Para acciones largas (briefing), el feedback inicial es "Procesando..." y el resultado llega como mensaje nuevo.
- El fork requiere mantenimiento manual al actualizar el plugin oficial.

## Testing

1. Copiar fork, modificar handler
2. Reiniciar channel con fork
3. Enviar /menu → verificar que aparecen botones
4. Tocar botón → verificar que Claude recibe "[callback] menu:briefing:bolivia"
5. Verificar que Claude ejecuta la acción correctamente
