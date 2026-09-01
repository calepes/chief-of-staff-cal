import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tools/research-competencia.js", () => ({
  runResearchCompetencia: vi.fn(),
  formatSummaryHtml: vi.fn(() => "resumen"),
}));
vi.mock("./rich-send.js", () => ({ sendCronMessage: vi.fn(async () => ({ message_id: 1 })) }));

import { runResearchCompetencia } from "../tools/research-competencia.js";
import { sendCronMessage } from "./rich-send.js";
import { checkResearchCompetenciaWeekly } from "./research-competencia-weekly.js";

const mockRun = vi.mocked(runResearchCompetencia);
const mockSend = vi.mocked(sendCronMessage);

describe("checkResearchCompetenciaWeekly", () => {
  beforeEach(() => vi.clearAllMocks());

  it("corre con timeframe de 7 días y manda el resumen por Telegram", async () => {
    mockRun.mockResolvedValue({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0 });

    await checkResearchCompetenciaWeekly({ botToken: "t", chatId: 1 });

    expect(mockRun).toHaveBeenCalledWith({ timeframeDias: 7 });
    expect(mockSend).toHaveBeenCalledWith("t", { chatId: 1, text: "resumen" });
  });

  it("no tira si runResearchCompetencia falla — solo loguea run_failed, no manda", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockRun.mockRejectedValue(new Error("boom"));

    await expect(checkResearchCompetenciaWeekly({ botToken: "t", chatId: 1 })).resolves.toBeUndefined();

    expect(mockSend).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some(([line]) => String(line).includes("research_competencia_weekly_run_failed"))).toBe(true);
    logSpy.mockRestore();
  });

  it("research corre OK pero sendCronMessage falla — loguea send_failed, no run_failed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockRun.mockResolvedValue({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 3 });
    mockSend.mockRejectedValue(new Error("telegram down"));

    await expect(checkResearchCompetenciaWeekly({ botToken: "t", chatId: 1 })).resolves.toBeUndefined();

    expect(mockRun).toHaveBeenCalledWith({ timeframeDias: 7 });
    const logged = logSpy.mock.calls.map(([line]) => String(line));
    expect(logged.some((l) => l.includes("research_competencia_weekly_send_failed"))).toBe(true);
    expect(logged.some((l) => l.includes("research_competencia_weekly_run_failed"))).toBe(false);
    logSpy.mockRestore();
  });
});
