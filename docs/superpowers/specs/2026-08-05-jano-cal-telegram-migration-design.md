# Migrar Jano a `@cal/telegram` — Design

## Contexto

`@cal/telegram` (`github.com/calepes/shared-telegram`) es la librería Telegram compartida nueva
para los 3 bots de Cal. Vesta ya está migrada (Rich Messages activo en producción, 2026-08-05).
Pecunia migrada el mismo día (10 archivos, gap real de `parseMode` encontrado y corregido). Este
doc es el diseño de la migración de Jano — no re-derivar las 7 decisiones de reconciliación de la
librería en sí (ver `shared-telegram/CLAUDE.md`).

## Hallazgo central: Jano ya es casi idéntico a la librería nueva

A diferencia de Pecunia (firma rota, migración de ~90 call sites), el `shared-v2/src/telegram.ts`
actual de Jano **ya tiene la misma forma** que `@cal/telegram` en casi todo: `sendMessage` ya toma
un objeto `SendMessageOpts` y ya tira excepción en vez de devolver `0`; `editMessage` ya es
`(token, chatId, messageId, text, parseMode='HTML', replyMarkup?)`; `sendPhoto`/`sendDocument` ya
devuelven `{message_id}` y tiran excepción. Tiene sentido — la memoria del proyecto documenta que
Jano y Vesta fueron la base de 5 de las 7 decisiones de reconciliación al diseñar la librería.

**Verificado exhaustivamente (grep de los 21 archivos que importan de `@cos/shared` en
`daemon-v2`/`worker-v2`):** ningún call site de `sendMessage`, `editMessage`,
`editMessageReplyMarkup`, `answerCallbackQuery`, `sendChatAction`, `sendPhoto`, `sendDocument`,
`sendVoice`, `deleteMessage`, `verifySecret`, `escapeHtml`, `escapeMarkdownV2` necesita cambiar de
firma. Se espera **0 errores de `tsc`** tras el swap del shim — a diferencia de Pecunia, no hace
falta una task por archivo.

## El único ajuste real: `TelegramUpdate` colisiona (mismo patrón que Vesta)

`shared-v2/src/types.ts` define su propio `TelegramUpdate` (con `edited_message`, `location`,
`web_app_data`, `TelegramMessage` recursivo vía `reply_to_message`) — más rico que el de
`@cal/telegram`. `shared-v2/src/index.ts` hoy hace:

```ts
export * from "./types.js";
export * from "./telegram.js";
```

Si `telegram.js` pasara a ser `export * from '@cal/telegram'` (que también exporta su propio
`TelegramUpdate`), los dos `export *` chocarían (`Cannot redeclare exported variable
'TelegramUpdate'`). Igual que en Vesta, `shared-v2/src/telegram.ts` debe ser un **re-export
nombrado** que excluya `TelegramUpdate`:

```ts
export {
  sendMessage, sendRichMessage, editMessage, editRichMessage, editMessageReplyMarkup,
  sendPhoto, sendDocument, sendVoice, sendChatAction, answerCallbackQuery, deleteMessage,
  splitForTelegram, editLongMessage, verifySecret, escapeHtml, escapeMarkdownV2,
  setMyCommands, getTelegramFileUrl, downloadTelegramFile, convertNewlinesToBr,
} from '@cal/telegram';
export type {
  ParseMode, SendMessageOpts, SendRichMessageOpts, ChatAction, BotCommand,
  TelegramVoice, TelegramPhotoSize, TelegramReactionType, TelegramMessageReaction,
} from '@cal/telegram';
```

(Sin `TelegramUpdate` en la lista — el de `types.ts` sigue siendo el único.)

## Riesgos verificados y descartados

- **`answerCallbackQuery`/`editMessageReplyMarkup`: la librería nueva SÍ tira excepción ante un
  error HTTP de Telegram** (ej. "message not found"), cosa que la implementación vieja de Jano
  ignoraba en silencio (nunca revisaba `data.ok`). Grep exhaustivo de los 2 call sites de
  `editMessageReplyMarkup` en `daemon-v2/src/index.ts` (líneas ~680 y ~1168): **ambos ya tienen
  `.catch(() => {})`** en la línea de cierre del call multilínea (un primer grep de una sola línea
  no lo mostraba — verificado leyendo el bloque completo). Sin riesgo real. `answerCallbackQuery`
  tiene ~25 call sites en `daemon-v2`/`worker-v2`; la mayoría con `.catch()`, algunos sin ninguno
  pero dentro de un flujo mecánico (ej. `menu.ts:210`, `index.ts:882/978`) donde antes tampoco
  podía fallar por HTTP (Jano nunca chequeaba `data.ok`) — el único cambio real es que ahora SÍ
  puede tirar por un error de Telegram (callback query expirada, `>15s` sin responder). Riesgo bajo
  (un answer fallido no rompe nada crítico) pero **la Task 1 del plan debe confirmar contra la
  salida real de `tsc`/tests si algún call site sin catch necesita uno** — no asumido a mano acá.
- **`sendVoice`: mismo bug de `Buffer`/`Blob` que tenía la librería antes de su propio fix
  (`new Blob([audio.buffer as ArrayBuffer], ...)` en vez de `new Uint8Array(audio.buffer,
  audio.byteOffset, audio.byteLength)`).** Migrar arregla esto gratis, sin tocar el único call site
  (`daemon-v2/src/index.ts:1488`).
- **Retry en fallo de red:** la librería nueva reintenta (`fetchWithRetry`, 3 intentos) en
  `sendMessage`/`editMessage`/`answerCallbackQuery`/etc — Jano hoy no reintenta nada. Mejora pura,
  sin call sites que ajustar.
- **`getTelegramFileUrl`/`downloadTelegramFile` NO viven en `shared-v2/src/telegram.ts`** — Jano
  tiene su propia implementación en `daemon-v2/src/tools/telegram-files.ts`, fuera de alcance de
  esta migración (no importa nada de `@cos/shared` para esto).

## Fuera de alcance

- Activar Rich Messages en Jano — igual que Pecunia, esta migración solo cambia la librería
  subyacente, no el formato de los mensajes actuales (HTML clásico).
- `daemon-v2/src/tools/telegram-files.ts` (no toca `@cos/shared`).
- Cualquier ajuste a `worker-v2` más allá de verificar que sigue compilando — solo usa
  `verifySecret`/`answerCallbackQuery`/`editMessage` (tipos ya compatibles) y tipos de `types.ts`
  (no tocados).

## Baseline (antes de tocar nada)

- `daemon-v2`: **799/800 tests** — el 1 que falla (`learning-reflect.test.ts` ›
  `SDK_SESSIONS_DIR`) es preexistente y NO relacionado (depende del filesystem real, no de
  Telegram) — no debe confundirse con una regresión de esta migración.
- `worker-v2`: **2/2 tests**.
