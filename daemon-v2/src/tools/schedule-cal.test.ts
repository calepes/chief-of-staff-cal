import { describe, it, expect } from "vitest";
import { parseVacacion } from "./schedule-cal.js";

function makePage(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-page-id",
    url: "https://notion.so/test",
    properties: {
      Name: { title: [{ plain_text: "Vacaciones Lima" }] },
      "Fecha ": { date: { start: "2025-07-15", end: "2025-07-22" } },
      Status: { select: { name: "Not started" } },
      Clase: { select: { name: "Viaje" } },
      Tipo: { multi_select: [{ name: "Vacaciones" }, { name: "Internacional" }] },
      "Año Vacaciones": { select: { name: "2025 - 2026" } },
      " D. Vacas": { rollup: { type: "number", number: 7 } },
      Pais: { rollup: { type: "array", array: [{ select: { name: "Perú" } }] } },
      "Ppto US$": { formula: { type: "number", number: 580 } },
      "Registro Vacaciones": { checkbox: true },
      ...overrides,
    },
  };
}

describe("parseVacacion", () => {
  it("extrae name correctamente", () => {
    expect(parseVacacion(makePage()).name).toBe("Vacaciones Lima");
  });

  it("extrae pageId y url", () => {
    const r = parseVacacion(makePage());
    expect(r.pageId).toBe("test-page-id");
    expect(r.url).toBe("https://notion.so/test");
  });

  it("extrae fecha con rango", () => {
    const r = parseVacacion(makePage());
    expect(r.fecha?.start).toBe("2025-07-15");
    expect(r.fecha?.end).toBe("2025-07-22");
  });

  it("extrae status y clase", () => {
    const r = parseVacacion(makePage());
    expect(r.status).toBe("Not started");
    expect(r.clase).toBe("Viaje");
  });

  it("extrae tipo como array de strings", () => {
    expect(parseVacacion(makePage()).tipo).toEqual(["Vacaciones", "Internacional"]);
  });

  it("extrae anoVacaciones", () => {
    expect(parseVacacion(makePage()).anoVacaciones).toBe("2025 - 2026");
  });

  it("extrae diasVacas del rollup number", () => {
    expect(parseVacacion(makePage()).diasVacas).toBe(7);
  });

  it("extrae pais del rollup array", () => {
    expect(parseVacacion(makePage()).pais).toBe("Perú");
  });

  it("extrae pptoUsd de formula", () => {
    expect(parseVacacion(makePage()).pptoUsd).toBe(580);
  });

  it("extrae registroVacaciones checkbox", () => {
    expect(parseVacacion(makePage()).registroVacaciones).toBe(true);
  });

  it("maneja fecha null → undefined", () => {
    const r = parseVacacion(makePage({ "Fecha ": { date: null } }));
    expect(r.fecha).toBeUndefined();
  });

  it("maneja rollup de dias con null → undefined", () => {
    const r = parseVacacion(
      makePage({ " D. Vacas": { rollup: { type: "number", number: null } } })
    );
    expect(r.diasVacas).toBeUndefined();
  });

  it("maneja pais vacío en rollup array → undefined", () => {
    const r = parseVacacion(
      makePage({ Pais: { rollup: { type: "array", array: [] } } })
    );
    expect(r.pais).toBeUndefined();
  });
});
