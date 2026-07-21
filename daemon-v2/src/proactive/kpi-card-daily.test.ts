import { describe, it, expect } from "vitest";
import { readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, afterEach } from "vitest";

vi.mock("./kpi-card-image.js", () => ({
  renderKpiCardImage: vi.fn(async () => Buffer.from("fake-png-bytes")),
}));
vi.mock("../tools/telegram-files.js", () => ({
  enviarFotoLocal: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@cos/shared", () => ({
  sendMessage: vi.fn(async () => ({})),
}));

import { renderKpiCardImage } from "./kpi-card-image.js";
import { enviarFotoLocal } from "../tools/telegram-files.js";
import { sendMessage } from "@cos/shared";
import { fetchDailyKpis, checkKpiCardDaily } from "./kpi-card-daily.js";

function notionResponse(overrides: Record<string, unknown> = {}) {
  return {
    results: [
      {
        properties: {
          TRX: { number: 12_400_000 },
          "TRX vs. Sem. anterior (%)": { number: 0.032 },
          "Activos DAU": { number: 8_700_000 },
          "DAU vs. Sem. anterior (%)": { number: -0.011 },
          Fecha: { date: { start: "2026-07-17" } },
          ...overrides,
        },
      },
    ],
  };
}

describe("fetchDailyKpis", () => {
  it("parsea una respuesta válida de Notion", async () => {
    const fetchFn = (async () => new Response(JSON.stringify(notionResponse()), { status: 200 })) as unknown as typeof fetch;

    const kpis = await fetchDailyKpis("fake-token", fetchFn);

    expect(kpis).toEqual({
      trx: 12_400_000,
      trxPctChange: 0.032,
      activosDau: 8_700_000,
      activosDauPctChange: -0.011,
      fecha: "2026-07-17",
    });
  });

  it("lanza si no hay resultados", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch;

    await expect(fetchDailyKpis("fake-token", fetchFn)).rejects.toThrow("0 resultados");
  });

  it("lanza si TRX viene null", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify(notionResponse({ TRX: { number: null } })), { status: 200 })) as unknown as typeof fetch;

    await expect(fetchDailyKpis("fake-token", fetchFn)).rejects.toThrow("TRX");
  });

  it("lanza si Activos DAU viene null", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify(notionResponse({ "Activos DAU": { number: null } })), { status: 200 })) as unknown as typeof fetch;

    await expect(fetchDailyKpis("fake-token", fetchFn)).rejects.toThrow("Activos DAU");
  });

  it("lanza si la API de Notion devuelve error HTTP", async () => {
    const fetchFn = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;

    await expect(fetchDailyKpis("fake-token", fetchFn)).rejects.toThrow("401");
  });

  it("con fecha, filtra por esa fecha en vez de traer la más reciente", async () => {
    let capturedBody: string | undefined;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(notionResponse({ Fecha: { date: { start: "2026-07-18" } } })), { status: 200 });
    }) as unknown as typeof fetch;

    const kpis = await fetchDailyKpis("fake-token", fetchFn, "2026-07-18");

    expect(kpis.fecha).toBe("2026-07-18");
    const body = JSON.parse(capturedBody ?? "{}");
    expect(body.filter).toEqual({ property: "Fecha", date: { equals: "2026-07-18" } });
    expect(body.sorts).toBeUndefined();
  });

  it("con fecha, lanza error explícito si no hay fila para esa fecha", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch;

    await expect(fetchDailyKpis("fake-token", fetchFn, "2026-07-18")).rejects.toThrow("2026-07-18");
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  // El nombre del PNG temporal incluye un UUID random (kpi-card-daily.ts) — barrer por prefijo.
  const files = await readdir(tmpdir()).catch(() => [] as string[]);
  await Promise.all(
    files
      .filter((f) => f.startsWith("kpi-card-") && f.endsWith(".png"))
      .map((f) => unlink(join(tmpdir(), f)).catch(() => {})),
  );
});

describe("checkKpiCardDaily", () => {
  it("manda la tarjeta cuando todo sale bien", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(notionResponse()), { status: 200 })));

    await checkKpiCardDaily({ botToken: "tok", chatId: 123, notionToken: "ntn" });

    expect(renderKpiCardImage).toHaveBeenCalledTimes(1);
    expect(enviarFotoLocal).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("avisa por texto si falla la consulta a Notion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));

    await checkKpiCardDaily({ botToken: "tok", chatId: 123, notionToken: "ntn" });

    expect(renderKpiCardImage).not.toHaveBeenCalled();
    expect(enviarFotoLocal).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("avisa por texto si falla el render de la imagen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(notionResponse()), { status: 200 })));
    vi.mocked(renderKpiCardImage).mockRejectedValueOnce(new Error("logo no encontrado"));

    await checkKpiCardDaily({ botToken: "tok", chatId: 123, notionToken: "ntn" });

    expect(enviarFotoLocal).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("avisa por texto si Telegram rechaza el envío", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(notionResponse()), { status: 200 })));
    vi.mocked(enviarFotoLocal).mockResolvedValueOnce({ ok: false, error: "chat not found" });

    await checkKpiCardDaily({ botToken: "tok", chatId: 123, notionToken: "ntn" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("con fecha, consulta esa fecha y manda la tarjeta", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(notionResponse({ Fecha: { date: { start: "2026-07-18" } } })), { status: 200 }),
      ),
    );

    await checkKpiCardDaily({ botToken: "tok", chatId: 123, notionToken: "ntn", fecha: "2026-07-18" });

    expect(renderKpiCardImage).toHaveBeenCalledTimes(1);
    expect(enviarFotoLocal).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("con fecha sin datos, avisa por texto mencionando la fecha", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));

    await checkKpiCardDaily({ botToken: "tok", chatId: 123, notionToken: "ntn", fecha: "2026-07-18" });

    expect(renderKpiCardImage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendMessage).mock.calls[0]?.[1] as { text: string };
    expect(call.text).toContain("2026-07-18");
  });
});
