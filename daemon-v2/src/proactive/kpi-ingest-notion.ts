import { isSunday } from "./kpi-ingest-csv.js";

export const KPI_DB_ID = "d4996efa-4053-44cf-8149-c6aee5eba52a";

const RAW_PROPS = [
  "Afiliaciones diarias",
  "TRX",
  "Activos DAU",
  "Activos 30d",
  "Stock Afiliados",
  "Saldo",
  "Remesas (cantidad)",
  "Remesas (USD)",
  "Activos 30d %",
  "Activos DAU %",
  "DAU Promedio 7d",
  "Ingresos Recaudacion",
  "Ingresos Recargas",
  "Ingresos PDS",
  // Fuente PDF ("Seguimiento Diario Yape Bolivia") — ver kpi-ingest-pdf.ts. "Afiliados 7d" y las
  // "vs. Sem. anterior (%)" también las puede completar fillDerivedFields() si el PDF no llegó;
  // getExisting() ahí ya evita pisar lo que haya escrito el PDF.
  "Afiliados 7d",
  "TRX Promedio 7d",
  "Afiliaciones vs. Ayer (%)",
  "Afiliaciones vs. Sem. anterior (%)",
  "TRX vs. Ayer (%)",
  "TRX vs. Sem. anterior (%)",
  "DAU vs. Ayer (%)",
  "DAU vs. Sem. anterior (%)",
] as const;

interface NotionPage {
  id: string;
  properties: Record<
    string,
    { number?: number | null; date?: { start: string } | null; rich_text?: Array<{ plain_text: string }> }
  >;
}

async function notionRequest(
  notionToken: string,
  method: string,
  path: string,
  body: unknown,
  fetchFn: typeof fetch,
): Promise<any> {
  const res = await fetchFn(`https://api.notion.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`notion ${method} ${path} -> ${res.status}`);
  return res.json();
}

async function findRowByFecha(notionToken: string, fecha: string, fetchFn: typeof fetch): Promise<NotionPage | undefined> {
  const queryRes = (await notionRequest(
    notionToken,
    "POST",
    `/v1/databases/${KPI_DB_ID}/query`,
    { page_size: 1, filter: { property: "Fecha", date: { equals: fecha } } },
    fetchFn,
  )) as { results: NotionPage[] };
  return queryRes.results[0];
}

export interface UpsertResult {
  fecha: string;
  created: boolean;
  fieldsWritten: string[];
}

export async function upsertKpiRow(
  notionToken: string,
  fecha: string,
  raw: Record<string, number | null | undefined>,
  fetchFn: typeof fetch = fetch,
): Promise<UpsertResult> {
  const existing = await findRowByFecha(notionToken, fecha, fetchFn);

  const properties: Record<string, unknown> = {};
  const fieldsWritten: string[] = [];
  for (const prop of RAW_PROPS) {
    const value = raw[prop];
    if (value === null || value === undefined) continue;
    properties[prop] = { number: value };
    fieldsWritten.push(prop);
  }

  if (existing) {
    if (fieldsWritten.length > 0) {
      await notionRequest(notionToken, "PATCH", `/v1/pages/${existing.id}`, { properties }, fetchFn);
    }
    return { fecha, created: false, fieldsWritten };
  }

  properties["Fecha"] = { date: { start: fecha } };
  properties["Registro"] = { title: [{ text: { content: fecha } }] };
  await notionRequest(
    notionToken,
    "POST",
    "/v1/pages",
    { parent: { database_id: KPI_DB_ID }, properties },
    fetchFn,
  );
  return { fecha, created: true, fieldsWritten };
}

export const PDF_FAIL_NOTE =
  "⚠️ Reporte fallido (updated fail) — falta información, reintentar cuando llegue el reporte correcto";

function readNotas(page: NotionPage): string {
  return (page.properties["Notas"]?.rich_text ?? []).map((t) => t.plain_text).join("");
}

/** Marca la Fecha como pendiente de reintento (PDF llegó con "updated fail"). No toca KPIs. */
export async function markPdfReportFailed(
  notionToken: string,
  fecha: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const existing = await findRowByFecha(notionToken, fecha, fetchFn);
  if (existing) {
    const currentNotas = readNotas(existing);
    if (currentNotas.includes(PDF_FAIL_NOTE)) return;
    const merged = currentNotas ? `${currentNotas}\n${PDF_FAIL_NOTE}` : PDF_FAIL_NOTE;
    await notionRequest(
      notionToken,
      "PATCH",
      `/v1/pages/${existing.id}`,
      { properties: { Notas: { rich_text: [{ text: { content: merged } }] } } },
      fetchFn,
    );
    return;
  }
  await notionRequest(
    notionToken,
    "POST",
    "/v1/pages",
    {
      parent: { database_id: KPI_DB_ID },
      properties: {
        Fecha: { date: { start: fecha } },
        Registro: { title: [{ text: { content: fecha } }] },
        Notas: { rich_text: [{ text: { content: PDF_FAIL_NOTE } }] },
      },
    },
    fetchFn,
  );
}

/** Borra la marca de "pendiente de reintento" tras un reintento exitoso. No toca nada si no estaba marcada. */
export async function clearPdfFailNote(notionToken: string, fecha: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const existing = await findRowByFecha(notionToken, fecha, fetchFn);
  if (!existing) return;
  const currentNotas = readNotas(existing);
  if (!currentNotas.includes(PDF_FAIL_NOTE)) return;
  const cleaned = currentNotas.replace(PDF_FAIL_NOTE, "").replace(/\n{2,}/g, "\n").trim();
  await notionRequest(
    notionToken,
    "PATCH",
    `/v1/pages/${existing.id}`,
    { properties: { Notas: { rich_text: cleaned ? [{ text: { content: cleaned } }] : [] } } },
    fetchFn,
  );
}

export interface KpiHistoryRow {
  id: string;
  fecha: string;
  trx: number | null;
  activosDau: number | null;
  afiliacionesDiarias: number | null;
  afiliados7d: number | null;
  trxVsSemana: number | null;
  dauVsSemana: number | null;
  afiliacionesVsSemana: number | null;
}

export async function fetchKpiHistory(notionToken: string, fetchFn: typeof fetch = fetch): Promise<KpiHistoryRow[]> {
  const rows: KpiHistoryRow[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = {
      page_size: 100,
      sorts: [{ property: "Fecha", direction: "ascending" }],
    };
    if (cursor) body.start_cursor = cursor;
    const res = (await notionRequest(notionToken, "POST", `/v1/databases/${KPI_DB_ID}/query`, body, fetchFn)) as {
      results: NotionPage[];
      has_more: boolean;
      next_cursor: string | null;
    };
    for (const p of res.results) {
      const props = p.properties;
      const fecha = props["Fecha"]?.date?.start;
      if (!fecha) continue;
      rows.push({
        id: p.id,
        fecha,
        trx: props["TRX"]?.number ?? null,
        activosDau: props["Activos DAU"]?.number ?? null,
        afiliacionesDiarias: props["Afiliaciones diarias"]?.number ?? null,
        afiliados7d: props["Afiliados 7d"]?.number ?? null,
        trxVsSemana: props["TRX vs. Sem. anterior (%)"]?.number ?? null,
        dauVsSemana: props["DAU vs. Sem. anterior (%)"]?.number ?? null,
        afiliacionesVsSemana: props["Afiliaciones vs. Sem. anterior (%)"]?.number ?? null,
      });
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  return rows;
}

export type DerivedOutcome = { ok: true; value: number } | { ok: false; reason: string };

function isoDaysBefore(fecha: string, days: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function computeAfiliados7d(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  const row = rows[index];
  let sum = 0;
  let count = 0;
  for (let offset = 0; offset <= 6; offset++) {
    const iso = isoDaysBefore(row.fecha, offset);
    if (isSunday(iso)) continue;
    const match = rows.find((r) => r.fecha === iso);
    if (!match || match.afiliacionesDiarias == null) {
      return { ok: false, reason: `falta Afiliaciones diarias el ${iso}` };
    }
    sum += match.afiliacionesDiarias;
    count++;
  }
  if (count === 0) return { ok: false, reason: "ventana de 7 días sin días hábiles" };
  return { ok: true, value: Math.round(sum / count) };
}

function computeVsSemanaAnterior(
  rows: KpiHistoryRow[],
  index: number,
  field: "trx" | "activosDau" | "afiliacionesDiarias",
): DerivedOutcome {
  const row = rows[index];
  const isoD7 = isoDaysBefore(row.fecha, 7);
  const rowD7 = rows.find((r) => r.fecha === isoD7);

  const valueD = row[field];
  if (valueD == null) return { ok: false, reason: `falta ${field} el ${row.fecha}` };
  if (!rowD7) return { ok: false, reason: `no existe registro D-7 (${isoD7})` };
  const valueD7 = rowD7[field];
  if (valueD7 == null) return { ok: false, reason: `falta ${field} el ${isoD7}` };
  if (valueD7 === 0) return { ok: false, reason: `${field} en D-7 (${isoD7}) es 0` };
  return { ok: true, value: valueD / valueD7 - 1 };
}

export function computeTrxVsSemana(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  return computeVsSemanaAnterior(rows, index, "trx");
}
export function computeDauVsSemana(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  return computeVsSemanaAnterior(rows, index, "activosDau");
}
export function computeAfiliacionesVsSemana(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  return computeVsSemanaAnterior(rows, index, "afiliacionesDiarias");
}

export interface DerivedFillReport {
  completados: Array<{ fecha: string; campo: string; valor: number }>;
  noCalculables: Array<{ fecha: string; campo: string; motivo: string }>;
}

interface DerivedSpec {
  campo: string;
  notionProp: string;
  getExisting: (r: KpiHistoryRow) => number | null;
  compute: (rows: KpiHistoryRow[], index: number) => DerivedOutcome;
}

const DERIVED_SPECS: DerivedSpec[] = [
  { campo: "Afiliados 7d", notionProp: "Afiliados 7d", getExisting: (r) => r.afiliados7d, compute: computeAfiliados7d },
  {
    campo: "TRX vs. Sem. anterior (%)",
    notionProp: "TRX vs. Sem. anterior (%)",
    getExisting: (r) => r.trxVsSemana,
    compute: computeTrxVsSemana,
  },
  {
    campo: "DAU vs. Sem. anterior (%)",
    notionProp: "DAU vs. Sem. anterior (%)",
    getExisting: (r) => r.dauVsSemana,
    compute: computeDauVsSemana,
  },
  {
    campo: "Afiliaciones vs. Sem. anterior (%)",
    notionProp: "Afiliaciones vs. Sem. anterior (%)",
    getExisting: (r) => r.afiliacionesVsSemana,
    compute: computeAfiliacionesVsSemana,
  },
];

/**
 * Completa los campos derivados que falten. Por default (`onlyFechas` omitido) recorre TODO el
 * histórico — es el modo "reprocesar todo", para cuando Cal lo pide explícito. El uso normal
 * (cron, cada ingesta) pasa `onlyFechas` con la(s) fecha(s) recién tocada(s) — no tiene sentido
 * re-evaluar meses de historial ya resuelto en cada tick; el fetch de historial completo se
 * sigue haciendo igual (hace falta como contexto para el cálculo D-7), pero solo se ATTEMPT/loggea/
 * escribe sobre las fechas objetivo.
 */
export async function fillDerivedFields(
  notionToken: string,
  onlyFechas?: string[],
  fetchFn: typeof fetch = fetch,
): Promise<DerivedFillReport> {
  const rows = await fetchKpiHistory(notionToken, fetchFn);
  const report: DerivedFillReport = { completados: [], noCalculables: [] };
  const targetFechas = onlyFechas ? new Set(onlyFechas) : null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (targetFechas && !targetFechas.has(row.fecha)) continue;
    for (const spec of DERIVED_SPECS) {
      if (spec.getExisting(row) != null) continue;
      const outcome = spec.compute(rows, i);
      if (!outcome.ok) {
        report.noCalculables.push({ fecha: row.fecha, campo: spec.campo, motivo: outcome.reason });
        continue;
      }
      try {
        await notionRequest(
          notionToken,
          "PATCH",
          `/v1/pages/${row.id}`,
          { properties: { [spec.notionProp]: { number: outcome.value } } },
          fetchFn,
        );
        report.completados.push({ fecha: row.fecha, campo: spec.campo, valor: outcome.value });
      } catch (err) {
        report.noCalculables.push({
          fecha: row.fecha,
          campo: spec.campo,
          motivo: `error al escribir en Notion: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  return report;
}
