# Backlog local — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que Jano pueda mostrar el mapa de todos los backlogs del árbol de Cal, leer los pendientes de cualquiera, y agregar ítems o marcarlos como hechos desde Telegram, siempre con una tarjeta de confirmación antes de tocar disco.

**Architecture:** Cuatro módulos puros y testeables (descubrimiento, lectura, escritura, render de tarjetas) más un store en CF KV para las propuestas y un handler de callbacks. Las tools del SDK y el routing de `index.ts` son la capa delgada de arriba. Los backlogs se descubren en vivo con `find`; la seguridad la dan tres invariantes verificados en cada escritura, no una lista hardcodeada.

**Tech Stack:** TypeScript ESM, Zod (schemas de tools), Vitest, `@anthropic-ai/claude-agent-sdk`, CF KV vía `cf-kv.ts`, Telegram HTML.

**Spec:** `docs/superpowers/specs/2026-07-28-backlog-tool-y-self-learning-design.md`

**UX:** el skill `telegram-bot-ux` es parte del diseño, no una referencia. Su checklist ya se corrió
sobre estas tarjetas (ver la sección "UX" del spec) y de ahí salieron el tope de 6 opciones + escape
del picker de destino, y los 3 emojis nuevos documentados en el lexicon. **Antes de tocar
`backlog-card.ts` o cualquier texto que salga a Telegram, invocar el skill y correr su checklist de
5 puntos** — no alcanza con leer este plan.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `daemon-v2/src/backlog-types.ts` | Tipos compartidos. Sin lógica. |
| `daemon-v2/src/tools/backlog-discovery.ts` | `find` de backlogs, derivación de claves, resolución segura de path. |
| `daemon-v2/src/tools/backlog-read.ts` | Conteo de pendientes, mapa agrupado, vista compacta de un backlog. |
| `daemon-v2/src/tools/backlog-write.ts` | Append de ítem y tildado, ambos con escritura atómica. |
| `daemon-v2/src/backlog-card.ts` | Render puro de tarjetas y teclados. Sin red. |
| `daemon-v2/src/backlog-store.ts` | Propuestas pendientes en CF KV. Espeja `journal-store.ts`. |
| `daemon-v2/src/backlog-callbacks.ts` | `isBacklogCallback` + `handleBacklogCallback`. |
| `daemon-v2/src/agent-tools.ts` *(modificar)* | Registro de las 3 tools del SDK. |
| `daemon-v2/src/index.ts` *(modificar)* | Routing de `bklg:*` con lock. |
| `daemon-v2/src/system-prompt.ts` *(modificar)* | Guía de uso para el modelo. |

Comandos del repo (desde `Personal/Agents/Jano`):
- Tests: `npm run test -w @cos/daemon`
- Typecheck: `npm run typecheck -w @cos/daemon`
- Build: `npm -w @cos/shared run build && npm -w @cos/daemon run build`

---

## Task 1: Tipos compartidos

**Files:**
- Create: `daemon-v2/src/backlog-types.ts`

- [ ] **Step 1: Escribir el archivo de tipos**

```typescript
// backlog-types.ts — tipos compartidos de las tools de backlog.
// Sin lógica: lo importan discovery, read, write, card, store y callbacks.

/** Un backlog descubierto en el árbol de Cal. */
export interface BacklogEntry {
  /** Clave estable que usa el modelo, ej. "jano", "aeropuertos-bolivia". */
  key: string;
  /** Path absoluto REAL tal como lo devolvió el find (respeta mayúsculas del disco). */
  path: string;
  /** Nombre legible para Telegram, ej. "Aeropuertos Bolivia". */
  label: string;
  /** Agrupador para el mapa: "Raíz" | "Agentes" | "Apps" | "Otros". */
  group: string;
}

/** Una fila del mapa: un backlog con su conteo de pendientes. */
export interface BacklogMapRow extends BacklogEntry {
  pending: number;
}

/** Un ítem pendiente dentro de un backlog. */
export interface BacklogItem {
  /** Sección `###` que lo contiene, o "" si está suelto. */
  section: string;
  /** Texto del ítem, ya truncado para el contexto. */
  text: string;
}

/** Vista compacta de un backlog — lo que ve el modelo, nunca el archivo crudo. */
export interface CompactBacklog {
  key: string;
  label: string;
  total: number;
  items: BacklogItem[];
}

/** Resultado de intentar tildar un ítem. */
export type MarkResult =
  | { ok: true; line: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; candidates: string[] };

/** Propuesta pendiente de confirmación, guardada en CF KV. */
export interface BacklogProposal {
  kind: "add" | "done";
  /** Clave del backlog destino. */
  key: string;
  /** Texto del ítem a agregar, o texto que localiza el ítem a tildar. */
  text: string;
}
```

- [ ] **Step 2: Verificar que compila**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git add daemon-v2/src/backlog-types.ts
git commit -m "feat(backlog): tipos compartidos de las tools de backlog"
```

---

## Task 2: Descubrimiento de backlogs y derivación de claves

**Files:**
- Create: `daemon-v2/src/tools/backlog-discovery.ts`
- Test: `daemon-v2/src/tools/backlog-discovery.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverBacklogs, deriveKey, resolveBacklogPath } from "./backlog-discovery.js";

const ROOT = join(tmpdir(), "jano-test-backlog-discovery");

function write(rel: string, content = "# x\n"): void {
  const full = join(ROOT, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  write("BACKLOG.md");
  write("Personal/Agents/Jano/BACKLOG.md");
  write("Personal/Agents/Yapito/backlog.md"); // minúscula real del disco
  write("Personal/Apps/Aeropuertos Bolivia/BACKLOG.md");
  write("Claude Code Setup/BACKLOG.md");
  // Trampas: NO deben ser descubiertos.
  write("Personal/Apps/Caltable/BACKLOGS.md");
  write("Personal/Apps/Caltable/backlog.md.bak");
  mkdirSync(join(ROOT, "node_modules", "algo"), { recursive: true });
  write("node_modules/algo/BACKLOG.md");
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("discoverBacklogs", () => {
  it("encuentra los backlogs reales y ninguna trampa", () => {
    const keys = discoverBacklogs(ROOT).map((e) => e.key).sort();
    expect(keys).toEqual([
      "aeropuertos-bolivia",
      "claude-code-setup",
      "claude-projects",
      "jano",
      "yapito",
    ]);
  });

  it("conserva el path literal del disco (backlog.md en minúscula)", () => {
    const yapito = discoverBacklogs(ROOT).find((e) => e.key === "yapito");
    expect(yapito?.path.endsWith("Yapito/backlog.md")).toBe(true);
  });

  it("agrupa por la estructura de carpetas", () => {
    const byKey = new Map(discoverBacklogs(ROOT).map((e) => [e.key, e]));
    expect(byKey.get("jano")?.group).toBe("Agentes");
    expect(byKey.get("aeropuertos-bolivia")?.group).toBe("Apps");
    expect(byKey.get("claude-projects")?.group).toBe("Raíz");
    expect(byKey.get("claude-code-setup")?.group).toBe("Raíz");
  });

  it("da labels legibles", () => {
    const byKey = new Map(discoverBacklogs(ROOT).map((e) => [e.key, e]));
    expect(byKey.get("aeropuertos-bolivia")?.label).toBe("Aeropuertos Bolivia");
    expect(byKey.get("claude-projects")?.label).toBe("General");
  });
});

describe("deriveKey", () => {
  it("normaliza espacios, mayúsculas y tildes", () => {
    expect(deriveKey("Aeropuertos Bolivia")).toBe("aeropuertos-bolivia");
    expect(deriveKey("F1 Dash")).toBe("f1-dash");
    expect(deriveKey("Migración")).toBe("migracion");
  });
});

describe("resolveBacklogPath", () => {
  it("resuelve una clave conocida", () => {
    const p = resolveBacklogPath("jano", ROOT);
    expect(p.endsWith("Personal/Agents/Jano/BACKLOG.md")).toBe(true);
  });

  it("rechaza una clave desconocida", () => {
    expect(() => resolveBacklogPath("no-existe", ROOT)).toThrow(/no reconozco/i);
  });

  it("rechaza intentos de path traversal como clave", () => {
    expect(() => resolveBacklogPath("../../etc/passwd", ROOT)).toThrow(/no reconozco/i);
  });

  it("rechaza un backlog que es symlink hacia afuera del root", () => {
    const outside = join(tmpdir(), "jano-test-backlog-outside");
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "BACKLOG.md"), "# fuera\n");
    mkdirSync(join(ROOT, "Personal/Agents/Fuga"), { recursive: true });
    symlinkSync(join(outside, "BACKLOG.md"), join(ROOT, "Personal/Agents/Fuga/BACKLOG.md"));
    expect(() => resolveBacklogPath("fuga", ROOT)).toThrow(/fuera del árbol/i);
    rmSync(outside, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- backlog-discovery`
Expected: FAIL — `Cannot find module './backlog-discovery.js'`.

- [ ] **Step 3: Implementar el módulo**

```typescript
// tools/backlog-discovery.ts — descubrimiento en vivo de los BACKLOG.md del árbol de Cal.
//
// Por qué se descubre y no se lista: Cal tiene 14 backlogs hoy y agrega proyectos seguido.
// Una allowlist hardcodeada quedaría vieja en silencio, y el pedido explícito fue ver el mapa
// "desde el root hasta el último proyecto".
//
// La seguridad NO la da la lista, la dan tres invariantes verificados en cada escritura:
//   1. El modelo pasa una CLAVE, nunca una ruta.
//   2. El realpath debe seguir cayendo dentro del root.
//   3. El basename debe ser exactamente backlog.md (case-insensitive).
// El invariante 2 usa realpathSync y va ANTES de cualquier uso del path — misma lección que
// consultar-json.ts, donde validar sobre el string sin resolver dejaba pasar `..` y symlinks.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, relative, sep } from "node:path";
import type { BacklogEntry } from "../backlog-types.js";

export const BACKLOG_ROOT = `${homedir()}/Claude Projects`;

/** Mismo criterio que el find, a propósito: un solo patrón para descubrir y para validar. */
const BACKLOG_BASENAME_RE = /^backlog\.md$/i;

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; root: string; entries: BacklogEntry[] } | null = null;

/** "Aeropuertos Bolivia" → "aeropuertos-bolivia" */
export function deriveKey(folderName: string): string {
  return folderName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function groupFor(relDir: string): string {
  if (relDir === "" || relDir === ".") return "Raíz";
  const parts = relDir.split(sep);
  if (parts[0] === "Personal" && parts[1] === "Agents") return "Agentes";
  if (parts[0] === "Personal" && parts[1] === "Apps") return "Apps";
  if (parts.length === 1) return "Raíz";
  return "Otros";
}

function entryFor(path: string, root: string): BacklogEntry {
  const relDir = relative(root, dirname(path));
  const folder = relDir === "" || relDir === "." ? "General" : basename(dirname(path));
  return {
    key: relDir === "" || relDir === "." ? "claude-projects" : deriveKey(folder),
    path,
    label: folder,
    group: groupFor(relDir),
  };
}

/**
 * Enumera los backlogs bajo `root`. Cacheado 10 min: se llama en cada `mapaBacklogs` y en cada
 * resolución de clave, y un find sobre el árbol entero por tool call sería gasto puro.
 */
export function discoverBacklogs(root: string = BACKLOG_ROOT, now: number = Date.now()): BacklogEntry[] {
  if (cache && cache.root === root && now - cache.at < CACHE_TTL_MS) return cache.entries;

  let out = "";
  try {
    out = execFileSync(
      "/usr/bin/find",
      [root, "-maxdepth", "4", "-name", "node_modules", "-prune", "-o", "-iname", "backlog.md", "-print"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch {
    return cache?.entries ?? [];
  }

  const seen = new Map<string, BacklogEntry>();
  for (const line of out.split("\n")) {
    const path = line.trim();
    if (!path || !BACKLOG_BASENAME_RE.test(basename(path))) continue;
    const entry = entryFor(path, root);
    if (!entry.key) continue;
    // Colisión de claves: prefijar con la carpeta padre para desambiguar.
    if (seen.has(entry.key)) {
      const parent = basename(dirname(dirname(path)));
      entry.key = `${deriveKey(parent)}-${entry.key}`;
    }
    seen.set(entry.key, entry);
  }

  const entries = [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
  cache = { at: now, root, entries };
  return entries;
}

/** Solo para tests: invalida el cache entre casos. */
export function clearBacklogCache(): void {
  cache = null;
}

/**
 * Traduce una clave a un path absoluto seguro. Lanza si la clave no existe, si el path resuelto
 * se sale del root, o si el basename no es backlog.md.
 */
export function resolveBacklogPath(key: string, root: string = BACKLOG_ROOT): string {
  const entry = discoverBacklogs(root).find((e) => e.key === key);
  if (!entry) {
    const disponibles = discoverBacklogs(root).map((e) => e.key).join(", ");
    throw new Error(`No reconozco el backlog "${key}". Disponibles: ${disponibles}`);
  }

  const resolved = realpathSync(entry.path);
  const rootReal = realpathSync(root);
  if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
    throw new Error(`El backlog "${key}" resuelve fuera del árbol de proyectos. No lo voy a tocar.`);
  }
  if (!BACKLOG_BASENAME_RE.test(basename(resolved))) {
    throw new Error(`El backlog "${key}" no apunta a un backlog.md.`);
  }
  return resolved;
}
```

- [ ] **Step 4: Agregar `clearBacklogCache()` al setup del test**

En `backlog-discovery.test.ts`, agregar el import y llamarlo en `beforeEach` (el cache es
módulo-global y contaminaría entre casos):

```typescript
import { discoverBacklogs, deriveKey, resolveBacklogPath, clearBacklogCache } from "./backlog-discovery.js";
```

Y como primera línea del `beforeEach`:

```typescript
  clearBacklogCache();
```

- [ ] **Step 5: Correr los tests**

Run: `npm run test -w @cos/daemon -- backlog-discovery`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add daemon-v2/src/tools/backlog-discovery.ts daemon-v2/src/tools/backlog-discovery.test.ts
git commit -m "feat(backlog): descubrimiento en vivo de backlogs con resolución segura de path"
```

---

## Task 3: Lectura — conteo, mapa y vista compacta

**Files:**
- Create: `daemon-v2/src/tools/backlog-read.ts`
- Test: `daemon-v2/src/tools/backlog-read.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countPending, readBacklogCompact, buildBacklogMap } from "./backlog-read.js";
import { clearBacklogCache, discoverBacklogs } from "./backlog-discovery.js";

const ROOT = join(tmpdir(), "jano-test-backlog-read");
const SAMPLE = `# Backlog — Test

## Pendientes

### Sección A
- [ ] **Primer ítem** con una descripción larguísima que se repite muchas veces ${"x".repeat(400)}
- [x] Ítem ya hecho
- [ ] Segundo ítem

### Sección B
- [ ] Tercer ítem
`;

function write(rel: string, content: string): void {
  const full = join(ROOT, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  clearBacklogCache();
  rmSync(ROOT, { recursive: true, force: true });
  write("Personal/Agents/Jano/BACKLOG.md", SAMPLE);
  write("Personal/Agents/Vesta/BACKLOG.md", "## Pendientes\n\n### S\n- [ ] Uno\n");
  write("Personal/Apps/Readwise/BACKLOG.md", "## Pendientes\n\n(nada)\n");
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("countPending", () => {
  it("cuenta solo las líneas sin tildar", () => {
    expect(countPending(join(ROOT, "Personal/Agents/Jano/BACKLOG.md"))).toBe(3);
  });

  it("devuelve 0 en un backlog sin pendientes", () => {
    expect(countPending(join(ROOT, "Personal/Apps/Readwise/BACKLOG.md"))).toBe(0);
  });
});

describe("readBacklogCompact", () => {
  it("devuelve solo pendientes, con su sección", () => {
    const c = readBacklogCompact(join(ROOT, "Personal/Agents/Jano/BACKLOG.md"), "jano", "Jano");
    expect(c.total).toBe(3);
    expect(c.items).toHaveLength(3);
    expect(c.items[0].section).toBe("Sección A");
    expect(c.items[2].section).toBe("Sección B");
    expect(c.items.some((i) => i.text.includes("Ítem ya hecho"))).toBe(false);
  });

  it("trunca los ítems largos para no disparar el persisted-output loop", () => {
    const c = readBacklogCompact(join(ROOT, "Personal/Agents/Jano/BACKLOG.md"), "jano", "Jano");
    expect(c.items[0].text.length).toBeLessThanOrEqual(203);
    expect(c.items[0].text.endsWith("…")).toBe(true);
  });

  it("la vista completa queda muy por debajo de 25 KB", () => {
    const c = readBacklogCompact(join(ROOT, "Personal/Agents/Jano/BACKLOG.md"), "jano", "Jano");
    expect(JSON.stringify(c).length).toBeLessThan(25_000);
  });
});

describe("buildBacklogMap", () => {
  it("agrupa y cuenta, incluyendo los que están en cero", () => {
    const rows = buildBacklogMap(discoverBacklogs(ROOT));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("jano")?.pending).toBe(3);
    expect(byKey.get("vesta")?.pending).toBe(1);
    expect(byKey.get("readwise")?.pending).toBe(0);
    expect(byKey.get("readwise")?.group).toBe("Apps");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- backlog-read`
Expected: FAIL — `Cannot find module './backlog-read.js'`.

- [ ] **Step 3: Implementar el módulo**

```typescript
// tools/backlog-read.ts — lectura de backlogs: conteo, mapa y vista compacta.
//
// La vista es COMPACTA a propósito. El BACKLOG.md de Jano son 287 líneas (~30 KB), por encima
// del umbral de ~25 KB en el que el SDK persiste el tool result a disco y el modelo entra en el
// loop de reintentos (gotcha documentado en CLAUDE.md). Mismo criterio que compactJournalRows.

import { readFileSync } from "node:fs";
import type { BacklogEntry, BacklogMapRow, CompactBacklog, BacklogItem } from "../backlog-types.js";

const PENDING_RE = /^\s*-\s\[ \]\s?(.*)$/;
const DONE_RE = /^\s*-\s\[[xX]\]/;
const SECTION_RE = /^###\s+(.*)$/;
/** Tope por ítem. Suficiente para reconocerlo y decidir, sin arrastrar párrafos enteros. */
const MAX_ITEM_CHARS = 200;

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
}

export function countPending(path: string): number {
  return readLines(path).filter((l) => PENDING_RE.test(l)).length;
}

export function readBacklogCompact(path: string, key: string, label: string): CompactBacklog {
  const items: BacklogItem[] = [];
  let section = "";

  for (const line of readLines(path)) {
    const sec = SECTION_RE.exec(line);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    if (DONE_RE.test(line)) continue;
    const m = PENDING_RE.exec(line);
    if (!m) continue;
    const raw = m[1].trim();
    items.push({
      section,
      text: raw.length > MAX_ITEM_CHARS ? `${raw.slice(0, MAX_ITEM_CHARS)}…` : raw,
    });
  }

  return { key, label, total: items.length, items };
}

export function buildBacklogMap(entries: BacklogEntry[]): BacklogMapRow[] {
  return entries.map((e) => ({ ...e, pending: countPending(e.path) }));
}
```

- [ ] **Step 4: Correr los tests**

Run: `npm run test -w @cos/daemon -- backlog-read`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/tools/backlog-read.ts daemon-v2/src/tools/backlog-read.test.ts
git commit -m "feat(backlog): lectura compacta, conteo de pendientes y mapa agrupado"
```

---

## Task 4: Escritura — append atómico y tildado

**Files:**
- Create: `daemon-v2/src/tools/backlog-write.ts`
- Test: `daemon-v2/src/tools/backlog-write.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendBacklogItem, markBacklogDone } from "./backlog-write.js";

const DIR = join(tmpdir(), "jano-test-backlog-write");
const FILE = join(DIR, "BACKLOG.md");

const BASE = `# Backlog — Test

## Pendientes

### Sección vieja
- [ ] Ítem viejo
- [ ] Otro ítem viejo

## Completados
- [x] Algo hecho
`;

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, BASE);
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("appendBacklogItem", () => {
  it("crea la sección del día justo debajo de ## Pendientes", () => {
    appendBacklogItem(FILE, "Idea nueva", "2026-07-28");
    const out = readFileSync(FILE, "utf8");
    expect(out).toContain("### Surgió en sesión 2026-07-28");
    expect(out).toContain("- [ ] **Idea nueva**");
    const iPend = out.indexOf("## Pendientes");
    const iNueva = out.indexOf("### Surgió en sesión 2026-07-28");
    const iVieja = out.indexOf("### Sección vieja");
    expect(iPend).toBeLessThan(iNueva);
    expect(iNueva).toBeLessThan(iVieja);
  });

  it("reusa la sección del día si ya existe", () => {
    appendBacklogItem(FILE, "Primera", "2026-07-28");
    appendBacklogItem(FILE, "Segunda", "2026-07-28");
    const out = readFileSync(FILE, "utf8");
    expect(out.match(/### Surgió en sesión 2026-07-28/g)).toHaveLength(1);
    expect(out.indexOf("Primera")).toBeLessThan(out.indexOf("Segunda"));
  });

  it("no toca el contenido preexistente", () => {
    appendBacklogItem(FILE, "Idea nueva", "2026-07-28");
    const out = readFileSync(FILE, "utf8");
    expect(out).toContain("- [ ] Ítem viejo");
    expect(out).toContain("- [x] Algo hecho");
    expect(out).toContain("### Sección vieja");
  });

  it("agrega al final si no hay ## Pendientes", () => {
    writeFileSync(FILE, "# Solo un título\n");
    appendBacklogItem(FILE, "Idea suelta", "2026-07-28");
    const out = readFileSync(FILE, "utf8");
    expect(out).toContain("# Solo un título");
    expect(out.trimEnd().endsWith("- [ ] **Idea suelta**")).toBe(true);
  });
});

describe("markBacklogDone", () => {
  it("tilda el ítem cuando hay exactamente una coincidencia", () => {
    const res = markBacklogDone(FILE, "Otro ítem viejo");
    expect(res.ok).toBe(true);
    const out = readFileSync(FILE, "utf8");
    expect(out).toContain("- [x] Otro ítem viejo");
    expect(out).toContain("- [ ] Ítem viejo");
  });

  it("falla explícito si no encuentra nada", () => {
    const res = markBacklogDone(FILE, "no existe esto");
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(readFileSync(FILE, "utf8")).toBe(BASE);
  });

  it("falla explícito y lista candidatos si hay más de una coincidencia", () => {
    const res = markBacklogDone(FILE, "ítem viejo");
    expect(res.ok).toBe(false);
    if (res.ok === false && res.reason === "ambiguous") {
      expect(res.candidates).toHaveLength(2);
    } else {
      throw new Error("esperaba ambiguous");
    }
    expect(readFileSync(FILE, "utf8")).toBe(BASE);
  });

  it("no tilda un ítem ya tildado", () => {
    const res = markBacklogDone(FILE, "Algo hecho");
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- backlog-write`
Expected: FAIL — `Cannot find module './backlog-write.js'`.

- [ ] **Step 3: Implementar el módulo**

```typescript
// tools/backlog-write.ts — las dos únicas escrituras permitidas sobre un backlog.
//
// Append de ítems nuevos y tildado de existentes. NUNCA edición libre de líneas: el riesgo de que
// el modelo reformatee o pierda contenido de un archivo de 287 líneas no vale la flexibilidad
// (decisión de Cal en el spec).
//
// Escritura atómica (temporal + rename) porque este daemon corre semanas seguidas y muere por
// launchd sin aviso: un writeFileSync interrumpido dejaría el BACKLOG.md truncado.

import { renameSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { MarkResult } from "../backlog-types.js";

const PENDING_RE = /^(\s*-\s)\[ \](\s?.*)$/;

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* el temporal puede no existir */
    }
    throw e;
  }
}

function sectionHeading(fecha: string): string {
  return `### Surgió en sesión ${fecha}`;
}

/**
 * Agrega un ítem bajo la sección del día, creándola si hace falta.
 * `fecha` en formato YYYY-MM-DD; se pasa desde afuera para que el test sea determinista.
 */
export function appendBacklogItem(path: string, texto: string, fecha: string): void {
  const lines = readFileSync(path, "utf8").split("\n");
  const heading = sectionHeading(fecha);
  const item = `- [ ] **${texto.trim()}**`;

  const idxSection = lines.findIndex((l) => l.trim() === heading);
  if (idxSection >= 0) {
    // Insertar al final de la sección existente: justo antes del próximo ## o ###.
    let end = lines.length;
    for (let i = idxSection + 1; i < lines.length; i++) {
      if (/^#{2,3}\s/.test(lines[i])) {
        end = i;
        break;
      }
    }
    while (end > idxSection + 1 && lines[end - 1].trim() === "") end--;
    lines.splice(end, 0, item);
    writeAtomic(path, lines.join("\n"));
    return;
  }

  const idxPend = lines.findIndex((l) => /^##\s+Pendientes\s*$/i.test(l));
  const block = [heading, item, ""];
  if (idxPend >= 0) {
    let at = idxPend + 1;
    while (at < lines.length && lines[at].trim() === "") at++;
    lines.splice(at, 0, ...block);
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(heading, item, "");
  }
  writeAtomic(path, lines.join("\n"));
}

/**
 * Tilda el único pendiente que contenga `needle`. Falla explícito con 0 o ≥2 coincidencias —
 * adivinar cuál tildar sería peor que no hacer nada.
 */
export function markBacklogDone(path: string, needle: string): MarkResult {
  const lines = readFileSync(path, "utf8").split("\n");
  const target = needle.trim().toLowerCase();
  const hits: number[] = [];

  lines.forEach((line, i) => {
    if (!PENDING_RE.test(line)) return;
    if (line.toLowerCase().includes(target)) hits.push(i);
  });

  if (hits.length === 0) return { ok: false, reason: "not_found" };
  if (hits.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      candidates: hits.map((i) => lines[i].replace(PENDING_RE, "$2").trim().slice(0, 120)),
    };
  }

  const i = hits[0];
  const original = lines[i];
  lines[i] = original.replace(PENDING_RE, "$1[x]$2");
  writeAtomic(path, lines.join("\n"));
  return { ok: true, line: lines[i].replace(/^(\s*-\s)\[[xX]\]\s?/, "").trim().slice(0, 120) };
}
```

- [ ] **Step 4: Correr los tests**

Run: `npm run test -w @cos/daemon -- backlog-write`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/tools/backlog-write.ts daemon-v2/src/tools/backlog-write.test.ts
git commit -m "feat(backlog): append de ítems y tildado con escritura atómica"
```

---

## Task 5: Render de tarjetas

**Files:**
- Create: `daemon-v2/src/backlog-card.ts`
- Test: `daemon-v2/src/backlog-card.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, expect, it } from "vitest";
import { renderBacklogMap, renderAddProposal, renderDoneProposal, renderSaved, renderDiscarded, renderDestPicker } from "./backlog-card.js";
import type { BacklogMapRow } from "./backlog-types.js";

const ROWS: BacklogMapRow[] = [
  { key: "claude-projects", path: "/x/BACKLOG.md", label: "General", group: "Raíz", pending: 3 },
  { key: "jano", path: "/x/j/BACKLOG.md", label: "Jano", group: "Agentes", pending: 12 },
  { key: "vesta", path: "/x/v/BACKLOG.md", label: "Vesta", group: "Agentes", pending: 0 },
  { key: "readwise", path: "/x/r/BACKLOG.md", label: "Readwise", group: "Apps", pending: 6 },
];

describe("renderBacklogMap", () => {
  it("muestra el total y agrupa por categoría", () => {
    const { text } = renderBacklogMap(ROWS);
    expect(text).toContain("21 pendientes");
    expect(text).toContain("<b>Raíz</b>");
    expect(text).toContain("<b>Agentes</b>");
    expect(text).toContain("<b>Apps</b>");
  });

  it("incluye los proyectos en cero", () => {
    expect(renderBacklogMap(ROWS).text).toContain("Vesta");
  });

  it("ordena cada grupo por cantidad de pendientes", () => {
    const { text } = renderBacklogMap(ROWS);
    expect(text.indexOf("Jano")).toBeLessThan(text.indexOf("Vesta"));
  });

  it("no usa bloques <pre> ni Markdown", () => {
    const { text } = renderBacklogMap(ROWS);
    expect(text).not.toContain("<pre>");
    expect(text).not.toContain("**");
    expect(text).not.toContain("---");
  });
});

describe("renderAddProposal", () => {
  it("muestra destino, texto y los cuatro botones", () => {
    const card = renderAddProposal("Jano", "Tool nueva", "abc123");
    expect(card.text).toContain("Jano");
    expect(card.text).toContain("Tool nueva");
    const datas = card.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).toEqual([
      "bklg:save:abc123",
      "bklg:edit:abc123",
      "bklg:dest:abc123",
      "bklg:drop:abc123",
    ]);
  });

  it("escapa HTML del texto de Cal", () => {
    expect(renderAddProposal("Jano", "usar <script> & cia", "abc123").text).toContain(
      "usar &lt;script&gt; &amp; cia",
    );
  });

  it("mantiene el callback_data bajo el límite de 64 bytes de Telegram", () => {
    const card = renderAddProposal("Jano", "x", "abcd1234");
    for (const b of card.keyboard.inline_keyboard.flat()) {
      expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});

describe("renderDoneProposal", () => {
  it("muestra la línea exacta que se va a tildar", () => {
    const card = renderDoneProposal("Jano", "Ítem viejo", "abc123");
    expect(card.text).toContain("Ítem viejo");
    const datas = card.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).toEqual(["bklg:save:abc123", "bklg:drop:abc123"]);
  });
});

describe("renderSaved / renderDiscarded", () => {
  it("dejan el teclado vacío", () => {
    expect(renderSaved("Jano", "Tool nueva", "add").keyboard.inline_keyboard).toEqual([]);
    expect(renderDiscarded().keyboard.inline_keyboard).toEqual([]);
  });
});

describe("renderDestPicker", () => {
  // 14 proyectos: el caso real de hoy, que es justo el que rompía el límite de Telegram.
  const MUCHOS: BacklogMapRow[] = Array.from({ length: 14 }, (_, i) => ({
    key: `p${i}`,
    path: `/x/${i}/BACKLOG.md`,
    label: `Proyecto ${i}`,
    group: "Apps",
    pending: i,
  }));

  it("respeta el límite de Telegram: máx 4 filas y 12 botones", () => {
    const kb = renderDestPicker(MUCHOS, "abc12345").keyboard.inline_keyboard;
    expect(kb.length).toBeLessThanOrEqual(4);
    expect(kb.flat().length).toBeLessThanOrEqual(12);
  });

  it("muestra los 6 con más pendientes", () => {
    const { text, keyboard } = renderDestPicker(MUCHOS, "abc12345");
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain("Proyecto 13");
    expect(labels).not.toContain("Proyecto 0");
    expect(text).toContain("8 proyectos más");
  });

  it("siempre ofrece el escape de texto libre", () => {
    const datas = renderDestPicker(MUCHOS, "abc12345").keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas.at(-1)).toBe("bklg:destother:abc12345");
  });

  it("trunca labels largos para que no hagan wrap en mobile", () => {
    const largo: BacklogMapRow[] = [
      { key: "x", path: "/x/BACKLOG.md", label: "Aeropuertos Bolivia Internacional", group: "Apps", pending: 1 },
    ];
    const label = renderDestPicker(largo, "abc12345").keyboard.inline_keyboard[0][0].text;
    expect(label.length).toBeLessThanOrEqual(16);
    expect(label.endsWith("…")).toBe(true);
  });

  it("no menciona proyectos extra cuando entran todos", () => {
    expect(renderDestPicker(ROWS, "abc12345").text).not.toContain("más");
  });

  it("mantiene el callback_data bajo 64 bytes con la clave más larga", () => {
    const largo: BacklogMapRow[] = [
      { key: "aeropuertos-bolivia-internacional", path: "/x/BACKLOG.md", label: "X", group: "Apps", pending: 1 },
    ];
    for (const b of renderDestPicker(largo, "abcd1234").keyboard.inline_keyboard.flat()) {
      expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- backlog-card`
Expected: FAIL — `Cannot find module './backlog-card.js'`.

- [ ] **Step 3: Implementar el módulo**

```typescript
// backlog-card.ts — render PURO de tarjetas y teclados del backlog.
// Sin red ni estado. Parse mode HTML (skill telegram-bot-ux): escapar solo < > &, bullets •,
// nada de Markdown ni separadores ---.
//
// Emojis de dominio (ninguno decorativo): 📋 backlog · 📝 ítem nuevo · 📁 destino · ☑️ tildar.
//
// Presupuesto de callback_data (Telegram corta a 64 bytes): el peor caso es
// `bklg:dest:{shortId8}` = 19 bytes, con margen de sobra para un selector de destino que sume
// la clave del proyecto (`bklg:destpick:{shortId8}:{key}`).

import type { BacklogMapRow } from "./backlog-types.js";

export interface Keyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface Card {
  text: string;
  keyboard: Keyboard;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const GROUP_ORDER = ["Raíz", "Agentes", "Apps", "Otros"];

export function renderBacklogMap(rows: BacklogMapRow[]): Card {
  const total = rows.reduce((a, r) => a + r.pending, 0);
  const lines: string[] = [`📋 <b>Mapa de backlogs</b> · ${total} pendientes`];

  for (const group of GROUP_ORDER) {
    const inGroup = rows
      .filter((r) => r.group === group)
      .sort((a, b) => b.pending - a.pending || a.label.localeCompare(b.label));
    if (inGroup.length === 0) continue;
    lines.push("", `<b>${esc(group)}</b>`);
    for (const r of inGroup) lines.push(`• 📋 ${esc(r.label)} — ${r.pending}`);
  }

  return { text: lines.join("\n"), keyboard: { inline_keyboard: [] } };
}

export function renderAddProposal(destino: string, texto: string, shortId: string): Card {
  return {
    text: [
      "📝 <b>Nueva idea para el backlog</b>",
      "",
      `📁 ${esc(destino)}`,
      `«${esc(texto)}»`,
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          { text: "✅ Guardar", callback_data: `bklg:save:${shortId}` },
          { text: "✏️ Editar texto", callback_data: `bklg:edit:${shortId}` },
        ],
        [
          { text: "📁 Cambiar proyecto", callback_data: `bklg:dest:${shortId}` },
          { text: "❌ Descartar", callback_data: `bklg:drop:${shortId}` },
        ],
      ],
    },
  };
}

export function renderDoneProposal(destino: string, linea: string, shortId: string): Card {
  return {
    text: [
      "☑️ <b>Marcar como hecho</b>",
      "",
      `📁 ${esc(destino)}`,
      `«${esc(linea)}»`,
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          { text: "✅ Confirmar", callback_data: `bklg:save:${shortId}` },
          { text: "❌ Descartar", callback_data: `bklg:drop:${shortId}` },
        ],
      ],
    },
  };
}

export function renderSaved(destino: string, texto: string, kind: "add" | "done"): Card {
  const head = kind === "add" ? "📝 <b>Anotado</b>" : "☑️ <b>Marcado como hecho</b>";
  return {
    text: [head, "", `📁 ${esc(destino)}`, `«${esc(texto)}»`].join("\n"),
    keyboard: { inline_keyboard: [] },
  };
}

export function renderDiscarded(): Card {
  return { text: "❌ <b>Descartado</b> · no anoté nada.", keyboard: { inline_keyboard: [] } };
}

/**
 * Selector de destino (bloque B3 del framework: picker con escape).
 *
 * Tope DURO de 6 opciones en 3 filas de 2, más la fila de escape = 4 filas / 7 botones.
 * Hay 14 backlogs y creciendo: una fila por proyecto daría 14 filas, muy por encima del
 * límite de 4 filas / 12 botones de Telegram (arriba de eso hay stutter en iOS).
 *
 * Los 6 que se muestran son los de más pendientes — los proyectos activos son los destinos
 * probables. El resto se alcanza por el escape de texto libre, que SIEMPRE está presente.
 */
const DEST_MAX_BOTONES = 6;
/** Los botones van de a 2 por fila, así que el label debe entrar en ~18 chars. */
const DEST_LABEL_MAX = 16;

export function renderDestPicker(rows: BacklogMapRow[], shortId: string): Card {
  const sorted = [...rows].sort((a, b) => b.pending - a.pending || a.label.localeCompare(b.label));
  const visibles = sorted.slice(0, DEST_MAX_BOTONES);

  const filas: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < visibles.length; i += 2) {
    filas.push(
      visibles.slice(i, i + 2).map((r) => ({
        text:
          r.label.length > DEST_LABEL_MAX ? `${r.label.slice(0, DEST_LABEL_MAX - 1)}…` : r.label,
        callback_data: `bklg:destpick:${shortId}:${r.key}`,
      })),
    );
  }
  filas.push([{ text: "✍️ Otro proyecto", callback_data: `bklg:destother:${shortId}` }]);

  const lines = ["📁 <b>¿A qué proyecto lo mando?</b>"];
  if (sorted.length > visibles.length) {
    lines.push("", `<i>Hay ${sorted.length - visibles.length} proyectos más — usa ✍️ y escribe el nombre.</i>`);
  }

  return { text: lines.join("\n"), keyboard: { inline_keyboard: filas } };
}
```

- [ ] **Step 4: Correr los tests**

Run: `npm run test -w @cos/daemon -- backlog-card`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/backlog-card.ts daemon-v2/src/backlog-card.test.ts
git commit -m "feat(backlog): render puro de tarjetas y teclados"
```

---

## Task 6: Store de propuestas en CF KV

**Files:**
- Create: `daemon-v2/src/backlog-store.ts`
- Test: `daemon-v2/src/backlog-store.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, expect, it } from "vitest";
import { BacklogStore } from "./backlog-store.js";
import type { CfKv } from "./cf-kv.js";

/** CfKv de mentira: un Map, suficiente para verificar claves y round-trip. */
function fakeKv(): CfKv & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T>(k: string): Promise<T | null> {
      return (store.get(k) as T) ?? null;
    },
    async set(k: string, v: unknown): Promise<void> {
      store.set(k, v);
    },
    async delete(k: string): Promise<void> {
      store.delete(k);
    },
  } as unknown as CfKv & { store: Map<string, unknown> };
}

describe("BacklogStore", () => {
  it("guarda y recupera una propuesta", async () => {
    const kv = fakeKv();
    const s = new BacklogStore(kv);
    const id = await s.createProposal(42, { kind: "add", key: "jano", text: "Idea" });
    expect(await s.getProposal(42, id)).toEqual({ kind: "add", key: "jano", text: "Idea" });
  });

  it("aísla por chat", async () => {
    const kv = fakeKv();
    const s = new BacklogStore(kv);
    const id = await s.createProposal(42, { kind: "add", key: "jano", text: "Idea" });
    expect(await s.getProposal(99, id)).toBeNull();
  });

  it("usa un shortId de 8 caracteres, para que quepa el callback_data", async () => {
    const kv = fakeKv();
    const s = new BacklogStore(kv);
    const id = await s.createProposal(42, { kind: "add", key: "jano", text: "Idea" });
    expect(id).toHaveLength(8);
  });

  it("permite cambiar el destino conservando el id", async () => {
    const kv = fakeKv();
    const s = new BacklogStore(kv);
    const id = await s.createProposal(42, { kind: "add", key: "jano", text: "Idea" });
    await s.updateProposal(42, id, { kind: "add", key: "vesta", text: "Idea" });
    expect((await s.getProposal(42, id))?.key).toBe("vesta");
  });

  it("borra la propuesta", async () => {
    const kv = fakeKv();
    const s = new BacklogStore(kv);
    const id = await s.createProposal(42, { kind: "add", key: "jano", text: "Idea" });
    await s.clearProposal(42, id);
    expect(await s.getProposal(42, id)).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- backlog-store`
Expected: FAIL — `Cannot find module './backlog-store.js'`.

- [ ] **Step 3: Implementar el módulo**

```typescript
// backlog-store.ts — propuestas de backlog pendientes de confirmación, en CF KV.
// Espejo reducido de journal-store.ts (que a su vez espeja proposal-store.ts de Pecunia).

import type { CfKv } from "./cf-kv.js";
import type { BacklogProposal } from "./backlog-types.js";

/** 1 hora: Cal puede dictar una idea y tocar el botón un rato después. */
const PROPOSAL_TTL_SEC = 3600;

export class BacklogStore {
  constructor(private kv: CfKv) {}

  private propKey(chatId: number, shortId: string): string {
    return `jano:backlog:prop:${chatId}:${shortId}`;
  }

  /** shortId de 8 chars: `bklg:destpick:{8}:{key}` queda holgado bajo los 64 bytes de Telegram. */
  async createProposal(chatId: number, payload: BacklogProposal): Promise<string> {
    const shortId = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
    await this.kv.set(this.propKey(chatId, shortId), payload, PROPOSAL_TTL_SEC);
    return shortId;
  }

  async getProposal(chatId: number, shortId: string): Promise<BacklogProposal | null> {
    return await this.kv.get<BacklogProposal>(this.propKey(chatId, shortId));
  }

  async updateProposal(chatId: number, shortId: string, payload: BacklogProposal): Promise<void> {
    await this.kv.set(this.propKey(chatId, shortId), payload, PROPOSAL_TTL_SEC);
  }

  async clearProposal(chatId: number, shortId: string): Promise<void> {
    await this.kv.delete(this.propKey(chatId, shortId));
  }
}
```

- [ ] **Step 4: Correr los tests**

Run: `npm run test -w @cos/daemon -- backlog-store`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/backlog-store.ts daemon-v2/src/backlog-store.test.ts
git commit -m "feat(backlog): store de propuestas en CF KV"
```

---

## Task 7: Handler de callbacks

**Files:**
- Create: `daemon-v2/src/backlog-callbacks.ts`
- Test: `daemon-v2/src/backlog-callbacks.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBacklogCallback, handleBacklogCallback } from "./backlog-callbacks.js";
import { BacklogStore } from "./backlog-store.js";
import { clearBacklogCache } from "./tools/backlog-discovery.js";
import type { CfKv } from "./cf-kv.js";

const ROOT = join(tmpdir(), "jano-test-backlog-cb");
const JANO = join(ROOT, "Personal/Agents/Jano/BACKLOG.md");

function fakeKv(): CfKv {
  const store = new Map<string, unknown>();
  return {
    async get<T>(k: string): Promise<T | null> {
      return (store.get(k) as T) ?? null;
    },
    async set(k: string, v: unknown): Promise<void> {
      store.set(k, v);
    },
    async delete(k: string): Promise<void> {
      store.delete(k);
    },
  } as unknown as CfKv;
}

/**
 * Captura los edits que el handler manda a Telegram, sin tocar la red.
 * Guarda también el keyboard: el anti-pattern #23 del skill telegram-bot-ux es justamente que
 * `editMessageText` PRESERVA el teclado viejo si `reply_markup` se omite, así que los tests
 * tienen que poder afirmar que se mandó `{inline_keyboard: []}` explícito.
 */
function fakeDeps(store: BacklogStore) {
  const edits: Array<{ text: string; keyboard?: unknown }> = [];
  return {
    edits,
    deps: {
      store,
      root: ROOT,
      today: "2026-07-28",
      log: () => {},
      editCard: async (_chatId: number, _messageId: number, text: string, keyboard?: unknown) => {
        edits.push({ text, keyboard });
      },
    },
  };
}

beforeEach(() => {
  clearBacklogCache();
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, "Personal/Agents/Jano"), { recursive: true });
  writeFileSync(JANO, "# Backlog\n\n## Pendientes\n\n### Vieja\n- [ ] Ítem viejo\n");
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("isBacklogCallback", () => {
  it("reconoce los prefijos propios y solo esos", () => {
    expect(isBacklogCallback("bklg:save:abc12345")).toBe(true);
    expect(isBacklogCallback("bklg:drop:abc12345")).toBe(true);
    expect(isBacklogCallback("j:menu")).toBe(false);
    expect(isBacklogCallback(undefined)).toBe(false);
  });
});

describe("handleBacklogCallback", () => {
  it("bklg:save escribe el ítem y confirma", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea nueva" });

    await handleBacklogCallback(deps, 1, 10, `bklg:save:${id}`);

    expect(readFileSync(JANO, "utf8")).toContain("- [ ] **Idea nueva**");
    expect(edits.at(-1)?.text).toContain("Anotado");
    expect(await store.getProposal(1, id)).toBeNull();
  });

  it("bklg:drop no escribe nada", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const before = readFileSync(JANO, "utf8");
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea nueva" });

    await handleBacklogCallback(deps, 1, 10, `bklg:drop:${id}`);

    expect(readFileSync(JANO, "utf8")).toBe(before);
    expect(edits.at(-1)?.text).toContain("Descartado");
  });

  it("bklg:destpick cambia el destino sin escribir todavía", async () => {
    mkdirSync(join(ROOT, "Personal/Agents/Vesta"), { recursive: true });
    writeFileSync(join(ROOT, "Personal/Agents/Vesta/BACKLOG.md"), "## Pendientes\n");
    clearBacklogCache();
    const store = new BacklogStore(fakeKv());
    const { deps } = fakeDeps(store);
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea" });

    await handleBacklogCallback(deps, 1, 10, `bklg:destpick:${id}:vesta`);

    expect((await store.getProposal(1, id))?.key).toBe("vesta");
    expect(readFileSync(JANO, "utf8")).not.toContain("Idea");
  });

  it("bklg:destother quita el teclado y lista las claves, sin escribir", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const before = readFileSync(JANO, "utf8");
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea" });

    await handleBacklogCallback(deps, 1, 10, `bklg:destother:${id}`);

    expect(edits.at(-1)?.text).toContain("Escríbeme el nombre");
    expect(edits.at(-1)?.text).toContain("jano");
    // Teclado vacío EXPLÍCITO, no omitido — si no, Telegram deja vivos los botones anteriores.
    expect(edits.at(-1)?.keyboard).toEqual({ inline_keyboard: [] });
    expect(readFileSync(JANO, "utf8")).toBe(before);
  });

  it("todo cierre de tarjeta manda el teclado vacío explícito, nunca undefined", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea" });

    await handleBacklogCallback(deps, 1, 10, `bklg:save:${id}`);

    expect(edits.at(-1)?.keyboard).toEqual({ inline_keyboard: [] });
  });

  it("una propuesta expirada avisa en vez de romper", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    await handleBacklogCallback(deps, 1, 10, "bklg:save:noexiste");
    expect(edits.at(-1)?.text).toContain("expiró");
  });

  it("bklg:save de un tildado ambiguo no escribe y explica", async () => {
    writeFileSync(JANO, "## Pendientes\n\n### V\n- [ ] Ítem viejo\n- [ ] Otro ítem viejo\n");
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const id = await store.createProposal(1, { kind: "done", key: "jano", text: "ítem viejo" });

    await handleBacklogCallback(deps, 1, 10, `bklg:save:${id}`);

    expect(readFileSync(JANO, "utf8")).not.toContain("[x]");
    expect(edits.at(-1)?.text).toContain("más de un");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- backlog-callbacks`
Expected: FAIL — `Cannot find module './backlog-callbacks.js'`.

- [ ] **Step 3: Implementar el módulo**

```typescript
// backlog-callbacks.ts — callbacks bklg:* del flujo de backlog.
//
// Todos son MECÁNICOS (sin LLM) y HEAVY (escriben a disco), así que en index.ts van con el lock
// anti-doble-tap de cf-kv.ts, igual que jnl:* y mlog:/mskip:/msel:.
//
// El módulo no toca la red directamente: recibe `editCard` como dependencia para poder testear
// el flujo completo sin mockear fetch.

import {
  renderSaved,
  renderDiscarded,
  renderDestPicker,
  renderAddProposal,
  renderDoneProposal,
} from "./backlog-card.js";
import { discoverBacklogs, resolveBacklogPath } from "./tools/backlog-discovery.js";
import { buildBacklogMap } from "./tools/backlog-read.js";
import { appendBacklogItem, markBacklogDone } from "./tools/backlog-write.js";
import type { BacklogStore } from "./backlog-store.js";

export interface BacklogCallbackDeps {
  store: BacklogStore;
  /** Root del árbol de proyectos. Parametrizado para tests. */
  root: string;
  /** Fecha YYYY-MM-DD de la sección a usar. Parametrizada para tests. */
  today: string;
  log: (obj: Record<string, unknown>) => void;
  editCard: (chatId: number, messageId: number, text: string, keyboard?: unknown) => Promise<void>;
}

export function isBacklogCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith("bklg:");
}

function labelFor(key: string, root: string): string {
  return discoverBacklogs(root).find((e) => e.key === key)?.label ?? key;
}

export async function handleBacklogCallback(
  deps: BacklogCallbackDeps,
  chatId: number,
  messageId: number,
  data: string,
): Promise<void> {
  const [, action, shortId, extra] = data.split(":");
  const prop = await deps.store.getProposal(chatId, shortId);

  if (!prop) {
    await deps.editCard(chatId, messageId, "⌛ <b>Esa propuesta expiró.</b> Díctamela de nuevo.", {
      inline_keyboard: [],
    });
    return;
  }

  if (action === "drop") {
    await deps.store.clearProposal(chatId, shortId);
    const card = renderDiscarded();
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    return;
  }

  if (action === "dest") {
    const rows = buildBacklogMap(discoverBacklogs(deps.root));
    const card = renderDestPicker(rows, shortId);
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    return;
  }

  // Escape del picker (bloque B5: corte de ancla por texto). Se le quita el teclado a esta
  // tarjeta y se le pide a Cal que escriba el proyecto. Su mensaje va al LLM, que vuelve a
  // llamar proponerItemBacklog con la clave correcta y nace una tarjeta NUEVA debajo de lo que
  // Cal escribió — nunca se reescribe esta, que quedaría posicionada arriba de su mensaje.
  //
  // No se guarda estado de "esperando respuesta": el LLM ya tiene la conversación y el texto del
  // ítem está acá en el mensaje. Un pendingEdit propio sería estado extra que se puede desincronizar.
  if (action === "destother") {
    const claves = discoverBacklogs(deps.root).map((e) => `• <code>${e.key}</code>`).join("\n");
    await deps.editCard(
      chatId,
      messageId,
      `📁 <b>¿A qué proyecto?</b>\nEscríbeme el nombre y lo anoto ahí.\n\n${claves}`,
      { inline_keyboard: [] },
    );
    return;
  }

  if (action === "destpick") {
    await deps.store.updateProposal(chatId, shortId, { ...prop, key: extra });
    const label = labelFor(extra, deps.root);
    const card =
      prop.kind === "add"
        ? renderAddProposal(label, prop.text, shortId)
        : renderDoneProposal(label, prop.text, shortId);
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    return;
  }

  if (action !== "save") return;

  let path: string;
  try {
    path = resolveBacklogPath(prop.key, deps.root);
  } catch (e) {
    deps.log({ msg: "backlog_resolve_failed", key: prop.key, err: String(e) });
    await deps.editCard(chatId, messageId, `⚠️ ${e instanceof Error ? e.message : String(e)}`, {
      inline_keyboard: [],
    });
    return;
  }

  const label = labelFor(prop.key, deps.root);

  if (prop.kind === "add") {
    appendBacklogItem(path, prop.text, deps.today);
    await deps.store.clearProposal(chatId, shortId);
    const card = renderSaved(label, prop.text, "add");
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    deps.log({ msg: "backlog_item_added", key: prop.key });
    return;
  }

  const res = markBacklogDone(path, prop.text);
  if (res.ok) {
    await deps.store.clearProposal(chatId, shortId);
    const card = renderSaved(label, res.line, "done");
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    deps.log({ msg: "backlog_item_done", key: prop.key });
    return;
  }

  const msg =
    res.reason === "not_found"
      ? "⚠️ No encontré ese ítem entre los pendientes. Revisa el texto y pídemelo de nuevo."
      : `⚠️ Encontré <b>más de un</b> ítem que coincide:\n${res.candidates
          .map((c) => `• ${c.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`)
          .join("\n")}\nDime cuál con más precisión.`;
  await deps.editCard(chatId, messageId, msg, { inline_keyboard: [] });
}
```

- [ ] **Step 4: Correr los tests**

Run: `npm run test -w @cos/daemon -- backlog-callbacks`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/backlog-callbacks.ts daemon-v2/src/backlog-callbacks.test.ts
git commit -m "feat(backlog): handler de callbacks bklg:*"
```

---

## Task 8: Registrar las tools en el SDK

**Files:**
- Modify: `daemon-v2/src/agent-tools.ts`

- [ ] **Step 1: Agregar los imports**

Junto a los demás imports de `./tools/*.js` al principio del archivo:

```typescript
import { discoverBacklogs, resolveBacklogPath } from "./tools/backlog-discovery.js";
import { buildBacklogMap, readBacklogCompact } from "./tools/backlog-read.js";
import { renderBacklogMap, renderAddProposal, renderDoneProposal } from "./backlog-card.js";
import { BacklogStore } from "./backlog-store.js";
```

- [ ] **Step 2: Agregar las tres tools**

Dentro del array de tools, junto a `consultarJson` (buscar `"consultarJson",` para ubicarse):

```typescript
    tool(
      "mapaBacklogs",
      "Muestra el MAPA COMPLETO de backlogs de Cal: todos los proyectos del árbol ~/Claude Projects " +
      "con su cantidad de pendientes, agrupados por Raíz / Agentes / Apps. " +
      "Usar cuando Cal pregunte qué tiene pendiente SIN nombrar un proyecto, pida 'el mapa de backlogs', " +
      "'qué hay en los backlogs', o quiera una vista general antes de bajar a uno concreto. " +
      "Devuelve texto ya formateado para Telegram: mandalo TAL CUAL, no lo reescribas.",
      {},
      async () => asText(renderBacklogMap(buildBacklogMap(discoverBacklogs())).text),
      READ_ONLY,
    ),
    tool(
      "leerBacklog",
      "Devuelve los pendientes de UN backlog concreto, en vista compacta (solo ítems sin tildar, truncados). " +
      "Usar cuando Cal pregunte por los pendientes de un proyecto puntual, o después de mapaBacklogs para bajar al detalle. " +
      "La clave sale de mapaBacklogs (ej. 'jano', 'vesta', 'aeropuertos-bolivia'). " +
      "NO devuelve el archivo entero — si Cal necesita el texto completo de un ítem, pedíselo por nombre.",
      {
        proyecto: z.string().describe("Clave del backlog, ej. 'jano'. Si no sabés cuál, llamá mapaBacklogs primero."),
      },
      async ({ proyecto }) => {
        try {
          const path = resolveBacklogPath(proyecto);
          const entry = discoverBacklogs().find((e) => e.key === proyecto)!;
          return asText(JSON.stringify(readBacklogCompact(path, entry.key, entry.label)));
        } catch (e) {
          return asText(e instanceof Error ? e.message : String(e));
        }
      },
      READ_ONLY,
    ),
    tool(
      "proponerItemBacklog",
      "Propone AGREGAR un ítem al backlog de un proyecto, o MARCARLO como hecho. NO escribe: manda una tarjeta " +
      "a Telegram con botones para que Cal confirme, y la escritura ocurre cuando él toca ✅. " +
      "Usar cuando Cal dicte una idea, un pendiente o un 'anotá esto' durante la charla, y cuando diga que ya terminó algo. " +
      "Redactá el texto en una línea clara y accionable, en las palabras de Cal — no lo adornes ni lo alargues. " +
      "Después de llamar esta tool NO generes texto: la tarjeta es el único canal.",
      {
        proyecto: z.string().describe("Clave del backlog destino, ej. 'jano'. Ante la duda usá 'jano'; Cal puede cambiarlo con un botón."),
        texto: z.string().min(3).describe("Para accion='agregar': el ítem a anotar. Para accion='hecho': texto que identifique el ítem existente."),
        accion: z.enum(["agregar", "hecho"]).describe("'agregar' para un ítem nuevo, 'hecho' para tildar uno existente"),
      },
      async ({ proyecto, texto, accion }) => {
        try {
          const entry = discoverBacklogs().find((e) => e.key === proyecto);
          if (!entry) {
            return asText(
              `No reconozco el backlog "${proyecto}". Disponibles: ${discoverBacklogs().map((e) => e.key).join(", ")}`,
            );
          }
          const store = new BacklogStore(deps.kv);
          const kind = accion === "agregar" ? "add" : "done";
          const shortId = await store.createProposal(deps.chatId, { kind, key: proyecto, text: texto });
          const card =
            kind === "add"
              ? renderAddProposal(entry.label, texto, shortId)
              : renderDoneProposal(entry.label, texto, shortId);
          await tgSend(deps.botToken, deps.chatId, card.text, card.keyboard);
          return asText("Tarjeta enviada. No generes texto adicional.");
        } catch (e) {
          return asText(e instanceof Error ? e.message : String(e));
        }
      },
    ),
```

- [ ] **Step 3: Verificar que `deps` expone `kv` y `chatId`**

Run: `grep -n "kv\b\|chatId" daemon-v2/src/agent-tools.ts | grep -i "deps\." | head -10`

Si `deps.kv` o `deps.chatId` no existen con esos nombres, usar los reales (buscar la interfaz de
deps con `grep -n "interface.*Deps" -A 20 daemon-v2/src/agent-tools.ts`) y ajustar las dos
referencias en `proponerItemBacklog`. No inventar un campo nuevo: el store necesita el mismo `CfKv`
que ya usan las otras tools con estado.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/agent-tools.ts
git commit -m "feat(backlog): registrar mapaBacklogs, leerBacklog y proponerItemBacklog"
```

---

## Task 9: Routing de callbacks en index.ts

**Files:**
- Modify: `daemon-v2/src/index.ts`

- [ ] **Step 1: Agregar imports**

```typescript
import { isBacklogCallback, handleBacklogCallback } from "./backlog-callbacks.js";
import { BacklogStore } from "./backlog-store.js";
import { BACKLOG_ROOT } from "./tools/backlog-discovery.js";
```

- [ ] **Step 2: Instanciar el store junto a `journalStore`**

Buscar `const journalStore = new JournalStore(kv);` y agregar debajo:

```typescript
const backlogStore = new BacklogStore(kv);
```

- [ ] **Step 3: Agregar el bloque de routing**

Insertar **inmediatamente después** del bloque `if (isJournalCallback(cb.data)) { ... }` (que
termina con `return; }` alrededor de la línea 614) y **antes** de cualquier `startsWith("j:")`:

```typescript
    // Callbacks del backlog (bklg:*) → mecánicos, sin LLM. Escriben a disco, así que llevan el
    // mismo lock anti-doble-tap que jnl:* y mlog:/mskip:/msel:.
    // Va ARRIBA del `startsWith("j:")` genérico: ese bloque retorna incondicionalmente y dejaría
    // esto como código muerto sin rastro en logs (mismo motivo que j:journal).
    if (isBacklogCallback(cb.data)) {
      const bchat = cb.message.chat.id;
      const banchor = cb.message.message_id;
      const lockUserId = cb.from.id;

      const acquired = await tryAcquireLock(kv, bchat, lockUserId, MEETING_FLOW_LOCK_TTL_SEC);
      if (!acquired) {
        await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id, "⏳ Todavía estoy procesando tu toque anterior...").catch(() => {});
        return;
      }
      await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id).catch(() => {});

      // Fire-and-forget: el poll loop del daemon es estrictamente secuencial y awaitear acá
      // congelaría todos los chats mientras se escribe el archivo.
      void handleBacklogCallback(
        {
          store: backlogStore,
          root: BACKLOG_ROOT,
          today: new Date().toISOString().slice(0, 10),
          log,
          editCard: async (chatId, messageId, text, keyboard) => {
            await editMessage(
              env.COS_TELEGRAM_BOT_TOKEN,
              chatId,
              messageId,
              text,
              "HTML",
              (keyboard as { inline_keyboard: unknown[] }) ?? { inline_keyboard: [] },
            ).catch(() => {});
          },
        },
        bchat,
        banchor,
        cb.data!,
      )
        .catch((err) => log({ msg: "backlog_callback_error", err: String(err) }))
        .finally(() => releaseLock(kv, bchat, lockUserId).catch(() => {}));
      return;
    }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores. Si `editMessage` tiene otra firma, ajustar la lambda `editCard` a la firma
real (verificar con `grep -n "export async function editMessage" -A 8 shared-v2/src/telegram.ts`).

- [ ] **Step 5: Verificar el orden del routing**

Run: `grep -n "isBacklogCallback\|isJournalCallback\|startsWith(\"j:\")" daemon-v2/src/index.ts`
Expected: la línea de `isBacklogCallback` debe tener número **menor** que la de `startsWith("j:")`.

- [ ] **Step 6: Commit**

```bash
git add daemon-v2/src/index.ts
git commit -m "feat(backlog): routing de callbacks bklg:* con lock anti-doble-tap"
```

---

## Task 10: Guía en el system prompt

**Files:**
- Modify: `daemon-v2/src/system-prompt.ts`

- [ ] **Step 1: Agregar la sección**

Junto a las otras secciones de dominio (buscar `## Aprendizajes` para ubicarse y poner esta antes):

```typescript
## Backlogs de proyectos

Cal tiene un `BACKLOG.md` por proyecto en `~/Claude Projects`. Puedes verlos y escribirlos:

- \`mapaBacklogs({})\` — el mapa completo con conteos. Úsalo cuando Cal pregunte qué tiene pendiente
  SIN nombrar proyecto. Devuelve texto ya formateado: mándalo TAL CUAL.
- \`leerBacklog({ proyecto })\` — los pendientes de uno solo, compactados.
- \`proponerItemBacklog({ proyecto, texto, accion })\` — propone agregar o tildar. NO escribe:
  manda una tarjeta y Cal confirma con un botón.

Reglas:
- Cuando Cal dicte una idea, un pendiente o diga "anota esto" / "agrega al backlog", llama
  \`proponerItemBacklog\` con \`accion: "agregar"\`. Cuando diga que terminó algo, \`accion: "hecho"\`.
- Redacta el ítem en UNA línea clara y accionable, con las palabras de Cal. No lo adornes.
- Si no está claro a qué proyecto va, usa \`jano\` — Cal lo cambia con el botón 📁.
- Después de \`proponerItemBacklog\` NO generes texto: la tarjeta es el único canal.
- Nunca prometas que anotaste algo antes de que Cal toque ✅.
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores. Ojo con las comillas invertidas: dentro de un template literal hay que
escaparlas (`\``), como en el resto del archivo.

- [ ] **Step 3: Commit**

```bash
git add daemon-v2/src/system-prompt.ts
git commit -m "docs(backlog): guía de uso de las tools de backlog en el system prompt"
```

---

## Task 11: Suite completa, build y despliegue

**Files:** ninguno nuevo.

- [ ] **Step 1: Correr la suite entera**

Run: `npm run test -w @cos/daemon`
Expected: PASS. Ningún test preexistente debe romperse.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores.

- [ ] **Step 3: Review del daemon**

Invocar el subagent `daemon-health-reviewer` sobre los cambios (regla del repo: obligatorio tras
editar `index.ts`, `agent-tools.ts` o `system-prompt.ts`). Aplicar los hallazgos **blocking** antes
de seguir; anotar los **warning** en el CHANGELOG.

- [ ] **Step 4: Build**

Run: `npm -w @cos/shared run build && npm -w @cos/daemon run build`
Expected: sin errores.

- [ ] **Step 5: Pedir a Cal el restart del daemon**

El clasificador bloquea `launchctl` en sesión interactiva. Pedirle a Cal que corra, con el prefijo
`!`:

```
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
```

- [ ] **Step 6: Verificación end-to-end con Cal**

Pedirle a Cal que pruebe por Telegram, en este orden:

1. "mostrame el mapa de backlogs" → debe llegar el mapa agrupado con conteos.
2. "qué tengo pendiente en Jano" → debe llegar la lista compacta.
3. "anotá en el backlog de Jano: probar el flujo de backlog end-to-end" → debe llegar la tarjeta.
4. Tocar ✅ → confirmar que el ítem aparece en `BACKLOG.md` bajo la sección del día.
5. Tocar ✅ una segunda vez sobre la misma tarjeta → debe responder que la propuesta expiró, sin
   duplicar el ítem.

Verificar en el repo: `git diff --stat` debe mostrar solo `BACKLOG.md` modificado, sin commit.

- [ ] **Step 7: Checklist final del skill `telegram-bot-ux`**

Invocar el skill y correr su checklist de 5 puntos contra las tarjetas ya renderizadas en el chat
real (no contra el código). Verificar en particular:

- El picker de destino no supera 4 filas ni 12 botones, y muestra `✍️ Otro proyecto`.
- Ningún emoji fuera del lexicon (los 5 nuevos ya están documentados: `📝 📁 ☑️ 🔧 🧹`).
- Ninguna tarjeta cerrada conserva botones vivos (anti-pattern #23).
- Ningún mensaje huérfano en el chat tras completar un flujo.

- [ ] **Step 8: Documentar los emojis en el CLAUDE.md de Jano**

El lexicon global ya tiene las filas; falta el espejo en el proyecto (el skill exige ambos).
Agregar a `CLAUDE.md`, junto a los emojis de dominio del Journal:

```markdown
- **Emojis de dominio del backlog** (extensión del lexicon de `telegram-bot-ux`):
  `📝` ítem de backlog · `📁` proyecto destino · `☑️` marcar hecho · `📋` mapa/listado de
  pendientes. Ninguno es decorativo.
```

- [ ] **Step 9: Commit final del CHANGELOG**

Agregar la entrada del día en `CHANGELOG.md` describiendo las tres tools y el flujo de tarjeta.

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: registrar las tools de backlog en el CHANGELOG"
```

---

## Self-review de este plan

**Cobertura del spec (Parte 1):**

| Requisito del spec | Task |
|---|---|
| Descubrimiento en vivo, cacheado 10 min | 2 |
| Derivación de claves + colisiones | 2 |
| Tres invariantes de seguridad | 2 |
| `mapaBacklogs` con agrupamiento y conteos | 3, 5, 8 |
| `leerBacklog` compacto bajo 25 KB | 3, 8 |
| `proponerItemBacklog` (agregar y tildar) | 8 |
| Append bajo sección fechada, reusando la del día | 4 |
| Tildado con fallo explícito en 0 y ≥2 coincidencias | 4, 7 |
| Escritura atómica | 4 |
| Tarjeta con botones, emojis de dominio, HTML | 5 |
| Store de propuestas en KV | 6 |
| Callbacks HEAVY con lock, arriba de `j:` | 7, 9 |
| Sin auto-commit | 11 (paso 6 lo verifica) |
| Guía en el system prompt | 10 |

**Consistencia de tipos:** `BacklogEntry` / `BacklogMapRow` / `CompactBacklog` / `MarkResult` /
`BacklogProposal` se definen en Task 1 y se usan con esos mismos nombres y campos en 2, 3, 4, 5, 6 y
7. `renderAddProposal(destino, texto, shortId)` y `renderDoneProposal(destino, linea, shortId)`
tienen la misma firma en Task 5 (definición), Task 7 (uso) y Task 8 (uso).

**Riesgo conocido:** Task 8 asume `deps.kv` y `deps.chatId` en la interfaz de deps de
`agent-tools.ts`. El Step 3 de esa task obliga a verificarlo contra el código real antes de seguir,
en vez de asumirlo.
