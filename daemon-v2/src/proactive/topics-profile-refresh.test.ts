import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../tools/feedbin-client.js", () => ({
  getRecentReadEntries: vi.fn(),
  getStarredEntries: vi.fn(),
}));
vi.mock("../tools/readwise.js", () => ({ readerListDocuments: vi.fn() }));
vi.mock("./rich-send.js", () => ({ sendCronMessage: vi.fn(async () => ({ message_id: 1 })) }));

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
  it("includes the three signal sources labeled by strength", async () => {
    const { buildTopicsProfilePrompt } = await import("./topics-profile-refresh.js");
    const prompt = buildTopicsProfilePrompt(["read1"], ["star1"], ["short1"]);
    expect(prompt).toContain("SHORTLIST");
    expect(prompt).toContain("short1");
    expect(prompt).toContain("STARRED");
    expect(prompt).toContain("star1");
    expect(prompt).toContain("LEÍDOS");
    expect(prompt).toContain("read1");
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
    vi.mocked(readerListDocuments).mockReturnValue({ results: [{ title: "Short title", summary: "sum" }] });

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
});
