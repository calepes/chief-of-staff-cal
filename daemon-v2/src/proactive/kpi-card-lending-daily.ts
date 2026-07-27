import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sendMessage } from "@cos/shared";
import type { LendingCardKpis } from "./kpi-card-lending-image.js";
import { renderKpiCardLendingImage } from "./kpi-card-lending-image.js";
import { fetchLendingHistory, type LendingHistoryRow } from "./kpi-lending-notion.js";
import { enviarFotoLocal } from "../tools/telegram-files.js";

interface Comparison {
  delta: number;
  compareFecha: string;
}

/** Busca, yendo hacia atrás desde `index`, el primer registro anterior que SÍ tenga dato para
 * `field` — no exige que sea D-1 exacto. Los huecos de reporte (ej. Yape no mandó nada el 24-25
 * de julio) son reales y frecuentes; comparar contra "el último dato real" es más útil para la
 * tarjeta que devolver `null` solo porque el día calendario inmediato anterior no tiene fila. */
function findComparison(rows: LendingHistoryRow[], index: number, field: "vistos" | "derivados" | "desembolso"): Comparison | null {
  const current = rows[index][field];
  if (current == null) return null;
  for (let i = index - 1; i >= 0; i--) {
    const prior = rows[i][field];
    if (prior != null) return { delta: current - prior, compareFecha: rows[i].fecha };
  }
  return null;
}

export async function fetchLendingCardKpis(
  notionToken: string,
  fetchFn: typeof fetch = fetch,
  fechaFiltro?: string,
): Promise<LendingCardKpis> {
  const rows = await fetchLendingHistory(notionToken, fetchFn); // orden ascendente por Fecha

  const index = fechaFiltro ? rows.findIndex((r) => r.fecha === fechaFiltro) : rows.length - 1;
  if (index === -1 || (fechaFiltro === undefined && rows.length === 0)) {
    throw new Error(
      fechaFiltro
        ? `No hay KPIs de Lending cargados en Notion para la fecha ${fechaFiltro}`
        : "Notion query devolvió 0 resultados en KPIs Yape Lending",
    );
  }
  const row = rows[index];

  if (row.vistos == null) throw new Error("Propiedad Vistos viene null en la fila más reciente");
  if (row.desembolso == null) throw new Error("Propiedad Desembolso viene null en la fila más reciente");
  if (row.derivados == null) throw new Error("Propiedad Derivados viene null en la fila más reciente");

  const vistosCmp = findComparison(rows, index, "vistos");
  const derivadosCmp = findComparison(rows, index, "derivados");
  const desembolsoCmp = findComparison(rows, index, "desembolso");

  return {
    vistos: row.vistos,
    vistosDelta: vistosCmp?.delta ?? null,
    vistosCompareFecha: vistosCmp?.compareFecha ?? null,
    derivados: row.derivados,
    derivadosDelta: derivadosCmp?.delta ?? null,
    derivadosCompareFecha: derivadosCmp?.compareFecha ?? null,
    desembolso: row.desembolso,
    desembolsoDelta: desembolsoCmp?.delta ?? null,
    desembolsoCompareFecha: desembolsoCmp?.compareFecha ?? null,
    fecha: row.fecha,
  };
}

export interface CheckKpiCardLendingOpts {
  botToken: string;
  chatId: number;
  notionToken: string;
  /** Fecha YYYY-MM-DD a consultar. Sin esto, usa la fila más reciente. */
  fecha?: string;
}

export async function checkKpiCardLending(opts: CheckKpiCardLendingOpts): Promise<void> {
  const { botToken, chatId, notionToken, fecha } = opts;
  const motivoFecha = fecha ?? "la más reciente";

  let kpis: LendingCardKpis;
  try {
    kpis = await fetchLendingCardKpis(notionToken, fetch, fecha);
  } catch (err) {
    await notifyFailure(botToken, chatId, `no pude leer los KPIs de Lending (${motivoFecha}) desde Notion`, err);
    return;
  }

  let imagePath: string;
  try {
    const png = await renderKpiCardLendingImage(kpis);
    imagePath = join(tmpdir(), `kpi-card-lending-${fecha ?? todayIso()}-${randomUUID()}.png`);
    await writeFile(imagePath, png);
  } catch (err) {
    await notifyFailure(botToken, chatId, `no pude generar la imagen de la tarjeta de Lending (${motivoFecha})`, err);
    return;
  }

  const sent = await enviarFotoLocal(botToken, chatId, imagePath, "kpi-card-lending.png");
  if (!sent.ok) {
    await notifyFailure(botToken, chatId, `no pude mandarte la tarjeta de Lending (${motivoFecha}) por Telegram`, sent.error);
  }

  await unlink(imagePath).catch(() => {});
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function notifyFailure(botToken: string, chatId: number, motivo: string, err: unknown): Promise<void> {
  console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_card_lending_failure", motivo, err: String(err) }));
  const text = `⚠️ No pude armar la tarjeta de KPIs Lending (${motivo}). Revisa los logs del daemon.`;
  try {
    await sendMessage(botToken, { chatId, text });
  } catch (sendErr) {
    console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_card_lending_notify_failed", err: String(sendErr) }));
  }
}
