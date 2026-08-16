import { describe, expect, it, vi } from "vitest";
import {
  applyLendingDateInput,
  handleLendingDateCallback,
  isLendingDateCallback,
  previousBusinessDay,
  renderProposeCard,
  type Card,
  type LendingDateCallbackDeps,
  type LendingDateInputDeps,
  type LendingDateProposal,
  type LendingPendingInput,
} from "./lending-date-confirm.js";

const HOY = "2026-08-11"; // martes

/** Store en memoria con la misma superficie que LendingDateStore — mismo patrón que
 * task-callbacks.test.ts (fakeStore). */
function fakeStore(initial?: LendingDateProposal) {
  const proposals = new Map<string, LendingDateProposal>();
  let input: LendingPendingInput | null = null;
  if (initial) proposals.set("s1", initial);
  return {
    proposals,
    getInput: () => input,
    store: {
      async getProposal(_chat: number, id: string) {
        return proposals.get(id) ?? null;
      },
      async clearProposal(_chat: number, id: string) {
        proposals.delete(id);
      },
      async createProposal(_chat: number, payload: LendingDateProposal) {
        proposals.set("s1", payload);
        return "s1";
      },
      async setPendingInput(_chat: number, v: LendingPendingInput) {
        input = v;
      },
      async getPendingInput() {
        return input;
      },
      async clearPendingInput() {
        input = null;
      },
    } as any,
  };
}

function baseProposal(over: Partial<LendingDateProposal> = {}): LendingDateProposal {
  return { messageId: "m1", suggestedFecha: "2026-08-07", subject: "Reporte diario Créditos Yape Lending - Riesgos", ...over };
}

describe("previousBusinessDay", () => {
  it("un lunes → el viernes anterior (salta el fin de semana)", () => {
    expect(previousBusinessDay("2026-08-10")).toBe("2026-08-07"); // lunes → viernes
  });
  it("un martes → el lunes anterior", () => {
    expect(previousBusinessDay("2026-08-11")).toBe("2026-08-10");
  });
  it("un domingo → el viernes anterior", () => {
    expect(previousBusinessDay("2026-08-09")).toBe("2026-08-07");
  });
});

describe("isLendingDateCallback", () => {
  it("reconoce el prefijo lend:", () => {
    expect(isLendingDateCallback("lend:ok:abc")).toBe(true);
    expect(isLendingDateCallback("tsk:ok:abc")).toBe(false);
    expect(isLendingDateCallback(undefined)).toBe(false);
  });
});

describe("renderProposeCard", () => {
  it("arma 3 botones: confirmar, escribir otra, ignorar", () => {
    const card = renderProposeCard("s1", "2026-08-07", "Asunto de prueba");
    expect(card.text).toContain("2026-08-07");
    expect(card.text).toContain("Asunto de prueba");
    const buttons = card.keyboard.inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data)).toEqual(["lend:ok:s1", "lend:wr:s1", "lend:no:s1"]);
  });
});

describe("handleLendingDateCallback", () => {
  function deps(fake: ReturnType<typeof fakeStore>, ingest = vi.fn(async () => {})): { deps: LendingDateCallbackDeps; editCard: ReturnType<typeof vi.fn> } {
    const editCard = vi.fn(async () => {});
    return { deps: { store: fake.store, ingest, editCard, log: vi.fn() }, editCard };
  }

  it("propuesta vencida (ya no está en el store) → tarjeta de expirado", async () => {
    const fake = fakeStore();
    const { deps: d, editCard } = deps(fake);
    await handleLendingDateCallback(d, 1, 99, "lend:ok:s1");
    expect(editCard).toHaveBeenCalledWith(99, expect.objectContaining({ text: expect.stringContaining("venció") }));
  });

  it("ok: ingiere con la fecha sugerida, limpia la propuesta y muestra éxito", async () => {
    const fake = fakeStore(baseProposal());
    const ingest = vi.fn(async () => {});
    const { deps: d, editCard } = deps(fake, ingest);
    await handleLendingDateCallback(d, 1, 10, "lend:ok:s1");
    expect(ingest).toHaveBeenCalledWith("m1", "2026-08-07");
    expect(fake.proposals.has("s1")).toBe(false);
    const last = editCard.mock.calls.at(-1)![1];
    expect(last.text).toContain("✅");
  });

  it("ok: si ingest tira, muestra el fallo y NO borra la propuesta", async () => {
    const fake = fakeStore(baseProposal());
    const ingest = vi.fn(async () => {
      throw new Error("gmail caído");
    });
    const { deps: d, editCard } = deps(fake, ingest);
    await handleLendingDateCallback(d, 1, 10, "lend:ok:s1");
    expect(fake.proposals.has("s1")).toBe(true);
    const last = editCard.mock.calls.at(-1)![1];
    expect(last.text).toContain("❌");
    expect(last.text).toContain("gmail caído");
  });

  it("wr: guarda pendingInput con el anchorMessageId y muestra la tarjeta de pedir fecha", async () => {
    const fake = fakeStore(baseProposal());
    const { deps: d, editCard } = deps(fake);
    await handleLendingDateCallback(d, 1, 10, "lend:wr:s1");
    expect(fake.getInput()).toEqual({ shortId: "s1", anchorMessageId: 10 });
    const last = editCard.mock.calls.at(-1)![1];
    expect(last.text).toContain("Escribime la fecha");
  });

  it("back: vuelve a la tarjeta original y limpia pendingInput", async () => {
    const fake = fakeStore(baseProposal());
    await fake.store.setPendingInput(1, { shortId: "s1", anchorMessageId: 10 });
    const { deps: d, editCard } = deps(fake);
    await handleLendingDateCallback(d, 1, 10, "lend:back:s1");
    expect(fake.getInput()).toBeNull();
    const last = editCard.mock.calls.at(-1)![1];
    expect(last.text).toContain("2026-08-07");
  });

  it("no: borra la propuesta y muestra el mensaje de ignorado", async () => {
    const fake = fakeStore(baseProposal());
    const { deps: d, editCard } = deps(fake);
    await handleLendingDateCallback(d, 1, 10, "lend:no:s1");
    expect(fake.proposals.has("s1")).toBe(false);
    const last = editCard.mock.calls.at(-1)![1];
    expect(last.text).toContain("🚫");
  });
});

describe("applyLendingDateInput", () => {
  function deps(fake: ReturnType<typeof fakeStore>, ingest = vi.fn(async (_id: string, _fecha: string) => {})) {
    const clearKeyboard = vi.fn(async (_messageId: number) => {});
    const sendCard = vi.fn(async (_card: Card) => {});
    const d: LendingDateInputDeps = { store: fake.store, ingest, today: () => HOY, log: vi.fn(), clearKeyboard, sendCard };
    return { d, clearKeyboard, sendCard };
  }

  it("sin pendingInput → no consume el mensaje", async () => {
    const fake = fakeStore();
    const { d } = deps(fake);
    const consumed = await applyLendingDateInput(d, 1, "2026-08-06", null);
    expect(consumed).toBe(false);
  });

  it("texto que no parsea como fecha → no consume, deja el pendingInput intacto", async () => {
    const fake = fakeStore(baseProposal());
    await fake.store.setPendingInput(1, { shortId: "s1", anchorMessageId: 10 });
    const { d, sendCard } = deps(fake);
    const consumed = await applyLendingDateInput(d, 1, "cómo estás Jano", { shortId: "s1", anchorMessageId: 10 });
    expect(consumed).toBe(false);
    expect(sendCard).not.toHaveBeenCalled();
    expect(fake.getInput()).not.toBeNull(); // sigue esperando — no se pierde el estado
  });

  it("fecha ISO válida → ingiere, limpia estado y manda tarjeta de éxito NUEVA (no edita la vieja)", async () => {
    const fake = fakeStore(baseProposal());
    await fake.store.setPendingInput(1, { shortId: "s1", anchorMessageId: 10 });
    const ingest = vi.fn(async () => {});
    const { d, clearKeyboard, sendCard } = deps(fake, ingest);
    const consumed = await applyLendingDateInput(d, 1, "2026-08-06", { shortId: "s1", anchorMessageId: 10 });
    expect(consumed).toBe(true);
    expect(ingest).toHaveBeenCalledWith("m1", "2026-08-06");
    expect(clearKeyboard).toHaveBeenCalledWith(10);
    expect(fake.getInput()).toBeNull();
    expect(fake.proposals.has("s1")).toBe(false);
    const cards = sendCard.mock.calls.map((c) => c[0].text);
    expect(cards.some((t) => t.includes("✅"))).toBe(true);
  });

  it('"cancelar" cierra la espera sin aplicar nada y vuelve a mostrar la propuesta original', async () => {
    const fake = fakeStore(baseProposal());
    await fake.store.setPendingInput(1, { shortId: "s1", anchorMessageId: 10 });
    const ingest = vi.fn(async () => {});
    const { d, sendCard } = deps(fake, ingest);
    const consumed = await applyLendingDateInput(d, 1, "cancelar", { shortId: "s1", anchorMessageId: 10 });
    expect(consumed).toBe(true);
    expect(ingest).not.toHaveBeenCalled();
    expect(fake.proposals.has("s1")).toBe(true); // la propuesta sigue viva
    expect(fake.getInput()).toBeNull();
    const last = sendCard.mock.calls.at(-1)![0];
    expect(last.text).toContain("2026-08-07");
  });
});
