import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIZE = 1080;
const LOGO_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "kpi-card", "yape-logo.png");
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export interface DailyKpis {
  trx: number;
  trxPctChange: number | null;
  activosDau: number;
  activosDauPctChange: number | null;
  /** ISO yyyy-mm-dd */
  fecha: string;
}

export async function renderKpiCardImage(kpis: DailyKpis): Promise<Buffer> {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.roundRect(0, 0, SIZE, SIZE, 48);
  ctx.fill();
  ctx.strokeStyle = "#E5E5E5";
  ctx.lineWidth = 2;
  ctx.stroke();

  const logo = await loadImage(LOGO_PATH);
  const logoHeight = 90;
  const logoWidth = (logo.width / logo.height) * logoHeight;
  ctx.drawImage(logo, 64, 64, logoWidth, logoHeight);

  ctx.fillStyle = "#999999";
  ctx.font = "28px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(formatFecha(kpis.fecha), SIZE - 64, 110);

  ctx.fillStyle = "#7A1FA2";
  ctx.textAlign = "left";
  ctx.font = "bold 32px sans-serif";
  ctx.fillText("Foco diario · Yape Bolivia", 64, 210);

  drawTile(ctx, 64, 280, 460, 500, "Transacciones", kpis.trx, kpis.trxPctChange);
  drawTile(ctx, 556, 280, 460, 500, "Activos DAU", kpis.activosDau, kpis.activosDauPctChange);

  return canvas.toBuffer("image/png");
}

function formatFecha(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MESES[month - 1]}`;
}

function drawTile(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  valueRaw: number,
  pctChange: number | null,
): void {
  ctx.fillStyle = "#F7F4FB";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 24);
  ctx.fill();

  ctx.fillStyle = "#777777";
  ctx.font = "22px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(label, x + 32, y + 60);

  ctx.fillStyle = "#1A1A1A";
  ctx.font = "bold 72px sans-serif";
  ctx.fillText(`${(valueRaw / 1_000_000).toFixed(1)}M`, x + 32, y + 160);

  if (pctChange !== null) {
    const isNegative = pctChange < 0;
    const chipColor = isNegative ? "#FBE4E4" : "#E4F7E9";
    const textColor = isNegative ? "#CC2222" : "#1B8A3D";
    const chipText = `${pctChange >= 0 ? "+" : ""}${(pctChange * 100).toFixed(1)}%`;

    ctx.font = "bold 26px sans-serif";
    const chipWidth = ctx.measureText(chipText).width + 40;

    ctx.fillStyle = chipColor;
    ctx.beginPath();
    ctx.roundRect(x + 32, y + 190, chipWidth, 48, 24);
    ctx.fill();

    ctx.fillStyle = textColor;
    ctx.fillText(chipText, x + 52, y + 223);
  }
}
