import { describe, it, expect } from "vitest";
import { buildInformeReportText } from "./research-competencia-notion.js";
import type { EntityRunResult } from "./research-competencia-types.js";

function entityResult(overrides: Partial<EntityRunResult>): EntityRunResult {
  return {
    entityId: "x", entityNombre: "Entidad X", primeraCorrida: false, hallazgos: [],
    snapshot: { entityId: "x", updatedAt: "2026-08-31T00:00:00Z" },
    ...overrides,
  };
}

describe("buildInformeReportText", () => {
  it("marca primera corrida sin comparación", () => {
    const text = buildInformeReportText("2026-08-31", 7, [entityResult({ primeraCorrida: true })]);
    expect(text).toContain("Primera corrida");
  });

  it("primera corrida con hallazgos los muestra igual, marcados como iniciales", () => {
    const text = buildInformeReportText("2026-08-31", 7, [
      entityResult({
        primeraCorrida: true,
        hallazgos: [{ dimension: "Hiring", descripcion: "Nuevo rol de UX abierto", fuente: "https://linkedin.com/x" }],
      }),
    ]);
    expect(text).toContain("Primera corrida");
    expect(text).toContain("[Hiring] Nuevo rol de UX abierto (https://linkedin.com/x)");
  });

  it("marca sin novedades cuando no hay hallazgos", () => {
    const text = buildInformeReportText("2026-08-31", 7, [entityResult({})]);
    expect(text).toContain("Sin novedades");
  });

  it("lista cada hallazgo con su dimensión", () => {
    const text = buildInformeReportText("2026-08-31", 7, [
      entityResult({ hallazgos: [{ dimension: "Producto", descripcion: "Nueva versión 3.2", fuente: "https://x.com" }] }),
    ]);
    expect(text).toContain("[Producto] Nueva versión 3.2 (https://x.com)");
  });

  it("muestra el error si la entidad falló", () => {
    const text = buildInformeReportText("2026-08-31", 7, [entityResult({ error: "timeout" })]);
    expect(text).toContain("Error en esta corrida: timeout");
  });
});
