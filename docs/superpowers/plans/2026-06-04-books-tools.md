# Books Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar 5 tools a Jano para gestionar la BD de libros en Notion: buscar, agregar, actualizar, registrar progreso de lectura, y setear cover+ícono desde internet.

**Architecture:** Nuevo archivo `tools/books.ts` con helpers `callNtn` (spawnSync al CLI ntn) y `searchCover` (fetch a Open Library / Google Books). Las 5 funciones de implementación se registran como tools en `agent-tools.ts` siguiendo el mismo patrón que las tools existentes.

**Tech Stack:** TypeScript ESM, Node spawnSync, ntn CLI (`/opt/homebrew/bin/ntn`), Notion REST API, Open Library API, Vitest.

---

## Archivos

| Acción | Archivo |
|--------|---------|
| Crear | `daemon-v2/src/tools/books.ts` |
| Crear | `daemon-v2/src/tools/books.test.ts` |
| Modificar | `daemon-v2/src/agent-tools.ts` |
| Modificar | `daemon-v2/src/agent-options.ts` |
| Modificar | `daemon-v2/src/agent.ts` |
| Modificar | `daemon-v2/src/system-prompt.ts` |

Directorio de trabajo: `/Users/calepes/Claude Projects/Personal/Agents/Jano`

---

## Task 1: Scaffold books.ts — constantes, tipos y helper callNtn

**Files:**
- Create: `daemon-v2/src/tools/books.ts`
- Create: `daemon-v2/src/tools/books.test.ts`

- [ ] **Step 1: Crear books.ts con constantes, tipos y callNtn**

```typescript
// daemon-v2/src/tools/books.ts
import { spawnSync } from "node:child_process";

const NTN_BIN = "/opt/homebrew/bin/ntn";
export const BOOKS_DB   = "b9222a76e9404e229091b1c0e26c29dd";
export const BOOKS_DS   = "901dba51-1d00-4e3f-95b1-17ba628a0915";
export const TRACKING_DB = "70b1e190-8547-4813-b918-43ce59071d3e";

export type EstadoLibro =
  | "Goal" | "Reading" | "Read" | "Focus"
  | "Stand-By" | "Reference" | "wish list";
export type RatingLibro = "🥱" | "😶" | "😊" | "😍";

export interface BookResult {
  pageId: string;
  url: string;
  name: string;
  estado?: string;
  rating?: string;
  avanceTracking?: number;
  startDate?: string;
  isbn?: string;
}

export function callNtn(
  path: string,
  opts: { method?: "POST" | "PATCH" | "DELETE"; body?: unknown } = {}
): { ok: boolean; data?: unknown; error?: string } {
  const args = ["api"];
  if (opts.method) args.push("-X", opts.method);
  args.push(path);
  if (opts.body !== undefined) args.push("-d", JSON.stringify(opts.body));

  const result = spawnSync(NTN_BIN, args, {
    encoding: "utf8",
    timeout: 15_000,
  });

  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout).trim() };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: true, data: result.stdout.trim() };
  }
}
```

- [ ] **Step 2: Crear books.test.ts con test básico de callNtn**

```typescript
// daemon-v2/src/tools/books.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";

// Mock spawnSync before importing books.ts
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
    mockSpawn.mockReturnValue({ status: 0, stdout: '{}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);

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
```

- [ ] **Step 3: Correr test**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/daemon test -- --reporter=verbose 2>&1 | grep -E "PASS|FAIL|✓|✗|callNtn"
```

Esperado: 3 tests PASS en `callNtn`.

- [ ] **Step 4: Commit**

```bash
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" add daemon-v2/src/tools/books.ts daemon-v2/src/tools/books.test.ts
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" commit -m "feat(books): scaffold books.ts with callNtn helper"
```

---

## Task 2: Helper searchCover + tests

**Files:**
- Modify: `daemon-v2/src/tools/books.ts`
- Modify: `daemon-v2/src/tools/books.test.ts`

- [ ] **Step 1: Agregar searchCover a books.ts**

Agregar después de `callNtn`:

```typescript
export async function searchCover(
  isbn?: string,
  title?: string,
  author?: string
): Promise<string | null> {
  // Primary: Open Library by ISBN
  if (isbn) {
    const url = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
    try {
      const res = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok || res.status === 302 || res.redirected) return url;
    } catch {
      // fall through
    }
  }

  // Fallback: Google Books by title + author
  if (title) {
    const q = encodeURIComponent(
      `intitle:${title}${author ? `+inauthor:${author}` : ""}`
    );
    try {
      const res = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=3`,
        { signal: AbortSignal.timeout(8_000) }
      );
      const data = (await res.json()) as {
        items?: Array<{ volumeInfo: { imageLinks?: { thumbnail?: string } } }>;
      };
      const thumb = data?.items?.[0]?.volumeInfo?.imageLinks?.thumbnail;
      if (thumb) return thumb;
    } catch {
      // fall through
    }
  }

  return null;
}
```

- [ ] **Step 2: Agregar tests de searchCover a books.test.ts**

Agregar después del bloque `describe("callNtn")`:

```typescript
describe("searchCover", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
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
```

- [ ] **Step 3: Correr tests**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/daemon test -- --reporter=verbose 2>&1 | grep -E "PASS|FAIL|✓|✗|searchCover|callNtn"
```

Esperado: 6 tests PASS (3 callNtn + 3 searchCover).

- [ ] **Step 4: Commit**

```bash
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" add daemon-v2/src/tools/books.ts daemon-v2/src/tools/books.test.ts
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" commit -m "feat(books): add searchCover helper (Open Library + Google Books fallback)"
```

---

## Task 3: searchBooks

**Files:**
- Modify: `daemon-v2/src/tools/books.ts`
- Modify: `daemon-v2/src/tools/books.test.ts`

- [ ] **Step 1: Agregar función helper formatBookList y searchBooks a books.ts**

```typescript
// Agregar al final de books.ts

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, unknown>;
}

function pageToBookResult(page: NotionPage): BookResult {
  const props = page.properties as Record<string, {
    select?: { name: string };
    title?: Array<{ plain_text: string }>;
    rich_text?: Array<{ plain_text: string }>;
    number?: number;
    date?: { start: string };
  }>;
  return {
    pageId: page.id,
    url: page.url,
    name: props["Name"]?.title?.[0]?.plain_text ?? "(sin título)",
    estado: props["Estado"]?.select?.name,
    rating: props["Rating"]?.select?.name,
    avanceTracking: props["Avance Tracking"]?.number ?? undefined,
    startDate: props["Start Date"]?.date?.start,
    isbn: props["ISBN"]?.rich_text?.[0]?.plain_text,
  };
}

export async function searchBooks(
  query?: string,
  estado?: EstadoLibro
): Promise<string> {
  const body: Record<string, unknown> = { page_size: 30 };

  if (estado) {
    body.filter = {
      property: "Estado",
      select: { equals: estado },
    };
  }

  const res = callNtn(`v1/data_sources/${BOOKS_DS}/query`, { body });
  if (!res.ok) return `❌ Error al buscar libros: ${res.error}`;

  const data = res.data as { results?: NotionPage[] };
  let books = (data.results ?? []).map(pageToBookResult);

  if (query) {
    const q = query.toLowerCase();
    books = books.filter((b) => b.name.toLowerCase().includes(q));
  }

  if (books.length === 0) {
    return query
      ? `📚 No se encontraron libros que coincidan con "<b>${esc(query)}</b>"`
      : "📚 No hay libros en la BD.";
  }

  const ESTADO_EMOJI: Record<string, string> = {
    Reading: "📖", Read: "✅", Goal: "🎯", Focus: "🔥",
    "Stand-By": "⏸️", Reference: "📎", "wish list": "💭",
  };

  const lines = books.map((b) => {
    const emoji = ESTADO_EMOJI[b.estado ?? ""] ?? "•";
    const rating = b.rating ? ` ${b.rating}` : "";
    const avance = b.avanceTracking != null ? ` · ${Math.round(b.avanceTracking * 100)}%` : "";
    return `${emoji} <b>${esc(b.name)}</b>${rating}${avance}\n   <a href="${b.url}">ver →</a>`;
  });

  const titulo = estado
    ? `📚 <b>${books.length} libro${books.length !== 1 ? "s" : ""} — ${estado}</b>`
    : `📚 <b>${books.length} libro${books.length !== 1 ? "s" : ""}</b>`;

  return `${titulo}\n\n${lines.join("\n\n")}`;
}
```

- [ ] **Step 2: Agregar tests de searchBooks a books.test.ts**

```typescript
describe("searchBooks (formatting)", () => {
  it("formats a list of books as HTML", async () => {
    mockSpawn.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        results: [
          {
            id: "abc",
            url: "https://notion.so/abc",
            properties: {
              Name: { title: [{ plain_text: "Leadership on the Line" }] },
              Estado: { select: { name: "Reading" } },
              "Avance Tracking": { number: 0.1 },
              Rating: { select: null },
              "Start Date": { date: null },
              ISBN: { rich_text: [] },
            },
          },
        ],
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
```

- [ ] **Step 3: Correr tests**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/daemon test -- --reporter=verbose 2>&1 | grep -E "✓|✗|PASS|FAIL"
```

Esperado: 9 tests PASS.

- [ ] **Step 4: Commit**

```bash
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" add daemon-v2/src/tools/books.ts daemon-v2/src/tools/books.test.ts
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" commit -m "feat(books): add searchBooks"
```

---

## Task 4: addBook

**Files:**
- Modify: `daemon-v2/src/tools/books.ts`

- [ ] **Step 1: Agregar addBook a books.ts**

```typescript
export interface AddBookParams {
  name: string;
  subtitle?: string;
  isbn?: string;
  estado: EstadoLibro;
  planningToRead?: string;
  totalPaginas?: number;
  startDate?: string;
  finishDate?: string;
  url?: string;
  fetchCover?: boolean;
}

export async function addBook(params: AddBookParams): Promise<string> {
  const {
    name, subtitle, isbn, estado, planningToRead,
    totalPaginas, startDate, finishDate, url,
    fetchCover = true,
  } = params;

  // Build properties
  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: name } }] },
    Estado: { select: { name: estado } },
  };
  if (subtitle) properties["Subtitle"] = { rich_text: [{ text: { content: subtitle } }] };
  if (isbn)     properties["ISBN"]     = { rich_text: [{ text: { content: isbn } }] };
  if (planningToRead) properties["Planning to read"] = { select: { name: planningToRead } };
  if (totalPaginas)   properties["Total Páginas"]    = { number: totalPaginas };
  if (startDate)      properties["Start Date"]       = { date: { start: startDate } };
  if (finishDate)     properties["Finish Date"]      = { date: { start: finishDate } };
  if (url)            properties["userDefined:URL"]  = { url };

  const body: Record<string, unknown> = {
    parent: { database_id: BOOKS_DB },
    properties,
  };

  // Cover + icon
  let coverUrl: string | null = null;
  if (fetchCover) {
    coverUrl = await searchCover(isbn, name);
    if (coverUrl) {
      body.cover = { type: "external", external: { url: coverUrl } };
      body.icon  = { type: "external", external: { url: coverUrl } };
    }
  }

  const res = callNtn("v1/pages", { body });
  if (!res.ok) return `❌ Error al crear libro: ${res.error}`;

  const page = res.data as { id: string; url: string };
  const coverLine = coverUrl ? "\n🖼️ Cover: cargado automáticamente" : "";
  const paginasLine = totalPaginas ? ` · ${totalPaginas} págs` : "";

  return (
    `✅ <b>${esc(name)}</b> creado en Notion\n` +
    `📖 ${estado}${paginasLine}${planningToRead ? ` · ${planningToRead}` : ""}` +
    coverLine +
    `\n<a href="${page.url}">Ver en Notion →</a>`
  );
}
```

- [ ] **Step 2: Agregar test de addBook a books.test.ts**

```typescript
describe("addBook", () => {
  beforeEach(() => vi.clearAllMocks());

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

    // Verify ntn was called with POST to v1/pages
    const ntnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(ntnArgs).toContain("v1/pages");
    const bodyArg = ntnArgs[ntnArgs.indexOf("-d") + 1];
    const body = JSON.parse(bodyArg);
    expect(body.parent.database_id).toBe("b9222a76e9404e229091b1c0e26c29dd");
    expect(body.properties.Name.title[0].text.content).toBe("Leadership on the Line");
    expect(body.properties.Estado.select.name).toBe("Reading");
  });
});
```

- [ ] **Step 3: Correr tests**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/daemon test -- --reporter=verbose 2>&1 | grep -E "✓|✗|PASS|FAIL"
```

Esperado: 10 tests PASS.

- [ ] **Step 4: Commit**

```bash
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" add daemon-v2/src/tools/books.ts daemon-v2/src/tools/books.test.ts
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" commit -m "feat(books): add addBook"
```

---

## Task 5: updateBook

**Files:**
- Modify: `daemon-v2/src/tools/books.ts`

- [ ] **Step 1: Agregar updateBook a books.ts**

```typescript
export interface UpdateBookParams {
  pageId: string;
  estado?: EstadoLibro;
  rating?: RatingLibro;
  startDate?: string;
  finishDate?: string;
  totalPaginas?: number;
  isbn?: string;
  subtitle?: string;
  url?: string;
  planningToRead?: string;
}

export async function updateBook(params: UpdateBookParams): Promise<string> {
  const { pageId, estado, rating, startDate, finishDate,
          totalPaginas, isbn, subtitle, url, planningToRead } = params;

  const properties: Record<string, unknown> = {};
  if (estado)       properties["Estado"]           = { select: { name: estado } };
  if (rating)       properties["Rating"]           = { select: { name: rating } };
  if (startDate)    properties["Start Date"]       = { date: { start: startDate } };
  if (finishDate)   properties["Finish Date"]      = { date: { start: finishDate } };
  if (totalPaginas) properties["Total Páginas"]    = { number: totalPaginas };
  if (isbn)         properties["ISBN"]             = { rich_text: [{ text: { content: isbn } }] };
  if (subtitle)     properties["Subtitle"]         = { rich_text: [{ text: { content: subtitle } }] };
  if (url)          properties["userDefined:URL"]  = { url };
  if (planningToRead) properties["Planning to read"] = { select: { name: planningToRead } };

  if (Object.keys(properties).length === 0) {
    return "⚠️ No se especificaron campos para actualizar.";
  }

  const res = callNtn(`v1/pages/${pageId}`, { method: "PATCH", body: { properties } });
  if (!res.ok) return `❌ Error al actualizar libro: ${res.error}`;

  const updated = Object.keys(properties)
    .map((k) => `• ${k}`)
    .join("\n");
  return `✅ Libro actualizado\n${updated}`;
}
```

- [ ] **Step 2: Agregar test de updateBook a books.test.ts**

```typescript
describe("updateBook", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends PATCH with updated properties", async () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '{"id":"abc"}', stderr: "" } as ReturnType<typeof childProcess.spawnSync>);

    const { updateBook } = await import("./books.js");
    const result = await updateBook({
      pageId: "abc-123",
      estado: "Read",
      rating: "😍",
      finishDate: "2026-06-04",
    });

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
```

- [ ] **Step 3: Correr tests**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/daemon test -- --reporter=verbose 2>&1 | grep -E "✓|✗|PASS|FAIL"
```

Esperado: 12 tests PASS.

- [ ] **Step 4: Commit**

```bash
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" add daemon-v2/src/tools/books.ts daemon-v2/src/tools/books.test.ts
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" commit -m "feat(books): add updateBook"
```

---

## Task 6: logReadingProgress

**Files:**
- Modify: `daemon-v2/src/tools/books.ts`

- [ ] **Step 1: Agregar logReadingProgress a books.ts**

```typescript
export interface LogProgressParams {
  pageId: string;
  porcentajeInicial: number; // 0.0 – 1.0
  porcentajeFinal: number;
  fecha?: string; // ISO date, default hoy
}

export async function logReadingProgress(params: LogProgressParams): Promise<string> {
  const { pageId, porcentajeInicial, porcentajeFinal, fecha } = params;
  const today = new Date().toISOString().slice(0, 10);

  const body = {
    parent: { database_id: TRACKING_DB },
    properties: {
      Book:  { relation: [{ id: pageId }] },
      Fecha: { date: { start: fecha ?? today } },
      "% Inicial": { number: porcentajeInicial },
      "% Final":   { number: porcentajeFinal },
    },
  };

  const res = callNtn("v1/pages", { body });
  if (!res.ok) return `❌ Error al registrar progreso: ${res.error}`;

  const delta = Math.round((porcentajeFinal - porcentajeInicial) * 100);
  const pctI  = Math.round(porcentajeInicial * 100);
  const pctF  = Math.round(porcentajeFinal * 100);

  return (
    `📊 Progreso registrado\n` +
    `${pctI}% → ${pctF}% <i>(+${delta}%)</i>\n` +
    `Fecha: ${fecha ?? today}`
  );
}
```

- [ ] **Step 2: Agregar test de logReadingProgress a books.test.ts**

```typescript
describe("logReadingProgress", () => {
  beforeEach(() => vi.clearAllMocks());

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
```

- [ ] **Step 3: Correr tests**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/daemon test -- --reporter=verbose 2>&1 | grep -E "✓|✗|PASS|FAIL"
```

Esperado: 13 tests PASS.

- [ ] **Step 4: Commit**

```bash
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" add daemon-v2/src/tools/books.ts daemon-v2/src/tools/books.test.ts
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" commit -m "feat(books): add logReadingProgress"
```

---

## Task 7: setBookCover

**Files:**
- Modify: `daemon-v2/src/tools/books.ts`

- [ ] **Step 1: Agregar setBookCover a books.ts**

```typescript
export interface SetCoverParams {
  pageId: string;
  isbn?: string;
  title?: string;
  author?: string;
}

export async function setBookCover(params: SetCoverParams): Promise<string> {
  const { pageId, isbn, title, author } = params;

  const coverUrl = await searchCover(isbn, title, author);
  if (!coverUrl) {
    return (
      "❌ No se encontró cover para este libro.\n" +
      "Intenta proveer ISBN o asegúrate de que el título sea exacto."
    );
  }

  const res = callNtn(`v1/pages/${pageId}`, {
    method: "PATCH",
    body: {
      cover: { type: "external", external: { url: coverUrl } },
      icon:  { type: "external", external: { url: coverUrl } },
    },
  });

  if (!res.ok) return `❌ Error al actualizar cover: ${res.error}`;

  const source = isbn ? "Open Library (ISBN)" : "Google Books";
  return (
    `🖼️ Cover actualizado\n` +
    `Fuente: ${source}\n` +
    `<a href="${coverUrl}">ver imagen →</a>`
  );
}
```

- [ ] **Step 2: Agregar test de setBookCover a books.test.ts**

```typescript
describe("setBookCover", () => {
  beforeEach(() => {
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
```

- [ ] **Step 3: Correr todos los tests**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/daemon test -- --reporter=verbose 2>&1 | grep -E "✓|✗|PASS|FAIL|Tests"
```

Esperado: 15 tests PASS, 0 failed.

- [ ] **Step 4: Commit**

```bash
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" add daemon-v2/src/tools/books.ts daemon-v2/src/tools/books.test.ts
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" commit -m "feat(books): add setBookCover (cover + icon same URL)"
```

---

## Task 8: Registrar tools en agent-tools.ts

**Files:**
- Modify: `daemon-v2/src/agent-tools.ts`

- [ ] **Step 1: Agregar import de books.ts al inicio de agent-tools.ts**

Agregar junto con los otros imports de tools (buscar el bloque `import { ... } from "./tools/..."`):

```typescript
import {
  searchBooks,
  addBook,
  updateBook,
  logReadingProgress,
  setBookCover,
  type EstadoLibro,
  type RatingLibro,
} from "./tools/books.js";
```

- [ ] **Step 2: Agregar las 5 tools a la función buildSdkTools()**

Agregar después del último `tool(...)` existente, antes del cierre `]` del return:

```typescript
tool(
  "searchBooks",
  "Busca libros en la BD de Notion de Cal. Filtra por nombre y/o estado. Devuelve lista con título, estado, % avance y link.",
  {
    query:  z.string().optional().describe("Texto a buscar en el título del libro"),
    estado: z.enum(["Goal","Reading","Read","Focus","Stand-By","Reference","wish list"]).optional(),
  },
  async ({ query, estado }) =>
    asText(await searchBooks(query, estado as EstadoLibro | undefined)),
  READ_ONLY,
),

tool(
  "addBook",
  "Agrega un libro nuevo a la BD de Notion. Busca y setea el cover automáticamente si hay ISBN o título. Setea cover e icono con la misma imagen.",
  {
    name:           z.string().describe("Título del libro"),
    subtitle:       z.string().optional(),
    isbn:           z.string().optional(),
    estado:         z.enum(["Goal","Reading","Read","Focus","Stand-By","Reference","wish list"]),
    planningToRead: z.enum(["2021","2022","2023","2024","2025","2026"]).optional(),
    totalPaginas:   z.number().int().positive().optional(),
    startDate:      z.string().optional().describe("ISO date YYYY-MM-DD"),
    finishDate:     z.string().optional().describe("ISO date YYYY-MM-DD"),
    url:            z.string().optional().describe("URL del libro (Apple Books, Amazon, etc.)"),
    fetchCover:     z.boolean().optional().describe("Buscar y setear cover automáticamente. Default true."),
  },
  async (params) => asText(await addBook(params as Parameters<typeof addBook>[0])),
),

tool(
  "updateBook",
  "Actualiza propiedades de un libro existente en la BD de Notion. Solo actualiza los campos provistos.",
  {
    pageId:         z.string().describe("ID de la página Notion del libro"),
    estado:         z.enum(["Goal","Reading","Read","Focus","Stand-By","Reference","wish list"]).optional(),
    rating:         z.enum(["🥱","😶","😊","😍"]).optional(),
    startDate:      z.string().optional().describe("ISO date YYYY-MM-DD"),
    finishDate:     z.string().optional().describe("ISO date YYYY-MM-DD"),
    totalPaginas:   z.number().int().positive().optional(),
    isbn:           z.string().optional(),
    subtitle:       z.string().optional(),
    url:            z.string().optional(),
    planningToRead: z.enum(["2021","2022","2023","2024","2025","2026"]).optional(),
  },
  async (params) => asText(await updateBook(params as Parameters<typeof updateBook>[0])),
),

tool(
  "logReadingProgress",
  "Registra una sesión de lectura en el tracking de libros. Los porcentajes son decimales: 0.10 = 10%, 0.25 = 25%.",
  {
    pageId:              z.string().describe("ID de la página Notion del libro"),
    porcentajeInicial:   z.number().min(0).max(1).describe("% al inicio de la sesión (0.0–1.0)"),
    porcentajeFinal:     z.number().min(0).max(1).describe("% al final de la sesión (0.0–1.0)"),
    fecha:               z.string().optional().describe("ISO date YYYY-MM-DD. Default: hoy."),
  },
  async (params) => asText(await logReadingProgress(params)),
),

tool(
  "setBookCover",
  "Busca el cover del libro en internet (Open Library por ISBN, Google Books como fallback) y lo aplica como banner e ícono de la página en Notion.",
  {
    pageId: z.string().describe("ID de la página Notion del libro"),
    isbn:   z.string().optional(),
    title:  z.string().optional().describe("Título del libro para búsqueda si no hay ISBN"),
    author: z.string().optional().describe("Autor para refinar la búsqueda"),
  },
  async (params) => asText(await setBookCover(params)),
),
```

- [ ] **Step 3: Build daemon para verificar tipos**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/shared run build && npm -w @cos/daemon run build 2>&1 | grep -E "error TS|warning|Error" | head -20
```

Esperado: sin errores TypeScript.

- [ ] **Step 4: Commit**

```bash
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" add daemon-v2/src/agent-tools.ts
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" commit -m "feat(books): register 5 book tools in agent-tools.ts"
```

---

## Task 9: Wiring final — agent-options.ts, agent.ts, system-prompt.ts

**Files:**
- Modify: `daemon-v2/src/agent-options.ts`
- Modify: `daemon-v2/src/agent.ts`
- Modify: `daemon-v2/src/system-prompt.ts`

- [ ] **Step 1: Agregar tools a CLAUDE_AI_COS_TOOLS en agent-options.ts**

Buscar el bloque de `mcp__cos-tools__` tools en el array `CLAUDE_AI_COS_TOOLS` y agregar al final del grupo:

```typescript
"mcp__cos-tools__searchBooks",
"mcp__cos-tools__addBook",
"mcp__cos-tools__updateBook",
"mcp__cos-tools__logReadingProgress",
"mcp__cos-tools__setBookCover",
```

- [ ] **Step 2: Agregar TOOL_MESSAGES en agent.ts**

Buscar el objeto `TOOL_MESSAGES` y agregar:

```typescript
"mcp__cos-tools__searchBooks":        "📚 Buscando libros...",
"mcp__cos-tools__addBook":            "📖 Creando libro en Notion...",
"mcp__cos-tools__updateBook":         "✏️ Actualizando libro...",
"mcp__cos-tools__logReadingProgress": "📊 Registrando progreso de lectura...",
"mcp__cos-tools__setBookCover":       "🖼️ Buscando cover del libro...",
```

- [ ] **Step 3: Agregar sección Libros al system-prompt.ts**

Buscar el final del archivo (antes del último bloque `PROHIBIDO` o al final del prompt). Agregar:

```typescript
// Dentro del template string del system prompt, agregar sección:
`
## Libros (Notion BD)

Gestiona la BD personal de libros de Cal en Notion. Usa las tools de libros en estos casos:

**Triggers:**
- "agrega el libro X" / "quiero leer X" → addBook (estado=Goal o Reading según contexto)
- "estoy leyendo X" → addBook(estado=Reading, startDate=hoy) + logReadingProgress(%i=0, %f=0)
- "terminé X" → updateBook(estado=Read, finishDate=hoy)
- "voy por el N% de X" / "leí hasta la página N" → searchBooks(query=X) para obtener pageId → logReadingProgress
- "califica X con Y" → updateBook(rating=emoji)
- "pon el cover de X" / "actualiza el cover" → setBookCover
- "qué estoy leyendo" / "mis libros" → searchBooks(estado=Reading)
- "wish list de libros" → searchBooks(estado="wish list")

**Notas:**
- logReadingProgress usa decimales: 10% = 0.10, 25% = 0.25
- Al agregar un libro leyendo, setear startDate con la fecha que Cal indique o hoy
- Si Cal dice "estoy en la página N de M", calcular: N/M = porcentajeFinal
- setBookCover siempre setea cover (banner) e icono con la misma imagen
- No setear Author/Tags/Big Themes vía tool (son relaciones complejas — Cal las asigna en Notion)
`
```

- [ ] **Step 4: Build final**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/shared run build && npm -w @cos/daemon run build 2>&1 | grep -E "error TS|Error" | head -20
```

Esperado: build limpio, sin errores.

- [ ] **Step 5: Correr todos los tests**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/daemon test 2>&1 | tail -10
```

Esperado: 15 tests PASS.

- [ ] **Step 6: Commit final**

```bash
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" add daemon-v2/src/agent-options.ts daemon-v2/src/agent.ts daemon-v2/src/system-prompt.ts
git -C "/Users/calepes/Claude Projects/Personal/Agents/Jano" commit -m "feat(books): wire books tools into daemon (allowlist, messages, system-prompt)"
```

---

## Task 10: Deploy y smoke test

- [ ] **Step 1: Restart daemon**

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
sleep 3
launchctl print gui/$(id -u)/com.cal.cos-agent-v2 | grep -E "state|pid"
```

Esperado: `state = running`

- [ ] **Step 2: Verificar logs arranque limpio**

```bash
tail -20 ~/Library/Logs/cos-agent-v2.out.log
tail -5 ~/Library/Logs/cos-agent-v2.err.log
```

Esperado: sin errores de import o MCP.

- [ ] **Step 3: Smoke test vía Telegram**

Enviar a @cal_jano_bot:
```
qué libros estoy leyendo
```

Esperado: respuesta con "Leadership on the Line · 10%" y link a Notion.

- [ ] **Step 4: Smoke test logReadingProgress**

Enviar a @cal_jano_bot:
```
avancé en Leadership on the Line, ya voy por el 15%
```

Esperado: Jano llama `searchBooks` para obtener el pageId, luego `logReadingProgress(0.1, 0.15)`, responde con "10% → 15% (+5%)".
