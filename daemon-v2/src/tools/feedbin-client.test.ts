import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getSubscriptions,
  getTaggings,
  getAllUnreadEntries,
  getRecentReadEntries,
  getReadEntriesByFeed,
  getReadEntriesByTag,
  getStarredEntries,
  markEntriesRead,
  markEntriesUnread,
} from "./feedbin-client.js";

const creds = { username: "u", password: "p" };

describe("feedbin-client", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("getSubscriptions sends Basic Auth and returns the list", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 1, feed_id: 10, title: "Feed A" }] });
    vi.stubGlobal("fetch", fetchMock);

    const subs = await getSubscriptions(creds);

    expect(subs).toEqual([{ id: 1, feed_id: 10, title: "Feed A" }]);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.feedbin.com/v2/subscriptions.json");
    expect((opts.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it("getTaggings returns feed_id -> tag name mapping", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [{ feed_id: 10, name: "1. Siempre" }] }));
    expect(await getTaggings(creds)).toEqual([{ feed_id: 10, name: "1. Siempre" }]);
  });

  it("getAllUnreadEntries paginates until an empty page", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: i, feed_id: 1, title: `t${i}`, url: "u", author: null, summary: null, published: "2026-01-01" }));
    const page2 = [{ id: 9999, feed_id: 1, title: "last", url: "u", author: null, summary: null, published: "2026-01-01" }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, json: async () => page2 })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);

    const all = await getAllUnreadEntries(creds);

    expect(all).toHaveLength(1001);
    expect(fetchMock).toHaveBeenCalledTimes(2); // corta apenas una página trae <1000 (sin pedir la 3ra)
  });

  it("getRecentReadEntries reads IDs from recently_read_entries and resolves them via entries?ids=, preserving order", async () => {
    const ids = [3, 1, 2];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ids })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 1, feed_id: 1, title: "uno", url: "u", author: null, summary: null, published: "2026-01-01" },
          { id: 2, feed_id: 1, title: "dos", url: "u", author: null, summary: null, published: "2026-01-01" },
          { id: 3, feed_id: 1, title: "tres", url: "u", author: null, summary: null, published: "2026-01-01" },
        ],
      });
    vi.stubGlobal("fetch", fetchMock);

    const recent = await getRecentReadEntries(creds, 150);

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.feedbin.com/v2/recently_read_entries.json");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.feedbin.com/v2/entries.json?ids=3,1,2&per_page=100");
    expect(recent.map((e) => e.title)).toEqual(["tres", "uno", "dos"]);
  });

  it("getRecentReadEntries caps at maxEntries before resolving", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ids })
      .mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);

    await getRecentReadEntries(creds, 50);

    expect(fetchMock.mock.calls[1][0]).toBe(`https://api.feedbin.com/v2/entries.json?ids=${Array.from({ length: 50 }, (_, i) => i).join(",")}&per_page=100`);
  });

  it("getRecentReadEntries returns [] without a second call when there are no recent reads", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);

    const recent = await getRecentReadEntries(creds);

    expect(recent).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getReadEntriesByFeed builds the read=true query with feed_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);

    await getReadEntriesByFeed(creds, 42, 10, 2);

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.feedbin.com/v2/entries.json?read=true&feed_id=42&per_page=10&page=2");
  });

  it("getReadEntriesByTag resolves feed_ids from taggings and merges results sorted by date", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [{ feed_id: 1, name: "1. Siempre" }, { feed_id: 2, name: "4. Opcional" }] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 1, feed_id: 1, title: "old", url: "u", author: null, summary: null, published: "2026-01-01" }] });
    vi.stubGlobal("fetch", fetchMock);

    const results = await getReadEntriesByTag(creds, "siempre");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("old");
  });

  it("getStarredEntries fetches ids then batches entries and respects limit", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [1, 2] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 1, feed_id: 1, title: "A", url: "u", author: null, summary: null, published: "2026-01-01" },
          { id: 2, feed_id: 1, title: "B", url: "u", author: null, summary: null, published: "2026-02-01" },
        ],
      });
    vi.stubGlobal("fetch", fetchMock);

    const starred = await getStarredEntries(creds, 1);

    expect(starred).toHaveLength(1);
    expect(starred[0].title).toBe("B"); // más reciente primero
  });

  it("throws with a descriptive message on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" }));
    await expect(getSubscriptions(creds)).rejects.toThrow(/Feedbin API 401/);
  });

  it("markEntriesRead sends a single DELETE with all ids when under 1000", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "[1,2,3]" });
    vi.stubGlobal("fetch", fetchMock);

    await markEntriesRead(creds, [1, 2, 3]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.feedbin.com/v2/unread_entries.json");
    expect(opts.method).toBe("DELETE");
    expect(JSON.parse(opts.body as string)).toEqual({ unread_entries: [1, 2, 3] });
  });

  it("markEntriesRead chunks into batches of 1000", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "[]" });
    vi.stubGlobal("fetch", fetchMock);
    const ids = Array.from({ length: 1500 }, (_, i) => i);

    await markEntriesRead(creds, ids);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).unread_entries).toHaveLength(1000);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).unread_entries).toHaveLength(500);
  });

  it("markEntriesRead does nothing with an empty list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await markEntriesRead(creds, []);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("markEntriesUnread sends a POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "[1]" });
    vi.stubGlobal("fetch", fetchMock);

    await markEntriesUnread(creds, [1]);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.feedbin.com/v2/unread_entries.json");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({ unread_entries: [1] });
  });

  it("markEntriesRead throws with the response body on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => "bad ids" }));

    await expect(markEntriesRead(creds, [1])).rejects.toThrow(/422/);
  });
});
