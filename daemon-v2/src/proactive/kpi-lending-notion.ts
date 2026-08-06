export const KPI_LENDING_DB_ID = "3aac4876-09dd-8164-8905-e287a7b16f40";

// Nombres de propiedad EXACTOS de la DB Notion "KPIs Yape Lending" (bajo el mismo parent page
// que "KPIs diarios", 365c4876-09dd-806b-b602-f408c50a077b) — dominio separado (Riesgos/Créditos,
// funnel ACUMULADO del piloto) de "KPIs diarios" (afiliación/TRX/DAU, flujo diario).
const RAW_PROPS = [
  "Leads",
  "Ofertas Vistas",
  "Ofertas No Vistas",
  "Me Interesa",
  "No Me Interesa",
  "Sin Interacción",
  "Contactado",
  "No Contactado",
  "Derivados",
  "No Derivados",
  "En Proceso (Derivados)",
  "Agencia",
  "Desembolso",
  "En Proceso (Agencia)",
  "Rechazado",
  // Derivados, calculados por fillLendingDerivedFields() — nunca vienen del parser del PDF.
  "Incremento Desembolso (D-1)",
  "Incremento Derivados (D-1)",
  "Incremento Ofertas Vistas (D-1)",
  "Incremento Agencia (D-1)",
  "Incremento En Proceso (Agencia) (D-1)",
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
    `/v1/databases/${KPI_LENDING_DB_ID}/query`,
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

export async function upsertLendingRow(
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
    { parent: { database_id: KPI_LENDING_DB_ID }, properties },
    fetchFn,
  );
  return { fecha, created: true, fieldsWritten };
}

function readNotas(page: NotionPage): string {
  return (page.properties["Notas"]?.rich_text ?? []).map((t) => t.plain_text).join("");
}

/** Marca la Fecha con el detalle del fallo (parseo/reconciliación) — nunca escribe campos
 * numéricos cuando falla, para no dejar cifras corruptas en la DB. `detalle` es variable
 * (a diferencia de PDF_FAIL_NOTE en "KPIs diarios", que es un texto fijo) porque acá el motivo
 * de fallo puede ser distinto cada vez (fecha no encontrada, label faltante, reconciliación rota). */
export async function markLendingReportFailed(
  notionToken: string,
  fecha: string,
  detalle: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const nota = `⚠️ Reporte fallido — ${detalle}`;
  const existing = await findRowByFecha(notionToken, fecha, fetchFn);
  if (existing) {
    const currentNotas = readNotas(existing);
    if (currentNotas.includes(nota)) return;
    const merged = currentNotas ? `${currentNotas}\n${nota}` : nota;
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
      parent: { database_id: KPI_LENDING_DB_ID },
      properties: {
        Fecha: { date: { start: fecha } },
        Registro: { title: [{ text: { content: fecha } }] },
        Notas: { rich_text: [{ text: { content: nota } }] },
      },
    },
    fetchFn,
  );
}

/** Borra la marca de fallo (busca por prefijo "⚠️ Reporte fallido —", conserva cualquier otra nota). */
export async function clearLendingFailNote(notionToken: string, fecha: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const existing = await findRowByFecha(notionToken, fecha, fetchFn);
  if (!existing) return;
  const currentNotas = readNotas(existing);
  const cleaned = currentNotas
    .split("\n")
    .filter((line) => !line.startsWith("⚠️ Reporte fallido —"))
    .join("\n")
    .trim();
  if (cleaned === currentNotas.trim()) return;
  await notionRequest(
    notionToken,
    "PATCH",
    `/v1/pages/${existing.id}`,
    { properties: { Notas: { rich_text: cleaned ? [{ text: { content: cleaned } }] : [] } } },
    fetchFn,
  );
}

export interface LendingHistoryRow {
  id: string;
  fecha: string;
  desembolso: number | null;
  derivados: number | null;
  vistos: number | null;
  agencia: number | null;
  enProcesoAgencia: number | null;
  incrementoDesembolso: number | null;
  incrementoDerivados: number | null;
  incrementoVistos: number | null;
  incrementoAgencia: number | null;
  incrementoEnProcesoAgencia: number | null;
}

export async function fetchLendingHistory(notionToken: string, fetchFn: typeof fetch = fetch): Promise<LendingHistoryRow[]> {
  const rows: LendingHistoryRow[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = {
      page_size: 100,
      sorts: [{ property: "Fecha", direction: "ascending" }],
    };
    if (cursor) body.start_cursor = cursor;
    const res = (await notionRequest(notionToken, "POST", `/v1/databases/${KPI_LENDING_DB_ID}/query`, body, fetchFn)) as {
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
        desembolso: props["Desembolso"]?.number ?? null,
        derivados: props["Derivados"]?.number ?? null,
        vistos: props["Ofertas Vistas"]?.number ?? null,
        agencia: props["Agencia"]?.number ?? null,
        enProcesoAgencia: props["En Proceso (Agencia)"]?.number ?? null,
        incrementoDesembolso: props["Incremento Desembolso (D-1)"]?.number ?? null,
        incrementoDerivados: props["Incremento Derivados (D-1)"]?.number ?? null,
        incrementoVistos: props["Incremento Ofertas Vistas (D-1)"]?.number ?? null,
        incrementoAgencia: props["Incremento Agencia (D-1)"]?.number ?? null,
        incrementoEnProcesoAgencia: props["Incremento En Proceso (Agencia) (D-1)"]?.number ?? null,
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

function computeIncremento(
  rows: LendingHistoryRow[],
  index: number,
  field: "desembolso" | "derivados" | "vistos" | "agencia" | "enProcesoAgencia",
): DerivedOutcome {
  const row = rows[index];
  const isoD1 = isoDaysBefore(row.fecha, 1);
  const rowD1 = rows.find((r) => r.fecha === isoD1);

  const valueD = row[field];
  if (valueD == null) return { ok: false, reason: `falta ${field} el ${row.fecha}` };
  if (!rowD1) return { ok: false, reason: `no existe registro D-1 (${isoD1}) — posible hueco de reporte` };
  const valueD1 = rowD1[field];
  if (valueD1 == null) return { ok: false, reason: `falta ${field} el ${isoD1}` };
  return { ok: true, value: valueD - valueD1 };
}

export function computeIncrementoDesembolso(rows: LendingHistoryRow[], index: number): DerivedOutcome {
  return computeIncremento(rows, index, "desembolso");
}
export function computeIncrementoDerivados(rows: LendingHistoryRow[], index: number): DerivedOutcome {
  return computeIncremento(rows, index, "derivados");
}
export function computeIncrementoVistos(rows: LendingHistoryRow[], index: number): DerivedOutcome {
  return computeIncremento(rows, index, "vistos");
}
export function computeIncrementoAgencia(rows: LendingHistoryRow[], index: number): DerivedOutcome {
  return computeIncremento(rows, index, "agencia");
}
export function computeIncrementoEnProcesoAgencia(rows: LendingHistoryRow[], index: number): DerivedOutcome {
  return computeIncremento(rows, index, "enProcesoAgencia");
}

export interface DerivedFillReport {
  completados: Array<{ fecha: string; campo: string; valor: number }>;
  noCalculables: Array<{ fecha: string; campo: string; motivo: string }>;
}

interface DerivedSpec {
  campo: string;
  notionProp: string;
  getExisting: (r: LendingHistoryRow) => number | null;
  compute: (rows: LendingHistoryRow[], index: number) => DerivedOutcome;
}

const DERIVED_SPECS: DerivedSpec[] = [
  {
    campo: "Incremento Desembolso (D-1)",
    notionProp: "Incremento Desembolso (D-1)",
    getExisting: (r) => r.incrementoDesembolso,
    compute: computeIncrementoDesembolso,
  },
  {
    campo: "Incremento Derivados (D-1)",
    notionProp: "Incremento Derivados (D-1)",
    getExisting: (r) => r.incrementoDerivados,
    compute: computeIncrementoDerivados,
  },
  {
    campo: "Incremento Ofertas Vistas (D-1)",
    notionProp: "Incremento Ofertas Vistas (D-1)",
    getExisting: (r) => r.incrementoVistos,
    compute: computeIncrementoVistos,
  },
  {
    campo: "Incremento Agencia (D-1)",
    notionProp: "Incremento Agencia (D-1)",
    getExisting: (r) => r.incrementoAgencia,
    compute: computeIncrementoAgencia,
  },
  {
    campo: "Incremento En Proceso (Agencia) (D-1)",
    notionProp: "Incremento En Proceso (Agencia) (D-1)",
    getExisting: (r) => r.incrementoEnProcesoAgencia,
    compute: computeIncrementoEnProcesoAgencia,
  },
];

/** Completa los derivados que falten. Sin `onlyFechas`, recorre todo el histórico (modo
 * "reprocesar todo") y NUNCA pisa un valor ya calculado — sería carísimo (barre toda la DB en
 * cada tick del cron) y redundante, ya que nada cambia el crudo de fechas viejas en ese modo.
 * Con `onlyFechas` (fecha recién ingestada, o pedido explícito de reprocesar), SÍ fuerza el
 * recálculo aunque ya exista un valor: un reporte reenviado con números corregidos para una
 * fecha ya cargada actualiza el campo crudo (upsertLendingRow lo pisa sin condición) pero el
 * derivado quedaba viejo porque antes esta función lo saltaba igual — bug real encontrado
 * 2026-08-05 (Desembolso del 4/ago: el mail se reenvió con el número corregido, el incremento
 * quedó pegado en 0 en vez de recalcular a 14). */
export async function fillLendingDerivedFields(
  notionToken: string,
  onlyFechas?: string[],
  fetchFn: typeof fetch = fetch,
): Promise<DerivedFillReport> {
  const rows = await fetchLendingHistory(notionToken, fetchFn);
  const report: DerivedFillReport = { completados: [], noCalculables: [] };
  const targetFechas = onlyFechas ? new Set(onlyFechas) : null;
  const forceRecompute = targetFechas !== null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (targetFechas && !targetFechas.has(row.fecha)) continue;
    for (const spec of DERIVED_SPECS) {
      if (!forceRecompute && spec.getExisting(row) != null) continue;
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
