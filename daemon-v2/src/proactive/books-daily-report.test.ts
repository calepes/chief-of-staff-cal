import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../shared/ntn.js", () => ({ callNtn: vi.fn() }));
vi.mock("./rich-send.js", () => ({ sendCronMessage: vi.fn(async () => ({ message_id: 1 })) }));

import { callNtn } from "../shared/ntn.js";
import { sendCronMessage } from "./rich-send.js";
import { checkBooksDailyReport } from "./books-daily-report.js";

const mockCallNtn = vi.mocked(callNtn);
const mockSend = vi.mocked(sendCronMessage);

function bookPage(estado: string) {
  return { properties: { Estado: { status: { name: estado } } } };
}

function sessionPage(titulo: string, paginas: number) {
  return {
    properties: {
      "Book Name": { rollup: { array: [{ title: [{ plain_text: titulo }] }] } },
      "Avance (pag)": { formula: { number: paginas } },
    },
  };
}

describe("checkBooksDailyReport", () => {
  beforeEach(() => vi.clearAllMocks());

  it("agrupa la meta 2026 por estado y suma páginas por libro de ayer", async () => {
    mockCallNtn
      .mockReturnValueOnce({ ok: true, data: { results: [bookPage("Reading"), bookPage("Reading"), bookPage("Not started")] } })
      .mockReturnValueOnce({ ok: true, data: { results: [sessionPage("Playing to Win", 5), sessionPage("Playing to Win", 3), sessionPage("Courage Is Calling", 8)] } });

    await checkBooksDailyReport({ botToken: "t", chatId: 1 });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const text = mockSend.mock.calls[0][1].text;
    expect(text).toContain("3 libros en la meta");
    expect(text).toContain("Reading: 2");
    expect(text).toContain("Not started: 1");
    expect(text).toContain("16 páginas en total");
    expect(text).toContain("Playing to Win");
    expect(text).toContain("8 págs"); // Courage Is Calling
  });

  it("muestra un mensaje corto cuando no hubo sesiones ayer, sin fallar", async () => {
    mockCallNtn
      .mockReturnValueOnce({ ok: true, data: { results: [bookPage("Goal")] } })
      .mockReturnValueOnce({ ok: true, data: { results: [] } });

    await checkBooksDailyReport({ botToken: "t", chatId: 1 });

    const text = mockSend.mock.calls[0][1].text;
    expect(text).toContain("Sin sesiones de lectura registradas ayer");
  });

  it("no manda nada si falla el query de la meta 2026", async () => {
    mockCallNtn.mockReturnValueOnce({ ok: false, error: "boom" });

    await checkBooksDailyReport({ botToken: "t", chatId: 1 });

    expect(mockSend).not.toHaveBeenCalled();
  });
});
