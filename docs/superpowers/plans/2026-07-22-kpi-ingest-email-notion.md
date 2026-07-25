# Ingesta automática de KPIs Yape desde mail (Self-Service → Notion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cron mecánico de Jano que detecta el mail diario de BCP ("Self-Service"), baja el CSV adjunto, hace upsert de los KPIs raw por Fecha en la DB de Notion "KPIs diarios", completa los 4 campos derivados documentados en todo el histórico, y le manda a Cal un reporte por Telegram.

**Architecture:** 4 módulos nuevos en `daemon-v2/src/proactive/`: parseo CSV puro (`kpi-ingest-csv.ts`), acceso a Gmail vía OAuth propio (`kpi-ingest-gmail.ts`), acceso a Notion + fórmulas de derivados (`kpi-ingest-notion.ts`), y el orquestador con estado local + reporte (`kpi-ingest-check.ts`). Se registra un cron nuevo en `index.ts` (`*/15 6-23 * * *` America/La_Paz), condicionado a que existan las credenciales de Gmail.

**Tech Stack:** TypeScript, Node.js, `node-cron`, `vitest`, fetch nativo (sin SDKs de Google/Notion — REST directo, mismo patrón que `resumir.ts`/`kpi-card-daily.ts`).

**Spec:** `docs/superpowers/specs/2026-07-22-kpi-ingest-email-notion-design.md`

**Política de commits (obligatoria para quien ejecute este plan):** Cal pidió explícitamente que los commits se hagan SOLO cuando él lo pide (ver `~/.claude/CLAUDE.md` global). Cada tarea de este plan termina con un paso de **stage** (`git add`), NO de commit. Al terminar TODAS las tareas, preguntarle a Cal si quiere que se genere el/los commit(s) antes de cerrar.

---

## Task 1: Parseo CSV — delimitador, números, fechas (funciones puras)

**Files:**
- Create: `daemon-v2/src/proactive/kpi-ingest-csv.ts`
- Test: `daemon-v2/src/proactive/kpi-ingest-csv.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `daemon-v2/src/proactive/kpi-ingest-csv.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectDelimiter, parseNumber, normalizeDate, isSunday } from "./kpi-ingest-csv.js";

describe("detectDelimiter", () => {
  it("detecta coma cuando hay más comas que punto y comas", () => {
    expect(detectDelimiter("Fecha,TRX,Activos DAU")).toBe(",");
  });
  it("detecta punto y coma cuando hay más ; que ,", () => {
    expect(detectDelimiter("Fecha;TRX;Activos DAU")).toBe(";");
  });
  it("ignora delimitadores dentro de comillas", () => {
    expect(detectDelimiter('"Nota, con coma",TRX,DAU')).toBe(",");
  });
});

describe("parseNumber", () => {
  it("parsea estilo LatAm (punto=miles, coma=decimal)", () => {
    expect(parseNumber("1.234,56")).toBeCloseTo(1234.56);
  });
  it("parsea estilo US (coma=miles, punto=decimal)", () => {
    expect(parseNumber("1,234.56")).toBeCloseTo(1234.56);
  });
  it("parsea miles sin decimales (con punto)", () => {
    expect(parseNumber("12.345")).toBe(12345);
  });
  it("parsea miles sin decimales (con coma)", () => {
    expect(parseNumber("12,345")).toBe(12345);
  });
  it("parsea un número plano", () => {
    expect(parseNumber("42")).toBe(42);
  });
  it("parsea un decimal plano con punto", () => {
    expect(parseNumber("42.5")).toBe(42.5);
  });
  it("devuelve null para vacío", () => {
    expect(parseNumber("")).toBeNull();
  });
  it("devuelve null para texto ilegible", () => {
    expect(parseNumber("N/D")).toBeNull();
  });
});

describe("normalizeDate", () => {
  it("deja pasar YYYY-MM-DD", () => {
    expect(normalizeDate("2026-07-20")).toBe("2026-07-20");
  });
  it("normaliza DD/MM/YYYY", () => {
    expect(normalizeDate("20/07/2026")).toBe("2026-07-20");
  });
  it("normaliza DD-MM-YYYY", () => {
    expect(normalizeDate("20-07-2026")).toBe("2026-07-20");
  });
  it("normaliza día/mes de un solo dígito", () => {
    expect(normalizeDate("5/7/2026")).toBe("2026-07-05");
  });
  it("devuelve null para formato desconocido", () => {
    expect(normalizeDate("julio 20")).toBeNull();
  });
});

describe("isSunday", () => {
  it("identifica un domingo", () => {
    expect(isSunday("2026-07-19")).toBe(true);
  });
  it("identifica un día que no es domingo", () => {
    expect(isSunday("2026-07-20")).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npm run test -w @cos/daemon -- kpi-ingest-csv`
Expected: FAIL — `Cannot find module './kpi-ingest-csv.js'`

- [ ] **Step 3: Implementar las funciones puras**

Crear `daemon-v2/src/proactive/kpi-ingest-csv.ts`:

```ts
export function detectDelimiter(headerLine: string): "," | ";" {
  const countOutsideQuotes = (line: string, ch: string): number => {
    let count = 0;
    let inQuotes = false;
    for (const c of line) {
      if (c === '"') inQuotes = !inQuotes;
      else if (c === ch && !inQuotes) count++;
    }
    return count;
  };
  const commas = countOutsideQuotes(headerLine, ",");
  const semicolons = countOutsideQuotes(headerLine, ";");
  return semicolons > commas ? ";" : ",";
}

export function parseNumber(raw: string): number | null {
  const v = raw.trim();
  if (v === "") return null;
  if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(v)) {
    return Number(v.replace(/\./g, "").replace(",", "."));
  }
  if (/^-?\d{1,3}(,\d{3})*\.\d+$/.test(v)) {
    return Number(v.replace(/,/g, ""));
  }
  if (/^-?\d{1,3}(\.\d{3})+$/.test(v)) {
    return Number(v.replace(/\./g, ""));
  }
  if (/^-?\d{1,3}(,\d{3})+$/.test(v)) {
    return Number(v.replace(/,/g, ""));
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    return Number(v);
  }
  return null;
}

export function normalizeDate(raw: string): string | null {
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

export function isSunday(fechaIso: string): boolean {
  return new Date(`${fechaIso}T00:00:00Z`).getUTCDay() === 0;
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npm run test -w @cos/daemon -- kpi-ingest-csv`
Expected: PASS (todos los tests de este archivo)

- [ ] **Step 5: Stage (sin commit)**

```bash
git add daemon-v2/src/proactive/kpi-ingest-csv.ts daemon-v2/src/proactive/kpi-ingest-csv.test.ts
```

---

## Task 2: Mapeo de columnas + `parseCsv` + regla de domingo

**Files:**
- Modify: `daemon-v2/src/proactive/kpi-ingest-csv.ts`
- Modify: `daemon-v2/src/proactive/kpi-ingest-csv.test.ts`

- [ ] **Step 1: Agregar los tests que fallan**

Agregar al final de `daemon-v2/src/proactive/kpi-ingest-csv.test.ts`:

```ts
import { parseCsv, applySundayRule } from "./kpi-ingest-csv.js";

describe("parseCsv", () => {
  it("mapea columnas conocidas y arma filas", () => {
    const csv = "Fecha,TRX,Activos DAU\n2026-07-20,12345,678\n2026-07-21,,700\n";
    const result = parseCsv(csv);
    expect(result.headerMapped).toBe(3);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({
      fecha: "2026-07-20",
      raw: { TRX: 12345, "Activos DAU": 678 },
      unmapped: [],
      illegible: [],
    });
    expect(result.rows[1].raw["TRX"]).toBeUndefined();
  });

  it("reconoce alias de columnas (Afiliaciones Nuevas, DAU, MAU)", () => {
    const csv = "Fecha,Afiliaciones Nuevas,DAU,MAU\n2026-07-20,50,678,9000\n";
    const result = parseCsv(csv);
    expect(result.rows[0].raw).toEqual({
      "Afiliaciones diarias": 50,
      "Activos DAU": 678,
      "Activos 30d": 9000,
    });
  });

  it("reporta columnas no mapeadas y valores ilegibles", () => {
    const csv = "Fecha,ColumnaRara,TRX\n2026-07-20,algo,N/D\n";
    const result = parseCsv(csv);
    expect(result.rows[0].unmapped).toEqual(["ColumnaRara"]);
    expect(result.rows[0].illegible).toEqual(["TRX"]);
  });

  it("detecta delimitador ; y parsea igual", () => {
    const csv = "Fecha;TRX\n2026-07-20;1.500\n";
    const result = parseCsv(csv);
    expect(result.rows[0].raw["TRX"]).toBe(1500);
  });

  it("ignora líneas vacías", () => {
    const csv = "Fecha,TRX\n2026-07-20,100\n\n2026-07-21,200\n";
    const result = parseCsv(csv);
    expect(result.rows).toHaveLength(2);
  });
});

describe("applySundayRule", () => {
  it("convierte Afiliaciones diarias=0 en null si la fecha es domingo", () => {
    const result = applySundayRule("2026-07-19", { "Afiliaciones diarias": 0, TRX: 100 });
    expect(result["Afiliaciones diarias"]).toBeNull();
    expect(result.TRX).toBe(100);
  });
  it("no toca el valor si no es domingo", () => {
    const result = applySundayRule("2026-07-20", { "Afiliaciones diarias": 0 });
    expect(result["Afiliaciones diarias"]).toBe(0);
  });
  it("no toca el valor si es domingo pero no es 0", () => {
    const result = applySundayRule("2026-07-19", { "Afiliaciones diarias": 5 });
    expect(result["Afiliaciones diarias"]).toBe(5);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npm run test -w @cos/daemon -- kpi-ingest-csv`
Expected: FAIL — `parseCsv is not a function` / `applySundayRule is not a function`

- [ ] **Step 3: Implementar `parseCsv` y `applySundayRule`**

Agregar a `daemon-v2/src/proactive/kpi-ingest-csv.ts`:

```ts
export interface ParsedCsvRow {
  fecha: string | null;
  raw: Record<string, number | null>;
  unmapped: string[];
  illegible: string[];
}

export interface ParseCsvResult {
  rows: ParsedCsvRow[];
  headerMapped: number;
}

const COLUMN_ALIASES: Record<string, string> = {
  "fecha": "Fecha",
  "afiliaciones diarias": "Afiliaciones diarias",
  "afiliaciones nuevas": "Afiliaciones diarias",
  "trx": "TRX",
  "transacciones": "TRX",
  "activos dau": "Activos DAU",
  "dau": "Activos DAU",
  "activos 30d": "Activos 30d",
  "mau": "Activos 30d",
  "stock afiliados": "Stock Afiliados",
  "saldo": "Saldo",
  "remesas (cantidad)": "Remesas (cantidad)",
  "remesas cantidad": "Remesas (cantidad)",
  "remesas (usd)": "Remesas (USD)",
  "remesas usd": "Remesas (USD)",
};

const DIACRITICS_RANGE_START = 0x0300;
const DIACRITICS_RANGE_END = 0x036f;

function normalizeHeaderName(h: string): string {
  const stripped = Array.from(h.normalize("NFD"))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < DIACRITICS_RANGE_START || code > DIACRITICS_RANGE_END;
    })
    .join("");
  return stripped.trim().toLowerCase();
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === delimiter && !inQuotes) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCsv(content: string): ParseCsvResult {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { rows: [], headerMapped: 0 };

  const delimiter = detectDelimiter(lines[0]);
  const headerCols = splitCsvLine(lines[0], delimiter);
  const mapped = headerCols.map((h) => COLUMN_ALIASES[normalizeHeaderName(h)] ?? null);
  const headerMapped = mapped.filter(Boolean).length;

  const rows: ParsedCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], delimiter);
    const raw: Record<string, number | null> = {};
    const unmapped: string[] = [];
    const illegible: string[] = [];
    let fecha: string | null = null;

    for (let c = 0; c < headerCols.length; c++) {
      const prop = mapped[c];
      const cellRaw = cols[c] ?? "";
      if (!prop) {
        if (cellRaw.trim() !== "") unmapped.push(headerCols[c]);
        continue;
      }
      if (prop === "Fecha") {
        fecha = normalizeDate(cellRaw);
        if (!fecha && cellRaw.trim() !== "") illegible.push("Fecha");
        continue;
      }
      if (cellRaw.trim() === "") continue;
      const num = parseNumber(cellRaw);
      if (num === null) illegible.push(prop);
      else raw[prop] = num;
    }

    rows.push({ fecha, raw, unmapped: [...new Set(unmapped)], illegible: [...new Set(illegible)] });
  }

  return { rows, headerMapped };
}

export function applySundayRule(fecha: string, raw: Record<string, number | null>): Record<string, number | null> {
  if (isSunday(fecha) && raw["Afiliaciones diarias"] === 0) {
    return { ...raw, "Afiliaciones diarias": null };
  }
  return raw;
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npm run test -w @cos/daemon -- kpi-ingest-csv`
Expected: PASS (todos los tests de este archivo)

- [ ] **Step 5: Stage (sin commit)**

```bash
git add daemon-v2/src/proactive/kpi-ingest-csv.ts daemon-v2/src/proactive/kpi-ingest-csv.test.ts
```

---

## Task 3: Gmail OAuth (`gmailAccessToken`) + búsqueda (`searchSelfServiceEmails`)

**Files:**
- Create: `daemon-v2/src/proactive/kpi-ingest-gmail.ts`
- Test: `daemon-v2/src/proactive/kpi-ingest-gmail.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `daemon-v2/src/proactive/kpi-ingest-gmail.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { gmailAccessToken, resetGmailTokenCache, searchSelfServiceEmails } from "./kpi-ingest-gmail.js";

const creds = { clientId: "cid", clientSecret: "csecret", refreshToken: "rtoken" };

afterEach(() => {
  resetGmailTokenCache();
  vi.clearAllMocks();
});

describe("gmailAccessToken", () => {
  it("intercambia el refresh token por un access token", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "atok", expires_in: 3600 }), { status: 200 }),
    ) as unknown as typeof fetch;

    const token = await gmailAccessToken(creds, fetchFn);

    expect(token).toBe("atok");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("cachea el token entre llamadas mientras no expiró", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "atok", expires_in: 3600 }), { status: 200 }),
    ) as unknown as typeof fetch;

    await gmailAccessToken(creds, fetchFn);
    await gmailAccessToken(creds, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("lanza si la respuesta no es ok", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(gmailAccessToken(creds, fetchFn)).rejects.toThrow("401");
  });

  it("lanza si la respuesta no trae access_token", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(gmailAccessToken(creds, fetchFn)).rejects.toThrow("access_token");
  });
});

describe("searchSelfServiceEmails", () => {
  it("devuelve los IDs de mensajes encontrados", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: "m1" }, { id: "m2" }] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await searchSelfServiceEmails("atok", fetchFn);

    expect(result).toEqual([{ id: "m1" }, { id: "m2" }]);
  });

  it("devuelve lista vacía si no hay mensajes", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    const result = await searchSelfServiceEmails("atok", fetchFn);
    expect(result).toEqual([]);
  });

  it("lanza si la API de Gmail devuelve error", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(searchSelfServiceEmails("atok", fetchFn)).rejects.toThrow("403");
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npm run test -w @cos/daemon -- kpi-ingest-gmail`
Expected: FAIL — `Cannot find module './kpi-ingest-gmail.js'`

- [ ] **Step 3: Implementar**

Crear `daemon-v2/src/proactive/kpi-ingest-gmail.ts`:

```ts
export interface GmailCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

export async function gmailAccessToken(creds: GmailCreds, fetchFn: typeof fetch = fetch): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`gmail token ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const d = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!d.access_token) throw new Error("gmail token: sin access_token en la respuesta");

  tokenCache = { token: d.access_token, expiresAt: Date.now() + ((d.expires_in ?? 3600) - 60) * 1000 };
  return d.access_token;
}

export function resetGmailTokenCache(): void {
  tokenCache = null;
}

const SEARCH_QUERY =
  "to:carlos@lepesqueur.net from:clepesqueur@bcp.com.bo subject:Self-Service has:attachment newer_than:3d";

export interface GmailMessageRef {
  id: string;
}

export async function searchSelfServiceEmails(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<GmailMessageRef[]> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", SEARCH_QUERY);
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`gmail search ${res.status}`);
  const d = (await res.json()) as { messages?: Array<{ id: string }> };
  return (d.messages ?? []).map((m) => ({ id: m.id }));
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npm run test -w @cos/daemon -- kpi-ingest-gmail`
Expected: PASS

- [ ] **Step 5: Stage (sin commit)**

```bash
git add daemon-v2/src/proactive/kpi-ingest-gmail.ts daemon-v2/src/proactive/kpi-ingest-gmail.test.ts
```

---

## Task 4: Detalle de mensaje, candidatos CSV y descarga de adjunto

**Files:**
- Modify: `daemon-v2/src/proactive/kpi-ingest-gmail.ts`
- Modify: `daemon-v2/src/proactive/kpi-ingest-gmail.test.ts`

- [ ] **Step 1: Agregar los tests que fallan**

Agregar a `daemon-v2/src/proactive/kpi-ingest-gmail.test.ts`:

```ts
import { getGmailMessage, findCsvCandidates, downloadGmailAttachment } from "./kpi-ingest-gmail.js";

describe("getGmailMessage", () => {
  it("extrae internalDate y attachments anidados en multipart", async () => {
    const payload = {
      id: "m1",
      internalDate: "1753185600000",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: {} }] },
          { filename: "kpis.csv", mimeType: "text/csv", body: { attachmentId: "att1" } },
        ],
      },
    };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;

    const detail = await getGmailMessage("m1", "atok", fetchFn);

    expect(detail.internalDate).toBe(1753185600000);
    expect(detail.attachments).toEqual([{ filename: "kpis.csv", mimeType: "text/csv", attachmentId: "att1" }]);
  });

  it("lanza si la API de Gmail devuelve error", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(getGmailMessage("m1", "atok", fetchFn)).rejects.toThrow("404");
  });
});

describe("findCsvCandidates", () => {
  it("filtra solo adjuntos .csv por filename", () => {
    const attachments = [
      { filename: "kpis.csv", mimeType: "text/csv", attachmentId: "a1" },
      { filename: "logo.png", mimeType: "image/png", attachmentId: "a2" },
    ];
    expect(findCsvCandidates(attachments)).toEqual([attachments[0]]);
  });

  it("devuelve lista vacía si no hay ningún .csv", () => {
    const attachments = [{ filename: "logo.png", mimeType: "image/png", attachmentId: "a2" }];
    expect(findCsvCandidates(attachments)).toEqual([]);
  });
});

describe("downloadGmailAttachment", () => {
  it("decodifica base64url a texto plano", async () => {
    const original = "Fecha,TRX\n2026-07-20,100\n";
    const b64url = Buffer.from(original).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: b64url }), { status: 200 })) as unknown as typeof fetch;

    const content = await downloadGmailAttachment("m1", "att1", "atok", fetchFn);

    expect(content).toBe(original);
  });

  it("lanza si no viene el campo data", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(downloadGmailAttachment("m1", "att1", "atok", fetchFn)).rejects.toThrow("data");
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npm run test -w @cos/daemon -- kpi-ingest-gmail`
Expected: FAIL — `getGmailMessage is not a function` / etc.

- [ ] **Step 3: Implementar**

Agregar a `daemon-v2/src/proactive/kpi-ingest-gmail.ts`:

```ts
export interface GmailAttachmentPart {
  filename: string;
  mimeType: string;
  attachmentId: string;
}

export interface GmailMessageDetail {
  id: string;
  internalDate: number;
  attachments: GmailAttachmentPart[];
}

interface GmailPart {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string };
  parts?: GmailPart[];
}

function collectAttachments(part: GmailPart, out: GmailAttachmentPart[]): void {
  if (part.filename && part.body?.attachmentId) {
    out.push({ filename: part.filename, mimeType: part.mimeType ?? "", attachmentId: part.body.attachmentId });
  }
  for (const p of part.parts ?? []) collectAttachments(p, out);
}

export async function getGmailMessage(
  messageId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<GmailMessageDetail> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`gmail get message ${res.status}`);
  const d = (await res.json()) as { id: string; internalDate: string; payload: GmailPart };
  const attachments: GmailAttachmentPart[] = [];
  collectAttachments(d.payload, attachments);
  return { id: d.id, internalDate: Number(d.internalDate), attachments };
}

export function findCsvCandidates(attachments: GmailAttachmentPart[]): GmailAttachmentPart[] {
  return attachments.filter((a) => a.filename.toLowerCase().endsWith(".csv"));
}

export async function downloadGmailAttachment(
  messageId: string,
  attachmentId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`;
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`gmail get attachment ${res.status}`);
  const d = (await res.json()) as { data?: string };
  if (!d.data) throw new Error("gmail attachment: sin campo data en la respuesta");
  const b64 = d.data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npm run test -w @cos/daemon -- kpi-ingest-gmail`
Expected: PASS

- [ ] **Step 5: Stage (sin commit)**

```bash
git add daemon-v2/src/proactive/kpi-ingest-gmail.ts daemon-v2/src/proactive/kpi-ingest-gmail.test.ts
```

---

## Task 5: Upsert de fila raw en Notion por Fecha

**Files:**
- Create: `daemon-v2/src/proactive/kpi-ingest-notion.ts`
- Test: `daemon-v2/src/proactive/kpi-ingest-notion.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `daemon-v2/src/proactive/kpi-ingest-notion.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { upsertKpiRow } from "./kpi-ingest-notion.js";

describe("upsertKpiRow", () => {
  it("crea una fila nueva si no existe la Fecha", async () => {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method: init?.method ?? "GET", url: String(url), body });
      if ((init?.method ?? "GET") === "POST" && String(url).includes("/query")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "new-page" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await upsertKpiRow("tok", "2026-07-20", { TRX: 1000, "Activos DAU": 500 }, fetchFn);

    expect(result).toEqual({ fecha: "2026-07-20", created: true, fieldsWritten: ["TRX", "Activos DAU"] });
    const createCall = calls.find((c) => c.url.endsWith("/v1/pages"));
    expect(createCall?.body.properties.TRX).toEqual({ number: 1000 });
    expect(createCall?.body.properties.Fecha).toEqual({ date: { start: "2026-07-20" } });
  });

  it("actualiza una fila existente con solo los campos raw provistos", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify({ results: [{ id: "existing-page", properties: {} }] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await upsertKpiRow("tok", "2026-07-20", { TRX: 2000 }, fetchFn);

    expect(result).toEqual({ fecha: "2026-07-20", created: false, fieldsWritten: ["TRX"] });
  });

  it("no llama a PATCH si no hay campos raw con valor", async () => {
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify({ results: [{ id: "existing-page", properties: {} }] }), { status: 200 });
      }
      throw new Error("no debería llamar a PATCH sin campos");
    }) as unknown as typeof fetch;

    const result = await upsertKpiRow("tok", "2026-07-20", { TRX: null }, fetchFn);

    expect(result.fieldsWritten).toEqual([]);
  });

  it("lanza si la query a Notion falla", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(upsertKpiRow("tok", "2026-07-20", { TRX: 1 }, fetchFn)).rejects.toThrow("401");
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npm run test -w @cos/daemon -- kpi-ingest-notion`
Expected: FAIL — `Cannot find module './kpi-ingest-notion.js'`

- [ ] **Step 3: Implementar**

Crear `daemon-v2/src/proactive/kpi-ingest-notion.ts`:

```ts
export const KPI_DB_ID = "d4996efa-4053-44cf-8149-c6aee5eba52a";

const RAW_PROPS = [
  "Afiliaciones diarias",
  "TRX",
  "Activos DAU",
  "Activos 30d",
  "Stock Afiliados",
  "Saldo",
  "Remesas (cantidad)",
  "Remesas (USD)",
] as const;

interface NotionPage {
  id: string;
  properties: Record<string, { number?: number | null; date?: { start: string } | null }>;
}

async function notionRequest(
  notionToken: string,
  method: string,
  path: string,
  body: unknown,
  fetchFn: typeof fetch,
): Promise<any> {
  const res = await fetchFn(`https://api.notion.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`notion ${method} ${path} -> ${res.status}`);
  return res.json();
}

export interface UpsertResult {
  fecha: string;
  created: boolean;
  fieldsWritten: string[];
}

export async function upsertKpiRow(
  notionToken: string,
  fecha: string,
  raw: Record<string, number | null | undefined>,
  fetchFn: typeof fetch = fetch,
): Promise<UpsertResult> {
  const queryRes = (await notionRequest(
    notionToken,
    "POST",
    `/v1/databases/${KPI_DB_ID}/query`,
    { page_size: 1, filter: { property: "Fecha", date: { equals: fecha } } },
    fetchFn,
  )) as { results: NotionPage[] };

  const properties: Record<string, unknown> = {};
  const fieldsWritten: string[] = [];
  for (const prop of RAW_PROPS) {
    const value = raw[prop];
    if (value === null || value === undefined) continue;
    properties[prop] = { number: value };
    fieldsWritten.push(prop);
  }

  const existing = queryRes.results[0];
  if (existing) {
    if (fieldsWritten.length > 0) {
      await notionRequest(notionToken, "PATCH", `/v1/pages/${existing.id}`, { properties }, fetchFn);
    }
    return { fecha, created: false, fieldsWritten };
  }

  properties["Fecha"] = { date: { start: fecha } };
  properties["Registro"] = { title: [{ text: { content: fecha } }] };
  await notionRequest(
    notionToken,
    "POST",
    "/v1/pages",
    { parent: { database_id: KPI_DB_ID }, properties },
    fetchFn,
  );
  return { fecha, created: true, fieldsWritten };
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npm run test -w @cos/daemon -- kpi-ingest-notion`
Expected: PASS

- [ ] **Step 5: Stage (sin commit)**

```bash
git add daemon-v2/src/proactive/kpi-ingest-notion.ts daemon-v2/src/proactive/kpi-ingest-notion.test.ts
```

---

## Task 6: Histórico de KPIs + fórmulas de derivados (funciones puras)

**Files:**
- Modify: `daemon-v2/src/proactive/kpi-ingest-notion.ts`
- Modify: `daemon-v2/src/proactive/kpi-ingest-notion.test.ts`

- [ ] **Step 1: Agregar los tests que fallan**

Agregar a `daemon-v2/src/proactive/kpi-ingest-notion.test.ts`:

```ts
import {
  fetchKpiHistory,
  computeAfiliados7d,
  computeTrxVsSemana,
  computeDauVsSemana,
  computeAfiliacionesVsSemana,
  type KpiHistoryRow,
} from "./kpi-ingest-notion.js";

function row(overrides: Partial<KpiHistoryRow>): KpiHistoryRow {
  return {
    id: "id",
    fecha: "2026-07-20",
    trx: null,
    activosDau: null,
    afiliacionesDiarias: null,
    afiliados7d: null,
    trxVsSemana: null,
    dauVsSemana: null,
    afiliacionesVsSemana: null,
    ...overrides,
  };
}

describe("fetchKpiHistory", () => {
  it("pagina hasta traer todas las filas ordenadas por Fecha", async () => {
    const page1 = {
      results: [{ id: "p1", properties: { Fecha: { date: { start: "2026-07-13" } }, TRX: { number: 1000 } } }],
      has_more: true,
      next_cursor: "cursor-1",
    };
    const page2 = {
      results: [{ id: "p2", properties: { Fecha: { date: { start: "2026-07-20" } }, TRX: { number: 1100 } } }],
      has_more: false,
      next_cursor: null,
    };
    let call = 0;
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(call++ === 0 ? page1 : page2), { status: 200 })) as unknown as typeof fetch;

    const rows = await fetchKpiHistory("tok", fetchFn);

    expect(rows).toHaveLength(2);
    expect(rows[0].fecha).toBe("2026-07-13");
    expect(rows[1].fecha).toBe("2026-07-20");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("ignora filas sin Fecha", async () => {
    const page = {
      results: [{ id: "p1", properties: {} }],
      has_more: false,
      next_cursor: null,
    };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(page), { status: 200 })) as unknown as typeof fetch;

    const rows = await fetchKpiHistory("tok", fetchFn);

    expect(rows).toEqual([]);
  });
});

describe("computeAfiliados7d", () => {
  const rows: KpiHistoryRow[] = [
    row({ fecha: "2026-07-13", afiliacionesDiarias: 10 }),
    row({ fecha: "2026-07-14", afiliacionesDiarias: 12 }),
    row({ fecha: "2026-07-15", afiliacionesDiarias: 8 }),
    row({ fecha: "2026-07-16", afiliacionesDiarias: 11 }),
    row({ fecha: "2026-07-17", afiliacionesDiarias: 9 }),
    row({ fecha: "2026-07-18", afiliacionesDiarias: 14 }),
    row({ fecha: "2026-07-19", afiliacionesDiarias: null }), // domingo, normal que esté vacío
    row({ fecha: "2026-07-20", afiliacionesDiarias: 13 }),
  ];

  it("promedia excluyendo domingos", () => {
    const result = computeAfiliados7d(rows, 7);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(11); // (10+12+8+11+9+14+13)/7
  });

  it("no calculable si falta un día no-domingo de la ventana", () => {
    const withGap = rows.map((r) => (r.fecha === "2026-07-15" ? row({ ...r, afiliacionesDiarias: null }) : r));
    const result = computeAfiliados7d(withGap, 7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("2026-07-15");
  });
});

describe("computeTrxVsSemana / computeDauVsSemana / computeAfiliacionesVsSemana", () => {
  const rows: KpiHistoryRow[] = [
    row({ fecha: "2026-07-13", trx: 1000, activosDau: 500, afiliacionesDiarias: 20 }),
    row({ fecha: "2026-07-20", trx: 1100, activosDau: 550, afiliacionesDiarias: 22 }),
  ];

  it("calcula la variación % vs. 7 días antes", () => {
    const result = computeTrxVsSemana(rows, 1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeCloseTo(0.1);
  });

  it("no calculable si no existe registro D-7", () => {
    const result = computeDauVsSemana([rows[1]], 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("D-7");
  });

  it("no calculable si D-7 es 0", () => {
    const withZero = [row({ fecha: "2026-07-13", afiliacionesDiarias: 0 }), rows[1]];
    const result = computeAfiliacionesVsSemana(withZero, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("0");
  });

  it("no calculable si falta el valor del día D", () => {
    const withMissing = [rows[0], row({ fecha: "2026-07-20", trx: null })];
    const result = computeTrxVsSemana(withMissing, 1);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npm run test -w @cos/daemon -- kpi-ingest-notion`
Expected: FAIL — `fetchKpiHistory is not a function` / etc.

- [ ] **Step 3: Implementar**

Agregar a `daemon-v2/src/proactive/kpi-ingest-notion.ts` (al inicio del archivo, agregar el import; el resto al final):

```ts
import { isSunday } from "./kpi-ingest-csv.js";
```

```ts
export interface KpiHistoryRow {
  id: string;
  fecha: string;
  trx: number | null;
  activosDau: number | null;
  afiliacionesDiarias: number | null;
  afiliados7d: number | null;
  trxVsSemana: number | null;
  dauVsSemana: number | null;
  afiliacionesVsSemana: number | null;
}

export async function fetchKpiHistory(notionToken: string, fetchFn: typeof fetch = fetch): Promise<KpiHistoryRow[]> {
  const rows: KpiHistoryRow[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = {
      page_size: 100,
      sorts: [{ property: "Fecha", direction: "ascending" }],
    };
    if (cursor) body.start_cursor = cursor;
    const res = (await notionRequest(notionToken, "POST", `/v1/databases/${KPI_DB_ID}/query`, body, fetchFn)) as {
      results: NotionPage[];
      has_more: boolean;
      next_cursor: string | null;
    };
    for (const p of res.results) {
      const props = p.properties;
      const fecha = props["Fecha"]?.date?.start;
      if (!fecha) continue;
      rows.push({
        id: p.id,
        fecha,
        trx: props["TRX"]?.number ?? null,
        activosDau: props["Activos DAU"]?.number ?? null,
        afiliacionesDiarias: props["Afiliaciones diarias"]?.number ?? null,
        afiliados7d: props["Afiliados 7d"]?.number ?? null,
        trxVsSemana: props["TRX vs. Sem. anterior (%)"]?.number ?? null,
        dauVsSemana: props["DAU vs. Sem. anterior (%)"]?.number ?? null,
        afiliacionesVsSemana: props["Afiliaciones vs. Sem. anterior (%)"]?.number ?? null,
      });
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  return rows;
}

export type DerivedOutcome = { ok: true; value: number } | { ok: false; reason: string };

function isoDaysBefore(fecha: string, days: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function computeAfiliados7d(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  const row = rows[index];
  let sum = 0;
  let count = 0;
  for (let offset = 0; offset <= 6; offset++) {
    const iso = isoDaysBefore(row.fecha, offset);
    if (isSunday(iso)) continue;
    const match = rows.find((r) => r.fecha === iso);
    if (!match || match.afiliacionesDiarias == null) {
      return { ok: false, reason: `falta Afiliaciones diarias el ${iso}` };
    }
    sum += match.afiliacionesDiarias;
    count++;
  }
  if (count === 0) return { ok: false, reason: "ventana de 7 días sin días hábiles" };
  return { ok: true, value: Math.round(sum / count) };
}

function computeVsSemanaAnterior(
  rows: KpiHistoryRow[],
  index: number,
  field: "trx" | "activosDau" | "afiliacionesDiarias",
): DerivedOutcome {
  const row = rows[index];
  const isoD7 = isoDaysBefore(row.fecha, 7);
  const rowD7 = rows.find((r) => r.fecha === isoD7);

  const valueD = row[field];
  if (valueD == null) return { ok: false, reason: `falta ${field} el ${row.fecha}` };
  if (!rowD7) return { ok: false, reason: `no existe registro D-7 (${isoD7})` };
  const valueD7 = rowD7[field];
  if (valueD7 == null) return { ok: false, reason: `falta ${field} el ${isoD7}` };
  if (valueD7 === 0) return { ok: false, reason: `${field} en D-7 (${isoD7}) es 0` };
  return { ok: true, value: valueD / valueD7 - 1 };
}

export function computeTrxVsSemana(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  return computeVsSemanaAnterior(rows, index, "trx");
}
export function computeDauVsSemana(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  return computeVsSemanaAnterior(rows, index, "activosDau");
}
export function computeAfiliacionesVsSemana(rows: KpiHistoryRow[], index: number): DerivedOutcome {
  return computeVsSemanaAnterior(rows, index, "afiliacionesDiarias");
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npm run test -w @cos/daemon -- kpi-ingest-notion`
Expected: PASS

- [ ] **Step 5: Stage (sin commit)**

```bash
git add daemon-v2/src/proactive/kpi-ingest-notion.ts daemon-v2/src/proactive/kpi-ingest-notion.test.ts
```

---

## Task 7: `fillDerivedFields` — orquesta el escaneo del histórico

**Files:**
- Modify: `daemon-v2/src/proactive/kpi-ingest-notion.ts`
- Modify: `daemon-v2/src/proactive/kpi-ingest-notion.test.ts`

- [ ] **Step 1: Agregar el test que falla**

Agregar a `daemon-v2/src/proactive/kpi-ingest-notion.test.ts`:

```ts
import { fillDerivedFields } from "./kpi-ingest-notion.js";

describe("fillDerivedFields", () => {
  it("completa solo los campos vacíos y reporta los no calculables", async () => {
    const historyResponse = {
      results: [
        {
          id: "p1",
          properties: {
            Fecha: { date: { start: "2026-07-13" } },
            TRX: { number: 1000 },
            "Activos DAU": { number: 500 },
            "Afiliaciones diarias": { number: 20 },
          },
        },
        {
          id: "p2",
          properties: {
            Fecha: { date: { start: "2026-07-20" } },
            TRX: { number: 1100 },
            "Activos DAU": { number: 550 },
            "Afiliaciones diarias": { number: 22 },
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    };
    const patchedProps: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify(historyResponse), { status: 200 });
      }
      const body = init?.body ? JSON.parse(init.body as string) : {};
      patchedProps.push(body.properties);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await fillDerivedFields("tok", fetchFn);

    expect(
      report.completados.some((c) => c.campo === "TRX vs. Sem. anterior (%)" && c.fecha === "2026-07-20"),
    ).toBe(true);
    expect(report.noCalculables.some((c) => c.fecha === "2026-07-13")).toBe(true);
    expect(patchedProps.some((p) => "TRX vs. Sem. anterior (%)" in p)).toBe(true);
  });

  it("no pisa un campo derivado que ya tiene valor", async () => {
    const historyResponse = {
      results: [
        {
          id: "p1",
          properties: {
            Fecha: { date: { start: "2026-07-13" } },
            "Afiliaciones diarias": { number: 20 },
          },
        },
        {
          id: "p2",
          properties: {
            Fecha: { date: { start: "2026-07-20" } },
            "Afiliaciones diarias": { number: 22 },
            "Afiliaciones vs. Sem. anterior (%)": { number: 0.5 },
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    };
    const patchedProps: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify(historyResponse), { status: 200 });
      }
      const body = init?.body ? JSON.parse(init.body as string) : {};
      patchedProps.push(body.properties);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await fillDerivedFields("tok", fetchFn);

    expect(report.completados.some((c) => c.campo === "Afiliaciones vs. Sem. anterior (%)")).toBe(false);
    expect(patchedProps.some((p) => "Afiliaciones vs. Sem. anterior (%)" in p)).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npm run test -w @cos/daemon -- kpi-ingest-notion`
Expected: FAIL — `fillDerivedFields is not a function`

- [ ] **Step 3: Implementar**

Agregar al final de `daemon-v2/src/proactive/kpi-ingest-notion.ts`:

```ts
export interface DerivedFillReport {
  completados: Array<{ fecha: string; campo: string; valor: number }>;
  noCalculables: Array<{ fecha: string; campo: string; motivo: string }>;
}

interface DerivedSpec {
  campo: string;
  notionProp: string;
  getExisting: (r: KpiHistoryRow) => number | null;
  compute: (rows: KpiHistoryRow[], index: number) => DerivedOutcome;
}

const DERIVED_SPECS: DerivedSpec[] = [
  { campo: "Afiliados 7d", notionProp: "Afiliados 7d", getExisting: (r) => r.afiliados7d, compute: computeAfiliados7d },
  {
    campo: "TRX vs. Sem. anterior (%)",
    notionProp: "TRX vs. Sem. anterior (%)",
    getExisting: (r) => r.trxVsSemana,
    compute: computeTrxVsSemana,
  },
  {
    campo: "DAU vs. Sem. anterior (%)",
    notionProp: "DAU vs. Sem. anterior (%)",
    getExisting: (r) => r.dauVsSemana,
    compute: computeDauVsSemana,
  },
  {
    campo: "Afiliaciones vs. Sem. anterior (%)",
    notionProp: "Afiliaciones vs. Sem. anterior (%)",
    getExisting: (r) => r.afiliacionesVsSemana,
    compute: computeAfiliacionesVsSemana,
  },
];

export async function fillDerivedFields(notionToken: string, fetchFn: typeof fetch = fetch): Promise<DerivedFillReport> {
  const rows = await fetchKpiHistory(notionToken, fetchFn);
  const report: DerivedFillReport = { completados: [], noCalculables: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (const spec of DERIVED_SPECS) {
      if (spec.getExisting(row) != null) continue;
      const outcome = spec.compute(rows, i);
      if (!outcome.ok) {
        report.noCalculables.push({ fecha: row.fecha, campo: spec.campo, motivo: outcome.reason });
        continue;
      }
      await notionRequest(
        notionToken,
        "PATCH",
        `/v1/pages/${row.id}`,
        { properties: { [spec.notionProp]: { number: outcome.value } } },
        fetchFn,
      );
      report.completados.push({ fecha: row.fecha, campo: spec.campo, valor: outcome.value });
    }
  }

  return report;
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npm run test -w @cos/daemon -- kpi-ingest-notion`
Expected: PASS

- [ ] **Step 5: Stage (sin commit)**

```bash
git add daemon-v2/src/proactive/kpi-ingest-notion.ts daemon-v2/src/proactive/kpi-ingest-notion.test.ts
```

---

## Task 8: Estado local + formateo del reporte de Telegram (funciones puras)

**Files:**
- Create: `daemon-v2/src/proactive/kpi-ingest-check.ts`
- Test: `daemon-v2/src/proactive/kpi-ingest-check.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `daemon-v2/src/proactive/kpi-ingest-check.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatSuccessReport } from "./kpi-ingest-check.js";

describe("formatSuccessReport", () => {
  it("arma el texto con ingesta y derivados completados", () => {
    const text = formatSuccessReport(
      ["2026-07-20: actualizado (TRX, Activos DAU)"],
      {
        completados: [{ fecha: "2026-07-20", campo: "Afiliados 7d", valor: 120 }],
        noCalculables: [{ fecha: "2026-07-13", campo: "TRX vs. Sem. anterior (%)", motivo: "no existe registro D-7 (2026-07-06)" }],
      },
    );

    expect(text).toContain("2026-07-20: actualizado (TRX, Activos DAU)");
    expect(text).toContain("Afiliados 7d → 120");
    expect(text).toContain("no calculable (no existe registro D-7 (2026-07-06))");
  });

  it("muestra un texto por default si no hay ingesta ni derivados", () => {
    const text = formatSuccessReport([], { completados: [], noCalculables: [] });
    expect(text).toContain("sin filas con Fecha válida");
    expect(text).toContain("nada pendiente");
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npm run test -w @cos/daemon -- kpi-ingest-check`
Expected: FAIL — `Cannot find module './kpi-ingest-check.js'`

- [ ] **Step 3: Implementar el estado local y el formateo**

Crear `daemon-v2/src/proactive/kpi-ingest-check.ts`:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import type { DerivedFillReport } from "./kpi-ingest-notion.js";

const WAIT_MS = 15 * 60 * 1000;
const ERROR_DEDUP_MS = 2 * 60 * 60 * 1000;
const MAX_PROCESSED = 200;

export interface KpiIngestState {
  processed: string[];
  pending: Record<string, { receivedAt: number }>;
  lastErrorNotified: Record<string, number>;
}

export function defaultStatePath(): string {
  return `${process.env.HOME}/.cos-agent/kpi-ingest-state.json`;
}

export function readState(path: string): KpiIngestState {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as KpiIngestState;
  } catch {
    return { processed: [], pending: {}, lastErrorNotified: {} };
  }
}

export function writeState(path: string, state: KpiIngestState): void {
  try {
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch {
    /* noop */
  }
}

export function formatSuccessReport(ingestSummary: string[], derived: DerivedFillReport): string {
  const lines: string[] = ["✅ <b>KPIs diarios actualizados</b> (Self-Service)", "", "<b>Ingesta:</b>"];
  lines.push(...(ingestSummary.length ? ingestSummary.map((s) => `• ${s}`) : ["• sin filas con Fecha válida"]));
  lines.push("", "<b>Derivados:</b>");
  const derivedLines = [
    ...derived.completados.map((c) => `• ${c.fecha} → ${c.campo} → ${c.valor}`),
    ...derived.noCalculables.map((c) => `• ${c.fecha} → ${c.campo} → no calculable (${c.motivo})`),
  ];
  lines.push(...(derivedLines.length ? derivedLines : ["• nada pendiente"]));
  return lines.join("\n");
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npm run test -w @cos/daemon -- kpi-ingest-check`
Expected: PASS

- [ ] **Step 5: Stage (sin commit)**

```bash
git add daemon-v2/src/proactive/kpi-ingest-check.ts daemon-v2/src/proactive/kpi-ingest-check.test.ts
```

---

## Task 9: `checkKpiIngest` — orquestador completo

**Files:**
- Modify: `daemon-v2/src/proactive/kpi-ingest-check.ts`
- Modify: `daemon-v2/src/proactive/kpi-ingest-check.test.ts`

- [ ] **Step 1: Agregar los tests que fallan**

Agregar a `daemon-v2/src/proactive/kpi-ingest-check.test.ts`:

```ts
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, beforeEach, afterEach } from "vitest";

vi.mock("./kpi-ingest-gmail.js", () => ({
  gmailAccessToken: vi.fn(async () => "atok"),
  searchSelfServiceEmails: vi.fn(),
  getGmailMessage: vi.fn(),
  findCsvCandidates: vi.fn(),
  downloadGmailAttachment: vi.fn(),
}));
vi.mock("./kpi-ingest-notion.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, upsertKpiRow: vi.fn(), fillDerivedFields: vi.fn() };
});
vi.mock("@cos/shared", () => ({ sendMessage: vi.fn(async () => ({ message_id: 1 })) }));

import {
  gmailAccessToken,
  searchSelfServiceEmails,
  getGmailMessage,
  findCsvCandidates,
  downloadGmailAttachment,
} from "./kpi-ingest-gmail.js";
import { upsertKpiRow, fillDerivedFields } from "./kpi-ingest-notion.js";
import { sendMessage } from "@cos/shared";
import { checkKpiIngest } from "./kpi-ingest-check.js";

const gmailCreds = { clientId: "c", clientSecret: "s", refreshToken: "r" };
let tmpDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kpi-ingest-test-"));
  statePath = join(tmpDir, "state.json");
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkKpiIngest", () => {
  it("agrega un mensaje nuevo a pending sin procesarlo todavía", async () => {
    vi.mocked(searchSelfServiceEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({ id: "m1", internalDate: Date.now(), attachments: [] });

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(upsertKpiRow).not.toHaveBeenCalled();
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.pending.m1).toBeDefined();
  });

  it("procesa un mensaje pending que ya pasó los 15 minutos", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchSelfServiceEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({
      id: "m1",
      internalDate: oldTimestamp,
      attachments: [{ filename: "kpis.csv", mimeType: "text/csv", attachmentId: "a1" }],
    });
    vi.mocked(findCsvCandidates).mockReturnValue([{ filename: "kpis.csv", mimeType: "text/csv", attachmentId: "a1" }]);
    vi.mocked(downloadGmailAttachment).mockResolvedValue("Fecha,TRX\n2026-07-20,100\n");
    vi.mocked(upsertKpiRow).mockResolvedValue({ fecha: "2026-07-20", created: true, fieldsWritten: ["TRX"] });
    vi.mocked(fillDerivedFields).mockResolvedValue({ completados: [], noCalculables: [] });

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(upsertKpiRow).toHaveBeenCalledWith("n", "2026-07-20", expect.objectContaining({ TRX: 100 }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
    expect(state.pending.m1).toBeUndefined();
  });

  it("no reprocesa un mensaje ya marcado como processed", async () => {
    writeFileSync(statePath, JSON.stringify({ processed: ["m1"], pending: {}, lastErrorNotified: {} }));
    vi.mocked(searchSelfServiceEmails).mockResolvedValue([{ id: "m1" }]);

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(getGmailMessage).not.toHaveBeenCalled();
  });

  it("reporta y marca processed si no hay CSV adjunto", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], pending: { m1: { receivedAt: oldTimestamp } }, lastErrorNotified: {} }),
    );
    vi.mocked(searchSelfServiceEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockResolvedValue({ id: "m1", internalDate: oldTimestamp, attachments: [] });
    vi.mocked(findCsvCandidates).mockReturnValue([]);

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendMessage).mock.calls[0]?.[1] as { text: string };
    expect(call.text).toContain("sin ningún CSV");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.processed).toContain("m1");
  });

  it("dedupea la notificación de error del mismo mensaje dentro de 2 horas", async () => {
    const oldTimestamp = Date.now() - 16 * 60 * 1000;
    const recentError = Date.now() - 30 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({
        processed: [],
        pending: { m1: { receivedAt: oldTimestamp } },
        lastErrorNotified: { m1: recentError },
      }),
    );
    vi.mocked(searchSelfServiceEmails).mockResolvedValue([{ id: "m1" }]);
    vi.mocked(getGmailMessage).mockRejectedValue(new Error("gmail caído"));

    await checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("no rompe el poll completo si falla la búsqueda en Gmail", async () => {
    vi.mocked(gmailAccessToken).mockRejectedValueOnce(new Error("token inválido"));

    await expect(
      checkKpiIngest({ botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, statePath }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npm run test -w @cos/daemon -- kpi-ingest-check`
Expected: FAIL — `checkKpiIngest is not a function`

- [ ] **Step 3: Implementar el orquestador**

Agregar a `daemon-v2/src/proactive/kpi-ingest-check.ts` (agregar imports al inicio del archivo y el resto al final):

```ts
import { sendMessage } from "@cos/shared";
import {
  gmailAccessToken,
  searchSelfServiceEmails,
  getGmailMessage,
  findCsvCandidates,
  downloadGmailAttachment,
  type GmailCreds,
} from "./kpi-ingest-gmail.js";
import { parseCsv, applySundayRule } from "./kpi-ingest-csv.js";
import { upsertKpiRow, fillDerivedFields } from "./kpi-ingest-notion.js";
```

```ts
export interface CheckKpiIngestOpts {
  botToken: string;
  chatId: number;
  notionToken: string;
  gmail: GmailCreds;
  /** Override para tests — default: `~/.cos-agent/kpi-ingest-state.json`. */
  statePath?: string;
}

export async function checkKpiIngest(opts: CheckKpiIngestOpts): Promise<void> {
  const statePath = opts.statePath ?? defaultStatePath();
  const state = readState(statePath);

  let messageIds: string[];
  try {
    const token = await gmailAccessToken(opts.gmail);
    const found = await searchSelfServiceEmails(token);
    messageIds = found.map((m) => m.id);
  } catch (err) {
    console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_search_error", err: String(err) }));
    return;
  }

  for (const id of messageIds) {
    if (state.processed.includes(id)) continue;

    if (!state.pending[id]) {
      try {
        const token = await gmailAccessToken(opts.gmail);
        const detail = await getGmailMessage(id, token);
        state.pending[id] = { receivedAt: detail.internalDate };
        writeState(statePath, state);
      } catch (err) {
        console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_metadata_error", id, err: String(err) }));
      }
      continue;
    }

    if (Date.now() - state.pending[id].receivedAt < WAIT_MS) continue;

    await processMessage(id, state, opts);
    writeState(statePath, state);
  }

  if (state.processed.length > MAX_PROCESSED) {
    state.processed = state.processed.slice(-MAX_PROCESSED);
    writeState(statePath, state);
  }
}

async function processMessage(id: string, state: KpiIngestState, opts: CheckKpiIngestOpts): Promise<void> {
  const { botToken, chatId, notionToken, gmail } = opts;
  try {
    const token = await gmailAccessToken(gmail);
    const detail = await getGmailMessage(id, token);
    const candidates = findCsvCandidates(detail.attachments);

    if (candidates.length === 0) {
      await sendReport(botToken, chatId, "⚠️ Llegó el mail de Self-Service pero no tiene ningún CSV adjunto.");
      markProcessed(state, id);
      return;
    }

    let best: { headerMapped: number; rows: ReturnType<typeof parseCsv>["rows"] } | null = null;
    for (const candidate of candidates) {
      const content = await downloadGmailAttachment(id, candidate.attachmentId, token);
      const parsed = parseCsv(content);
      if (!best || parsed.headerMapped > best.headerMapped) best = parsed;
    }

    const ingestSummary: string[] = [];
    for (const row of best!.rows) {
      if (!row.fecha) continue;
      const raw = applySundayRule(row.fecha, row.raw);
      const result = await upsertKpiRow(notionToken, row.fecha, raw);
      const extras = [
        row.unmapped.length ? `no mapeadas: ${row.unmapped.join(", ")}` : "",
        row.illegible.length ? `ilegibles: ${row.illegible.join(", ")}` : "",
      ].filter(Boolean);
      ingestSummary.push(
        `${result.fecha}: ${result.created ? "creado" : "actualizado"} (${result.fieldsWritten.join(", ") || "sin campos"})` +
          (extras.length ? ` · ${extras.join(" · ")}` : ""),
      );
    }

    const derived = await fillDerivedFields(notionToken);
    await sendReport(botToken, chatId, formatSuccessReport(ingestSummary, derived));
    markProcessed(state, id);
  } catch (err) {
    const now = Date.now();
    const last = state.lastErrorNotified[id] ?? 0;
    if (now - last >= ERROR_DEDUP_MS) {
      await sendReport(botToken, chatId, `⚠️ Falló la ingesta de KPIs desde el mail de Self-Service: ${String(err)}`);
      state.lastErrorNotified[id] = now;
    }
    console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_process_error", id, err: String(err) }));
  }
}

function markProcessed(state: KpiIngestState, id: string): void {
  state.processed.push(id);
  delete state.pending[id];
  delete state.lastErrorNotified[id];
}

async function sendReport(botToken: string, chatId: number, text: string): Promise<void> {
  try {
    await sendMessage(botToken, { chatId, text, parseMode: "HTML" });
  } catch (err) {
    console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_ingest_report_send_failed", err: String(err) }));
  }
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npm run test -w @cos/daemon -- kpi-ingest-check`
Expected: PASS (los 3 archivos de test del feature: `kpi-ingest-csv`, `kpi-ingest-gmail`, `kpi-ingest-notion`, `kpi-ingest-check`)

Run también la suite completa para confirmar que no rompió nada existente: `npm run test -w @cos/daemon`
Expected: PASS

- [ ] **Step 5: Stage (sin commit)**

```bash
git add daemon-v2/src/proactive/kpi-ingest-check.ts daemon-v2/src/proactive/kpi-ingest-check.test.ts
```

---

## Task 10: Wiring en `index.ts` — env vars + cron condicional

**Files:**
- Modify: `daemon-v2/src/index.ts`

- [ ] **Step 1: Agregar el import**

En `daemon-v2/src/index.ts`, junto al import de `checkKpiCardDaily` (línea ~25):

```ts
import { checkKpiCardDaily } from "./proactive/kpi-card-daily.js";
import { checkKpiIngest } from "./proactive/kpi-ingest-check.js";
```

- [ ] **Step 2: Agregar las env vars (opcionales — no crashean el daemon si faltan)**

En el objeto `env` de `daemon-v2/src/index.ts`, junto a `HEALTH_API_KEY` (línea ~49):

```ts
  HEALTH_API_KEY: process.env.HEALTH_API_KEY ?? "",
  GMAIL_OAUTH_CLIENT_ID: process.env.GMAIL_OAUTH_CLIENT_ID ?? "",
  GMAIL_OAUTH_CLIENT_SECRET: process.env.GMAIL_OAUTH_CLIENT_SECRET ?? "",
  GMAIL_OAUTH_REFRESH_TOKEN: process.env.GMAIL_OAUTH_REFRESH_TOKEN ?? "",
```

- [ ] **Step 3: Agregar la función de scheduling**

En `daemon-v2/src/index.ts`, junto a `scheduleKpiCardDaily()` (línea ~1046):

```ts
function scheduleKpiIngestCheck(): void {
  cron.schedule("*/15 6-23 * * *", () => {
    void checkKpiIngest({
      botToken: env.COS_TELEGRAM_BOT_TOKEN,
      chatId: ALERT_CHAT_ID,
      notionToken: env.NOTION_TOKEN,
      gmail: {
        clientId: env.GMAIL_OAUTH_CLIENT_ID,
        clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET,
        refreshToken: env.GMAIL_OAUTH_REFRESH_TOKEN,
      },
    }).catch((err) => log({ msg: "kpi_ingest_check_unhandled_error", err: String(err) }));
  }, { timezone: "America/La_Paz" });
  log({ msg: "kpi_ingest_check_scheduled", interval: "every 15min 6-23h" });
}
```

- [ ] **Step 4: Registrar el cron condicionado a que existan las credenciales**

En `daemon-v2/src/index.ts`, junto al llamado a `scheduleKpiCardDaily()` (línea ~1104):

```ts
  scheduleKpiCardDaily();
  // Ingesta de KPIs Yape desde el mail de Self-Service de BCP (2026-07-22, pedido de Cal, ver
  // docs/superpowers/specs/2026-07-22-kpi-ingest-email-notion-design.md). Requiere que Cal haya
  // corrido `gcloud auth application-default login --scopes=...gmail.readonly` y cargado las 3
  // env vars GMAIL_OAUTH_* — si no están, el cron queda sin registrar (no rompe el arranque).
  if (env.GMAIL_OAUTH_REFRESH_TOKEN) {
    scheduleKpiIngestCheck();
  } else {
    log({ msg: "kpi_ingest_check_skipped_no_credentials" });
  }
```

- [ ] **Step 5: Typecheck y build**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores

Run: `npm -w @cos/shared run build && npm -w @cos/daemon run build`
Expected: build exitoso

- [ ] **Step 6: Stage (sin commit)**

```bash
git add daemon-v2/src/index.ts
```

---

## Task 11: Documentar en `CLAUDE.md` de Jano

**Files:**
- Modify: `CLAUDE.md` (raíz del repo Jano)

- [ ] **Step 1: Agregar el cron nuevo a la lista de crons internos activos**

En la sección `## Automatización — dos capas`, dentro de la lista de crons internos del daemon (después de la entrada de `scheduleKpiCardDaily()`), agregar:

```markdown
- `scheduleKpiIngestCheck()` — **ACTIVO 2026-07-22** (pedido de Cal, ver
  `docs/superpowers/specs/2026-07-22-kpi-ingest-email-notion-design.md`). Cron `*/15 6-23 * * *`,
  mecánico (sin agente SDK) — detecta el mail diario de BCP ("Self-Service", CSV adjunto),
  espera 15 min desde que llega, hace upsert de los KPIs raw por Fecha en "KPIs diarios" y
  completa los 4 campos derivados documentados (Afiliados 7d, TRX/DAU/Afiliaciones vs. Sem.
  anterior %) en todo el histórico. Usa Gmail vía OAuth propio (`GMAIL_OAUTH_CLIENT_ID/SECRET/
  REFRESH_TOKEN`, generado con `gcloud auth application-default login --scopes=...gmail.readonly`,
  scope solo lectura — el MCP de Gmail heredado vía OAuth Max no puede descargar attachments).
  Si las credenciales no están configuradas, el cron queda sin registrar al arrancar (no rompe
  el daemon). No marca leído ni archiva el mail (decisión explícita, ver el spec). No vive en
  Yapito — el trigger es el Gmail personal de Cal, que solo Jano tiene conectado.
```

- [ ] **Step 2: Actualizar el resumen de estado**

En la línea de "Estado real (actualizado...)" al final de la sección de Automatización, actualizar la fecha y el conteo de proactivos activos para incluir este nuevo cron.

- [ ] **Step 3: Stage (sin commit)**

```bash
git add CLAUDE.md
```

---

## Task 12: Verificación manual y cierre

- [ ] **Step 1: Correr toda la suite de tests del daemon**

Run: `npm run test -w @cos/daemon`
Expected: PASS (incluye los 4 archivos nuevos + toda la suite existente sin regresiones)

- [ ] **Step 2: Typecheck completo**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores

- [ ] **Step 3: Confirmar que el daemon arranca sin las credenciales de Gmail configuradas**

Sin `GMAIL_OAUTH_*` en `~/.cos-agent/.env`, correr `npm run dev -w @cos/daemon` (o el comando de dev habitual) y confirmar en el log de arranque la línea `kpi_ingest_check_skipped_no_credentials` — el resto del daemon debe arrancar normal.

- [ ] **Step 4: Pendiente para Cal — no bloquea el cierre de este plan**

Recordarle a Cal que, cuando esté en su Mac, corra:

```bash
gcloud auth application-default login \
  --scopes="openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/gmail.readonly"
```

y pase `client_id`/`client_secret`/`refresh_token` de
`~/.config/gcloud/application_default_credentials.json` para cargarlos en
`~/.cos-agent/.env` como `GMAIL_OAUTH_CLIENT_ID`/`GMAIL_OAUTH_CLIENT_SECRET`/
`GMAIL_OAUTH_REFRESH_TOKEN`. Recién ahí:
- Reiniciar el daemon (`launchctl bootout` + `bootstrap` de `com.cal.cos-agent-v2`).
- Confirmar en los logs que aparece `kpi_ingest_check_scheduled` en vez de `..._skipped_no_credentials`.
- Esperar al próximo mail real de Self-Service para validar el ciclo completo end-to-end.

- [ ] **Step 5: Preguntarle a Cal si quiere que se genere el commit**

Todas las tareas anteriores dejaron los cambios **staged pero sin commitear** (política del
repo). Antes de cerrar, preguntarle a Cal si quiere el commit ahora (y con qué mensaje) o si
prefiere revisarlo primero con `git diff --staged`.
