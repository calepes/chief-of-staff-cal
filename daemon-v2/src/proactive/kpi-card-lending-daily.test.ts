import { describe, it, expect } from "vitest";
import { readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, afterEach } from "vitest";

vi.mock("./kpi-card-lending-image.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, renderKpiCardLendingImage: vi.fn(async () => Buffer.from("fake-png-bytes")) };
});
vi.mock("./kpi-lending-notion.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchLendingHistory: vi.fn() };
});
vi.mock("../tools/telegram-files.js", () => ({
  enviarFotoLocal: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@cos/shared", () => ({
  sendMessage: vi.fn(async () => ({})),
}));

import { renderKpiCardLendingImage } from "./kpi-card-lending-image.js";
import { fetchLendingHistory, type LendingHistoryRow } from "./kpi-lending-notion.js";
import { enviarFotoLocal } from "../tools/telegram-files.js";
import { sendMessage } from "@cos/shared";
import { fetchLendingCardKpis, checkKpiCardLending } from "./kpi-card-lending-daily.js";

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

// Los incrementos ya vienen PRECOMPUTADOS (D-1 estricto, calculados por fillLendingDerivedFields()
// — fetchLendingCardKpis ya no los recalcula, solo los expone).
const HISTORY: LendingHistoryRow[] = [
  row({ fecha: "2026-07-21", derivados: 318, agencia: 100, enProcesoAgencia: 30, desembolso: 68 }),
  row({
    fecha: "2026-07-22",
    derivados: 348,
    agencia: 110,
    enProcesoAgencia: 38,
    desembolso: 72,
    incrementoDerivados: 30,
    incrementoAgencia: 10,
    incrementoEnProcesoAgencia: 8,
    incrementoDesembolso: 4,
  }),
  row({
    fecha: "2026-07-23",
    derivados: 384,
    agencia: 120,
    enProcesoAgencia: 42,
    desembolso: 78,
    incrementoDerivados: 36,
    incrementoAgencia: 10,
    incrementoEnProcesoAgencia: 4,
    incrementoDesembolso: 6,
  }),
  // Hueco real: no hay reporte 24/25 jul — el 26 no tiene D-1 real, todos los incrementos vienen null.
  row({ fecha: "2026-07-26", derivados: 435, agencia: 130, enProcesoAgencia: 45, desembolso: 85 }),
];

describe("fetchLendingCardKpis", () => {
  it("usa la fila más reciente y expone los incrementos D-1 precomputados", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue(HISTORY.slice(0, 3)); // hasta 07-23

    const kpis = await fetchLendingCardKpis("fake-token");

    expect(kpis.fecha).toBe("2026-07-23");
    expect(kpis.derivadosDelta).toBe(36);
    expect(kpis.derivadosCompareFecha).toBe("2026-07-22");
    expect(kpis.agenciaDelta).toBe(10);
    expect(kpis.agenciaCompareFecha).toBe("2026-07-22");
    expect(kpis.enProcesoAgenciaDelta).toBe(4);
    expect(kpis.desembolsoDelta).toBe(6);
  });

  it("con hueco de reporte (sin D-1 real), todos los deltas vienen null", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue(HISTORY); // incluye el hueco 24-25 jul

    const kpis = await fetchLendingCardKpis("fake-token");

    expect(kpis.fecha).toBe("2026-07-26");
    expect(kpis.derivadosDelta).toBeNull();
    expect(kpis.derivadosCompareFecha).toBeNull();
    expect(kpis.agenciaDelta).toBeNull();
    expect(kpis.enProcesoAgenciaDelta).toBeNull();
    expect(kpis.desembolsoDelta).toBeNull();
    expect(kpis.desembolsoCompareFecha).toBeNull();
  });

  it("primer registro del histórico: delta null porque no hay incremento precomputado", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue([HISTORY[0]]);

    const kpis = await fetchLendingCardKpis("fake-token");

    expect(kpis.derivadosDelta).toBeNull();
    expect(kpis.derivadosCompareFecha).toBeNull();
  });

  it("lanza si no hay ninguna fila", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue([]);
    await expect(fetchLendingCardKpis("fake-token")).rejects.toThrow("0 resultados");
  });

  it("lanza si Derivados viene null en la fila objetivo", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue([row({ fecha: "2026-07-26", agencia: 130, enProcesoAgencia: 45, desembolso: 85, derivados: null })]);
    await expect(fetchLendingCardKpis("fake-token")).rejects.toThrow("Derivados");
  });

  it("lanza si Agencia viene null en la fila objetivo", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue([row({ fecha: "2026-07-26", derivados: 435, enProcesoAgencia: 45, desembolso: 85, agencia: null })]);
    await expect(fetchLendingCardKpis("fake-token")).rejects.toThrow("Agencia");
  });

  it("lanza si En Proceso (Agencia) viene null en la fila objetivo", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue([row({ fecha: "2026-07-26", derivados: 435, agencia: 130, desembolso: 85, enProcesoAgencia: null })]);
    await expect(fetchLendingCardKpis("fake-token")).rejects.toThrow("En Proceso (Agencia)");
  });

  it("lanza si Desembolso viene null en la fila objetivo", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue([row({ fecha: "2026-07-26", derivados: 435, agencia: 130, enProcesoAgencia: 45, desembolso: null })]);
    await expect(fetchLendingCardKpis("fake-token")).rejects.toThrow("Desembolso");
  });

  it("con fecha, busca esa fila puntual y expone su incremento D-1 precomputado", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue(HISTORY);

    const kpis = await fetchLendingCardKpis("fake-token", fetch, "2026-07-22");

    expect(kpis.fecha).toBe("2026-07-22");
    expect(kpis.derivadosDelta).toBe(30);
    expect(kpis.derivadosCompareFecha).toBe("2026-07-21");
  });

  it("con fecha que no existe en el histórico, lanza error explícito mencionando la fecha", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue(HISTORY);
    await expect(fetchLendingCardKpis("fake-token", fetch, "2026-07-18")).rejects.toThrow("2026-07-18");
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  const files = await readdir(tmpdir()).catch(() => [] as string[]);
  await Promise.all(
    files
      .filter((f) => f.startsWith("kpi-card-lending-") && f.endsWith(".png"))
      .map((f) => unlink(join(tmpdir(), f)).catch(() => {})),
  );
});

describe("checkKpiCardLending", () => {
  it("manda la tarjeta cuando todo sale bien", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue(HISTORY);

    await checkKpiCardLending({ botToken: "tok", chatId: 123, notionToken: "ntn" });

    expect(renderKpiCardLendingImage).toHaveBeenCalledTimes(1);
    expect(enviarFotoLocal).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("avisa por texto si falla la consulta a Notion", async () => {
    vi.mocked(fetchLendingHistory).mockRejectedValue(new Error("Notion query falló con status 500"));

    await checkKpiCardLending({ botToken: "tok", chatId: 123, notionToken: "ntn" });

    expect(renderKpiCardLendingImage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("avisa por texto si falla el render de la imagen", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue(HISTORY);
    vi.mocked(renderKpiCardLendingImage).mockRejectedValueOnce(new Error("logo no encontrado"));

    await checkKpiCardLending({ botToken: "tok", chatId: 123, notionToken: "ntn" });

    expect(enviarFotoLocal).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("avisa por texto si Telegram rechaza el envío", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue(HISTORY);
    vi.mocked(enviarFotoLocal).mockResolvedValueOnce({ ok: false, error: "chat not found" });

    await checkKpiCardLending({ botToken: "tok", chatId: 123, notionToken: "ntn" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("con fecha sin datos, avisa por texto mencionando la fecha", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue(HISTORY);

    await checkKpiCardLending({ botToken: "tok", chatId: 123, notionToken: "ntn", fecha: "2026-07-18" });

    expect(renderKpiCardLendingImage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendMessage).mock.calls[0]?.[1] as { text: string };
    expect(call.text).toContain("2026-07-18");
  });
});
