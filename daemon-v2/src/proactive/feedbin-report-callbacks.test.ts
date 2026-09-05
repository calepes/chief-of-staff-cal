import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isFeedbinReportCallback,
  parseFeedbinReportCallback,
  handleFeedbinReportCallback,
  type FeedbinReportCallbackDeps,
} from "./feedbin-report-callbacks.js";
import { FeedbinReportStore, type FeedbinReportProposal } from "./feedbin-report-store.js";
import type { FeedbinReportButton, Card } from "./feedbin-report-card.js";

/** CfKv falso en memoria, mismo patrón que learning-callbacks.test.ts. */
class FakeKv {
  store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const BTN: FeedbinReportButton = { id: "g1", label: "Rumores Apple", count: 2, entryIds: [10, 20], markedAt: 0 };

function proposal(overrides: Partial<FeedbinReportProposal> = {}): FeedbinReportProposal {
  return { headerText: "HEADER", buttons: [{ ...BTN }], ...overrides };
}

describe("isFeedbinReportCallback", () => {
  it("reconoce el prefijo fbr:", () => expect(isFeedbinReportCallback("fbr:mark:r1:g1")).toBe(true));
  it("rechaza otros prefijos", () => expect(isFeedbinReportCallback("lrn:all:b1")).toBe(false));
  it("rechaza undefined", () => expect(isFeedbinReportCallback(undefined)).toBe(false));
});

describe("parseFeedbinReportCallback", () => {
  it("parsea mark", () => {
    expect(parseFeedbinReportCallback("fbr:mark:r1:g1")).toEqual({ action: "mark", reportId: "r1", buttonId: "g1" });
  });
  it("parsea undo", () => {
    expect(parseFeedbinReportCallback("fbr:undo:r1:resto")).toEqual({ action: "undo", reportId: "r1", buttonId: "resto" });
  });
  it("rechaza una acción desconocida", () => {
    expect(parseFeedbinReportCallback("fbr:borrar:r1:g1")).toBeNull();
  });
  it("rechaza partes faltantes", () => {
    expect(parseFeedbinReportCallback("fbr:mark:r1")).toBeNull();
  });
});

describe("handleFeedbinReportCallback", () => {
  let kv: FakeKv;
  let store: FeedbinReportStore;
  let edits: Array<{ messageId: number; card: Card }>;
  let logs: Array<Record<string, unknown>>;
  let markEntriesRead: ReturnType<typeof vi.fn>;
  let markEntriesUnread: ReturnType<typeof vi.fn>;
  let deps: FeedbinReportCallbackDeps;

  beforeEach(() => {
    kv = new FakeKv();
    store = new FeedbinReportStore(kv as never);
    edits = [];
    logs = [];
    markEntriesRead = vi.fn(async () => {});
    markEntriesUnread = vi.fn(async () => {});
    deps = {
      store,
      feedbin: { username: "u", password: "p" },
      markEntriesRead,
      markEntriesUnread,
      log: (obj) => logs.push(obj),
      editCard: async (messageId, card) => {
        edits.push({ messageId, card });
      },
    };
  });

  it("fbr:mark llama a markEntriesRead con los entryIds del grupo y marca el botón", async () => {
    const reportId = await store.createReport(proposal());

    await handleFeedbinReportCallback(deps, 99, `fbr:mark:${reportId}:g1`);

    expect(markEntriesRead).toHaveBeenCalledWith({ username: "u", password: "p" }, [10, 20]);
    const saved = await store.getReport(reportId);
    expect(saved!.buttons[0]!.markedAt).toBeGreaterThan(0);
    expect(edits.at(-1)!.card.text).toContain("marcado (2)");
    expect(edits.at(-1)!.card.keyboard.inline_keyboard).toEqual([[{ text: "↩️ Deshacer", callback_data: `fbr:undo:${reportId}:g1` }]]);
  });

  it("fbr:mark no toca el KV si la API de Feedbin falla, y avisa en la tarjeta", async () => {
    markEntriesRead.mockRejectedValue(new Error("Feedbin API 500"));
    const reportId = await store.createReport(proposal());

    await handleFeedbinReportCallback(deps, 99, `fbr:mark:${reportId}:g1`);

    const saved = await store.getReport(reportId);
    expect(saved!.buttons[0]!.markedAt).toBe(0);
    expect(edits.at(-1)!.card.text).toContain("No pude marcar");
    expect(logs.some((l) => l.msg === "feedbin_report_mark_failed")).toBe(true);
  });

  it("fbr:undo dentro de la ventana de 10 min llama a markEntriesUnread y limpia el marcado", async () => {
    const btnMarked = { ...BTN, markedAt: Date.now() - 60_000 };
    const reportId = await store.createReport(proposal({ buttons: [btnMarked] }));

    await handleFeedbinReportCallback(deps, 99, `fbr:undo:${reportId}:g1`);

    expect(markEntriesUnread).toHaveBeenCalledWith({ username: "u", password: "p" }, [10, 20]);
    const saved = await store.getReport(reportId);
    expect(saved!.buttons[0]!.markedAt).toBe(0);
    expect(edits.at(-1)!.card.text).not.toContain("marcado");
  });

  it("fbr:undo fuera de la ventana no llama a la API y deja el grupo marcado", async () => {
    const btnExpired = { ...BTN, markedAt: Date.now() - 11 * 60_000 };
    const reportId = await store.createReport(proposal({ buttons: [btnExpired] }));

    await handleFeedbinReportCallback(deps, 99, `fbr:undo:${reportId}:g1`);

    expect(markEntriesUnread).not.toHaveBeenCalled();
    const saved = await store.getReport(reportId);
    expect(saved!.buttons[0]!.markedAt).toBeGreaterThan(0);
    expect(logs.some((l) => l.msg === "feedbin_report_undo_expired_or_missing")).toBe(true);
  });

  it("un reportId inexistente edita la tarjeta con el mensaje de expirado", async () => {
    await handleFeedbinReportCallback(deps, 99, "fbr:mark:no-existe:g1");

    expect(markEntriesRead).not.toHaveBeenCalled();
    expect(edits.at(-1)!.card.text).toContain("expiró");
    expect(edits.at(-1)!.card.keyboard.inline_keyboard).toEqual([]);
  });

  it("un buttonId inexistente dentro de un reporte real no hace nada", async () => {
    const reportId = await store.createReport(proposal());

    await handleFeedbinReportCallback(deps, 99, `fbr:mark:${reportId}:no-existe`);

    expect(markEntriesRead).not.toHaveBeenCalled();
    expect(edits).toHaveLength(0);
  });

  it("fbr:undo dentro de la ventana pero con la API fallando no toca el KV y deja el grupo marcado", async () => {
    markEntriesUnread.mockRejectedValue(new Error("Feedbin API 500"));
    const reportId = await store.createReport(proposal({ buttons: [{ ...BTN, markedAt: Date.now() - 60_000 }] }));

    await handleFeedbinReportCallback(deps, 99, `fbr:undo:${reportId}:g1`);

    const saved = await store.getReport(reportId);
    expect(saved!.buttons[0]!.markedAt).toBeGreaterThan(0); // sigue marcado, no se revirtió a 0
    expect(edits.at(-1)!.card.text).toContain("marcado"); // la tarjeta muestra el estado real
    expect(logs.some((l) => l.msg === "feedbin_report_undo_failed")).toBe(true);
  });
});
