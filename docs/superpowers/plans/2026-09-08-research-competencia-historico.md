# Histórico acumulado de posts (D1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un archivo histórico de posts en D1 al research de competencia, con dedupe por URL para no re-pagar visión/transcripción de posts ya vistos, y un bloque de contexto agregado (tendencias) para el agente LLM semanal.

**Architecture:** Un cliente D1 puro (`research-competencia-d1.ts`) que hace `fetch` directo a la REST API de Cloudflare (sin Worker, sin wrangler). Una capa de dominio (`research-competencia-history.ts`) construida sobre ese cliente: dedupe por URL, inserción, agregación. `research-competencia-social.ts` consulta el histórico antes de enriquecer cada post; `research-competencia-agent.ts` recibe un bloque de tendencias agregadas en el prompt. Todo fail-soft: si D1 no responde, el research sigue funcionando exactamente igual que hoy.

**Tech Stack:** TypeScript, Node `fetch` nativo, Vitest, Cloudflare D1 (REST API), 1Password CLI (`op`) para el token nuevo.

**Referencia:** spec completo en `docs/superpowers/specs/2026-09-08-research-competencia-historico-design.md`. Este plan cubre la infraestructura D1 + el flujo semanal ajustado (secciones "Arquitectura", "Modelo de datos", "Flujo semanal ajustado" del spec) — el backfill inicial de 6 meses (sección "Backfill inicial") es un plan separado, posterior a que esto esté validado en producción.

---

## Provisioning manual previo (Cal, antes de la Task 2)

Esto no es código — es una acción única en el dashboard de Cloudflare que solo Cal puede hacer (crear un token de API es una operación de cuenta, no algo que un script pueda hacer por sí mismo):

1. Ir a `dash.cloudflare.com` → My Profile → API Tokens → Create Custom Token.
2. Nombre: `research-competencia-d1`. Permisos: **Account → D1 → Edit**. Scope: la cuenta de Cal (la misma donde ya viven los otros Workers/D1 del workspace).
3. Copiar el token generado.
4. Guardarlo en 1Password, vault `Daemons`, ítem nuevo `Research Competencia D1`, campo `credential` — vía `op item create --vault Daemons --category "API Credential" --title "Research Competencia D1" credential=<token pegado desde el propio dashboard, nunca en el chat>` (regla dura del repo: ningún secreto se pega en la conversación).

Task 3 de este plan (el script de setup) depende de que este ítem ya exista.

---

### Task 1: Cliente D1

**Files:**
- Create: `daemon-v2/src/tools/research-competencia-d1.ts`
- Test: `daemon-v2/src/tools/research-competencia-d1.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
// daemon-v2/src/tools/research-competencia-d1.test.ts
import { describe, it, expect, vi } from "vitest";
import { queryD1 } from "./research-competencia-d1.js";

function deps(overrides: Partial<Parameters<typeof queryD1>[2]> = {}) {
  return {
    accountId: "acc123",
    databaseId: "db456",
    token: "tok789",
    fetchFn: vi.fn(),
    ...overrides,
  };
}

describe("queryD1", () => {
  it("hace POST al endpoint correcto con Authorization Bearer y el sql/params en el body", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: [{ success: true, results: [{ id: 1 }] }] }),
    });
    const rows = await queryD1("SELECT * FROM posts WHERE url = ?", ["https://x.com/1"], deps({ fetchFn }));
    expect(rows).toEqual([{ id: 1 }]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/acc123/d1/database/db456/query",
      {
        method: "POST",
        headers: { Authorization: "Bearer tok789", "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT * FROM posts WHERE url = ?", params: ["https://x.com/1"] }),
      },
    );
  });

  it("devuelve null si falta accountId/databaseId/token, sin llamar a fetch", async () => {
    const fetchFn = vi.fn();
    const rows = await queryD1("SELECT 1", [], { fetchFn, accountId: undefined, databaseId: "db", token: "t" });
    expect(rows).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("devuelve null si la respuesta HTTP no es ok, sin tirar", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const rows = await queryD1("SELECT 1", [], deps({ fetchFn }));
    expect(rows).toBeNull();
  });

  it("devuelve null si la respuesta trae success:false", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, errors: [{ code: 7500, message: "boom" }] }),
    });
    const rows = await queryD1("SELECT 1", [], deps({ fetchFn }));
    expect(rows).toBeNull();
  });

  it("devuelve null si fetch tira (red caída), sin propagar la excepción", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const rows = await queryD1("SELECT 1", [], deps({ fetchFn }));
    expect(rows).toBeNull();
  });

  it("usa params vacío por default si no se pasa", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: [{ success: true, results: [] }] }),
    });
    await queryD1("SELECT 1", undefined as unknown as unknown[], deps({ fetchFn }));
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.params).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr los tests, confirmar que fallan**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-d1.test.ts`
Expected: FAIL — `Cannot find module './research-competencia-d1.js'`

- [ ] **Step 3: Implementar `research-competencia-d1.ts`**

```typescript
// daemon-v2/src/tools/research-competencia-d1.ts
// Cliente D1 vía REST API de Cloudflare directa — sin Worker, sin wrangler, sin binding.
// research-competencia-now.ts corre standalone en Node local, así que hace el mismo fetch que
// ya hace contra Google Ads Transparency Center / Meta Ad Library (research-competencia-ads.ts).
// Fail-soft en todo el archivo: D1 es una capa ADICIONAL sobre el research (histórico de posts,
// dedupe), nunca bloqueante — mismo criterio que Apify/Google Ads (research-competencia-apify.ts).

export interface D1QueryDeps {
  fetchFn?: typeof fetch;
  accountId?: string;
  databaseId?: string;
  token?: string;
}

interface D1ApiResponse {
  success: boolean;
  result?: Array<{ success: boolean; results: Record<string, unknown>[] }>;
  errors?: unknown[];
}

/**
 * Ejecuta una query SQL contra la D1 database de research-competencia. Devuelve las filas del
 * primer statement, o `null` ante cualquier problema (config faltante, HTTP no-ok, `success:false`,
 * red caída) — nunca tira. `params` son SOLO posicionales (`?`) — D1 no soporta params nombrados
 * (verificado contra la doc oficial, 2026-09-08).
 */
export async function queryD1(
  sql: string,
  params: unknown[] = [],
  deps: D1QueryDeps = {},
): Promise<Record<string, unknown>[] | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const accountId = deps.accountId ?? process.env.CF_ACCOUNT_ID;
  const databaseId = deps.databaseId ?? process.env.D1_RESEARCH_COMPETENCIA_DATABASE_ID;
  const token = deps.token ?? process.env.CF_API_TOKEN_D1_RESEARCH_COMPETENCIA;
  if (!accountId || !databaseId || !token) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_d1_missing_config" }));
    return null;
  }
  try {
    const res = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params }),
      },
    );
    if (!res.ok) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_d1_http_error", status: res.status }));
      return null;
    }
    const data = (await res.json()) as D1ApiResponse;
    if (!data.success || !data.result?.[0]) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_d1_query_error", errors: data.errors }));
      return null;
    }
    return data.result[0].results;
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_d1_fetch_error", err: String(err) }));
    return null;
  }
}
```

- [ ] **Step 4: Correr los tests, confirmar que pasan**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-d1.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/research-competencia-d1.ts daemon-v2/src/tools/research-competencia-d1.test.ts
git commit -m "feat(research-competencia): cliente D1 vía REST API de Cloudflare"
```

---

### Task 2: Resolver del token D1 desde 1Password

**Files:**
- Create: `daemon-v2/scripts/research-competencia-cf-token.ts`
- Test: `daemon-v2/scripts/research-competencia-cf-token.test.ts`

Mismo patrón exacto que `research-competencia-apify-token.ts` (mismo Service Account de solo lectura, mismo mecanismo de `op read` puntual) — solo cambia la referencia de 1Password.

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
// daemon-v2/scripts/research-competencia-cf-token.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveD1Token } from "./research-competencia-cf-token.js";

describe("resolveD1Token", () => {
  it("devuelve el token leído de 1Password vía el Service Account", () => {
    const readTokenFile = vi.fn().mockReturnValue("sa-token-abc");
    const readFromOnePassword = vi.fn().mockReturnValue("cf-d1-token-xyz");
    const token = resolveD1Token({ readTokenFile, readFromOnePassword });
    expect(token).toBe("cf-d1-token-xyz");
    expect(readFromOnePassword).toHaveBeenCalledWith("sa-token-abc");
  });

  it("devuelve null si el archivo del Service Account está vacío, sin tirar", () => {
    const readTokenFile = vi.fn().mockReturnValue("");
    const readFromOnePassword = vi.fn();
    const token = resolveD1Token({ readTokenFile, readFromOnePassword });
    expect(token).toBeNull();
    expect(readFromOnePassword).not.toHaveBeenCalled();
  });

  it("devuelve null si op read tira (vault inaccesible, op no instalado), sin tirar", () => {
    const readTokenFile = vi.fn().mockReturnValue("sa-token-abc");
    const readFromOnePassword = vi.fn().mockImplementation(() => {
      throw new Error("op: command not found");
    });
    const token = resolveD1Token({ readTokenFile, readFromOnePassword });
    expect(token).toBeNull();
  });

  it("devuelve null si op read devuelve string vacío", () => {
    const readTokenFile = vi.fn().mockReturnValue("sa-token-abc");
    const readFromOnePassword = vi.fn().mockReturnValue("");
    const token = resolveD1Token({ readTokenFile, readFromOnePassword });
    expect(token).toBeNull();
  });
});
```

- [ ] **Step 2: Correr los tests, confirmar que fallan**

Run: `cd daemon-v2 && npx vitest run scripts/research-competencia-cf-token.test.ts`
Expected: FAIL — `Cannot find module './research-competencia-cf-token.js'`

- [ ] **Step 3: Implementar, calcado de `research-competencia-apify-token.ts`**

```typescript
// daemon-v2/scripts/research-competencia-cf-token.ts
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Resuelve CF_API_TOKEN_D1_RESEARCH_COMPETENCIA desde 1Password para research-competencia-now.ts.
// Secreto NUEVO (2026-09-08) → vault Daemons, mismo criterio que APIFY_TOKEN
// (research-competencia-apify-token.ts) y la regla dura de Personal/Agents/CLAUDE.md.

const TOKEN_FILE_PATH = `${process.env.HOME}/.claude/secrets/op-service-account-token-daemons`;
const CF_D1_OP_REF = "op://Daemons/Research Competencia D1/credential";

export interface CfD1TokenDeps {
  readTokenFile: () => string;
  readFromOnePassword: (serviceAccountToken: string) => string;
}

function readTokenFileReal(): string {
  return readFileSync(TOKEN_FILE_PATH, "utf8").trim();
}

function readFromOnePasswordReal(serviceAccountToken: string): string {
  return execFileSync("op", ["read", CF_D1_OP_REF], {
    env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: serviceAccountToken },
    encoding: "utf8",
  }).trim();
}

/**
 * Devuelve el token de Cloudflare (scope D1:Edit) para research-competencia, o `null` ante
 * cualquier problema. Fail-soft: research-competencia-now.ts sigue corriendo igual sin esto —
 * el histórico de posts queda sin actualizarse esta corrida, nada más.
 */
export function resolveD1Token(deps: Partial<CfD1TokenDeps> = {}): string | null {
  const readTokenFile = deps.readTokenFile ?? readTokenFileReal;
  const readFromOnePassword = deps.readFromOnePassword ?? readFromOnePasswordReal;
  try {
    const serviceAccountToken = readTokenFile();
    if (!serviceAccountToken) throw new Error("token del Service Account vacío");
    const cfToken = readFromOnePassword(serviceAccountToken);
    return cfToken || null;
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_d1_token_resolve_error", err: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}
```

- [ ] **Step 4: Correr los tests, confirmar que pasan**

Run: `cd daemon-v2 && npx vitest run scripts/research-competencia-cf-token.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/scripts/research-competencia-cf-token.ts daemon-v2/scripts/research-competencia-cf-token.test.ts
git commit -m "feat(research-competencia): resolver del token D1 desde 1Password"
```

---

### Task 3: Script de provisioning (crear la D1 database + tabla)

**Files:**
- Create: `daemon-v2/scripts/setup-d1-research-competencia.ts`

Script imperativo one-off, sin test — mismo patrón que `setup-notion-research-competencia.ts` (provisioning, no lógica de dominio). Requiere que el ítem de 1Password ya exista (paso manual de arriba) y que `CF_ACCOUNT_ID` esté en el entorno (ya vive en `~/.claude/secrets/apps.env`).

- [ ] **Step 1: Implementar el script**

```typescript
// daemon-v2/scripts/setup-d1-research-competencia.ts
import { config as loadEnv } from "dotenv";
loadEnv({ path: `${process.env.HOME}/.claude/secrets/apps.env` });

import { resolveD1Token } from "./research-competencia-cf-token.js";

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const DB_NAME = "research-competencia";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  fecha TEXT,
  caption TEXT,
  es_video INTEGER NOT NULL,
  media_urls TEXT,
  imagenes_desc TEXT,
  video_transcripcion TEXT,
  video_frames TEXT,
  run_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_entity_fecha ON posts(entity_id, fecha);
`.trim();

async function main(): Promise<void> {
  if (!ACCOUNT_ID) {
    console.error("❌ Falta CF_ACCOUNT_ID en el entorno (~/.claude/secrets/apps.env).");
    process.exit(1);
  }
  const token = resolveD1Token();
  if (!token) {
    console.error("❌ No pude resolver el token D1 desde 1Password (vault Daemons, ítem 'Research Competencia D1'). ¿Ya lo creaste con `op item create`?");
    process.exit(1);
  }

  console.log(`Creando (o reusando) la D1 database "${DB_NAME}"...`);
  const createRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: DB_NAME }),
  });
  const createData = (await createRes.json()) as { success: boolean; result?: { uuid: string }; errors?: unknown[] };

  let databaseId: string;
  if (createData.success && createData.result) {
    databaseId = createData.result.uuid;
    console.log(`✅ Database creada: ${databaseId}`);
  } else {
    // Ya existe — listar para encontrar el uuid en vez de fallar.
    console.log("La database ya existe (o el create falló por otro motivo) — buscándola en la lista...");
    const listRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database?name=${DB_NAME}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listData = (await listRes.json()) as { success: boolean; result?: Array<{ uuid: string; name: string }> };
    const found = listData.result?.find((d) => d.name === DB_NAME);
    if (!found) {
      console.error("❌ No encontré ni pude crear la database. Respuesta del create:", JSON.stringify(createData.errors));
      process.exit(1);
    }
    databaseId = found.uuid;
    console.log(`✅ Database ya existía: ${databaseId}`);
  }

  console.log("Aplicando el schema (CREATE TABLE posts)...");
  const schemaRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: SCHEMA_SQL }),
  });
  const schemaData = (await schemaRes.json()) as { success: boolean; errors?: unknown[] };
  if (!schemaData.success) {
    console.error("❌ Falló aplicar el schema:", JSON.stringify(schemaData.errors));
    process.exit(1);
  }

  console.log(`\n✅ Listo. Agregá esta línea a ~/.claude/secrets/apps.env:\n\nD1_RESEARCH_COMPETENCIA_DATABASE_ID=${databaseId}\n`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Agregar el script a `package.json`**

Modify: `daemon-v2/package.json` — agregar en `scripts`:

```json
"setup:d1-research-competencia": "tsx scripts/setup-d1-research-competencia.ts"
```

- [ ] **Step 3: Correr el script una vez (acción real, requiere el token de 1Password ya creado)**

Run: `cd daemon-v2 && npm run setup:d1-research-competencia`
Expected: imprime el `database_id` nuevo. Pegar ese valor en `~/.claude/secrets/apps.env` como `D1_RESEARCH_COMPETENCIA_DATABASE_ID=...` antes de seguir a la Task 4.

- [ ] **Step 4: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/scripts/setup-d1-research-competencia.ts daemon-v2/package.json
git commit -m "feat(research-competencia): script de provisioning de la D1 database"
```

---

### Task 4: Dedupe — `findExistingUrls` e `insertPosts`

**Files:**
- Create: `daemon-v2/src/tools/research-competencia-history.ts`
- Test: `daemon-v2/src/tools/research-competencia-history.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
// daemon-v2/src/tools/research-competencia-history.test.ts
import { describe, it, expect, vi } from "vitest";
import { findExistingUrls, insertPosts, type HistoryPost } from "./research-competencia-history.js";

describe("findExistingUrls", () => {
  it("devuelve un Map url->fila para las URLs que ya existen en D1", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue([
      { url: "https://a.com/1", caption: "hola", imagenes_desc: "[]" },
    ]);
    const result = await findExistingUrls(["https://a.com/1", "https://a.com/2"], { queryD1Fn });
    expect(result.size).toBe(1);
    expect(result.get("https://a.com/1")?.caption).toBe("hola");
  });

  it("devuelve un Map vacío (no null) si D1 no responde — fail-soft, todo se trata como nuevo", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue(null);
    const result = await findExistingUrls(["https://a.com/1"], { queryD1Fn });
    expect(result.size).toBe(0);
  });

  it("devuelve un Map vacío sin llamar a D1 si la lista de URLs está vacía", async () => {
    const queryD1Fn = vi.fn();
    const result = await findExistingUrls([], { queryD1Fn });
    expect(result.size).toBe(0);
    expect(queryD1Fn).not.toHaveBeenCalled();
  });

  it("arma el SQL con un placeholder ? por cada URL", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue([]);
    await findExistingUrls(["u1", "u2", "u3"], { queryD1Fn });
    const [sql, params] = queryD1Fn.mock.calls[0];
    expect(sql).toContain("IN (?,?,?)");
    expect(params).toEqual(["u1", "u2", "u3"]);
  });
});

describe("insertPosts", () => {
  const post: HistoryPost = {
    entityId: "takenos",
    platform: "instagram",
    handle: "takenosapp.bo",
    url: "https://instagram.com/p/abc",
    fecha: "2026-09-08",
    caption: "promo",
    esVideo: false,
    mediaUrls: ["https://img.example/1.jpg"],
    imagenes: ["una imagen de una promo"],
    video: undefined,
  };

  it("inserta cada post con INSERT OR IGNORE, sin tirar si D1 falla", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue([]);
    await insertPosts([post], "run-2026-09-08", { queryD1Fn });
    expect(queryD1Fn).toHaveBeenCalledTimes(1);
    const [sql, params] = queryD1Fn.mock.calls[0];
    expect(sql).toContain("INSERT OR IGNORE INTO posts");
    expect(params).toContain("takenos");
    expect(params).toContain("https://instagram.com/p/abc");
  });

  it("no tira si queryD1Fn rechaza — fail-soft", async () => {
    const queryD1Fn = vi.fn().mockRejectedValue(new Error("d1 down"));
    await expect(insertPosts([post], "run-1", { queryD1Fn })).resolves.toBeUndefined();
  });

  it("no llama a D1 si la lista de posts está vacía", async () => {
    const queryD1Fn = vi.fn();
    await insertPosts([], "run-1", { queryD1Fn });
    expect(queryD1Fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr los tests, confirmar que fallan**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-history.test.ts`
Expected: FAIL — `Cannot find module './research-competencia-history.js'`

- [ ] **Step 3: Implementar**

```typescript
// daemon-v2/src/tools/research-competencia-history.ts
import { queryD1, type D1QueryDeps } from "./research-competencia-d1.js";
import type { SocialPlatform } from "./research-competencia-social.js";
import type { VideoAnalysis } from "./research-competencia-media.js";

export interface HistoryPost {
  entityId: string;
  platform: SocialPlatform;
  handle: string;
  url: string;
  fecha: string | null;
  caption: string;
  esVideo: boolean;
  mediaUrls: string[];
  imagenes: string[];
  video?: VideoAnalysis;
}

export interface HistoryRow {
  url: string;
  fecha: string | null;
  caption: string;
  esVideo: boolean;
  mediaUrls: string[];
  imagenes: string[];
  videoTranscripcion: string | null;
  videoFrames: string[];
}

export interface HistoryDeps {
  queryD1Fn?: (sql: string, params: unknown[], deps?: D1QueryDeps) => Promise<Record<string, unknown>[] | null>;
}

function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToHistoryRow(row: Record<string, unknown>): HistoryRow {
  return {
    url: String(row.url),
    fecha: typeof row.fecha === "string" ? row.fecha : null,
    caption: typeof row.caption === "string" ? row.caption : "",
    esVideo: row.es_video === 1,
    mediaUrls: parseJsonArray(row.media_urls),
    imagenes: parseJsonArray(row.imagenes_desc),
    videoTranscripcion: typeof row.video_transcripcion === "string" ? row.video_transcripcion : null,
    videoFrames: parseJsonArray(row.video_frames),
  };
}

/**
 * Consulta D1 por las URLs que YA existen en el histórico. Fail-soft: si D1 no responde, devuelve
 * un Map vacío — `fetchSocialText` trata eso como "nada visto todavía" y enriquece todo igual que
 * hoy (más caro esa semana, nunca se pierde contenido).
 */
export async function findExistingUrls(urls: string[], deps: HistoryDeps = {}): Promise<Map<string, HistoryRow>> {
  if (urls.length === 0) return new Map();
  const queryD1Fn = deps.queryD1Fn ?? queryD1;
  const placeholders = urls.map(() => "?").join(",");
  const rows = await queryD1Fn(`SELECT * FROM posts WHERE url IN (${placeholders})`, urls);
  const map = new Map<string, HistoryRow>();
  for (const row of rows ?? []) {
    const parsed = rowToHistoryRow(row);
    map.set(parsed.url, parsed);
  }
  return map;
}

/**
 * Inserta posts nuevos (ya enriquecidos) al histórico. `INSERT OR IGNORE` — si la URL ya existe
 * (carrera entre dos corridas, o un post que `findExistingUrls` no vio a tiempo), se ignora en vez
 * de tirar. Una query por post — el volumen semanal (≤8×22 en el peor caso) no justifica el modo
 * `batch` de la API todavía; si esto se usa para el backfill grande, ahí sí conviene batchear.
 */
export async function insertPosts(posts: HistoryPost[], runId: string, deps: HistoryDeps = {}): Promise<void> {
  if (posts.length === 0) return;
  const queryD1Fn = deps.queryD1Fn ?? queryD1;
  const nowIso = new Date().toISOString();
  for (const post of posts) {
    try {
      await queryD1Fn(
        `INSERT OR IGNORE INTO posts (entity_id, platform, handle, url, fecha, caption, es_video, media_urls, imagenes_desc, video_transcripcion, video_frames, run_id, first_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          post.entityId,
          post.platform,
          post.handle,
          post.url,
          post.fecha,
          post.caption,
          post.esVideo ? 1 : 0,
          JSON.stringify(post.mediaUrls),
          JSON.stringify(post.imagenes),
          post.video?.transcripcion ?? null,
          JSON.stringify(post.video?.frames ?? []),
          runId,
          nowIso,
        ],
      );
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_history_insert_error", url: post.url, err: String(err) }));
    }
  }
}
```

- [ ] **Step 4: Correr los tests, confirmar que pasan**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-history.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/research-competencia-history.ts daemon-v2/src/tools/research-competencia-history.test.ts
git commit -m "feat(research-competencia): dedupe por URL contra el histórico D1"
```

---

### Task 5: Agregación — `getAggregateStats` y `formatHistoryText`

**Files:**
- Modify: `daemon-v2/src/tools/research-competencia-history.ts`
- Modify: `daemon-v2/src/tools/research-competencia-history.test.ts`

- [ ] **Step 1: Agregar los tests que fallan**

```typescript
// agregar a daemon-v2/src/tools/research-competencia-history.test.ts
import { getAggregateStats, formatHistoryText } from "./research-competencia-history.js";

describe("getAggregateStats", () => {
  it("calcula conteo total y promedio semanal a partir de las filas de D1", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue([{ total: 12, primera_fecha: "2026-06-01", ultima_fecha: "2026-09-01" }]);
    const stats = await getAggregateStats("takenos", 90, { queryD1Fn });
    expect(stats).toEqual({ total: 12, primeraFecha: "2026-06-01", ultimaFecha: "2026-09-01", promedioSemanal: expect.any(Number) });
  });

  it("devuelve null si D1 no responde — fail-soft", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue(null);
    const stats = await getAggregateStats("takenos", 90, { queryD1Fn });
    expect(stats).toBeNull();
  });

  it("devuelve null si no hay filas (entidad sin historial todavía)", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue([{ total: 0, primera_fecha: null, ultima_fecha: null }]);
    const stats = await getAggregateStats("takenos", 90, { queryD1Fn });
    expect(stats).toBeNull();
  });
});

describe("formatHistoryText", () => {
  it("arma una línea legible por entidad con las stats", () => {
    const texto = formatHistoryText({ total: 12, primeraFecha: "2026-06-01", ultimaFecha: "2026-09-01", promedioSemanal: 0.9 });
    expect(texto).toContain("12 posts");
    expect(texto).toContain("0.9");
  });

  it("devuelve null si stats es null", () => {
    expect(formatHistoryText(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Correr, confirmar que fallan**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-history.test.ts`
Expected: FAIL — `getAggregateStats`/`formatHistoryText` no exportados

- [ ] **Step 3: Agregar la implementación al mismo archivo**

```typescript
// agregar a daemon-v2/src/tools/research-competencia-history.ts

export interface AggregateStats {
  total: number;
  primeraFecha: string;
  ultimaFecha: string;
  promedioSemanal: number;
}

/**
 * Agregación de tendencia sobre el histórico — conteo y promedio semanal en la ventana pedida.
 * Es lo que recibe el agente LLM (resumen agregado, decisión de Cal 2026-09-08), no posts crudos
 * históricos completos. `null` si D1 no responde o si la entidad no tiene historial en la ventana
 * (evita mandarle al agente un bloque vacío/engañoso).
 */
export async function getAggregateStats(entityId: string, days: number, deps: HistoryDeps = {}): Promise<AggregateStats | null> {
  const queryD1Fn = deps.queryD1Fn ?? queryD1;
  const desde = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await queryD1Fn(
    "SELECT COUNT(*) as total, MIN(fecha) as primera_fecha, MAX(fecha) as ultima_fecha FROM posts WHERE entity_id = ? AND fecha >= ?",
    [entityId, desde],
  );
  const row = rows?.[0];
  const total = typeof row?.total === "number" ? row.total : 0;
  if (!row || total === 0 || !row.primera_fecha || !row.ultima_fecha) return null;
  const primeraFecha = String(row.primera_fecha);
  const ultimaFecha = String(row.ultima_fecha);
  const diasSpan = Math.max(1, (new Date(ultimaFecha).getTime() - new Date(primeraFecha).getTime()) / (24 * 60 * 60 * 1000));
  return { total, primeraFecha, ultimaFecha, promedioSemanal: Math.round((total / (diasSpan / 7)) * 10) / 10 };
}

/** Convierte las stats agregadas en el bloque de texto que va al prompt del agente. */
export function formatHistoryText(stats: AggregateStats | null): string | null {
  if (!stats) return null;
  return `${stats.total} posts detectados entre ${stats.primeraFecha} y ${stats.ultimaFecha} (histórico acumulado) — promedio ${stats.promedioSemanal} posts/semana.`;
}
```

- [ ] **Step 4: Correr, confirmar que pasan**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-history.test.ts`
Expected: PASS — 12 tests en total (7 de la Task 4 + 5 nuevos)

- [ ] **Step 5: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/research-competencia-history.ts daemon-v2/src/tools/research-competencia-history.test.ts
git commit -m "feat(research-competencia): agregación de tendencia histórica"
```

---

### Task 6: Dedupe en `fetchSocialText`

**Files:**
- Modify: `daemon-v2/src/tools/research-competencia-social.ts`
- Modify: `daemon-v2/src/tools/research-competencia-social.test.ts`

**Contexto:** hoy `fetchSocialText` scrapea → filtra por ventana → `enrichFn` sobre TODO lo filtrado. El cambio: antes de `enrichFn`, separar en "ya visto en D1" (reusar, sin re-enriquecer) y "nuevo" (enriquecer como hoy); después de enriquecer, insertar los nuevos a D1.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// agregar a daemon-v2/src/tools/research-competencia-social.test.ts (mismo describe de fetchSocialText)
it("no vuelve a enriquecer un post cuya URL ya existe en el histórico D1 — lo reusa desde ahí", async () => {
  const entity = { id: "takenos", social: { instagram: ["takenosapp.bo"], tiktok: [], facebook: [], x: [] } } as EntityConfig;
  const postYaVisto = { platform: "instagram" as const, handle: "takenosapp.bo", url: "https://ig.com/p/1", fecha: "2026-09-01", caption: "vieja", mediaUrls: [], esVideo: false };
  const postNuevo = { platform: "instagram" as const, handle: "takenosapp.bo", url: "https://ig.com/p/2", fecha: "2026-09-08", caption: "nueva", mediaUrls: [], esVideo: false };
  const scrapers = { instagram: vi.fn().mockResolvedValue([postYaVisto, postNuevo]), tiktok: vi.fn(), facebook: vi.fn(), x: vi.fn() };
  const enrichFn = vi.fn().mockImplementation(async (posts: SocialPost[]) => posts.map((p) => ({ ...p, imagenes: [`analizado:${p.url}`] })));
  const findExistingUrlsFn = vi.fn().mockResolvedValue(new Map([["https://ig.com/p/1", { url: "https://ig.com/p/1", fecha: "2026-09-01", caption: "vieja", esVideo: false, mediaUrls: [], imagenes: ["ya analizado antes"], videoTranscripcion: null, videoFrames: [] }]]));
  const insertPostsFn = vi.fn().mockResolvedValue(undefined);

  const texto = await fetchSocialText(entity, 90, {
    context: {} as never,
    scrapers,
    enrichFn,
    findExistingUrlsFn,
    insertPostsFn,
    runId: "run-test",
  });

  // enrichFn solo se llamó con el post NUEVO, no con el ya visto
  expect(enrichFn).toHaveBeenCalledWith([postNuevo]);
  // el texto final incluye AMBOS — el viejo reusado desde D1, el nuevo recién analizado
  expect(texto).toContain("ya analizado antes");
  expect(texto).toContain("analizado:https://ig.com/p/2");
  // solo el nuevo se insertó a D1
  expect(insertPostsFn).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ url: "https://ig.com/p/2" })]),
    "run-test",
    undefined,
  );
});

it("si findExistingUrlsFn no se pasa (deps opcionales), enriquece todo igual que hoy — comportamiento sin cambios", async () => {
  const entity = { id: "takenos", social: { instagram: ["takenosapp.bo"], tiktok: [], facebook: [], x: [] } } as EntityConfig;
  const post = { platform: "instagram" as const, handle: "takenosapp.bo", url: "https://ig.com/p/1", fecha: "2026-09-01", caption: "x", mediaUrls: [], esVideo: false };
  const scrapers = { instagram: vi.fn().mockResolvedValue([post]), tiktok: vi.fn(), facebook: vi.fn(), x: vi.fn() };
  const enrichFn = vi.fn().mockResolvedValue([{ ...post, imagenes: [] }]);
  await fetchSocialText(entity, 90, { context: {} as never, scrapers, enrichFn });
  expect(enrichFn).toHaveBeenCalledWith([post]);
});
```

- [ ] **Step 2: Correr, confirmar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: FAIL — el primer test falla porque `enrichFn` se llama con los 2 posts, no solo el nuevo

- [ ] **Step 3: Modificar `fetchSocialText`**

Modify: `daemon-v2/src/tools/research-competencia-social.ts` — agregar el import y extender `FetchSocialDeps`, y el cuerpo del loop interno:

```typescript
// agregar al inicio del archivo, junto a los demás imports
import type { HistoryRow, HistoryPost, HistoryDeps } from "./research-competencia-history.js";
```

```typescript
// extender la interface existente FetchSocialDeps — agregar estos 3 campos opcionales
export interface FetchSocialDeps {
  scrapers?: Record<SocialPlatform, ScraperFn>;
  context: BrowserContext;
  enrichFn?: (posts: SocialPost[]) => Promise<EnrichedPost[]>;
  ahora?: Date;
  nowMs?: () => number;
  presupuestoMs?: number;
  /** Consulta el histórico D1 por URLs ya vistas — opcional: si no se pasa, el comportamiento es
   * idéntico al de antes de esta feature (se enriquece todo, sin dedupe). */
  findExistingUrlsFn?: (urls: string[], deps?: HistoryDeps) => Promise<Map<string, HistoryRow>>;
  /** Inserta los posts nuevos ya enriquecidos al histórico D1. Mismo criterio opcional que arriba. */
  insertPostsFn?: (posts: HistoryPost[], runId: string, deps?: HistoryDeps) => Promise<void>;
  /** Id de la corrida — requerido solo si se pasa `insertPostsFn` (para trazabilidad en D1). */
  runId?: string;
  entityId?: string;
}
```

Reemplazar el cuerpo del `for (const handle of handles)` dentro de `fetchSocialText` (la parte que hoy llama `enrichFn(enVentana)` directo) por:

```typescript
      let enVentana: SocialPost[];
      try {
        enVentana = filterPostsByTimeframe(posts, timeframeDias, deps.ahora);
      } catch (err) {
        console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_social_filter_error", platform, handle, err: String(err) }));
        continue;
      }

      try {
        let enriquecidos: EnrichedPost[];
        if (deps.findExistingUrlsFn) {
          const existentes = await deps.findExistingUrlsFn(enVentana.map((p) => p.url));
          const nuevos = enVentana.filter((p) => !existentes.has(p.url));
          const reusados: EnrichedPost[] = enVentana
            .filter((p) => existentes.has(p.url))
            .map((p) => {
              const row = existentes.get(p.url) as HistoryRow;
              // VideoAnalysis.transcripcion es `string` requerido (no `string | null`) — si la fila
              // de D1 no tiene transcripción pero sí frames (o viceversa), "" cubre el campo
              // faltante en vez de violar el tipo con `undefined`.
              const video: VideoAnalysis | undefined =
                row.videoTranscripcion !== null || row.videoFrames.length > 0
                  ? { transcripcion: row.videoTranscripcion ?? "", frames: row.videoFrames }
                  : undefined;
              return { ...p, imagenes: row.imagenes, video };
            });
          const nuevosEnriquecidos = nuevos.length > 0 ? await enrichFn(nuevos) : [];
          enriquecidos = [...reusados, ...nuevosEnriquecidos];
          if (deps.insertPostsFn && nuevosEnriquecidos.length > 0 && deps.runId) {
            const historyPosts: HistoryPost[] = nuevosEnriquecidos.map((p) => ({
              entityId: deps.entityId ?? entity.id,
              platform: p.platform,
              handle: p.handle,
              url: p.url,
              fecha: p.fecha,
              caption: p.caption,
              esVideo: p.esVideo,
              mediaUrls: p.mediaUrls,
              imagenes: p.imagenes,
              video: p.video,
            }));
            await deps.insertPostsFn(historyPosts, deps.runId);
          }
        } else {
          enriquecidos = await enrichFn(enVentana);
        }
        todos.push(...enriquecidos);
      } catch (err) {
        console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_social_enrich_error", platform, handle, err: String(err) }));
      }
```

- [ ] **Step 4: Correr, confirmar que pasan**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: PASS — todos los tests, incluidos los 2 nuevos

- [ ] **Step 5: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/research-competencia-social.ts daemon-v2/src/tools/research-competencia-social.test.ts
git commit -m "feat(research-competencia): dedupe de posts contra el histórico D1 en fetchSocialText"
```

---

### Task 7: Bloque de tendencia en el prompt del agente

**Files:**
- Modify: `daemon-v2/src/tools/research-competencia-agent.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear (si no existe) o extender `daemon-v2/src/tools/research-competencia-agent.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildEntityPrompt } from "./research-competencia-agent.js";
import type { EntityConfig } from "./research-competencia-entities.js";

describe("buildEntityPrompt — bloque de historial", () => {
  const entity: EntityConfig = { id: "takenos", nombre: "Takenos", linkedinQuery: "Takenos Bolivia" };

  it("incluye el texto de historyText cuando viene presente", () => {
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: "12 posts detectados entre 2026-06-01 y 2026-09-01 — promedio 0.9 posts/semana." }, 7);
    expect(prompt).toContain("12 posts detectados entre 2026-06-01 y 2026-09-01");
  });

  it("no rompe si historyText es null (entidad sin histórico todavía)", () => {
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    expect(prompt).toContain("sin histórico acumulado todavía");
  });
});
```

- [ ] **Step 2: Correr, confirmar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-agent.test.ts`
Expected: FAIL — `historyText` no existe en `MechanicalFacts`, TypeScript no compila el test

- [ ] **Step 3: Modificar `research-competencia-agent.ts`**

Modify `MechanicalFacts` (línea 5-11):

```typescript
export interface MechanicalFacts {
  ios: { version: string; rating: number | null; releaseNotes: string | null } | null;
  android: { version: string | null; rating: number | null; releaseNotes: string | null } | null;
  siteText: string | null;
  socialText: string | null;
  adsText: string | null;
  /** Resumen agregado del histórico acumulado en D1 (conteo/promedio semanal) — no posts crudos.
   * `null` si D1 no respondió o si la entidad no tiene historial en la ventana consultada. */
  historyText: string | null;
}
```

Insertar un bloque nuevo en `buildEntityPrompt`, después del bloque de `facts.socialText` (después de la línea que hoy termina en `... clasificalo con las mismas dimensiones de arriba: GTM si es promo/campaña/canal, ...`) y antes del bloque de `Publicidad PAGA`:

```typescript
    ``,
    `Contexto de tendencia histórica (acumulado de corridas anteriores, NO son posts nuevos — es solo para que sepas si la actividad de esta semana es normal o atípica para esta entidad, nunca lo repitas como hallazgo):`,
    facts.historyText ?? "(sin histórico acumulado todavía — es la primera vez que se guarda historial para esta entidad, o D1 no respondió esta corrida. No es una señal de nada.)",
    ``,
```

- [ ] **Step 4: Correr, confirmar que pasan**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/research-competencia-agent.ts daemon-v2/src/tools/research-competencia-agent.test.ts
git commit -m "feat(research-competencia): bloque de tendencia histórica en el prompt del agente"
```

---

### Task 8: Conectar todo en el orquestador

**Files:**
- Modify: `daemon-v2/src/tools/research-competencia.ts`
- Modify: `daemon-v2/src/tools/research-competencia.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Agregar a `research-competencia.test.ts` (junto a los demás tests de `runResearchCompetencia`/`processEntity` — usar el mock existente de `research-competencia-social.js` como base):

```typescript
it("pasa historyText a MechanicalFacts a partir de getAggregateStats", async () => {
  vi.mocked(getAggregateStats).mockResolvedValue({ total: 5, primeraFecha: "2026-08-01", ultimaFecha: "2026-09-01", promedioSemanal: 1.1 });
  const result = await runResearchCompetencia({ entidadIds: ["takenos"] });
  expect(buildEntityPrompt).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ historyText: expect.stringContaining("5 posts") }),
    expect.anything(),
  );
});

it("un fallo de getAggregateStats no aborta la entidad — historyText queda null", async () => {
  vi.mocked(getAggregateStats).mockRejectedValue(new Error("d1 down"));
  const result = await runResearchCompetencia({ entidadIds: ["takenos"] });
  expect(result.entidades[0].error).toBeUndefined();
});
```

(Agregar los mocks correspondientes al bloque `vi.mock` del archivo, siguiendo el mismo patrón que los mocks existentes de `research-competencia-ads.js`/`research-competencia-social.js`:)

```typescript
vi.mock("./research-competencia-history.js", () => ({
  findExistingUrls: vi.fn().mockResolvedValue(new Map()),
  insertPosts: vi.fn().mockResolvedValue(undefined),
  getAggregateStats: vi.fn().mockResolvedValue(null),
  formatHistoryText: vi.fn((stats) => (stats ? `${stats.total} posts detectados` : null)),
}));
```

- [ ] **Step 2: Correr, confirmar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia.test.ts`
Expected: FAIL — `historyText` no se pasa a `facts`, `getAggregateStats` no se llama

- [ ] **Step 3: Modificar `research-competencia.ts`**

Agregar el import (junto a los demás, cerca de la línea 9):

```typescript
import { findExistingUrls, insertPosts, getAggregateStats, formatHistoryText } from "./research-competencia-history.js";
```

En `processEntity`, agregar una promesa de historial junto a las demás (cerca del bloque de `instagramFollowersPromise`/`facebookFollowersPromise`, antes del `Promise.all` que las junta):

```typescript
    const historyTextPromise = getAggregateStats(entity.id, 90)
      .then(formatHistoryText)
      .catch((err) => {
        console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_history_stats_error", entityId: entity.id, err: String(err) }));
        return null;
      });
```

Agregar `historyTextPromise` al array del `Promise.all` existente y a la desestructuración:

```typescript
    const [ios, android, siteText, socialText, adsBlock, instagramFollowers, facebookFollowers, historyText] = await Promise.all([
      entity.ios ? fetchIosAppInfo(entity.ios) : Promise.resolve(null),
      entity.android ? fetchAndroidAppInfo(entity.android.packageName) : Promise.resolve(null),
      entity.siteUrl ? fetchSiteText(entity.siteUrl) : Promise.resolve(null),
      socialTextWithDeadline,
      adsBlockWithDeadline,
      instagramFollowersPromise,
      facebookFollowersPromise,
      historyTextPromise,
    ]);
```

Agregar `historyText` a la construcción de `facts`:

```typescript
    const facts: MechanicalFacts = {
      ios: ios ? { version: ios.version, rating: ios.rating, releaseNotes: ios.releaseNotes } : null,
      android: android ? { version: android.version, rating: android.rating, releaseNotes: android.releaseNotes } : null,
      siteText,
      socialText,
      adsText: adsBlock?.texto ?? null,
      historyText,
    };
```

Pasar el dedupe y el `runId` a `fetchSocialText`. Buscar la línea (dentro de `processEntity`, cerca del inicio):

```typescript
    const socialTextPromise = browserSession
      ? fetchSocialText(entity, timeframeDias, { context: browserSession.context }).catch((err) => {
```

y reemplazar el objeto de deps por:

```typescript
    const socialTextPromise = browserSession
      ? fetchSocialText(entity, timeframeDias, {
          context: browserSession.context,
          findExistingUrlsFn: findExistingUrls,
          insertPostsFn: insertPosts,
          runId,
          entityId: entity.id,
        }).catch((err) => {
```

`runId` se genera UNA vez por corrida completa (no por entidad) — agregarlo como parámetro de `processEntity` y generarlo en `runResearchCompetencia` (la función pública que llama a `processEntity` por cada entidad). Buscar la firma de `processEntity`:

```typescript
async function processEntity(
  entity: EntityConfig,
  timeframeDias: number,
  fecha: string,
  browserSession: ResearchBrowserSession | null,
): Promise<EntityRunResult> {
```

y agregar el parámetro:

```typescript
async function processEntity(
  entity: EntityConfig,
  timeframeDias: number,
  fecha: string,
  browserSession: ResearchBrowserSession | null,
  runId: string,
): Promise<EntityRunResult> {
```

En `runResearchCompetencia` (la función exportada que llama a `processEntity`), generar `runId` una vez al inicio (buscar donde se calcula `fecha` con `nowInLaPaz` — agregar al lado) y pasarlo en cada llamada a `processEntity(entity, timeframeDias, fecha, browserSession)`:

```typescript
const runId = new Date().toISOString();
```

```typescript
processEntity(entity, timeframeDias, fecha, browserSession, runId)
```

- [ ] **Step 4: Correr, confirmar que pasan**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia.test.ts`
Expected: PASS — todos los tests, incluidos los 2 nuevos

- [ ] **Step 5: Correr la suite completa del módulo, confirmar que nada se rompió**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia`
Expected: PASS — todos los archivos `research-competencia*.test.ts`

- [ ] **Step 6: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/research-competencia.ts daemon-v2/src/tools/research-competencia.test.ts
git commit -m "feat(research-competencia): conectar el histórico D1 al orquestador (runId, dedupe, agregación)"
```

---

### Task 9: Resolver el token D1 en el entrypoint del cron

**Files:**
- Modify: `daemon-v2/scripts/research-competencia-now.ts`

- [ ] **Step 1: Modificar `main()`**

Agregar el import (junto a `resolveApifyToken`):

```typescript
import { resolveD1Token } from "./research-competencia-cf-token.js";
```

Agregar, junto al bloque existente de `resolveApifyToken` dentro de `main()`:

```typescript
  if (!process.env.CF_API_TOKEN_D1_RESEARCH_COMPETENCIA) {
    const d1Token = resolveD1Token();
    if (d1Token) process.env.CF_API_TOKEN_D1_RESEARCH_COMPETENCIA = d1Token;
  }
```

Esto va inmediatamente después del bloque equivalente de `APIFY_TOKEN` (antes de `findMissingEnvVars`). No se agrega a `REQUIRED_ENV_VARS` — el histórico es fail-soft, no bloqueante (si falta, el research corre igual sin dedupe ni agregación, como hoy).

- [ ] **Step 2: Verificar en vivo (corrida real, on-demand, timeframe chico)**

Run: `cd daemon-v2 && npm run research:now -- --timeframe=7 --entidades=takenos --no-notify`
Expected: la corrida completa sin errores nuevos en consola. Revisar en los logs (`console.log` estructurado) que aparezcan `research_competencia_history_insert_error` NUNCA (0 ocurrencias) y que no aparezca `research_competencia_d1_missing_config` (confirma que el token/env se resolvieron bien).

- [ ] **Step 3: Confirmar en D1 que los posts quedaron insertados**

Run (usando el MCP `mcp__claude_ai_Cloudflare_Developer_Platform__d1_database_query` desde la sesión interactiva, o `queryD1` a mano): `SELECT COUNT(*) FROM posts WHERE entity_id = 'takenos'`
Expected: > 0

- [ ] **Step 4: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/scripts/research-competencia-now.ts
git commit -m "feat(research-competencia): resolver el token D1 en el entrypoint del cron"
```

---

### Task 10: Documentar en el spec de referencia

**Files:**
- Modify: `docs/references/research-competencia.md`

- [ ] **Step 1: Agregar una sección "3.11 Histórico acumulado (D1)"**

Agregar después de la sección "3.10 Resiliencia y límites conocidos" (antes de la tabla "Historial resumido"):

```markdown
### 3.11 Histórico acumulado (D1)

Desde 2026-09-08: cada post enriquecido (visión/transcripción) se guarda en una D1 database
(`research-competencia`, tabla `posts`, dedupe por `url UNIQUE`) — spec completo en
`docs/superpowers/specs/2026-09-08-research-competencia-historico-design.md`. Antes de enriquecer
un post, `fetchSocialText` consulta D1 por su URL; si ya existe, reusa el análisis guardado en vez
de re-pagar visión/transcripción. El agente LLM recibe un resumen agregado (conteo/promedio
semanal de los últimos 90 días, `getAggregateStats`) como contexto de tendencia — nunca posts
crudos históricos completos. Acceso vía REST API de Cloudflare directa (sin Worker), token
`CF_API_TOKEN_D1_RESEARCH_COMPETENCIA` en vault `Daemons` de 1Password (ítem "Research Competencia
D1"), resuelto por `research-competencia-cf-token.ts` — mismo patrón que `APIFY_TOKEN`. Fail-soft
en toda la cadena: si D1 no responde, el research corre exactamente igual que antes de esta
feature (sin dedupe, sin bloque de tendencia).

Retención: indefinida, sin purga — el volumen (≤8 posts/semana × 22 handles) nunca justifica un
tope rodante.
```

- [ ] **Step 2: Actualizar el mapa de archivos (sección 3.1)**

Agregar a la lista de `src/tools/` en la sección "3.1 Mapa de archivos":

```
    ├── research-competencia-d1.ts          # cliente D1 puro — fetch directo a la REST API de Cloudflare
    ├── research-competencia-history.ts     # dedupe por URL, inserción, agregación de tendencia
```

Y a `scripts/`:

```
    ├── research-competencia-cf-token.ts       # resuelve el token D1 vía 1Password
    ├── setup-d1-research-competencia.ts       # provisioning one-off de la D1 database
```

- [ ] **Step 3: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add docs/references/research-competencia.md
git commit -m "docs(research-competencia): documentar el histórico D1 en el mapa de referencia"
```

---

## Fuera de alcance de este plan (queda para el plan de backfill)

- Scroll en `scrapeInstagram`/`scrapeX` (necesario solo para el backfill de 6 meses, no para el flujo semanal regular).
- El script de backfill en sí (pasada de conteo + pasada de enriquecimiento, `resultsLimit` alto en Apify).
- Cualquier ajuste a `MAX_POSTS_PER_ACCOUNT`/`MAX_VIDEOS_PER_ACCOUNT` — esos topes no cambian con este plan.
