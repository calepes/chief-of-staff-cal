import { describe, it, expect, vi } from "vitest";
import { upsertKpiRow } from "./kpi-ingest-notion.js";
import {
  fetchKpiHistory,
  computeAfiliados7d,
  computeTrxVsSemana,
  computeDauVsSemana,
  computeAfiliacionesVsSemana,
  fillDerivedFields,
  markPdfReportFailed,
  clearPdfFailNote,
  PDF_FAIL_NOTE,
  type KpiHistoryRow,
} from "./kpi-ingest-notion.js";

function row(overrides: Partial<KpiHistoryRow>): KpiHistoryRow {
  return {
    id: "id",
    fecha: "2026-07-20",
    trx: null,
    activosDau: null,
    afiliacionesDiarias: null,
    afiliados7d: null,
    trxVsSemana: null,
    dauVsSemana: null,
    afiliacionesVsSemana: null,
    ...overrides,
  };
}

describe("upsertKpiRow", () => {
  it("crea una fila nueva si no existe la Fecha", async () => {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method: init?.method ?? "GET", url: String(url), body });
      if ((init?.method ?? "GET") === "POST" && String(url).includes("/query")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "new-page" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await upsertKpiRow("tok", "2026-07-20", { TRX: 1000, "Activos DAU": 500 }, fetchFn);

    expect(result).toEqual({ fecha: "2026-07-20", created: true, fieldsWritten: ["TRX", "Activos DAU"] });
    const createCall = calls.find((c) => c.url.endsWith("/v1/pages"));
    expect(createCall?.body.properties.TRX).toEqual({ number: 1000 });
    expect(createCall?.body.properties.Fecha).toEqual({ date: { start: "2026-07-20" } });
  });

  it("actualiza una fila existente con solo los campos raw provistos", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify({ results: [{ id: "existing-page", properties: {} }] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await upsertKpiRow("tok", "2026-07-20", { TRX: 2000 }, fetchFn);

    expect(result).toEqual({ fecha: "2026-07-20", created: false, fieldsWritten: ["TRX"] });
  });

  it("no llama a PATCH si no hay campos raw con valor", async () => {
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify({ results: [{ id: "existing-page", properties: {} }] }), { status: 200 });
      }
      throw new Error("no debería llamar a PATCH sin campos");
    }) as unknown as typeof fetch;

    const result = await upsertKpiRow("tok", "2026-07-20", { TRX: null }, fetchFn);

    expect(result.fieldsWritten).toEqual([]);
  });

  it("lanza si la query a Notion falla", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(upsertKpiRow("tok", "2026-07-20", { TRX: 1 }, fetchFn)).rejects.toThrow("401");
  });
});

describe("markPdfReportFailed", () => {
  it("crea la fila con la Fecha y la nota si no existía", async () => {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method: init?.method ?? "GET", url: String(url), body });
      if (String(url).includes("/query")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(JSON.stringify({ id: "new-page" }), { status: 200 });
    }) as unknown as typeof fetch;

    await markPdfReportFailed("tok", "2026-07-20", fetchFn);

    const createCall = calls.find((c) => c.url.endsWith("/v1/pages"));
    expect(createCall?.body.properties.Fecha).toEqual({ date: { start: "2026-07-20" } });
    expect(createCall?.body.properties.Notas.rich_text[0].text.content).toBe(PDF_FAIL_NOTE);
  });

  it("agrega la nota a una fila existente sin tocar KPIs", async () => {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method: init?.method ?? "GET", url: String(url), body });
      if (String(url).includes("/query")) {
        return new Response(
          JSON.stringify({ results: [{ id: "existing-page", properties: { Notas: { rich_text: [] } } }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    await markPdfReportFailed("tok", "2026-07-20", fetchFn);

    const patchCall = calls.find((c) => c.method === "PATCH");
    expect(patchCall?.body.properties.Notas.rich_text[0].text.content).toBe(PDF_FAIL_NOTE);
    expect(patchCall?.body.properties).not.toHaveProperty("TRX");
  });

  it("no duplica la nota si ya estaba marcada", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      if (String(url).includes("/query")) {
        return new Response(
          JSON.stringify({
            results: [{ id: "existing-page", properties: { Notas: { rich_text: [{ plain_text: PDF_FAIL_NOTE }] } } }],
          }),
          { status: 200 },
        );
      }
      throw new Error("no debería llamar a PATCH si ya estaba marcada");
    }) as unknown as typeof fetch;

    await markPdfReportFailed("tok", "2026-07-20", fetchFn);
  });

  it("conserva notas manuales previas al agregar la marca", async () => {
    const calls: Array<{ body: any }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(
          JSON.stringify({
            results: [{ id: "existing-page", properties: { Notas: { rich_text: [{ plain_text: "nota manual de Cal" }] } } }],
          }),
          { status: 200 },
        );
      }
      calls.push({ body: init?.body ? JSON.parse(init.body as string) : {} });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    await markPdfReportFailed("tok", "2026-07-20", fetchFn);

    const content = calls[0].body.properties.Notas.rich_text[0].text.content;
    expect(content).toContain("nota manual de Cal");
    expect(content).toContain(PDF_FAIL_NOTE);
  });
});

describe("clearPdfFailNote", () => {
  it("limpia la nota si estaba marcada como fallida", async () => {
    const calls: Array<{ body: any }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(
          JSON.stringify({
            results: [{ id: "existing-page", properties: { Notas: { rich_text: [{ plain_text: PDF_FAIL_NOTE }] } } }],
          }),
          { status: 200 },
        );
      }
      calls.push({ body: init?.body ? JSON.parse(init.body as string) : {} });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    await clearPdfFailNote("tok", "2026-07-20", fetchFn);

    expect(calls[0].body.properties.Notas.rich_text).toEqual([]);
  });

  it("no toca nada si la fila no tenía la marca", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      if (String(url).includes("/query")) {
        return new Response(
          JSON.stringify({ results: [{ id: "existing-page", properties: { Notas: { rich_text: [] } } }] }),
          { status: 200 },
        );
      }
      throw new Error("no debería llamar a PATCH si no había marca");
    }) as unknown as typeof fetch;

    await clearPdfFailNote("tok", "2026-07-20", fetchFn);
  });

  it("no toca nada si la fila no existe", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      if (String(url).includes("/query")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      throw new Error("no debería llamar a PATCH si la fila no existe");
    }) as unknown as typeof fetch;

    await clearPdfFailNote("tok", "2026-07-20", fetchFn);
  });

  it("conserva notas manuales al limpiar la marca", async () => {
    const calls: Array<{ body: any }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(
          JSON.stringify({
            results: [{ id: "existing-page", properties: { Notas: { rich_text: [{ plain_text: `nota manual\n${PDF_FAIL_NOTE}` }] } } }],
          }),
          { status: 200 },
        );
      }
      calls.push({ body: init?.body ? JSON.parse(init.body as string) : {} });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    await clearPdfFailNote("tok", "2026-07-20", fetchFn);

    expect(calls[0].body.properties.Notas.rich_text[0].text.content).toBe("nota manual");
  });
});

describe("fetchKpiHistory", () => {
  it("pagina hasta traer todas las filas ordenadas por Fecha", async () => {
    const page1 = {
      results: [{ id: "p1", properties: { Fecha: { date: { start: "2026-07-13" } }, TRX: { number: 1000 } } }],
      has_more: true,
      next_cursor: "cursor-1",
    };
    const page2 = {
      results: [{ id: "p2", properties: { Fecha: { date: { start: "2026-07-20" } }, TRX: { number: 1100 } } }],
      has_more: false,
      next_cursor: null,
    };
    let call = 0;
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(call++ === 0 ? page1 : page2), { status: 200 })) as unknown as typeof fetch;

    const rows = await fetchKpiHistory("tok", fetchFn);

    expect(rows).toHaveLength(2);
    expect(rows[0].fecha).toBe("2026-07-13");
    expect(rows[1].fecha).toBe("2026-07-20");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("ignora filas sin Fecha", async () => {
    const page = {
      results: [{ id: "p1", properties: {} }],
      has_more: false,
      next_cursor: null,
    };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(page), { status: 200 })) as unknown as typeof fetch;

    const rows = await fetchKpiHistory("tok", fetchFn);

    expect(rows).toEqual([]);
  });
});

describe("computeAfiliados7d", () => {
  const rows: KpiHistoryRow[] = [
    row({ fecha: "2026-07-13", afiliacionesDiarias: 15 }),
    row({ fecha: "2026-07-14", afiliacionesDiarias: 12 }),
    row({ fecha: "2026-07-15", afiliacionesDiarias: 8 }),
    row({ fecha: "2026-07-16", afiliacionesDiarias: 11 }),
    row({ fecha: "2026-07-17", afiliacionesDiarias: 9 }),
    row({ fecha: "2026-07-18", afiliacionesDiarias: 14 }),
    row({ fecha: "2026-07-19", afiliacionesDiarias: null }), // domingo, normal que esté vacío
    row({ fecha: "2026-07-20", afiliacionesDiarias: 13 }),
  ];

  it("promedia excluyendo domingos", () => {
    const result = computeAfiliados7d(rows, 7);
    expect(result.ok).toBe(true);
    // D-6..D excluye 07-19 (domingo) y NO usa 07-13 (D-7, fuera de ventana): 12+8+11+9+14+13 = 67/6 = 11.
    // 07-13 se sube a 15 (en vez de 10) a propósito: si algún día la ventana se corriera a D-7..D por error,
    // el promedio pasaría a 82/7=12 y este test lo detectaría — con 10 ambas ventanas redondeaban igual.
    if (result.ok) expect(result.value).toBe(11);
  });

  it("no calculable si falta un día no-domingo de la ventana", () => {
    const withGap = rows.map((r) => (r.fecha === "2026-07-15" ? row({ ...r, afiliacionesDiarias: null }) : r));
    const result = computeAfiliados7d(withGap, 7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("2026-07-15");
  });
});

describe("computeTrxVsSemana / computeDauVsSemana / computeAfiliacionesVsSemana", () => {
  const rows: KpiHistoryRow[] = [
    row({ fecha: "2026-07-13", trx: 1000, activosDau: 500, afiliacionesDiarias: 20 }),
    row({ fecha: "2026-07-20", trx: 1100, activosDau: 550, afiliacionesDiarias: 22 }),
  ];

  it("calcula la variación % vs. 7 días antes", () => {
    const result = computeTrxVsSemana(rows, 1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeCloseTo(0.1);
  });

  it("no calculable si no existe registro D-7", () => {
    const result = computeDauVsSemana([rows[1]], 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("D-7");
  });

  it("no calculable si D-7 es 0", () => {
    const withZero = [row({ fecha: "2026-07-13", afiliacionesDiarias: 0 }), rows[1]];
    const result = computeAfiliacionesVsSemana(withZero, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("0");
  });

  it("no calculable si falta el valor del día D", () => {
    const withMissing = [rows[0], row({ fecha: "2026-07-20", trx: null })];
    const result = computeTrxVsSemana(withMissing, 1);
    expect(result.ok).toBe(false);
  });
});

describe("fillDerivedFields", () => {
  it("completa solo los campos vacíos y reporta los no calculables", async () => {
    const historyResponse = {
      results: [
        {
          id: "p1",
          properties: {
            Fecha: { date: { start: "2026-07-13" } },
            TRX: { number: 1000 },
            "Activos DAU": { number: 500 },
            "Afiliaciones diarias": { number: 20 },
          },
        },
        {
          id: "p2",
          properties: {
            Fecha: { date: { start: "2026-07-20" } },
            TRX: { number: 1100 },
            "Activos DAU": { number: 550 },
            "Afiliaciones diarias": { number: 22 },
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    };
    const patchedProps: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify(historyResponse), { status: 200 });
      }
      const body = init?.body ? JSON.parse(init.body as string) : {};
      patchedProps.push(body.properties);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await fillDerivedFields("tok", undefined, fetchFn);

    expect(
      report.completados.some((c) => c.campo === "TRX vs. Sem. anterior (%)" && c.fecha === "2026-07-20"),
    ).toBe(true);
    expect(report.noCalculables.some((c) => c.fecha === "2026-07-13")).toBe(true);
    expect(patchedProps.some((p) => "TRX vs. Sem. anterior (%)" in p)).toBe(true);
  });

  it("con onlyFechas, solo intenta/reporta sobre esas fechas — igual usa el histórico completo como contexto", async () => {
    const historyResponse = {
      results: [
        {
          id: "p1",
          properties: {
            Fecha: { date: { start: "2026-07-13" } },
            TRX: { number: 1000 },
            "Activos DAU": { number: 500 },
            "Afiliaciones diarias": { number: 20 },
          },
        },
        {
          id: "p2",
          properties: {
            Fecha: { date: { start: "2026-07-20" } },
            TRX: { number: 1100 },
            "Activos DAU": { number: 550 },
            "Afiliaciones diarias": { number: 22 },
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    };
    const patchedProps: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify(historyResponse), { status: 200 });
      }
      const body = init?.body ? JSON.parse(init.body as string) : {};
      patchedProps.push(body.properties);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    // Solo pedimos la fecha 2026-07-20 — 2026-07-13 también tiene un campo derivado faltante
    // (usa el mismo historial como contexto para el cálculo D-7), pero no debe ni intentarse
    // ni aparecer en el reporte porque no está en onlyFechas.
    const report = await fillDerivedFields("tok", ["2026-07-20"], fetchFn);

    expect(report.completados.every((c) => c.fecha === "2026-07-20")).toBe(true);
    expect(report.noCalculables.every((c) => c.fecha === "2026-07-20")).toBe(true);
    expect(report.completados.some((c) => c.fecha === "2026-07-13")).toBe(false);
    expect(report.noCalculables.some((c) => c.fecha === "2026-07-13")).toBe(false);
  });

  it("no pisa un campo derivado que ya tiene valor", async () => {
    const historyResponse = {
      results: [
        {
          id: "p1",
          properties: {
            Fecha: { date: { start: "2026-07-13" } },
            "Afiliaciones diarias": { number: 20 },
          },
        },
        {
          id: "p2",
          properties: {
            Fecha: { date: { start: "2026-07-20" } },
            "Afiliaciones diarias": { number: 22 },
            "Afiliaciones vs. Sem. anterior (%)": { number: 0.5 },
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    };
    const patchedProps: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify(historyResponse), { status: 200 });
      }
      const body = init?.body ? JSON.parse(init.body as string) : {};
      patchedProps.push(body.properties);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await fillDerivedFields("tok", undefined, fetchFn);

    expect(report.completados.some((c) => c.campo === "Afiliaciones vs. Sem. anterior (%)")).toBe(false);
    expect(patchedProps.some((p) => "Afiliaciones vs. Sem. anterior (%)" in p)).toBe(false);
  });

  it("si un PATCH falla, lo registra como no calculable y sigue con el resto sin abortar", async () => {
    const historyResponse = {
      results: [
        {
          id: "p1",
          properties: {
            Fecha: { date: { start: "2026-07-13" } },
            TRX: { number: 1000 },
            "Activos DAU": { number: 500 },
            "Afiliaciones diarias": { number: 20 },
          },
        },
        {
          id: "p2",
          properties: {
            Fecha: { date: { start: "2026-07-20" } },
            TRX: { number: 1100 },
            "Activos DAU": { number: 550 },
            "Afiliaciones diarias": { number: 22 },
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    };
    const patchedProps: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify(historyResponse), { status: 200 });
      }
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if ("TRX vs. Sem. anterior (%)" in body.properties) {
        throw new Error("PATCH simulado falló (network error)");
      }
      patchedProps.push(body.properties);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await fillDerivedFields("tok", undefined, fetchFn);

    // No aborta: la promesa resuelve con un reporte, no rechaza.
    const trxFailure = report.noCalculables.find(
      (c) => c.campo === "TRX vs. Sem. anterior (%)" && c.fecha === "2026-07-20",
    );
    expect(trxFailure).toBeDefined();
    expect(trxFailure?.motivo).toContain("error al escribir en Notion");
    expect(trxFailure?.motivo).toContain("PATCH simulado falló");

    // Otro campo independientemente calculable en la MISMA corrida sí se completa normalmente.
    expect(
      report.completados.some((c) => c.campo === "DAU vs. Sem. anterior (%)" && c.fecha === "2026-07-20"),
    ).toBe(true);
    expect(patchedProps.some((p) => "DAU vs. Sem. anterior (%)" in p)).toBe(true);
    expect(patchedProps.some((p) => "TRX vs. Sem. anterior (%)" in p)).toBe(false);
  });
});
