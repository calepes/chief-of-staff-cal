import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LOGO_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "kpi-card", "yape-logo.png");
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

// Mismos tokens que kpi-card-image.ts (duplicados a propósito, no importados — mismo criterio de
// independencia entre pipelines que kpi-lending-notion.ts vs. kpi-ingest-notion.ts).
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
  labelPx: 26,
  labelLineHeight: 32,
  // Más angosto que kpi-card-image.ts (190/110): 3 columnas en vez de 2, y "Vistos" puede llegar
  // a 6 cifras — necesita más margen para achicarse sin desbordar la columna.
  valueMaxPx: 160,
  valueMinPx: 70,
  delta: "bold 34px sans-serif",
  deltaUnit: "26px sans-serif",
  caption: "26px sans-serif",
  heading: "bold 32px sans-serif",
  meta: "44px sans-serif",
} as const;

const card = {
  size: 1080,
  radius: 48,
  padding: space.xl,
} as const;

export interface LendingCardKpis {
  vistos: number;
  /** Incremento (resta simple, no %) vs. el registro anterior más reciente CON dato para este
   * campo — no necesariamente D-1 exacto (los huecos de reporte, ej. 24-25 jul, son reales y
   * frecuentes). `null` solo si no existe NINGÚN registro previo con dato (primer registro). */
  vistosDelta: number | null;
  /** Fecha ISO del registro contra el que se comparó `vistosDelta` — permite mostrar "vs. 23 jul"
   * en vez de "día" cuando la comparación no es realmente contra el día calendario anterior. */
  vistosCompareFecha: string | null;
  derivados: number;
  derivadosDelta: number | null;
  derivadosCompareFecha: string | null;
  desembolso: number;
  desembolsoDelta: number | null;
  desembolsoCompareFecha: string | null;
  /** ISO yyyy-mm-dd */
  fecha: string;
}

export async function renderKpiCardLendingImage(kpis: LendingCardKpis): Promise<Buffer> {
  const canvas = createCanvas(card.size, card.size);
  const ctx = canvas.getContext("2d");

  // Mismo fix de esquinas que kpi-card-image.ts: pintar el canvas ENTERO antes del roundRect
  // decorativo — si no, las 4 esquinas fuera de la curva quedan transparentes y Telegram las
  // muestra negras.
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
  ctx.fillText("Funnel Piloto Lending Híbrido", card.padding, 364);

  ctx.strokeStyle = "#ECE7F2";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(card.padding, 400);
  ctx.lineTo(card.size - card.padding, 400);
  ctx.stroke();

  const zoneTop = 400;
  const zoneBottom = card.size - card.padding;
  const blockHeight = 460;
  const blockTop = zoneTop + (zoneBottom - zoneTop - blockHeight) / 2;

  // 3 columnas en orden de funnel (Vistos → Derivados Agencia → Desembolsos) — a diferencia de
  // kpi-card-image.ts (2 columnas), acá van 2 gaps/divisores en vez de 1.
  const colGap = space.lg;
  const colWidth = (card.size - card.padding * 2 - colGap * 2) / 3;
  const col1X = card.padding;
  const col2X = col1X + colWidth + colGap;
  const col3X = col2X + colWidth + colGap;

  const vistosText = formatValue(kpis.vistos);
  const derivadosText = formatValue(kpis.derivados);
  const desembolsoText = formatValue(kpis.desembolso);
  const sharedValuePx = Math.min(
    fitFontSize(ctx, vistosText, colWidth, font.valueMaxPx, font.valueMinPx),
    fitFontSize(ctx, derivadosText, colWidth, font.valueMaxPx, font.valueMinPx),
    fitFontSize(ctx, desembolsoText, colWidth, font.valueMaxPx, font.valueMinPx),
  );

  drawColumn(ctx, col1X, blockTop, "Ofertas Vistas", vistosText, sharedValuePx, kpis.vistosDelta, compareLabel(kpis.fecha, kpis.vistosCompareFecha), colWidth);
  drawColumn(
    ctx,
    col2X,
    blockTop,
    "Derivados Agencia",
    derivadosText,
    sharedValuePx,
    kpis.derivadosDelta,
    compareLabel(kpis.fecha, kpis.derivadosCompareFecha),
    colWidth,
  );
  drawColumn(
    ctx,
    col3X,
    blockTop,
    "Desembolsos",
    desembolsoText,
    sharedValuePx,
    kpis.desembolsoDelta,
    compareLabel(kpis.fecha, kpis.desembolsoCompareFecha),
    colWidth,
  );

  ctx.strokeStyle = semantic.colorBorder;
  ctx.lineWidth = 2;
  for (const dividerX of [col1X + colWidth + colGap / 2, col2X + colWidth + colGap / 2]) {
    ctx.beginPath();
    ctx.moveTo(dividerX, blockTop);
    ctx.lineTo(dividerX, blockTop + blockHeight - 60);
    ctx.stroke();
  }

  return canvas.toBuffer("image/png");
}

function formatFecha(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const dow = DIAS[new Date(year, month - 1, day).getDay()];
  return `${dow} ${day} ${MESES[month - 1]}`;
}

function formatShortDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MESES[month - 1]}`;
}

// La leyenda global "vs. día anterior" de la primera versión asumía que las 3 columnas siempre
// comparan contra el mismo día — deja de ser cierto ahora que cada campo busca su propio dato
// previo más reciente (pueden divergir si un campo puntual quedó null en una fecha intermedia).
// Por eso cada columna lleva su PROPIA etiqueta: "día" si la comparación es realmente D-1, o la
// fecha corta ("23 jul") si el hueco de reporte hizo que la comparación saltara más atrás.
export function compareLabel(fecha: string, compareFecha: string | null): string {
  if (!compareFecha) return "";
  const diffDays = Math.round((Date.parse(`${fecha}T00:00:00Z`) - Date.parse(`${compareFecha}T00:00:00Z`)) / 86_400_000);
  return diffDays === 1 ? "día" : formatShortDate(compareFecha);
}

// A diferencia de kpi-card-image.ts (TRX/DAU en millones), el funnel de Lending trabaja con
// conteos chicos (decenas a miles). Bajo 1000 se muestra el entero tal cual (ej. "384"); desde
// 1000 se abrevia a K con 2 decimales (ej. "9.52K") — más corto que el separador de miles y
// consistente con cómo el propio dashboard de Power BI abrevia sus gauges de cabecera.
function formatValue(raw: number): string {
  if (raw < 1000) return String(raw);
  return `${(raw / 1000).toFixed(2)}K`;
}

// Reservado SIEMPRE a 2 líneas (el peor caso, "DERIVADOS AGENCIA") para las 3 columnas — así el
// valor arranca a la misma altura en las 3 sin importar si su propia label wrappeó o no.
const LABEL_RESERVED_LINES = 2;

/** Wrap greedy por palabra — labels de 1-2 palabras alcanza con 1 palabra por línea si no entra. */
function wrapLabel(ctx: SKRSContext2D, label: string, maxWidth: number): string[] {
  if (ctx.measureText(label).width <= maxWidth) return [label];
  const words = label.split(" ");
  if (words.length <= 1) return [label]; // una sola palabra larga: no hay wrap posible, se deja
  return words;
}

function drawColumn(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  label: string,
  valueText: string,
  valueFontPx: number,
  delta: number | null,
  deltaCompareLabel: string,
  colWidth: number,
): void {
  ctx.textAlign = "left";

  ctx.fillStyle = semantic.colorTextMuted;
  ctx.font = `bold ${font.labelPx}px sans-serif`;
  ctx.letterSpacing = "1.5px";
  const labelLines = wrapLabel(ctx, label.toUpperCase(), colWidth);
  labelLines.forEach((line, i) => ctx.fillText(line, x, y + i * font.labelLineHeight));
  ctx.letterSpacing = "0px";

  const reservedLabelHeight = LABEL_RESERVED_LINES * font.labelLineHeight;

  ctx.fillStyle = semantic.colorText;
  ctx.font = `bold ${valueFontPx}px sans-serif`;
  const valueBaseline = y + reservedLabelHeight + valueFontPx * 0.86;
  ctx.fillText(valueText, x, valueBaseline);

  if (delta !== null) {
    const isNegative = delta < 0;
    const arrow = isNegative ? "▼" : "▲";
    // Incremento D-1 es una resta simple (no %) — formato "▲ +6", no "▲ +6%".
    const deltaText = `${arrow} ${delta >= 0 ? "+" : ""}${delta}`;
    const deltaY = valueBaseline + 64;

    ctx.fillStyle = isNegative ? semantic.colorNegative : semantic.colorPositive;
    ctx.font = font.delta;
    ctx.fillText(deltaText, x, deltaY);

    const deltaWidth = ctx.measureText(deltaText).width;
    ctx.fillStyle = semantic.colorTextMuted;
    ctx.font = font.deltaUnit;
    ctx.fillText(deltaCompareLabel, x + deltaWidth + space.xs, deltaY);
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
