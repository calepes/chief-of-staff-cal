# Research y monitoreo de competencia (Fase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir el flujo de research de competencia de Yape Bolivia (Fase 1 del spec: apps + sitio web + prensa + LinkedIn, sin RRSS) con tres triggers — cron semanal, tool de Telegram on-demand, y script/comando interactivo — que dejan registro en Notion (changelog, snapshot de estado por entidad, e informe completo por corrida).

**Architecture:** Módulos puros (config de entidades, parsers, formatters) separados de la I/O (fetch a app stores/sitio, un agente SDK one-off con WebSearch por entidad, escritura a Notion vía `callNtn`). Un orquestador (`runResearchCompetencia`) los combina; cron, tool de Telegram y script interactivo son wrappers finos sobre el mismo orquestador — mismo patrón que `kpi-card-yape`/`checkBooksDailyReport` en este repo.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (`startup()` one-off, sin warm pool), `node-cron`, `ntn` CLI vía `callNtn` (sin token — Keychain), `google-play-scraper` (nuevo dep), iTunes Lookup API pública (fetch nativo, sin dep nueva), vitest.

**Spec de referencia:** `docs/superpowers/specs/2026-08-31-research-competencia-design.md`

---

## Contexto que el ingeniero necesita (no está en el spec)

- **Todas las escrituras/lecturas de Notion usan `callNtn()`** (`daemon-v2/src/shared/ntn.ts`), NO el módulo `tools/notion-cli.ts` (ese requiere `NOTION_TOKEN` en el entorno — `callNtn` no necesita ningún token, usa el Keychain de macOS vía el binario `ntn`). Esto es deliberado: así el mismo código corre igual desde el cron del daemon, la tool de Telegram, y el script interactivo standalone, sin depender de qué secretos estén cargados en cada contexto. Ver `daemon-v2/src/proactive/books-daily-report.ts` como referencia — es el cron mecánico más reciente de este repo y usa exactamente este patrón.
- **`callNtn(path, opts)` es SÍNCRONO** (usa `spawnSync`) y devuelve `{ ok: boolean, data?: unknown, error?: string }`. No hace falta `await`.
- **Todo Notion API call va con `Notion-Version` que decide `ntn` por default** (no la fijamos nosotros, a diferencia de `notion-cli.ts`) — esto usa el modelo "data sources": cada base de datos tiene un `id` (database) Y un `data_sources[0].id` (data source) distintos. Página → propiedades se escriben con `parent: { database_id }`; QUERY de filas va por `/v1/data_sources/{ds_id}/query`, nunca `/v1/databases/{id}/query`. Ver `daemon-v2/src/tools/books.ts` (consts `BOOKS_DB`/`BOOKS_DS`) para el patrón exacto ya en producción.
- **Reemplazar el body completo de una página** (usado para las 6 páginas de estado y la página de cada informe) se hace a mano con la Block API (`GET`/`DELETE` los children existentes, `PATCH` para appendear los nuevos) — NO uses `notionUpdateBody` de `tools/notion-cli.ts`, porque esa función sí requiere `NOTION_TOKEN` en el entorno.
- **Un agente SDK "one-off" (sin warm pool, sin tools custom, solo WebSearch)** se arranca con `startup({ options: { model, maxTurns, allowedTools } })` y se itera con `for await (const event of handle.query(prompt))`, cortando en el primer `event.type === "result" && event.subtype === "success"`. Ver `daemon-v2/src/compact.ts` — es el ejemplo más simple ya en producción de este patrón exacto (ahí con `allowedTools: []`; acá usamos `["WebSearch"]`).
- **`"WebFetch"` y `"WebSearch"` son los nombres exactos de los builtins** del Agent SDK en este repo (confirmado en `daemon-v2/src/agent-options.ts`).
- **Antes de llamar `startup()` desde un proceso que NO sea el daemon principal** (o sea: el script interactivo de Task 10), hay que `delete process.env.ANTHROPIC_API_KEY` para forzar auth OAuth Max vía Keychain — si no, y si hay una API key de Tier 1 en el entorno, el SDK la usa y tira 429. Dentro del daemon esto ya lo hace `index.ts` una vez al arrancar el proceso.
- **Datos reales de las 6 entidades, verificados con búsqueda web el 2026-08-31** (no inventados): ver Task 1. Ojo — el producto de Banco Económico se llama **"ZAS"**, no "Zaz" como se escribió informalmente en el spec; se corrige acá.
- **La estructura en Notion (2 DBs + 6 páginas) NO existe todavía.** Task 3 la crea escribiendo de verdad contra la Notion de Cal (la página "Yape Bolivia", `1f3c487609dd800a97e7c11870f3bd3f`, ya está compartida con ambas integraciones — verificado 2026-08-31). Los IDs que devuelve esa corrida real se pegan a mano en Task 4 — no se pueden hardcodear de antemano.

---

## File Structure

Todo nuevo, bajo `daemon-v2/src/tools/` (flat, con prefijo `research-competencia-*` — el repo no usa subcarpetas dentro de `tools/`, ver `kpi-ingest-*.ts` como precedente de una familia de archivos con prefijo compartido):

| Archivo | Responsabilidad |
|---|---|
| `tools/research-competencia-types.ts` | Tipos compartidos (`Dimension`, `Hallazgo`, `EntitySnapshot`, `EntityRunResult`, `RunResult`) |
| `tools/research-competencia-entities.ts` | Config estática de las 6 entidades |
| `tools/research-competencia-ids.ts` | IDs de Notion (DBs, data sources, páginas de estado) — se llena tras correr el setup |
| `tools/research-competencia-sources.ts` | Fetchers mecánicos: iOS, Android, sitio web |
| `tools/research-competencia-notion.ts` | Lectura/escritura a Notion (baseline, Cambios, Informe) |
| `tools/research-competencia-agent.ts` | Prompt + parseo + ejecución del agente one-off por entidad |
| `tools/research-competencia.ts` | Orquestador (`runResearchCompetencia`) + formateo del resumen |
| `proactive/research-competencia-weekly.ts` | Wrapper del cron semanal |
| `scripts/setup-notion-research-competencia.ts` | Script de un solo uso: crea la estructura en Notion |
| `scripts/research-competencia-now.ts` | Script on-demand para sesión interactiva |

Más ediciones a `index.ts` (registro del cron), `agent-tools.ts` (tool de Telegram), `system-prompt.ts` (guía para el modelo), `package.json` (script npm + dependencia nueva), y un comando nuevo `~/.claude/commands/research-competencia.md`.

---

### Task 1: Tipos compartidos + config de entidades

**Files:**
- Create: `daemon-v2/src/tools/research-competencia-types.ts`
- Create: `daemon-v2/src/tools/research-competencia-entities.ts`
- Test: `daemon-v2/src/tools/research-competencia-entities.test.ts`

- [ ] **Step 1: Crear los tipos compartidos**

`daemon-v2/src/tools/research-competencia-types.ts`:

```typescript
export type Dimension = "Producto" | "Estrategia" | "GTM" | "Hiring";

export interface Hallazgo {
  dimension: Dimension;
  descripcion: string;
  fuente: string;
}

export interface EntitySnapshot {
  entityId: string;
  updatedAt: string;
  ios?: { trackId?: string; version?: string; rating?: number; ratingCount?: number };
  android?: { version?: string; rating?: number; ratingCount?: number };
  siteSnippet?: string;
  notas?: string;
}

export interface EntityRunResult {
  entityId: string;
  entityNombre: string;
  primeraCorrida: boolean;
  hallazgos: Hallazgo[];
  snapshot: EntitySnapshot;
  error?: string;
}

export interface RunResult {
  fecha: string;
  timeframeDias: number;
  entidades: EntityRunResult[];
  totalHallazgos: number;
  informeUrl?: string;
}
```

- [ ] **Step 2: Escribir el test de la config de entidades (falla primero)**

`daemon-v2/src/tools/research-competencia-entities.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { ENTITIES, getEntity } from "./research-competencia-entities.js";

describe("research-competencia-entities", () => {
  it("tiene exactamente 6 entidades con ids únicos", () => {
    expect(ENTITIES).toHaveLength(6);
    const ids = ENTITIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(6);
  });

  it("cada entidad tiene al menos una fuente mecánica configurada (iOS, Android o sitio)", () => {
    for (const e of ENTITIES) {
      expect(e.ios || e.android || e.siteUrl).toBeTruthy();
    }
  });

  it("getEntity devuelve la entidad por id", () => {
    expect(getEntity("takenos").nombre).toBe("Takenos");
  });

  it("getEntity tira si el id no existe", () => {
    expect(() => getEntity("no-existe")).toThrow("Entidad desconocida: no-existe");
  });
});
```

- [ ] **Step 3: Correr el test y verificar que falla**

Run: `cd "Personal/Agents/Jano/daemon-v2" && npx vitest run src/tools/research-competencia-entities.test.ts`
Expected: FAIL — `Cannot find module './research-competencia-entities.js'`

- [ ] **Step 4: Escribir la config real (datos verificados con búsqueda web 2026-08-31)**

`daemon-v2/src/tools/research-competencia-entities.ts`:

```typescript
export interface EntityConfig {
  id: string;
  nombre: string;
  ios?: { trackId?: string; searchTerm?: string };
  android?: { packageName: string };
  siteUrl?: string;
  linkedinQuery: string;
}

export const ENTITIES: EntityConfig[] = [
  {
    id: "bancosol-altoke",
    nombre: "Banco Sol / Altoke",
    ios: { trackId: "6479173387" },
    android: { packageName: "com.bancosol.altoke" },
    siteUrl: "https://www.altoke.com.bo",
    linkedinQuery: "BancoSol Altoke Bolivia",
  },
  {
    id: "ganadero-yolopago",
    nombre: "Banco Ganadero / Yolo Pago",
    ios: { trackId: "1582673945" },
    android: { packageName: "bo.com.yolopago" },
    siteUrl: "https://www.bg.com.bo/canales-digitales/yolo-pago/",
    linkedinQuery: "Banco Ganadero Yolo Pago Bolivia",
  },
  {
    // Nombre real del producto: "ZAS" (no "Zaz" — corregido tras verificar con búsqueda web).
    id: "economico-zas",
    nombre: "Banco Económico / ZAS",
    ios: { searchTerm: "ZAS Banco Economico" }, // sin trackId confirmado — resuelve por búsqueda
    android: { packageName: "bec.vdb.direct" },
    siteUrl: "https://www.baneco.com.bo/zas",
    linkedinQuery: "Banco Economico ZAS Bolivia",
  },
  {
    id: "takenos",
    nombre: "Takenos",
    ios: { trackId: "6499217598" },
    // Nota: una fuente vio "removida de Google Play en 2026-03" — sin confirmar. Si
    // fetchAndroidAppInfo devuelve null de forma consistente, no es un bug del fetcher.
    android: { packageName: "com.takenos" },
    siteUrl: "https://takenos.com/bolivia",
    linkedinQuery: "Takenos Bolivia",
  },
  {
    id: "meru",
    nombre: "Meru",
    ios: { trackId: "1636697895" },
    android: { packageName: "com.getmeru.app" },
    siteUrl: "https://getmeru.com",
    linkedinQuery: "Meru getmeru fintech Bolivia",
  },
  {
    id: "peso-app",
    nombre: "Peso App",
    ios: { trackId: "6740822281" },
    android: { packageName: "com.latam.peso" },
    siteUrl: "https://www.peso-latam.com",
    linkedinQuery: "Peso Latam app Bolivia",
  },
];

export function getEntity(id: string): EntityConfig {
  const found = ENTITIES.find((e) => e.id === id);
  if (!found) throw new Error(`Entidad desconocida: ${id}`);
  return found;
}
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `npx vitest run src/tools/research-competencia-entities.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/research-competencia-types.ts daemon-v2/src/tools/research-competencia-entities.ts daemon-v2/src/tools/research-competencia-entities.test.ts
git commit -m "feat(research-competencia): tipos compartidos y config de las 6 entidades"
```

---

### Task 2: Fuentes mecánicas — iOS, Android, sitio web

**Files:**
- Create: `daemon-v2/src/tools/research-competencia-sources.ts`
- Test: `daemon-v2/src/tools/research-competencia-sources.test.ts`
- Modify: `daemon-v2/package.json` (nueva dependencia)

- [ ] **Step 1: Agregar la dependencia `google-play-scraper`**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm install google-play-scraper`
Expected: se agrega a `dependencies` en `package.json` y a `package-lock.json`.

- [ ] **Step 2: Escribir los tests de las funciones puras (fallan primero)**

`daemon-v2/src/tools/research-competencia-sources.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { extractVisibleText, chunkText, fetchIosAppInfo, fetchAndroidAppInfo, fetchSiteText } from "./research-competencia-sources.js";

describe("extractVisibleText", () => {
  it("saca scripts, estilos y tags, colapsa espacios", () => {
    const html = `<html><head><style>.a{color:red}</style><script>alert(1)</script></head><body><h1>Título</h1><p>Texto  con   espacios</p></body></html>`;
    expect(extractVisibleText(html)).toBe("Título Texto con espacios");
  });

  it("decodifica entidades HTML básicas", () => {
    expect(extractVisibleText("<p>A &amp; B &lt;3&gt;</p>")).toBe("A & B <3>");
  });
});

describe("chunkText", () => {
  it("no divide texto corto", () => {
    expect(chunkText("hola mundo", 100)).toEqual(["hola mundo"]);
  });

  it("divide por espacios sin cortar palabras", () => {
    const text = "una dos tres cuatro cinco";
    const chunks = chunkText(text, 10);
    expect(chunks.every((c) => c.length <= 10)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text);
  });
});

describe("fetchIosAppInfo", () => {
  it("resuelve por trackId directo", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ version: "3.2", averageUserRating: 4.5, userRatingCount: 120, releaseNotes: "Fixes" }] }),
    })) as unknown as typeof fetch;
    const info = await fetchIosAppInfo({ trackId: "123" }, fetchFn);
    expect(info).toEqual({ version: "3.2", rating: 4.5, ratingCount: 120, releaseNotes: "Fixes" });
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining("lookup?id=123"), expect.anything());
  });

  it("devuelve null si la respuesta no trae resultados", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ results: [] }) })) as unknown as typeof fetch;
    expect(await fetchIosAppInfo({ trackId: "123" }, fetchFn)).toBeNull();
  });

  it("devuelve null si el fetch no es ok", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
    expect(await fetchIosAppInfo({ trackId: "123" }, fetchFn)).toBeNull();
  });
});

describe("fetchAndroidAppInfo", () => {
  it("mapea los campos de google-play-scraper", async () => {
    const gplayFn = vi.fn(async () => ({ version: "1.0.5", score: 4.1, ratings: 900, recentChanges: "Novedades" }));
    const info = await fetchAndroidAppInfo("com.example.app", gplayFn as any);
    expect(info).toEqual({ version: "1.0.5", rating: 4.1, ratingCount: 900, releaseNotes: "Novedades" });
  });

  it("devuelve null si el scraper tira error (app no encontrada, etc.)", async () => {
    const gplayFn = vi.fn(async () => { throw new Error("Not Found"); });
    expect(await fetchAndroidAppInfo("com.no.existe", gplayFn as any)).toBeNull();
  });
});

describe("fetchSiteText", () => {
  it("extrae texto visible y lo trunca a 5000 chars", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, text: async () => `<p>${"a".repeat(6000)}</p>` })) as unknown as typeof fetch;
    const text = await fetchSiteText("https://example.com", fetchFn);
    expect(text).toHaveLength(5000);
  });

  it("devuelve null si el fetch falla", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    expect(await fetchSiteText("https://example.com", fetchFn)).toBeNull();
  });
});
```

- [ ] **Step 3: Correr los tests y verificar que fallan**

Run: `npx vitest run src/tools/research-competencia-sources.test.ts`
Expected: FAIL — módulo no existe

- [ ] **Step 4: Implementar `research-competencia-sources.ts`**

```typescript
import gplay from "google-play-scraper";

export interface IosAppInfo {
  version: string;
  rating: number | null;
  ratingCount: number | null;
  releaseNotes: string | null;
}

export interface AndroidAppInfo {
  version: string | null;
  rating: number | null;
  ratingCount: number | null;
  releaseNotes: string | null;
}

export function extractVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function fetchIosAppInfo(
  app: { trackId?: string; searchTerm?: string },
  fetchFn: typeof fetch = fetch,
): Promise<IosAppInfo | null> {
  const url = app.trackId
    ? `https://itunes.apple.com/lookup?id=${app.trackId}&country=bo`
    : `https://itunes.apple.com/search?term=${encodeURIComponent(app.searchTerm ?? "")}&country=bo&entity=software&limit=1`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const r = data.results?.[0];
  if (!r) return null;
  return {
    version: String(r.version ?? ""),
    rating: typeof r.averageUserRating === "number" ? r.averageUserRating : null,
    ratingCount: typeof r.userRatingCount === "number" ? r.userRatingCount : null,
    releaseNotes: typeof r.releaseNotes === "string" ? r.releaseNotes : null,
  };
}

export async function fetchAndroidAppInfo(
  packageName: string,
  gplayFn: typeof gplay.app = gplay.app,
): Promise<AndroidAppInfo | null> {
  try {
    const r = (await gplayFn({ appId: packageName })) as {
      version?: string; score?: number; ratings?: number; recentChanges?: string;
    };
    return {
      version: r.version ?? null,
      rating: typeof r.score === "number" ? r.score : null,
      ratingCount: typeof r.ratings === "number" ? r.ratings : null,
      releaseNotes: r.recentChanges ?? null,
    };
  } catch {
    return null;
  }
}

export async function fetchSiteText(url: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const html = await res.text();
    return extractVisibleText(html).slice(0, 5000);
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `npx vitest run src/tools/research-competencia-sources.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: Smoke test real contra los 6 packages/apps (no automatizado — verificación manual)**

Run un script ad-hoc (`npx tsx` inline o un `console.log` temporal) que llame `fetchIosAppInfo`/`fetchAndroidAppInfo`/`fetchSiteText` con los datos reales de `ENTITIES` (Task 1) y confirme que devuelven datos no-null para al menos iOS+Android+sitio de 5 de las 6 entidades. Anotar cuál falla (ej. Takenos Android puede estar delisted, ver nota en Task 1) — no es bloqueante, el orquestador (Task 7) ya tolera `null` por fuente.

- [ ] **Step 7: Commit**

```bash
git add daemon-v2/src/tools/research-competencia-sources.ts daemon-v2/src/tools/research-competencia-sources.test.ts daemon-v2/package.json daemon-v2/package-lock.json
git commit -m "feat(research-competencia): fetchers de app stores y sitio web"
```

---

### Task 3: Setup de la estructura en Notion (ejecución real, una sola vez)

**Files:**
- Create: `daemon-v2/scripts/setup-notion-research-competencia.ts`

- [ ] **Step 1: Escribir el script de setup**

`daemon-v2/scripts/setup-notion-research-competencia.ts`:

```typescript
import { callNtn } from "../src/shared/ntn.js";
import { ENTITIES } from "../src/tools/research-competencia-entities.js";

const YAPE_BOLIVIA_PAGE_ID = "1f3c487609dd800a97e7c11870f3bd3f";

interface DbCreateResult {
  id: string;
  data_sources: Array<{ id: string }>;
}

function must<T>(res: { ok: boolean; data?: T; error?: string }, label: string): T {
  if (!res.ok || res.data === undefined) {
    console.error(`❌ ${label} falló:`, res.error);
    process.exit(1);
  }
  return res.data;
}

async function main(): Promise<void> {
  console.log("Creando DB 'Competencia — Cambios'...");
  const cambiosRes = callNtn("v1/databases", {
    method: "POST",
    body: {
      parent: { type: "page_id", page_id: YAPE_BOLIVIA_PAGE_ID },
      is_inline: false,
      title: [{ type: "text", text: { content: "Competencia — Cambios" } }],
      properties: {
        Hallazgo: { title: {} },
        Entidad: { select: { options: ENTITIES.map((e) => ({ name: e.nombre })) } },
        "Dimensión": {
          select: { options: [{ name: "Producto" }, { name: "Estrategia" }, { name: "GTM" }, { name: "Hiring" }] },
        },
        Fecha: { date: {} },
        "Descripción": { rich_text: {} },
        Fuente: { url: {} },
      },
    },
  });
  const cambios = must<DbCreateResult>(cambiosRes, "crear DB Cambios");
  console.log(`✅ Cambios: db=${cambios.id} ds=${cambios.data_sources[0].id}`);

  console.log("Creando DB 'Informe Análisis Competencia'...");
  const informeRes = callNtn("v1/databases", {
    method: "POST",
    body: {
      parent: { type: "page_id", page_id: YAPE_BOLIVIA_PAGE_ID },
      is_inline: false,
      title: [{ type: "text", text: { content: "Informe Análisis Competencia" } }],
      properties: {
        Informe: { title: {} },
        Fecha: { date: {} },
        "Timeframe (días)": { number: {} },
        "Entidades incluidas": { rich_text: {} },
        Hallazgos: { number: {} },
      },
    },
  });
  const informe = must<DbCreateResult>(informeRes, "crear DB Informe");
  console.log(`✅ Informe: db=${informe.id} ds=${informe.data_sources[0].id}`);

  console.log("Creando 6 páginas de estado...");
  const statusPageIds: Record<string, string> = {};
  for (const entity of ENTITIES) {
    const pageRes = callNtn("v1/pages", {
      method: "POST",
      body: {
        parent: { type: "page_id", page_id: YAPE_BOLIVIA_PAGE_ID },
        properties: { title: { title: [{ type: "text", text: { content: `Estado — ${entity.nombre}` } }] } },
      },
    });
    const page = must<{ id: string }>(pageRes, `crear página de estado (${entity.nombre})`);
    statusPageIds[entity.id] = page.id;
    console.log(`✅ ${entity.nombre}: ${page.id}`);
  }

  console.log("\n--- Pegar esto en research-competencia-ids.ts ---\n");
  console.log(`export const CAMBIOS_DB = ${JSON.stringify(cambios.id)};`);
  console.log(`export const CAMBIOS_DS = ${JSON.stringify(cambios.data_sources[0].id)};`);
  console.log(`export const INFORME_DB = ${JSON.stringify(informe.id)};`);
  console.log(`export const INFORME_DS = ${JSON.stringify(informe.data_sources[0].id)};`);
  console.log(`export const STATUS_PAGE_IDS: Record<string, string> = ${JSON.stringify(statusPageIds, null, 2)};`);
}

main();
```

- [ ] **Step 2: Correr el script contra la Notion real de Cal**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npx tsx scripts/setup-notion-research-competencia.ts`
Expected: imprime `✅` por cada DB/página creada, termina con el bloque `export const ...` listo para copiar. Si algo falla con 403/permiso, confirmar que "Yape Bolivia" sigue compartida con la integración "Notion CLI" (verificado 2026-08-31, no debería hacer falta re-compartir).

Esta es una escritura real y visible en el Notion de Cal — antes de correrlo, avisale que se van a crear 2 databases nuevas y 6 páginas dentro de "Yape Bolivia" (no destructivo, no toca nada existente).

- [ ] **Step 3: Commit**

```bash
git add daemon-v2/scripts/setup-notion-research-competencia.ts
git commit -m "feat(research-competencia): script de setup de la estructura en Notion"
```

---

### Task 4: IDs de Notion capturados

**Files:**
- Create: `daemon-v2/src/tools/research-competencia-ids.ts`

- [ ] **Step 1: Crear el archivo con el output real de Task 3**

`daemon-v2/src/tools/research-competencia-ids.ts` — pegar EXACTAMENTE lo que imprimió el script de Task 3 (los valores de ejemplo abajo son solo de referencia, se sobreescriben con los reales):

```typescript
export const CAMBIOS_DB = "<pegar el id real que imprimió Task 3>";
export const CAMBIOS_DS = "<pegar el id real que imprimió Task 3>";
export const INFORME_DB = "<pegar el id real que imprimió Task 3>";
export const INFORME_DS = "<pegar el id real que imprimió Task 3>";
export const STATUS_PAGE_IDS: Record<string, string> = {
  "bancosol-altoke": "<pegar>",
  "ganadero-yolopago": "<pegar>",
  "economico-zas": "<pegar>",
  "takenos": "<pegar>",
  "meru": "<pegar>",
  "peso-app": "<pegar>",
};
```

- [ ] **Step 2: Verificar que compila**

Run: `npx tsc --noEmit`
Expected: sin errores nuevos relacionados a este archivo.

- [ ] **Step 3: Commit**

```bash
git add daemon-v2/src/tools/research-competencia-ids.ts
git commit -m "feat(research-competencia): IDs de Notion de la estructura creada en Task 3"
```

---

### Task 5: Lectura/escritura a Notion

**Files:**
- Create: `daemon-v2/src/tools/research-competencia-notion.ts`
- Test: `daemon-v2/src/tools/research-competencia-notion.test.ts`

- [ ] **Step 1: Escribir el test de la única función pura de este módulo (falla primero)**

`daemon-v2/src/tools/research-competencia-notion.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildInformeReportText } from "./research-competencia-notion.js";
import type { EntityRunResult } from "./research-competencia-types.js";

function entityResult(overrides: Partial<EntityRunResult>): EntityRunResult {
  return {
    entityId: "x", entityNombre: "Entidad X", primeraCorrida: false, hallazgos: [],
    snapshot: { entityId: "x", updatedAt: "2026-08-31T00:00:00Z" },
    ...overrides,
  };
}

describe("buildInformeReportText", () => {
  it("marca primera corrida sin comparación", () => {
    const text = buildInformeReportText("2026-08-31", 7, [entityResult({ primeraCorrida: true })]);
    expect(text).toContain("Primera corrida");
  });

  it("marca sin novedades cuando no hay hallazgos", () => {
    const text = buildInformeReportText("2026-08-31", 7, [entityResult({})]);
    expect(text).toContain("Sin novedades");
  });

  it("lista cada hallazgo con su dimensión", () => {
    const text = buildInformeReportText("2026-08-31", 7, [
      entityResult({ hallazgos: [{ dimension: "Producto", descripcion: "Nueva versión 3.2", fuente: "https://x.com" }] }),
    ]);
    expect(text).toContain("[Producto] Nueva versión 3.2 (https://x.com)");
  });

  it("muestra el error si la entidad falló", () => {
    const text = buildInformeReportText("2026-08-31", 7, [entityResult({ error: "timeout" })]);
    expect(text).toContain("Error en esta corrida: timeout");
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run src/tools/research-competencia-notion.test.ts`
Expected: FAIL — módulo no existe

- [ ] **Step 3: Implementar `research-competencia-notion.ts`**

```typescript
import { callNtn } from "../shared/ntn.js";
import { CAMBIOS_DB, INFORME_DB, STATUS_PAGE_IDS } from "./research-competencia-ids.js";
import { getEntity } from "./research-competencia-entities.js";
import type { EntitySnapshot, Hallazgo, EntityRunResult } from "./research-competencia-types.js";

async function replacePageBody(pageId: string, blocks: unknown[]): Promise<void> {
  const listRes = callNtn(`v1/blocks/${pageId}/children?page_size=100`);
  if (listRes.ok) {
    const data = listRes.data as { results?: Array<{ id: string }> };
    for (const block of data.results ?? []) {
      callNtn(`v1/blocks/${block.id}`, { method: "DELETE" });
    }
  }
  callNtn(`v1/blocks/${pageId}/children`, { method: "PATCH", body: { children: blocks } });
}

function codeBlock(json: string): unknown {
  return {
    object: "block",
    type: "code",
    code: { language: "json", rich_text: [{ type: "text", text: { content: json.slice(0, 2000) } }] },
  };
}

function paragraphBlocks(text: string, chunkFn: (t: string, n: number) => string[]): unknown[] {
  return chunkFn(text, 1900).map((chunk) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
  }));
}

export async function readEntityState(entityId: string): Promise<EntitySnapshot | null> {
  const pageId = STATUS_PAGE_IDS[entityId];
  if (!pageId) throw new Error(`Sin página de estado para ${entityId}`);
  const res = callNtn(`v1/blocks/${pageId}/children?page_size=10`);
  if (!res.ok) return null;
  const data = res.data as {
    results?: Array<{ type?: string; code?: { rich_text?: Array<{ plain_text?: string }> } }>;
  };
  const found = (data.results ?? []).find((b) => b.type === "code");
  const raw = found?.code?.rich_text?.map((t) => t.plain_text ?? "").join("") ?? "";
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EntitySnapshot;
  } catch {
    return null;
  }
}

export async function writeEntityState(entityId: string, snapshot: EntitySnapshot): Promise<void> {
  const pageId = STATUS_PAGE_IDS[entityId];
  if (!pageId) throw new Error(`Sin página de estado para ${entityId}`);
  await replacePageBody(pageId, [codeBlock(JSON.stringify(snapshot, null, 2))]);
}

export async function appendCambios(
  entityId: string,
  hallazgos: Hallazgo[],
  informePageId: string,
  fecha: string,
): Promise<void> {
  const entity = getEntity(entityId);
  for (const h of hallazgos) {
    callNtn("v1/pages", {
      method: "POST",
      body: {
        parent: { database_id: CAMBIOS_DB },
        properties: {
          Hallazgo: { title: [{ text: { content: h.descripcion.slice(0, 100) } }] },
          Entidad: { select: { name: entity.nombre } },
          "Dimensión": { select: { name: h.dimension } },
          Fecha: { date: { start: fecha } },
          "Descripción": { rich_text: [{ text: { content: h.descripcion } }] },
          Fuente: h.fuente ? { url: h.fuente } : { url: null },
          Corrida: { relation: [{ id: informePageId }] },
        },
      },
    });
  }
}

export function buildInformeReportText(fecha: string, timeframeDias: number, entidades: EntityRunResult[]): string {
  const lines: string[] = [`Informe de análisis de competencia — ${fecha} (últimos ${timeframeDias} días)`, ""];
  for (const e of entidades) {
    lines.push(`— ${e.entityNombre} —`);
    if (e.error) {
      lines.push(`  Error en esta corrida: ${e.error}`);
    } else if (e.primeraCorrida) {
      lines.push("  Primera corrida — se guardó el estado inicial, sin comparación.");
    } else if (e.hallazgos.length === 0) {
      lines.push("  Sin novedades.");
    } else {
      for (const h of e.hallazgos) {
        lines.push(`  [${h.dimension}] ${h.descripcion}${h.fuente ? ` (${h.fuente})` : ""}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function createInformePage(
  fecha: string,
  timeframeDias: number,
  entidades: EntityRunResult[],
  chunkFn: (t: string, n: number) => string[],
): Promise<{ pageId: string; url: string }> {
  const totalHallazgos = entidades.reduce((sum, e) => sum + e.hallazgos.length, 0);
  const nombres = entidades.map((e) => e.entityNombre).join(", ");
  const createRes = callNtn("v1/pages", {
    method: "POST",
    body: {
      parent: { database_id: INFORME_DB },
      properties: {
        Informe: { title: [{ text: { content: `Competencia — ${fecha}` } }] },
        Fecha: { date: { start: fecha } },
        "Timeframe (días)": { number: timeframeDias },
        "Entidades incluidas": { rich_text: [{ text: { content: nombres } }] },
        Hallazgos: { number: totalHallazgos },
      },
    },
  });
  if (!createRes.ok || !createRes.data) {
    throw new Error(`No se pudo crear la página de informe: ${createRes.error}`);
  }
  const page = createRes.data as { id: string; url: string };
  const reportText = buildInformeReportText(fecha, timeframeDias, entidades);
  await replacePageBody(page.id, paragraphBlocks(reportText, chunkFn));
  return { pageId: page.id, url: page.url };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run src/tools/research-competencia-notion.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add daemon-v2/src/tools/research-competencia-notion.ts daemon-v2/src/tools/research-competencia-notion.test.ts
git commit -m "feat(research-competencia): lectura/escritura a Notion (baseline, Cambios, Informe)"
```

---

### Task 6: Prompt + parseo + ejecución del agente por entidad

**Files:**
- Create: `daemon-v2/src/tools/research-competencia-agent.ts`
- Test: `daemon-v2/src/tools/research-competencia-agent.test.ts`

- [ ] **Step 1: Escribir los tests de `buildEntityPrompt` y `parseAgentJson` (fallan primero)**

`daemon-v2/src/tools/research-competencia-agent.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildEntityPrompt, parseAgentJson } from "./research-competencia-agent.js";
import { getEntity } from "./research-competencia-entities.js";

describe("buildEntityPrompt", () => {
  it("incluye el nombre de la entidad, el timeframe y la query de LinkedIn", () => {
    const entity = getEntity("takenos");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null }, 7);
    expect(prompt).toContain("Takenos");
    expect(prompt).toContain("últimos 7 días");
    expect(prompt).toContain(entity.linkedinQuery);
  });

  it("marca explícito cuando no hay baseline (primera corrida)", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null }, 7);
    expect(prompt).toContain("sin baseline — primera corrida");
  });

  it("incluye el baseline serializado cuando existe", () => {
    const entity = getEntity("meru");
    const baseline = { entityId: "meru", updatedAt: "2026-08-01T00:00:00Z", notas: "vio rol de Growth" };
    const prompt = buildEntityPrompt(entity, baseline, { ios: null, android: null, siteText: null }, 7);
    expect(prompt).toContain("vio rol de Growth");
  });
});

describe("parseAgentJson", () => {
  it("parsea un JSON limpio", () => {
    const result = parseAgentJson('{"hallazgos":[{"dimension":"Producto","descripcion":"Nueva versión","fuente":"https://x.com"}],"notas":"ok"}');
    expect(result.hallazgos).toEqual([{ dimension: "Producto", descripcion: "Nueva versión", fuente: "https://x.com" }]);
    expect(result.notas).toBe("ok");
  });

  it("extrae el JSON aunque venga rodeado de prosa", () => {
    const result = parseAgentJson('Acá está el resultado:\n{"hallazgos":[],"notas":"nada"}\nListo.');
    expect(result.hallazgos).toEqual([]);
    expect(result.notas).toBe("nada");
  });

  it("descarta hallazgos con dimensión inválida", () => {
    const result = parseAgentJson('{"hallazgos":[{"dimension":"Inventada","descripcion":"x","fuente":""}],"notas":""}');
    expect(result.hallazgos).toEqual([]);
  });

  it("devuelve vacío si no hay JSON parseable", () => {
    const result = parseAgentJson("no hay nada acá");
    expect(result).toEqual({ hallazgos: [], notas: "" });
  });
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run src/tools/research-competencia-agent.test.ts`
Expected: FAIL — módulo no existe

- [ ] **Step 3: Implementar `research-competencia-agent.ts`**

```typescript
import { startup } from "@anthropic-ai/claude-agent-sdk";
import type { EntityConfig } from "./research-competencia-entities.js";
import type { EntitySnapshot, Hallazgo } from "./research-competencia-types.js";

export interface MechanicalFacts {
  ios: { version: string; rating: number | null; releaseNotes: string | null } | null;
  android: { version: string | null; rating: number | null; releaseNotes: string | null } | null;
  siteText: string | null;
}

export function buildEntityPrompt(
  entity: EntityConfig,
  baseline: EntitySnapshot | null,
  facts: MechanicalFacts,
  timeframeDias: number,
): string {
  const baselineText = baseline ? JSON.stringify(baseline, null, 2) : "(sin baseline — primera corrida para esta entidad)";
  return [
    `Sos un analista de inteligencia competitiva para Yape Bolivia. Estás investigando a "${entity.nombre}".`,
    `Buscá en la web (prensa boliviana y LinkedIn — consultá algo como "${entity.linkedinQuery}") novedades de los últimos ${timeframeDias} días sobre: alianzas, comunicados, posicionamiento, cambios de T&C (dimensión Estrategia); campañas, promos, canales, lanzamientos (dimensión GTM); roles nuevos publicados o posts institucionales en LinkedIn (dimensión Hiring).`,
    ``,
    `Estado anterior conocido (baseline):`,
    baselineText,
    ``,
    `Datos mecánicos NUEVOS de esta corrida (app stores + sitio web):`,
    JSON.stringify(facts, null, 2),
    ``,
    `Comparalos contra el baseline. Si hay una versión de app nueva, un rating que cambió de forma notoria, o texto de sitio con una diferencia real (no ruido de maquetación), generá un hallazgo de dimensión Producto.`,
    ``,
    `Devolvé SOLO un JSON (sin texto alrededor, sin markdown) con esta forma exacta:`,
    `{"hallazgos": [{"dimension": "Producto"|"Estrategia"|"GTM"|"Hiring", "descripcion": "string corto y concreto", "fuente": "URL o vacío"}], "notas": "string corto con contexto para la próxima corrida (ej. último rol visto en LinkedIn), o vacío"}`,
    `Si no encontrás nada relevante, devolvé {"hallazgos": [], "notas": ""}. No inventes hallazgos ni fuentes.`,
  ].join("\n");
}

export interface AgentResponse {
  hallazgos: Hallazgo[];
  notas: string;
}

const VALID_DIMENSIONS = new Set(["Producto", "Estrategia", "GTM", "Hiring"]);

export function parseAgentJson(text: string): AgentResponse {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { hallazgos: [], notas: "" };
  try {
    const parsed = JSON.parse(match[0]) as { hallazgos?: unknown[]; notas?: unknown };
    const hallazgos: Hallazgo[] = Array.isArray(parsed.hallazgos)
      ? parsed.hallazgos
          .filter(
            (h): h is { dimension: string; descripcion: string; fuente?: string } =>
              !!h &&
              typeof h === "object" &&
              VALID_DIMENSIONS.has((h as { dimension?: string }).dimension ?? "") &&
              typeof (h as { descripcion?: unknown }).descripcion === "string",
          )
          .map((h) => ({
            dimension: h.dimension as Hallazgo["dimension"],
            descripcion: h.descripcion,
            fuente: typeof h.fuente === "string" ? h.fuente : "",
          }))
      : [];
    return { hallazgos, notas: typeof parsed.notas === "string" ? parsed.notas : "" };
  } catch {
    return { hallazgos: [], notas: "" };
  }
}

export async function runEntityAgent(prompt: string): Promise<string> {
  const handle = await startup({
    options: { model: "claude-sonnet-5", maxTurns: 8, allowedTools: ["WebSearch"] },
  });
  let result = "";
  for await (const event of handle.query(prompt)) {
    if ((event as { type?: string }).type === "result" && (event as { subtype?: string }).subtype === "success") {
      result = (event as { result?: string }).result ?? "";
      break;
    }
  }
  return result;
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run src/tools/research-competencia-agent.test.ts`
Expected: PASS (7 tests) — `runEntityAgent` queda sin test unitario propio (llama al SDK real), mismo criterio que `compact.ts` en este repo, que tampoco tiene test file.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/tools/research-competencia-agent.ts daemon-v2/src/tools/research-competencia-agent.test.ts
git commit -m "feat(research-competencia): prompt, parseo y ejecución del agente one-off por entidad"
```

---

### Task 7: Orquestador + formateo del resumen

**Files:**
- Create: `daemon-v2/src/tools/research-competencia.ts`
- Test: `daemon-v2/src/tools/research-competencia.test.ts`

- [ ] **Step 1: Escribir el test del orquestador con todo mockeado (falla primero)**

`daemon-v2/src/tools/research-competencia.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./research-competencia-sources.js", () => ({
  fetchIosAppInfo: vi.fn(async () => null),
  fetchAndroidAppInfo: vi.fn(async () => null),
  fetchSiteText: vi.fn(async () => null),
  chunkText: (text: string) => [text],
}));
vi.mock("./research-competencia-agent.js", () => ({
  buildEntityPrompt: vi.fn(() => "prompt"),
  runEntityAgent: vi.fn(async () => '{"hallazgos":[],"notas":""}'),
  parseAgentJson: vi.fn((raw: string) => JSON.parse(raw)),
}));
vi.mock("./research-competencia-notion.js", () => ({
  readEntityState: vi.fn(async () => null),
  writeEntityState: vi.fn(async () => {}),
  appendCambios: vi.fn(async () => {}),
  createInformePage: vi.fn(async () => ({ pageId: "page1", url: "https://notion.so/page1" })),
}));

import { readEntityState, writeEntityState, appendCambios, createInformePage } from "./research-competencia-notion.js";
import { runEntityAgent, parseAgentJson } from "./research-competencia-agent.js";
import { runResearchCompetencia, formatSummaryHtml } from "./research-competencia.js";

const mockReadState = vi.mocked(readEntityState);
const mockWriteState = vi.mocked(writeEntityState);
const mockAppendCambios = vi.mocked(appendCambios);
const mockCreateInforme = vi.mocked(createInformePage);
const mockRunAgent = vi.mocked(runEntityAgent);
const mockParseJson = vi.mocked(parseAgentJson);

describe("runResearchCompetencia", () => {
  beforeEach(() => vi.clearAllMocks());

  it("corre las 6 entidades por default y crea la página de informe", async () => {
    const result = await runResearchCompetencia({});
    expect(result.entidades).toHaveLength(6);
    expect(mockCreateInforme).toHaveBeenCalledTimes(1);
    expect(result.informeUrl).toBe("https://notion.so/page1");
  });

  it("primera corrida (sin baseline) no genera hallazgos ni filas en Cambios, aunque el agente devuelva alguno", async () => {
    mockReadState.mockResolvedValue(null);
    mockRunAgent.mockResolvedValue('{"hallazgos":[{"dimension":"Producto","descripcion":"x","fuente":""}],"notas":""}');
    mockParseJson.mockReturnValue({ hallazgos: [{ dimension: "Producto", descripcion: "x", fuente: "" }], notas: "" });

    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });

    expect(result.entidades[0].primeraCorrida).toBe(true);
    expect(result.entidades[0].hallazgos).toEqual([]);
    expect(mockAppendCambios).not.toHaveBeenCalled();
    expect(mockWriteState).toHaveBeenCalledTimes(1);
  });

  it("corrida normal (con baseline) sí propaga los hallazgos del agente", async () => {
    mockReadState.mockResolvedValue({ entityId: "takenos", updatedAt: "2026-08-01T00:00:00Z" });
    mockRunAgent.mockResolvedValue('{"hallazgos":[{"dimension":"GTM","descripcion":"promo nueva","fuente":"https://x.com"}],"notas":""}');
    mockParseJson.mockReturnValue({ hallazgos: [{ dimension: "GTM", descripcion: "promo nueva", fuente: "https://x.com" }], notas: "" });

    const result = await runResearchCompetencia({ entidadIds: ["takenos"] });

    expect(result.entidades[0].hallazgos).toHaveLength(1);
    expect(mockAppendCambios).toHaveBeenCalledWith("takenos", result.entidades[0].hallazgos, "page1", result.fecha);
    expect(result.totalHallazgos).toBe(1);
  });

  it("una entidad que falla no interrumpe a las demás", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("boom"));

    const result = await runResearchCompetencia({ entidadIds: ["takenos", "meru"] });

    expect(result.entidades).toHaveLength(2);
    expect(result.entidades[0].error).toBe("boom");
    expect(result.entidades[1].error).toBeUndefined();
  });
});

describe("formatSummaryHtml", () => {
  it("dice 'sin novedades' cuando no hay hallazgos", () => {
    const html = formatSummaryHtml({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0 });
    expect(html).toContain("Sin novedades relevantes");
  });

  it("incluye el link al informe cuando existe", () => {
    const html = formatSummaryHtml({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0, informeUrl: "https://notion.so/x" });
    expect(html).toContain("https://notion.so/x");
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run src/tools/research-competencia.test.ts`
Expected: FAIL — módulo no existe

- [ ] **Step 3: Implementar `research-competencia.ts`**

```typescript
import { getEntity, ENTITIES } from "./research-competencia-entities.js";
import { fetchIosAppInfo, fetchAndroidAppInfo, fetchSiteText, chunkText } from "./research-competencia-sources.js";
import { buildEntityPrompt, runEntityAgent, parseAgentJson, type MechanicalFacts } from "./research-competencia-agent.js";
import { readEntityState, writeEntityState, appendCambios, createInformePage } from "./research-competencia-notion.js";
import { nowInLaPaz } from "../journal-capture.js";
import type { EntityRunResult, RunResult } from "./research-competencia-types.js";

export interface RunOpts {
  timeframeDias?: number;
  entidadIds?: string[];
}

export async function runResearchCompetencia(opts: RunOpts = {}): Promise<RunResult> {
  const timeframeDias = opts.timeframeDias ?? 7;
  const targets = opts.entidadIds?.length ? opts.entidadIds.map((id) => getEntity(id)) : ENTITIES;
  const fecha = nowInLaPaz().slice(0, 10);

  const resultados: EntityRunResult[] = [];
  for (const entity of targets) {
    try {
      const baseline = await readEntityState(entity.id);
      const [ios, android, siteText] = await Promise.all([
        entity.ios ? fetchIosAppInfo(entity.ios) : Promise.resolve(null),
        entity.android ? fetchAndroidAppInfo(entity.android.packageName) : Promise.resolve(null),
        entity.siteUrl ? fetchSiteText(entity.siteUrl) : Promise.resolve(null),
      ]);
      const facts: MechanicalFacts = {
        ios: ios ? { version: ios.version, rating: ios.rating, releaseNotes: ios.releaseNotes } : null,
        android: android ? { version: android.version, rating: android.rating, releaseNotes: android.releaseNotes } : null,
        siteText,
      };
      const prompt = buildEntityPrompt(entity, baseline, facts, timeframeDias);
      const raw = await runEntityAgent(prompt);
      const parsed = parseAgentJson(raw);

      const snapshot = {
        entityId: entity.id,
        updatedAt: new Date().toISOString(),
        ios: ios
          ? { trackId: entity.ios?.trackId, version: ios.version, rating: ios.rating ?? undefined, ratingCount: ios.ratingCount ?? undefined }
          : undefined,
        android: android
          ? { version: android.version ?? undefined, rating: android.rating ?? undefined, ratingCount: android.ratingCount ?? undefined }
          : undefined,
        siteSnippet: siteText?.slice(0, 3000),
        notas: parsed.notas,
      };

      resultados.push({
        entityId: entity.id,
        entityNombre: entity.nombre,
        primeraCorrida: baseline === null,
        hallazgos: baseline === null ? [] : parsed.hallazgos,
        snapshot,
      });
    } catch (err) {
      resultados.push({
        entityId: entity.id,
        entityNombre: entity.nombre,
        primeraCorrida: false,
        hallazgos: [],
        snapshot: { entityId: entity.id, updatedAt: new Date().toISOString() },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const { pageId: informePageId, url: informeUrl } = await createInformePage(fecha, timeframeDias, resultados, chunkText);

  for (const r of resultados) {
    if (r.error) continue;
    if (r.hallazgos.length > 0) await appendCambios(r.entityId, r.hallazgos, informePageId, fecha);
    await writeEntityState(r.entityId, r.snapshot);
  }

  const totalHallazgos = resultados.reduce((sum, r) => sum + r.hallazgos.length, 0);
  return { fecha, timeframeDias, entidades: resultados, totalHallazgos, informeUrl };
}

export function formatSummaryHtml(result: RunResult): string {
  const lines = [`🔎 <b>Research de competencia</b> — ${result.fecha} (últimos ${result.timeframeDias} días)`];
  if (result.totalHallazgos === 0) {
    lines.push("Sin novedades relevantes esta corrida.");
  } else {
    lines.push(`${result.totalHallazgos} hallazgo${result.totalHallazgos !== 1 ? "s" : ""}:`);
    for (const e of result.entidades) {
      if (e.hallazgos.length > 0) lines.push(`• <b>${e.entityNombre}</b> — ${e.hallazgos.length}`);
    }
  }
  const errores = result.entidades.filter((e) => e.error);
  if (errores.length > 0) lines.push(`⚠️ Falló: ${errores.map((e) => e.entityNombre).join(", ")}`);
  if (result.informeUrl) lines.push(`\n📄 Informe completo: ${result.informeUrl}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run src/tools/research-competencia.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add daemon-v2/src/tools/research-competencia.ts daemon-v2/src/tools/research-competencia.test.ts
git commit -m "feat(research-competencia): orquestador runResearchCompetencia + resumen HTML"
```

---

### Task 8: Cron semanal (lunes 7am)

**Files:**
- Create: `daemon-v2/src/proactive/research-competencia-weekly.ts`
- Test: `daemon-v2/src/proactive/research-competencia-weekly.test.ts`
- Modify: `daemon-v2/src/index.ts`

- [ ] **Step 1: Escribir el test (falla primero)**

`daemon-v2/src/proactive/research-competencia-weekly.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tools/research-competencia.js", () => ({
  runResearchCompetencia: vi.fn(),
  formatSummaryHtml: vi.fn(() => "resumen"),
}));
vi.mock("./rich-send.js", () => ({ sendCronMessage: vi.fn(async () => ({ message_id: 1 })) }));

import { runResearchCompetencia } from "../tools/research-competencia.js";
import { sendCronMessage } from "./rich-send.js";
import { checkResearchCompetenciaWeekly } from "./research-competencia-weekly.js";

const mockRun = vi.mocked(runResearchCompetencia);
const mockSend = vi.mocked(sendCronMessage);

describe("checkResearchCompetenciaWeekly", () => {
  beforeEach(() => vi.clearAllMocks());

  it("corre con timeframe de 7 días y manda el resumen por Telegram", async () => {
    mockRun.mockResolvedValue({ fecha: "2026-08-31", timeframeDias: 7, entidades: [], totalHallazgos: 0 });

    await checkResearchCompetenciaWeekly({ botToken: "t", chatId: 1 });

    expect(mockRun).toHaveBeenCalledWith({ timeframeDias: 7 });
    expect(mockSend).toHaveBeenCalledWith("t", { chatId: 1, text: "resumen" });
  });

  it("no tira si runResearchCompetencia falla — solo loguea", async () => {
    mockRun.mockRejectedValue(new Error("boom"));
    await expect(checkResearchCompetenciaWeekly({ botToken: "t", chatId: 1 })).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run src/proactive/research-competencia-weekly.test.ts`
Expected: FAIL — módulo no existe

- [ ] **Step 3: Implementar el cron wrapper**

`daemon-v2/src/proactive/research-competencia-weekly.ts`:

```typescript
import { runResearchCompetencia, formatSummaryHtml } from "../tools/research-competencia.js";
import { sendCronMessage } from "./rich-send.js";

export interface ResearchCompetenciaWeeklyOpts {
  botToken: string;
  chatId: number;
}

export async function checkResearchCompetenciaWeekly(opts: ResearchCompetenciaWeeklyOpts): Promise<void> {
  try {
    const result = await runResearchCompetencia({ timeframeDias: 7 });
    await sendCronMessage(opts.botToken, { chatId: opts.chatId, text: formatSummaryHtml(result) });
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_weekly_sent", totalHallazgos: result.totalHallazgos }));
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_weekly_failed", err: String(err) }));
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run src/proactive/research-competencia-weekly.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Registrar el cron en `index.ts`**

Agregar el import junto a los demás de `proactive/` (cerca de la línea 41, junto al import de `checkBooksDailyReport`):

```typescript
import { checkResearchCompetenciaWeekly } from "./proactive/research-competencia-weekly.js";
```

Agregar la función de registro, justo antes de `function scheduleBooksDailyReport()` (línea ~1891 de `index.ts`):

```typescript
function scheduleResearchCompetenciaWeekly(): void {
  cron.schedule("0 7 * * 1", () => {
    void checkResearchCompetenciaWeekly({
      botToken: env.COS_TELEGRAM_BOT_TOKEN,
      chatId: ALERT_CHAT_ID,
    }).catch((err) => log({ msg: "research_competencia_weekly_unhandled_error", err: String(err) }));
  }, { timezone: "America/La_Paz" });
  log({ msg: "research_competencia_weekly_scheduled", interval: "monday 07:00" });
}
```

Agregar la llamada en el bloque de arranque, junto a `scheduleBooksDailyReport();` (línea ~2139):

```typescript
  scheduleResearchCompetenciaWeekly();
```

- [ ] **Step 6: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: sin errores.

- [ ] **Step 7: Commit**

```bash
git add daemon-v2/src/proactive/research-competencia-weekly.ts daemon-v2/src/proactive/research-competencia-weekly.test.ts daemon-v2/src/index.ts
git commit -m "feat(research-competencia): cron semanal (lunes 7am La Paz)"
```

---

### Task 9: Tool de Telegram on-demand

**Files:**
- Modify: `daemon-v2/src/agent-tools.ts`
- Modify: `daemon-v2/src/system-prompt.ts`

- [ ] **Step 1: Agregar el import en `agent-tools.ts`**

Junto a los demás imports de `tools/`/`proactive/` (cerca de `import { fillDerivedFields } from "./proactive/kpi-ingest-notion.js";`):

```typescript
import { runResearchCompetencia, formatSummaryHtml } from "./tools/research-competencia.js";
```

- [ ] **Step 2: Agregar la tool nueva**

Dentro del array que devuelve `buildSdkTools(deps)`, junto a las demás tools de Yape (cerca de `generarKpiCardLending`):

```typescript
tool(
  "investigarCompetencia",
  [
    "Corre el research de competencia de Yape Bolivia (apps, sitios, prensa y LinkedIn de Banco Sol/Altoke, Banco Ganadero/Yolo Pago, Banco Económico/ZAS, Takenos, Meru y Peso App) y guarda el resultado en Notion (changelog + snapshot de estado + informe completo por corrida).",
    "Puede tardar 1-3 minutos (hace varias búsquedas web por entidad) — avisale a Cal que puede demorar antes de invocarla.",
    "Úsalo cuando Cal pida el research de competencia on-demand: 'corre el research de los últimos N días', 'investigá a la competencia', 'quiero el análisis de competencia de esta semana', etc.",
    "Args: { timeframeDias?: number (default 7), entidades?: string[] } — entidades es una lista de ids: bancosol-altoke, ganadero-yolopago, economico-zas, takenos, meru, peso-app. Sin especificar, corre las 6.",
    "Tras invocar, mostrale a Cal el 'resumen' que devuelve la tool (ya viene formateado) y el link al informe completo — no inventes hallazgos que no estén en el resultado.",
  ].join(" "),
  {
    timeframeDias: z.number().int().positive().max(90).optional(),
    entidades: z.array(z.string()).optional(),
  },
  async ({ timeframeDias, entidades }) => {
    const result = await runResearchCompetencia({ timeframeDias, entidadIds: entidades });
    return asText({
      status: "done",
      totalHallazgos: result.totalHallazgos,
      informeUrl: result.informeUrl,
      resumen: formatSummaryHtml(result),
    });
  },
),
```

- [ ] **Step 3: Typecheck**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npx tsc --noEmit`
Expected: sin errores. Esta tool queda auto-allowlisteada por el mapeo `sdkTools.map(t => mcp__cos-tools__${t.name})` en `index.ts` — no hace falta tocar `agent-options.ts`.

- [ ] **Step 4: Agregar la guía en `system-prompt.ts`**

Agregar una sección nueva (buscar dónde está la guía de "Tarjeta de KPIs de Yape Lending" o similar y agregar al lado, respetando el formato de las secciones vecinas):

```markdown
## Research de competencia (Yape Bolivia)

Cal puede pedir "corre el research de competencia" / "investigá a la competencia de los últimos N días". Usá la tool `investigarCompetencia`. Avisale antes que puede tardar 1-3 minutos. Al terminar, mostrale el resumen que devuelve la tool tal cual (ya viene formateado con el conteo de hallazgos por entidad y el link al informe completo en Notion) — no repitas ni inventes hallazgos que no estén en ese resumen.
```

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/agent-tools.ts daemon-v2/src/system-prompt.ts
git commit -m "feat(research-competencia): tool investigarCompetencia para Telegram on-demand"
```

---

### Task 10: Script + comando interactivo

**Files:**
- Create: `daemon-v2/scripts/research-competencia-now.ts`
- Modify: `daemon-v2/package.json`
- Create: `~/.claude/commands/research-competencia.md`

- [ ] **Step 1: Crear el script**

`daemon-v2/scripts/research-competencia-now.ts`:

```typescript
import { config as loadEnv } from "dotenv";
loadEnv({ path: `${process.env.HOME}/.cos-agent/.env` });
loadEnv({ path: `${process.env.HOME}/.claude/secrets/apps.env` });

// Fuerza auth OAuth Max (Keychain) — sin esto, si hay una API key de Tier 1 en el
// entorno, el SDK la usa y tira 429. index.ts hace esto una vez por el daemon;
// este script es un proceso aparte, así que lo repite acá.
delete process.env.ANTHROPIC_API_KEY;

import { runResearchCompetencia } from "../src/tools/research-competencia.js";
import { formatSummaryHtml } from "../src/tools/research-competencia.js";
import { stripHtmlTags } from "../src/proactive/rich-send.js";

/**
 * Corre el research de competencia fuera del cron semanal (lunes 7am).
 * `npm run research:now -- --timeframe=14 --entidades=takenos,meru`
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const timeframeArg = args.find((a) => a.startsWith("--timeframe="));
  const entidadesArg = args.find((a) => a.startsWith("--entidades="));
  const timeframeDias = timeframeArg ? Number(timeframeArg.split("=")[1]) : undefined;
  const entidadIds = entidadesArg ? entidadesArg.split("=")[1].split(",") : undefined;

  console.log("Corriendo research de competencia... (puede tardar 1-3 minutos)");
  const result = await runResearchCompetencia({ timeframeDias, entidadIds });
  console.log(stripHtmlTags(formatSummaryHtml(result)));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Agregar el script npm**

En `daemon-v2/package.json`, dentro de `"scripts"`, junto a `"kpi-card:send-now"`:

```json
    "research:now": "tsx scripts/research-competencia-now.ts"
```

- [ ] **Step 3: Smoke test manual**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run research:now -- --timeframe=7 --entidades=takenos`
Expected: imprime el progreso y termina con el resumen en texto plano, sin tags HTML. Esta es una corrida REAL contra Notion — confirmar con Cal antes de correrla la primera vez (crea filas reales en "Competencia — Cambios" si Takenos tiene baseline, o guarda el estado inicial si es la primera corrida de esa entidad).

- [ ] **Step 4: Crear el comando interactivo**

`~/.claude/commands/research-competencia.md`:

```markdown
Corre el research de competencia de Yape Bolivia (Banco Sol/Altoke, Banco Ganadero/Yolo Pago, Banco Económico/ZAS, Takenos, Meru, Peso App) para un timeframe dado y guarda el resultado en Notion.

Sintaxis: `/research-competencia [timeframe_dias] [entidad1,entidad2,...]`

## Instrucciones

1. Parsea `timeframe_dias` (número, default 7) y la lista opcional de entidades (ids válidos: `bancosol-altoke`, `ganadero-yolopago`, `economico-zas`, `takenos`, `meru`, `peso-app`) del input del usuario.
2. Avisale que puede tardar 1-3 minutos (hace varias búsquedas web por entidad) antes de correrlo.
3. Corré en la terminal:
   ```bash
   cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2"
   npm run research:now -- --timeframe=<timeframe_dias> [--entidades=<lista,separada,por,comas>]
   ```
4. Mostrale el resumen que imprime el script tal cual — no inventes hallazgos que no estén en esa salida.
```

- [ ] **Step 5: Commit (repo de Jano — el comando global queda fuera del repo, no se commitea acá)**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/scripts/research-competencia-now.ts daemon-v2/package.json
git commit -m "feat(research-competencia): script y comando interactivo on-demand"
```

---

### Task 11: Verificación final

**Files:** ninguno nuevo — solo comandos de verificación.

- [ ] **Step 1: Test suite completa**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run test`
Expected: todos los tests pasan, incluidos los 6 archivos nuevos de este plan (~30 tests) y los preexistentes sin romper.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: sin errores.

- [ ] **Step 3: Invocar el subagente `daemon-health-reviewer`**

Este repo lo pide automáticamente al tocar `agent-options.ts`/`system-prompt.ts`/`index.ts` (`Personal/Agents/CLAUDE.md`). Correrlo sobre el diff completo de este plan antes de reiniciar el daemon en producción.

- [ ] **Step 4: Reinicio del daemon (requiere confirmación explícita de Cal antes de ejecutar)**

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
tail -f ~/Library/Logs/cos-agent-v2.{out,err}.log
```

Confirmar en el log: `research_competencia_weekly_scheduled` (registro del cron) sin errores de arranque.

- [ ] **Step 5: Prueba real de la tool de Telegram**

Pedirle a Jano por Telegram "corre el research de competencia de los últimos 7 días" y confirmar: llega el resumen, el link al informe abre en Notion, y la página de informe + las páginas de estado de cada entidad tienen contenido coherente.

---

## Self-Review (hecho por el autor del plan)

**Cobertura del spec:** Fase 1 completa — 6 entidades ✓, 4 dimensiones ✓, 4 fuentes (apps/sitio/prensa/LinkedIn vía WebSearch) ✓, Notion (Cambios + 6 estados + Informe) ✓, 3 triggers (cron/Telegram/interactivo) mismo código ✓, primera corrida = baseline sin ruido ✓. Fase 2 (RRSS) queda explícitamente fuera, como dice el spec.

**Placeholders:** ninguno en código — los únicos valores "a completar" son los IDs de Notion (Task 4), que solo existen después de correr un script real (Task 3); es un paso de bootstrap normal, no una tarea sin definir.

**Consistencia de tipos:** `Hallazgo`/`EntitySnapshot`/`EntityRunResult`/`RunResult` se definen una sola vez en `research-competencia-types.ts` (Task 1) y se importan sin redeclarar en el resto de los módulos — verificado que `dimension`/`descripcion`/`fuente` se usan con el mismo nombre en `agent.ts`, `notion.ts` y `research-competencia.ts`.
