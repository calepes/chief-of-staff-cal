import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const mockSpawn = vi.mocked(childProcess.spawnSync);

import { callNtn } from "./books.js";

describe("callNtn", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls ntn api with path and returns parsed JSON", () => {
    mockSpawn.mockReturnValue({
      status: 0,
      stdout: '{"id":"abc123"}',
      stderr: "",
    } as ReturnType<typeof childProcess.spawnSync>);

    const result = callNtn("v1/users/me");

    expect(mockSpawn).toHaveBeenCalledWith(
      "/opt/homebrew/bin/ntn",
      ["api", "v1/users/me"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(result).toEqual({ ok: true, data: { id: "abc123" } });
  });

  it("adds -X PATCH and -d body for PATCH calls", () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: "{}", stderr: "" } as ReturnType<typeof childProcess.spawnSync>);

    callNtn("v1/pages/123", { method: "PATCH", body: { icon: "📖" } });

    expect(mockSpawn).toHaveBeenCalledWith(
      "/opt/homebrew/bin/ntn",
      ["api", "-X", "PATCH", "v1/pages/123", "-d", '{"icon":"📖"}'],
      expect.anything()
    );
  });

  it("returns ok: false on non-zero exit", () => {
    mockSpawn.mockReturnValue({ status: 1, stdout: "", stderr: "auth error" } as ReturnType<typeof childProcess.spawnSync>);
    const result = callNtn("v1/pages/bad");
    expect(result).toEqual({ ok: false, error: "auth error" });
  });
});

describe("searchCover", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  it("returns Open Library URL when ISBN cover exists (302)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 302, redirected: false });
    const { searchCover } = await import("./books.js");
    const url = await searchCover("9781578514373");
    expect(url).toBe("https://covers.openlibrary.org/b/isbn/9781578514373-L.jpg");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://covers.openlibrary.org/b/isbn/9781578514373-L.jpg",
      expect.objectContaining({ method: "HEAD" })
    );
  });

  it("falls back to Google Books when no ISBN", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ volumeInfo: { imageLinks: { thumbnail: "https://books.google.com/thumb.jpg" } } }],
      }),
    });
    const { searchCover } = await import("./books.js");
    const url = await searchCover(undefined, "Leadership on the Line", "Heifetz");
    expect(url).toBe("https://books.google.com/thumb.jpg");
  });

  it("returns null when no cover found", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));
    const { searchCover } = await import("./books.js");
    const url = await searchCover(undefined, "Unknown Book");
    expect(url).toBeNull();
  });
});
