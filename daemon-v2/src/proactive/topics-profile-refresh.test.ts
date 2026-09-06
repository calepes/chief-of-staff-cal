import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../tools/feedbin-client.js", () => ({
  getRecentReadEntries: vi.fn(),
  getStarredEntries: vi.fn(),
  feedbinEntryUrl: (id: number) => `https://feedbin.com/entries/${id}`,
}));
vi.mock("../tools/readwise.js", () => ({ readerListDocuments: vi.fn() }));
vi.mock("./rich-send.js", () => ({
  sendCronMessage: vi.fn(async () => ({ message_id: 1 })),
  stripHtmlTags: (html: string) => html.replace(/<[^>]+>/g, ""),
}));
vi.mock("@cos/shared", () => ({ sendMessage: vi.fn(async () => ({ message_id: 2 })) }));

const creds = { username: "u", password: "p" };
let tmpHome: string;

// topics-profile-refresh.ts resuelve TOPICS_PROFILE_PATH desde process.env.HOME al
// importarse — mismo patrón que session-store.test.ts / books.test.ts.
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "jano-topics-"));
  process.env.HOME = tmpHome;
  vi.resetModules();
});
afterEach(() => rmSync(tmpHome, { recursive: true, force: true }));

describe("buildTopicsProfilePrompt", () => {
  it("includes the three signal sources labeled by strength, each with its citation ID", async () => {
    const { buildTopicsProfilePrompt } = await import("./topics-profile-refresh.js");
    const prompt = buildTopicsProfilePrompt(
      [{ id: "L1", title: "read1", url: "https://r.example/1" }],
      [{ id: "S1", title: "star1", url: "https://s.example/1" }],
      [{ id: "R1", title: "short1", url: "https://sh.example/1" }],
    );
    expect(prompt).toContain("SHORTLIST");
    expect(prompt).toContain("[R1] short1");
    expect(prompt).toContain("STARRED");
    expect(prompt).toContain("[S1] star1");
    expect(prompt).toContain("LEÍDOS");
    expect(prompt).toContain("[L1] read1");
  });

  it("shows (vacío) for empty sources instead of an empty list", async () => {
    const { buildTopicsProfilePrompt } = await import("./topics-profile-refresh.js");
    const prompt = buildTopicsProfilePrompt([], [], []);
    expect(prompt).toContain("(vacío)");
  });
});

describe("refreshTopicsProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes the synthesized profile to disk and sends a summary", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      startup: vi.fn(async () => ({
        query: async function* () {
          yield { type: "result", subtype: "success", result: "- tema X: por qué" };
        },
        close: vi.fn(async () => {}),
      })),
    }));
    const { getRecentReadEntries, getStarredEntries } = await import("../tools/feedbin-client.js");
    const { readerListDocuments } = await import("../tools/readwise.js");
    vi.mocked(getRecentReadEntries).mockResolvedValue([{ id: 1, feed_id: 1, title: "Read title", url: "u", author: null, summary: null, published: "2026-01-01" }]);
    vi.mocked(getStarredEntries).mockResolvedValue([]);
    vi.mocked(readerListDocuments).mockReturnValue({ results: [{ title: "Short title", summary: "sum", url: "https://reader.example/short" }] });

    const { refreshTopicsProfile, TOPICS_PROFILE_PATH } = await import("./topics-profile-refresh.js");
    await refreshTopicsProfile({ botToken: "t", chatId: 1, feedbin: creds });

    const written = readFileSync(TOPICS_PROFILE_PATH, "utf8");
    expect(written).toBe("- tema X: por qué");

    const { sendCronMessage } = await import("./rich-send.js");
    expect(vi.mocked(sendCronMessage).mock.calls[0][1].text).toContain("Perfil de temas actualizado");
  });

  it("does not call the LLM or write anything when there's no signal at all", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ startup: vi.fn() }));
    const { getRecentReadEntries, getStarredEntries } = await import("../tools/feedbin-client.js");
    const { readerListDocuments } = await import("../tools/readwise.js");
    vi.mocked(getRecentReadEntries).mockResolvedValue([]);
    vi.mocked(getStarredEntries).mockResolvedValue([]);
    vi.mocked(readerListDocuments).mockReturnValue({ results: [] });

    const { refreshTopicsProfile } = await import("./topics-profile-refresh.js");
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    await refreshTopicsProfile({ botToken: "t", chatId: 1, feedbin: creds });

    expect(vi.mocked(sdk.startup)).not.toHaveBeenCalled();
  });

  it("escapes a literal & in a topic name before converting markdown to HTML", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      startup: vi.fn(async () => ({
        query: async function* () {
          yield { type: "result", subtype: "success", result: "- **IA & startups**: por qué" };
        },
        close: vi.fn(async () => {}),
      })),
    }));
    const { getRecentReadEntries, getStarredEntries } = await import("../tools/feedbin-client.js");
    const { readerListDocuments } = await import("../tools/readwise.js");
    vi.mocked(getRecentReadEntries).mockResolvedValue([]);
    vi.mocked(getStarredEntries).mockResolvedValue([{ id: 1, feed_id: 1, title: "s", url: "u", author: null, summary: null, published: "2026-01-01" }]);
    vi.mocked(readerListDocuments).mockReturnValue({ results: [] });

    const { refreshTopicsProfile } = await import("./topics-profile-refresh.js");
    await refreshTopicsProfile({ botToken: "t", chatId: 1, feedbin: creds });

    const { sendCronMessage } = await import("./rich-send.js");
    const text = vi.mocked(sendCronMessage).mock.calls[0][1].text;
    expect(text).toContain("&amp;");
    expect(text).not.toMatch(/[^&]& /); // sin un "&" crudo suelto (rompería el parseo de Telegram)
  });

  it("falls back to plain text via sendMessage when sendCronMessage fails", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      startup: vi.fn(async () => ({
        query: async function* () {
          yield { type: "result", subtype: "success", result: "- tema X: por qué" };
        },
        close: vi.fn(async () => {}),
      })),
    }));
    const { getRecentReadEntries, getStarredEntries } = await import("../tools/feedbin-client.js");
    const { readerListDocuments } = await import("../tools/readwise.js");
    vi.mocked(getRecentReadEntries).mockResolvedValue([{ id: 1, feed_id: 1, title: "r", url: "u", author: null, summary: null, published: "2026-01-01" }]);
    vi.mocked(getStarredEntries).mockResolvedValue([]);
    vi.mocked(readerListDocuments).mockReturnValue({ results: [] });

    const { sendCronMessage } = await import("./rich-send.js");
    vi.mocked(sendCronMessage).mockRejectedValueOnce(new Error("rich and classic HTML both rejected"));
    const { sendMessage } = await import("@cos/shared");

    const { refreshTopicsProfile } = await import("./topics-profile-refresh.js");
    await refreshTopicsProfile({ botToken: "t", chatId: 1, feedbin: creds });

    expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMessage).mock.calls[0][1].text).toContain("Perfil de temas actualizado");
  });

  it("replaces a valid citation ID with a real hyperlink and strips it from the disk copy", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      startup: vi.fn(async () => ({
        query: async function* () {
          yield { type: "result", subtype: "success", result: "- tema Y: por qué [L1]" };
        },
        close: vi.fn(async () => {}),
      })),
    }));
    const { getRecentReadEntries, getStarredEntries } = await import("../tools/feedbin-client.js");
    const { readerListDocuments } = await import("../tools/readwise.js");
    vi.mocked(getRecentReadEntries).mockResolvedValue([{ id: 1, feed_id: 1, title: "Read title", url: "https://feedbin.example/a", author: null, summary: null, published: "2026-01-01" }]);
    vi.mocked(getStarredEntries).mockResolvedValue([]);
    vi.mocked(readerListDocuments).mockReturnValue({ results: [] });

    const { refreshTopicsProfile, TOPICS_PROFILE_PATH } = await import("./topics-profile-refresh.js");
    await refreshTopicsProfile({ botToken: "t", chatId: 1, feedbin: creds });

    expect(readFileSync(TOPICS_PROFILE_PATH, "utf8")).toBe("- tema Y: por qué");

    const { sendCronMessage } = await import("./rich-send.js");
    const text = vi.mocked(sendCronMessage).mock.calls[0][1].text;
    expect(text).toContain('<a href="https://feedbin.com/entries/1">🔗</a>');
    expect(text).not.toContain("[L1]");
  });

  it("silently drops a hallucinated citation ID that doesn't match any known source", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      startup: vi.fn(async () => ({
        query: async function* () {
          yield { type: "result", subtype: "success", result: "- tema Z: por qué [X99]" };
        },
        close: vi.fn(async () => {}),
      })),
    }));
    const { getRecentReadEntries, getStarredEntries } = await import("../tools/feedbin-client.js");
    const { readerListDocuments } = await import("../tools/readwise.js");
    vi.mocked(getRecentReadEntries).mockResolvedValue([{ id: 1, feed_id: 1, title: "Read title", url: "https://feedbin.example/a", author: null, summary: null, published: "2026-01-01" }]);
    vi.mocked(getStarredEntries).mockResolvedValue([]);
    vi.mocked(readerListDocuments).mockReturnValue({ results: [] });

    const { refreshTopicsProfile } = await import("./topics-profile-refresh.js");
    await refreshTopicsProfile({ botToken: "t", chatId: 1, feedbin: creds });

    const { sendCronMessage } = await import("./rich-send.js");
    const text = vi.mocked(sendCronMessage).mock.calls[0][1].text;
    expect(text).not.toContain("[X99]");
    expect(text).not.toContain("<a href");
  });
});
