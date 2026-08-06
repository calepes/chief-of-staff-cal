import { describe, it, expect } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderKpiCardLendingImage, compareLabel } from "./kpi-card-lending-image.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("compareLabel", () => {
  it("devuelve 'día' cuando la comparación es realmente contra el día calendario anterior", () => {
    expect(compareLabel("2026-07-23", "2026-07-22")).toBe("día");
  });

  it("devuelve la fecha corta cuando el hueco de reporte hizo saltar la comparación más atrás", () => {
    expect(compareLabel("2026-07-26", "2026-07-23")).toBe("23 jul");
  });

  it("devuelve string vacío si no hay ninguna comparación (compareFecha null)", () => {
    expect(compareLabel("2026-07-21", null)).toBe("");
  });
});

describe("renderKpiCardLendingImage", () => {
  it("devuelve un PNG válido con los 4 KPIs y sus incrementos", async () => {
    const png = await renderKpiCardLendingImage({
      derivados: 435,
      derivadosDelta: -12,
      derivadosCompareFecha: "2026-07-25",
      agencia: 120,
      agenciaDelta: 8,
      agenciaCompareFecha: "2026-07-25",
      enProcesoAgencia: 42,
      enProcesoAgenciaDelta: 3,
      enProcesoAgenciaCompareFecha: "2026-07-25",
      desembolso: 85,
      desembolsoDelta: 7,
      desembolsoCompareFecha: "2026-07-25",
      fecha: "2026-07-26",
    });

    expect(png.length).toBeGreaterThan(0);
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it("no revienta si los incrementos vienen null (sin registro D-1 real)", async () => {
    const png = await renderKpiCardLendingImage({
      derivados: 435,
      derivadosDelta: null,
      derivadosCompareFecha: null,
      agencia: 120,
      agenciaDelta: null,
      agenciaCompareFecha: null,
      enProcesoAgencia: 42,
      enProcesoAgenciaDelta: null,
      enProcesoAgenciaCompareFecha: null,
      desembolso: 85,
      desembolsoDelta: null,
      desembolsoCompareFecha: null,
      fecha: "2026-07-26",
    });

    expect(png.length).toBeGreaterThan(0);
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it("no deja las esquinas transparentes (mismo fix que kpi-card-image.ts)", async () => {
    const png = await renderKpiCardLendingImage({
      derivados: 435,
      derivadosDelta: -12,
      derivadosCompareFecha: "2026-07-25",
      agencia: 120,
      agenciaDelta: 8,
      agenciaCompareFecha: "2026-07-25",
      enProcesoAgencia: 42,
      enProcesoAgenciaDelta: 3,
      enProcesoAgenciaCompareFecha: "2026-07-25",
      desembolso: 85,
      desembolsoDelta: 7,
      desembolsoCompareFecha: "2026-07-25",
      fecha: "2026-07-26",
    });

    const img = await loadImage(png);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    expect(a).toBe(255);
    expect([r, g, b]).toEqual([255, 255, 255]);
  });
});
