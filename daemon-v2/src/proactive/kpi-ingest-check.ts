import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { sendCronMessage } from "./rich-send.js";
import {
  gmailAccessToken,
  searchSelfServiceEmails,
  searchSeguimientoDiarioEmails,
  searchLendingReportEmails,
  getGmailMessage,
  findCsvCandidates,
  findPdfCandidates,
  downloadGmailAttachment,
  downloadGmailAttachmentBuffer,
  archiveAndMarkRead,
  type GmailCreds,
  type GmailMessageRef,
} from "./kpi-ingest-gmail.js";
import { parseCsv, applySundayRule, isSunday } from "./kpi-ingest-csv.js";
import { extractPdfKpis, isFailedReport, parseReportDateFromFilename, type PdfKpiFields } from "./kpi-ingest-pdf.js";
import {
  upsertKpiRow,
  fillDerivedFields,
  markPdfReportFailed,
  clearPdfFailNote,
  type DerivedFillReport,
  type UpsertResult,
} from "./kpi-ingest-notion.js";
import { parseReportDateFromBody, parseAndValidateLendingReport, type LendingFunnelFields } from "./kpi-ingest-lending-pdf.js";
import {
  upsertLendingRow,
  markLendingReportFailed,
  clearLendingFailNote,
  fillLendingDerivedFields,
  type DerivedFillReport as LendingDerivedFillReport,
} from "./kpi-lending-notion.js";
import { checkKpiCardDaily } from "./kpi-card-daily.js";
import { checkKpiCardLending } from "./kpi-card-lending-daily.js";

const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse") as {
  PDFParse: new (opts: { data: Uint8Array }) => { getText(): Promise<{ text: string }> };
};

const WAIT_MS = 15 * 60 * 1000;
const ERROR_DEDUP_MS = 2 * 60 * 60 * 1000;
const MAX_PROCESSED = 200;
const MAX_CARD_SENT = 90;

// El PDF ("Seguimiento Diario Yape Bolivia") es la fuente autoritativa de estos 3 campos —
// el CSV ("Self-Service") ya no los escribe, para que no se pisen entre sí. Ver
// Jano/CLAUDE.md sección "scheduleKpiIngestCheck" para el diseño completo.
const PDF_OWNED_RAW_PROPS = ["Afiliaciones diarias", "TRX", "Activos DAU"];

export interface KpiIngestState {
  processed: string[];
  pending: Record<string, { receivedAt: number }>;
  lastErrorNotified: Record<string, number>;
  /** Fechas para las que ya se mandó la tarjeta automática (KPIs diarios — TRX/DAU). */
  cardSent: string[];
  /** Fechas para las que ya se mandó la tarjeta de Lending — array propio, no comparte
   * dedup con `cardSent` (dominios y DBs distintas, aunque coincida la fecha string). */
  lendingCardSent: string[];
}

export function defaultStatePath(): string {
  return `${process.env.HOME}/.cos-agent/kpi-ingest-state.json`;
}

export function readState(path: string): KpiIngestState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<KpiIngestState>;
    // cardSent/lendingCardSent son campos que un state.json viejo puede no tener todavía.
    return {
      processed: parsed.processed ?? [],
      pending: parsed.pending ?? {},
      lastErrorNotified: parsed.lastErrorNotified ?? {},
      cardSent: parsed.cardSent ?? [],
      lendingCardSent: parsed.lendingCardSent ?? [],
    };
  } catch {
    return { processed: [], pending: {}, lastErrorNotified: {}, cardSent: [], lendingCardSent: [] };
  }
}

export function writeState(path: string, state: KpiIngestState): void {
  try {
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch {
    /* noop */
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MAX_REPORT_LINES = 25;

function capLines(lines: string[]): string[] {
  if (lines.length <= MAX_REPORT_LINES) return lines;
  return [...lines.slice(0, MAX_REPORT_LINES), `• …+${lines.length - MAX_REPORT_LINES} más (ver logs del daemon)`];
}

const NO_CALCULABLE_REPORT_WINDOW_DAYS = 30;

// Los "no calculables" de fechas viejas (típicamente enero, sin D-7 porque ahí arranca el
// histórico) son permanentes — NUNCA se van a poder calcular, y sin este filtro se repiten
// idénticos en TODOS los reportes desde siempre (ruido puro). Solo lo reciente es accionable
// (indica un hueco real que vale la pena mirar); el detalle completo, viejo incluido, sigue
// en el log estructurado `kpi_ingest_(pdf_)?full_report` para debug.
function isRecentFecha(fecha: string, days = NO_CALCULABLE_REPORT_WINDOW_DAYS): boolean {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(`${fecha}T00:00:00Z`).getTime() >= cutoff;
}

// "Afiliaciones vs. Sem. anterior (%)" nunca se puede calcular un domingo — "Afiliaciones
// diarias" es null ESE mismo día por la regla SEGIP (applySundayRule), no porque falte data.
// Es tan permanente como el hueco de enero (arriba), solo que en vez de un límite histórico
// fijo se repite cada semana — sin este filtro, siempre iban a quedar ~4 domingos "recientes"
// ensuciando el reporte para siempre.
function isPermanentSundayGap(c: { fecha: string; motivo: string }): boolean {
  return isSunday(c.fecha) && c.motivo.startsWith("falta afiliacionesDiarias el");
}

function formatDerivedLines(derived: DerivedFillReport): string[] {
  return capLines([
    ...derived.completados.map((c) => `• ${escapeHtml(c.fecha)} → ${escapeHtml(c.campo)} → ${c.valor}`),
    ...derived.noCalculables
      .filter((c) => isRecentFecha(c.fecha) && !isPermanentSundayGap(c))
      .map((c) => `• ${escapeHtml(c.fecha)} → ${escapeHtml(c.campo)} → no calculable (${escapeHtml(c.motivo)})`),
  ]);
}

/** Una fila del CSV ya escrita en Notion — la materia prima del reporte de ingesta. */
export interface CsvIngestRow {
  fecha: string;
  created: boolean;
  fieldsWritten: string[];
  unmapped: string[];
  illegible: string[];
}

/** Los `campos` que escribe la corrida, si TODAS las fechas coinciden; si no, el set más común. */
function modalFieldCount(rows: CsvIngestRow[]): number {
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.fieldsWritten.length, (counts.get(r.fieldsWritten.length) ?? 0) + 1);
  let best = 0;
  let bestFreq = -1;
  for (const [n, freq] of counts) {
    if (freq > bestFreq) {
      best = n;
      bestFreq = freq;
    }
  }
  return best;
}

// El CSV del Self-Service trae el mes-a-la-fecha COMPLETO cada día: la corrida normal reescribe
// ~27 fechas con exactamente los mismos campos. Desglosarlas una por una producía la misma pared
// de texto todos los días (creciendo un renglón por jornada, hasta tocar el cap y truncarse), sin
// una sola línea accionable. Acá solo se nombra lo que se sale de esa norma; el detalle completo
// queda en el log estructurado `kpi_ingest_full_report`.
function formatAnomalyLines(rows: CsvIngestRow[]): string[] {
  const habitual = modalFieldCount(rows);
  const out: string[] = [];
  for (const r of rows) {
    const notas: string[] = [];
    if (r.created) notas.push("creado (fecha nueva)");
    if (!r.fieldsWritten.length) notas.push("sin campos");
    else if (r.fieldsWritten.length !== habitual) notas.push(`${r.fieldsWritten.length} campos (lo habitual son ${habitual})`);
    if (r.illegible.length) notas.push(`ilegibles: ${r.illegible.map(escapeHtml).join(", ")}`);
    if (r.unmapped.length) notas.push(`no mapeadas: ${r.unmapped.map(escapeHtml).join(", ")}`);
    if (notas.length) out.push(`• ${escapeHtml(r.fecha)} → ${notas.join(" · ")}`);
  }
  return capLines(out);
}

export function formatSuccessReport(rows: CsvIngestRow[], derived: DerivedFillReport): string {
  const lines: string[] = ["✅ <b>KPIs diarios</b> · Self-Service"];

  if (!rows.length) {
    lines.push("⚠️ sin filas con Fecha válida");
  } else {
    const ultima = rows.map((r) => r.fecha).sort().at(-1)!;
    const conteo = rows.length > 1 ? `${rows.length} fechas · ` : "";
    lines.push(`📅 <b>${escapeHtml(ultima)}</b> · ${conteo}${modalFieldCount(rows)} campos`);

    const anomalias = formatAnomalyLines(rows);
    if (anomalias.length) lines.push("", "⚠️ <b>Revisar:</b>", ...anomalias);
  }

  // Sin nada que completar ni ningún hueco reciente, la sección entera se omite: un
  // "• nada pendiente" fijo en cada corrida es ruido, no confirmación útil.
  const derivedLines = formatDerivedLines(derived);
  if (derivedLines.length) lines.push("", "<b>Derivados:</b>", ...derivedLines);

  return lines.join("\n");
}

function formatMiles(n: number): string {
  return n.toLocaleString("en-US");
}

function formatPct(n: number): string {
  const arrow = n >= 0 ? "▲" : "▼";
  const sign = n >= 0 ? "+" : "";
  return `${arrow} ${sign}${(n * 100).toFixed(1)}%`;
}

function pctCell(n: number | null): string {
  return n != null ? formatPct(n) : "—";
}

// Una fila de la tabla de KPIs — `null` si el valor no vino en el PDF (PDF parcial), para que
// el caller la filtre sin dejar una fila vacía en la tabla.
function kpiRow(emoji: string, label: string, value: number | null, vsAyer: number | null, vsSemana: number | null): string | null {
  if (value == null) return null;
  return `<tr><td>${emoji} ${escapeHtml(label)}</td><td><b>${formatMiles(value)}</b></td><td>${pctCell(vsAyer)}</td><td>${pctCell(vsSemana)}</td></tr>`;
}

export function formatPdfSuccessReport(
  fecha: string,
  pdfKpis: PdfKpiFields,
  result: UpsertResult,
  derived: DerivedFillReport,
): string {
  const lines: string[] = [
    "✅ <b>KPIs diarios actualizados</b> · Seguimiento Diario",
    `📅 <b>${escapeHtml(fecha)}</b> (${result.created ? "creado" : "actualizado"})`,
    "",
  ];

  // Tabla real (Rich Messages) — datos comparables en 2 ejes (métrica × día/semana), el caso
  // exacto que la política "diseño activo" del prompt pide como tabla en vez de líneas sueltas.
  const rows = [
    kpiRow("👥", "Afiliaciones diarias", pdfKpis.afiliacionesDiarias, pdfKpis.afiliacionesVsAyer, pdfKpis.afiliacionesVsSemana),
    kpiRow("👥", "Afiliados 7d", pdfKpis.afiliados7d, null, null),
    kpiRow("🔁", "TRX", pdfKpis.trx, pdfKpis.trxVsAyer, pdfKpis.trxVsSemana),
    kpiRow("🔁", "TRX Promedio 7d", pdfKpis.trxPromedio7d, null, null),
    kpiRow("📊", "Activos DAU", pdfKpis.activosDau, pdfKpis.dauVsAyer, pdfKpis.dauVsSemana),
  ].filter((r): r is string => r != null);

  if (rows.length) {
    lines.push(`<table><tr><th>Métrica</th><th>Valor</th><th>Día</th><th>Sem.</th></tr>${rows.join("")}</table>`);
  }
  if (!result.fieldsWritten.length) lines.push("sin campos");

  const derivedLines = formatDerivedLines(derived);
  if (derivedLines.length) lines.push("", "<b>Derivados:</b>", ...derivedLines);
  return lines.join("\n");
}

export function formatLendingSuccessReport(fecha: string, fields: LendingFunnelFields, result: UpsertResult): string {
  const lines: string[] = [
    "✅ <b>Funnel Yape Lending actualizado</b> · Riesgos",
    `📅 <b>${escapeHtml(fecha)}</b> (${result.created ? "creado" : "actualizado"})`,
    "",
    `Leads: <b>${formatMiles(fields.leads ?? 0)}</b> → Ofertas Vistas: <b>${formatMiles(fields.vistos ?? 0)}</b> → Me Interesa: <b>${formatMiles(fields.meInteresa ?? 0)}</b>`,
    `Contactado: <b>${formatMiles(fields.contactado ?? 0)}</b> → Derivados: <b>${formatMiles(fields.derivados ?? 0)}</b> → Agencia: <b>${formatMiles(fields.agencia ?? 0)}</b>`,
    `💰 Desembolso: <b>${formatMiles(fields.desembolso ?? 0)}</b> · Rechazado: ${formatMiles(fields.rechazado ?? 0)}`,
  ];
  if (!result.fieldsWritten.length) lines.push("sin campos");
  return lines.join("\n");
}

function formatLendingFailedReport(fecha: string, detalle: string): string {
  return `⚠️ <b>Funnel Yape Lending — reporte fallido</b>\n📅 ${escapeHtml(fecha)}\n${escapeHtml(detalle)}\nNo se tocaron los KPIs de esa fecha (quedan en 0 filas nuevas). Revisar el PDF manualmente — el layout puede haber cambiado.`;
}

function lendingFieldsToRaw(f: LendingFunnelFields): Record<string, number | null> {
  return {
    Leads: f.leads,
    "Ofertas Vistas": f.vistos,
    "Ofertas No Vistas": f.noVistos,
    "Me Interesa": f.meInteresa,
    "No Me Interesa": f.noMeInteresa,
    "Sin Interacción": f.sinInteraccion,
    Contactado: f.contactado,
    "No Contactado": f.noContactado,
    Derivados: f.derivados,
    "No Derivados": f.noDerivados,
    "En Proceso (Derivados)": f.enProcesoDerivados,
    Agencia: f.agencia,
    Desembolso: f.desembolso,
    "En Proceso (Agencia)": f.enProcesoAgencia,
    Rechazado: f.rechazado,
  };
}

function formatErrorReport(accion: string, motivo: string, sugerencia: string): string {
  return `⚠️ <b>No pude ${escapeHtml(accion)}</b>\n${escapeHtml(motivo)}\n${escapeHtml(sugerencia)}`;
}

function pdfKpisToRaw(pdf: PdfKpiFields): Record<string, number | null> {
  return {
    "Afiliaciones diarias": pdf.afiliacionesDiarias,
    "Afiliados 7d": pdf.afiliados7d,
    "TRX": pdf.trx,
    "TRX Promedio 7d": pdf.trxPromedio7d,
    "Activos DAU": pdf.activosDau,
    "Afiliaciones vs. Ayer (%)": pdf.afiliacionesVsAyer,
    "Afiliaciones vs. Sem. anterior (%)": pdf.afiliacionesVsSemana,
    "TRX vs. Ayer (%)": pdf.trxVsAyer,
    "TRX vs. Sem. anterior (%)": pdf.trxVsSemana,
    "DAU vs. Ayer (%)": pdf.dauVsAyer,
    "DAU vs. Sem. anterior (%)": pdf.dauVsSemana,
  };
}

async function defaultPdfTextExtractor(buf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  const { text } = await parser.getText();
  return text;
}

export interface CheckKpiIngestOpts {
  botToken: string;
  chatId: number;
  notionToken: string;
  gmail: GmailCreds;
  /** Override para tests — default: `~/.cos-agent/kpi-ingest-state.json`. */
  statePath?: string;
  /** Override para tests — evita instanciar pdf-parse real sobre un binario de PDF de verdad. */
  pdfTextExtractor?: (buf: Buffer) => Promise<string>;
}

let running = false;

async function pollAndProcess(
  state: KpiIngestState,
  statePath: string,
  gmail: GmailCreds,
  searchFn: (accessToken: string) => Promise<GmailMessageRef[]>,
  processFn: (id: string, state: KpiIngestState, opts: CheckKpiIngestOpts) => Promise<void>,
  opts: CheckKpiIngestOpts,
  errLabel: string,
): Promise<void> {
  let messageIds: string[];
  try {
    const token = await gmailAccessToken(gmail);
    const found = await searchFn(token);
    messageIds = found.map((m) => m.id);
  } catch (err) {
    console.error(JSON.stringify({ ts: Date.now(), msg: `kpi_ingest_search_error_${errLabel}`, err: String(err) }));
    return;
  }

  for (const id of messageIds) {
    if (state.processed.includes(id)) continue;

    if (!state.pending[id]) {
      try {
        const token = await gmailAccessToken(gmail);
        const detail = await getGmailMessage(id, token);
        state.pending[id] = { receivedAt: detail.internalDate };
        writeState(statePath, state);
      } catch (err) {
        console.error(JSON.stringify({ ts: Date.now(), msg: `kpi_ingest_metadata_error_${errLabel}`, id, err: String(err) }));
      }
      continue;
    }

    if (Date.now() - state.pending[id].receivedAt < WAIT_MS) continue;

    await processFn(id, state, opts);
    writeState(statePath, state);
  }
}

export async function checkKpiIngest(opts: CheckKpiIngestOpts): Promise<void> {
  if (running) {
    console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_check_overlap_skipped" }));
    return;
  }
  running = true;
  try {
    const statePath = opts.statePath ?? defaultStatePath();
    const state = readState(statePath);

    await pollAndProcess(state, statePath, opts.gmail, searchSelfServiceEmails, processCsvMessage, opts, "csv");
    await pollAndProcess(state, statePath, opts.gmail, searchSeguimientoDiarioEmails, processPdfMessage, opts, "pdf");
    await pollAndProcess(state, statePath, opts.gmail, searchLendingReportEmails, processLendingMessage, opts, "lending");

    if (state.processed.length > MAX_PROCESSED) {
      state.processed = state.processed.slice(-MAX_PROCESSED);
      writeState(statePath, state);
    }
    if (state.cardSent.length > MAX_CARD_SENT) {
      state.cardSent = state.cardSent.slice(-MAX_CARD_SENT);
      writeState(statePath, state);
    }
    if (state.lendingCardSent.length > MAX_CARD_SENT) {
      state.lendingCardSent = state.lendingCardSent.slice(-MAX_CARD_SENT);
      writeState(statePath, state);
    }
  } finally {
    running = false;
  }
}

async function processCsvMessage(id: string, state: KpiIngestState, opts: CheckKpiIngestOpts): Promise<void> {
  const { botToken, chatId, notionToken, gmail } = opts;
  try {
    const token = await gmailAccessToken(gmail);
    const detail = await getGmailMessage(id, token);
    const candidates = findCsvCandidates(detail.attachments);

    if (candidates.length === 0) {
      await sendReport(
        botToken,
        chatId,
        formatErrorReport("procesar el Self-Service", "El mail llegó sin ningún CSV adjunto.", "Revisa el mail manualmente si se repite."),
      );
      markProcessed(state, id);
      return;
    }

    let best: { headerMapped: number; rows: ReturnType<typeof parseCsv>["rows"] } | null = null;
    for (const candidate of candidates) {
      const content = await downloadGmailAttachment(id, candidate.attachmentId, token);
      const parsed = parseCsv(content);
      if (!best || parsed.headerMapped > best.headerMapped) best = parsed;
    }

    const ingestRows: CsvIngestRow[] = [];
    const touchedFechas: string[] = [];
    for (const row of best!.rows) {
      if (!row.fecha) continue;
      const raw = applySundayRule(row.fecha, row.raw);
      for (const prop of PDF_OWNED_RAW_PROPS) delete raw[prop];
      const result = await upsertKpiRow(notionToken, row.fecha, raw);
      touchedFechas.push(result.fecha);
      ingestRows.push({
        fecha: result.fecha,
        created: result.created,
        fieldsWritten: result.fieldsWritten,
        unmapped: row.unmapped,
        illegible: row.illegible,
      });
    }

    // Solo las fechas recién tocadas en ESTE mail — no todo el histórico (ver fillDerivedFields).
    const derived = await fillDerivedFields(notionToken, touchedFechas);
    console.log(JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_full_report", id, ingestRows, derived }));
    await sendReport(botToken, chatId, formatSuccessReport(ingestRows, derived));
    markProcessed(state, id);
  } catch (err) {
    const now = Date.now();
    const last = state.lastErrorNotified[id] ?? 0;
    if (now - last >= ERROR_DEDUP_MS) {
      await sendReport(
        botToken,
        chatId,
        formatErrorReport("actualizar los KPIs (Self-Service)", String(err), "Reintento automático en el próximo tick."),
      );
      state.lastErrorNotified[id] = now;
    }
    console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_process_error", id, err: String(err) }));
  }
}

async function processPdfMessage(id: string, state: KpiIngestState, opts: CheckKpiIngestOpts): Promise<void> {
  const { botToken, chatId, notionToken, gmail } = opts;
  try {
    const token = await gmailAccessToken(gmail);
    const detail = await getGmailMessage(id, token);
    const candidates = findPdfCandidates(detail.attachments);

    if (candidates.length === 0) {
      await sendReport(
        botToken,
        chatId,
        formatErrorReport("procesar el Seguimiento Diario", "El mail llegó sin ningún PDF adjunto.", "Revisa el mail manualmente si se repite."),
      );
      markProcessed(state, id);
      return;
    }

    const attachment = candidates[0];
    const fecha = parseReportDateFromFilename(attachment.filename);
    if (!fecha) {
      throw new Error(`no pude determinar la fecha del reporte desde el nombre del archivo "${attachment.filename}"`);
    }

    const buf = await downloadGmailAttachmentBuffer(id, attachment.attachmentId, token);
    const text = await (opts.pdfTextExtractor ?? defaultPdfTextExtractor)(buf);

    if (isFailedReport(text)) {
      await markPdfReportFailed(notionToken, fecha);
      await sendReport(
        botToken,
        chatId,
        `⚠️ <b>Reporte de Seguimiento Diario fallido</b>\n${escapeHtml(fecha)} — el PDF llegó marcado "updated fail". No se tocaron los KPIs de esa fecha, queda pendiente de reintento.`,
      );
      markProcessed(state, id);
      return;
    }

    const pdfKpis = extractPdfKpis(text);
    if (pdfKpis.afiliacionesDiarias == null && pdfKpis.trx == null && pdfKpis.activosDau == null) {
      throw new Error("no pude extraer ningún KPI reconocible del PDF (¿cambió el formato del reporte?)");
    }

    const raw = applySundayRule(fecha, pdfKpisToRaw(pdfKpis));
    const result = await upsertKpiRow(notionToken, fecha, raw);
    await clearPdfFailNote(notionToken, fecha);
    const derived = await fillDerivedFields(notionToken, [fecha]);

    try {
      await archiveAndMarkRead(id, token);
    } catch (err) {
      // Requiere scope gmail.modify — hasta que ese OAuth esté listo, esto falla con 403 y
      // el mail queda sin archivar (no rompe el resto del flujo). Ver Jano/CLAUDE.md.
      console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_archive_failed", id, err: String(err) }));
    }

    console.log(
      JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_pdf_full_report", id, fecha, fieldsWritten: result.fieldsWritten, derived }),
    );
    await sendReport(botToken, chatId, formatPdfSuccessReport(fecha, pdfKpis, result, derived));

    // La tarjeta PNG (TRX + Activos DAU + sus % vs. semana anterior) solo necesita datos del
    // PDF — el CSV no le aporta nada. Se dispara acá en vez de esperar un cron fijo a las 10:00
    // (pedido de Cal 2026-07-24, ver Jano/CLAUDE.md). Idempotente por fecha vía state.cardSent.
    // Try/catch propio (checkKpiCardDaily no debería lanzar — maneja y reporta sus propios
    // errores por Telegram — pero un fallo puntual acá no debe hacer parecer que TODA la
    // ingesta falló, ni bloquear markProcessed de un mail ya procesado con éxito).
    if (!state.cardSent.includes(fecha)) {
      try {
        await checkKpiCardDaily({ botToken, chatId, notionToken, fecha });
        state.cardSent.push(fecha);
      } catch (err) {
        console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_card_daily_trigger_failed", fecha, err: String(err) }));
      }
    }

    markProcessed(state, id);
  } catch (err) {
    const now = Date.now();
    const last = state.lastErrorNotified[id] ?? 0;
    if (now - last >= ERROR_DEDUP_MS) {
      await sendReport(
        botToken,
        chatId,
        formatErrorReport("actualizar los KPIs (Seguimiento Diario)", String(err), "Reintento automático en el próximo tick."),
      );
      state.lastErrorNotified[id] = now;
    }
    console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_pdf_process_error", id, err: String(err) }));
  }
}

/**
 * Pipeline "Funnel Yape Lending" (Riesgos/Créditos) — dominio distinto de "KPIs diarios"
 * (afiliación/TRX/DAU), DB Notion separada (kpi-lending-notion.ts). Reusa la misma infraestructura
 * de cron/estado (pollAndProcess/kpi-ingest-state.json) que los otros 2 pipelines — sin riesgo de
 * colisión porque los IDs de mensaje de Gmail son únicos en todo el buzón.
 *
 * A diferencia del PDF de "Seguimiento Diario" (fecha del FILENAME del adjunto), este reporte no
 * trae fecha en el nombre del PDF — se extrae del CUERPO del mail ("...cierre de la jornada de
 * 2026-07-26..."). Si no se encuentra, se lanza (retry en el próximo tick, no se marca processed —
 * podría ser un problema transitorio de formato). Si el parseo/reconciliación del PDF falla, la
 * fecha SÍ se conoce → se anota el fallo en Notas y se marca processed (reintentar el mismo mail no
 * va a cambiar su contenido).
 */
async function processLendingMessage(id: string, state: KpiIngestState, opts: CheckKpiIngestOpts): Promise<void> {
  const { botToken, chatId, notionToken, gmail } = opts;
  try {
    const token = await gmailAccessToken(gmail);
    const detail = await getGmailMessage(id, token);
    const candidates = findPdfCandidates(detail.attachments);

    if (candidates.length === 0) {
      await sendReport(
        botToken,
        chatId,
        formatErrorReport("procesar el Funnel Yape Lending", "El mail llegó sin ningún PDF adjunto.", "Revisa el mail manualmente si se repite."),
      );
      markProcessed(state, id);
      return;
    }

    const fecha = parseReportDateFromBody(detail.bodyText ?? "");
    if (!fecha) {
      throw new Error('no pude encontrar "cierre de la jornada de YYYY-MM-DD" en el cuerpo del mail');
    }

    const attachment = candidates[0];
    const buf = await downloadGmailAttachmentBuffer(id, attachment.attachmentId, token);
    const text = await (opts.pdfTextExtractor ?? defaultPdfTextExtractor)(buf);

    const parsed = parseAndValidateLendingReport(text);
    if (!parsed.ok) {
      const detalle = parsed.errors.join("; ");
      await markLendingReportFailed(notionToken, fecha, detalle);
      await sendReport(botToken, chatId, formatLendingFailedReport(fecha, detalle));
      console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_lending_parse_failed", id, fecha, errors: parsed.errors }));
      markProcessed(state, id);
      return;
    }

    const result = await upsertLendingRow(notionToken, fecha, lendingFieldsToRaw(parsed.fields));
    await clearLendingFailNote(notionToken, fecha);
    const derived: LendingDerivedFillReport = await fillLendingDerivedFields(notionToken, [fecha]);

    console.log(
      JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_lending_full_report", id, fecha, fieldsWritten: result.fieldsWritten, derived }),
    );
    await sendReport(botToken, chatId, formatLendingSuccessReport(fecha, parsed.fields, result));

    // Igual patrón que la tarjeta de KPIs diarios desde processPdfMessage: se dispara sola apenas
    // este mail se procesa con éxito, en vez de esperar un horario fijo. Try/catch propio — un
    // fallo puntual de la tarjeta no debe hacer parecer que la ingesta completa falló, ni bloquear
    // el markProcessed de un mail ya procesado. Dedup por fecha vía state.lendingCardSent (array
    // propio, no comparte el de "KPIs diarios").
    if (!state.lendingCardSent.includes(fecha)) {
      try {
        await checkKpiCardLending({ botToken, chatId, notionToken, fecha });
        state.lendingCardSent.push(fecha);
      } catch (err) {
        console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_card_lending_trigger_failed", fecha, err: String(err) }));
      }
    }

    markProcessed(state, id);
  } catch (err) {
    const now = Date.now();
    const last = state.lastErrorNotified[id] ?? 0;
    if (now - last >= ERROR_DEDUP_MS) {
      await sendReport(
        botToken,
        chatId,
        formatErrorReport("actualizar el Funnel Yape Lending", String(err), "Reintento automático en el próximo tick."),
      );
      state.lastErrorNotified[id] = now;
    }
    console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_lending_process_error", id, err: String(err) }));
  }
}

function markProcessed(state: KpiIngestState, id: string): void {
  state.processed.push(id);
  delete state.pending[id];
  delete state.lastErrorNotified[id];
}

function paginateReport(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = remaining.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendReport(botToken: string, chatId: number, text: string): Promise<void> {
  // Rich Messages soporta 32.768 chars (vs. 4.096 del HTML clásico) — con MAX_REPORT_LINES=25
  // el texto rara vez se acerca al límite clásico, así que paginar antes de intentar Rich
  // Messages cortaría de más en el caso común. Paginar solo importa si sendCronMessage cae al
  // fallback HTML clásico, así que se intenta primero el texto completo de una.
  try {
    await sendCronMessage(botToken, { chatId, text });
    return;
  } catch {
    // sendCronMessage ya logueó el fallo de Rich Messages — si igual falló el fallback HTML,
    // puede ser por longitud (>4096) en vez de un problema de red: reintentar paginado.
  }
  for (const chunk of paginateReport(text)) {
    try {
      await sendCronMessage(botToken, { chatId, text: chunk });
    } catch (err) {
      console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_report_send_failed", err: String(err) }));
      return;
    }
  }
}
