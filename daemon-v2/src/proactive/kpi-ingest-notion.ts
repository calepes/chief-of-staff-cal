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
  /** Subconjunto de `fieldsWritten` que entró por `skipIfExisting` (el dueño habitual —el
   * PDF— nunca lo escribió para esta fecha, así que se usó el valor de respaldo del caller). */
  fallbackWritten?: string[];
}

export async function upsertKpiRow(
  notionToken: string,
  fecha: string,
  raw: Record<string, number | null | undefined>,
  fetchFn: typeof fetch = fetch,
  opts?: { skipIfExisting?: readonly string[] },
): Promise<UpsertResult> {
  const existing = await findRowByFecha(notionToken, fecha, fetchFn);

  const properties: Record<string, unknown> = {};
  const fieldsWritten: string[] = [];
  const fallbackWritten: string[] = [];
  for (const prop of RAW_PROPS) {
    const value = raw[prop];
    if (value === null || value === undefined) continue;
    const isFallbackProp = opts?.skipIfExisting?.includes(prop) ?? false;
    if (isFallbackProp) {
      // El dueño habitual (PDF) ya escribió esta fecha — no pisarlo con el valor del caller
      // (puede redondear distinto). Si el dueño nunca llegó (null/página nueva), sí se usa.
      if (existing?.properties[prop]?.number != null) continue;
      fallbackWritten.push(prop);
    }
    properties[prop] = { number: value };
    fieldsWritten.push(prop);
  }

  if (existing) {
    if (fieldsWritten.length > 0) {
      await notionRequest(notionToken, "PATCH", `/v1/pages/${existing.id}`, { properties }, fetchFn);
    }
    return { fecha, created: false, fieldsWritten, fallbackWritten };
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
  return { fecha, created: true, fieldsWritten, fallbackWritten };
}

export const PDF_FAIL_NOTE =
  "⚠️ Reporte fallido (updated fail) — falta información, reintentar cuando llegue el reporte correcto";

export const SELF_SERVICE_FALLBACK_NOTE =
  "📋 Completado con Self-Service — el PDF de Seguimiento Diario nunca llegó para esta fecha";

function readNotas(page: NotionPage): string {
  return (page.properties["Notas"]?.rich_text ?? []).map((t) => t.plain_text).join("");
}

/** Agrega `note` a Notas si todavía no está (crea la página si la fecha no existe). No duplica. */
async function appendNotaIfMissing(
  notionToken: string,
  fecha: string,
  note: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const existing = await findRowByFecha(notionToken, fecha, fetchFn);
  if (existing) {
    const currentNotas = readNotas(existing);
    if (currentNotas.includes(note)) return;
    const merged = currentNotas ? `${currentNotas}\n${note}` : note;
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
        Notas: { rich_text: [{ text: { content: note } }] },
      },
    },
    fetchFn,
  );
}

/** Marca la Fecha como pendiente de reintento (PDF llegó con "updated fail"). No toca KPIs. */
export async function markPdfReportFailed(
  notionToken: string,
  fecha: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await appendNotaIfMissing(notionToken, fecha, PDF_FAIL_NOTE, fetchFn);
}

/** Deja constancia de que los 3 campos "propiedad del PDF" se completaron con el valor del
 * Self-Service (CSV) porque el PDF nunca llegó para esa fecha — ver `PDF_OWNED_RAW_PROPS` en
 * kpi-ingest-check.ts y `opts.skipIfExisting` de `upsertKpiRow`. */
export async function markSelfServiceFallback(
  notionToken: string,
  fecha: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await appendNotaIfMissing(notionToken, fecha, SELF_SERVICE_FALLBACK_NOTE, fetchFn);
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
  trxVsAyer: number | null;
  dauVsAyer: number | null;
  afiliacionesVsAyer: number | null;
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
        trxVsAyer: props["TRX vs. Ayer (%)"]?.number ?? null,
        dauVsAyer: props["DAU vs. Ayer (%)"]?.number ?? null,
        afiliacionesVsAyer: props["Afiliaciones vs. Ayer (%)"]?.number ?? null,
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

function computeVsOffset(
  rows: KpiHistoryRow[],
  index: number,
  field: "trx" | "activosDau" | "afiliacionesDiarias",
  offsetDays: number,
  offsetLabel: string,
): DerivedOutcome {
  const row = rows[index];
  const isoOffset = isoDaysBefore(row.fecha, offsetDays);
  const rowOffset = rows.find((r) => r.fecha === isoOffset);

  const valueD = row[field];
  if (valueD == null) return { ok: false, reason: `falta ${field} el ${row.fecha}` };
  if (!rowOffset) return { ok: false, reason: `no existe registro ${offsetLabel} (${isoOffset})` };
  const valueOffset = rowOffset[field];
  if (valueOffset == null) return { ok: false, reason: `falta ${field} el ${isoOffset}` };
  if (valueOffset === 0) return { ok: false, reason: `${field} en ${offsetLabel} (${isoOffset}) es 0` };
  return { ok: true, value: valueD / valueOffset - 1 };
}

export function computeTrxVsSemana(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  return computeVsOffset(rows, index, "trx", 7, "D-7");
}
export function computeDauVsSemana(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  return computeVsOffset(rows, index, "activosDau", 7, "D-7");
}
export function computeAfiliacionesVsSemana(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  return computeVsOffset(rows, index, "afiliacionesDiarias", 7, "D-7");
}
export function computeTrxVsAyer(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  return computeVsOffset(rows, index, "trx", 1, "D-1");
}
export function computeDauVsAyer(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  return computeVsOffset(rows, index, "activosDau", 1, "D-1");
}
export function computeAfiliacionesVsAyer(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  return computeVsOffset(rows, index, "afiliacionesDiarias", 1, "D-1");
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
  {
    campo: "TRX vs. Ayer (%)",
    notionProp: "TRX vs. Ayer (%)",
    getExisting: (r) => r.trxVsAyer,
    compute: computeTrxVsAyer,
  },
  {
    campo: "DAU vs. Ayer (%)",
    notionProp: "DAU vs. Ayer (%)",
    getExisting: (r) => r.dauVsAyer,
    compute: computeDauVsAyer,
  },
  {
    campo: "Afiliaciones vs. Ayer (%)",
    notionProp: "Afiliaciones vs. Ayer (%)",
    getExisting: (r) => r.afiliacionesVsAyer,
    compute: computeAfiliacionesVsAyer,
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
