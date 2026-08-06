# Migrar Jano a `@cal/telegram` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar la implementación propia de `shared-v2/src/telegram.ts` (paquete interno
`@cos/shared`) por un re-export de `@cal/telegram`, sin romper ningún call site — a diferencia de
Pecunia, se espera que esto sea casi gratis porque las firmas ya coinciden.

**Architecture:** `shared-v2/src/telegram.ts` pasa de ~169 líneas de implementación propia a un
re-export NOMBRADO de `@cal/telegram` (excluyendo `TelegramUpdate`, que sigue viniendo de
`shared-v2/src/types.ts` — mismo patrón que Vesta). Como los 21 archivos consumidores ya usan la
forma de la librería nueva, la Task 1 corre `tsc` inmediatamente después del swap para confirmar
(no asumir) que da 0 errores.

**Tech Stack:** TypeScript, npm workspaces (`daemon-v2`/`worker-v2`/`shared-v2`), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-jano-cal-telegram-migration-design.md` — leer antes de
ejecutar, tiene el detalle de por qué se espera 0 breaking changes y los 2 riesgos ya descartados
(`editMessageReplyMarkup` con catch, `sendVoice` con fix gratis del bug Buffer/Blob).

---

### Task 0: Baseline

**Files:** ninguno (solo verificación)

- [ ] **Step 1: Confirmar git status limpio (o anotar WIP ajeno a no tocar)**

Run: `git status`
Expected (ya verificado al escribir este plan): WIP ajeno sin commitear en `BACKLOG.md`,
`CLAUDE.md`, `daemon-v2/src/system-prompt.ts` (regla de formato de datos densos, agregada en
sesión previa) y los archivos de `proactive/kpi-card-lending-*`/`kpi-lending-notion.*` (feature de
Lending, otra sesión). Ninguno de estos toca `@cos/shared` — no tocar ni commitear junto con esta
migración.

- [ ] **Step 2: Baseline de tests**

Run: `npx vitest run --root daemon-v2 2>&1 | tail -10` y `npx vitest run --root worker-v2 2>&1 | tail -10`
Expected: `daemon-v2` → **799 tests passed, 1 failed** (el fallo es
`learning-reflect.test.ts › SDK_SESSIONS_DIR` — preexistente, depende del filesystem real, NO
relacionado con Telegram — no confundir con una regresión de esta migración). `worker-v2` → **2/2
passed**.

- [ ] **Step 3: Confirmar build de `shared-telegram`**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/shared-telegram" && npm run build`
Expected: build limpio (ya debería estarlo, migrado hoy para Vesta y Pecunia).

---

### Task 1: Wire `@cal/telegram` + shim nombrado + typecheck completo

**Files:**
- Modify: `shared-v2/package.json`
- Modify: `shared-v2/src/telegram.ts`

- [ ] **Step 1: Agregar la dependencia**

En `shared-v2/package.json`, agregar `dependencies` (crear la clave si no existe):

```json
{
  "dependencies": {
    "@cal/telegram": "file:../../shared-telegram"
  }
}
```

(Ruta relativa desde `Jano/shared-v2/` — 2 niveles hasta `Personal/Agents/`, luego
`shared-telegram/`. Un nivel MENOS que en Pecunia, porque `shared-v2` cuelga directo de `Jano/`, no
de un subdirectorio como `Pecunia/pecunia-agent/shared/`.)

- [ ] **Step 2: Reemplazar la implementación por el re-export nombrado**

Reemplazar TODO el contenido de `shared-v2/src/telegram.ts` (169 líneas) por:

```ts
export {
  sendMessage,
  sendRichMessage,
  editMessage,
  editRichMessage,
  editMessageReplyMarkup,
  sendPhoto,
  sendDocument,
  sendVoice,
  sendChatAction,
  answerCallbackQuery,
  deleteMessage,
  splitForTelegram,
  editLongMessage,
  verifySecret,
  escapeHtml,
  escapeMarkdownV2,
  setMyCommands,
  getTelegramFileUrl,
  downloadTelegramFile,
  convertNewlinesToBr,
} from '@cal/telegram';

export type {
  ParseMode,
  SendMessageOpts,
  SendRichMessageOpts,
  ChatAction,
  BotCommand,
  TelegramVoice,
  TelegramPhotoSize,
  TelegramReactionType,
  TelegramMessageReaction,
} from '@cal/telegram';
```

**Sin `export * from` y sin `TelegramUpdate`** — `shared-v2/src/types.ts` ya lo define y
`shared-v2/src/index.ts` (`export * from "./types.js"; export * from "./telegram.js";`) debe seguir
resolviendo un solo `TelegramUpdate` (el de `types.ts`).

- [ ] **Step 3: Instalar y buildear**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm install
npm -w @cos/shared run build
```
Expected: instala el symlink `file:` y compila `shared-v2/dist/telegram.d.ts` con los tipos de
`@cal/telegram` re-exportados.

- [ ] **Step 4: Typecheck completo — confirmar (no asumir) que da 0 errores**

Run:
```bash
npm run typecheck -w @cos/daemon 2>&1
npm run typecheck -w @cos/worker 2>&1
```
Expected: **0 errores en ambos.** Si aparece algún error, es la señal de que algún call site SÍ
necesita ajuste pese al análisis de la spec — en ese caso, tratarlo igual que un archivo de
Pecunia (leer el error real, aplicar el fix mínimo, no asumir el patrón de otro repo).

- [ ] **Step 5: Commit**

```bash
git add shared-v2/package.json shared-v2/src/telegram.ts package-lock.json
git commit -m "chore(shared-v2): re-export nombrado de @cal/telegram desde shared-v2/src/telegram.ts"
```

---

### Task 2: Fix de call sites (solo si Task 1 encontró errores reales)

**Files:** los que indique la salida real de `tsc` de la Task 1 — NO asumir de antemano cuáles.

- [ ] **Step 1: Si Task 1 dio 0 errores, marcar esta task como N/A y saltar a la Task 3.**

- [ ] **Step 2 (solo si hubo errores): aplicar el fix mínimo por archivo, uno a la vez**

Mismo patrón que Pecunia: leer el error real de `tsc`, identificar si es un caso ya cubierto por la
spec (ninguno debería serlo, dado el análisis) o un caso nuevo, aplicar el cambio mínimo, volver a
correr `tsc` para ese archivo, confirmar 0 errores, commitear por archivo.

---

### Task 3: Validación completa

**Files:** ninguno (solo verificación)

- [ ] **Step 1: Typecheck de todo el workspace**

Run: `npm run typecheck` (raíz del repo — corre `-ws --if-present`)
Expected: 0 errores en `daemon-v2`, `worker-v2`, `shared-v2`.

- [ ] **Step 2: Build completo**

Run: `npm run build`
Expected: build limpio (`shared-v2/dist` + `daemon-v2/dist` regenerados y consistentes entre sí —
mismo gotcha que Pecunia: el daemon importa de `shared-v2/dist`, un build salteado da
`ERR_MODULE_NOT_FOUND` silencioso post-restart).

- [ ] **Step 3: Test suite completo**

Run: `npx vitest run --root daemon-v2 2>&1 | tail -15` y `npx vitest run --root worker-v2 2>&1 | tail -10`
Expected: `daemon-v2` → **799 passed, 1 failed** (el mismo `SDK_SESSIONS_DIR` preexistente de la
Task 0 — CONFIRMAR que es el mismo test y no uno nuevo). `worker-v2` → **2/2 passed**. Ningún test
nuevo en rojo.

- [ ] **Step 4: Grep de residuos de la firma vieja / doble-check de `TelegramUpdate`**

Run:
```bash
grep -rn "TelegramUpdate" shared-v2/src/index.ts shared-v2/src/telegram.ts
```
Expected: `TelegramUpdate` NO debe aparecer en `telegram.ts` (solo se re-exporta desde `types.ts`
vía el `export *` ya existente en `index.ts`) — si aparece, revisar que no se coló un `export *`
genérico en vez del nombrado del Step 2 de la Task 1.

---

### Task 4: Deploy — CON confirmación explícita de Cal antes de cada paso

**No ejecutar este task sin que Cal lo apruebe explícitamente en el momento** — reiniciar el daemon
de producción es una acción con impacto real en el bot que Cal usa a diario.

- [ ] **Step 1: Mostrar a Cal el resumen de los commits + pedir confirmación para el restart**

- [ ] **Step 2 (tras el OK de Cal): Restart daemon**

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
```

- [ ] **Step 3: Verificar boot limpio**

Run: `tail -30 ~/Library/Logs/cos-agent-v2.out.log` y `tail -30 ~/Library/Logs/cos-agent-v2.err.log`
Expected: arranque sin errores nuevos, sin `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Prueba en vivo — pedirle a Cal un mensaje de prueba real**

Confirmar que un mensaje de texto simple (ej. una consulta a Things o un saludo) responde bien
formateado (HTML, sin tags crudos), y si es fácil de probar en el momento, un mensaje de voz (para
tocar el `sendVoice` recién arreglado) y un callback de algún menú (para tocar
`answerCallbackQuery`/`editMessage`). Sin esto, el plan no se considera terminado — los tests no
cubren el render real de Telegram.

- [ ] **Step 5 (solo si `worker-v2` tuvo cambios reales en la Task 2): Deploy del worker**

```bash
cd worker-v2 && npx wrangler deploy
```

Si `worker-v2` no tuvo cambios (caso esperado), este paso no aplica — el worker actual sigue
compilando contra el mismo `@cos/shared` ya buildeado, sin necesidad de redeploy.

---

## Self-Review (ya aplicado al escribir este plan)

- **Cobertura del spec:** el hallazgo central (0 breaking changes esperados) tiene su task de
  verificación explícita (Task 1, Step 4) en vez de darlo por hecho; el único ajuste real necesario
  (re-export nombrado por la colisión de `TelegramUpdate`) tiene su propio step con el código
  completo, no un placeholder.
- **Sin placeholders:** el código del shim está completo y es el resultado real del análisis de la
  API de `@cal/telegram` cruzado contra los 21 call sites verificados — no una plantilla genérica.
- **Diferencia deliberada con el plan de Pecunia:** no hay una task por archivo porque el research
  ya descartó la necesidad — si la Task 1 encontrara errores reales, la Task 2 explícitamente cae
  al mismo patrón de Pecunia (un archivo a la vez, guiado por la salida real de `tsc`) en vez de
  fingir que no puede pasar.
