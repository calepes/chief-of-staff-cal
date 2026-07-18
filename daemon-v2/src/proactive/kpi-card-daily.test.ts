import { describe, it, expect } from "vitest";
import { fetchDailyKpis } from "./kpi-card-daily.js";

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
});
