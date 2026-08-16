import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSuccessReport, formatPdfSuccessReport, type CsvIngestRow } from "./kpi-ingest-check.js";
import type { PdfKpiFields } from "./kpi-ingest-pdf.js";

// Fechas relativas a "ahora" para no dejar time-bombs en los tests (el filtro de recencia
// del reporte de derivados depende de Date.now(), no de un valor fijo).
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const NINE_FIELDS = [
  "Activos 30d",
  "Stock Afiliados",
  "Saldo",
  "Activos 30d %",
  "Activos DAU %",
  "DAU Promedio 7d",
  "Ingresos Recaudacion",
  "Ingresos Recargas",
  "Ingresos PDS",
];

function csvRow(overrides: Partial<CsvIngestRow> = {}): CsvIngestRow {
  return {
    fecha: "2026-07-20",
    created: false,
    fieldsWritten: [...NINE_FIELDS],
    unmapped: [],
    illegible: [],
    ...overrides,
  };
}

// El CSV del Self-Service trae el mes-a-la-fecha COMPLETO cada día, así que la corrida
// típica reescribe ~27 fechas con los mismos 9 campos. Ese es el caso normal, no un
// catch-up: si el reporte lo desglosa fecha por fecha, Cal recibe la misma pared de texto
// todos los días. Ver Jano/CLAUDE.md, sección "scheduleKpiIngestCheck".
function monthToDate(days = 27): CsvIngestRow[] {
  return Array.from({ length: days }, (_, i) =>
    csvRow({ fecha: `2026-07-${String(i + 1).padStart(2, "0")}` }),
  );
}

describe("formatSuccessReport", () => {
  it("colapsa la corrida típica (mes-a-la-fecha) en una sola línea de resumen", () => {
    const text = formatSuccessReport(monthToDate(), { completados: [], noCalculables: [] });

    expect(text).toContain("📅 <b>2026-07-27</b> · 27 fechas · 9 campos");
    // El desglose fecha-por-fecha es exactamente el ruido que este formato elimina.
    expect(text).not.toContain("2026-07-01");
    expect(text).not.toContain("Ingresos Recargas");
    expect(text.split("\n").length).toBeLessThanOrEqual(3);
  });

  it("omite el conteo de fechas cuando el mail trae una sola", () => {
    const text = formatSuccessReport([csvRow()], { completados: [], noCalculables: [] });

    expect(text).toContain("📅 <b>2026-07-20</b> · 9 campos");
    expect(text).not.toContain("fechas ·");
  });

  it("muestra un texto explícito si no hubo ninguna fila con Fecha válida", () => {
    const text = formatSuccessReport([], { completados: [], noCalculables: [] });
    expect(text).toContain("sin filas con Fecha válida");
  });

  it("señala una fecha creada (registro nuevo) como algo a revisar", () => {
    const text = formatSuccessReport([...monthToDate(), csvRow({ fecha: "2026-07-28", created: true })], {
      completados: [],
      noCalculables: [],
    });

    expect(text).toContain("⚠️");
    expect(text).toContain("2026-07-28 → creado (fecha nueva)");
    // Las 27 fechas normales siguen sin desglosarse: solo se nombra la excepción.
    expect(text).not.toContain("2026-07-15");
  });

  it("señala columnas ilegibles y no mapeadas", () => {
    const text = formatSuccessReport(
      [csvRow(), csvRow({ fecha: "2026-07-21", illegible: ["Saldo"], unmapped: ["Columna Rara"] })],
      { completados: [], noCalculables: [] },
    );

    expect(text).toContain("2026-07-21 → ilegibles: Saldo · no mapeadas: Columna Rara");
  });

  it("señala una fecha cuyo set de campos difiere del habitual (columna que dejó de venir)", () => {
    const text = formatSuccessReport(
      [...monthToDate(), csvRow({ fecha: "2026-07-28", fieldsWritten: NINE_FIELDS.slice(0, 7) })],
      { completados: [], noCalculables: [] },
    );

    expect(text).toContain("2026-07-28 → 7 campos (lo habitual son 9)");
  });

  it("señala una fecha sin ningún campo escrito", () => {
    const text = formatSuccessReport([csvRow(), csvRow({ fecha: "2026-07-21", fieldsWritten: [] })], {
      completados: [],
      noCalculables: [],
    });

    expect(text).toContain("2026-07-21 → sin campos");
  });

  it("NO agrega el bloque de revisión cuando todo salió normal", () => {
    const text = formatSuccessReport(monthToDate(), { completados: [], noCalculables: [] });
    expect(text).not.toContain("Revisar");
    expect(text).not.toContain("⚠️");
  });

  it("cap el bloque de revisión y avisa cuántas fechas faltan", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      csvRow({ fecha: `2026-06-${String(i + 1).padStart(2, "0")}`, created: true }),
    );

    const text = formatSuccessReport(rows, { completados: [], noCalculables: [] });

    expect(text).toContain("+15 más");
    expect(text).not.toContain("2026-06-30 → creado");
  });

  it("escapa HTML en contenido dinámico (nombres de columna de un CSV real)", () => {
    const text = formatSuccessReport([csvRow({ illegible: ["Trx & Remesas"] })], {
      completados: [],
      noCalculables: [],
    });

    expect(text).toContain("Trx &amp; Remesas");
    expect(text).not.toContain("Trx & Remesas");
  });

  it("omite la sección de derivados cuando no hay nada pendiente", () => {
    const text = formatSuccessReport(monthToDate(), { completados: [], noCalculables: [] });
    expect(text).not.toContain("Derivados");
    expect(text).not.toContain("nada pendiente");
  });

  it("muestra los derivados completados cuando los hay", () => {
    const text = formatSuccessReport(monthToDate(), {
      completados: [{ fecha: "2026-07-20", campo: "Afiliados 7d", valor: 120 }],
      noCalculables: [{ fecha: daysAgo(7), campo: "TRX vs. Sem. anterior (%)", motivo: "no existe registro D-7" }],
    });

    expect(text).toContain("Derivados");
    expect(text).toContain("Afiliados 7d → 120");
    expect(text).toContain("no calculable (no existe registro D-7)");
  });

  it("oculta 'no calculables' viejos (>30 días) — son permanentes, ruido puro en cada corrida", () => {
    const text = formatSuccessReport(monthToDate(), {
      completados: [],
      noCalculables: [{ fecha: daysAgo(200), campo: "TRX vs. Sem. anterior (%)", motivo: "no existe registro D-7 (permanente, antes del histórico)" }],
    });
    expect(text).not.toContain("permanente, antes del histórico");
    expect(text).not.toContain("Derivados"); // sin nada reciente, la sección entera se omite
  });

  it("SÍ muestra 'no calculables' recientes (≤30 días) — son accionables", () => {
    const text = formatSuccessReport(monthToDate(), {
      completados: [],
      noCalculables: [{ fecha: daysAgo(5), campo: "TRX vs. Sem. anterior (%)", motivo: "falta TRX el D-7" }],
    });
    expect(text).toContain("falta TRX el D-7");
  });

  it("oculta el hueco permanente de domingo en Afiliaciones vs. Sem. anterior (%) aunque sea reciente", () => {
    // Buscamos el domingo más reciente relativo a hoy para que el test no dependa de qué día es "hoy".
    let sunday = new Date();
    while (sunday.getUTCDay() !== 0) sunday.setUTCDate(sunday.getUTCDate() - 1);
    const fecha = sunday.toISOString().slice(0, 10);

    const text = formatSuccessReport(monthToDate(), {
      completados: [],
      noCalculables: [{ fecha, campo: "Afiliaciones vs. Sem. anterior (%)", motivo: `falta afiliacionesDiarias el ${fecha}` }],
    });
    expect(text).not.toContain("Afiliaciones vs. Sem. anterior");
    expect(text).not.toContain("Derivados");
  });

  it("NO oculta 'falta afiliacionesDiarias' si NO es domingo (hueco real)", () => {
    // Buscamos el lunes más reciente — mismo motivo textual, pero un día hábil sí es accionable.
    let monday = new Date();
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() - 1);
    const fecha = monday.toISOString().slice(0, 10);

    const text = formatSuccessReport(monthToDate(), {
      completados: [],
      noCalculables: [{ fecha, campo: "Afiliaciones vs. Sem. anterior (%)", motivo: `falta afiliacionesDiarias el ${fecha}` }],
    });
    expect(text).toContain("Afiliaciones vs. Sem. anterior");
  });

  it("cap el reporte de derivados a 25 líneas y avisa cuántas faltan (backfill grande)", () => {
    const completados = Array.from({ length: 40 }, (_, i) => ({
      fecha: `2026-01-${String(i + 1).padStart(2, "0")}`,
      campo: "Afiliados 7d",
      valor: i,
    }));

    const text = formatSuccessReport(monthToDate(), { completados, noCalculables: [] });

    expect(text).toContain("+15 más");
    // La entrada #30 (índice 29) queda fuera del cap de 25 — no debe aparecer completa.
    expect(text).not.toContain("2026-01-30 → Afiliados 7d → 29");
  });
});

function emptyPdfKpis(overrides: Partial<PdfKpiFields> = {}): PdfKpiFields {
  return {
    afiliacionesDiarias: null,
    afiliados7d: null,
    trx: null,
    trxPromedio7d: null,
    activosDau: null,
    afiliacionesVsAyer: null,
    afiliacionesVsSemana: null,
    trxVsAyer: null,
    trxVsSemana: null,
    dauVsAyer: null,
    dauVsSemana: null,
    ...overrides,
  };
}

describe("formatPdfSuccessReport", () => {
  it("muestra los valores reales con separador de miles, tendencia y emoji por categoría", () => {
    const text = formatPdfSuccessReport(
      "2026-07-22",
      emptyPdfKpis({
        afiliacionesDiarias: 4977,
        afiliados7d: 4844,
        trx: 3759966,
        trxPromedio7d: 3909550,
        activosDau: 1150676,
        afiliacionesVsAyer: 0.004,
        afiliacionesVsSemana: 0.071,
        trxVsAyer: 0.008,
        trxVsSemana: -0.103,
        dauVsAyer: 0.001,
        dauVsSemana: -0.033,
      }),
      { fecha: "2026-07-22", created: false, fieldsWritten: ["Afiliaciones diarias", "TRX", "Activos DAU"] },
      { completados: [], noCalculables: [] },
    );

    expect(text).toContain("Seguimiento Diario");
    expect(text).toContain("📅 <b>2026-07-22</b> (actualizado)");
    // Tabla real (Rich Messages), no líneas sueltas — datos comparables métrica × día/semana.
    expect(text).toContain("<table>");
    expect(text).toContain("<th>Métrica</th><th>Valor</th><th>Día</th><th>Sem.</th>");
    expect(text).toContain("<tr><td>👥 Afiliaciones diarias</td><td><b>4,977</b></td><td>▲ +0.4%</td><td>▲ +7.1%</td></tr>");
    expect(text).toContain("<tr><td>🔁 TRX</td><td><b>3,759,966</b></td><td>▲ +0.8%</td><td>▼ -10.3%</td></tr>");
    expect(text).toContain("<tr><td>🔁 TRX Promedio 7d</td><td><b>3,909,550</b></td><td>—</td><td>—</td></tr>");
    expect(text).toContain("<tr><td>📊 Activos DAU</td><td><b>1,150,676</b></td><td>▲ +0.1%</td><td>▼ -3.3%</td></tr>");
    // Sin derivados pendientes la sección entera se omite (antes imprimía "• nada pendiente").
    expect(text).not.toContain("Derivados");
  });

  it("omite filas de campos que vinieron null (PDF parcial)", () => {
    const text = formatPdfSuccessReport(
      "2026-07-22",
      emptyPdfKpis({ trx: 100 }),
      { fecha: "2026-07-22", created: true, fieldsWritten: ["TRX"] },
      { completados: [], noCalculables: [] },
    );

    expect(text).toContain("<tr><td>🔁 TRX</td><td><b>100</b></td><td>—</td><td>—</td></tr>");
    expect(text).not.toContain("Afiliaciones diarias");
    expect(text).not.toContain("Activos DAU");
  });

  it("muestra — en vez de tendencia si no hay % disponible", () => {
    const text = formatPdfSuccessReport(
      "2026-07-22",
      emptyPdfKpis({ afiliados7d: 4844 }),
      { fecha: "2026-07-22", created: true, fieldsWritten: ["Afiliados 7d"] },
      { completados: [], noCalculables: [] },
    );

    expect(text).toContain("<tr><td>👥 Afiliados 7d</td><td><b>4,844</b></td><td>—</td><td>—</td></tr>");
  });

  it("no manda tabla si ningún campo vino (todo null)", () => {
    const text = formatPdfSuccessReport(
      "2026-07-22",
      emptyPdfKpis({}),
      { fecha: "2026-07-22", created: true, fieldsWritten: [] },
      { completados: [], noCalculables: [] },
    );

    expect(text).not.toContain("<table>");
    expect(text).toContain("sin campos");
  });
});

vi.mock("./kpi-ingest-gmail.js", () => ({
  gmailAccessToken: vi.fn(async () => "atok"),
  searchSelfServiceEmails: vi.fn(),
  searchSeguimientoDiarioEmails: vi.fn(),
  searchLendingReportEmails: vi.fn(),
  getGmailMessage: vi.fn(),
  findCsvCandidates: vi.fn(),
  findPdfCandidates: vi.fn(),
  downloadGmailAttachment: vi.fn(),
  downloadGmailAttachmentBuffer: vi.fn(),
  archiveAndMarkRead: vi.fn(),
}));
vi.mock("./kpi-ingest-notion.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    upsertKpiRow: vi.fn(),
    fillDerivedFields: vi.fn(),
    markPdfReportFailed: vi.fn(),
    clearPdfFailNote: vi.fn(),
  };
});
vi.mock("./kpi-lending-notion.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    upsertLendingRow: vi.fn(),
    markLendingReportFailed: vi.fn(),
    clearLendingFailNote: vi.fn(),
    fillLendingDerivedFields: vi.fn(),
  };
});
vi.mock("./rich-send.js", () => ({ sendCronMessage: vi.fn(async () => ({ message_id: 1 })) }));
vi.mock("./kpi-card-daily.js", () => ({ checkKpiCardDaily: vi.fn() }));
vi.mock("./kpi-card-lending-daily.js", () => ({ checkKpiCardLending: vi.fn() }));
vi.mock("./lending-date-confirm.js", () => ({
  LendingDateStore: vi.fn().mockImplementation(() => ({
    createProposal: vi.fn(async () => "abc123"),
    getProposal: vi.fn(async () => null),
    clearProposal: vi.fn(async () => {}),
    setPendingInput: vi.fn(async () => {}),
    getPendingInput: vi.fn(async () => null),
    clearPendingInput: vi.fn(async () => {}),
  })),
  previousBusinessDay: vi.fn((iso: string) => iso),
  renderProposeCard: vi.fn((shortId: string, fecha: string, subject: string) => ({
    text: `propose:${fecha}:${subject}`,
    keyboard: { inline_keyboard: [] },
  })),
}));

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
} from "./kpi-ingest-gmail.js";
import { upsertKpiRow, fillDerivedFields, markPdfReportFailed, clearPdfFailNote } from "./kpi-ingest-notion.js";
import { upsertLendingRow, markLendingReportFailed, clearLendingFailNote, fillLendingDerivedFields } from "./kpi-lending-notion.js";
import { sendCronMessage } from "./rich-send.js";
import { checkKpiCardDaily } from "./kpi-card-daily.js";
import { checkKpiCardLending } from "./kpi-card-lending-daily.js";
import { checkKpiIngest } from "./kpi-ingest-check.js";
import { LendingDateStore } from "./lending-date-confirm.js";

const gmailCreds = { clientId: "c", clientSecret: "s", refreshToken: "r" };
const lendingDateStore = new LendingDateStore({} as any);
let tmpDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kpi-ingest-test-"));
  statePath = join(tmpDir, "state.json");
  vi.clearAllMocks();
  // Defaults inofensivos — cada test override solo el pipeline que le importa.
  vi.mocked(searchSelfServiceEmails).mockResolvedValue([]);
  vi.mocked(searchSeguimientoDiarioEmails).mockResolvedValue([]);
  vi.mocked(searchLendingReportEmails).mockResolvedValue([]);
  vi.mocked(checkKpiCardDaily).mockResolvedValue(undefined);
  vi.mocked(checkKpiCardLending).mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkKpiIngest — pipeline CSV (Self-Service)", () => {
  it("agrega un mensaje nuevo a pending sin procesarlo todavía", async () => {
    vi.mocked(searchSelfServiceEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({ id: "m1", internalDate: Date.now(), attachments: [] });

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath });

    expect(upsertKpiRow).not.toHaveBeenCalled();
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.pending.m1).toBeDefined();
  });

  it("procesa un mensaje pending que ya pasó los 15 minutos", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchSelfServiceEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: oldTimestamp,
      attachments: [{ filename: "kpis.csv", mimeType: "text/csv", attachmentId: "a1" }],
    });
    vi.mocked(findCsvCandidates).mockReturnValue([{ filename: "kpis.csv", mimeType: "text/csv", attachmentId: "a1" }]);
    vi.mocked(downloadGmailAttachment).mockResolvedValue("Fecha,Saldo\n2026-07-20,100\n");
    vi.mocked(upsertKpiRow).mockResolvedValue({ fecha: "2026-07-20", created: true, fieldsWritten: ["Saldo"] });
    vi.mocked(fillDerivedFields).mockResolvedValue({ completados: [], noCalculables: [] });

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath });

    expect(upsertKpiRow).toHaveBeenCalledWith("n", "2026-07-20", expect.objectContaining({ Saldo: 100 }));
    // Solo la fecha recién tocada — no recalcula todo el histórico en cada corrida.
    expect(fillDerivedFields).toHaveBeenCalledWith("n", ["2026-07-20"]);
    expect(sendCronMessage).toHaveBeenCalledTimes(1);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
    expect(state.pending.m1).toBeUndefined();
  });

  it("NO escribe Afiliaciones diarias/TRX/Activos DAU aunque el CSV los traiga — son campos exclusivos del PDF", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchSelfServiceEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: oldTimestamp,
      attachments: [{ filename: "kpis.csv", mimeType: "text/csv", attachmentId: "a1" }],
    });
    vi.mocked(findCsvCandidates).mockReturnValue([{ filename: "kpis.csv", mimeType: "text/csv", attachmentId: "a1" }]);
    vi.mocked(downloadGmailAttachment).mockResolvedValue(
      "Fecha,TRX,Activos DAU,Afiliaciones diarias,Saldo\n2026-07-20,100,50,10,999\n",
    );
    vi.mocked(upsertKpiRow).mockResolvedValue({ fecha: "2026-07-20", created: true, fieldsWritten: ["Saldo"] });
    vi.mocked(fillDerivedFields).mockResolvedValue({ completados: [], noCalculables: [] });

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath });

    const [, , rawArg] = vi.mocked(upsertKpiRow).mock.calls[0];
    expect(rawArg).not.toHaveProperty("TRX");
    expect(rawArg).not.toHaveProperty("Activos DAU");
    expect(rawArg).not.toHaveProperty("Afiliaciones diarias");
    expect(rawArg).toHaveProperty("Saldo", 999);
  });

  it("no reprocesa un mensaje ya marcado como processed", async () => {
    writeFileSync(statePath, JSON.stringify({ processed: ["m1"], pending: {}, lastErrorNotified: {} }));
    vi.mocked(searchSelfServiceEmails).mockResolvedValue([{ id: "m1" }]);

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath });

    expect(getGmailMessage).not.toHaveBeenCalled();
  });

  it("reporta y marca processed si no hay CSV adjunto", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchSelfServiceEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({ id: "m1", internalDate: oldTimestamp, attachments: [] });
    vi.mocked(findCsvCandidates).mockReturnValue([]);

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath });

    expect(sendCronMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendCronMessage).mock.calls[0]?.[1] as { text: string };
    expect(call.text).toContain("sin ningún CSV");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
  });

  it("dedupea la notificación de error del mismo mensaje dentro de 2 horas", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    const recentError = Date.now() - 30 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({
        processed: [],
        pending: { m1: { receivedAt: oldTimestamp } },
        lastErrorNotified: { m1: recentError },
      }),
    );
    vi.mocked(searchSelfServiceEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockRejectedValue(new Error("gmail caído"));

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath });

    expect(sendCronMessage).not.toHaveBeenCalled();
  });

  it("no rompe el poll completo si falla la búsqueda en Gmail", async () => {
    vi.mocked(gmailAccessToken).mockRejectedValueOnce(new Error("token inválido"));

    await expect(
      checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath }),
    ).resolves.toBeUndefined();
  });

  it("evita corridas superpuestas: un segundo tick mientras el primero sigue corriendo no hace trabajo de Gmail", async () => {
    let resolveFirstToken!: (v: string) => void;
    const hangingTokenPromise = new Promise<string>((resolve) => {
      resolveFirstToken = resolve;
    });
    vi.mocked(gmailAccessToken).mockReturnValueOnce(hangingTokenPromise);

    const p1 = checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath });
    // Para cuando esta línea corre, p1 ya ejecutó de forma síncrona hasta el `await gmailAccessToken(...)`
    // colgado — el flag `running` ya quedó en true antes de ceder el control.
    const p2 = checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath });

    await expect(p2).resolves.toBeUndefined();
    // El segundo tick debe cortar antes de tocar Gmail — un solo llamado (el del primer tick, todavía colgado).
    expect(gmailAccessToken).toHaveBeenCalledTimes(1);

    resolveFirstToken("atok");
    await expect(p1).resolves.toBeUndefined();
  });
});

const REAL_PDF_TEXT = `Afiliaciones diarias
4,977
vs. Día anterior : ▲ +0.4%
vs. Sem. anterior : ▲ +7.1%
TRX
3,759,966
vs. Día anterior : ▲ +0.8%
vs. Sem. anterior : ▼ -10.3%
Activos DAU
1,150,676
vs. Día anterior : ▲ +0.1%
vs. Sem. anterior : ▼ -3.3%
`;

describe("checkKpiIngest — pipeline PDF (Seguimiento Diario)", () => {
  const pdfAttachment = { filename: "Seguimiento Diario Yape | 22/07/2026.PDF", mimeType: "application/pdf", attachmentId: "p1" };

  it("procesa un PDF pending, escribe los campos y archiva el mail", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchSeguimientoDiarioEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({ id: "m1", internalDate: oldTimestamp, attachments: [pdfAttachment] });
    vi.mocked(findPdfCandidates).mockReturnValue([pdfAttachment]);
    vi.mocked(downloadGmailAttachmentBuffer).mockResolvedValue(Buffer.from("fake-pdf-bytes"));
    vi.mocked(upsertKpiRow).mockResolvedValue({
      fecha: "2026-07-22",
      created: false,
      fieldsWritten: ["Afiliaciones diarias", "TRX", "Activos DAU"],
    });
    vi.mocked(fillDerivedFields).mockResolvedValue({ completados: [], noCalculables: [] });
    vi.mocked(archiveAndMarkRead).mockResolvedValue(undefined);

    await checkKpiIngest({
      botToken: "t",
      chatId: 1,
      notionToken: "n",
      gmail: gmailCreds, lendingDateStore,
      statePath,
      pdfTextExtractor: async () => REAL_PDF_TEXT,
    });

    expect(upsertKpiRow).toHaveBeenCalledWith(
      "n",
      "2026-07-22",
      expect.objectContaining({ "Afiliaciones diarias": 4977, TRX: 3759966, "Activos DAU": 1150676 }),
    );
    expect(clearPdfFailNote).toHaveBeenCalledWith("n", "2026-07-22");
    expect(fillDerivedFields).toHaveBeenCalledWith("n", ["2026-07-22"]);
    expect(archiveAndMarkRead).toHaveBeenCalledWith("m1", "atok");
    // La tarjeta se dispara sola apenas el PDF escribe con éxito — ya no espera el cron de 10:00.
    expect(checkKpiCardDaily).toHaveBeenCalledWith({ botToken: "t", chatId: 1, notionToken: "n", fecha: "2026-07-22" });
    expect(sendCronMessage).toHaveBeenCalledTimes(1);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
    expect(state.cardSent).toEqual(["2026-07-22"]);
  });

  it("no dispara la tarjeta dos veces para la misma fecha (dedup vía cardSent)", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({
        processed: [],
        pending: { m2: { receivedAt: oldTimestamp } },
        lastErrorNotified: {},
        cardSent: ["2026-07-22"], // ya se mandó hoy para esta fecha (ej. un reintento del PDF)
      }),
    );
    vi.mocked(searchSeguimientoDiarioEmails).mockResolvedValue([{ id: "m2" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({ id: "m2", internalDate: oldTimestamp, attachments: [pdfAttachment] });
    vi.mocked(findPdfCandidates).mockReturnValue([pdfAttachment]);
    vi.mocked(downloadGmailAttachmentBuffer).mockResolvedValue(Buffer.from("fake-pdf-bytes"));
    vi.mocked(upsertKpiRow).mockResolvedValue({ fecha: "2026-07-22", created: false, fieldsWritten: ["TRX"] });
    vi.mocked(fillDerivedFields).mockResolvedValue({ completados: [], noCalculables: [] });
    vi.mocked(archiveAndMarkRead).mockResolvedValue(undefined);

    await checkKpiIngest({
      botToken: "t",
      chatId: 1,
      notionToken: "n",
      gmail: gmailCreds, lendingDateStore,
      statePath,
      pdfTextExtractor: async () => REAL_PDF_TEXT,
    });

    expect(checkKpiCardDaily).not.toHaveBeenCalled();
  });

  it("si checkKpiCardDaily lanza una excepción, no rompe el resto del flujo ni deja de marcar processed", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchSeguimientoDiarioEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({ id: "m1", internalDate: oldTimestamp, attachments: [pdfAttachment] });
    vi.mocked(findPdfCandidates).mockReturnValue([pdfAttachment]);
    vi.mocked(downloadGmailAttachmentBuffer).mockResolvedValue(Buffer.from("fake-pdf-bytes"));
    vi.mocked(upsertKpiRow).mockResolvedValue({ fecha: "2026-07-22", created: false, fieldsWritten: ["TRX"] });
    vi.mocked(fillDerivedFields).mockResolvedValue({ completados: [], noCalculables: [] });
    vi.mocked(archiveAndMarkRead).mockResolvedValue(undefined);
    vi.mocked(checkKpiCardDaily).mockRejectedValue(new Error("boom inesperado"));

    await checkKpiIngest({
      botToken: "t",
      chatId: 1,
      notionToken: "n",
      gmail: gmailCreds, lendingDateStore,
      statePath,
      pdfTextExtractor: async () => REAL_PDF_TEXT,
    });

    expect(sendCronMessage).toHaveBeenCalledTimes(1); // el reporte de ingesta sí salió
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
    expect(state.cardSent).toEqual([]); // no se marca si tiró excepción — queda para reintentar
  });

  it("reporte fallido ('updated fail'): no toca KPIs, marca Notas, no archiva", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchSeguimientoDiarioEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({ id: "m1", internalDate: oldTimestamp, attachments: [pdfAttachment] });
    vi.mocked(findPdfCandidates).mockReturnValue([pdfAttachment]);
    vi.mocked(downloadGmailAttachmentBuffer).mockResolvedValue(Buffer.from("fake-pdf-bytes"));

    await checkKpiIngest({
      botToken: "t",
      chatId: 1,
      notionToken: "n",
      gmail: gmailCreds, lendingDateStore,
      statePath,
      pdfTextExtractor: async () => "algo algo Updated Fail! algo",
    });

    expect(upsertKpiRow).not.toHaveBeenCalled();
    expect(markPdfReportFailed).toHaveBeenCalledWith("n", "2026-07-22");
    expect(archiveAndMarkRead).not.toHaveBeenCalled();
    const call = vi.mocked(sendCronMessage).mock.calls[0]?.[1] as { text: string };
    expect(call.text).toContain("fallido");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1"); // no se reintenta este mismo mail — el reintento llega como OTRO mail
  });

  it("reporta y marca processed si no hay PDF adjunto", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchSeguimientoDiarioEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({ id: "m1", internalDate: oldTimestamp, attachments: [] });
    vi.mocked(findPdfCandidates).mockReturnValue([]);

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath });

    const call = vi.mocked(sendCronMessage).mock.calls[0]?.[1] as { text: string };
    expect(call.text).toContain("sin ningún PDF");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
  });

  it("si el archivado falla (sin scope gmail.modify todavía), no rompe el resto del flujo", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchSeguimientoDiarioEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({ id: "m1", internalDate: oldTimestamp, attachments: [pdfAttachment] });
    vi.mocked(findPdfCandidates).mockReturnValue([pdfAttachment]);
    vi.mocked(downloadGmailAttachmentBuffer).mockResolvedValue(Buffer.from("fake-pdf-bytes"));
    vi.mocked(upsertKpiRow).mockResolvedValue({ fecha: "2026-07-22", created: false, fieldsWritten: ["TRX"] });
    vi.mocked(fillDerivedFields).mockResolvedValue({ completados: [], noCalculables: [] });
    vi.mocked(archiveAndMarkRead).mockRejectedValue(new Error("403 insufficient scope"));

    await checkKpiIngest({
      botToken: "t",
      chatId: 1,
      notionToken: "n",
      gmail: gmailCreds, lendingDateStore,
      statePath,
      pdfTextExtractor: async () => REAL_PDF_TEXT,
    });

    expect(sendCronMessage).toHaveBeenCalledTimes(1); // el reporte de éxito sí sale
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
  });

  it("filename sin fecha reconocible: reporta error y reintenta en el próximo tick (no marca processed)", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchSeguimientoDiarioEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: oldTimestamp,
      attachments: [{ filename: "reporte-sin-fecha.pdf", mimeType: "application/pdf", attachmentId: "p1" }],
    });
    vi.mocked(findPdfCandidates).mockReturnValue([
      { filename: "reporte-sin-fecha.pdf", mimeType: "application/pdf", attachmentId: "p1" },
    ]);

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath });

    expect(upsertKpiRow).not.toHaveBeenCalled();
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).not.toContain("m1"); // sigue pending, se reintenta
  });

  it("las dos búsquedas (CSV y PDF) corren en el mismo tick, sin pisarse", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({
        processed: [],
        pending: { csvMsg: { receivedAt: oldTimestamp }, pdfMsg: { receivedAt: oldTimestamp } },
        lastErrorNotified: {},
      }),
    );
    vi.mocked(searchSelfServiceEmails).mockResolvedValue([{ id: "csvMsg" }]);
    vi.mocked(searchSeguimientoDiarioEmails).mockResolvedValue([{ id: "pdfMsg" }]);
    vi.mocked(getGmailMessage).mockImplementation(async (id: string) => {
      if (id === "csvMsg") {
        return { id, internalDate: oldTimestamp, attachments: [{ filename: "kpis.csv", mimeType: "text/csv", attachmentId: "a1" }] };
      }
      return { id, internalDate: oldTimestamp, attachments: [pdfAttachment] };
    });
    vi.mocked(findCsvCandidates).mockReturnValue([{ filename: "kpis.csv", mimeType: "text/csv", attachmentId: "a1" }]);
    vi.mocked(findPdfCandidates).mockReturnValue([pdfAttachment]);
    vi.mocked(downloadGmailAttachment).mockResolvedValue("Fecha,Saldo\n2026-07-20,999\n");
    vi.mocked(downloadGmailAttachmentBuffer).mockResolvedValue(Buffer.from("fake-pdf-bytes"));
    vi.mocked(upsertKpiRow).mockResolvedValue({ fecha: "2026-07-20", created: true, fieldsWritten: ["Saldo"] });
    vi.mocked(fillDerivedFields).mockResolvedValue({ completados: [], noCalculables: [] });
    vi.mocked(archiveAndMarkRead).mockResolvedValue(undefined);

    await checkKpiIngest({
      botToken: "t",
      chatId: 1,
      notionToken: "n",
      gmail: gmailCreds, lendingDateStore,
      statePath,
      pdfTextExtractor: async () => REAL_PDF_TEXT,
    });

    expect(upsertKpiRow).toHaveBeenCalledTimes(2);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toEqual(expect.arrayContaining(["csvMsg", "pdfMsg"]));
    expect(sendCronMessage).toHaveBeenCalledTimes(2);
  });
});

// Texto real extraído del PDF "LENDING.pdf" (correo del cierre 2026-07-26, verificado a mano).
const REAL_LENDING_PDF_TEXT =
  "Power BI Desktop\nLEADS ENVIADOS\n0 \t29.090\n15.720\nNOTIFICACIONES\n0,00K \t15,72K\n12K\nCLICK POP UP\n0,00K \t12,13K\n2066\nCONTACTADOS\n0 \t2066\n1098\nFUNNEL PILOTO YAPE LENDING\nDERIVADOS AGENCIA\n0 \t1098\n435\nDESEMBOLSOS\n0 \t140\n85\nLEADS\n15.720\n100 %\nVISTOS\n12.129\n77,2 %\nNO VISTOS\n3.591\n22,8 %\nME INTERESA\n2.066\nNO ME INTERESA\n3.717\n17,0 %\n30,6 %\nCONTACTADO\n1.098\nNO CONTACTADO\n968\n53,1 %\n46,9 %\nMONTO APROBADO\nAll \t\nCIUDAD\nAll \t\nDESEMBOLSO\n85\nEN PROCESO\n44\n60,7 %\n31,4 %NO DERIVADOS\n663\nDERIVADOS\n435\n60,4 %\n39,6 %\nEN PROCESO\n295\n67,8 %\nAGENCIA\n140\n32,2 %\nRECHAZADO\n11\n7,9 %\nSIN INTERACCIÓN\n6.346\n52,3 %\n\n-- 1 of 1 --\n\n";

const LENDING_BODY_TEXT = "información actualizada al cierre de la jornada de 2026-07-26 .";

describe("checkKpiIngest — pipeline Lending (Funnel Créditos Yape)", () => {
  const lendingAttachment = { filename: "LENDING.pdf", mimeType: "application/pdf", attachmentId: "l1" };

  it("procesa un reporte Lending pending, escribe los 15 campos y limpia la nota de fallo previa", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchLendingReportEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: oldTimestamp,
      attachments: [lendingAttachment],
      bodyText: LENDING_BODY_TEXT,
    });
    vi.mocked(findPdfCandidates).mockReturnValue([lendingAttachment]);
    vi.mocked(downloadGmailAttachmentBuffer).mockResolvedValue(Buffer.from("fake-lending-pdf-bytes"));
    vi.mocked(upsertLendingRow).mockResolvedValue({ fecha: "2026-07-26", created: true, fieldsWritten: ["Leads", "Desembolso"] });
    vi.mocked(fillLendingDerivedFields).mockResolvedValue({ completados: [], noCalculables: [] });

    await checkKpiIngest({
      botToken: "t",
      chatId: 1,
      notionToken: "n",
      gmail: gmailCreds, lendingDateStore,
      statePath,
      pdfTextExtractor: async () => REAL_LENDING_PDF_TEXT,
    });

    expect(upsertLendingRow).toHaveBeenCalledWith(
      "n",
      "2026-07-26",
      expect.objectContaining({ Leads: 15720, Desembolso: 85, "En Proceso (Agencia)": 44, "En Proceso (Derivados)": 295 }),
    );
    expect(clearLendingFailNote).toHaveBeenCalledWith("n", "2026-07-26");
    expect(fillLendingDerivedFields).toHaveBeenCalledWith("n", ["2026-07-26"]);
    expect(markLendingReportFailed).not.toHaveBeenCalled();
    expect(checkKpiCardLending).toHaveBeenCalledWith({ botToken: "t", chatId: 1, notionToken: "n", fecha: "2026-07-26" });
    expect(sendCronMessage).toHaveBeenCalledTimes(1);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
    expect(state.lendingCardSent).toEqual(["2026-07-26"]);
  });

  it("no dispara la tarjeta de Lending dos veces para la misma fecha (dedup vía lendingCardSent)", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({
        processed: [],
        pending: { m2: { receivedAt: oldTimestamp } },
        lastErrorNotified: {},
        lendingCardSent: ["2026-07-26"],
      }),
    );
    vi.mocked(searchLendingReportEmails).mockResolvedValue([{ id: "m2" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m2",
      internalDate: oldTimestamp,
      attachments: [lendingAttachment],
      bodyText: LENDING_BODY_TEXT,
    });
    vi.mocked(findPdfCandidates).mockReturnValue([lendingAttachment]);
    vi.mocked(downloadGmailAttachmentBuffer).mockResolvedValue(Buffer.from("fake-lending-pdf-bytes"));
    vi.mocked(upsertLendingRow).mockResolvedValue({ fecha: "2026-07-26", created: false, fieldsWritten: ["Desembolso"] });
    vi.mocked(fillLendingDerivedFields).mockResolvedValue({ completados: [], noCalculables: [] });

    await checkKpiIngest({
      botToken: "t",
      chatId: 1,
      notionToken: "n",
      gmail: gmailCreds, lendingDateStore,
      statePath,
      pdfTextExtractor: async () => REAL_LENDING_PDF_TEXT,
    });

    expect(checkKpiCardLending).not.toHaveBeenCalled();
  });

  it("si checkKpiCardLending lanza una excepción, no rompe el resto del flujo ni deja de marcar processed", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchLendingReportEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: oldTimestamp,
      attachments: [lendingAttachment],
      bodyText: LENDING_BODY_TEXT,
    });
    vi.mocked(findPdfCandidates).mockReturnValue([lendingAttachment]);
    vi.mocked(downloadGmailAttachmentBuffer).mockResolvedValue(Buffer.from("fake-lending-pdf-bytes"));
    vi.mocked(upsertLendingRow).mockResolvedValue({ fecha: "2026-07-26", created: false, fieldsWritten: ["Desembolso"] });
    vi.mocked(fillLendingDerivedFields).mockResolvedValue({ completados: [], noCalculables: [] });
    vi.mocked(checkKpiCardLending).mockRejectedValue(new Error("boom inesperado"));

    await checkKpiIngest({
      botToken: "t",
      chatId: 1,
      notionToken: "n",
      gmail: gmailCreds, lendingDateStore,
      statePath,
      pdfTextExtractor: async () => REAL_LENDING_PDF_TEXT,
    });

    expect(sendCronMessage).toHaveBeenCalledTimes(1); // el reporte de ingesta sí salió
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
    expect(state.lendingCardSent).toEqual([]); // no se marca si tiró excepción — queda para reintentar
  });

  it("reporta y marca processed si no hay PDF adjunto", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchLendingReportEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({ id: "m1", internalDate: oldTimestamp, attachments: [], bodyText: LENDING_BODY_TEXT });
    vi.mocked(findPdfCandidates).mockReturnValue([]);

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath });

    expect(sendCronMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendCronMessage).mock.calls[0]?.[1] as { text: string };
    expect(call.text).toContain("sin ningún PDF");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
  });

  it("si no encuentra la fecha en el cuerpo del mail, propone una tarjeta con fecha sugerida y SÍ marca processed", async () => {
    // Caso real 2026-08-11: quien reenvía cambió "cierre de la jornada de AAAA-MM-DD" por
    // "cierre de la anterior jornada" — reintentar en silencio nunca iba a hacer aparecer la
    // fecha, y dejaba el mail reintentando cada 15 min hasta salir de la ventana de búsqueda
    // de Gmail (3 días) sin ningún aviso final. Ahora se propone por tarjeta y Cal confirma.
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchLendingReportEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: oldTimestamp,
      attachments: [lendingAttachment],
      bodyText: "cierre de la anterior jornada",
      subject: "Reporte diario Créditos Yape Lending - Riesgos",
    });
    vi.mocked(findPdfCandidates).mockReturnValue([lendingAttachment]);

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath });

    expect(upsertLendingRow).not.toHaveBeenCalled();
    expect(lendingDateStore.createProposal).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ messageId: "m1", subject: "Reporte diario Créditos Yape Lending - Riesgos" }),
    );
    expect(sendCronMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendCronMessage).mock.calls[0]?.[1] as { text: string; replyMarkup?: unknown };
    expect(call.text).toContain("propose:");
    expect(call.replyMarkup).toBeDefined();
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
  });

  it("marca fallo explícito y processed si la reconciliación no cierra — no escribe upsertLendingRow", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchLendingReportEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: oldTimestamp,
      attachments: [lendingAttachment],
      bodyText: LENDING_BODY_TEXT,
    });
    vi.mocked(findPdfCandidates).mockReturnValue([lendingAttachment]);
    vi.mocked(downloadGmailAttachmentBuffer).mockResolvedValue(Buffer.from("fake-lending-pdf-bytes"));
    const brokenText = REAL_LENDING_PDF_TEXT.replace("VISTOS\n12.129", "VISTOS\n99999");

    await checkKpiIngest({
      botToken: "t",
      chatId: 1,
      notionToken: "n",
      gmail: gmailCreds, lendingDateStore,
      statePath,
      pdfTextExtractor: async () => brokenText,
    });

    expect(upsertLendingRow).not.toHaveBeenCalled();
    expect(markLendingReportFailed).toHaveBeenCalledWith("n", "2026-07-26", expect.any(String));
    expect(sendCronMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendCronMessage).mock.calls[0]?.[1] as { text: string };
    expect(call.text).toContain("reporte fallido");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
  });

  it("dedupea la notificación de error del mismo mensaje dentro de 2 horas", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    const recentError = Date.now() - 30 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({
        processed: [],
        pending: { m1: { receivedAt: oldTimestamp } },
        lastErrorNotified: { m1: recentError },
      }),
    );
    vi.mocked(searchLendingReportEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockRejectedValue(new Error("gmail caído"));

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, lendingDateStore, statePath });

    expect(sendCronMessage).not.toHaveBeenCalled();
  });
});
