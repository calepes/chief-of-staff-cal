# Self-learning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que Jano aprenda de sus conversaciones con Cal: un pase nocturno barato revisa las sesiones del día, extrae aprendizajes candidatos, y se los propone a Cal en una tarjeta para que apruebe los que valen — más un camino manual ("Jano, recuerda que…") para fijar algo al toque.

**Architecture:** La reflexión sale del turno. Un cron interno a las 22:00 lee los `.jsonl` que el SDK ya persiste (filtrados a las sesiones propias del daemon), los recorta, y los pasa por una llamada acotada a Haiku sin tools. Los candidatos se deduplican contra lo ya guardado y se proponen; solo lo aprobado se escribe a `~/.cos-agent/learnings.md`, que sigue inyectándose en el system prompt como hoy. Un semáforo de tokens avisa cuando el archivo crece demasiado.

**Tech Stack:** TypeScript ESM, Vitest, `@anthropic-ai/claude-agent-sdk` (Haiku, `maxTurns:1`, `allowedTools:[]`), `node-cron`, CF KV, Telegram HTML.

**Spec:** `docs/superpowers/specs/2026-07-28-backlog-tool-y-self-learning-design.md` (Parte 2)

**Dependencia:** ninguna sobre el plan de backlog. Los dos son independientes.

**UX:** el skill `telegram-bot-ux` es parte del diseño, no una referencia. Su checklist ya se corrió
sobre estas tarjetas (ver la sección "UX" del spec) y de ahí salieron el tope de 5 candidatos
visibles, la numeración en texto plano (en vez de emojis `1️⃣`) y los emojis nuevos documentados en
el lexicon. **Antes de tocar `learning-card.ts` o cualquier texto que salga a Telegram, invocar el
skill y correr su checklist de 5 puntos** — no alcanza con leer este plan.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `daemon-v2/src/learning-types.ts` | Tipos compartidos. Sin lógica. |
| `daemon-v2/src/learning-file.ts` | Parse/serialize de `learnings.md` con tags, dedupe, presupuesto de tokens. |
| `daemon-v2/src/session-log.ts` | Registro append-only de los sessionIds que usó el daemon. |
| `daemon-v2/src/learning-transcript.ts` | Lee los `.jsonl` del día y produce el texto recortado. |
| `daemon-v2/src/learning-extract.ts` | Prompt y parseo de la llamada a Haiku. |
| `daemon-v2/src/learning-card.ts` | Render puro de tarjetas y teclados. |
| `daemon-v2/src/learning-store.ts` | Candidatos pendientes en CF KV. |
| `daemon-v2/src/learning-callbacks.ts` | `isLearningCallback` + `handleLearningCallback`. |
| `daemon-v2/src/proactive/learning-reflect.ts` | El cron nocturno. |
| `daemon-v2/src/session-store.ts` *(modificar)* | Anotar cada sessionId en el registro. |
| `daemon-v2/src/learnings.ts` *(modificar)* | Inyección con tags + aviso de presupuesto. |
| `daemon-v2/src/index.ts` *(modificar)* | Registro del cron + routing de `lrn:*`. |
| `daemon-v2/src/agent-tools.ts` *(modificar)* | Tool `recordarAprendizaje`. |
| `daemon-v2/src/system-prompt.ts` *(modificar)* | Guía de uso. |

---

## Task 1: Tipos y parseo del archivo de learnings

**Files:**
- Create: `daemon-v2/src/learning-types.ts`
- Create: `daemon-v2/src/learning-file.ts`
- Test: `daemon-v2/src/learning-file.test.ts`

- [ ] **Step 1: Escribir los tipos**

```typescript
// learning-types.ts — tipos compartidos del self-learning.

/** Las cuatro categorías que Cal pidió que Jano aprenda. */
export const LEARNING_TAGS = ["pref", "hecho", "err", "flujo"] as const;
export type LearningTag = (typeof LEARNING_TAGS)[number];

/** Una línea de ~/.cos-agent/learnings.md ya parseada. */
export interface Learning {
  date: string;
  tag: LearningTag;
  text: string;
}

/** Un candidato propuesto por el pase nocturno, todavía sin aprobar. */
export interface LearningCandidate {
  tag: LearningTag;
  text: string;
  /** Cita corta de la conversación que lo justifica. Se muestra, no se guarda. */
  evidencia: string;
}

/** Lo que el cron deja en KV esperando los botones de Cal. */
export interface LearningBatch {
  fecha: string;
  candidates: LearningCandidate[];
  /** Índice del candidato que se está revisando en modo uno-a-uno. */
  cursor: number;
  /** Tokens estimados de los learnings activos al momento de armar el batch. */
  tokensActuales: number;
}
```

- [ ] **Step 2: Escribir el test que falla**

```typescript
import { describe, expect, it } from "vitest";
import {
  parseLearnings,
  formatLearning,
  estimateTokens,
  dedupeCandidates,
  overBudget,
  LEARNING_BUDGET_TOKENS,
} from "./learning-file.js";
import type { LearningCandidate } from "./learning-types.js";

const LEGACY = `- [2026-05-03] Cuando Cal comparte una foto de uso de Claude, calcular proyección.
- [2026-05-04] Cata está en Inicial y Anto en Primaria en el Colegio Porongo.
`;

const TAGGED = `- [2026-07-28] [pref] Cal quiere el total antes del desglose
- [2026-07-28] [err] notionApi: el body va como objeto, no como string
`;

describe("parseLearnings", () => {
  it("parsea líneas con tag", () => {
    const out = parseLearnings(TAGGED);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      date: "2026-07-28",
      tag: "pref",
      text: "Cal quiere el total antes del desglose",
    });
    expect(out[1].tag).toBe("err");
  });

  it("tolera las líneas viejas sin tag y las marca como hecho", () => {
    const out = parseLearnings(LEGACY);
    expect(out).toHaveLength(2);
    expect(out[0].tag).toBe("hecho");
    expect(out[0].text).toContain("proyección");
  });

  it("ignora líneas vacías y basura", () => {
    expect(parseLearnings("\n\nno es un learning\n")).toHaveLength(0);
  });

  it("ignora un tag desconocido y cae a hecho", () => {
    const out = parseLearnings("- [2026-07-28] [inventado] algo\n");
    expect(out[0].tag).toBe("hecho");
  });
});

describe("formatLearning", () => {
  it("serializa en el formato del archivo", () => {
    expect(formatLearning({ date: "2026-07-28", tag: "pref", text: "Algo" })).toBe(
      "- [2026-07-28] [pref] Algo",
    );
  });

  it("round-trip con parseLearnings", () => {
    const l = { date: "2026-07-28", tag: "err" as const, text: "Algo puntual" };
    expect(parseLearnings(formatLearning(l))[0]).toEqual(l);
  });
});

describe("estimateTokens", () => {
  it("estima por caracteres", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("es 0 para vacío", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("overBudget", () => {
  it("no dispara con pocos learnings", () => {
    expect(overBudget(parseLearnings(TAGGED))).toBe(false);
  });

  it("dispara cuando se pasa el presupuesto", () => {
    const gordo = Array.from({ length: 400 }, (_, i) => `- [2026-07-28] [pref] ${"x".repeat(60)} ${i}`).join("\n");
    expect(overBudget(parseLearnings(gordo))).toBe(true);
  });

  it("el presupuesto es el documentado en el spec", () => {
    expect(LEARNING_BUDGET_TOKENS).toBe(4000);
  });
});

describe("dedupeCandidates", () => {
  const existentes = parseLearnings(TAGGED);

  it("descarta un candidato que repite un learning existente con otras palabras", () => {
    const cands: LearningCandidate[] = [
      { tag: "err", text: "notionApi necesita el body como objeto y no como string", evidencia: "x" },
    ];
    expect(dedupeCandidates(cands, existentes)).toHaveLength(0);
  });

  it("conserva un candidato genuinamente nuevo", () => {
    const cands: LearningCandidate[] = [
      { tag: "hecho", text: "El pediatra de las niñas atiende en Equipetrol", evidencia: "x" },
    ];
    expect(dedupeCandidates(cands, existentes)).toHaveLength(1);
  });

  it("descarta duplicados dentro del propio batch", () => {
    const cands: LearningCandidate[] = [
      { tag: "pref", text: "A Cal le gusta el resumen corto arriba", evidencia: "x" },
      { tag: "pref", text: "Cal prefiere el resumen corto arriba de todo", evidencia: "y" },
    ];
    expect(dedupeCandidates(cands, [])).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- learning-file`
Expected: FAIL — `Cannot find module './learning-file.js'`.

- [ ] **Step 4: Implementar el módulo**

```typescript
// learning-file.ts — parseo, serialización, dedupe y presupuesto de ~/.cos-agent/learnings.md.
//
// El archivo entero se inyecta en el system prompt en CADA turno (ver learnings.ts), así que su
// tamaño es contexto fijo que se paga siempre. De ahí el semáforo de tokens.
//
// Compatibilidad: las 4 entries escritas antes de este cambio no tienen tag. Se parsean igual y
// caen a "hecho" — romper con ellas habría significado perder los únicos learnings que existían.

import { LEARNING_TAGS, type Learning, type LearningCandidate, type LearningTag } from "./learning-types.js";

/**
 * Presupuesto BLANDO. Al superarlo el pase nocturno avisa y propone podar; nunca corta solo.
 * 4000 tokens ≈ 80-100 learnings, sobre un system prompt que ya pesa 18-20K.
 */
export const LEARNING_BUDGET_TOKENS = 4000;

const LINE_RE = /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(?:\[([a-z]+)\]\s*)?(.+)$/;

function isTag(v: string | undefined): v is LearningTag {
  return typeof v === "string" && (LEARNING_TAGS as readonly string[]).includes(v);
}

export function parseLearnings(content: string): Learning[] {
  const out: Learning[] = [];
  for (const line of content.split("\n")) {
    const m = LINE_RE.exec(line.trim());
    if (!m) continue;
    const text = m[3].trim();
    if (!text) continue;
    out.push({ date: m[1], tag: isTag(m[2]) ? m[2] : "hecho", text });
  }
  return out;
}

export function formatLearning(l: Learning): string {
  return `- [${l.date}] [${l.tag}] ${l.text}`;
}

/** Estimación por caracteres. Suficiente para un semáforo; no justifica un tokenizer real. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function totalTokens(learnings: Learning[]): number {
  return estimateTokens(learnings.map(formatLearning).join("\n"));
}

export function overBudget(learnings: Learning[]): boolean {
  return totalTokens(learnings) > LEARNING_BUDGET_TOKENS;
}

const STOPWORDS = new Set([
  "el", "la", "los", "las", "un", "una", "de", "del", "que", "y", "o", "a", "en", "con", "por",
  "para", "es", "no", "se", "su", "lo", "al", "como", "cal", "jano",
]);

function bagOfWords(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function similarity(a: string, b: string): number {
  const A = bagOfWords(a);
  const B = bagOfWords(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** Por encima de esto se considera el mismo learning dicho con otras palabras. */
const DUP_THRESHOLD = 0.6;

/**
 * Filtra candidatos que ya están cubiertos por un learning existente, y duplicados internos del
 * propio batch. Heurística deliberadamente simple: el costo de un falso positivo es perder un
 * learning que Cal puede volver a fijar a mano; el de un falso negativo es ruido permanente en
 * el system prompt.
 */
export function dedupeCandidates(
  candidates: LearningCandidate[],
  existentes: Learning[],
): LearningCandidate[] {
  const kept: LearningCandidate[] = [];
  for (const c of candidates) {
    const contraExistentes = existentes.some((e) => similarity(c.text, e.text) >= DUP_THRESHOLD);
    if (contraExistentes) continue;
    const contraBatch = kept.some((k) => similarity(c.text, k.text) >= DUP_THRESHOLD);
    if (contraBatch) continue;
    kept.push(c);
  }
  return kept;
}
```

- [ ] **Step 5: Correr los tests**

Run: `npm run test -w @cos/daemon -- learning-file`
Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add daemon-v2/src/learning-types.ts daemon-v2/src/learning-file.ts daemon-v2/src/learning-file.test.ts
git commit -m "feat(learning): parseo con tags, dedupe y presupuesto de tokens"
```

---

## Task 2: Registro de sessionIds del daemon

**Files:**
- Create: `daemon-v2/src/session-log.ts`
- Test: `daemon-v2/src/session-log.test.ts`
- Modify: `daemon-v2/src/session-store.ts`

**Por qué:** las sesiones del daemon y las sesiones interactivas de Claude Code sobre este repo
caen en el MISMO directorio `~/.claude/projects/-Users-calepes-Claude-Projects-Personal-Agents-Jano/`.
Sin este registro, el pase nocturno leería sesiones de desarrollo y propondría learnings sin
sentido para el bot. `sessions.json` no sirve: guarda solo la sesión vigente y la pierde al rotar.

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSession, sessionIdsForDay, pruneSessionLog } from "./session-log.js";

const DIR = join(tmpdir(), "jano-test-session-log");
const LOG = join(DIR, "sessions-log.jsonl");

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("recordSession", () => {
  it("anota una sesión nueva", () => {
    recordSession(LOG, "abc-123", 42, Date.parse("2026-07-28T10:00:00Z"));
    const lines = readFileSync(LOG, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ sessionId: "abc-123", chatId: 42 });
  });

  it("no duplica la misma sesión llamada muchas veces", () => {
    const t = Date.parse("2026-07-28T10:00:00Z");
    recordSession(LOG, "abc-123", 42, t);
    recordSession(LOG, "abc-123", 42, t + 1000);
    recordSession(LOG, "abc-123", 42, t + 2000);
    expect(readFileSync(LOG, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("no rompe si el directorio no existe todavía", () => {
    const otro = join(DIR, "nested", "sessions-log.jsonl");
    expect(() => recordSession(otro, "x", 1, Date.now())).not.toThrow();
  });
});

describe("sessionIdsForDay", () => {
  it("devuelve solo las sesiones del día pedido", () => {
    recordSession(LOG, "de-hoy", 42, Date.parse("2026-07-28T10:00:00-04:00"));
    recordSession(LOG, "de-ayer", 42, Date.parse("2026-07-27T10:00:00-04:00"));
    expect(sessionIdsForDay(LOG, "2026-07-28")).toEqual(["de-hoy"]);
  });

  it("devuelve vacío si no hay archivo", () => {
    expect(sessionIdsForDay(join(DIR, "no-existe.jsonl"), "2026-07-28")).toEqual([]);
  });

  it("ignora líneas corruptas sin romper", () => {
    writeFileSync(LOG, `no es json\n${JSON.stringify({ sessionId: "ok", chatId: 1, startedAt: Date.parse("2026-07-28T12:00:00-04:00") })}\n`);
    expect(sessionIdsForDay(LOG, "2026-07-28")).toEqual(["ok"]);
  });
});

describe("pruneSessionLog", () => {
  it("borra los registros de más de 30 días", () => {
    const now = Date.parse("2026-07-28T10:00:00Z");
    recordSession(LOG, "viejo", 1, now - 40 * 24 * 3600 * 1000);
    recordSession(LOG, "nuevo", 1, now);
    pruneSessionLog(LOG, now);
    const ids = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l).sessionId);
    expect(ids).toEqual(["nuevo"]);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- session-log`
Expected: FAIL — `Cannot find module './session-log.js'`.

- [ ] **Step 3: Implementar el módulo**

```typescript
// session-log.ts — registro append-only de las sesiones del SDK que usó ESTE daemon.
//
// Por qué existe: el SDK persiste cada sesión en
// ~/.claude/projects/<proyecto>/<sessionId>.jsonl, pero ese directorio lo comparten el daemon y
// las sesiones interactivas de Claude Code sobre el mismo repo. El pase nocturno de learnings
// necesita leer SOLO las del daemon; sin esta lista propondría learnings extraídos de sesiones
// de desarrollo ("Cal prefiere que los tests corran antes del commit").
//
// sessions.json no alcanza: guarda la sesión VIGENTE por chat y la pierde al rotar (techo de
// turnos o TTL de 12h), así que no es una fuente histórica.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const SESSION_LOG_PATH = join(homedir(), ".cos-agent", "sessions-log.jsonl");

const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

interface SessionLogRow {
  sessionId: string;
  chatId: number;
  startedAt: number;
}

function readRows(path: string): SessionLogRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: SessionLogRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SessionLogRow;
      if (typeof r.sessionId === "string" && typeof r.startedAt === "number") rows.push(r);
    } catch {
      /* una línea corrupta no invalida el resto del registro */
    }
  }
  return rows;
}

/** Anota la sesión si no estaba. Idempotente: se llama después de cada turno. */
export function recordSession(
  path: string,
  sessionId: string,
  chatId: number,
  startedAt: number = Date.now(),
): void {
  try {
    if (readRows(path).some((r) => r.sessionId === sessionId)) return;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ sessionId, chatId, startedAt })}\n`, "utf8");
  } catch {
    // Nunca romper un turno por no poder anotar. El costo de fallar acá es perder un día de
    // material para la reflexión, no una respuesta a Cal.
  }
}

/** `fecha` en YYYY-MM-DD, hora local de la máquina (La Paz). */
export function sessionIdsForDay(path: string, fecha: string): string[] {
  return readRows(path)
    .filter((r) => localDay(r.startedAt) === fecha)
    .map((r) => r.sessionId);
}

function localDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function pruneSessionLog(path: string, now: number = Date.now()): void {
  try {
    const kept = readRows(path).filter((r) => now - r.startedAt < PRUNE_AFTER_MS);
    writeFileSync(path, kept.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
  } catch {
    /* best-effort */
  }
}
```

- [ ] **Step 4: Correr los tests**

Run: `npm run test -w @cos/daemon -- session-log`
Expected: PASS, 8 tests.

- [ ] **Step 5: Enganchar el registro en `session-store.ts`**

En `daemon-v2/src/session-store.ts`, agregar el import arriba:

```typescript
import { recordSession, SESSION_LOG_PATH } from "./session-log.js";
```

Y dentro de `saveSessionId`, como última línea de la función (después de `writeAll(data);`):

```typescript
  // Anotar en el registro histórico: writeAll solo conserva la sesión vigente por chat, y el
  // pase nocturno de learnings necesita saber TODAS las sesiones que fueron del daemon.
  recordSession(SESSION_LOG_PATH, id, chatId);
```

- [ ] **Step 6: Verificar que los tests preexistentes de session-store siguen pasando**

Run: `npm run test -w @cos/daemon -- session-store`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add daemon-v2/src/session-log.ts daemon-v2/src/session-log.test.ts daemon-v2/src/session-store.ts
git commit -m "feat(learning): registro de sessionIds propios del daemon"
```

---

## Task 3: Lectura recortada de transcripts

**Files:**
- Create: `daemon-v2/src/learning-transcript.ts`
- Test: `daemon-v2/src/learning-transcript.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript, buildDayTranscript } from "./learning-transcript.js";

const DIR = join(tmpdir(), "jano-test-transcript");

/** Un .jsonl del SDK: una línea por evento. */
function writeSession(id: string, events: unknown[]): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n"));
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("readTranscript", () => {
  it("extrae texto de usuario y asistente", () => {
    writeSession("s1", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "Hola Jano" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hola Cal" }] } },
    ]);
    const t = readTranscript(join(DIR, "s1.jsonl"));
    expect(t).toContain("CAL: Hola Jano");
    expect(t).toContain("JANO: Hola Cal");
  });

  it("registra los tool calls por nombre, sin el payload", () => {
    writeSession("s2", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "notionApi", input: { body: "x".repeat(5000) } }],
        },
      },
    ]);
    const t = readTranscript(join(DIR, "s2.jsonl"));
    expect(t).toContain("TOOL notionApi");
    expect(t).not.toContain("xxxxx");
    expect(t.length).toBeLessThan(200);
  });

  it("conserva el mensaje de error de un tool fallido", () => {
    writeSession("s3", [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", is_error: true, content: "Error parsing JSON body" }],
        },
      },
    ]);
    const t = readTranscript(join(DIR, "s3.jsonl"));
    expect(t).toContain("ERROR");
    expect(t).toContain("Error parsing JSON body");
  });

  it("omite el resultado de un tool exitoso", () => {
    writeSession("s4", [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", is_error: false, content: "y".repeat(3000) }],
        },
      },
    ]);
    expect(readTranscript(join(DIR, "s4.jsonl"))).not.toContain("yyyy");
  });

  it("devuelve vacío si el archivo no existe", () => {
    expect(readTranscript(join(DIR, "no-existe.jsonl"))).toBe("");
  });

  it("ignora líneas corruptas", () => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, "s5.jsonl"), `basura\n${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Hola" }] } })}\n`);
    expect(readTranscript(join(DIR, "s5.jsonl"))).toContain("CAL: Hola");
  });
});

describe("buildDayTranscript", () => {
  it("concatena solo las sesiones pedidas", () => {
    writeSession("mia", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "soy del daemon" }] } },
    ]);
    writeSession("ajena", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "soy de Claude Code" }] } },
    ]);
    const t = buildDayTranscript(DIR, ["mia"]);
    expect(t).toContain("soy del daemon");
    expect(t).not.toContain("soy de Claude Code");
  });

  it("trunca al tope para no reventar la llamada a Haiku", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: `mensaje número ${i} con relleno` }] },
    }));
    writeSession("gorda", many);
    expect(buildDayTranscript(DIR, ["gorda"]).length).toBeLessThanOrEqual(60_000);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- learning-transcript`
Expected: FAIL — `Cannot find module './learning-transcript.js'`.

- [ ] **Step 3: Implementar el módulo**

```typescript
// learning-transcript.ts — convierte los .jsonl del SDK en texto plano para la reflexión.
//
// Qué se conserva y por qué:
//   - texto de Cal y de Jano → de ahí salen preferencias, hechos y flujos.
//   - NOMBRE de cada tool call, sin el payload → el payload satura sin aportar.
//   - mensaje de error de los tool calls fallidos → ESTA es la fuente de los learnings de tipo
//     "err", que son justamente los que Cal no puede notar desde Telegram.
//   - resultado de tools exitosos → se descarta entero: es el grueso del archivo y no enseña nada.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Tope del transcript que se le manda a Haiku. Por encima, se conserva la COLA (lo más reciente). */
const MAX_CHARS = 60_000;
const MAX_TEXT_PER_MSG = 1500;
const MAX_ERROR_CHARS = 300;

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  is_error?: boolean;
  content?: unknown;
}

function blockText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (typeof b === "object" && b !== null && typeof (b as ContentBlock).text === "string" ? (b as ContentBlock).text : ""))
      .join(" ");
  }
  return "";
}

export function readTranscript(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "";
  }

  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content as ContentBlock[]) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        const who = ev.message?.role === "assistant" ? "JANO" : "CAL";
        out.push(`${who}: ${block.text.trim().slice(0, MAX_TEXT_PER_MSG)}`);
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        out.push(`TOOL ${block.name}`);
      } else if (block.type === "tool_result" && block.is_error === true) {
        const msg = blockText(block.content).trim().slice(0, MAX_ERROR_CHARS);
        out.push(`TOOL ERROR: ${msg}`);
      }
    }
  }
  return out.join("\n");
}

/** Concatena las sesiones indicadas, truncando por la cola si excede el tope. */
export function buildDayTranscript(dir: string, sessionIds: string[]): string {
  const parts: string[] = [];
  for (const id of sessionIds) {
    const t = readTranscript(join(dir, `${id}.jsonl`));
    if (t) parts.push(`--- sesión ${id} ---\n${t}`);
  }
  const full = parts.join("\n\n");
  // Se conserva el FINAL, no el principio: lo más reciente del día es lo más representativo de
  // cómo terminó cada conversación.
  return full.length > MAX_CHARS ? full.slice(full.length - MAX_CHARS) : full;
}
```

- [ ] **Step 4: Correr los tests**

Run: `npm run test -w @cos/daemon -- learning-transcript`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/learning-transcript.ts daemon-v2/src/learning-transcript.test.ts
git commit -m "feat(learning): lectura recortada de transcripts del SDK"
```

---

## Task 4: Extractor con Haiku

**Files:**
- Create: `daemon-v2/src/learning-extract.ts`
- Test: `daemon-v2/src/learning-extract.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, expect, it } from "vitest";
import { buildExtractPrompt, parseExtractResult } from "./learning-extract.js";
import { parseLearnings } from "./learning-file.js";

describe("buildExtractPrompt", () => {
  const prompt = buildExtractPrompt("CAL: hola\nJANO: hola", parseLearnings("- [2026-07-01] [pref] Ya sé esto\n"));

  it("incluye el transcript", () => {
    expect(prompt).toContain("CAL: hola");
  });

  it("le pasa los learnings existentes para que deduplique", () => {
    expect(prompt).toContain("Ya sé esto");
  });

  it("nombra los cuatro tags", () => {
    for (const t of ["pref", "hecho", "err", "flujo"]) expect(prompt).toContain(t);
  });

  it("dice explícitamente que devolver vacío es lo esperado", () => {
    expect(prompt.toLowerCase()).toContain("vacío");
  });
});

describe("parseExtractResult", () => {
  it("parsea una lista de candidatos", () => {
    const out = parseExtractResult(
      JSON.stringify([
        { tag: "pref", text: "Cal quiere el total primero", evidencia: "dijo 'primero el total'" },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe("pref");
  });

  it("tolera fences de markdown", () => {
    expect(parseExtractResult('```json\n[{"tag":"err","text":"algo","evidencia":"x"}]\n```')).toHaveLength(1);
  });

  it("devuelve vacío ante JSON inválido", () => {
    expect(parseExtractResult("no soy json")).toEqual([]);
  });

  it("devuelve vacío ante lista vacía", () => {
    expect(parseExtractResult("[]")).toEqual([]);
  });

  it("descarta candidatos con tag desconocido", () => {
    expect(parseExtractResult('[{"tag":"inventado","text":"algo","evidencia":"x"}]')).toEqual([]);
  });

  it("descarta candidatos sin texto", () => {
    expect(parseExtractResult('[{"tag":"pref","text":"","evidencia":"x"}]')).toEqual([]);
  });

  it("recorta textos larguísimos a 2 líneas de contenido", () => {
    const out = parseExtractResult(JSON.stringify([{ tag: "pref", text: "x".repeat(900), evidencia: "y" }]));
    expect(out[0].text.length).toBeLessThanOrEqual(300);
  });

  it("ignora un objeto suelto en vez de una lista", () => {
    expect(parseExtractResult('{"tag":"pref","text":"algo","evidencia":"x"}')).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- learning-extract`
Expected: FAIL — `Cannot find module './learning-extract.js'`.

- [ ] **Step 3: Implementar el módulo**

```typescript
// learning-extract.ts — el pase de reflexión. Haiku, maxTurns 1, sin tools.
// Mismo patrón acotado que journal-enrich.ts y compact.ts.
//
// Este módulo es la razón de ser del rediseño: hasta hoy la escritura de learnings la decidía el
// modelo EN MEDIO del turno, compitiendo con la tarea real — resultado, 4 entries en 3 meses.
// Acá la reflexión es el único trabajo de la llamada.

import { startup } from "@anthropic-ai/claude-agent-sdk";
import { LEARNING_TAGS, type Learning, type LearningCandidate, type LearningTag } from "./learning-types.js";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TEXT_CHARS = 300;

export function buildExtractPrompt(transcript: string, existentes: Learning[]): string {
  const yaSe = existentes.length
    ? existentes.map((l) => `- [${l.tag}] ${l.text}`).join("\n")
    : "(todavía no hay ninguno)";

  return [
    "Sos el módulo de reflexión de Jano, el asistente personal de Cal.",
    "Leé la transcripción del día y extraé aprendizajes que valgan para FUTURAS conversaciones.",
    "Devolvé SOLO un array JSON, sin explicación ni fences.",
    "",
    "Cada elemento: {\"tag\", \"text\", \"evidencia\"}",
    "",
    "Tags posibles:",
    '- "pref": preferencia de Cal sobre cómo quiere que Jano responda (formato, largo, orden).',
    '- "hecho": dato no obvio sobre Cal, su familia, su trabajo o su contexto.',
    '- "err": error operativo de Jano — una tool que falló y por qué, un parámetro que no acepta.',
    '- "flujo": secuencia que Cal repite y Jano puede anticipar.',
    "",
    '"text": máximo 2 líneas, en español, redactado como instrucción o hecho, no como narración.',
    '"evidencia": cita corta de la transcripción que lo justifica.',
    "",
    "REGLAS:",
    "1. NO repitas nada que ya esté en la lista de aprendizajes actuales de abajo.",
    "2. NO anotes algo que pasó una sola vez: un pedido puntual no es una preferencia.",
    "3. NO anotes comportamiento genérico de un asistente ni cosas obvias.",
    "4. Los TOOL ERROR de la transcripción son la mejor fuente de learnings tipo \"err\".",
    "5. Si no hay nada que realmente valga, devolvé un array vacío []. Devolver vacío es el",
    "   resultado ESPERADO la mayoría de los días — no inventes para justificar la llamada.",
    "",
    "Aprendizajes actuales:",
    yaSe,
    "",
    "Transcripción del día:",
    transcript,
  ].join("\n");
}

function isTag(v: unknown): v is LearningTag {
  return typeof v === "string" && (LEARNING_TAGS as readonly string[]).includes(v);
}

export function parseExtractResult(raw: string): LearningCandidate[] {
  const limpio = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(limpio);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: LearningCandidate[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (!isTag(o["tag"])) continue;
    const text = typeof o["text"] === "string" ? o["text"].trim() : "";
    if (!text) continue;
    out.push({
      tag: o["tag"],
      text: text.slice(0, MAX_TEXT_CHARS),
      evidencia: typeof o["evidencia"] === "string" ? o["evidencia"].trim().slice(0, 200) : "",
    });
  }
  return out;
}

/** Corre la llamada real. Devuelve [] si el modelo falla o responde algo inutilizable. */
export async function extractLearnings(
  transcript: string,
  existentes: Learning[],
): Promise<LearningCandidate[]> {
  if (!transcript.trim()) return [];

  const handle = await startup({
    options: { model: MODEL, maxTurns: 1, allowedTools: [] },
  });

  let out = "";
  try {
    for await (const event of handle.query(buildExtractPrompt(transcript, existentes))) {
      const e = event as { type?: string; subtype?: string; result?: string };
      if (e.type === "result" && e.subtype === "success") {
        out = e.result ?? "";
        break;
      }
    }
  } finally {
    // Cerrar SIEMPRE: sin close() queda un subprocess huérfano, y este daemon corre semanas sin
    // reiniciarse. Mismo motivo que enrichEntry y discardWarm.
    try {
      await handle.close();
    } catch {
      /* best-effort */
    }
  }
  return parseExtractResult(out);
}
```

- [ ] **Step 4: Correr los tests**

Run: `npm run test -w @cos/daemon -- learning-extract`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/learning-extract.ts daemon-v2/src/learning-extract.test.ts
git commit -m "feat(learning): extractor de aprendizajes con Haiku"
```

---

## Task 5: Tarjetas y store

**Files:**
- Create: `daemon-v2/src/learning-card.ts`
- Create: `daemon-v2/src/learning-store.ts`
- Test: `daemon-v2/src/learning-card.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, expect, it } from "vitest";
import { renderBatch, renderOneByOne, renderDone, renderNothing, TAG_EMOJI } from "./learning-card.js";
import type { LearningCandidate } from "./learning-types.js";

const CANDS: LearningCandidate[] = [
  { tag: "pref", text: "Cal quiere el total antes del desglose", evidencia: "«primero el total»" },
  { tag: "err", text: "notionApi: el body va como objeto", evidencia: "«invalid_json»" },
  { tag: "hecho", text: "El colegio cierra la última semana de julio", evidencia: "«cierran el 25»" },
];

describe("renderBatch", () => {
  it("numera en texto plano y muestra el emoji de cada tag", () => {
    const { text } = renderBatch(CANDS, "b1", 1200);
    expect(text).toContain("1. ");
    expect(text).toContain(TAG_EMOJI.pref);
    expect(text).toContain(TAG_EMOJI.err);
    // Nada de emojis numerados: no están en el lexicon y el Journal ya usa texto plano.
    expect(text).not.toContain("1️⃣");
  });

  it("lista como máximo 5 y avisa cuántos quedan", () => {
    const muchos: LearningCandidate[] = Array.from({ length: 9 }, (_, i) => ({
      tag: "pref" as const,
      text: `Candidato ${i}`,
      evidencia: "x",
    }));
    const { text } = renderBatch(muchos, "b1", 100);
    expect(text).toContain("Candidato 4");
    expect(text).not.toContain("Candidato 5");
    expect(text).toContain("(y 4 más)");
  });

  it("ofrece los tres botones", () => {
    const datas = renderBatch(CANDS, "b1", 1200).keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).toEqual(["lrn:all:b1", "lrn:one:b1", "lrn:none:b1"]);
  });

  it("no avisa de presupuesto cuando está por debajo", () => {
    expect(renderBatch(CANDS, "b1", 1200).text).not.toContain("presupuesto");
  });

  it("avisa cuando se pasó el presupuesto", () => {
    expect(renderBatch(CANDS, "b1", 4300).text).toContain("presupuesto");
  });

  it("escapa HTML", () => {
    const c: LearningCandidate[] = [{ tag: "pref", text: "usa <b> y & cia", evidencia: "x" }];
    expect(renderBatch(c, "b1", 100).text).toContain("&lt;b&gt;");
  });
});

describe("renderOneByOne", () => {
  it("muestra el candidato del cursor con su evidencia", () => {
    const { text } = renderOneByOne(CANDS, 1, "b1");
    expect(text).toContain("notionApi");
    expect(text).toContain("invalid_json");
    expect(text).toContain("2 de 3");
  });

  it("ofrece guardar y saltar el actual", () => {
    const datas = renderOneByOne(CANDS, 1, "b1").keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).toEqual(["lrn:keep:b1", "lrn:skip:b1", "lrn:none:b1"]);
  });
});

describe("renderDone / renderNothing", () => {
  it("renderDone resume cuántos se guardaron y deja el teclado vacío", () => {
    const card = renderDone(2, 1);
    expect(card.text).toContain("2");
    expect(card.keyboard.inline_keyboard).toEqual([]);
  });

  it("renderNothing es explícito", () => {
    expect(renderNothing().text).toContain("No guardé");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- learning-card`
Expected: FAIL — `Cannot find module './learning-card.js'`.

- [ ] **Step 3: Implementar `learning-card.ts`**

```typescript
// learning-card.ts — render PURO de las tarjetas del pase nocturno.
// Parse mode HTML (skill telegram-bot-ux): escapar solo < > &, bullets •, sin Markdown.
//
// Emojis de dominio (ninguno decorativo — cada uno mapea a un tag real del archivo):
//   🌙 reflexión nocturna · 🎯 pref · 🧠 hecho · 🔧 err · 🔁 flujo · 🧹 poda.

import type { LearningCandidate, LearningTag } from "./learning-types.js";

export interface Keyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface Card {
  text: string;
  keyboard: Keyboard;
}

export const TAG_EMOJI: Record<LearningTag, string> = {
  pref: "🎯",
  hecho: "🧠",
  err: "🔧",
  flujo: "🔁",
};

/**
 * Tope de candidatos listados en la tarjeta. Mismo criterio que `SWEEP_MAX_BOTONES` del Journal
 * (`journal-card.ts`): más de 5 convierte la tarjeta en una pared de texto en mobile. El resto
 * no se pierde — el modo uno-a-uno los recorre todos.
 */
const BATCH_MAX_VISIBLES = 5;

/** Debe coincidir con LEARNING_BUDGET_TOKENS de learning-file.ts. */
const BUDGET = 4000;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderBatch(cands: LearningCandidate[], batchId: string, tokensActuales: number): Card {
  const lines: string[] = [
    "🌙 <b>Reflexión del día</b>",
    "",
    `${cands.length} ${cands.length === 1 ? "aprendizaje candidato" : "aprendizajes candidatos"}:`,
    "",
  ];

  // Numeración en texto plano, no con emojis 1️⃣-🔟: es el patrón que ya usa renderSweepSelector
  // del Journal, y los emojis numerados no están en el lexicon del skill telegram-bot-ux.
  const visibles = cands.slice(0, BATCH_MAX_VISIBLES);
  visibles.forEach((c, i) => {
    lines.push(`${i + 1}. ${TAG_EMOJI[c.tag]} «${esc(c.text)}»`);
  });
  if (cands.length > visibles.length) {
    lines.push(`(y ${cands.length - visibles.length} más)`);
  }

  if (tokensActuales > BUDGET) {
    lines.push(
      "",
      `🧹 <b>Ojo:</b> los aprendizajes activos suman ~${tokensActuales} tokens y pasaron el presupuesto de ${BUDGET}. Conviene podar los viejos.`,
    );
  }

  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          { text: "✅ Guardar todos", callback_data: `lrn:all:${batchId}` },
          { text: "🔍 Uno a uno", callback_data: `lrn:one:${batchId}` },
        ],
        [{ text: "❌ Ninguno", callback_data: `lrn:none:${batchId}` }],
      ],
    },
  };
}

export function renderOneByOne(cands: LearningCandidate[], cursor: number, batchId: string): Card {
  const c = cands[cursor];
  const lines = [
    `🌙 <b>Aprendizaje ${cursor + 1} de ${cands.length}</b>`,
    "",
    `${TAG_EMOJI[c.tag]} «${esc(c.text)}»`,
  ];
  if (c.evidencia) lines.push("", `<i>${esc(c.evidencia)}</i>`);

  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          { text: "✅ Guardar", callback_data: `lrn:keep:${batchId}` },
          { text: "⏭️ Saltar", callback_data: `lrn:skip:${batchId}` },
        ],
        [{ text: "⏹️ Terminar", callback_data: `lrn:none:${batchId}` }],
      ],
    },
  };
}

export function renderDone(guardados: number, descartados: number): Card {
  const partes = [`Guardé ${guardados} ${guardados === 1 ? "aprendizaje" : "aprendizajes"}`];
  if (descartados > 0) partes.push(`descarté ${descartados}`);
  return {
    text: `🌙 <b>Listo</b>\n${partes.join(" · ")}.`,
    keyboard: { inline_keyboard: [] },
  };
}

export function renderNothing(): Card {
  return { text: "🌙 <b>Listo</b>\nNo guardé ninguno.", keyboard: { inline_keyboard: [] } };
}
```

- [ ] **Step 4: Implementar `learning-store.ts`**

```typescript
// learning-store.ts — batches de candidatos esperando los botones de Cal, en CF KV.
// Espejo reducido de journal-store.ts.

import type { CfKv } from "./cf-kv.js";
import type { LearningBatch } from "./learning-types.js";

/** 24 h: el pase corre de noche y Cal puede tocarlo a la mañana siguiente. */
const BATCH_TTL_SEC = 24 * 3600;

export class LearningStore {
  constructor(private kv: CfKv) {}

  private key(chatId: number, batchId: string): string {
    return `jano:learning:batch:${chatId}:${batchId}`;
  }

  async createBatch(chatId: number, payload: LearningBatch): Promise<string> {
    const batchId = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
    await this.kv.set(this.key(chatId, batchId), payload, BATCH_TTL_SEC);
    return batchId;
  }

  async getBatch(chatId: number, batchId: string): Promise<LearningBatch | null> {
    return await this.kv.get<LearningBatch>(this.key(chatId, batchId));
  }

  async updateBatch(chatId: number, batchId: string, payload: LearningBatch): Promise<void> {
    await this.kv.set(this.key(chatId, batchId), payload, BATCH_TTL_SEC);
  }

  async clearBatch(chatId: number, batchId: string): Promise<void> {
    await this.kv.delete(this.key(chatId, batchId));
  }
}
```

- [ ] **Step 5: Correr los tests**

Run: `npm run test -w @cos/daemon -- learning-card`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add daemon-v2/src/learning-card.ts daemon-v2/src/learning-store.ts daemon-v2/src/learning-card.test.ts
git commit -m "feat(learning): tarjetas del pase nocturno y store de batches"
```

---

## Task 6: Callbacks del pase nocturno

**Files:**
- Create: `daemon-v2/src/learning-callbacks.ts`
- Test: `daemon-v2/src/learning-callbacks.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLearningCallback, handleLearningCallback } from "./learning-callbacks.js";
import { LearningStore } from "./learning-store.js";
import type { CfKv } from "./cf-kv.js";
import type { LearningCandidate } from "./learning-types.js";

const DIR = join(tmpdir(), "jano-test-learning-cb");
const FILE = join(DIR, "learnings.md");

const CANDS: LearningCandidate[] = [
  { tag: "pref", text: "Primero el total", evidencia: "a" },
  { tag: "err", text: "notionApi body como objeto", evidencia: "b" },
];

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

function fakeDeps(store: LearningStore) {
  const edits: Array<{ text: string }> = [];
  return {
    edits,
    deps: {
      store,
      learningsPath: FILE,
      today: "2026-07-28",
      log: () => {},
      editCard: async (_c: number, _m: number, text: string) => {
        edits.push({ text });
      },
    },
  };
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, "");
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("isLearningCallback", () => {
  it("reconoce solo su prefijo", () => {
    expect(isLearningCallback("lrn:all:b1")).toBe(true);
    expect(isLearningCallback("j:menu")).toBe(false);
    expect(isLearningCallback(undefined)).toBe(false);
  });
});

describe("handleLearningCallback", () => {
  it("lrn:all guarda todos con su tag", async () => {
    const store = new LearningStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const id = await store.createBatch(1, { fecha: "2026-07-28", candidates: CANDS, cursor: 0, tokensActuales: 100 });

    await handleLearningCallback(deps, 1, 10, `lrn:all:${id}`);

    const out = readFileSync(FILE, "utf8");
    expect(out).toContain("- [2026-07-28] [pref] Primero el total");
    expect(out).toContain("- [2026-07-28] [err] notionApi body como objeto");
    expect(edits.at(-1)?.text).toContain("2");
    expect(await store.getBatch(1, id)).toBeNull();
  });

  it("lrn:none no guarda nada", async () => {
    const store = new LearningStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const id = await store.createBatch(1, { fecha: "2026-07-28", candidates: CANDS, cursor: 0, tokensActuales: 100 });

    await handleLearningCallback(deps, 1, 10, `lrn:none:${id}`);

    expect(readFileSync(FILE, "utf8")).toBe("");
    expect(edits.at(-1)?.text).toContain("No guardé");
  });

  it("lrn:keep guarda solo el del cursor y avanza", async () => {
    const store = new LearningStore(fakeKv());
    const { deps } = fakeDeps(store);
    const id = await store.createBatch(1, { fecha: "2026-07-28", candidates: CANDS, cursor: 0, tokensActuales: 100 });

    await handleLearningCallback(deps, 1, 10, `lrn:one:${id}`);
    await handleLearningCallback(deps, 1, 10, `lrn:keep:${id}`);

    const out = readFileSync(FILE, "utf8");
    expect(out).toContain("Primero el total");
    expect(out).not.toContain("notionApi");
    expect((await store.getBatch(1, id))?.cursor).toBe(1);
  });

  it("lrn:skip avanza sin guardar", async () => {
    const store = new LearningStore(fakeKv());
    const { deps } = fakeDeps(store);
    const id = await store.createBatch(1, { fecha: "2026-07-28", candidates: CANDS, cursor: 0, tokensActuales: 100 });

    await handleLearningCallback(deps, 1, 10, `lrn:skip:${id}`);

    expect(readFileSync(FILE, "utf8")).toBe("");
    expect((await store.getBatch(1, id))?.cursor).toBe(1);
  });

  it("al pasar el último candidato cierra el batch con el resumen", async () => {
    const store = new LearningStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const id = await store.createBatch(1, { fecha: "2026-07-28", candidates: CANDS, cursor: 1, tokensActuales: 100 });

    await handleLearningCallback(deps, 1, 10, `lrn:keep:${id}`);

    expect(edits.at(-1)?.text).toContain("Listo");
    expect(await store.getBatch(1, id)).toBeNull();
  });

  it("un batch expirado avisa en vez de romper", async () => {
    const store = new LearningStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    await handleLearningCallback(deps, 1, 10, "lrn:all:noexiste");
    expect(edits.at(-1)?.text).toContain("expiró");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- learning-callbacks`
Expected: FAIL — `Cannot find module './learning-callbacks.js'`.

- [ ] **Step 3: Implementar el módulo**

```typescript
// learning-callbacks.ts — callbacks lrn:* de la tarjeta del pase nocturno.
// Mecánicos (sin LLM) y HEAVY (escriben a disco): en index.ts van con el lock anti-doble-tap.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { formatLearning } from "./learning-file.js";
import { renderOneByOne, renderDone, renderNothing } from "./learning-card.js";
import type { LearningStore } from "./learning-store.js";
import type { LearningCandidate } from "./learning-types.js";

export interface LearningCallbackDeps {
  store: LearningStore;
  learningsPath: string;
  /** Fecha YYYY-MM-DD con la que se escriben los learnings. Parametrizada para tests. */
  today: string;
  log: (obj: Record<string, unknown>) => void;
  editCard: (chatId: number, messageId: number, text: string, keyboard?: unknown) => Promise<void>;
}

export function isLearningCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith("lrn:");
}

function persist(path: string, cands: LearningCandidate[], today: string): void {
  if (cands.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  const body = cands.map((c) => formatLearning({ date: today, tag: c.tag, text: c.text })).join("\n");
  appendFileSync(path, `${body}\n`, "utf8");
}

export async function handleLearningCallback(
  deps: LearningCallbackDeps,
  chatId: number,
  messageId: number,
  data: string,
): Promise<void> {
  const [, action, batchId] = data.split(":");
  const batch = await deps.store.getBatch(chatId, batchId);

  if (!batch) {
    await deps.editCard(chatId, messageId, "⌛ <b>Esa tanda expiró.</b> La reflexión de esta noche te va a proponer de nuevo lo que siga valiendo.", { inline_keyboard: [] });
    return;
  }

  if (action === "all") {
    persist(deps.learningsPath, batch.candidates, deps.today);
    await deps.store.clearBatch(chatId, batchId);
    const card = renderDone(batch.candidates.length, 0);
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    deps.log({ msg: "learning_batch_saved", count: batch.candidates.length });
    return;
  }

  if (action === "none") {
    await deps.store.clearBatch(chatId, batchId);
    const card = renderNothing();
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    deps.log({ msg: "learning_batch_discarded", count: batch.candidates.length });
    return;
  }

  if (action === "one") {
    const card = renderOneByOne(batch.candidates, batch.cursor, batchId);
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    return;
  }

  if (action !== "keep" && action !== "skip") return;

  if (action === "keep") {
    persist(deps.learningsPath, [batch.candidates[batch.cursor]], deps.today);
  }

  const cursor = batch.cursor + 1;
  if (cursor >= batch.candidates.length) {
    await deps.store.clearBatch(chatId, batchId);
    // El conteo exacto de guardados en modo uno-a-uno no se lleva en KV: el resumen informa
    // cuántos quedaban por revisar, no una auditoría. El archivo es la fuente de verdad.
    const card = renderDone(action === "keep" ? 1 : 0, action === "skip" ? 1 : 0);
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    deps.log({ msg: "learning_one_by_one_done" });
    return;
  }

  await deps.store.updateBatch(chatId, batchId, { ...batch, cursor });
  const card = renderOneByOne(batch.candidates, cursor, batchId);
  await deps.editCard(chatId, messageId, card.text, card.keyboard);
}
```

- [ ] **Step 4: Correr los tests**

Run: `npm run test -w @cos/daemon -- learning-callbacks`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/learning-callbacks.ts daemon-v2/src/learning-callbacks.test.ts
git commit -m "feat(learning): callbacks lrn:* del pase nocturno"
```

---

## Task 7: El cron nocturno

**Files:**
- Create: `daemon-v2/src/proactive/learning-reflect.ts`
- Test: `daemon-v2/src/proactive/learning-reflect.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, expect, it, vi } from "vitest";
import { reflectDedupKey, runReflection } from "./learning-reflect.js";
import type { LearningCandidate } from "../learning-types.js";

describe("reflectDedupKey", () => {
  it("es una clave por día", () => {
    expect(reflectDedupKey(new Date("2026-07-28T22:00:00-04:00"))).toContain("2026-07-28");
  });
});

describe("runReflection", () => {
  const baseDeps = () => ({
    sessionIds: ["s1"],
    transcript: "CAL: hola\nJANO: hola",
    existentes: [],
    extract: vi.fn(async (): Promise<LearningCandidate[]> => []),
    createBatch: vi.fn(async () => "b1"),
    send: vi.fn(async () => {}),
    log: vi.fn(),
  });

  it("no manda nada si no hubo sesiones", async () => {
    const d = { ...baseDeps(), sessionIds: [] as string[] };
    await runReflection(d, "2026-07-28");
    expect(d.extract).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("no manda nada si el extractor no encontró candidatos", async () => {
    const d = baseDeps();
    await runReflection(d, "2026-07-28");
    expect(d.extract).toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("manda la tarjeta cuando hay candidatos", async () => {
    const d = baseDeps();
    d.extract = vi.fn(async () => [{ tag: "pref" as const, text: "Primero el total", evidencia: "x" }]);
    await runReflection(d, "2026-07-28");
    expect(d.createBatch).toHaveBeenCalled();
    expect(d.send).toHaveBeenCalledOnce();
    expect((d.send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("Reflexión del día");
  });

  it("filtra los candidatos duplicados antes de proponer", async () => {
    const d = baseDeps();
    d.existentes = [{ date: "2026-07-01", tag: "pref" as const, text: "Cal quiere el total antes del desglose" }];
    d.extract = vi.fn(async () => [
      { tag: "pref" as const, text: "Cal quiere primero el total y después el desglose", evidencia: "x" },
    ]);
    await runReflection(d, "2026-07-28");
    expect(d.send).not.toHaveBeenCalled();
  });

  it("no explota si el extractor tira error", async () => {
    const d = baseDeps();
    d.extract = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(runReflection(d, "2026-07-28")).resolves.toBeUndefined();
    expect(d.send).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- learning-reflect`
Expected: FAIL — `Cannot find module './learning-reflect.js'`.

- [ ] **Step 3: Implementar el módulo**

```typescript
// proactive/learning-reflect.ts — el pase nocturno de reflexión.
//
// Cuarta (y última) excepción a la arquitectura reactiva de Jano, junto a health-sync-check,
// kpi-ingest-check y journal-sweep. Corre una vez al día: una llamada a Haiku, despreciable.
//
// La lógica pura vive en runReflection(), con todas las dependencias inyectadas, para poder
// testear el flujo entero sin tocar el SDK, el disco ni la red.

import cron from "node-cron";
import { sendMessage } from "@cos/shared";
import type { CfKv } from "../cf-kv.js";
import { dedupeCandidates, parseLearnings, totalTokens } from "../learning-file.js";
import { renderBatch } from "../learning-card.js";
import { extractLearnings } from "../learning-extract.js";
import { buildDayTranscript } from "../learning-transcript.js";
import { LearningStore } from "../learning-store.js";
import { pruneSessionLog, sessionIdsForDay, SESSION_LOG_PATH } from "../session-log.js";
import type { Learning, LearningCandidate } from "../learning-types.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEDUP_TTL_SEC = 48 * 3600;

/** Directorio donde el SDK persiste las sesiones de este proyecto. */
export const SDK_SESSIONS_DIR = join(
  homedir(),
  ".claude",
  "projects",
  "-Users-calepes-Claude-Projects-Personal-Agents-Jano",
);

export const LEARNINGS_PATH = join(homedir(), ".cos-agent", "learnings.md");

export function reflectDedupKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `jano:learning:reflect:${y}-${m}-${d}`;
}

export interface ReflectionDeps {
  sessionIds: string[];
  transcript: string;
  existentes: Learning[];
  extract: (transcript: string, existentes: Learning[]) => Promise<LearningCandidate[]>;
  createBatch: (candidates: LearningCandidate[], tokensActuales: number) => Promise<string>;
  send: (text: string, keyboard: unknown) => Promise<void>;
  log: (obj: Record<string, unknown>) => void;
}

/** Lógica pura del pase. Devuelve sin hacer nada cuando no hay material — el caso más común. */
export async function runReflection(deps: ReflectionDeps, fecha: string): Promise<void> {
  if (deps.sessionIds.length === 0) {
    deps.log({ msg: "learning_reflect_no_sessions", fecha });
    return;
  }

  let candidates: LearningCandidate[];
  try {
    candidates = await deps.extract(deps.transcript, deps.existentes);
  } catch (err) {
    // Un fallo del extractor no debe romper el cron ni dejar rastro en el chat de Cal:
    // mañana vuelve a correr sobre las sesiones de mañana.
    deps.log({ msg: "learning_reflect_extract_failed", err: String(err) });
    return;
  }

  const frescos = dedupeCandidates(candidates, deps.existentes);
  if (frescos.length === 0) {
    deps.log({ msg: "learning_reflect_empty", fecha, raw: candidates.length });
    return;
  }

  const tokensActuales = totalTokens(deps.existentes);
  const batchId = await deps.createBatch(frescos, tokensActuales);
  const card = renderBatch(frescos, batchId, tokensActuales);
  await deps.send(card.text, card.keyboard);
  deps.log({ msg: "learning_reflect_proposed", count: frescos.length, tokensActuales });
}

export interface ScheduleOpts {
  kv: CfKv;
  botToken: string;
  chatId: number;
  log: (obj: Record<string, unknown>) => void;
}

export async function checkLearningReflect(opts: ScheduleOpts): Promise<void> {
  const { kv, botToken, chatId, log } = opts;
  const dedupKey = reflectDedupKey();
  try {
    if (await kv.get<boolean>(dedupKey)) return;
    await kv.set(dedupKey, true, DEDUP_TTL_SEC);

    const fecha = dedupKey.slice(-10);
    const sessionIds = sessionIdsForDay(SESSION_LOG_PATH, fecha);
    const store = new LearningStore(kv);
    let existentes: Learning[] = [];
    try {
      existentes = parseLearnings(readFileSync(LEARNINGS_PATH, "utf8"));
    } catch {
      /* primer arranque: no hay archivo todavía */
    }

    await runReflection(
      {
        sessionIds,
        transcript: buildDayTranscript(SDK_SESSIONS_DIR, sessionIds),
        existentes,
        extract: extractLearnings,
        createBatch: (candidates, tokensActuales) =>
          store.createBatch(chatId, { fecha, candidates, cursor: 0, tokensActuales }),
        send: async (text, keyboard) => {
          await sendMessage(botToken, {
            chatId,
            text,
            parseMode: "HTML",
            replyMarkup: keyboard,
          });
        },
        log,
      },
      fecha,
    );

    pruneSessionLog(SESSION_LOG_PATH);
  } catch (err) {
    log({ msg: "learning_reflect_error", err: String(err) });
  }
}

/** Cron 22:00 hora de La Paz. */
export function scheduleLearningReflect(opts: ScheduleOpts): void {
  cron.schedule("0 22 * * *", () => void checkLearningReflect(opts), {
    timezone: "America/La_Paz",
  });
  opts.log({ msg: "learning_reflect_scheduled", cron: "0 22 * * *" });
}
```

- [ ] **Step 4: Verificar el nombre real del directorio de sesiones**

Run: `ls -d ~/.claude/projects/-Users-calepes-Claude-Projects-Personal-Agents-Jano`
Expected: el directorio existe. Si el nombre difiere, corregir `SDK_SESSIONS_DIR`.

- [ ] **Step 5: Verificar la firma de `sendMessage`**

Run: `grep -n "interface SendMessageOpts" -A 8 shared-v2/src/telegram.ts`
Expected: confirma que acepta `replyMarkup`. Si el campo tiene otro nombre, ajustar la lambda `send`.

- [ ] **Step 6: Correr los tests**

Run: `npm run test -w @cos/daemon -- learning-reflect`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add daemon-v2/src/proactive/learning-reflect.ts daemon-v2/src/proactive/learning-reflect.test.ts
git commit -m "feat(learning): cron nocturno de reflexión"
```

---

## Task 8: Inyección con tags y aviso de presupuesto

**Files:**
- Modify: `daemon-v2/src/learnings.ts`
- Test: `daemon-v2/src/learnings.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLearningsSection } from "./learnings.js";

const DIR = join(tmpdir(), "jano-test-learnings-section");
const FILE = join(DIR, "learnings.md");

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("buildLearningsSection", () => {
  it("agrupa los learnings por categoría", () => {
    writeFileSync(
      FILE,
      "- [2026-07-28] [pref] Primero el total\n- [2026-07-28] [err] notionApi body objeto\n",
    );
    const s = buildLearningsSection(FILE);
    expect(s).toContain("Preferencias de Cal");
    expect(s).toContain("Errores a evitar");
    expect(s).toContain("Primero el total");
  });

  it("sigue funcionando con el archivo vacío", () => {
    writeFileSync(FILE, "");
    expect(buildLearningsSection(FILE)).toContain("Sin learnings todavía");
  });

  it("sigue funcionando si el archivo no existe", () => {
    expect(buildLearningsSection(join(DIR, "no-existe.md"))).toContain("Sin learnings todavía");
  });

  it("incluye las líneas viejas sin tag", () => {
    writeFileSync(FILE, "- [2026-05-03] Algo viejo sin tag\n");
    expect(buildLearningsSection(FILE)).toContain("Algo viejo sin tag");
  });

  it("ya no le pide al modelo que llame addLearning en medio del turno", () => {
    writeFileSync(FILE, "- [2026-07-28] [pref] Algo\n");
    expect(buildLearningsSection(FILE)).not.toContain("addLearning");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm run test -w @cos/daemon -- learnings`
Expected: FAIL — el texto actual sigue mencionando `addLearning` y no agrupa por categoría.

- [ ] **Step 3: Reemplazar `buildLearningsSection` en `learnings.ts`**

Dejar `loadLearnings` y `appendLearning` como están (los usa el MCP y los tests existentes) y
reemplazar solo `buildLearningsSection`:

```typescript
import { parseLearnings } from "./learning-file.js";
import type { LearningTag } from "./learning-types.js";

const TAG_TITLE: Record<LearningTag, string> = {
  pref: "Preferencias de Cal",
  hecho: "Hechos sobre Cal y su contexto",
  err: "Errores a evitar",
  flujo: "Flujos que Cal repite",
};

const TAG_ORDER: LearningTag[] = ["pref", "err", "flujo", "hecho"];

/**
 * Arma la sección de aprendizajes del system prompt, agrupada por categoría.
 *
 * Ya NO le pide al modelo que llame addLearning en medio del turno: ese era el diseño viejo y
 * en tres meses produjo 4 entries — la reflexión competía con la tarea real y perdía siempre.
 * Ahora la captura la hace el pase nocturno (proactive/learning-reflect.ts), y el camino manual
 * es que Cal diga "recuerda que…".
 */
export function buildLearningsSection(path: string): string {
  const learnings = parseLearnings(loadLearnings(path));
  if (learnings.length === 0) {
    return `\n\n## Aprendizajes acumulados\n\n(Sin learnings todavía)`;
  }

  const bloques: string[] = [];
  for (const tag of TAG_ORDER) {
    const items = learnings.filter((l) => l.tag === tag);
    if (items.length === 0) continue;
    bloques.push(`### ${TAG_TITLE[tag]}\n${items.map((l) => `- ${l.text}`).join("\n")}`);
  }

  return `\n\n## Aprendizajes acumulados\n\nCosas que aprendiste de Cal en conversaciones anteriores. Aplicalas sin anunciarlas.\n\n${bloques.join("\n\n")}`;
}
```

- [ ] **Step 4: Correr los tests**

Run: `npm run test -w @cos/daemon -- learnings`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/learnings.ts daemon-v2/src/learnings.test.ts
git commit -m "feat(learning): inyección agrupada por categoría en el system prompt"
```

---

## Task 9: Camino manual — "Jano, recuerda que…"

**Files:**
- Modify: `daemon-v2/src/agent-tools.ts`
- Modify: `daemon-v2/src/system-prompt.ts`

- [ ] **Step 1: Agregar el import en `agent-tools.ts`**

```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatLearning } from "./learning-file.js";
import { LEARNING_TAGS } from "./learning-types.js";
```

Si `appendFileSync`/`mkdirSync` ya están importados de `node:fs` en ese archivo, sumarlos al import
existente en vez de duplicar la línea.

- [ ] **Step 2: Agregar la tool**

Junto a las demás tools del array:

```typescript
    tool(
      "recordarAprendizaje",
      "Guarda YA un aprendizaje persistente que Cal pidió explícitamente recordar. " +
      "Usar SOLO cuando Cal diga algo como 'recordá que...', 'acordate de que...', 'de ahora en más...', " +
      "'no vuelvas a...'. NO la uses por iniciativa propia en medio de una tarea — de eso se encarga la " +
      "reflexión nocturna, que le propone los candidatos a Cal para que apruebe. " +
      "Redactá el texto en una o dos líneas, como instrucción o hecho. Respondé con un ack breve, sin repetir todo.",
      {
        texto: z.string().min(5).max(300).describe("El aprendizaje, en 1-2 líneas"),
        tag: z
          .enum(LEARNING_TAGS)
          .describe(
            "pref = preferencia de formato/estilo · hecho = dato sobre Cal o su contexto · err = error operativo tuyo a evitar · flujo = secuencia que Cal repite",
          ),
      },
      async ({ texto, tag }) => {
        const path = join(homedir(), ".cos-agent", "learnings.md");
        const date = new Date().toISOString().slice(0, 10);
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${formatLearning({ date, tag, text: texto.trim() })}\n`, "utf8");
        return asText("Guardado. Respondé solo: 🧠 Anotado.");
      },
    ),
```

- [ ] **Step 3: Actualizar la sección `## Aprendizajes` del system prompt**

Reemplazar la sección existente (que hoy apunta a `mcp__agent-learnings__addLearning`) por:

```typescript
## Aprendizajes

Tus aprendizajes acumulados están más abajo, agrupados por categoría. Aplicalos sin anunciarlos.

- Cuando Cal diga explícitamente "recordá que...", "acordate de...", "de ahora en más..." o
  "no vuelvas a...", llamá \`mcp__cos-tools__recordarAprendizaje({ texto, tag })\` y respondé
  solo "🧠 Anotado.".
- NO guardes aprendizajes por iniciativa propia en medio de una tarea. Cada noche corre una
  reflexión que revisa el día entero y le propone candidatos a Cal para que apruebe — ese es el
  camino, y funciona mejor porque no compite con lo que estás resolviendo.
- \`mcp__agent-learnings__addLearning\` quedó obsoleta: no la uses.
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/agent-tools.ts daemon-v2/src/system-prompt.ts
git commit -m "feat(learning): tool recordarAprendizaje y guía en el system prompt"
```

---

## Task 10: Wiring en index.ts

**Files:**
- Modify: `daemon-v2/src/index.ts`

- [ ] **Step 1: Agregar imports**

```typescript
import { isLearningCallback, handleLearningCallback } from "./learning-callbacks.js";
import { LearningStore } from "./learning-store.js";
import { scheduleLearningReflect, LEARNINGS_PATH } from "./proactive/learning-reflect.js";
```

- [ ] **Step 2: Instanciar el store junto a `journalStore`**

```typescript
const learningStore = new LearningStore(kv);
```

- [ ] **Step 3: Agregar el routing de callbacks**

Insertar junto a los otros bloques mecánicos, **arriba** del `startsWith("j:")` genérico:

```typescript
    // Callbacks del pase nocturno de aprendizajes (lrn:*) → mecánicos, sin LLM. Escriben a
    // disco, así que llevan el mismo lock anti-doble-tap que jnl:* y mlog:/mskip:/msel:.
    if (isLearningCallback(cb.data)) {
      const lchat = cb.message.chat.id;
      const lanchor = cb.message.message_id;
      const lockUserId = cb.from.id;

      const acquired = await tryAcquireLock(kv, lchat, lockUserId, MEETING_FLOW_LOCK_TTL_SEC);
      if (!acquired) {
        await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id, "⏳ Todavía estoy procesando tu toque anterior...").catch(() => {});
        return;
      }
      await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id).catch(() => {});

      void handleLearningCallback(
        {
          store: learningStore,
          learningsPath: LEARNINGS_PATH,
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
        lchat,
        lanchor,
        cb.data!,
      )
        .catch((err) => log({ msg: "learning_callback_error", err: String(err) }))
        .finally(() => releaseLock(kv, lchat, lockUserId).catch(() => {}));
      return;
    }
```

- [ ] **Step 4: Registrar el cron**

Dentro de `loop()`, junto a `scheduleJournalSweep(...)`:

```typescript
  scheduleLearningReflect({ kv, botToken: env.COS_TELEGRAM_BOT_TOKEN, chatId: CAL_CHAT_ID, log });
```

Usar el mismo identificador de chat que usan `scheduleJournalSweep` y `scheduleHealthSyncCheck`
(verificar con `grep -n "scheduleJournalSweep(" -A 3 daemon-v2/src/index.ts`).

- [ ] **Step 5: Verificar el orden del routing**

Run: `grep -n "isLearningCallback\|startsWith(\"j:\")" daemon-v2/src/index.ts`
Expected: la línea de `isLearningCallback` debe tener número **menor** que la de `startsWith("j:")`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores.

- [ ] **Step 7: Commit**

```bash
git add daemon-v2/src/index.ts
git commit -m "feat(learning): wiring del cron nocturno y los callbacks lrn:*"
```

---

## Task 11: Suite completa, build y despliegue

- [ ] **Step 1: Suite entera**

Run: `npm run test -w @cos/daemon`
Expected: PASS. Ningún test preexistente roto.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores.

- [ ] **Step 3: Review del daemon**

Invocar el subagent `daemon-health-reviewer` (obligatorio tras tocar `index.ts`, `agent-tools.ts`
y `system-prompt.ts`). Aplicar los hallazgos **blocking**; anotar los **warning**.

- [ ] **Step 4: Build**

Run: `npm -w @cos/shared run build && npm -w @cos/daemon run build`
Expected: sin errores.

- [ ] **Step 5: Prueba en seco del pase, sin esperar a las 22:00**

Crear `daemon-v2/scripts/run-reflection-now.ts`:

```typescript
// Dispara el pase de reflexión a mano, para no esperar al cron de las 22:00.
import { checkLearningReflect } from "../src/proactive/learning-reflect.js";
import { makeCfKv } from "../src/cf-kv.js";

const kv = makeCfKv({
  accountId: process.env.CF_ACCOUNT_ID!,
  namespaceId: process.env.CF_KV_NAMESPACE_ID!,
  token: process.env.CF_API_TOKEN!,
});

await checkLearningReflect({
  kv,
  botToken: process.env.COS_TELEGRAM_BOT_TOKEN!,
  chatId: Number(process.env.CAL_CHAT_ID ?? 94137698),
  log: (o) => console.log(JSON.stringify(o)),
});
```

Verificar el nombre real del constructor de KV (`grep -n "export function makeCfKv\|export class CfKv" daemon-v2/src/cf-kv.ts`) y el de las env vars (`grep -n "CF_" daemon-v2/src/index.ts | head`) antes de correrlo; ajustar si difieren.

Run: `cd daemon-v2 && npx tsx scripts/run-reflection-now.ts`
Expected: log `learning_reflect_no_sessions` (todavía no hay sesiones registradas — el registro
empieza a poblarse recién con el daemon nuevo corriendo). Eso confirma que el pase corre sin
romper.

- [ ] **Step 6: Pedir a Cal el restart del daemon**

El clasificador bloquea `launchctl` en sesión interactiva. Pedirle a Cal que corra, con `!`:

```
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
```

- [ ] **Step 7: Verificar que el cron quedó registrado**

Run: `grep "learning_reflect_scheduled" ~/Library/Logs/cos-agent-v2.out.log | tail -1`
Expected: una línea con `"cron":"0 22 * * *"`.

- [ ] **Step 8: Verificación end-to-end con Cal**

1. Cal manda 2-3 mensajes cualquiera por Telegram (para poblar el registro de sesiones).
2. Verificar el registro: `wc -l ~/.cos-agent/sessions-log.jsonl` — debe tener al menos una línea.
3. Cal dice "Jano, recordá que prefiero el total antes del desglose" → debe responder "🧠 Anotado."
   y aparecer la línea con tag `pref` en `~/.cos-agent/learnings.md`.
4. Correr el pase a mano de nuevo (Step 5) → ahora debe encontrar sesiones. Si hay candidatos,
   llega la tarjeta; si no, log `learning_reflect_empty` (resultado esperado y correcto).
5. Si llegó tarjeta: tocar 🔍 Uno a uno, guardar uno y saltar otro; verificar el archivo.

- [ ] **Step 9: Checklist final del skill `telegram-bot-ux`**

Invocar el skill y correr su checklist de 5 puntos contra la tarjeta ya renderizada en el chat
real. Verificar en particular:

- La tarjeta lista máximo 5 candidatos y avisa `(y N más)` si hay más.
- Numeración en texto plano (`1.`), sin emojis numerados.
- Ningún emoji fuera del lexicon (`🌙 🎯 🧠 🔧 🔁 🧹` ya documentados).
- Al cerrar (guardar todos / ninguno / terminar) la tarjeta queda sin botones vivos.

- [ ] **Step 10: Documentar en CLAUDE.md y CHANGELOG.md**

Agregar a `CLAUDE.md` los emojis de dominio (el lexicon global ya los tiene; el skill exige el
espejo en el proyecto):

```markdown
- **Emojis de dominio del self-learning** (extensión del lexicon de `telegram-bot-ux`):
  `🌙` reflexión nocturna · `🎯` preferencia · `🧠` hecho sobre Cal · `🔧` error operativo ·
  `🔁` flujo repetido (mismo emoji que TRX en KPIs Yape — nunca coexisten en un mensaje) ·
  `🧹` poda de learnings viejos. Ninguno es decorativo.
```

Y además:
- En la sección "Automatización — dos capas": `scheduleLearningReflect()` como **quinto**
  proactivo interno activo, con su cron `0 22 * * *`.
- Una sección "Self-learning" con: el diagnóstico (4 entries en 3 meses por reflexión in-turn),
  el gotcha del directorio de sesiones compartido con Claude Code, los 4 tags, y el presupuesto
  blando de 4K tokens.

Actualizar el conteo de proactivos internos, que hoy dice "4".

```bash
git add CLAUDE.md CHANGELOG.md daemon-v2/scripts/run-reflection-now.ts
git commit -m "docs(learning): documentar el pase nocturno de reflexión"
```

---

## Self-review de este plan

**Cobertura del spec (Parte 2):**

| Requisito del spec | Task |
|---|---|
| Reflexión fuera del turno, Haiku maxTurns:1 sin tools | 4, 7 |
| Lectura de `.jsonl` con tool calls y errores | 3 |
| Aislar sesiones del daemon vs. Claude Code | 2 |
| Cuatro tags en un solo archivo | 1 |
| Compatibilidad con las 4 entries viejas sin tag | 1, 8 |
| Prompt con precisión sobre recall + "vacío es lo esperado" | 4 |
| Dedupe contra existentes | 1, 7 |
| Tarjeta selector con guardar todos / uno a uno / ninguno | 5, 6 |
| Callbacks HEAVY con lock, arriba de `j:` | 6, 10 |
| Dedup del cron en KV | 7 |
| Camino manual "recordá que…" | 9 |
| Presupuesto blando de 4K con aviso, sin cortar | 1, 5 |
| Consolidación de duplicados | 1 (`dedupeCandidates` evita que entren nuevos duplicados) |

**Gap consciente respecto del spec:** el spec también pide que el pase proponga **fundir
learnings existentes** y archivar obsoletos a `learnings-archive.md`. Este plan implementa la
prevención (dedupe de candidatos nuevos) y el semáforo, pero **no** la consolidación retroactiva
de lo ya guardado. Razón: con 4 learnings hoy y ~2/día aprobados, el presupuesto no se toca
en meses, y construirlo ahora sería adivinar sobre datos que no existen. El aviso de presupuesto
es el disparador para implementarlo cuando de verdad haga falta. Anotarlo en `BACKLOG.md` al
terminar.

**Consistencia de tipos:** `Learning` / `LearningCandidate` / `LearningBatch` / `LearningTag` se
definen en Task 1 y se usan con esos nombres y campos en 1, 4, 5, 6 y 7. `formatLearning` se define
en Task 1 y se usa en 6 y 9. `parseLearnings` se define en Task 1 y se usa en 4, 7 y 8.
`LEARNING_BUDGET_TOKENS` (Task 1) y la constante `BUDGET` de `learning-card.ts` (Task 5) deben
valer ambas 4000 — el test de Task 5 (`avisa cuando se pasó el presupuesto`, con 4300) lo verifica
indirectamente.
