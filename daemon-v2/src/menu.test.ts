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
