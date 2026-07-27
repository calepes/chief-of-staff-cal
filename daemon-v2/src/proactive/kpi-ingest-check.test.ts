import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSuccessReport, formatPdfSuccessReport } from "./kpi-ingest-check.js";
import type { PdfKpiFields } from "./kpi-ingest-pdf.js";

// Fechas relativas a "ahora" para no dejar time-bombs en los tests (el filtro de recencia
// del reporte de derivados depende de Date.now(), no de un valor fijo).
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

describe("formatSuccessReport", () => {
  it("arma el texto con ingesta y derivados completados", () => {
    const text = formatSuccessReport(
      ["2026-07-20: actualizado (Stock Afiliados, Saldo)"],
      {
        completados: [{ fecha: "2026-07-20", campo: "Afiliados 7d", valor: 120 }],
        noCalculables: [{ fecha: daysAgo(7), campo: "TRX vs. Sem. anterior (%)", motivo: "no existe registro D-7" }],
      },
    );

    expect(text).toContain("2026-07-20: actualizado (Stock Afiliados, Saldo)");
    expect(text).toContain("Afiliados 7d → 120");
    expect(text).toContain("no calculable (no existe registro D-7)");
  });

  it("escapa HTML en contenido dinámico (nombres de columna de un CSV real)", () => {
    const text = formatSuccessReport(
      ["2026-07-20: actualizado (Trx & Remesas)"],
      { completados: [], noCalculables: [] },
    );

    expect(text).toContain("Trx &amp; Remesas");
    expect(text).not.toContain("Trx & Remesas");
  });

  it("muestra un texto por default si no hay ingesta ni derivados", () => {
    const text = formatSuccessReport([], { completados: [], noCalculables: [] });
    expect(text).toContain("sin filas con Fecha válida");
    expect(text).toContain("nada pendiente");
  });

  it("agrega un header con el conteo cuando hay más de 1 fecha (catch-up)", () => {
    const text = formatSuccessReport(
      ["2026-07-19: actualizado (Saldo)", "2026-07-20: actualizado (Saldo)", "2026-07-21: actualizado (Saldo)"],
      { completados: [], noCalculables: [] },
    );
    expect(text).toContain("📋 3 fechas actualizadas");
  });

  it("NO muestra el header de conteo con una sola fecha", () => {
    const text = formatSuccessReport(["2026-07-20: actualizado (Saldo)"], { completados: [], noCalculables: [] });
    expect(text).not.toContain("fechas actualizadas");
  });

  it("oculta 'no calculables' viejos (>30 días) — son permanentes, ruido puro en cada corrida", () => {
    const text = formatSuccessReport([], {
      completados: [],
      noCalculables: [{ fecha: daysAgo(200), campo: "TRX vs. Sem. anterior (%)", motivo: "no existe registro D-7 (permanente, antes del histórico)" }],
    });
    expect(text).not.toContain("permanente, antes del histórico");
    expect(text).toContain("nada pendiente"); // sin nada reciente que mostrar, cae al default
  });

  it("SÍ muestra 'no calculables' recientes (≤30 días) — son accionables", () => {
    const text = formatSuccessReport([], {
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

    const text = formatSuccessReport([], {
      completados: [],
      noCalculables: [{ fecha, campo: "Afiliaciones vs. Sem. anterior (%)", motivo: `falta afiliacionesDiarias el ${fecha}` }],
    });
    expect(text).not.toContain("Afiliaciones vs. Sem. anterior");
    expect(text).toContain("nada pendiente");
  });

  it("NO oculta 'falta afiliacionesDiarias' si NO es domingo (hueco real)", () => {
    // Buscamos el lunes más reciente — mismo motivo textual, pero un día hábil sí es accionable.
    let monday = new Date();
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() - 1);
    const fecha = monday.toISOString().slice(0, 10);

    const text = formatSuccessReport([], {
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

    const text = formatSuccessReport([], { completados, noCalculables: [] });

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
    expect(text).toContain("👥 Afiliaciones diarias: <b>4,977</b>");
    expect(text).toContain("▲ +0.4% día · ▲ +7.1% sem.");
    expect(text).toContain("🔁 TRX: <b>3,759,966</b>");
    expect(text).toContain("▲ +0.8% día · ▼ -10.3% sem.");
    expect(text).toContain("🔁 TRX Promedio 7d: <b>3,909,550</b>");
    expect(text).toContain("📊 Activos DAU: <b>1,150,676</b>");
    expect(text).toContain("▲ +0.1% día · ▼ -3.3% sem.");
    expect(text).toContain("nada pendiente");
  });

  it("omite líneas de campos que vinieron null (PDF parcial)", () => {
    const text = formatPdfSuccessReport(
      "2026-07-22",
      emptyPdfKpis({ trx: 100 }),
      { fecha: "2026-07-22", created: true, fieldsWritten: ["TRX"] },
      { completados: [], noCalculables: [] },
    );

    expect(text).toContain("🔁 TRX: <b>100</b>");
    expect(text).not.toContain("Afiliaciones diarias");
    expect(text).not.toContain("Activos DAU");
  });

  it("no muestra sufijo de tendencia si no hay % disponible", () => {
    const text = formatPdfSuccessReport(
      "2026-07-22",
      emptyPdfKpis({ afiliados7d: 4844 }),
      { fecha: "2026-07-22", created: true, fieldsWritten: ["Afiliados 7d"] },
      { completados: [], noCalculables: [] },
    );

    expect(text).toContain("👥 Afiliados 7d: <b>4,844</b>");
    expect(text).not.toContain("día");
    expect(text).not.toContain("sem.");
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
vi.mock("@cos/shared", () => ({ sendMessage: vi.fn(async () => ({ message_id: 1 })) }));
vi.mock("./kpi-card-daily.js", () => ({ checkKpiCardDaily: vi.fn() }));
vi.mock("./kpi-card-lending-daily.js", () => ({ checkKpiCardLending: vi.fn() }));

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
import { sendMessage } from "@cos/shared";
import { checkKpiCardDaily } from "./kpi-card-daily.js";
import { checkKpiCardLending } from "./kpi-card-lending-daily.js";
import { checkKpiIngest } from "./kpi-ingest-check.js";

const gmailCreds = { clientId: "c", clientSecret: "s", refreshToken: "r" };
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

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

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

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(upsertKpiRow).toHaveBeenCalledWith("n", "2026-07-20", expect.objectContaining({ Saldo: 100 }));
    // Solo la fecha recién tocada — no recalcula todo el histórico en cada corrida.
    expect(fillDerivedFields).toHaveBeenCalledWith("n", ["2026-07-20"]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
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

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    const [, , rawArg] = vi.mocked(upsertKpiRow).mock.calls[0];
    expect(rawArg).not.toHaveProperty("TRX");
    expect(rawArg).not.toHaveProperty("Activos DAU");
    expect(rawArg).not.toHaveProperty("Afiliaciones diarias");
    expect(rawArg).toHaveProperty("Saldo", 999);
  });

  it("no reprocesa un mensaje ya marcado como processed", async () => {
    writeFileSync(statePath, JSON.stringify({ processed: ["m1"], pending: {}, lastErrorNotified: {} }));
    vi.mocked(searchSelfServiceEmails).mockResolvedValue([{ id: "m1" }]);

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

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

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendMessage).mock.calls[0]?.[1] as { text: string };
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

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("no rompe el poll completo si falla la búsqueda en Gmail", async () => {
    vi.mocked(gmailAccessToken).mockRejectedValueOnce(new Error("token inválido"));

    await expect(
      checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath }),
    ).resolves.toBeUndefined();
  });

  it("evita corridas superpuestas: un segundo tick mientras el primero sigue corriendo no hace trabajo de Gmail", async () => {
    let resolveFirstToken!: (v: string) => void;
    const hangingTokenPromise = new Promise<string>((resolve) => {
      resolveFirstToken = resolve;
    });
    vi.mocked(gmailAccessToken).mockReturnValueOnce(hangingTokenPromise);

    const p1 = checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });
    // Para cuando esta línea corre, p1 ya ejecutó de forma síncrona hasta el `await gmailAccessToken(...)`
    // colgado — el flag `running` ya quedó en true antes de ceder el control.
    const p2 = checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

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
      gmail: gmailCreds,
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
    expect(sendMessage).toHaveBeenCalledTimes(1);
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
      gmail: gmailCreds,
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
      gmail: gmailCreds,
      statePath,
      pdfTextExtractor: async () => REAL_PDF_TEXT,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1); // el reporte de ingesta sí salió
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
      gmail: gmailCreds,
      statePath,
      pdfTextExtractor: async () => "algo algo Updated Fail! algo",
    });

    expect(upsertKpiRow).not.toHaveBeenCalled();
    expect(markPdfReportFailed).toHaveBeenCalledWith("n", "2026-07-22");
    expect(archiveAndMarkRead).not.toHaveBeenCalled();
    const call = vi.mocked(sendMessage).mock.calls[0]?.[1] as { text: string };
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

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    const call = vi.mocked(sendMessage).mock.calls[0]?.[1] as { text: string };
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
      gmail: gmailCreds,
      statePath,
      pdfTextExtractor: async () => REAL_PDF_TEXT,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1); // el reporte de éxito sí sale
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

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

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
      gmail: gmailCreds,
      statePath,
      pdfTextExtractor: async () => REAL_PDF_TEXT,
    });

    expect(upsertKpiRow).toHaveBeenCalledTimes(2);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toEqual(expect.arrayContaining(["csvMsg", "pdfMsg"]));
    expect(sendMessage).toHaveBeenCalledTimes(2);
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
      gmail: gmailCreds,
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
    expect(sendMessage).toHaveBeenCalledTimes(1);
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
      gmail: gmailCreds,
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
      gmail: gmailCreds,
      statePath,
      pdfTextExtractor: async () => REAL_LENDING_PDF_TEXT,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1); // el reporte de ingesta sí salió
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

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendMessage).mock.calls[0]?.[1] as { text: string };
    expect(call.text).toContain("sin ningún PDF");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
  });

  it("NO marca processed si no encuentra la fecha en el cuerpo del mail — reintenta el próximo tick", async () => {
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
      bodyText: "un cuerpo de mail sin la frase esperada",
    });
    vi.mocked(findPdfCandidates).mockReturnValue([lendingAttachment]);

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(upsertLendingRow).not.toHaveBeenCalled();
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).not.toContain("m1");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendMessage).mock.calls[0]?.[1] as { text: string };
    expect(call.text).toContain("cierre de la jornada");
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
      gmail: gmailCreds,
      statePath,
      pdfTextExtractor: async () => brokenText,
    });

    expect(upsertLendingRow).not.toHaveBeenCalled();
    expect(markLendingReportFailed).toHaveBeenCalledWith("n", "2026-07-26", expect.any(String));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendMessage).mock.calls[0]?.[1] as { text: string };
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

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
