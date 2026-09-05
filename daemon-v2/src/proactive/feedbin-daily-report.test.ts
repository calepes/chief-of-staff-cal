import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tools/feedbin-client.js", () => ({
  getAllUnreadEntries: vi.fn(),
  getSubscriptions: vi.fn(),
  getTaggings: vi.fn(),
  feedbinEntryUrl: (id: number) => `https://feedbin.com/entries/${id}`,
}));
vi.mock("./topics-profile-refresh.js", () => ({ TOPICS_PROFILE_PATH: "/tmp/does-not-exist-topics-profile.md" }));
vi.mock("./rich-send.js", () => ({ sendCronMessage: vi.fn(async () => ({ message_id: 1 })) }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ startup: vi.fn() }));

import { getAllUnreadEntries, getSubscriptions, getTaggings } from "../tools/feedbin-client.js";
import { sendCronMessage } from "./rich-send.js";
import { checkFeedbinDailyReport, parseClassifyResult } from "./feedbin-daily-report.js";

const mockUnread = vi.mocked(getAllUnreadEntries);
const mockSubs = vi.mocked(getSubscriptions);
const mockTaggings = vi.mocked(getTaggings);
const mockSend = vi.mocked(sendCronMessage);

const creds = { username: "u", password: "p" };

/** Fake mínimo de CfKv — checkFeedbinDailyReport solo lo usa para armar un FeedbinReportStore. */
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

function entry(id: number, title: string) {
  return { id, feed_id: 10, title, url: "u", author: null, summary: null, published: "2026-01-01" };
}

/** Encola una respuesta de Haiku (classify o group) para el próximo `handle.query(...)`. */
function queueHaikuResponse(sdk: { startup: ReturnType<typeof vi.fn> }, result: string): void {
  sdk.startup.mockResolvedValueOnce({
    query: async function* () {
      yield { type: "result", subtype: "success", result };
    },
    close: vi.fn(async () => {}),
  } as never);
}

describe("parseClassifyResult", () => {
  it("parses a well-formed JSON response", () => {
    const out = parseClassifyResult('{"recomendaciones":[{"id":1,"decision":"abrir"},{"id":2,"decision":"saltar"}]}');
    expect(out).toEqual([{ id: 1, decision: "abrir" }, { id: 2, decision: "saltar" }]);
  });

  it("tolerates a markdown fence around the JSON", () => {
    const out = parseClassifyResult('```json\n{"recomendaciones":[{"id":1,"decision":"abrir"}]}\n```');
    expect(out).toEqual([{ id: 1, decision: "abrir" }]);
  });

  it("returns [] on invalid JSON or missing recomendaciones", () => {
    expect(parseClassifyResult("not json")).toEqual([]);
    expect(parseClassifyResult('{"foo":"bar"}')).toEqual([]);
  });

  it("filters out entries with invalid id/decision shape", () => {
    const out = parseClassifyResult('{"recomendaciones":[{"id":"x","decision":"abrir"},{"id":1,"decision":"maybe"},{"id":2,"decision":"saltar"}]}');
    expect(out).toEqual([{ id: 2, decision: "saltar" }]);
  });
});

describe("checkFeedbinDailyReport", () => {
  let kv: FakeKv;

  beforeEach(() => {
    vi.clearAllMocks();
    kv = new FakeKv();
  });

  it("reports 'sin artículos' when there's nothing unread", async () => {
    mockUnread.mockResolvedValue([]);
    mockSubs.mockResolvedValue([]);
    mockTaggings.mockResolvedValue([]);

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds, kv: kv as never });

    expect(mockSend.mock.calls[0][1].text).toContain("Sin artículos sin leer");
  });

  it("groups unread counts by folder tag, falling back to feed title, and reports no profile", async () => {
    mockUnread.mockResolvedValue([
      entry(1, "A"),
      entry(2, "B"),
      { ...entry(3, "C"), feed_id: 20 },
    ]);
    mockSubs.mockResolvedValue([{ id: 1, feed_id: 20, title: "Feed sin carpeta" }]);
    mockTaggings.mockResolvedValue([{ feed_id: 10, name: "1. Siempre" }]);

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds, kv: kv as never });

    const text = mockSend.mock.calls[0][1].text;
    expect(text).toContain("3 sin leer");
    expect(text).toContain("1. Siempre: 2");
    expect(text).toContain("Feed sin carpeta: 1");
    expect(text).toContain("Sin perfil de temas todavía");
  });

  it("does not send anything if fetching from Feedbin fails", async () => {
    mockUnread.mockRejectedValue(new Error("boom"));

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds, kv: kv as never });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("classifies ALL unread entries in batches of 60, not just the most recent 60", async () => {
    const entries = Array.from({ length: 130 }, (_, i) => entry(i + 1, `Título ${i + 1}`));
    mockUnread.mockResolvedValue(entries);
    mockSubs.mockResolvedValue([]);
    mockTaggings.mockResolvedValue([]);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const { TOPICS_PROFILE_PATH } = await import("./topics-profile-refresh.js");
    // El mock de topics-profile-refresh.js ya define un path fijo; escribimos un perfil real ahí.
    mkdirSync(dirname(TOPICS_PROFILE_PATH), { recursive: true });
    writeFileSync(TOPICS_PROFILE_PATH, "perfil de prueba", "utf8");

    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    // 3 llamadas de classify (130 entries / 60 por lote = 3 lotes) — todas "abrir".
    for (let i = 0; i < 3; i++) {
      const start = i * 60;
      const end = Math.min(start + 60, 130);
      const ids = Array.from({ length: end - start }, (_, j) => start + j + 1);
      queueHaikuResponse(sdk as never, JSON.stringify({ recomendaciones: ids.map((id) => ({ id, decision: "abrir" })) }));
    }
    // 1 llamada de agrupado para "abrir" (todos los 130) — un solo grupo grande.
    queueHaikuResponse(sdk as never, JSON.stringify({ grupos: [{ tema: "Todo", ids: entries.map((e) => e.id) }] }));
    // 0 entries "saltar" → no debería llamar a agrupar para saltar.

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds, kv: kv as never });

    expect(vi.mocked(sdk.startup)).toHaveBeenCalledTimes(4); // 3 classify + 1 group (abrir)
    const text = mockSend.mock.calls[0][1].text;
    expect(text).toContain("Para abrir</b> (130)");
    expect(text).toContain("Todo</b> (130)");
    expect(text).toContain("...y 125 más"); // 130 - 5 mostrados
  });

  it("builds mark-as-read buttons from the grouped 'saltar' entries", async () => {
    const entries = [entry(1, "A"), entry(2, "B"), entry(3, "C")];
    mockUnread.mockResolvedValue(entries);
    mockSubs.mockResolvedValue([]);
    mockTaggings.mockResolvedValue([]);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const { TOPICS_PROFILE_PATH } = await import("./topics-profile-refresh.js");
    mkdirSync(dirname(TOPICS_PROFILE_PATH), { recursive: true });
    writeFileSync(TOPICS_PROFILE_PATH, "perfil de prueba", "utf8");

    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    queueHaikuResponse(sdk as never, JSON.stringify({ recomendaciones: [{ id: 1, decision: "abrir" }, { id: 2, decision: "saltar" }, { id: 3, decision: "saltar" }] })); // classify (1 lote)
    queueHaikuResponse(sdk as never, JSON.stringify({ grupos: [{ tema: "Interesante", ids: [1] }] })); // group abrir
    queueHaikuResponse(sdk as never, JSON.stringify({ grupos: [{ tema: "Ruido", ids: [2, 3] }] })); // group saltar

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds, kv: kv as never });

    const [, opts] = mockSend.mock.calls[0];
    expect(opts.text).toContain("Ruido (2)");
    expect(opts.replyMarkup).toBeDefined();
    const kb = opts.replyMarkup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    expect(kb.inline_keyboard[0]![0]!.text).toContain("Ruido");
    expect(kb.inline_keyboard[0]![0]!.callback_data).toMatch(/^fbr:mark:.+:g1$/);
  });

  it("falls back to a flat 'saltar' line without buttons if grouping saltar fails", async () => {
    const entries = [entry(1, "A"), entry(2, "B")];
    mockUnread.mockResolvedValue(entries);
    mockSubs.mockResolvedValue([]);
    mockTaggings.mockResolvedValue([]);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const { TOPICS_PROFILE_PATH } = await import("./topics-profile-refresh.js");
    mkdirSync(dirname(TOPICS_PROFILE_PATH), { recursive: true });
    writeFileSync(TOPICS_PROFILE_PATH, "perfil de prueba", "utf8");

    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    queueHaikuResponse(sdk as never, JSON.stringify({ recomendaciones: [{ id: 1, decision: "saltar" }, { id: 2, decision: "saltar" }] })); // classify
    // grouping para "abrir": no se llama porque abrirEntries está vacío.
    vi.mocked(sdk.startup).mockRejectedValueOnce(new Error("Haiku caído")); // group saltar falla

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds, kv: kv as never });

    const [, opts] = mockSend.mock.calls[0];
    expect(opts.text).toContain("no pude agrupar");
    expect(opts.replyMarkup).toBeUndefined();
  });
});
