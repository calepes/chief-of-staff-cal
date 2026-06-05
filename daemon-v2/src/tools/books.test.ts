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

describe("searchBooks (formatting)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("formats a list of books as HTML", async () => {
    mockSpawn.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        results: [{
          id: "abc", url: "https://notion.so/abc",
          properties: {
            Name: { title: [{ plain_text: "Leadership on the Line" }] },
            Estado: { select: { name: "Reading" } },
            "Avance Tracking": { number: 0.1 },
            Rating: { select: null },
            "Start Date": { date: null },
            ISBN: { rich_text: [] },
          },
        }],
      }),
      stderr: "",
    } as ReturnType<typeof childProcess.spawnSync>);

    const { searchBooks } = await import("./books.js");
    const result = await searchBooks();
    expect(result).toContain("Leadership on the Line");
    expect(result).toContain("10%");
    expect(result).toContain("📖");
  });

  it("filters by query text", async () => {
    mockSpawn.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        results: [
          { id: "a", url: "u1", properties: { Name: { title: [{ plain_text: "Book A" }] }, Estado: { select: { name: "Read" } }, "Avance Tracking": { number: null }, Rating: { select: null }, "Start Date": { date: null }, ISBN: { rich_text: [] } } },
          { id: "b", url: "u2", properties: { Name: { title: [{ plain_text: "Book B" }] }, Estado: { select: { name: "Reading" } }, "Avance Tracking": { number: null }, Rating: { select: null }, "Start Date": { date: null }, ISBN: { rich_text: [] } } },
        ],
      }),
      stderr: "",
    } as ReturnType<typeof childProcess.spawnSync>);

    const { searchBooks } = await import("./books.js");
    const result = await searchBooks("Book A");
    expect(result).toContain("Book A");
    expect(result).not.toContain("Book B");
  });

  it("returns no-results message when empty", async () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '{"results":[]}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);
    const { searchBooks } = await import("./books.js");
    const result = await searchBooks("xyz");
    expect(result).toContain("No se encontraron");
  });
});

describe("addBook", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("calls ntn to create page and returns success message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 302, redirected: false }));
    mockSpawn.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ id: "new-id", url: "https://notion.so/new" }),
      stderr: "",
    } as ReturnType<typeof childProcess.spawnSync>);

    const { addBook } = await import("./books.js");
    const result = await addBook({
      name: "Leadership on the Line",
      isbn: "9781578514373",
      estado: "Reading",
      totalPaginas: 252,
      planningToRead: "2026",
    });

    expect(result).toContain("Leadership on the Line");
    expect(result).toContain("Reading");
    expect(result).toContain("252");
    expect(result).toContain("Ver en Notion");

    const ntnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(ntnArgs).toContain("v1/pages");
    const bodyArg = ntnArgs[ntnArgs.indexOf("-d") + 1];
    const body = JSON.parse(bodyArg);
    expect(body.parent.database_id).toBe("b9222a76e9404e229091b1c0e26c29dd");
    expect(body.properties.Name.title[0].text.content).toBe("Leadership on the Line");
    expect(body.properties.Estado.select.name).toBe("Reading");
  });
});

describe("updateBook", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("sends PATCH with updated properties", async () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '{"id":"abc"}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);

    const { updateBook } = await import("./books.js");
    const result = await updateBook({ pageId: "abc-123", estado: "Read", rating: "😍", finishDate: "2026-06-04" });

    expect(result).toContain("actualizado");
    const ntnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(ntnArgs).toContain("-X");
    expect(ntnArgs).toContain("PATCH");
    expect(ntnArgs).toContain("v1/pages/abc-123");
    const body = JSON.parse(ntnArgs[ntnArgs.indexOf("-d") + 1]);
    expect(body.properties["Estado"].select.name).toBe("Read");
    expect(body.properties["Rating"].select.name).toBe("😍");
  });

  it("returns warning when no fields provided", async () => {
    const { updateBook } = await import("./books.js");
    const result = await updateBook({ pageId: "abc" });
    expect(result).toContain("No se especificaron campos");
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe("logReadingProgress", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("creates tracking entry with correct body", async () => {
    mockSpawn.mockReturnValue({
      status: 0,
      stdout: '{"id":"track-1","url":"https://notion.so/track-1"}',
      stderr: "",
    } as ReturnType<typeof childProcess.spawnSync>);

    const { logReadingProgress } = await import("./books.js");
    const result = await logReadingProgress({
      pageId: "book-id",
      porcentajeInicial: 0.1,
      porcentajeFinal: 0.25,
      fecha: "2026-06-04",
    });

    expect(result).toContain("10% → 25%");
    expect(result).toContain("+15%");

    const ntnArgs = mockSpawn.mock.calls[0][1] as string[];
    const body = JSON.parse(ntnArgs[ntnArgs.indexOf("-d") + 1]);
    expect(body.parent.database_id).toBe("70b1e190-8547-4813-b918-43ce59071d3e");
    expect(body.properties.Book.relation[0].id).toBe("book-id");
    expect(body.properties["% Inicial"].number).toBe(0.1);
    expect(body.properties["% Final"].number).toBe(0.25);
  });
});

describe("setBookCover", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 302, redirected: false }));
  });

  it("patches page with cover and icon using same URL", async () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '{"id":"abc"}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);

    const { setBookCover } = await import("./books.js");
    const result = await setBookCover({ pageId: "abc", isbn: "9781578514373" });

    expect(result).toContain("Cover actualizado");
    expect(result).toContain("Open Library");

    const ntnArgs = mockSpawn.mock.calls[0][1] as string[];
    const body = JSON.parse(ntnArgs[ntnArgs.indexOf("-d") + 1]);
    expect(body.cover.external.url).toBe(body.icon.external.url);
    expect(body.cover.type).toBe("external");
    expect(body.icon.type).toBe("external");
  });

  it("returns error when no cover found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("not found")));
    const { setBookCover } = await import("./books.js");
    const result = await setBookCover({ pageId: "abc" });
    expect(result).toContain("No se encontró cover");
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
