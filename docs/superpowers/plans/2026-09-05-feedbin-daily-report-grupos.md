# Feedbin Daily Report — Clasificación Completa + Agrupado + Marcar Leído Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El cron diario de Feedbin (`checkFeedbinDailyReport`, Jano) clasifica TODO el backlog no leído (no solo los últimos 60), agrupa por tema tanto lo recomendado para abrir como lo de baja relevancia, y ofrece un botón por grupo para marcarlo como leído en bloque contra la API real de Feedbin — con deshacer de 10 minutos.

**Architecture:** Dos llamadas nuevas a Haiku por corrida (agrupar "abrir" y agrupar "saltar", cada una sobre el conjunto COMPLETO, separadas del classify por lotes de 60). El agrupado de "para abrir" es puramente informativo (links `<a href>`, sin botones). El de "marcar leído" persiste sus grupos + IDs reales en CF KV (mismo patrón `propose → botones` que journal/backlog/tareas/learnings) y expone hasta 6 botones de grupo + 1 "marcar el resto", con handler de callback que llama a la API real de Feedbin y deshace en el mismo mensaje.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (Haiku, `maxTurns:1`, sin tools), Cloudflare KV (`CfKv`), Telegram Bot API vía `@cos/shared` + `rich-send.ts`, Vitest.

Spec de referencia: `docs/superpowers/specs/2026-09-05-feedbin-daily-report-grupos-design.md`.

---

## File Structure

- **Modify** `daemon-v2/src/tools/feedbin-client.ts` — agrega `markEntriesRead`/`markEntriesUnread` (bulk, API real de Feedbin).
- **Modify** `daemon-v2/src/tools/feedbin-client.test.ts` — tests de lo anterior.
- **Create** `daemon-v2/src/proactive/feedbin-report-groups.ts` — prompt + parseo + llamada a Haiku para agrupar por tema (puro + una función con red).
- **Create** `daemon-v2/src/proactive/feedbin-report-groups.test.ts`.
- **Create** `daemon-v2/src/proactive/feedbin-report-card.ts` — render puro: sección "para abrir", selección de botones de "marcar leído", texto y teclado.
- **Create** `daemon-v2/src/proactive/feedbin-report-card.test.ts`.
- **Create** `daemon-v2/src/proactive/feedbin-report-store.ts` — estado en KV (mismo patrón que `learning-store.ts`, sin test dedicado — ver Task 4).
- **Create** `daemon-v2/src/proactive/feedbin-report-callbacks.ts` — handler de los callbacks `fbr:mark:*`/`fbr:undo:*`.
- **Create** `daemon-v2/src/proactive/feedbin-report-callbacks.test.ts`.
- **Modify** `daemon-v2/src/proactive/feedbin-daily-report.ts` — clasifica TODO el backlog en lotes, agrupa, arma la tarjeta con `FeedbinReportStore`.
- **Modify** `daemon-v2/src/proactive/feedbin-daily-report.test.ts` — cubre el nuevo flujo.
- **Modify** `daemon-v2/src/index.ts` — instancia `FeedbinReportStore`, routing de `fbr:*`, pasa `kv` a `checkFeedbinDailyReport`.

---

## Task 1: API real de Feedbin — marcar leído/no leído en bloque

**Files:**
- Modify: `daemon-v2/src/tools/feedbin-client.ts`
- Test: `daemon-v2/src/tools/feedbin-client.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `daemon-v2/src/tools/feedbin-client.test.ts` (dentro del `describe("feedbin-client", ...)` existente, antes del cierre `});`):

```ts
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
```

Agregar `markEntriesRead, markEntriesUnread` al import de `"./feedbin-client.js"` al principio del archivo (mismo import que ya trae `getSubscriptions, getTaggings, ...`).

- [ ] **Step 2: Correr los tests, confirmar que fallan**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run test -- feedbin-client`
Expected: FAIL — `markEntriesRead`/`markEntriesUnread` no exportadas todavía (`SyntaxError` o `is not a function`).

- [ ] **Step 3: Implementar**

En `daemon-v2/src/tools/feedbin-client.ts`, agregar después de la función `apiFetch` existente:

```ts
async function apiFetchMutate(path: string, method: "POST" | "DELETE", creds: FeedbinCreds, body: unknown): Promise<void> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Feedbin API ${method} ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const MARK_CHUNK_SIZE = 1000; // límite real de la API de Feedbin por request

/** Marca entradas como LEÍDAS en bloque — DELETE real contra Feedbin, no solo local. */
export async function markEntriesRead(creds: FeedbinCreds, ids: number[]): Promise<void> {
  for (let i = 0; i < ids.length; i += MARK_CHUNK_SIZE) {
    await apiFetchMutate("/unread_entries.json", "DELETE", creds, { unread_entries: ids.slice(i, i + MARK_CHUNK_SIZE) });
  }
}

/** Revierte lo anterior — usado por el botón "↩️ Deshacer". */
export async function markEntriesUnread(creds: FeedbinCreds, ids: number[]): Promise<void> {
  for (let i = 0; i < ids.length; i += MARK_CHUNK_SIZE) {
    await apiFetchMutate("/unread_entries.json", "POST", creds, { unread_entries: ids.slice(i, i + MARK_CHUNK_SIZE) });
  }
}
```

- [ ] **Step 4: Correr los tests, confirmar que pasan**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run test -- feedbin-client`
Expected: PASS — todos los tests de `feedbin-client.test.ts` (los 10 existentes + los 5 nuevos).

- [ ] **Step 5: Typecheck**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/feedbin-client.ts daemon-v2/src/tools/feedbin-client.test.ts
git commit -m "feat(jano): add bulk mark-as-read/unread against the real Feedbin API"
```

---

## Task 2: Agrupado por tema (prompt + parseo + llamada a Haiku)

**Files:**
- Create: `daemon-v2/src/proactive/feedbin-report-groups.ts`
- Test: `daemon-v2/src/proactive/feedbin-report-groups.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `daemon-v2/src/proactive/feedbin-report-groups.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ startup: vi.fn() }));

import { buildGroupingPrompt, parseGroupingResult, groupEntries } from "./feedbin-report-groups.js";
import type { FeedbinEntry } from "../tools/feedbin-client.js";

function entry(id: number, title: string): FeedbinEntry {
  return { id, feed_id: 1, title, url: "u", author: null, summary: null, published: "2026-01-01" };
}

describe("buildGroupingPrompt", () => {
  it("lists each entry with its id and title", () => {
    const prompt = buildGroupingPrompt("perfil de prueba", [entry(1, "Uno"), entry(2, "Dos")]);
    expect(prompt).toContain("perfil de prueba");
    expect(prompt).toContain("1 | Uno");
    expect(prompt).toContain("2 | Dos");
  });
});

describe("parseGroupingResult", () => {
  const validIds = new Set([1, 2, 3]);

  it("parses well-formed JSON", () => {
    const out = parseGroupingResult('{"grupos":[{"tema":"Apple","ids":[1,2]},{"tema":"Otro","ids":[3]}]}', validIds);
    expect(out).toEqual([
      { label: "Apple", entryIds: [1, 2] },
      { label: "Otro", entryIds: [3] },
    ]);
  });

  it("tolerates a markdown fence", () => {
    const out = parseGroupingResult('```json\n{"grupos":[{"tema":"Apple","ids":[1]}]}\n```', validIds);
    expect(out).toEqual([{ label: "Apple", entryIds: [1] }]);
  });

  it("drops ids not present in validIds — nunca confía en un id inventado por el modelo", () => {
    const out = parseGroupingResult('{"grupos":[{"tema":"Apple","ids":[1,999]}]}', validIds);
    expect(out).toEqual([{ label: "Apple", entryIds: [1] }]);
  });

  it("drops a group that ends up empty after filtrar ids inválidos", () => {
    const out = parseGroupingResult('{"grupos":[{"tema":"Fantasma","ids":[999]},{"tema":"Real","ids":[1]}]}', validIds);
    expect(out).toEqual([{ label: "Real", entryIds: [1] }]);
  });

  it("drops a group without tema", () => {
    const out = parseGroupingResult('{"grupos":[{"ids":[1]},{"tema":"Real","ids":[2]}]}', validIds);
    expect(out).toEqual([{ label: "Real", entryIds: [2] }]);
  });

  it("returns [] on invalid JSON or missing grupos", () => {
    expect(parseGroupingResult("not json", validIds)).toEqual([]);
    expect(parseGroupingResult('{"foo":"bar"}', validIds)).toEqual([]);
  });
});

describe("groupEntries", () => {
  it("returns [] without calling the SDK when entries is empty", async () => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const out = await groupEntries("perfil", []);
    expect(out).toEqual([]);
    expect(vi.mocked(sdk.startup)).not.toHaveBeenCalled();
  });

  it("calls Haiku and parses the result, filtering by valid ids", async () => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(sdk.startup).mockResolvedValue({
      query: async function* () {
        yield { type: "result", subtype: "success", result: '{"grupos":[{"tema":"Apple","ids":[1]}]}' };
      },
      close: vi.fn(async () => {}),
    } as never);

    const out = await groupEntries("perfil", [entry(1, "iPhone")]);

    expect(out).toEqual([{ label: "Apple", entryIds: [1] }]);
  });
});
```

- [ ] **Step 2: Correr, confirmar que falla**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run test -- feedbin-report-groups`
Expected: FAIL — `./feedbin-report-groups.js` no existe.

- [ ] **Step 3: Implementar**

Crear `daemon-v2/src/proactive/feedbin-report-groups.ts`:

```ts
// feedbin-report-groups.ts — agrupa por tema una lista de entries de Feedbin ya clasificados
// (abrir o saltar), usando el perfil de intereses como contexto. Mismo patrón que
// classifyEntries/parseClassifyResult en feedbin-daily-report.ts (Haiku, maxTurns 1, sin tools).
//
// Principio de seguridad (mismo que feedbinEntryUrl / las citas [ID] del perfil semanal):
// el link/id final SIEMPRE sale de datos que nosotros ya conocíamos, nunca de texto que el
// modelo inventó — parseGroupingResult descarta cualquier id que no esté en `validIds`.

import { startup } from "@anthropic-ai/claude-agent-sdk";
import type { FeedbinEntry } from "../tools/feedbin-client.js";

const MODEL = "claude-haiku-4-5-20251001";

export interface ThemeGroup {
  label: string;
  entryIds: number[];
}

export function buildGroupingPrompt(perfil: string, entries: FeedbinEntry[]): string {
  const lista = entries.map((e) => `${e.id} | ${e.title ?? "(sin título)"}`).join("\n");
  return [
    "Perfil de temas de interés actuales de la persona:",
    perfil,
    "",
    "Artículos (id | título):",
    lista,
    "",
    "Agrupá estos artículos en temas concretos y específicos (no genéricos como \"tecnología\").",
    "Cada artículo va en EXACTAMENTE un grupo — el que mejor calce. Un número razonable de",
    "grupos para este conjunto (ni un grupo por artículo, ni todo en un solo grupo).",
    "",
    "Devolvé SOLO un JSON, sin explicación ni fences:",
    '{"grupos":[{"tema":"...","ids":[N,N,...]}, ...]}',
  ].join("\n");
}

export function parseGroupingResult(raw: string, validIds: Set<number>): ThemeGroup[] {
  const limpio = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(limpio);
  } catch {
    return [];
  }

  const grupos = (parsed as { grupos?: unknown }).grupos;
  if (!Array.isArray(grupos)) return [];

  const out: ThemeGroup[] = [];
  for (const g of grupos as Array<Record<string, unknown>>) {
    const label = typeof g.tema === "string" ? g.tema.trim() : "";
    if (!label) continue;
    const ids = Array.isArray(g.ids)
      ? (g.ids as unknown[]).filter((id): id is number => typeof id === "number" && validIds.has(id))
      : [];
    if (ids.length === 0) continue;
    out.push({ label, entryIds: ids });
  }
  return out;
}

/** Corre la llamada real a Haiku. Sin entries, no llama al modelo. Cierra SIEMPRE el handle. */
export async function groupEntries(perfil: string, entries: FeedbinEntry[]): Promise<ThemeGroup[]> {
  if (entries.length === 0) return [];

  const validIds = new Set(entries.map((e) => e.id));
  const handle = await startup({ options: { model: MODEL, maxTurns: 1, allowedTools: [] } });
  let out = "";
  try {
    for await (const event of handle.query(buildGroupingPrompt(perfil, entries))) {
      const e = event as { type?: string; subtype?: string; result?: string };
      if (e.type === "result" && e.subtype === "success") {
        out = e.result ?? "";
        break;
      }
    }
  } finally {
    try {
      await handle.close();
    } catch {
      /* cerrar es best-effort */
    }
  }

  return parseGroupingResult(out, validIds);
}
```

- [ ] **Step 4: Correr, confirmar que pasa**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run test -- feedbin-report-groups`
Expected: PASS — 10 tests.

- [ ] **Step 5: Typecheck**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/proactive/feedbin-report-groups.ts daemon-v2/src/proactive/feedbin-report-groups.test.ts
git commit -m "feat(jano): add theme grouping for Feedbin daily report entries"
```

---

## Task 3: Render de la tarjeta (sección "para abrir" + botones de "marcar leído")

**Files:**
- Create: `daemon-v2/src/proactive/feedbin-report-card.ts`
- Test: `daemon-v2/src/proactive/feedbin-report-card.test.ts`

Este archivo importa `FeedbinReportButton` desde `feedbin-report-store.ts` (Task 4) — pero como
en TypeScript los `import type` no crean una dependencia en tiempo de ejecución, y vamos a crear
`feedbin-report-store.ts` en el próximo task, escribimos primero el tipo `FeedbinReportButton`
DENTRO de este archivo y lo movemos/reexportamos en el Task 4 para no bloquear este task. Definí
el tipo acá mismo:

- [ ] **Step 1: Escribir el test que falla**

Crear `daemon-v2/src/proactive/feedbin-report-card.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { renderAbrirSection, selectMarkButtons, buildMarkSection, buildKeyboard, buildReportText, type FeedbinReportButton } from "./feedbin-report-card.js";
import type { ThemeGroup } from "./feedbin-report-groups.js";
import type { FeedbinEntry } from "../tools/feedbin-client.js";

function entry(id: number, title: string): FeedbinEntry {
  return { id, feed_id: 1, title, url: "u", author: null, summary: null, published: "2026-01-01" };
}

function entryById(entries: FeedbinEntry[]): Map<number, FeedbinEntry> {
  return new Map(entries.map((e) => [e.id, e]));
}

describe("renderAbrirSection", () => {
  it("returns '' for no groups", () => {
    expect(renderAbrirSection([], new Map())).toBe("");
  });

  it("lists up to 5 items per group with a link, largest group first", () => {
    const entries = Array.from({ length: 7 }, (_, i) => entry(i + 1, `Título ${i + 1}`));
    const groups: ThemeGroup[] = [
      { label: "Chico", entryIds: [1] },
      { label: "Grande", entryIds: [2, 3, 4, 5, 6, 7, 100] }, // 100 no resuelve en entryById, se ignora
    ];

    const text = renderAbrirSection(groups, entryById(entries));

    const grandeIdx = text.indexOf("Grande");
    const chicoIdx = text.indexOf("Chico");
    expect(grandeIdx).toBeGreaterThanOrEqual(0);
    expect(grandeIdx).toBeLessThan(chicoIdx);
    expect(text).toContain("Grande</b> (6)"); // 100 se descarta, quedan 6 reales
    expect(text).toContain("...y 1 más");
    expect(text).toContain("Título 2");
    expect(text).not.toContain("Título 7"); // 6to item del grupo grande, fuera del tope de 5
  });

  it("escapes & < > in group labels and titles", () => {
    const entries = [entry(1, "A & B <script>")];
    const groups: ThemeGroup[] = [{ label: "Tema & raro", entryIds: [1] }];

    const text = renderAbrirSection(groups, entryById(entries));

    expect(text).toContain("Tema &amp; raro");
    expect(text).toContain("A &amp; B &lt;script&gt;");
  });
});

describe("selectMarkButtons", () => {
  it("returns one button per group, largest first, when there are 6 or fewer", () => {
    const groups: ThemeGroup[] = [
      { label: "Chico", entryIds: [1] },
      { label: "Grande", entryIds: [2, 3] },
    ];

    const buttons = selectMarkButtons(groups);

    expect(buttons).toEqual([
      { id: "g1", label: "Grande", count: 2, entryIds: [2, 3], markedAt: 0 },
      { id: "g2", label: "Chico", count: 1, entryIds: [1], markedAt: 0 },
    ]);
  });

  it("caps at 6 group buttons and folds the rest into a 'resto' bucket", () => {
    const groups: ThemeGroup[] = Array.from({ length: 8 }, (_, i) => ({
      label: `Tema ${i}`,
      entryIds: [i], // todos tamaño 1, orden estable por label
    }));

    const buttons = selectMarkButtons(groups);

    expect(buttons).toHaveLength(7); // 6 + resto
    expect(buttons[6]).toMatchObject({ id: "resto", count: 2 }); // 2 grupos sobrantes, 1 item c/u
  });

  it("does not add a 'resto' bucket when there are 6 or fewer groups", () => {
    const groups: ThemeGroup[] = Array.from({ length: 6 }, (_, i) => ({ label: `Tema ${i}`, entryIds: [i] }));
    const buttons = selectMarkButtons(groups);
    expect(buttons.find((b) => b.id === "resto")).toBeUndefined();
    expect(buttons).toHaveLength(6);
  });
});

const BTN: FeedbinReportButton = { id: "g1", label: "Rumores Apple", count: 66, entryIds: [1, 2], markedAt: 0 };

describe("buildMarkSection", () => {
  it("returns '' for no buttons", () => {
    expect(buildMarkSection([])).toBe("");
  });

  it("shows the plain label+count when unmarked", () => {
    const text = buildMarkSection([BTN]);
    expect(text).toContain("Rumores Apple (66)");
    expect(text).not.toContain("✅");
  });

  it("shows a struck-through 'marcado' line once marked", () => {
    const text = buildMarkSection([{ ...BTN, markedAt: Date.now() }]);
    expect(text).toContain("✅ <s>Rumores Apple</s> — marcado (66)");
  });
});

describe("buildKeyboard", () => {
  it("emits a mark button per unmarked group, 2 per row", () => {
    const buttons: FeedbinReportButton[] = [
      { id: "g1", label: "Uno", count: 1, entryIds: [1], markedAt: 0 },
      { id: "g2", label: "Dos", count: 1, entryIds: [2], markedAt: 0 },
      { id: "g3", label: "Tres", count: 1, entryIds: [3], markedAt: 0 },
    ];

    const kb = buildKeyboard("r1", buttons);

    expect(kb.inline_keyboard).toEqual([
      [
        { text: "✅ Uno (1)", callback_data: "fbr:mark:r1:g1" },
        { text: "✅ Dos (1)", callback_data: "fbr:mark:r1:g2" },
      ],
      [{ text: "✅ Tres (1)", callback_data: "fbr:mark:r1:g3" }],
    ]);
  });

  it("shows Deshacer within the 10-minute undo window", () => {
    const buttons: FeedbinReportButton[] = [{ ...BTN, markedAt: Date.now() - 60_000 }]; // hace 1 min
    const kb = buildKeyboard("r1", buttons);
    expect(kb.inline_keyboard).toEqual([[{ text: "↩️ Deshacer", callback_data: "fbr:undo:r1:g1" }]]);
  });

  it("drops the button entirely once the undo window expired", () => {
    const buttons: FeedbinReportButton[] = [{ ...BTN, markedAt: Date.now() - 11 * 60_000 }]; // hace 11 min
    const kb = buildKeyboard("r1", buttons);
    expect(kb.inline_keyboard).toEqual([]);
  });
});

describe("buildReportText", () => {
  it("appends the mark section when there are buttons", () => {
    const text = buildReportText("HEADER", [BTN]);
    expect(text).toBe("HEADER\n\n<b>⏭️ Marcar como leído</b>\nRumores Apple (66)");
  });

  it("returns just the header when there are no buttons", () => {
    expect(buildReportText("HEADER", [])).toBe("HEADER");
  });
});
```

- [ ] **Step 2: Correr, confirmar que falla**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run test -- feedbin-report-card`
Expected: FAIL — `./feedbin-report-card.js` no existe.

- [ ] **Step 3: Implementar**

Crear `daemon-v2/src/proactive/feedbin-report-card.ts`:

```ts
// feedbin-report-card.ts — render PURO de la tarjeta del reporte diario de Feedbin: la sección
// "para abrir" (informativa, sin botones) y la de "marcar leído" (con botones por grupo). Sin
// red ni estado — entran grupos ya resueltos, sale texto/teclado. Parse mode HTML (skill
// telegram-bot-ux): escapar solo < > &, sin Markdown.

import type { FeedbinEntry } from "../tools/feedbin-client.js";
import { feedbinEntryUrl } from "../tools/feedbin-client.js";
import type { ThemeGroup } from "./feedbin-report-groups.js";

export interface Keyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface Card {
  text: string;
  keyboard: Keyboard;
}

/** Un grupo de "marcar leído" con botón propio. `markedAt` 0 = sin marcar; si no, epoch ms de
 * cuándo se marcó (para saber si el `↩️ Deshacer` sigue dentro de su ventana de 10 min). */
export interface FeedbinReportButton {
  id: string;
  label: string;
  count: number;
  entryIds: number[];
  markedAt: number;
}

const ABRIR_ITEMS_PER_GROUP = 5;
const MAX_MARK_BUTTONS = 6;
const UNDO_TTL_MS = 10 * 60 * 1000;
const BUTTON_LABEL_MAX = 18;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateLabel(label: string): string {
  return label.length > BUTTON_LABEL_MAX ? `${label.slice(0, BUTTON_LABEL_MAX - 1)}…` : label;
}

/** Grupos más grandes primero; empate por label para un orden estable/testeable. */
function sortBySize(groups: ThemeGroup[]): ThemeGroup[] {
  return [...groups].sort((a, b) => b.entryIds.length - a.entryIds.length || a.label.localeCompare(b.label));
}

/** Sección "✅ Para abrir": TODOS los grupos, cada uno con hasta 5 links + "...y N más". */
export function renderAbrirSection(groups: ThemeGroup[], entryById: Map<number, FeedbinEntry>): string {
  if (groups.length === 0) return "";

  const lines: string[] = [];
  for (const group of sortBySize(groups)) {
    const entries = group.entryIds.map((id) => entryById.get(id)).filter((e): e is FeedbinEntry => Boolean(e));
    if (entries.length === 0) continue;
    lines.push(`<b>${esc(group.label)}</b> (${entries.length})`);
    for (const e of entries.slice(0, ABRIR_ITEMS_PER_GROUP)) {
      lines.push(`• <a href="${feedbinEntryUrl(e.id)}">${esc(e.title ?? "(sin título)")}</a>`);
    }
    if (entries.length > ABRIR_ITEMS_PER_GROUP) {
      lines.push(`<i>...y ${entries.length - ABRIR_ITEMS_PER_GROUP} más</i>`);
    }
  }
  return lines.join("\n");
}

/** Hasta MAX_MARK_BUTTONS grupos con botón propio (los más grandes); el resto se pliega en un
 * único botón "resto" si sobra algo. */
export function selectMarkButtons(groups: ThemeGroup[]): FeedbinReportButton[] {
  const sorted = sortBySize(groups);
  const top = sorted.slice(0, MAX_MARK_BUTTONS);
  const overflow = sorted.slice(MAX_MARK_BUTTONS);

  const buttons: FeedbinReportButton[] = top.map((g, i) => ({
    id: `g${i + 1}`,
    label: g.label,
    count: g.entryIds.length,
    entryIds: g.entryIds,
    markedAt: 0,
  }));

  if (overflow.length > 0) {
    buttons.push({
      id: "resto",
      label: "el resto",
      count: overflow.reduce((sum, g) => sum + g.entryIds.length, 0),
      entryIds: overflow.flatMap((g) => g.entryIds),
      markedAt: 0,
    });
  }

  return buttons;
}

/** Texto de la sección "⏭️ Marcar como leído" — refleja el estado actual (marcado o no). */
export function buildMarkSection(buttons: FeedbinReportButton[]): string {
  if (buttons.length === 0) return "";
  const lines = ["<b>⏭️ Marcar como leído</b>"];
  for (const b of buttons) {
    lines.push(
      b.markedAt > 0
        ? `✅ <s>${esc(b.label)}</s> — marcado (${b.count})`
        : `${esc(b.label)} (${b.count})`,
    );
  }
  return lines.join("\n");
}

/** Teclado inline: un botón "✅" por grupo sin marcar, "↩️ Deshacer" si se marcó hace <10 min,
 * y nada (fila más corta) si ya venció la ventana de deshacer. 2 botones por fila. */
export function buildKeyboard(reportId: string, buttons: FeedbinReportButton[]): Keyboard {
  const now = Date.now();
  const cells = buttons
    .map((b): { text: string; callback_data: string } | null => {
      if (b.markedAt === 0) {
        return { text: `✅ ${truncateLabel(b.label)} (${b.count})`, callback_data: `fbr:mark:${reportId}:${b.id}` };
      }
      if (now - b.markedAt < UNDO_TTL_MS) {
        return { text: "↩️ Deshacer", callback_data: `fbr:undo:${reportId}:${b.id}` };
      }
      return null;
    })
    .filter((c): c is { text: string; callback_data: string } => c !== null);

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(cells.slice(i, i + 2));
  return { inline_keyboard: rows };
}

/** Arma el texto completo del mensaje: header fijo (para abrir, ya renderizado) + la sección de
 * marcar leído (que sí cambia con cada mark/undo). */
export function buildReportText(headerText: string, buttons: FeedbinReportButton[]): string {
  const markSection = buildMarkSection(buttons);
  return markSection ? `${headerText}\n\n${markSection}` : headerText;
}
```

- [ ] **Step 4: Correr, confirmar que pasa**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run test -- feedbin-report-card`
Expected: PASS — 13 tests.

- [ ] **Step 5: Typecheck**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/proactive/feedbin-report-card.ts daemon-v2/src/proactive/feedbin-report-card.test.ts
git commit -m "feat(jano): render Feedbin report groups and mark-as-read keyboard"
```

---

## Task 4: Estado en KV (proposal store)

**Files:**
- Create: `daemon-v2/src/proactive/feedbin-report-store.ts`

Sin test dedicado — mismo criterio que `learning-store.ts` (que tampoco tiene uno): es un wrapper
CRUD de 3 métodos sobre `CfKv`, y se ejercita indirectamente a fondo en el Task 5 (tests de
`feedbin-report-callbacks.ts`, que usan un `FakeKv` + esta clase real).

- [ ] **Step 1: Implementar directamente (sin test propio, ver nota arriba)**

Crear `daemon-v2/src/proactive/feedbin-report-store.ts`:

```ts
// feedbin-report-store.ts — estado del reporte diario de Feedbin en CF KV. Mismo patrón que
// learning-store.ts: un documento por corrida del cron, con TTL, para que el botón de "marcar
// leído" sepa qué IDs reales tocar sin mandarlos en el callback_data (límite de 64 bytes).

import type { CfKv } from "../cf-kv.js";
import type { FeedbinReportButton } from "./feedbin-report-card.js";

/** Todo lo necesario para reconstruir el mensaje completo tras un mark/undo.
 * `headerText` es la parte que NUNCA cambia (para abrir + resumen de carpetas) — solo
 * `buttons` se actualiza cuando Cal toca un botón. */
export interface FeedbinReportProposal {
  headerText: string;
  buttons: FeedbinReportButton[];
}

/** 7 días: si Cal no confirma hoy, el botón de un reporte viejo sigue siendo válido — marcar
 * como leído es idempotente del lado de Feedbin, así que no hace falta invalidar nada. */
const REPORT_TTL_SEC = 7 * 24 * 60 * 60;

export class FeedbinReportStore {
  constructor(private kv: CfKv) {}

  private key(reportId: string): string {
    return `jano:feedbin-report:${reportId}`;
  }

  async createReport(payload: FeedbinReportProposal): Promise<string> {
    const reportId = Math.random().toString(36).slice(2, 10);
    await this.kv.set(this.key(reportId), payload, REPORT_TTL_SEC);
    return reportId;
  }

  async getReport(reportId: string): Promise<FeedbinReportProposal | null> {
    return await this.kv.get<FeedbinReportProposal>(this.key(reportId));
  }

  async updateReport(reportId: string, payload: FeedbinReportProposal): Promise<void> {
    await this.kv.set(this.key(reportId), payload, REPORT_TTL_SEC);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run typecheck`
Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/proactive/feedbin-report-store.ts
git commit -m "feat(jano): add KV proposal store for the Feedbin daily report"
```

---

## Task 5: Callbacks `fbr:mark:*` / `fbr:undo:*`

**Files:**
- Create: `daemon-v2/src/proactive/feedbin-report-callbacks.ts`
- Test: `daemon-v2/src/proactive/feedbin-report-callbacks.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `daemon-v2/src/proactive/feedbin-report-callbacks.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isFeedbinReportCallback,
  parseFeedbinReportCallback,
  handleFeedbinReportCallback,
  type FeedbinReportCallbackDeps,
} from "./feedbin-report-callbacks.js";
import { FeedbinReportStore, type FeedbinReportProposal } from "./feedbin-report-store.js";
import type { FeedbinReportButton, Card } from "./feedbin-report-card.js";

/** CfKv falso en memoria, mismo patrón que learning-callbacks.test.ts. */
class FakeKv {
  store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const BTN: FeedbinReportButton = { id: "g1", label: "Rumores Apple", count: 2, entryIds: [10, 20], markedAt: 0 };

function proposal(overrides: Partial<FeedbinReportProposal> = {}): FeedbinReportProposal {
  return { headerText: "HEADER", buttons: [BTN], ...overrides };
}

describe("isFeedbinReportCallback", () => {
  it("reconoce el prefijo fbr:", () => expect(isFeedbinReportCallback("fbr:mark:r1:g1")).toBe(true));
  it("rechaza otros prefijos", () => expect(isFeedbinReportCallback("lrn:all:b1")).toBe(false));
  it("rechaza undefined", () => expect(isFeedbinReportCallback(undefined)).toBe(false));
});

describe("parseFeedbinReportCallback", () => {
  it("parsea mark", () => {
    expect(parseFeedbinReportCallback("fbr:mark:r1:g1")).toEqual({ action: "mark", reportId: "r1", buttonId: "g1" });
  });
  it("parsea undo", () => {
    expect(parseFeedbinReportCallback("fbr:undo:r1:resto")).toEqual({ action: "undo", reportId: "r1", buttonId: "resto" });
  });
  it("rechaza una acción desconocida", () => {
    expect(parseFeedbinReportCallback("fbr:borrar:r1:g1")).toBeNull();
  });
  it("rechaza partes faltantes", () => {
    expect(parseFeedbinReportCallback("fbr:mark:r1")).toBeNull();
  });
});

describe("handleFeedbinReportCallback", () => {
  let kv: FakeKv;
  let store: FeedbinReportStore;
  let edits: Array<{ messageId: number; card: Card }>;
  let logs: Array<Record<string, unknown>>;
  let markEntriesRead: ReturnType<typeof vi.fn>;
  let markEntriesUnread: ReturnType<typeof vi.fn>;
  let deps: FeedbinReportCallbackDeps;

  beforeEach(() => {
    kv = new FakeKv();
    store = new FeedbinReportStore(kv as never);
    edits = [];
    logs = [];
    markEntriesRead = vi.fn(async () => {});
    markEntriesUnread = vi.fn(async () => {});
    deps = {
      store,
      feedbin: { username: "u", password: "p" },
      markEntriesRead,
      markEntriesUnread,
      log: (obj) => logs.push(obj),
      editCard: async (messageId, card) => {
        edits.push({ messageId, card });
      },
    };
  });

  it("fbr:mark llama a markEntriesRead con los entryIds del grupo y marca el botón", async () => {
    const reportId = await store.createReport(proposal());

    await handleFeedbinReportCallback(deps, 99, `fbr:mark:${reportId}:g1`);

    expect(markEntriesRead).toHaveBeenCalledWith({ username: "u", password: "p" }, [10, 20]);
    const saved = await store.getReport(reportId);
    expect(saved!.buttons[0]!.markedAt).toBeGreaterThan(0);
    expect(edits.at(-1)!.card.text).toContain("marcado (2)");
    expect(edits.at(-1)!.card.keyboard.inline_keyboard).toEqual([[{ text: "↩️ Deshacer", callback_data: `fbr:undo:${reportId}:g1` }]]);
  });

  it("fbr:mark no toca el KV si la API de Feedbin falla, y avisa en la tarjeta", async () => {
    markEntriesRead.mockRejectedValue(new Error("Feedbin API 500"));
    const reportId = await store.createReport(proposal());

    await handleFeedbinReportCallback(deps, 99, `fbr:mark:${reportId}:g1`);

    const saved = await store.getReport(reportId);
    expect(saved!.buttons[0]!.markedAt).toBe(0);
    expect(edits.at(-1)!.card.text).toContain("No pude marcar");
    expect(logs.some((l) => l.msg === "feedbin_report_mark_failed")).toBe(true);
  });

  it("fbr:undo dentro de la ventana de 10 min llama a markEntriesUnread y limpia el marcado", async () => {
    const reportId = await store.createReport(proposal({ buttons: [{ ...BTN, markedAt: Date.now() - 60_000 }] }));

    await handleFeedbinReportCallback(deps, 99, `fbr:undo:${reportId}:g1`);

    expect(markEntriesUnread).toHaveBeenCalledWith({ username: "u", password: "p" }, [10, 20]);
    const saved = await store.getReport(reportId);
    expect(saved!.buttons[0]!.markedAt).toBe(0);
    expect(edits.at(-1)!.card.text).not.toContain("marcado");
  });

  it("fbr:undo fuera de la ventana no llama a la API y deja el grupo marcado", async () => {
    const reportId = await store.createReport(proposal({ buttons: [{ ...BTN, markedAt: Date.now() - 11 * 60_000 }] }));

    await handleFeedbinReportCallback(deps, 99, `fbr:undo:${reportId}:g1`);

    expect(markEntriesUnread).not.toHaveBeenCalled();
    const saved = await store.getReport(reportId);
    expect(saved!.buttons[0]!.markedAt).toBeGreaterThan(0);
    expect(logs.some((l) => l.msg === "feedbin_report_undo_expired_or_missing")).toBe(true);
  });

  it("un reportId inexistente edita la tarjeta con el mensaje de expirado", async () => {
    await handleFeedbinReportCallback(deps, 99, "fbr:mark:no-existe:g1");

    expect(markEntriesRead).not.toHaveBeenCalled();
    expect(edits.at(-1)!.card.text).toContain("expiró");
    expect(edits.at(-1)!.card.keyboard.inline_keyboard).toEqual([]);
  });

  it("un buttonId inexistente dentro de un reporte real no hace nada", async () => {
    const reportId = await store.createReport(proposal());

    await handleFeedbinReportCallback(deps, 99, `fbr:mark:${reportId}:no-existe`);

    expect(markEntriesRead).not.toHaveBeenCalled();
    expect(edits).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Correr, confirmar que falla**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run test -- feedbin-report-callbacks`
Expected: FAIL — `./feedbin-report-callbacks.js` no existe.

- [ ] **Step 3: Implementar**

Crear `daemon-v2/src/proactive/feedbin-report-callbacks.ts`:

```ts
// feedbin-report-callbacks.ts — handlers de los callbacks fbr:mark:*/fbr:undo:* de la tarjeta
// del reporte diario de Feedbin. HEAVY (llaman a la API real de Feedbin), mismo lock
// anti-doble-tap que jnl:*/bklg:*/lrn:*/tsk:* en index.ts.

import type { FeedbinCreds } from "../tools/feedbin-client.js";
import { buildKeyboard, buildReportText, type Card } from "./feedbin-report-card.js";
import type { FeedbinReportStore } from "./feedbin-report-store.js";

const UNDO_TTL_MS = 10 * 60 * 1000;

export interface ParsedFeedbinReportCallback {
  action: "mark" | "undo";
  reportId: string;
  buttonId: string;
}

export function isFeedbinReportCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith("fbr:");
}

export function parseFeedbinReportCallback(data: string): ParsedFeedbinReportCallback | null {
  const parts = data.split(":");
  if (parts[0] !== "fbr" || (parts[1] !== "mark" && parts[1] !== "undo") || !parts[2] || !parts[3]) return null;
  return { action: parts[1], reportId: parts[2], buttonId: parts[3] };
}

export interface FeedbinReportCallbackDeps {
  store: FeedbinReportStore;
  feedbin: FeedbinCreds;
  markEntriesRead: (creds: FeedbinCreds, ids: number[]) => Promise<void>;
  markEntriesUnread: (creds: FeedbinCreds, ids: number[]) => Promise<void>;
  log: (obj: Record<string, unknown>) => void;
  editCard: (messageId: number, card: Card) => Promise<void>;
}

export async function handleFeedbinReportCallback(
  deps: FeedbinReportCallbackDeps,
  messageId: number,
  data: string,
): Promise<void> {
  const parsed = parseFeedbinReportCallback(data);
  if (!parsed) return;
  const { action, reportId, buttonId } = parsed;

  const proposal = await deps.store.getReport(reportId);
  if (!proposal) {
    await deps.editCard(messageId, { text: "⏳ Esto expiró, corré el reporte de nuevo.", keyboard: { inline_keyboard: [] } });
    return;
  }

  const button = proposal.buttons.find((b) => b.id === buttonId);
  if (!button) return;

  if (action === "mark") {
    try {
      await deps.markEntriesRead(deps.feedbin, button.entryIds);
    } catch (err) {
      deps.log({ msg: "feedbin_report_mark_failed", reportId, buttonId, err: String(err) });
      await deps.editCard(messageId, {
        text: `${buildReportText(proposal.headerText, proposal.buttons)}\n\n⚠️ No pude marcar "${button.label}" — reintentá tocando el botón de nuevo.`,
        keyboard: buildKeyboard(reportId, proposal.buttons),
      });
      return;
    }
    button.markedAt = Date.now();
    await deps.store.updateReport(reportId, proposal);
    await deps.editCard(messageId, {
      text: buildReportText(proposal.headerText, proposal.buttons),
      keyboard: buildKeyboard(reportId, proposal.buttons),
    });
    return;
  }

  // action === "undo"
  if (button.markedAt > 0 && Date.now() - button.markedAt < UNDO_TTL_MS) {
    try {
      await deps.markEntriesUnread(deps.feedbin, button.entryIds);
      button.markedAt = 0;
      await deps.store.updateReport(reportId, proposal);
    } catch (err) {
      deps.log({ msg: "feedbin_report_undo_failed", reportId, buttonId, err: String(err) });
    }
  } else {
    deps.log({ msg: "feedbin_report_undo_expired_or_missing", reportId, buttonId });
  }

  // Re-renderiza siempre — si la ventana de deshacer venció, buildKeyboard ya omite ese botón
  // por su cuenta, así la tarjeta queda consistente con el estado real sin un mensaje aparte.
  await deps.editCard(messageId, {
    text: buildReportText(proposal.headerText, proposal.buttons),
    keyboard: buildKeyboard(reportId, proposal.buttons),
  });
}
```

- [ ] **Step 4: Correr, confirmar que pasa**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run test -- feedbin-report-callbacks`
Expected: PASS — 13 tests.

- [ ] **Step 5: Typecheck**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/proactive/feedbin-report-callbacks.ts daemon-v2/src/proactive/feedbin-report-callbacks.test.ts
git commit -m "feat(jano): handle mark/undo callbacks for the Feedbin report groups"
```

---

## Task 6: Reescribir `checkFeedbinDailyReport` — clasificar TODO + agrupar + tarjeta

**Files:**
- Modify: `daemon-v2/src/proactive/feedbin-daily-report.ts`
- Modify: `daemon-v2/src/proactive/feedbin-daily-report.test.ts`

- [ ] **Step 1: Actualizar los tests existentes y agregar los nuevos casos (deben fallar primero)**

Reemplazar el contenido completo de `daemon-v2/src/proactive/feedbin-daily-report.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tools/feedbin-client.js", () => ({
  getAllUnreadEntries: vi.fn(),
  getSubscriptions: vi.fn(),
  getTaggings: vi.fn(),
  feedbinEntryUrl: (id: number) => `https://feedbin.com/entries/${id}`,
}));
vi.mock("./topics-profile-refresh.js", () => ({ TOPICS_PROFILE_PATH: "/tmp/does-not-exist-topics-profile.md" }));
vi.mock("./rich-send.js", () => ({ sendCronMessage: vi.fn(async () => ({ message_id: 1 })) }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ startup: vi.fn() }));

import { getAllUnreadEntries, getSubscriptions, getTaggings } from "../tools/feedbin-client.js";
import { sendCronMessage } from "./rich-send.js";
import { checkFeedbinDailyReport, parseClassifyResult } from "./feedbin-daily-report.js";

const mockUnread = vi.mocked(getAllUnreadEntries);
const mockSubs = vi.mocked(getSubscriptions);
const mockTaggings = vi.mocked(getTaggings);
const mockSend = vi.mocked(sendCronMessage);

const creds = { username: "u", password: "p" };

/** Fake mínimo de CfKv — checkFeedbinDailyReport solo lo usa para armar un FeedbinReportStore. */
class FakeKv {
  store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function entry(id: number, title: string) {
  return { id, feed_id: 10, title, url: "u", author: null, summary: null, published: "2026-01-01" };
}

/** Encola una respuesta de Haiku (classify o group) para el próximo `handle.query(...)`. */
function queueHaikuResponse(sdk: { startup: ReturnType<typeof vi.fn> }, result: string): void {
  sdk.startup.mockResolvedValueOnce({
    query: async function* () {
      yield { type: "result", subtype: "success", result };
    },
    close: vi.fn(async () => {}),
  } as never);
}

describe("parseClassifyResult", () => {
  it("parses a well-formed JSON response", () => {
    const out = parseClassifyResult('{"recomendaciones":[{"id":1,"decision":"abrir"},{"id":2,"decision":"saltar"}]}');
    expect(out).toEqual([{ id: 1, decision: "abrir" }, { id: 2, decision: "saltar" }]);
  });

  it("tolerates a markdown fence around the JSON", () => {
    const out = parseClassifyResult('```json\n{"recomendaciones":[{"id":1,"decision":"abrir"}]}\n```');
    expect(out).toEqual([{ id: 1, decision: "abrir" }]);
  });

  it("returns [] on invalid JSON or missing recomendaciones", () => {
    expect(parseClassifyResult("not json")).toEqual([]);
    expect(parseClassifyResult('{"foo":"bar"}')).toEqual([]);
  });

  it("filters out entries with invalid id/decision shape", () => {
    const out = parseClassifyResult('{"recomendaciones":[{"id":"x","decision":"abrir"},{"id":1,"decision":"maybe"},{"id":2,"decision":"saltar"}]}');
    expect(out).toEqual([{ id: 2, decision: "saltar" }]);
  });
});

describe("checkFeedbinDailyReport", () => {
  let kv: FakeKv;

  beforeEach(() => {
    vi.clearAllMocks();
    kv = new FakeKv();
  });

  it("reports 'sin artículos' when there's nothing unread", async () => {
    mockUnread.mockResolvedValue([]);
    mockSubs.mockResolvedValue([]);
    mockTaggings.mockResolvedValue([]);

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds, kv: kv as never });

    expect(mockSend.mock.calls[0][1].text).toContain("Sin artículos sin leer");
  });

  it("groups unread counts by folder tag, falling back to feed title, and reports no profile", async () => {
    mockUnread.mockResolvedValue([
      entry(1, "A"),
      entry(2, "B"),
      { ...entry(3, "C"), feed_id: 20 },
    ]);
    mockSubs.mockResolvedValue([{ id: 1, feed_id: 20, title: "Feed sin carpeta" }]);
    mockTaggings.mockResolvedValue([{ feed_id: 10, name: "1. Siempre" }]);

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds, kv: kv as never });

    const text = mockSend.mock.calls[0][1].text;
    expect(text).toContain("3 sin leer");
    expect(text).toContain("1. Siempre: 2");
    expect(text).toContain("Feed sin carpeta: 1");
    expect(text).toContain("Sin perfil de temas todavía");
  });

  it("does not send anything if fetching from Feedbin fails", async () => {
    mockUnread.mockRejectedValue(new Error("boom"));

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds, kv: kv as never });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("classifies ALL unread entries in batches of 60, not just the most recent 60", async () => {
    const entries = Array.from({ length: 130 }, (_, i) => entry(i + 1, `Título ${i + 1}`));
    mockUnread.mockResolvedValue(entries);
    mockSubs.mockResolvedValue([]);
    mockTaggings.mockResolvedValue([]);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const { TOPICS_PROFILE_PATH } = await import("./topics-profile-refresh.js");
    // El mock de topics-profile-refresh.js ya define un path fijo; escribimos un perfil real ahí.
    mkdirSync(dirname(TOPICS_PROFILE_PATH), { recursive: true });
    writeFileSync(TOPICS_PROFILE_PATH, "perfil de prueba", "utf8");

    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    // 3 llamadas de classify (130 entries / 60 por lote = 3 lotes) — todas "abrir".
    for (let i = 0; i < 3; i++) {
      const start = i * 60;
      const end = Math.min(start + 60, 130);
      const ids = Array.from({ length: end - start }, (_, j) => start + j + 1);
      queueHaikuResponse(sdk as never, JSON.stringify({ recomendaciones: ids.map((id) => ({ id, decision: "abrir" })) }));
    }
    // 1 llamada de agrupado para "abrir" (todos los 130) — un solo grupo grande.
    queueHaikuResponse(sdk as never, JSON.stringify({ grupos: [{ tema: "Todo", ids: entries.map((e) => e.id) }] }));
    // 0 entries "saltar" → no debería llamar a agrupar para saltar.

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds, kv: kv as never });

    expect(vi.mocked(sdk.startup)).toHaveBeenCalledTimes(4); // 3 classify + 1 group (abrir)
    const text = mockSend.mock.calls[0][1].text;
    expect(text).toContain("Para abrir</b> (130)");
    expect(text).toContain("Todo</b> (130)");
    expect(text).toContain("...y 125 más"); // 130 - 5 mostrados
  });

  it("builds mark-as-read buttons from the grouped 'saltar' entries", async () => {
    const entries = [entry(1, "A"), entry(2, "B"), entry(3, "C")];
    mockUnread.mockResolvedValue(entries);
    mockSubs.mockResolvedValue([]);
    mockTaggings.mockResolvedValue([]);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const { TOPICS_PROFILE_PATH } = await import("./topics-profile-refresh.js");
    mkdirSync(dirname(TOPICS_PROFILE_PATH), { recursive: true });
    writeFileSync(TOPICS_PROFILE_PATH, "perfil de prueba", "utf8");

    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    queueHaikuResponse(sdk as never, JSON.stringify({ recomendaciones: [{ id: 1, decision: "abrir" }, { id: 2, decision: "saltar" }, { id: 3, decision: "saltar" }] })); // classify (1 lote)
    queueHaikuResponse(sdk as never, JSON.stringify({ grupos: [{ tema: "Interesante", ids: [1] }] })); // group abrir
    queueHaikuResponse(sdk as never, JSON.stringify({ grupos: [{ tema: "Ruido", ids: [2, 3] }] })); // group saltar

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds, kv: kv as never });

    const [, opts] = mockSend.mock.calls[0];
    expect(opts.text).toContain("Ruido (2)");
    expect(opts.replyMarkup).toBeDefined();
    const kb = opts.replyMarkup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    expect(kb.inline_keyboard[0]![0]!.text).toContain("Ruido");
    expect(kb.inline_keyboard[0]![0]!.callback_data).toMatch(/^fbr:mark:.+:g1$/);
  });

  it("falls back to a flat 'saltar' line without buttons if grouping saltar fails", async () => {
    const entries = [entry(1, "A"), entry(2, "B")];
    mockUnread.mockResolvedValue(entries);
    mockSubs.mockResolvedValue([]);
    mockTaggings.mockResolvedValue([]);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const { TOPICS_PROFILE_PATH } = await import("./topics-profile-refresh.js");
    mkdirSync(dirname(TOPICS_PROFILE_PATH), { recursive: true });
    writeFileSync(TOPICS_PROFILE_PATH, "perfil de prueba", "utf8");

    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    queueHaikuResponse(sdk as never, JSON.stringify({ recomendaciones: [{ id: 1, decision: "saltar" }, { id: 2, decision: "saltar" }] })); // classify
    // grouping para "abrir": no se llama porque abrirEntries está vacío.
    vi.mocked(sdk.startup).mockRejectedValueOnce(new Error("Haiku caído")); // group saltar falla

    await checkFeedbinDailyReport({ botToken: "t", chatId: 1, feedbin: creds, kv: kv as never });

    const [, opts] = mockSend.mock.calls[0];
    expect(opts.text).toContain("no pude agrupar");
    expect(opts.replyMarkup).toBeUndefined();
  });
});
```

- [ ] **Step 2: Correr, confirmar que falla**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run test -- feedbin-daily-report`
Expected: FAIL — `checkFeedbinDailyReport` todavía no acepta `kv`, ni clasifica por lotes, ni agrupa.

- [ ] **Step 3: Reescribir `feedbin-daily-report.ts`**

Reemplazar el contenido completo de `daemon-v2/src/proactive/feedbin-daily-report.ts`:

```ts
// Cron diario: clasifica TODO el backlog de no leídos en Feedbin (sin techo — antes solo miraba
// los últimos 60), lo agrupa por tema en dos tandas ("para abrir" y "marcar leído") usando el
// perfil de temas que refresca `topics-profile-refresh.ts` semanalmente, y ofrece un botón por
// grupo de baja relevancia para marcarlo como leído en bloque. Nunca marca nada por su cuenta —
// la ejecución real solo pasa por tocar un botón (ver feedbin-report-callbacks.ts).

import { readFileSync } from "node:fs";
import { startup } from "@anthropic-ai/claude-agent-sdk";
import { getAllUnreadEntries, getSubscriptions, getTaggings, feedbinEntryUrl, type FeedbinCreds, type FeedbinEntry } from "../tools/feedbin-client.js";
import type { CfKv } from "../cf-kv.js";
import { TOPICS_PROFILE_PATH } from "./topics-profile-refresh.js";
import { sendCronMessage } from "./rich-send.js";
import { groupEntries, type ThemeGroup } from "./feedbin-report-groups.js";
import { renderAbrirSection, selectMarkButtons, buildReportText, buildKeyboard, type Keyboard } from "./feedbin-report-card.js";
import { FeedbinReportStore } from "./feedbin-report-store.js";

const MODEL = "claude-haiku-4-5-20251001";
const CLASSIFY_BATCH_SIZE = 60;
const ABRIR_FALLBACK_LIMIT = 15; // si el agrupado de "abrir" falla, cuántos links planos mostrar

export interface FeedbinDailyReportOpts {
  botToken: string;
  chatId: number;
  feedbin: FeedbinCreds;
  kv: CfKv;
}

export interface Recomendacion { id: number; decision: "abrir" | "saltar" }

export function parseClassifyResult(raw: string): Recomendacion[] {
  const limpio = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(limpio) as { recomendaciones?: unknown };
    if (!Array.isArray(parsed.recomendaciones)) return [];
    return (parsed.recomendaciones as Array<Record<string, unknown>>)
      .filter((r) => typeof r.id === "number" && (r.decision === "abrir" || r.decision === "saltar"))
      .map((r) => ({ id: r.id as number, decision: r.decision as "abrir" | "saltar" }));
  } catch {
    return [];
  }
}

function readTopicsProfile(): string | null {
  try {
    const raw = readFileSync(TOPICS_PROFILE_PATH, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function buildClassifyPrompt(perfil: string, entries: FeedbinEntry[]): string {
  const lista = entries
    .map((e) => `${e.id} | ${e.title ?? "(sin título)"} | ${(e.summary ?? "").slice(0, 200)}`)
    .join("\n");
  return [
    "Perfil de temas de interés actuales de la persona:",
    perfil,
    "",
    "Artículos sin leer de hoy (id | título | resumen):",
    lista,
    "",
    "Para CADA artículo decidí si vale la pena abrirlo (relevante para el perfil) o si es de",
    "baja relevancia y puede marcarse como leído sin abrir. Ante la duda, preferí \"abrir\"",
    "(el costo de abrir algo irrelevante es bajo; el de perderse algo relevante no).",
    "",
    "Devolvé SOLO un JSON, sin explicación ni fences:",
    '{"recomendaciones":[{"id":N,"decision":"abrir"|"saltar"}, ...]}',
  ].join("\n");
}

async function classifyEntries(perfil: string, entries: FeedbinEntry[]): Promise<Recomendacion[]> {
  const handle = await startup({ options: { model: MODEL, maxTurns: 1, allowedTools: [] } });
  let out = "";
  try {
    for await (const event of handle.query(buildClassifyPrompt(perfil, entries))) {
      const e = event as { type?: string; subtype?: string; result?: string };
      if (e.type === "result" && e.subtype === "success") {
        out = e.result ?? "";
        break;
      }
    }
  } finally {
    try { await handle.close(); } catch { /* best-effort */ }
  }

  return parseClassifyResult(out);
}

/** Clasifica TODO el backlog en lotes de CLASSIFY_BATCH_SIZE — un lote que falla se loguea y se
 * excluye, pero no aborta los siguientes. Reemplaza el viejo techo MAX_TO_CLASSIFY=60. */
async function classifyAllEntries(perfil: string, entries: FeedbinEntry[]): Promise<Recomendacion[]> {
  const all: Recomendacion[] = [];
  for (let i = 0; i < entries.length; i += CLASSIFY_BATCH_SIZE) {
    const batch = entries.slice(i, i + CLASSIFY_BATCH_SIZE);
    try {
      const recs = await classifyEntries(perfil, batch);
      all.push(...recs);
    } catch (err) {
      console.log(JSON.stringify({
        ts: Date.now(),
        msg: "feedbin_daily_report_batch_classify_failed",
        batchIndex: Math.floor(i / CLASSIFY_BATCH_SIZE),
        err: String(err),
      }));
    }
  }
  return all;
}

export async function checkFeedbinDailyReport(opts: FeedbinDailyReportOpts): Promise<void> {
  const { botToken, chatId, feedbin, kv } = opts;

  let unread: FeedbinEntry[];
  let subs: Awaited<ReturnType<typeof getSubscriptions>>;
  let taggings: Awaited<ReturnType<typeof getTaggings>>;
  try {
    [unread, subs, taggings] = await Promise.all([
      getAllUnreadEntries(feedbin),
      getSubscriptions(feedbin),
      getTaggings(feedbin),
    ]);
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_fetch_error", err: String(err) }));
    return;
  }

  if (unread.length === 0) {
    try {
      await sendCronMessage(botToken, { chatId, text: "📰 <b>Feedbin</b>\nSin artículos sin leer." });
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_send_failed", err: String(err) }));
    }
    return;
  }

  const feedTagName = new Map<number, string>();
  for (const t of taggings) feedTagName.set(t.feed_id, t.name);
  const feedTitle = new Map<number, string>();
  for (const s of subs) feedTitle.set(s.feed_id, s.title);

  const porCarpeta = new Map<string, number>();
  for (const e of unread) {
    const carpeta = feedTagName.get(e.feed_id) ?? feedTitle.get(e.feed_id) ?? "(sin carpeta)";
    porCarpeta.set(carpeta, (porCarpeta.get(carpeta) ?? 0) + 1);
  }
  const carpetaLine = [...porCarpeta.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([carpeta, count]) => `${carpeta}: ${count}`)
    .join(" · ");

  const perfil = readTopicsProfile();
  if (!perfil) {
    const text = [
      `📰 <b>Feedbin</b> — ${unread.length} sin leer`,
      carpetaLine,
      "",
      "<i>Sin perfil de temas todavía (corre el domingo) — sin recomendación por ahora.</i>",
    ].join("\n");
    try {
      await sendCronMessage(botToken, { chatId, text });
      console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_sent", unreadCount: unread.length }));
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_send_failed", err: String(err) }));
    }
    return;
  }

  const entryById = new Map(unread.map((e) => [e.id, e]));
  const recomendaciones = await classifyAllEntries(perfil, unread);

  if (recomendaciones.length === 0) {
    const text = [
      `📰 <b>Feedbin</b> — ${unread.length} sin leer`,
      carpetaLine,
      "",
      "<i>No pude clasificar hoy (falló la síntesis) — revisá la lista completa vos.</i>",
    ].join("\n");
    try {
      await sendCronMessage(botToken, { chatId, text });
      console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_sent", unreadCount: unread.length }));
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_send_failed", err: String(err) }));
    }
    return;
  }

  const abrirEntries = recomendaciones
    .filter((r) => r.decision === "abrir")
    .map((r) => entryById.get(r.id))
    .filter((e): e is FeedbinEntry => Boolean(e));
  const saltarEntries = recomendaciones
    .filter((r) => r.decision === "saltar")
    .map((r) => entryById.get(r.id))
    .filter((e): e is FeedbinEntry => Boolean(e));

  let abrirGroups: ThemeGroup[] = [];
  try {
    abrirGroups = await groupEntries(perfil, abrirEntries);
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_group_abrir_failed", err: String(err) }));
  }

  let saltarGroups: ThemeGroup[] = [];
  try {
    saltarGroups = await groupEntries(perfil, saltarEntries);
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_group_saltar_failed", err: String(err) }));
  }

  const headerLines = [`📰 <b>Feedbin</b> — ${unread.length} sin leer`, carpetaLine, ""];
  headerLines.push(`<b>✅ Para abrir</b> (${abrirEntries.length})`);
  if (abrirEntries.length === 0) {
    headerLines.push("<i>Nada para abrir hoy.</i>");
  } else if (abrirGroups.length > 0) {
    headerLines.push(renderAbrirSection(abrirGroups, entryById));
  } else {
    headerLines.push(
      abrirEntries
        .slice(0, ABRIR_FALLBACK_LIMIT)
        .map((e) => `• <a href="${feedbinEntryUrl(e.id)}">${e.title ?? "(sin título)"}</a>`)
        .join("\n"),
    );
  }
  const headerText = headerLines.join("\n");

  let text = headerText;
  let keyboard: Keyboard | undefined;

  if (saltarEntries.length > 0) {
    if (saltarGroups.length > 0) {
      const buttons = selectMarkButtons(saltarGroups);
      const store = new FeedbinReportStore(kv);
      const reportId = await store.createReport({ headerText, buttons });
      text = buildReportText(headerText, buttons);
      keyboard = buildKeyboard(reportId, buttons);
    } else {
      text = `${headerText}\n\n<b>⏭️ Marcar como leído</b> (${saltarEntries.length}) — no pude agrupar, revisalo directo en Feedbin.`;
    }
  }

  try {
    await sendCronMessage(botToken, { chatId, text, replyMarkup: keyboard });
    console.log(JSON.stringify({
      ts: Date.now(),
      msg: "feedbin_daily_report_sent",
      unreadCount: unread.length,
      abrirCount: abrirEntries.length,
      saltarCount: saltarEntries.length,
    }));
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "feedbin_daily_report_send_failed", err: String(err) }));
  }
}
```

- [ ] **Step 4: Correr, confirmar que pasa**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run test -- feedbin-daily-report`
Expected: PASS — 9 tests (4 de `parseClassifyResult` + 5 de `checkFeedbinDailyReport`).

- [ ] **Step 5: Typecheck**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run typecheck`
Expected: sin errores. Si `sendCronMessage`'s `CronMessageOpts.replyMarkup` no acepta `Keyboard | undefined`
directamente (es `unknown` en `rich-send.ts` — sí acepta cualquier cosa), no debería hacer falta
ningún cast.

- [ ] **Step 6: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/proactive/feedbin-daily-report.ts daemon-v2/src/proactive/feedbin-daily-report.test.ts
git commit -m "feat(jano): classify the entire Feedbin backlog and group by theme"
```

---

## Task 7: Wiring en `index.ts`

**Files:**
- Modify: `daemon-v2/src/index.ts`

- [ ] **Step 1: Agregar imports**

Cerca de la línea 35 (`import { isLearningCallback, handleLearningCallback } from "./learning-callbacks.js";`),
agregar:

```ts
import { isFeedbinReportCallback, handleFeedbinReportCallback } from "./proactive/feedbin-report-callbacks.js";
import { FeedbinReportStore } from "./proactive/feedbin-report-store.js";
```

Y en el import existente de `"./tools/feedbin-client.js"` (o crear uno si no hay ninguno a nivel
módulo todavía — buscar con `grep -n "feedbin-client" daemon-v2/src/index.ts`; si no existe,
agregarlo junto a los demás imports de tools):

```ts
import { markEntriesRead, markEntriesUnread } from "./tools/feedbin-client.js";
```

- [ ] **Step 2: Instanciar el store**

Cerca de la línea 215 (`const learningStore = new LearningStore(kv);`), agregar:

```ts
const feedbinReportStore = new FeedbinReportStore(kv);
```

- [ ] **Step 3: Agregar el routing del callback, arriba del catch-all de "Heavy callbacks legacy"**

Justo después del bloque `if (isLearningCallback(cb.data)) { ... }` (el que termina en la línea
~856 con `return; }`), agregar el bloque nuevo, ANTES del comentario de `tsk:*`:

```ts
    // Callbacks del reporte diario de Feedbin (fbr:mark:*/fbr:undo:*) → mecánicos, sin LLM:
    // marcan/deshacen grupos de "marcar leído" en bloque contra la API real de Feedbin. Mismo
    // lock anti-doble-tap que jnl:*/bklg:*/lrn:*. Va ARRIBA del catch-all de "Heavy callbacks
    // legacy" más abajo — puesto debajo, `fbr:*` sería código muerto sin rastro en logs (mismo
    // motivo por el que `bklg:*`/`lrn:*` están donde están).
    if (isFeedbinReportCallback(cb.data)) {
      const fchat = cb.message.chat.id;
      const fanchor = cb.message.message_id;
      const lockUserId = cb.from.id;

      const acquired = await tryAcquireLock(kv, fchat, lockUserId, MEETING_FLOW_LOCK_TTL_SEC);
      if (!acquired) {
        await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id, "⏳ Todavía estoy procesando tu toque anterior...").catch(() => {});
        return;
      }
      await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id).catch(() => {});

      void handleFeedbinReportCallback(
        {
          store: feedbinReportStore,
          feedbin: { username: env.FEEDBIN_USERNAME, password: env.FEEDBIN_PASSWORD },
          markEntriesRead,
          markEntriesUnread,
          log,
          editCard: async (messageId, card) => {
            await editMessage(
              env.COS_TELEGRAM_BOT_TOKEN,
              fchat,
              messageId,
              card.text,
              "HTML",
              card.keyboard ?? { inline_keyboard: [] },
            ).catch((err) => log({ msg: "feedbin_report_edit_failed", err: String(err) }));
          },
        },
        fanchor,
        cb.data!,
      )
        .catch((err) => log({ msg: "feedbin_report_callback_error", err: String(err) }))
        .finally(() => releaseLock(kv, fchat, lockUserId).catch(() => {}));
      return;
    }

```

- [ ] **Step 4: Pasar `kv` a `checkFeedbinDailyReport` en `scheduleFeedbinDailyReport`**

Buscar la función `scheduleFeedbinDailyReport` (contiene `cron.schedule("0 8 * * *"`) y agregar
`kv` al objeto que se le pasa a `checkFeedbinDailyReport`:

```ts
function scheduleFeedbinDailyReport(): void {
  cron.schedule("0 8 * * *", () => {
    if (!env.FEEDBIN_USERNAME || !env.FEEDBIN_PASSWORD) return;
    void checkFeedbinDailyReport({
      botToken: env.COS_TELEGRAM_BOT_TOKEN,
      chatId: ALERT_CHAT_ID,
      feedbin: { username: env.FEEDBIN_USERNAME, password: env.FEEDBIN_PASSWORD },
      kv,
    }).catch((err) => log({ msg: "feedbin_daily_report_unhandled_error", err: String(err) }));
  }, { timezone: "America/La_Paz" });
  log({ msg: "feedbin_daily_report_scheduled", interval: "daily 08:00" });
}
```

(Solo se agrega la línea `kv,` dentro del objeto — el resto de la función queda igual.)

- [ ] **Step 5: Typecheck**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run typecheck`
Expected: sin errores. Si `FEEDBIN_USERNAME`/`FEEDBIN_PASSWORD` no están tipadas en `env` en este
punto del archivo, revisar cómo se accede a ellas en el bloque ya existente de
`scheduleFeedbinDailyReport` (unas líneas más abajo) y copiar exactamente esa forma de acceso.

- [ ] **Step 6: Build completo**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run build`
Expected: sin errores.

- [ ] **Step 7: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/index.ts
git commit -m "feat(jano): wire the Feedbin report mark/undo callbacks into the daemon"
```

---

## Task 8: Verificación final

**Files:** ninguno (solo comandos).

- [ ] **Step 1: Suite completa de tests**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run test`
Expected: PASS — todos los test files, incluidos los 6 nuevos/modificados de este plan.

- [ ] **Step 2: Typecheck completo**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run typecheck`
Expected: sin errores.

- [ ] **Step 3: Build completo**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2" && npm run build`
Expected: sin errores.

- [ ] **Step 4: Reviewer del daemon**

Este cambio toca `index.ts` y varios archivos de `proactive/` — invocar el subagente
`daemon-health-reviewer` sobre el diff completo antes de reiniciar el daemon en producción (regla
de `Personal/Agents/CLAUDE.md`).

- [ ] **Step 5: Reinicio en producción — requiere confirmación explícita de Cal**

NO ejecutar sin que Cal lo confirme explícitamente en el momento (regla dura del proyecto — ver
`Personal/Agents/CLAUDE.md` y el feedback ya registrado en esta sesión). Una vez confirmado:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
```

Verificar arranque limpio: `tail -30 ~/Library/Logs/cos-agent-v2.out.log | grep -E "scheduled|error"`
— debe verse `feedbin_daily_report_scheduled` sin ningún `error`.

- [ ] **Step 6: Smoke test manual (opcional, a pedido de Cal)**

El cron corre a las 08:00 — para verlo actuar el mismo día sin esperar, se puede disparar
`checkFeedbinDailyReport` desde un script one-off (mismo patrón ya usado en esta sesión: `op run
--env-file=~/.cos-agent/apps-env.1password.tpl -- node <script>` importando desde
`daemon-v2/dist/proactive/feedbin-daily-report.js`, pasando además un `CfKv` real construido con
las credenciales de Cloudflare del `.tpl`). No es parte de este plan de implementación — hacerlo
solo si Cal lo pide explícitamente después de haber revisado el código.

---

## Self-Review

**Spec coverage:**
- Clasificar TODO el backlog en lotes de 60 → Task 6 (`classifyAllEntries`).
- Agrupar por tema, grupos libres guiados por el perfil, 2 llamadas separadas (abrir/saltar) → Task 2 (`groupEntries`) + Task 6 (dos invocaciones).
- Botón por grupo para "marcar leído", tope de 6 + "resto" → Task 3 (`selectMarkButtons`).
- Opción A de render de "para abrir" (todos los grupos, tope 5 + "...y N más") → Task 3 (`renderAbrirSection`).
- Estado en KV, callback `fbr:mark:*`/`fbr:undo:*`, deshacer 10 min → Tasks 4 y 5.
- Manejo de errores (fetch falla, lote falla, agrupado falla, envío falla, mark falla, undo vencido) → cubierto en Tasks 1, 2, 3, 5, 6 (casos de test explícitos para cada uno).
- Wiring en `index.ts` (routing HEAVY, lock anti-doble-tap, `kv` en `scheduleFeedbinDailyReport`) → Task 7.
- Reportes de días distintos conviven sin conflicto → cubierto por diseño (TTL de 7 días + mark idempotente del lado de Feedbin), sin necesidad de código adicional — no requiere un test dedicado porque no hay lógica nueva que verificar (es una propiedad que se cumple sola).

**Placeholder scan:** sin TBD/TODO. El único paso sin código "real" es Task 8 Step 6 (smoke test
opcional), marcado explícitamente como fuera del plan y a pedido — no es una tarea de
implementación pendiente.

**Type consistency:** `FeedbinReportButton` se define una sola vez, en `feedbin-report-card.ts`
(Task 3), y se importa desde ahí en `feedbin-report-store.ts` (Task 4) y `feedbin-report-callbacks.ts`
(Task 5) — nunca redefinido. `ThemeGroup` se define una sola vez en `feedbin-report-groups.ts`
(Task 2). `Card`/`Keyboard` se definen una sola vez en `feedbin-report-card.ts`. Los nombres de
función (`groupEntries`, `selectMarkButtons`, `buildReportText`, `buildKeyboard`,
`renderAbrirSection`, `parseFeedbinReportCallback`, `handleFeedbinReportCallback`) se usan
consistentes entre el archivo que los define y cada import posterior — verificado línea por línea
al escribir Tasks 6 y 7.
