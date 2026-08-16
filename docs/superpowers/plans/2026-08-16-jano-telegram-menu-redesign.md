# Rediseño del menú de Telegram de Jano — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reestructurar `daemon-v2/src/menu.ts` de un menú plano de 10 botones a un árbol de 2
niveles (11 botones de categoría/acción directa en el nivel 1, 6 submenús nuevos/extendidos en
el nivel 2), agregando acceso a 12 capacidades de Jano que hoy solo son accesibles por texto.

**Architecture:** Todo el cambio vive en un solo archivo, `menu.ts` — funciones puras
`buildXMenu()` que devuelven `MenuPayload`, más dos tablas de despacho (`NAV_MENUS` para
navegación sin LLM, `ACTION_TEXT` para acciones que se convierten en texto natural para el LLM).
`index.ts` NO se toca: ya despacha genéricamente cualquier `callback_data` con prefijo `j:` a
`handleMenuCallback()`, y los 3 casos mecánicos (`j:star`/`j:ytpl`/`j:journal`) siguen
interceptados ahí arriba sin cambios, con los mismos nombres de callback.

**Tech Stack:** TypeScript, vitest (`npm run test -w @cos/daemon`), mismo patrón de test que
`proactive/rich-send.test.ts`.

---

## Task 1: Rediseñar `menu.ts` — árbol de 2 niveles + test de integridad de wiring

**Files:**
- Modify: `daemon-v2/src/menu.ts`
- Create: `daemon-v2/src/menu.test.ts`

### Contexto para quien ejecute esta tarea

`menu.ts` hoy exporta `buildMainMenu()` (10 botones planos), `buildHealthMenu()`,
`buildCambioMenu()`, `buildFlightsMenu()`/`buildFlightsDirMenu()` (submenú de vuelos ya
anidado), dos tablas privadas `ACTION_TEXT`/`NAV_MENUS`, y `handleMenuCallback()` (despachador
genérico, sin cambios en esta tarea). El spec completo con la tabla botón→tool está en
`docs/superpowers/specs/2026-08-16-jano-telegram-menu-redesign-design.md`.

Cambio de fondo: `buildMainMenu()` pasa a devolver 11 botones (7 categorías/acciones nuevas +
4 que ya existían: `j:fuel`, `j:tokens`, `j:journal` se quedan en nivel 1; `j:health`/`j:fx`
también se quedan en nivel 1 pero ahora apuntan a submenús EXTENDIDOS). Se agregan 4 funciones
`buildXMenu()` nuevas (`buildPersonalMenu`, `buildLearningMenu`, `buildViajesMenu`,
`buildYapeMenu`). `buildHealthMenu`/`buildCambioMenu` ganan un botón cada uno.
`buildFlightsMenu()` cambia SOLO su botón "← Volver": de `j:menu` pasa a `j:viajes`, porque
Vuelos queda anidado un nivel más adentro (dentro de la categoría Viajes).

`ACTION_TEXT` y `NAV_MENUS` pasan de privadas (`const`) a exportadas (`export const`) — las
necesita el test de integridad de wiring de este mismo task para verificar que cada
`callback_data` que aparece en algún botón tiene una entrada real en alguna de las dos tablas
(o es uno de los 3 casos mecánicos interceptados en `index.ts`). Sin este export, un typo en un
`callback_data` (ej. escribir `j:leaning:reader` en vez de `j:learning:reader`) no fallaría
ningún test — el botón simplemente no haría nada al tocarlo, en producción, sin ningún error.

- [ ] **Step 1: Escribir el test de integridad (falla contra el `menu.ts` actual)**

Crear `daemon-v2/src/menu.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  buildMainMenu,
  buildPersonalMenu,
  buildHealthMenu,
  buildLearningMenu,
  buildViajesMenu,
  buildYapeMenu,
  buildCambioMenu,
  buildFlightsMenu,
  NAV_MENUS,
  ACTION_TEXT,
} from "./menu.js";
import type { MenuPayload } from "./menu.js";

// Callbacks manejados FUERA de menu.ts (interceptados en index.ts antes del
// startsWith("j:") genérico que despacha a handleMenuCallback) — nunca viven
// en NAV_MENUS ni en ACTION_TEXT, y eso es correcto.
const MECHANICAL_ELSEWHERE = new Set(["j:star", "j:ytpl", "j:journal"]);

function allCallbacks(menus: MenuPayload[]): string[] {
  return menus.flatMap((m) => m.keyboard.inline_keyboard.flat().map((b) => b.callback_data));
}

const ALL_MENUS = (): MenuPayload[] => [
  buildMainMenu(),
  buildPersonalMenu(),
  buildHealthMenu(),
  buildLearningMenu(),
  buildViajesMenu(),
  buildYapeMenu(),
  buildCambioMenu(),
  buildFlightsMenu(),
];

describe("menu wiring integrity", () => {
  it("every callback_data across all menus is wired (NAV_MENUS, ACTION_TEXT, or mechanical)", () => {
    const unwired = allCallbacks(ALL_MENUS()).filter(
      (cb) => !(cb in NAV_MENUS) && !(cb in ACTION_TEXT) && !MECHANICAL_ELSEWHERE.has(cb),
    );
    expect(unwired).toEqual([]);
  });

  it("ningún menú excede 3 botones por fila ni 4 filas (convención de menu.ts)", () => {
    for (const menu of ALL_MENUS()) {
      expect(menu.keyboard.inline_keyboard.length).toBeLessThanOrEqual(4);
      for (const row of menu.keyboard.inline_keyboard) {
        expect(row.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it("buildMainMenu expone los 11 botones de nivel 1 acordados, en orden", () => {
    expect(allCallbacks([buildMainMenu()])).toEqual([
      "j:personal", "j:health", "j:learning",
      "j:viajes", "j:yape", "j:fx",
      "j:fuel", "j:tokens", "j:launcher",
      "j:backlog", "j:journal",
    ]);
  });

  it("buildFlightsMenu vuelve a j:viajes (queda anidado bajo Viajes, no en el nivel 1)", () => {
    const backButtonRow = buildFlightsMenu().keyboard.inline_keyboard.at(-1);
    expect(backButtonRow?.[0]?.callback_data).toBe("j:viajes");
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm run test -w @cos/daemon -- menu.test.ts`
Expected: FAIL — `buildPersonalMenu`/`buildLearningMenu`/`buildViajesMenu`/`buildYapeMenu` no
existen todavía (error de import/compilación), y `NAV_MENUS`/`ACTION_TEXT` no están exportadas.

- [ ] **Step 3: Reescribir `menu.ts` completo**

Reemplazar TODO el contenido de `daemon-v2/src/menu.ts` por:

```typescript
/**
 * menu.ts — Menú interactivo de Telegram para Jano (CoS personal de Cal).
 *
 * Convenciones:
 * - callback_data con prefijo "j:" para distinguir de callbacks legacy del worker.
 * - Parse mode: siempre HTML.
 * - Máximo 3 botones por fila, 4 filas totales.
 * - Callbacks de navegación → editMessage con sub-menú (sin LLM).
 * - Callbacks de acción → mensaje sintético en lenguaje natural → LLM.
 */

import { editMessage, answerCallbackQuery, sendMessage } from "@cos/shared";
import type { TelegramUpdate, TelegramCallbackQuery } from "@cos/shared";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface MenuPayload {
  text: string;
  keyboard: InlineKeyboardMarkup;
}

// ---------------------------------------------------------------------------
// Menús
// ---------------------------------------------------------------------------

export function buildMainMenu(): MenuPayload {
  return {
    text: "🎯 <b>¿En qué te ayudo, Cal?</b>",
    keyboard: {
      inline_keyboard: [
        [
          { text: "🏠 Personal", callback_data: "j:personal" },
          { text: "🩺 Salud", callback_data: "j:health" },
          { text: "📚 Learning", callback_data: "j:learning" },
        ],
        [
          { text: "✈️ Viajes", callback_data: "j:viajes" },
          { text: "💼 Yape", callback_data: "j:yape" },
          { text: "💰 Finanzas", callback_data: "j:fx" },
        ],
        [
          { text: "🚗 Combustible", callback_data: "j:fuel" },
          { text: "⚡ Tokens", callback_data: "j:tokens" },
          { text: "💻 Claude Launcher", callback_data: "j:launcher" },
        ],
        [
          { text: "📋 Backlog", callback_data: "j:backlog" },
          { text: "📓 Journal", callback_data: "j:journal" },
        ],
      ],
    },
  };
}

// Teclado persistente bajo el campo de texto: un botón "📋 Menú" siempre visible en el chat
// para abrir el menú principal sin escribir /menu. Se fija adjuntándolo a cualquier sendMessage.
export const MENU_REPLY_KEYBOARD = {
  keyboard: [[{ text: "📋 Menú" }]],
  resize_keyboard: true,
  is_persistent: true,
};

export function buildPersonalMenu(): MenuPayload {
  return {
    text: "🏠 <b>Personal</b> — ¿qué necesitás?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "📋 Things hoy", callback_data: "j:personal:things-today" },
          { text: "📁 Proyectos", callback_data: "j:personal:things-projects" },
          { text: "👪 Reminders", callback_data: "j:personal:reminders" },
        ],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildHealthMenu(): MenuPayload {
  return {
    text: "🏥 <b>Salud</b> — ¿Qué datos?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "📊 Resumen", callback_data: "j:health:sum" },
          { text: "📈 Tendencia", callback_data: "j:health:trend" },
          { text: "💪 Workouts", callback_data: "j:health:work" },
        ],
        [{ text: "🎯 Foco CAL", callback_data: "j:health:foco" }],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildLearningMenu(): MenuPayload {
  return {
    text: "📚 <b>Learning</b> — ¿qué necesitás?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "⭐ Starred", callback_data: "j:star" },
          { text: "🎬 Playlist", callback_data: "j:ytpl" },
          { text: "📚 Resumir", callback_data: "j:resumir" },
        ],
        [
          { text: "📋 Estado", callback_data: "j:estado" },
          { text: "✨ Readwise", callback_data: "j:learning:readwise" },
          { text: "📖 Reader", callback_data: "j:learning:reader" },
        ],
        [
          { text: "📰 Feedbin", callback_data: "j:learning:feedbin" },
          { text: "📕 Libros", callback_data: "j:learning:libros" },
        ],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildViajesMenu(): MenuPayload {
  return {
    text: "✈️ <b>Viajes</b> — ¿qué necesitás?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "✈️ Vuelos", callback_data: "j:flights" },
          { text: "🛂 QR Aduana", callback_data: "j:viajes:qr" },
          { text: "✅ Check-in BoA", callback_data: "j:viajes:boa" },
        ],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildYapeMenu(): MenuPayload {
  return {
    text: "💼 <b>Yape</b> — ¿qué necesitás?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "📊 KPI cards", callback_data: "j:yape:kpi" },
          { text: "📅 Meetings", callback_data: "j:yape:meetings" },
          { text: "🎤 PPT wizard", callback_data: "j:yape:ppt" },
        ],
        [{ text: "🌧️ Lluvia/pronóstico", callback_data: "j:yape:lluvia" }],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildCambioMenu(): MenuPayload {
  return {
    text: "💰 <b>Tipo de cambio</b> — ¿Qué tasa?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "🏦 BCB", callback_data: "j:fx:bcb" },
          { text: "💹 P2P Binance", callback_data: "j:fx:p2p" },
          { text: "📊 Ambos", callback_data: "j:fx:all" },
        ],
        [{ text: "📈 Inversiones", callback_data: "j:fx:inversiones" }],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildFlightsMenu(): MenuPayload {
  return {
    text: "✈️ <b>Vuelos</b> — ¿qué aeropuerto?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "Santa Cruz VVI", callback_data: "j:flights:vvi" },
          { text: "La Paz LPB",     callback_data: "j:flights:lpb" },
          { text: "Cochabamba CBB", callback_data: "j:flights:cbb" },
        ],
        [
          { text: "Tarija TJA",     callback_data: "j:flights:tja" },
          { text: "Sucre SRE",      callback_data: "j:flights:sre" },
          { text: "Oruro ORU",      callback_data: "j:flights:oru" },
        ],
        [{ text: "← Volver", callback_data: "j:viajes" }],
      ],
    },
  };
}

function buildFlightsDirMenu(code: string, name: string): MenuPayload {
  return {
    text: `✈️ <b>${code} · ${name}</b> — ¿salidas o llegadas?`,
    keyboard: {
      inline_keyboard: [
        [
          { text: "🛫 Salidas hoy",  callback_data: `j:flights:${code.toLowerCase()}:dep` },
          { text: "🛬 Llegadas hoy", callback_data: `j:flights:${code.toLowerCase()}:arr` },
        ],
        [{ text: "← Aeropuertos", callback_data: "j:flights" }],
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Mapeo acción → texto natural para el LLM
// ---------------------------------------------------------------------------

export const ACTION_TEXT: Record<string, string> = {
  // j:star y j:ytpl son MECÁNICOS (se interceptan en index.ts y editan el mensaje tocado como ancla).
  "j:resumir": "Quiero resumir un link o título de libro; pídeme cuál es.",
  "j:estado": "Dame el estado del resumidor: qué hay en curso y en cola (playlist y starred).",
  "j:resu:tag": "Quiero agregar uno o más tags al resumen pendiente ANTES de guardar. Preguntame en una línea qué tag(s) agregar; cuando responda, llamá mcp__cos-tools__editarPropuestaResumen con addTags. NO guardes todavía.",
  "j:resu:edit": "Quiero editar los highlights o tags del resumen pendiente. Preguntame en una línea qué cambiar; usá mcp__cos-tools__editarPropuestaResumen (setTags / removeHighlights / retag). NO guardes hasta que confirme.",
  "j:health:sum": "Dame un resumen de mi salud",
  "j:health:trend": "Muéstrame la tendencia de mi salud",
  "j:health:work": "Muéstrame mis workouts recientes",
  "j:health:foco": "Dame el estado de mi Foco CAL",
  "j:fx:bcb": "¿Cuál es el tipo de cambio BCB oficial hoy?",
  "j:fx:p2p": "¿Cuál es la tasa P2P de Binance ahora?",
  "j:fx:all": "Dame el tipo de cambio BCB oficial y P2P Binance",
  "j:fx:inversiones": "Dame el resumen de mi portafolio de inversiones",
  "j:fuel": "Muéstrame las gasolineras con combustible disponible en Santa Cruz",
  "j:tokens": "¿Cuánto presupuesto de Claude Max llevo hoy?",
  "j:launcher": "Muéstrame los proyectos del Claude Launcher",
  "j:backlog": "Muéstrame el mapa de mis backlogs",
  "j:personal:things-today": "Muéstrame mis tareas de hoy en Things",
  "j:personal:things-projects": "Muéstrame mis proyectos de Things",
  "j:personal:reminders": "Muéstrame los reminders de hoy de familia y mercado",
  "j:learning:readwise": "Dame mi daily review de Readwise",
  "j:learning:reader": "Muéstrame lo nuevo en mi inbox de Readwise Reader",
  "j:learning:feedbin": "Muéstrame lo no leído de Feedbin",
  "j:learning:libros": "Muéstrame mis libros recientes",
  "j:viajes:qr": "Quiero generar el QR de aduana de Bolivia",
  "j:viajes:boa": "Quiero hacer el check-in de mi próximo vuelo de BoA",
  "j:yape:kpi": "Muéstrame las KPI cards de Yape de hoy",
  "j:yape:meetings": "Muéstrame mis meetings",
  "j:yape:ppt": "Retoma mi último PPT wizard",
  "j:yape:lluvia": "Dame el reporte de lluvia y el pronóstico",
  "j:flights:vvi:dep": "Muéstrame las salidas de hoy desde VVI (Viru Viru, Santa Cruz)",
  "j:flights:vvi:arr": "Muéstrame las llegadas de hoy a VVI (Viru Viru, Santa Cruz)",
  "j:flights:lpb:dep": "Muéstrame las salidas de hoy desde LPB (El Alto, La Paz)",
  "j:flights:lpb:arr": "Muéstrame las llegadas de hoy a LPB (El Alto, La Paz)",
  "j:flights:cbb:dep": "Muéstrame las salidas de hoy desde CBB (Cochabamba)",
  "j:flights:cbb:arr": "Muéstrame las llegadas de hoy a CBB (Cochabamba)",
  "j:flights:tja:dep": "Muéstrame las salidas de hoy desde TJA (Tarija)",
  "j:flights:tja:arr": "Muéstrame las llegadas de hoy a TJA (Tarija)",
  "j:flights:sre:dep": "Muéstrame las salidas de hoy desde SRE (Sucre)",
  "j:flights:sre:arr": "Muéstrame las llegadas de hoy a SRE (Sucre)",
  "j:flights:oru:dep": "Muéstrame las salidas de hoy desde ORU (Oruro)",
  "j:flights:oru:arr": "Muéstrame las llegadas de hoy a ORU (Oruro)",
};

// Callbacks de navegación pura (solo editan el mensaje, sin LLM)
export const NAV_MENUS: Record<string, () => MenuPayload> = {
  "j:menu": buildMainMenu,
  "j:personal": buildPersonalMenu,
  "j:health": buildHealthMenu,
  "j:learning": buildLearningMenu,
  "j:viajes": buildViajesMenu,
  "j:yape": buildYapeMenu,
  "j:fx": buildCambioMenu,
  "j:flights": buildFlightsMenu,
  "j:flights:vvi": () => buildFlightsDirMenu("VVI", "Viru Viru (SCZ)"),
  "j:flights:lpb": () => buildFlightsDirMenu("LPB", "El Alto (LPZ)"),
  "j:flights:cbb": () => buildFlightsDirMenu("CBB", "Jorge Wilstermann"),
  "j:flights:tja": () => buildFlightsDirMenu("TJA", "Oriel Lea Plaza"),
  "j:flights:sre": () => buildFlightsDirMenu("SRE", "Alcantarí"),
  "j:flights:oru": () => buildFlightsDirMenu("ORU", "Juan Méndez"),
};

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

/**
 * Maneja callbacks con prefijo "j:".
 *
 * @param cb              - Objeto callback_query de Telegram.
 * @param token           - Bot token de Jano.
 * @param processMessageFn - Función processMessage de index.ts (para callbacks de acción).
 * @param updateId        - update_id del TelegramUpdate original.
 */
export async function handleMenuCallback(
  cb: TelegramCallbackQuery,
  token: string,
  processMessageFn: (payload: TelegramUpdate, queueWaitMs: number, opts?: { existingPlaceholderId?: number }) => Promise<void>,
  updateId: number,
): Promise<void> {
  const data = cb.data ?? "";
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;

  // Siempre dismissar el spinner de Telegram
  await answerCallbackQuery(token, cb.id);

  // --- Navegación pura ---
  if (data in NAV_MENUS) {
    if (chatId == null || messageId == null) return;
    const menu = NAV_MENUS[data]();
    await editMessage(token, chatId, messageId, menu.text, "HTML", menu.keyboard);
    return;
  }

  // --- Acción → LLM (Option B: el mensaje de menú se convierte en placeholder) ---
  const naturalText = ACTION_TEXT[data];
  if (!naturalText) return;
  if (!cb.message) return;

  const menuMsgId = cb.message.message_id;
  const actionChatId = cb.message.chat.id;

  // 1. El menú se edita a ⏳ (queda como placeholder, sin teclado)
  await editMessage(token, actionChatId, menuMsgId, "⏳ Pensando...", "HTML");

  // 2. Update sintético usando el mismo chat
  const synthetic: TelegramUpdate = {
    update_id: updateId,
    message: {
      message_id: menuMsgId,
      chat: cb.message.chat,
      date: Math.floor(Date.now() / 1000),
      text: naturalText,
      from: cb.from ? { id: cb.from.id, first_name: cb.from.first_name } : undefined,
    },
  };

  // 3. LLM reemplaza el placeholder con la respuesta
  await processMessageFn(synthetic, 0, { existingPlaceholderId: menuMsgId });
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npm run test -w @cos/daemon -- menu.test.ts`
Expected: PASS — 4/4 tests.

- [ ] **Step 5: Typecheck y build completo del daemon**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm run typecheck -w @cos/daemon
npm run test -w @cos/daemon
npm -w @cos/shared run build && npm -w @cos/daemon run build
```
Expected: sin errores en las 3 corridas (typecheck limpio, suite completa en verde — no solo
`menu.test.ts`, para confirmar que exportar `ACTION_TEXT`/`NAV_MENUS` y renombrar el target del
botón "← Volver" de Vuelos no rompió nada en otros tests), build genera `dist/` sin errores.

- [ ] **Step 6: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/menu.ts daemon-v2/src/menu.test.ts
git commit -m "feat(jano): rediseñar menú de Telegram a árbol de 2 niveles

11 botones en nivel 1 (Personal/Salud/Learning/Viajes/Yape/Finanzas +
Combustible/Tokens/Claude Launcher/Backlog/Journal), 4 submenús nuevos
(Personal, Learning, Viajes, Yape) + 2 extendidos (Salud +Foco CAL,
Finanzas +Inversiones). Expone 12 capacidades que antes solo eran
accesibles por texto. Spec/plan: docs/superpowers/specs+plans/2026-08-16-jano-telegram-menu-redesign.*"
```

---

## Verificación en producción (fuera de los tasks de código — requiere a Cal)

No es un task de esta sección porque no es código: sigue la norma ya establecida en este repo
(`CLAUDE.md` → "Comandos operativos" y regla dura de confirmar restarts).

1. Restart del daemon **con confirmación explícita de Cal antes de ejecutarlo**:
   ```bash
   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
   ```
2. Arranque limpio verificado en logs: `tail -n 50 ~/Library/Logs/cos-agent-v2.{out,err}.log`.
3. Prueba real por Telegram: abrir `/menu`, entrar a cada una de las 6 categorías con submenú
   (Personal, Salud, Learning, Viajes, Yape, Finanzas), tocar al menos un botón nuevo de cada una
   y confirmar que dispara la respuesta esperada. Confirmar que `⭐ Starred`/`🎬 Playlist`
   (ahora dentro de Learning) y `📓 Journal` (nivel 1, sin cambios) siguen funcionando igual que
   antes del rediseño — son los 3 casos mecánicos que no pasaron por ninguna prueba automatizada.
   Confirmar que Vuelos → "← Volver" ahora cae en Viajes, no en el menú principal.

## Self-Review

**Cobertura del spec:** las 8 secciones de nivel 2 del spec (Personal, Salud+Foco, Learning,
Viajes, Yape, Finanzas+Inversiones, nivel 1 con Combustible/Tokens/Claude
Launcher/Backlog/Journal, y el reancla de Vuelos→Viajes) están todas en el Task 1 — un solo
archivo, un solo task, sin fragmentación artificial porque es una reescritura cohesiva de una
única estructura de datos.

**Placeholders:** ninguno — código completo en cada step, incluido el archivo entero de
`menu.ts` (no un diff parcial, para que quien ejecute no tenga que adivinar cómo integrar los
fragmentos).

**Consistencia de tipos:** `MenuPayload`/`InlineKeyboardButton`/`InlineKeyboardMarkup` no
cambian. Las 4 funciones nuevas (`buildPersonalMenu`/`buildLearningMenu`/`buildViajesMenu`/
`buildYapeMenu`) siguen exactamente la firma `(): MenuPayload` de las 3 existentes. Los nombres
de `callback_data` en el test (`menu.test.ts`) son un match literal contra los mismos strings
usados en `menu.ts` — verificado dato por dato al escribir el plan, no solo por convención de
nombre.

**Fuera de alcance (no tocado por este plan):** `index.ts` (el despacho genérico y los 3 casos
mecánicos ya cubren el nuevo árbol sin cambios), `agent-tools.ts`/`agent-options.ts` (ningún
tool nuevo — todos los botones nuevos disparan tools que YA existen y ya están en la
allowlist), cualquier otro archivo de `daemon-v2`.
