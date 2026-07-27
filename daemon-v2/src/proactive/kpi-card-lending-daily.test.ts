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
    incrementoDesembolso: null,
    incrementoDerivados: null,
    incrementoVistos: null,
    ...overrides,
  };
}

const HISTORY: LendingHistoryRow[] = [
  row({ fecha: "2026-07-21", vistos: 8504, derivados: 318, desembolso: 68 }),
  row({ fecha: "2026-07-22", vistos: 9522, derivados: 348, desembolso: 72 }),
  row({ fecha: "2026-07-23", vistos: 9522, derivados: 384, desembolso: 78 }),
  // Hueco real: no hay reporte 24/25 jul.
  row({ fecha: "2026-07-26", vistos: 12129, derivados: 435, desembolso: 85 }),
];

describe("fetchLendingCardKpis", () => {
  it("usa la fila más reciente y compara contra D-1 cuando existe", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue(HISTORY.slice(0, 3)); // hasta 07-23, sin hueco

    const kpis = await fetchLendingCardKpis("fake-token");

    expect(kpis.fecha).toBe("2026-07-23");
    expect(kpis.vistosDelta).toBe(0); // 9522 - 9522
    expect(kpis.vistosCompareFecha).toBe("2026-07-22");
    expect(kpis.derivadosDelta).toBe(36); // 384 - 348
    expect(kpis.desembolsoDelta).toBe(6); // 78 - 72
  });

  it("con hueco de reporte, compara contra el último dato disponible (no D-1 estricto) y lo marca", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue(HISTORY); // incluye el hueco 24-25 jul

    const kpis = await fetchLendingCardKpis("fake-token");

    expect(kpis.fecha).toBe("2026-07-26");
    expect(kpis.derivadosDelta).toBe(51); // 435 - 384 (contra 07-23, no un D-1 inexistente)
    expect(kpis.derivadosCompareFecha).toBe("2026-07-23");
    expect(kpis.desembolsoDelta).toBe(7); // 85 - 78
    expect(kpis.desembolsoCompareFecha).toBe("2026-07-23");
  });

  it("primer registro del histórico: delta null porque no hay NINGÚN dato previo", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue([HISTORY[0]]);

    const kpis = await fetchLendingCardKpis("fake-token");

    expect(kpis.vistosDelta).toBeNull();
    expect(kpis.vistosCompareFecha).toBeNull();
  });

  it("lanza si no hay ninguna fila", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue([]);
    await expect(fetchLendingCardKpis("fake-token")).rejects.toThrow("0 resultados");
  });

  it("lanza si Vistos viene null en la fila objetivo", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue([row({ fecha: "2026-07-26", derivados: 435, desembolso: 85, vistos: null })]);
    await expect(fetchLendingCardKpis("fake-token")).rejects.toThrow("Vistos");
  });

  it("con fecha, busca esa fila puntual y compara igual contra su dato previo más reciente", async () => {
    vi.mocked(fetchLendingHistory).mockResolvedValue(HISTORY);

    const kpis = await fetchLendingCardKpis("fake-token", fetch, "2026-07-22");

    expect(kpis.fecha).toBe("2026-07-22");
    expect(kpis.vistosDelta).toBe(1018); // 9522 - 8504
    expect(kpis.vistosCompareFecha).toBe("2026-07-21");
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
