import { describe, it, expect } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderKpiCardImage } from "./kpi-card-image.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("renderKpiCardImage", () => {
  it("devuelve un PNG válido con ambos KPIs y sus variaciones", async () => {
    const png = await renderKpiCardImage({
      trx: 12_400_000,
      trxPctChange: 0.032,
      activosDau: 8_700_000,
      activosDauPctChange: -0.011,
      fecha: "2026-07-17",
    });

    expect(png.length).toBeGreaterThan(0);
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it("no revienta si las variaciones % vienen null", async () => {
    const png = await renderKpiCardImage({
      trx: 12_400_000,
      trxPctChange: null,
      activosDau: 8_700_000,
      activosDauPctChange: null,
      fecha: "2026-07-17",
    });

    expect(png.length).toBeGreaterThan(0);
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it("no deja las esquinas transparentes (Telegram las renderizaba negras)", async () => {
    const png = await renderKpiCardImage({
      trx: 12_400_000,
      trxPctChange: 0.032,
      activosDau: 8_700_000,
      activosDauPctChange: -0.011,
      fecha: "2026-07-17",
    });

    const img = await loadImage(png);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    // (0,0) cae afuera de la curva del roundRect — el pixel exacto de la esquina.
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    expect(a).toBe(255); // opaco — antes del fix quedaba transparente (a=0)
    expect([r, g, b]).toEqual([255, 255, 255]); // blanco, no negro
  });
});
