import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendMessage } from "@cos/shared";
import type { DailyKpis } from "./kpi-card-image.js";
import { renderKpiCardImage } from "./kpi-card-image.js";
import { enviarFotoLocal } from "../tools/telegram-files.js";

const KPI_DB_ID = "d4996efa-4053-44cf-8149-c6aee5eba52a";

interface NotionQueryResponse {
  results: Array<{
    properties: Record<string, { number?: number | null; date?: { start: string } | null }>;
  }>;
}

export async function fetchDailyKpis(
  notionToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<DailyKpis> {
  const res = await fetchFn(`https://api.notion.com/v1/databases/${KPI_DB_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ page_size: 1, sorts: [{ property: "Fecha", direction: "descending" }] }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Notion query falló con status ${res.status}`);

  const data = (await res.json()) as NotionQueryResponse;
  const row = data.results[0];
  if (!row) throw new Error("Notion query devolvió 0 resultados en KPIs diarios");

  const props = row.properties;
  const trx = props["TRX"]?.number;
  const activosDau = props["Activos DAU"]?.number;
  const fecha = props["Fecha"]?.date?.start;

  if (trx == null) throw new Error("Propiedad TRX viene null en la fila más reciente");
  if (activosDau == null) throw new Error("Propiedad Activos DAU viene null en la fila más reciente");
  if (!fecha) throw new Error("Propiedad Fecha viene vacía en la fila más reciente");

  return {
    trx,
    trxPctChange: props["TRX vs. Sem. anterior (%)"]?.number ?? null,
    activosDau,
    activosDauPctChange: props["DAU vs. Sem. anterior (%)"]?.number ?? null,
    fecha,
  };
}

export interface CheckKpiCardDailyOpts {
  botToken: string;
  chatId: number;
  notionToken: string;
}

export async function checkKpiCardDaily(opts: CheckKpiCardDailyOpts): Promise<void> {
  const { botToken, chatId, notionToken } = opts;

  let kpis: DailyKpis;
  try {
    kpis = await fetchDailyKpis(notionToken);
  } catch (err) {
    await notifyFailure(botToken, chatId, "no pude leer los KPIs desde Notion", err);
    return;
  }

  let imagePath: string;
  try {
    const png = await renderKpiCardImage(kpis);
    imagePath = join(tmpdir(), `kpi-card-${todayIso()}.png`);
    await writeFile(imagePath, png);
  } catch (err) {
    await notifyFailure(botToken, chatId, "no pude generar la imagen de la tarjeta", err);
    return;
  }

  const sent = await enviarFotoLocal(botToken, chatId, imagePath, "kpi-card.png");
  if (!sent.ok) {
    await notifyFailure(botToken, chatId, "no pude mandarte la tarjeta por Telegram", sent.error);
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function notifyFailure(
  botToken: string,
  chatId: number,
  motivo: string,
  err: unknown,
): Promise<void> {
  console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_card_daily_failure", motivo, err: String(err) }));
  const text = `⚠️ No pude armar la tarjeta de KPIs de hoy (${motivo}). Revisa los logs del daemon.`;
  try {
    await sendMessage(botToken, { chatId, text });
  } catch (sendErr) {
    console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_card_daily_notify_failed", err: String(sendErr) }));
  }
}
