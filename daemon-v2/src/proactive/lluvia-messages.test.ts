import { describe, it, expect } from "vitest";
import { buildLluviaMessages, type CiudadDiaResultado } from "./lluvia-messages.js";

function resultado(overrides: Partial<CiudadDiaResultado> = {}): CiudadDiaResultado {
  return {
    ciudad: "Cochabamba",
    ok: true,
    total: 0,
    categoria: null,
    percentil: null,
    maxHist: null,
    ...overrides,
  };
}

describe("buildLluviaMessages — reporte", () => {
  it("lista las 3 ciudades con mm y categoría", () => {
    const { reporte } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Santa Cruz (centro)", total: 12.4, categoria: "Normal" }),
      resultado({ ciudad: "Cochabamba", total: 0 }),
      resultado({ ciudad: "La Paz", total: 3.1, categoria: "Poca" }),
    ]);
    expect(reporte).toContain("Santa Cruz (centro)");
    expect(reporte).toContain("12.4 mm");
    expect(reporte).toContain("Normal");
    expect(reporte).toContain("2026-08-16");
  });

  it("muestra 'sin dato' para una ciudad sin total", () => {
    const { reporte } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Cochabamba", ok: false, total: null, error: "http 500" }),
    ]);
    expect(reporte).toContain("sin dato");
  });
});

describe("buildLluviaMessages — confirmación", () => {
  it("reporta éxito si las 3 ciudades tienen dato", () => {
    const { confirmacion } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Santa Cruz (centro)" }),
      resultado({ ciudad: "Cochabamba" }),
      resultado({ ciudad: "La Paz" }),
    ]);
    expect(confirmacion).toContain("✅");
    expect(confirmacion).not.toContain("⚠️");
  });

  it("reporta falla con el detalle cuando el fetch de una ciudad dio error HTTP", () => {
    const { confirmacion } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Santa Cruz (centro)" }),
      resultado({ ciudad: "Cochabamba", ok: false, total: null, error: "http 500" }),
      resultado({ ciudad: "La Paz" }),
    ]);
    expect(confirmacion).toContain("⚠️");
    expect(confirmacion).toContain("Cochabamba");
    expect(confirmacion).toContain("http 500");
  });

  it("reporta falla cuando el fetch fue ok pero no hay dato de hoy (total null)", () => {
    const { confirmacion } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Santa Cruz (centro)" }),
      resultado({ ciudad: "Cochabamba", ok: true, total: null }),
      resultado({ ciudad: "La Paz" }),
    ]);
    expect(confirmacion).toContain("⚠️");
    expect(confirmacion).toContain("Cochabamba");
    expect(confirmacion).toContain("sin dato de hoy");
  });
});

describe("buildLluviaMessages — alerta", () => {
  it("no dispara si ninguna ciudad pasa Considerable", () => {
    const { alerta } = buildLluviaMessages("2026-08-16", [
      resultado({ categoria: "Normal" }),
      resultado({ categoria: "Poca" }),
      resultado({ categoria: null }),
    ]);
    expect(alerta).toBeNull();
  });

  it("dispara desde Considerable en adelante", () => {
    const { alerta } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Cochabamba", total: 45, categoria: "Considerable", percentil: 82 }),
    ]);
    expect(alerta).not.toBeNull();
    expect(alerta).toContain("Cochabamba");
    expect(alerta).toContain("Considerable");
    expect(alerta).toContain("82");
  });

  it("incluye todas las ciudades que dispararon, no solo la primera", () => {
    const { alerta } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Cochabamba", categoria: "Fuerte" }),
      resultado({ ciudad: "La Paz", categoria: "Excepcional" }),
      resultado({ ciudad: "Santa Cruz (centro)", categoria: "Normal" }),
    ]);
    expect(alerta).toContain("Cochabamba");
    expect(alerta).toContain("La Paz");
    expect(alerta).not.toContain("Santa Cruz (centro):");
  });
});

describe("buildLluviaMessages — escaping", () => {
  it("escapa HTML en ciudad/categoria/error (regresión del fix f2f98ec)", () => {
    const { reporte, confirmacion, alerta } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "<script>", categoria: "Considerable", total: 50, percentil: 90 }),
      resultado({ ciudad: "Cochabamba", ok: false, total: null, error: "<b>boom</b> & fail" }),
    ]);
    expect(reporte).toContain("&lt;script&gt;");
    expect(reporte).not.toContain("<script>");
    expect(confirmacion).toContain("&lt;b&gt;boom&lt;/b&gt; &amp; fail");
    expect(confirmacion).not.toContain("<b>boom</b>");
    expect(alerta).toContain("&lt;script&gt;");
    expect(alerta).not.toContain("<script>");
  });
});
