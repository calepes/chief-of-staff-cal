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
  buildAchoradazosMenu,
  buildExpenseJunteMenu,
  beginExpenseJunteSelection,
  beginExpenseJunteNameInput,
  consumeExpenseJunteNameInput,
  selectExpenseJunte,
  consumeExpenseJunteSelection,
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
  buildAchoradazosMenu(),
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

  it("buildMainMenu expone Achoradazos en el espacio libre del nivel 1", () => {
    expect(allCallbacks([buildMainMenu()])).toEqual([
      "j:personal", "j:health", "j:learning",
      "j:viajes", "j:yape", "j:fx",
      "j:fuel", "j:tokens", "j:launcher",
      "j:backlog", "j:journal",
      "j:achoradazos",
    ]);
  });

  it("buildAchoradazosMenu expone cobros, juntes y operaciones", () => {
    expect(allCallbacks([buildAchoradazosMenu()])).toEqual([
      "j:achoradazos:cobros", "j:achoradazos:juntes",
      "j:achoradazos:pago", "j:achoradazos:nuevo-cobro",
      "j:achoradazos:gasto", "j:achoradazos:nuevo-junte", "j:menu",
    ]);
  });

  it("ubica Registrar gasto junto a Nuevo junte", () => {
    const expenseRow = buildAchoradazosMenu().keyboard.inline_keyboard[2];
    expect(expenseRow.map((button) => button.callback_data)).toEqual([
      "j:achoradazos:gasto",
      "j:achoradazos:nuevo-junte",
    ]);
  });

  it("exige elegir un junte antes de continuar el gasto", () => {
    beginExpenseJunteSelection(94137698, [{ id: "recEvento1", nombre: "9va Reunión" }]);
    expect(selectExpenseJunte(94137698, "recEvento1")).toBe(true);
    expect(consumeExpenseJunteSelection(94137698)).toEqual({ id: "recEvento1", nombre: "9va Reunión" });
    expect(consumeExpenseJunteSelection(94137698)).toBeUndefined();
  });

  it("vence una selección de junte que no se usa", () => {
    beginExpenseJunteSelection(94137699, [{ id: "recEvento2", nombre: "8va Reunión" }]);
    expect(selectExpenseJunte(94137699, "recEvento2", 1_000)).toBe(true);
    expect(consumeExpenseJunteSelection(94137699, 15 * 60_000 + 1_001)).toBeUndefined();
  });

  it("rechaza botones de un selector de junte vencido", () => {
    beginExpenseJunteSelection(94137701, [{ id: "recEvento4", nombre: "7ma Reunión" }], 1_000);
    expect(selectExpenseJunte(94137701, "recEvento4", 15 * 60_000 + 1_001)).toBe(false);
    expect(beginExpenseJunteNameInput(94137701, 15 * 60_000 + 1_001)).toBe(false);
  });

  it("permite escribir otro junte sin omitir la selección explícita", () => {
    beginExpenseJunteSelection(94137700, [{ id: "recEvento3", nombre: "Reunión Ñuñoa" }]);
    expect(beginExpenseJunteNameInput(94137700)).toBe(true);
    expect(consumeExpenseJunteNameInput(94137700, "reunion nunoa")).toEqual({ id: "recEvento3", nombre: "Reunión Ñuñoa" });
    expect(consumeExpenseJunteSelection(94137700)).toEqual({ id: "recEvento3", nombre: "Reunión Ñuñoa" });
  });

  it("muestra juntes disponibles y permite cancelar el gasto", () => {
    const menu = buildExpenseJunteMenu([
      { id: "recEvento1", nombre: "9va Reunión" },
      { id: "recEvento2", nombre: "8va Reunión" },
    ]);
    expect(allCallbacks([menu])).toEqual([
      "j:achoradazos:gasto:junte:recEvento1",
      "j:achoradazos:gasto:junte:recEvento2",
      "j:achoradazos:gasto:otro",
      "j:achoradazos:gasto:cancelar",
    ]);
  });

  it("buildFlightsMenu vuelve a j:viajes (queda anidado bajo Viajes, no en el nivel 1)", () => {
    const backButtonRow = buildFlightsMenu().keyboard.inline_keyboard.at(-1);
    expect(backButtonRow?.[0]?.callback_data).toBe("j:viajes");
  });
});
