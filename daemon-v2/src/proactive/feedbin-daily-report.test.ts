import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tools/feedbin-client.js", () => ({
  getAllUnreadEntries: vi.fn(),
  getSubscriptions: vi.fn(),
  getTaggings: vi.fn(),
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
  beforeEach(() => vi.clearAllMocks());

  it("reports 'sin artículos' when there's nothing unread", async () => {
    mockUnread.mockResolvedValue([]);
    mockSubs.mockResolvedValue([]);
    mockTaggings.mockResolvedValue([]);

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds });

    expect(mockSend.mock.calls[0][1].text).toContain("Sin artículos sin leer");
  });

  it("groups unread counts by folder tag, falling back to feed title", async () => {
    mockUnread.mockResolvedValue([
      { id: 1, feed_id: 10, title: "A", url: "u", author: null, summary: null, published: "2026-08-20" },
      { id: 2, feed_id: 10, title: "B", url: "u", author: null, summary: null, published: "2026-08-21" },
      { id: 3, feed_id: 20, title: "C", url: "u", author: null, summary: null, published: "2026-08-19" },
    ]);
    mockSubs.mockResolvedValue([{ id: 1, feed_id: 20, title: "Feed sin carpeta" }]);
    mockTaggings.mockResolvedValue([{ feed_id: 10, name: "1. Siempre" }]);

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds });

    const text = mockSend.mock.calls[0][1].text;
    expect(text).toContain("3 sin leer");
    expect(text).toContain("1. Siempre: 2");
    expect(text).toContain("Feed sin carpeta: 1");
    expect(text).toContain("Sin perfil de temas todavía");
  });

  it("does not send anything if fetching from Feedbin fails", async () => {
    mockUnread.mockRejectedValue(new Error("boom"));

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds });

    expect(mockSend).not.toHaveBeenCalled();
  });
});
