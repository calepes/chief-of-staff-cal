import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./kpi-ingest-gmail.js", () => ({
  gmailAccessToken: vi.fn(async () => "atok"),
  searchDailyNoteEmails: vi.fn(),
  getGmailMessage: vi.fn(),
}));
vi.mock("./daily-note-ingest.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, createDailyNotePage: vi.fn() };
});
vi.mock("@cos/shared", () => ({ sendMessage: vi.fn(async () => ({ message_id: 1 })) }));

import { gmailAccessToken, searchDailyNoteEmails, getGmailMessage } from "./kpi-ingest-gmail.js";
import { createDailyNotePage } from "./daily-note-ingest.js";
import { sendMessage } from "@cos/shared";
import { checkDailyNotes } from "./daily-note-check.js";

const gmailCreds = { clientId: "c", clientSecret: "s", refreshToken: "r" };
let tmpDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "daily-note-test-"));
  statePath = join(tmpDir, "state.json");
  vi.clearAllMocks();
  vi.mocked(searchDailyNoteEmails).mockResolvedValue([]);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkDailyNotes", () => {
  it("procesa un mail (DN) nuevo de inmediato, sin esperar ningún delay", async () => {
    vi.mocked(searchDailyNoteEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: new Date("2026-07-27T15:13:00Z").getTime(),
      attachments: [],
      subject: "(DN)  Funcionalidades de Pagos Yape Bolivia - Informe final",
      bodyHtml: "<p>Buenas tardes equipo Yape.</p>",
    });
    vi.mocked(createDailyNotePage).mockResolvedValue({ pageId: "page-1" });

    await checkDailyNotes({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(createDailyNotePage).toHaveBeenCalledWith("n", {
      title: "Funcionalidades de Pagos Yape Bolivia - Informe final",
      fecha: "2026-07-27",
      bodyMarkdown: "Buenas tardes equipo Yape.",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
  });

  it("la fecha de la nota usa el día calendario de La Paz (UTC-4), no el de UTC", async () => {
    vi.mocked(searchDailyNoteEmails).mockResolvedValue([{ id: "m1" }]);
    // 2026-07-27 23:30 hora La Paz == 2026-07-28 03:30 UTC — un toISOString() directo fecharía
    // esto 07-28, que es el día equivocado para Cal.
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: new Date("2026-07-28T03:30:00Z").getTime(),
      attachments: [],
      subject: "(DN) test tarde",
      bodyHtml: "<p>cuerpo</p>",
    });
    vi.mocked(createDailyNotePage).mockResolvedValue({ pageId: "page-1" });

    await checkDailyNotes({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    const [, arg] = vi.mocked(createDailyNotePage).mock.calls[0];
    expect(arg.fecha).toBe("2026-07-27");
  });

  it("prefiere bodyHtml sobre bodyText cuando ambos están presentes", async () => {
    vi.mocked(searchDailyNoteEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: Date.now(),
      attachments: [],
      subject: "(DN) test",
      bodyText: "texto plano crudo",
      bodyHtml: "<p>texto <b>html</b></p>",
    });
    vi.mocked(createDailyNotePage).mockResolvedValue({ pageId: "page-1" });

    await checkDailyNotes({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    const [, arg] = vi.mocked(createDailyNotePage).mock.calls[0];
    expect(arg.bodyMarkdown).toBe("texto **html**");
  });

  it("cae a bodyText si no hay bodyHtml", async () => {
    vi.mocked(searchDailyNoteEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: Date.now(),
      attachments: [],
      subject: "(DN) test",
      bodyText: "solo texto plano",
      bodyHtml: null,
    });
    vi.mocked(createDailyNotePage).mockResolvedValue({ pageId: "page-1" });

    await checkDailyNotes({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    const [, arg] = vi.mocked(createDailyNotePage).mock.calls[0];
    expect(arg.bodyMarkdown).toBe("solo texto plano");
  });

  it("no reprocesa un mensaje ya marcado como processed", async () => {
    writeFileSync(statePath, JSON.stringify({ processed: ["m1"], lastErrorNotified: {} }));
    vi.mocked(searchDailyNoteEmails).mockResolvedValue([{ id: "m1" }]);

    await checkDailyNotes({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(getGmailMessage).not.toHaveBeenCalled();
  });

  it("no crea la nota y reintenta si el mail no tiene cuerpo de texto legible", async () => {
    vi.mocked(searchDailyNoteEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: Date.now(),
      attachments: [],
      subject: "(DN) sin cuerpo",
      bodyText: null,
      bodyHtml: null,
    });

    await checkDailyNotes({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(createDailyNotePage).not.toHaveBeenCalled();
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).not.toContain("m1");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendMessage).mock.calls[0]?.[1] as { text: string };
    expect(call.text).toContain("cuerpo de texto legible");
  });

  it("false positive de la búsqueda (subject sin el tag): marca processed de una, sin reintentar ni notificar", async () => {
    vi.mocked(searchDailyNoteEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: Date.now(),
      attachments: [],
      subject: "Sin el tag en el subject",
      bodyHtml: "<p>algo</p>",
    });

    await checkDailyNotes({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(createDailyNotePage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled(); // no es un fallo transitorio — nunca va a cambiar en un retry
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
  });

  it("dedupea la notificación de error del mismo mensaje dentro de 2 horas", async () => {
    const recentError = Date.now() - 30 * 60 * 1000;
    writeFileSync(statePath, JSON.stringify({ processed: [], lastErrorNotified: { m1: recentError } }));
    vi.mocked(searchDailyNoteEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockRejectedValue(new Error("gmail caído"));

    await checkDailyNotes({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("no rompe el poll completo si falla la búsqueda en Gmail", async () => {
    vi.mocked(gmailAccessToken).mockRejectedValueOnce(new Error("token inválido"));

    await expect(
      checkDailyNotes({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath }),
    ).resolves.toBeUndefined();
  });

  it("procesa varios mails (DN) en el mismo tick", async () => {
    vi.mocked(searchDailyNoteEmails).mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    vi.mocked(getGmailMessage).mockImplementation(async (id: string) => ({
      id,
      internalDate: Date.now(),
      attachments: [],
      subject: `(DN) mail ${id}`,
      bodyHtml: `<p>cuerpo ${id}</p>`,
    }));
    vi.mocked(createDailyNotePage).mockResolvedValue({ pageId: "page-x" });

    await checkDailyNotes({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(createDailyNotePage).toHaveBeenCalledTimes(2);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toEqual(expect.arrayContaining(["m1", "m2"]));
  });

  it("evita corridas superpuestas", async () => {
    let resolveFirstToken!: (v: string) => void;
    const hangingTokenPromise = new Promise<string>((resolve) => {
      resolveFirstToken = resolve;
    });
    vi.mocked(gmailAccessToken).mockReturnValueOnce(hangingTokenPromise);

    const p1 = checkDailyNotes({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });
    const p2 = checkDailyNotes({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    await expect(p2).resolves.toBeUndefined();
    expect(gmailAccessToken).toHaveBeenCalledTimes(1);

    resolveFirstToken("atok");
    await expect(p1).resolves.toBeUndefined();
  });
});
