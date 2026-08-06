import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sendMessage } from "@cos/shared";
import type { LendingCardKpis } from "./kpi-card-lending-image.js";
import { renderKpiCardLendingImage } from "./kpi-card-lending-image.js";
import { fetchLendingHistory, type LendingHistoryRow } from "./kpi-lending-notion.js";
import { enviarFotoLocal } from "../tools/telegram-files.js";

function isoDaysBefore(fecha: string, days: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
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

  if (row.derivados == null) throw new Error("Propiedad Derivados viene null en la fila más reciente");
  if (row.agencia == null) throw new Error("Propiedad Agencia viene null en la fila más reciente");
  if (row.enProcesoAgencia == null) throw new Error("Propiedad En Proceso (Agencia) viene null en la fila más reciente");
  if (row.desembolso == null) throw new Error("Propiedad Desembolso viene null en la fila más reciente");

  // D-1 estricto: los incrementos ya vienen precomputados en Notion (fillLendingDerivedFields()
  // exige el registro del día calendario inmediato anterior, no "el último dato disponible" —
  // a diferencia del diseño previo de esta función, acá no se recalcula nada, solo se expone lo
  // que ya está en la DB). Si el incremento es null (hueco de reporte o primer registro),
  // compareFecha también va null — no tiene sentido mostrar "vs. día" sin un delta real.
  const compareFecha = isoDaysBefore(row.fecha, 1);

  return {
    derivados: row.derivados,
    derivadosDelta: row.incrementoDerivados,
    derivadosCompareFecha: row.incrementoDerivados != null ? compareFecha : null,
    agencia: row.agencia,
    agenciaDelta: row.incrementoAgencia,
    agenciaCompareFecha: row.incrementoAgencia != null ? compareFecha : null,
    enProcesoAgencia: row.enProcesoAgencia,
    enProcesoAgenciaDelta: row.incrementoEnProcesoAgencia,
    enProcesoAgenciaCompareFecha: row.incrementoEnProcesoAgencia != null ? compareFecha : null,
    desembolso: row.desembolso,
    desembolsoDelta: row.incrementoDesembolso,
    desembolsoCompareFecha: row.incrementoDesembolso != null ? compareFecha : null,
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
