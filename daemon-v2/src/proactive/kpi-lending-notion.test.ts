import { describe, it, expect, vi } from "vitest";
import {
  upsertLendingRow,
  markLendingReportFailed,
  clearLendingFailNote,
  computeIncrementoDesembolso,
  computeIncrementoDerivados,
  computeIncrementoVistos,
  computeIncrementoAgencia,
  computeIncrementoEnProcesoAgencia,
  fillLendingDerivedFields,
  type LendingHistoryRow,
} from "./kpi-lending-notion.js";

function row(overrides: Partial<LendingHistoryRow>): LendingHistoryRow {
  return {
    id: "id",
    fecha: "2026-07-26",
    desembolso: null,
    derivados: null,
    vistos: null,
    agencia: null,
    enProcesoAgencia: null,
    incrementoDesembolso: null,
    incrementoDerivados: null,
    incrementoVistos: null,
    incrementoAgencia: null,
    incrementoEnProcesoAgencia: null,
    ...overrides,
  };
}

describe("upsertLendingRow", () => {
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

    const result = await upsertLendingRow("tok", "2026-07-26", { Leads: 15720, Desembolso: 85 }, fetchFn);

    expect(result).toEqual({ fecha: "2026-07-26", created: true, fieldsWritten: ["Leads", "Desembolso"] });
    const createCall = calls.find((c) => c.url.endsWith("/v1/pages"));
    expect(createCall?.body.properties.Leads).toEqual({ number: 15720 });
    expect(createCall?.body.properties.Fecha).toEqual({ date: { start: "2026-07-26" } });
    expect(createCall?.body.properties.Registro).toEqual({ title: [{ text: { content: "2026-07-26" } }] });
  });

  it("actualiza una fila existente sin crear otra", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify({ results: [{ id: "existing-page", properties: {} }] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await upsertLendingRow("tok", "2026-07-26", { Desembolso: 85 }, fetchFn);
    expect(result).toEqual({ fecha: "2026-07-26", created: false, fieldsWritten: ["Desembolso"] });
  });
});

describe("markLendingReportFailed / clearLendingFailNote", () => {
  it("escribe la nota de fallo con el detalle sin tocar campos numéricos", async () => {
    const calls: any[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify({ results: [{ id: "p1", properties: {} }] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    await markLendingReportFailed("tok", "2026-07-27", "reconciliación rota: Vistos+NoVistos ≠ Leads", fetchFn);

    const patchCall = calls.find((c) => c.url.endsWith("/pages/p1"));
    expect(patchCall.body.properties.Notas.rich_text[0].text.content).toContain("reconciliación rota");
    expect(Object.keys(patchCall.body.properties)).toEqual(["Notas"]);
  });

  it("conserva notas manuales previas al agregar el fallo", async () => {
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(
          JSON.stringify({ results: [{ id: "p1", properties: { Notas: { rich_text: [{ plain_text: "nota manual de Cal" }] } } }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const calls: any[] = [];
    const wrapped = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
      return fetchFn(url as any, init);
    }) as unknown as typeof fetch;

    await markLendingReportFailed("tok", "2026-07-27", "fecha no encontrada", wrapped);
    const patchCall = calls.find((c) => c.url.endsWith("/pages/p1"));
    expect(patchCall.body.properties.Notas.rich_text[0].text.content).toContain("nota manual de Cal");
    expect(patchCall.body.properties.Notas.rich_text[0].text.content).toContain("fecha no encontrada");
  });

  it("clearLendingFailNote quita solo la línea de fallo, conserva el resto", async () => {
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(
          JSON.stringify({
            results: [
              { id: "p1", properties: { Notas: { rich_text: [{ plain_text: "nota manual\n⚠️ Reporte fallido — fecha no encontrada" }] } } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const calls: any[] = [];
    const wrapped = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
      return fetchFn(url as any, init);
    }) as unknown as typeof fetch;

    await clearLendingFailNote("tok", "2026-07-27", wrapped);
    const patchCall = calls.find((c) => c.url.endsWith("/pages/p1"));
    expect(patchCall.body.properties.Notas.rich_text[0].text.content).toBe("nota manual");
  });
});

describe("computeIncrementoDesembolso / computeIncrementoDerivados / computeIncrementoVistos / computeIncrementoAgencia / computeIncrementoEnProcesoAgencia", () => {
  it("no calculable sin registro D-1", () => {
    const rows = [row({ fecha: "2026-07-26", desembolso: 85, derivados: 435, vistos: 12129, agencia: 120, enProcesoAgencia: 40 })];
    expect(computeIncrementoDesembolso(rows, 0).ok).toBe(false);
    expect(computeIncrementoDerivados(rows, 0).ok).toBe(false);
    expect(computeIncrementoVistos(rows, 0).ok).toBe(false);
    expect(computeIncrementoAgencia(rows, 0).ok).toBe(false);
    expect(computeIncrementoEnProcesoAgencia(rows, 0).ok).toBe(false);
  });

  it("resta simple correcta cuando existe D-1 contiguo", () => {
    const rows = [
      row({ fecha: "2026-07-22", desembolso: 72, derivados: 348, vistos: 9522, agencia: 110, enProcesoAgencia: 38 }),
      row({ fecha: "2026-07-23", desembolso: 78, derivados: 384, vistos: 9522, agencia: 120, enProcesoAgencia: 42 }),
    ];
    const d = computeIncrementoDesembolso(rows, 1);
    const r = computeIncrementoDerivados(rows, 1);
    const v = computeIncrementoVistos(rows, 1);
    const a = computeIncrementoAgencia(rows, 1);
    const p = computeIncrementoEnProcesoAgencia(rows, 1);
    expect(d).toEqual({ ok: true, value: 6 });
    expect(r).toEqual({ ok: true, value: 36 });
    expect(v).toEqual({ ok: true, value: 0 });
    expect(a).toEqual({ ok: true, value: 10 });
    expect(p).toEqual({ ok: true, value: 4 });
  });

  it("no calculable si D-1 existe pero con hueco de fecha (no es realmente día anterior)", () => {
    // 07-24 no llegó reporte — 07-26 no tiene un D-1 real (07-25) en el histórico.
    const rows = [
      row({ fecha: "2026-07-23", desembolso: 78, derivados: 384, vistos: 9522, agencia: 120, enProcesoAgencia: 42 }),
      row({ fecha: "2026-07-26", desembolso: 85, derivados: 435, vistos: 12129, agencia: 130, enProcesoAgencia: 45 }),
    ];
    expect(computeIncrementoDesembolso(rows, 1).ok).toBe(false);
    expect(computeIncrementoVistos(rows, 1).ok).toBe(false);
    expect(computeIncrementoAgencia(rows, 1).ok).toBe(false);
    expect(computeIncrementoEnProcesoAgencia(rows, 1).ok).toBe(false);
  });
});

describe("fillLendingDerivedFields", () => {
  it("completa los derivados faltantes solo para las fechas objetivo", async () => {
    const queryResults = [
      {
        id: "p1",
        properties: {
          Fecha: { date: { start: "2026-07-22" } },
          Desembolso: { number: 72 },
          Derivados: { number: 348 },
          Agencia: { number: 110 },
          "En Proceso (Agencia)": { number: 38 },
        },
      },
      {
        id: "p2",
        properties: {
          Fecha: { date: { start: "2026-07-23" } },
          Desembolso: { number: 78 },
          Derivados: { number: 384 },
          Agencia: { number: 120 },
          "En Proceso (Agencia)": { number: 42 },
        },
      },
    ];
    const patches: any[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify({ results: queryResults, has_more: false, next_cursor: null }), { status: 200 });
      }
      patches.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await fillLendingDerivedFields("tok", ["2026-07-23"], fetchFn);

    expect(report.completados).toEqual(
      expect.arrayContaining([
        { fecha: "2026-07-23", campo: "Incremento Desembolso (D-1)", valor: 6 },
        { fecha: "2026-07-23", campo: "Incremento Derivados (D-1)", valor: 36 },
        { fecha: "2026-07-23", campo: "Incremento Agencia (D-1)", valor: 10 },
        { fecha: "2026-07-23", campo: "Incremento En Proceso (Agencia) (D-1)", valor: 4 },
      ]),
    );
    expect(patches.some((p) => p.url.endsWith("/pages/p1"))).toBe(false);
  });

  it("con onlyFechas, fuerza el recálculo aunque ya exista un valor (reporte reenviado con números corregidos)", async () => {
    // Caso real 2026-08-05: llegaron 2 mails de Lending para la misma fecha — el primero calculó
    // el incremento (mal, contra un crudo que el segundo mail corrigió después) y quedó pegado.
    const queryResults = [
      { id: "p1", properties: { Fecha: { date: { start: "2026-08-03" } }, Desembolso: { number: 133 } } },
      {
        id: "p2",
        properties: {
          Fecha: { date: { start: "2026-08-04" } },
          Desembolso: { number: 147 }, // corregido por el 2do mail
          "Incremento Desembolso (D-1)": { number: 0 }, // stale — quedó del 1er mail (desembolso viejo = 133)
        },
      },
    ];
    const patches: any[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify({ results: queryResults, has_more: false, next_cursor: null }), { status: 200 });
      }
      patches.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await fillLendingDerivedFields("tok", ["2026-08-04"], fetchFn);

    expect(report.completados).toEqual(
      expect.arrayContaining([{ fecha: "2026-08-04", campo: "Incremento Desembolso (D-1)", valor: 14 }]),
    );
    const patch = patches.find((p) => p.url.endsWith("/pages/p2") && "Incremento Desembolso (D-1)" in p.body.properties);
    expect(patch?.body.properties["Incremento Desembolso (D-1)"]).toEqual({ number: 14 });
  });

  it("SIN onlyFechas (modo reprocesar todo), no pisa un valor ya existente aunque el crudo haya cambiado", async () => {
    const queryResults = [
      { id: "p1", properties: { Fecha: { date: { start: "2026-08-03" } }, Desembolso: { number: 133 } } },
      {
        id: "p2",
        properties: {
          Fecha: { date: { start: "2026-08-04" } },
          Desembolso: { number: 147 },
          "Incremento Desembolso (D-1)": { number: 0 },
        },
      },
    ];
    const patches: any[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify({ results: queryResults, has_more: false, next_cursor: null }), { status: 200 });
      }
      patches.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await fillLendingDerivedFields("tok", undefined, fetchFn);

    expect(
      report.completados.some((c) => c.fecha === "2026-08-04" && c.campo === "Incremento Desembolso (D-1)"),
    ).toBe(false);
    expect(patches.some((p) => p.url.endsWith("/pages/p2"))).toBe(false);
  });
});
