import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const mockSpawn = vi.mocked(childProcess.spawnSync);

import { callNtn } from "../shared/ntn.js";

// book-relation-pending.ts resuelve su path desde process.env.HOME al importarse — mismo
// patrón que session-store.test.ts, para no tocar el ~/.cos-agent real de Cal.
let tmpHome: string;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "jano-books-"));
  process.env.HOME = tmpHome;
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

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

  it("returns Open Library URL when ISBN cover exists", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { searchCover } = await import("./books.js");
    const url = await searchCover("9781578514373");
    expect(url).toBe("https://covers.openlibrary.org/b/isbn/9781578514373-L.jpg");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://covers.openlibrary.org/b/isbn/9781578514373-L.jpg?default=false",
      expect.objectContaining({ method: "HEAD" })
    );
  });

  it("returns Google Books cover when available (primary source)", async () => {
    process.env.GOOGLE_BOOKS_API_KEY = "test-key";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ volumeInfo: { imageLinks: { thumbnail: "https://books.google.com/thumb.jpg" } } }],
      }),
    });
    const { searchCover } = await import("./books.js");
    const url = await searchCover(undefined, "Leadership on the Line", "Heifetz");
    expect(url).toBe("https://books.google.com/thumb.jpg");
    delete process.env.GOOGLE_BOOKS_API_KEY;
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
            Estado: { status: { name: "Reading" } },
            "Avance Tracking": { rollup: { number: 0.1 } },
            "Total Páginas": { number: 240 },
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
    expect(result).toContain("240 págs");
    expect(result).toContain("📖");
  });

  it("filters by query text", async () => {
    mockSpawn.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        results: [
          { id: "a", url: "u1", properties: { Name: { title: [{ plain_text: "Book A" }] }, Estado: { status: { name: "Read" } }, "Avance Tracking": { rollup: { number: null } }, Rating: { select: null }, "Start Date": { date: null }, ISBN: { rich_text: [] } } },
          { id: "b", url: "u2", properties: { Name: { title: [{ plain_text: "Book B" }] }, Estado: { status: { name: "Reading" } }, "Avance Tracking": { rollup: { number: null } }, Rating: { select: null }, "Start Date": { date: null }, ISBN: { rich_text: [] } } },
        ],
      }),
      stderr: "",
    } as ReturnType<typeof childProcess.spawnSync>);

    const { searchBooks } = await import("./books.js");
    const result = await searchBooks({ query: "Book A" });
    expect(result).toContain("Book A");
    expect(result).not.toContain("Book B");
  });

  it("returns no-results message when empty", async () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '{"results":[]}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);
    const { searchBooks } = await import("./books.js");
    const result = await searchBooks({ query: "xyz" });
    expect(result).toContain("No se encontraron");
  });

  it("combines multiple scalar filters with AND", async () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '{"results":[]}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);
    const { searchBooks } = await import("./books.js");
    await searchBooks({ estado: "Reading", rating: "😍", planningToRead: "2026" });

    const args = mockSpawn.mock.calls[0][1] as string[];
    const body = JSON.parse(args[args.indexOf("-d") + 1]);
    expect(body.filter.and).toHaveLength(3);
    expect(body.filter.and).toContainEqual({ property: "Estado", status: { equals: "Reading" } });
    expect(body.filter.and).toContainEqual({ property: "Rating", select: { equals: "😍" } });
    expect(body.filter.and).toContainEqual({ property: "Planning to read", select: { equals: "2026" } });
  });

  it("filters by rollup ranges (Avance Tracking, Ultima lectura)", async () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '{"results":[]}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);
    const { searchBooks } = await import("./books.js");
    await searchBooks({ avanceTrackingMin: 0.5, ultimaLecturaFrom: "2026-01-01" });

    const args = mockSpawn.mock.calls[0][1] as string[];
    const body = JSON.parse(args[args.indexOf("-d") + 1]);
    expect(body.filter.and).toContainEqual({
      property: "Avance Tracking",
      rollup: { number: { greater_than_or_equal_to: 0.5 } },
    });
    expect(body.filter.and).toContainEqual({
      property: "Ultima lectura",
      rollup: { date: { on_or_after: "2026-01-01" } },
    });
  });

  it("resolves author to a relation filter", async () => {
    mockSpawn
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ results: [{ id: "author-1", properties: { Name: { title: [{ plain_text: "Simon Sinek" }] } } }] }),
        stderr: "",
      } as ReturnType<typeof childProcess.spawnSync>)
      .mockReturnValueOnce({ status: 0, stdout: '{"results":[]}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);

    const { searchBooks } = await import("./books.js");
    await searchBooks({ author: "Simon Sinek" });

    const args = mockSpawn.mock.calls[1][1] as string[];
    const body = JSON.parse(args[args.indexOf("-d") + 1]);
    expect(body.filter).toEqual({ property: "Author", relation: { contains: "author-1" } });
  });

  it("returns an explicit message when author doesn't resolve", async () => {
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: '{"results":[]}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);
    const { searchBooks } = await import("./books.js");
    const result = await searchBooks({ author: "Nadie" });
    expect(result).toContain("No encontré");
    expect(result).toContain("Nadie");
    expect(mockSpawn).toHaveBeenCalledTimes(1); // nunca llega a queryear libros
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
    expect(body.properties.Estado.status.name).toBe("Reading");
  });

  it("writes Google Books pageCount when totalPaginas is omitted", async () => {
    process.env.GOOGLE_BOOKS_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{
          volumeInfo: {
            title: "Cracking the PM Interview",
            authors: ["Gayle Laakmann McDowell", "Jackie Bavaro"],
            pageCount: 363,
            imageLinks: { thumbnail: "https://books.google.com/thumb.jpg" },
          },
        }],
      }),
    }));
    mockSpawn.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ id: "new-id", url: "https://notion.so/new" }),
      stderr: "",
    } as ReturnType<typeof childProcess.spawnSync>);

    const { addBook } = await import("./books.js");
    await addBook({
      name: "Cracking the PM Interview",
      estado: "Goal",
      author: "Gayle Laakmann McDowell",
    });
    delete process.env.GOOGLE_BOOKS_API_KEY;

    const ntnArgs = mockSpawn.mock.calls.at(-1)?.[1] as string[];
    const body = JSON.parse(ntnArgs[ntnArgs.indexOf("-d") + 1]);
    expect(body.properties["Total Páginas"].number).toBe(363);
  });

  it("writes URL to the real 'URL' property, not 'userDefined:URL'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 302, redirected: false }));
    mockSpawn.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ id: "new-id", url: "https://notion.so/new" }),
      stderr: "",
    } as ReturnType<typeof childProcess.spawnSync>);

    const { addBook } = await import("./books.js");
    await addBook({
      name: "Some Book",
      estado: "Goal",
      url: "https://apple.co/xyz",
      fetchCover: false,
    });

    const ntnArgs = mockSpawn.mock.calls[0][1] as string[];
    const body = JSON.parse(ntnArgs[ntnArgs.indexOf("-d") + 1]);
    expect(body.properties["URL"].url).toBe("https://apple.co/xyz");
    expect(body.properties["userDefined:URL"]).toBeUndefined();
  });

  it("resolves author to a single matching relation and sets it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 302, redirected: false }));
    mockSpawn
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          results: [{ id: "author-page-1", properties: { Name: { title: [{ plain_text: "Simon Sinek" }] } } }],
        }),
        stderr: "",
      } as ReturnType<typeof childProcess.spawnSync>)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ id: "book-id", url: "https://notion.so/book-id" }),
        stderr: "",
      } as ReturnType<typeof childProcess.spawnSync>);

    const { addBook } = await import("./books.js");
    const result = await addBook({
      name: "Leaders Eat Last",
      estado: "Goal",
      author: "Simon Sinek",
      fetchCover: false,
    });

    expect(result).not.toContain("No encontré");
    const createArgs = mockSpawn.mock.calls[1][1] as string[];
    const body = JSON.parse(createArgs[createArgs.indexOf("-d") + 1]);
    expect(body.properties.Author.relation[0].id).toBe("author-page-1");
  });

  it("does not fail book creation when author has no match — returns a pending note instead", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 302, redirected: false }));
    mockSpawn
      .mockReturnValueOnce({ status: 0, stdout: '{"results":[]}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ id: "book-id", url: "https://notion.so/book-id" }),
        stderr: "",
      } as ReturnType<typeof childProcess.spawnSync>);

    const { addBook } = await import("./books.js");
    const result = await addBook({
      name: "Some New Book",
      estado: "Goal",
      author: "Nombre Inexistente",
      fetchCover: false,
    });

    expect(result).toContain("creado en Notion");
    expect(result).toContain("No encontré");
    expect(result).toContain("Nombre Inexistente");
    expect(result).toContain("book-id");

    const createArgs = mockSpawn.mock.calls[1][1] as string[];
    const body = JSON.parse(createArgs[createArgs.indexOf("-d") + 1]);
    expect(body.properties.Author).toBeUndefined();
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
    expect(body.properties["Estado"].status.name).toBe("Read");
    expect(body.properties["Rating"].select.name).toBe("😍");
  });

  it("clears Planning to read with clearPlanningToRead (select: null, not a name)", async () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '{"id":"abc"}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);

    const { updateBook } = await import("./books.js");
    await updateBook({ pageId: "abc-123", clearPlanningToRead: true });

    const ntnArgs = mockSpawn.mock.calls[0][1] as string[];
    const body = JSON.parse(ntnArgs[ntnArgs.indexOf("-d") + 1]);
    expect(body.properties["Planning to read"]).toEqual({ select: null });
  });

  it("ignores planningToRead when clearPlanningToRead is also set", async () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '{"id":"abc"}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);

    const { updateBook } = await import("./books.js");
    await updateBook({ pageId: "abc-123", planningToRead: "2026", clearPlanningToRead: true });

    const ntnArgs = mockSpawn.mock.calls[0][1] as string[];
    const body = JSON.parse(ntnArgs[ntnArgs.indexOf("-d") + 1]);
    expect(body.properties["Planning to read"]).toEqual({ select: null });
  });

  it("returns warning when no fields provided", async () => {
    const { updateBook } = await import("./books.js");
    const result = await updateBook({ pageId: "abc" });
    expect(result).toContain("No se especificaron campos");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("merges new tags with existing ones instead of replacing them", async () => {
    mockSpawn
      // GET libro existente (para leer relaciones actuales)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          id: "book-1",
          properties: { Tags: { relation: [{ id: "tag-existing" }] } },
        }),
        stderr: "",
      } as ReturnType<typeof childProcess.spawnSync>)
      // query a la DB de Tags buscando "Liderazgo"
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          results: [{ id: "tag-nuevo", properties: { Topic: { title: [{ plain_text: "Liderazgo" }] } } }],
        }),
        stderr: "",
      } as ReturnType<typeof childProcess.spawnSync>)
      // PATCH final
      .mockReturnValueOnce({ status: 0, stdout: '{"id":"book-1"}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);

    const { updateBook } = await import("./books.js");
    const result = await updateBook({ pageId: "book-1", tags: ["Liderazgo"] });

    expect(result).toContain("actualizado");
    const patchArgs = mockSpawn.mock.calls[2][1] as string[];
    const body = JSON.parse(patchArgs[patchArgs.indexOf("-d") + 1]);
    const ids = body.properties.Tags.relation.map((r: { id: string }) => r.id);
    expect(ids).toContain("tag-existing");
    expect(ids).toContain("tag-nuevo");
  });

  it("does NOT touch Tags/Big Themes when it can't read the book's current state", async () => {
    // GET del libro falla (network blip, rate limit, etc.)
    mockSpawn.mockReturnValueOnce({ status: 1, stdout: "", stderr: "rate limited" } as ReturnType<typeof childProcess.spawnSync>);

    const { updateBook } = await import("./books.js");
    const result = await updateBook({ pageId: "book-1", tags: ["Liderazgo"], rating: "😍" });

    // El resto de los campos SÍ se actualiza — solo las relaciones quedan sin tocar.
    expect(result).toContain("actualizado");
    expect(result).toContain("No pude leer el estado actual del libro");

    // Una sola llamada total: el GET fallido. Nunca se llega a un PATCH que reemplace Tags.
    expect(mockSpawn).toHaveBeenCalledTimes(2); // GET (falla) + PATCH final (solo Rating)
    const patchArgs = mockSpawn.mock.calls[1][1] as string[];
    const body = JSON.parse(patchArgs[patchArgs.indexOf("-d") + 1]);
    expect(body.properties.Tags).toBeUndefined();
    expect(body.properties.Rating.select.name).toBe("😍");
  });

  it("replaces Author instead of merging with the existing one (single-value, unlike Tags)", async () => {
    mockSpawn
      // resolver "Simon Sinek" contra la DB de Personas
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ results: [{ id: "author-nuevo", properties: { Name: { title: [{ plain_text: "Simon Sinek" }] } } }] }),
        stderr: "",
      } as ReturnType<typeof childProcess.spawnSync>)
      // PATCH final
      .mockReturnValueOnce({ status: 0, stdout: '{"id":"book-1"}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);

    const { updateBook } = await import("./books.js");
    const result = await updateBook({ pageId: "book-1", author: "Simon Sinek" });

    expect(result).toContain("actualizado");
    // Solo 2 llamadas: resolver + PATCH. Nunca un GET previo del libro — author no mergea.
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const patchArgs = mockSpawn.mock.calls[1][1] as string[];
    const body = JSON.parse(patchArgs[patchArgs.indexOf("-d") + 1]);
    expect(body.properties.Author.relation).toEqual([{ id: "author-nuevo" }]);
  });
});

describe("logReadingProgress", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("creates tracking entry with correct body", async () => {
    mockSpawn
      .mockReturnValueOnce({
        status: 0,
        stdout: '{"id":"track-1","url":"https://notion.so/track-1"}',
        stderr: "",
      } as ReturnType<typeof childProcess.spawnSync>)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          id: "book-id",
          url: "https://notion.so/book-id",
          properties: { Name: { title: [{ plain_text: "Leadership on the Line" }] } },
        }),
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
    expect(result).toContain("Leadership on the Line");
    expect(result).toMatch(/^📖 <b>Leadership on the Line<\/b>/);
    expect(result.split("\n")).toHaveLength(2);
    expect(result).toContain("· 2026-06-04");

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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
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

describe("confirmCreateBookRelation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("creates the relation page and links it to the book, merging with existing relations", async () => {
    mockSpawn
      // crear la página nueva
      .mockReturnValueOnce({ status: 0, stdout: '{"id":"new-author-id"}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>)
      // GET libro para leer relaciones existentes
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ id: "book-1", properties: { Author: { relation: [] } } }),
        stderr: "",
      } as ReturnType<typeof childProcess.spawnSync>)
      // PATCH final
      .mockReturnValueOnce({ status: 0, stdout: '{"id":"book-1"}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);

    const { confirmCreateBookRelation } = await import("./books.js");
    const { addPendingRelation } = await import("./book-relation-pending.js");
    // Simula que addBook/updateBook ya propuso esta relación — el gate solo ejecuta si matchea.
    addPendingRelation("book-1", "author", "Simon Sinek");

    const result = await confirmCreateBookRelation({
      tipo: "author",
      nombre: "Simon Sinek",
      bookPageId: "book-1",
    });

    expect(result).toContain("Autor");
    expect(result).toContain("Simon Sinek");
    expect(result).toContain("creado y vinculado");

    const createArgs = mockSpawn.mock.calls[0][1] as string[];
    const createBody = JSON.parse(createArgs[createArgs.indexOf("-d") + 1]);
    expect(createBody.parent.database_id).toBe("57e58779c09c4dea8a61023fb6c9a0a0");
    expect(createBody.properties.Name.title[0].text.content).toBe("Simon Sinek");

    const patchArgs = mockSpawn.mock.calls[2][1] as string[];
    const patchBody = JSON.parse(patchArgs[patchArgs.indexOf("-d") + 1]);
    expect(patchBody.properties.Author.relation[0].id).toBe("new-author-id");
  });

  it("rejects the call when there is no matching pending proposal (prompt-injection gate)", async () => {
    const { confirmCreateBookRelation } = await import("./books.js");

    const result = await confirmCreateBookRelation({
      tipo: "author",
      nombre: "Alguien Nunca Propuesto",
      bookPageId: "book-1",
    });

    expect(result).toContain("No hay ninguna propuesta pendiente");
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe("getReadingHistory", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns the full session history for a single matching book", async () => {
    mockSpawn
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          results: [{
            id: "book-1", url: "https://notion.so/book-1",
            properties: {
              Name: { title: [{ plain_text: "Continuous Discovery Habits" }] },
              Estado: { status: { name: "Reading" } },
              "Avance Tracking": { rollup: { number: 0.59 } },
              "Total Páginas": { number: 300 },
              Rating: { select: null }, "Start Date": { date: null }, ISBN: { rich_text: [] },
            },
          }],
        }),
        stderr: "",
      } as ReturnType<typeof childProcess.spawnSync>)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          results: [
            { properties: { Fecha: { date: { start: "2026-01-01" } }, "% Inicial": { number: 0 }, "% Final": { number: 0.2 }, "Avance (pag)": { formula: { number: 60 } } } },
            { properties: { Fecha: { date: { start: "2026-01-07" } }, "% Inicial": { number: 0.2 }, "% Final": { number: 0.59 }, "Avance (pag)": { formula: { number: 117 } } } },
          ],
        }),
        stderr: "",
      } as ReturnType<typeof childProcess.spawnSync>);

    const { getReadingHistory } = await import("./books.js");
    const result = await getReadingHistory("Continuous Discovery");

    expect(result).toContain("Continuous Discovery Habits");
    expect(result).toContain("59%");
    expect(result).toContain("59% de 300 págs");
    expect(result).toContain("2 sesiones");
    expect(result).toContain("2026-01-01: 0% → 20% — 60 págs");
    expect(result).toContain("2026-01-07: 20% → 59% — 117 págs");
  });

  it("asks which book when the query matches more than one", async () => {
    mockSpawn.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        results: [
          { id: "a", url: "u1", properties: { Name: { title: [{ plain_text: "Book Alpha" }] }, Estado: { status: { name: "Reading" } }, "Avance Tracking": { rollup: {} }, Rating: { select: null }, "Start Date": { date: null }, ISBN: { rich_text: [] } } },
          { id: "b", url: "u2", properties: { Name: { title: [{ plain_text: "Book Beta" }] }, Estado: { status: { name: "Reading" } }, "Avance Tracking": { rollup: {} }, Rating: { select: null }, "Start Date": { date: null }, ISBN: { rich_text: [] } } },
        ],
      }),
      stderr: "",
    } as ReturnType<typeof childProcess.spawnSync>);

    const { getReadingHistory } = await import("./books.js");
    const result = await getReadingHistory("Book");

    expect(result).toContain("varios libros");
    expect(result).toContain("Book Alpha");
    expect(result).toContain("Book Beta");
  });
});
