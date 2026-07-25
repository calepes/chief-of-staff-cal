import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LOGO_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "kpi-card", "yape-logo.png");
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

// --- Tokens: primitivo → semántico → componente ---------------------------

const primitive = {
  purple900: "#3D0F63",
  purple600: "#7A1FA2",
  gray900: "#1A1A1A",
  gray500: "#777777",
  gray300: "#B3B3B3",
  gray200: "#E5E5E5",
  green600: "#1B8A3D",
  red600: "#CC2222",
  white: "#FFFFFF",
} as const;

const semantic = {
  colorBrand: primitive.purple600,
  colorText: primitive.gray900,
  colorTextMuted: primitive.gray500,
  colorTextFaint: primitive.gray300,
  colorBorder: primitive.gray200,
  colorPositive: primitive.green600,
  colorNegative: primitive.red600,
  colorSurface: primitive.white,
} as const;

const space = { xs: 8, sm: 16, md: 24, lg: 48, xl: 64, xxl: 96 } as const;

const font = {
  label: "bold 34px sans-serif",
  valueMaxPx: 190,
  valueMinPx: 110,
  delta: "bold 40px sans-serif",
  deltaUnit: "30px sans-serif",
  caption: "26px sans-serif",
  heading: "bold 32px sans-serif",
  meta: "44px sans-serif",
} as const;

const card = {
  size: 1080,
  radius: 48,
  padding: space.xl,
} as const;

export interface DailyKpis {
  trx: number;
  trxPctChange: number | null;
  activosDau: number;
  activosDauPctChange: number | null;
  /** ISO yyyy-mm-dd */
  fecha: string;
}

export async function renderKpiCardImage(kpis: DailyKpis): Promise<Buffer> {
  const canvas = createCanvas(card.size, card.size);
  const ctx = canvas.getContext("2d");

  // Fondo del canvas ENTERO primero — el canvas nace transparente, y las 4 esquinas fuera de
  // la curva de roundRect() nunca se pintaban (quedaban transparentes → Telegram las mostraba
  // negras). El roundRect de abajo queda solo como borde decorativo, ya no como relleno.
  ctx.fillStyle = semantic.colorSurface;
  ctx.fillRect(0, 0, card.size, card.size);
  ctx.beginPath();
  ctx.roundRect(0, 0, card.size, card.size, card.radius);
  ctx.strokeStyle = semantic.colorBorder;
  ctx.lineWidth = 2;
  ctx.stroke();

  const logo = await loadImage(LOGO_PATH);
  const logoHeight = 245;
  const logoWidth = (logo.width / logo.height) * logoHeight;
  ctx.drawImage(logo, card.padding, card.padding, logoWidth, logoHeight);

  ctx.fillStyle = semantic.colorTextFaint;
  ctx.font = font.meta;
  ctx.textAlign = "right";
  ctx.fillText(formatFecha(kpis.fecha), card.size - card.padding, 195);

  ctx.fillStyle = semantic.colorBrand;
  ctx.textAlign = "left";
  ctx.font = font.heading;
  ctx.fillText("Foco diario · Yape Bolivia", card.padding, 364);

  ctx.strokeStyle = "#ECE7F2";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(card.padding, 400);
  ctx.lineTo(card.size - card.padding, 400);
  ctx.stroke();

  // Dos columnas, mismo peso visual — sin cajas de fondo (Concepto B, aprobado por Cal).
  const zoneTop = 400;
  const zoneBottom = card.size - card.padding;
  const blockHeight = 460;
  const blockTop = zoneTop + (zoneBottom - zoneTop - blockHeight) / 2;

  const colGap = space.xl;
  const colWidth = (card.size - card.padding * 2 - colGap) / 2;
  const col1X = card.padding;
  const col2X = col1X + colWidth + colGap;

  // Mismo tamaño de fuente para los dos valores — simetría visual entre KPIs,
  // aunque "12.4M" (5 caracteres) sea más ancho que "8.7M" (4 caracteres).
  const trxText = formatValue(kpis.trx);
  const dauText = formatValue(kpis.activosDau);
  const sharedValuePx = Math.min(
    fitFontSize(ctx, trxText, colWidth, font.valueMaxPx, font.valueMinPx),
    fitFontSize(ctx, dauText, colWidth, font.valueMaxPx, font.valueMinPx),
  );

  drawColumn(ctx, col1X, blockTop, "Transacciones", trxText, sharedValuePx, kpis.trxPctChange);
  drawColumn(ctx, col2X, blockTop, "Activos DAU", dauText, sharedValuePx, kpis.activosDauPctChange);

  const dividerX = col1X + colWidth + colGap / 2;
  ctx.strokeStyle = semantic.colorBorder;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(dividerX, blockTop);
  ctx.lineTo(dividerX, blockTop + blockHeight - 60);
  ctx.stroke();

  ctx.fillStyle = semantic.colorTextMuted;
  ctx.font = font.caption;
  ctx.textAlign = "center";
  ctx.fillText("vs. semana anterior", card.size / 2, blockTop + blockHeight);

  return canvas.toBuffer("image/png");
}

function formatFecha(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const dow = DIAS[new Date(year, month - 1, day).getDay()];
  return `${dow} ${day} ${MESES[month - 1]}`;
}

function formatValue(raw: number): string {
  return `${(raw / 1_000_000).toFixed(2)}M`;
}

function drawColumn(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  label: string,
  valueText: string,
  valueFontPx: number,
  pctChange: number | null,
): void {
  ctx.textAlign = "left";

  ctx.fillStyle = semantic.colorTextMuted;
  ctx.font = font.label;
  ctx.letterSpacing = "1.5px";
  ctx.fillText(label.toUpperCase(), x, y);
  ctx.letterSpacing = "0px";

  ctx.fillStyle = semantic.colorText;
  ctx.font = `bold ${valueFontPx}px sans-serif`;
  const valueBaseline = y + 40 + valueFontPx * 0.86;
  ctx.fillText(valueText, x, valueBaseline);

  if (pctChange !== null) {
    const isNegative = pctChange < 0;
    const arrow = isNegative ? "▼" : "▲";
    const deltaText = `${arrow} ${pctChange >= 0 ? "+" : ""}${(pctChange * 100).toFixed(1)}%`;
    const deltaY = valueBaseline + 64;

    ctx.fillStyle = isNegative ? semantic.colorNegative : semantic.colorPositive;
    ctx.font = font.delta;
    ctx.fillText(deltaText, x, deltaY);

    const deltaWidth = ctx.measureText(deltaText).width;
    ctx.fillStyle = semantic.colorTextMuted;
    ctx.font = font.deltaUnit;
    ctx.fillText("WoW", x + deltaWidth + space.xs, deltaY);
  }
}

/** Reduce el tamaño de fuente hasta que el texto entre en colWidth, sin bajar de minPx. */
function fitFontSize(ctx: SKRSContext2D, text: string, colWidth: number, maxPx: number, minPx: number): number {
  let size = maxPx;
  while (size > minPx) {
    ctx.font = `bold ${size}px sans-serif`;
    if (ctx.measureText(text).width <= colWidth) break;
    size -= 4;
  }
  return size;
}
