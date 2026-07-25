import { describe, it, expect, vi, afterEach } from "vitest";
import {
  gmailAccessToken,
  resetGmailTokenCache,
  searchSelfServiceEmails,
  searchSeguimientoDiarioEmails,
  getGmailMessage,
  findCsvCandidates,
  findPdfCandidates,
  downloadGmailAttachment,
  downloadGmailAttachmentBuffer,
  archiveAndMarkRead,
} from "./kpi-ingest-gmail.js";

const creds = { clientId: "cid", clientSecret: "csecret", refreshToken: "rtoken" };

afterEach(() => {
  resetGmailTokenCache();
  vi.clearAllMocks();
});

describe("gmailAccessToken", () => {
  it("intercambia el refresh token por un access token", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "atok", expires_in: 3600 }), { status: 200 }),
    ) as unknown as typeof fetch;

    const token = await gmailAccessToken(creds, fetchFn);

    expect(token).toBe("atok");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("cachea el token entre llamadas mientras no expiró", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "atok", expires_in: 3600 }), { status: 200 }),
    ) as unknown as typeof fetch;

    await gmailAccessToken(creds, fetchFn);
    await gmailAccessToken(creds, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("lanza si la respuesta no es ok", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(gmailAccessToken(creds, fetchFn)).rejects.toThrow("401");
  });

  it("lanza si la respuesta no trae access_token", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(gmailAccessToken(creds, fetchFn)).rejects.toThrow("access_token");
  });
});

describe("searchSelfServiceEmails", () => {
  it("devuelve los IDs de mensajes encontrados", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: "m1" }, { id: "m2" }] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await searchSelfServiceEmails("atok", fetchFn);

    expect(result).toEqual([{ id: "m1" }, { id: "m2" }]);
  });

  it("devuelve lista vacía si no hay mensajes", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    const result = await searchSelfServiceEmails("atok", fetchFn);
    expect(result).toEqual([]);
  });

  it("lanza si la API de Gmail devuelve error", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(searchSelfServiceEmails("atok", fetchFn)).rejects.toThrow("403");
  });
});

describe("searchSeguimientoDiarioEmails", () => {
  it("devuelve los IDs de mensajes encontrados", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ messages: [{ id: "m1" }] }), { status: 200 }),
    );
    const fetchFn = fetchMock as unknown as typeof fetch;

    const result = await searchSeguimientoDiarioEmails("atok", fetchFn);

    expect(result).toEqual([{ id: "m1" }]);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain("Seguimiento+Diario+Yape+Bolivia");
  });

  it("lanza si la API de Gmail devuelve error", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(searchSeguimientoDiarioEmails("atok", fetchFn)).rejects.toThrow("403");
  });
});

describe("getGmailMessage", () => {
  it("extrae internalDate y attachments anidados en multipart", async () => {
    const payload = {
      id: "m1",
      internalDate: "1753185600000",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: {} }] },
          { filename: "kpis.csv", mimeType: "text/csv", body: { attachmentId: "att1" } },
        ],
      },
    };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;

    const detail = await getGmailMessage("m1", "atok", fetchFn);

    expect(detail.internalDate).toBe(1753185600000);
    expect(detail.attachments).toEqual([{ filename: "kpis.csv", mimeType: "text/csv", attachmentId: "att1" }]);
  });

  it("devuelve attachments vacío para un mensaje sin parts (single-part, sin adjuntos)", async () => {
    const payload = {
      id: "m2",
      internalDate: "1753185600000",
      payload: { mimeType: "text/plain", body: {} },
    };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;

    const detail = await getGmailMessage("m2", "atok", fetchFn);

    expect(detail.attachments).toEqual([]);
  });

  it("lanza si la API de Gmail devuelve error", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(getGmailMessage("m1", "atok", fetchFn)).rejects.toThrow("404");
  });
});

describe("findCsvCandidates", () => {
  it("filtra solo adjuntos .csv por filename", () => {
    const attachments = [
      { filename: "kpis.csv", mimeType: "text/csv", attachmentId: "a1" },
      { filename: "logo.png", mimeType: "image/png", attachmentId: "a2" },
    ];
    expect(findCsvCandidates(attachments)).toEqual([attachments[0]]);
  });

  it("devuelve lista vacía si no hay ningún .csv", () => {
    const attachments = [{ filename: "logo.png", mimeType: "image/png", attachmentId: "a2" }];
    expect(findCsvCandidates(attachments)).toEqual([]);
  });
});

describe("findPdfCandidates", () => {
  it("filtra solo adjuntos .pdf por filename (case-insensitive)", () => {
    const attachments = [
      { filename: "Seguimiento Diario Yape | 22/07/2026.PDF", mimeType: "application/pdf", attachmentId: "a1" },
      { filename: "logo.png", mimeType: "image/png", attachmentId: "a2" },
    ];
    expect(findPdfCandidates(attachments)).toEqual([attachments[0]]);
  });

  it("devuelve lista vacía si no hay ningún .pdf", () => {
    const attachments = [{ filename: "kpis.csv", mimeType: "text/csv", attachmentId: "a1" }];
    expect(findPdfCandidates(attachments)).toEqual([]);
  });
});

describe("downloadGmailAttachment", () => {
  it("decodifica base64url a texto plano", async () => {
    const original = "Fecha,TRX\n2026-07-20,100\n";
    const b64url = Buffer.from(original).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: b64url }), { status: 200 })) as unknown as typeof fetch;

    const content = await downloadGmailAttachment("m1", "att1", "atok", fetchFn);

    expect(content).toBe(original);
  });

  it("lanza si no viene el campo data", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(downloadGmailAttachment("m1", "att1", "atok", fetchFn)).rejects.toThrow("data");
  });
});

describe("downloadGmailAttachmentBuffer", () => {
  it("decodifica base64url a Buffer binario intacto", async () => {
    const original = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]); // bytes no-UTF8 válidos
    const b64url = original.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: b64url }), { status: 200 })) as unknown as typeof fetch;

    const buf = await downloadGmailAttachmentBuffer("m1", "att1", "atok", fetchFn);

    expect(Buffer.compare(buf, original)).toBe(0);
  });
});

describe("archiveAndMarkRead", () => {
  it("llama modify con removeLabelIds INBOX y UNREAD", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const fetchFn = fetchMock as unknown as typeof fetch;

    await archiveAndMarkRead("m1", "atok", fetchFn);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/messages/m1/modify");
    expect(JSON.parse(init.body as string)).toEqual({ removeLabelIds: ["INBOX", "UNREAD"] });
  });

  it("lanza si la API de Gmail devuelve error (ej. 403 sin scope gmail.modify)", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(archiveAndMarkRead("m1", "atok", fetchFn)).rejects.toThrow("403");
  });
});
