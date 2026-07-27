# Journal de reflexión (terapia) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que Cal pueda descargar pensamientos en Telegram (texto o voz) y queden guardados tal cual en una DB `Journal` de Notion con fecha y hora, y que las reflexiones que valen la pena pasen a Resonate Calendar con su aprobación.

**Architecture:** Guardado en dos tiempos — primero una escritura mecánica sin LLM que persiste el texto íntegro (nunca se pierde un pensamiento), después un enriquecimiento con LLM que propone metadata vía tarjeta con botones (patrón `propose → botones` de Pecunia). La destilación a Resonate es un segundo checkpoint sobre la misma tarjeta, más un barrido dominical de lo que quedó `Sin revisar`.

**Tech Stack:** TypeScript + Node (daemon-v2), `ntn` CLI para Notion (vía `tools/notion-cli.ts`), Cloudflare KV para propuestas y modo, `node-cron` para el barrido, `@anthropic-ai/claude-agent-sdk` (`startup` con Haiku, patrón de `compact.ts`) para el enriquecimiento, vitest para tests.

**Spec:** `docs/superpowers/specs/2026-07-27-journal-terapia-notion-design.md`

> **Nota sobre commits:** la regla global de Cal es que los commits van solo cuando los pide. Los pasos de commit de este plan están escritos como parte del flujo TDD — **confirmá con Cal antes del primer commit** y, si dice que sí, seguí commiteando por tarea sin volver a preguntar.

---

## Estructura de archivos

**Nuevos** (`daemon-v2/src/`):

| Archivo | Responsabilidad |
|---|---|
| `journal-ids.ts` | IDs de Notion (generado por la Task 1) |
| `journal-types.ts` | Tipos compartidos: payloads de propuesta, snapshots de undo, constantes de `Ánimo` |
| `journal-text.ts` | Funciones puras de texto: parseo del prefijo, extracto, chunking en bloques |
| `journal-payloads.ts` | Builders puros de los `properties` de Notion |
| `journal-card.ts` | Render puro de tarjetas y teclados |
| `journal-store.ts` | Propuestas, snapshots de undo y estado del modo en CF KV |
| `journal-enrich.ts` | Llamada acotada al LLM que propone metadata + reflexión |
| `tools/journal.ts` | Escrituras y lecturas reales contra Notion |
| `journal-capture.ts` | Orquesta la captura: transcribe si hace falta, guarda, enriquece, manda tarjeta |
| `journal-callbacks.ts` | Handlers de los callbacks `jnl:*` |
| `proactive/journal-sweep.ts` | Barrido dominical |

**Modificados:** `index.ts`, `menu.ts` (daemon), `worker-v2/src/callback-router.ts`, `agent-tools.ts`, `system-prompt.ts`, `agent.ts`.

---

### Task 1: Crear las bases en Notion

Esta tarea no tiene tests — es setup contra el Notion real de Cal. Produce el archivo `journal-ids.ts` que consumen todas las tareas siguientes.

**Files:**
- Create: `daemon-v2/src/journal-ids.ts` (lo genera el comando)

- [ ] **Step 1: Verificar que la página Mental Health es visible para la integración**

```bash
ntn api -X GET /v1/pages/f2cab0c2-f8d0-48c3-a37f-c4f55c59cc39 --notion-version 2022-06-28 \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('object'), d.get('id'))"
```

Esperado: `page f2cab0c2-f8d0-48c3-a37f-c4f55c59cc39`

Si devuelve un error 404/403, la página no está compartida con la integración "Claude CoS" — pedile a Cal que la comparta desde Notion antes de seguir.

- [ ] **Step 2: Crear la DB `Journal` y generar `journal-ids.ts`**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
ntn api -X POST /v1/databases --notion-version 2022-06-28 -d '{
  "parent": {"type": "page_id", "page_id": "f2cab0c2-f8d0-48c3-a37f-c4f55c59cc39"},
  "title": [{"type": "text", "text": {"content": "Journal"}}],
  "properties": {
    "Pensamiento": {"title": {}},
    "Fecha y hora": {"date": {}},
    "Extracto": {"rich_text": {}},
    "Origen": {"select": {"options": [
      {"name": "Texto", "color": "blue"},
      {"name": "Voz", "color": "purple"},
      {"name": "Sesión terapia", "color": "green"}
    ]}},
    "Ánimo": {"select": {"options": [
      {"name": "😔 Bajo", "color": "gray"},
      {"name": "😐 Neutro", "color": "default"},
      {"name": "🙂 Bien", "color": "green"},
      {"name": "😤 Tensionado", "color": "orange"},
      {"name": "😰 Ansioso", "color": "red"}
    ]}},
    "Intensidad": {"number": {"format": "number"}},
    "Topics": {"relation": {"database_id": "39fdd6fd-abe5-4971-ab1e-0ecc0e8528d7", "type": "dual_property", "dual_property": {}}},
    "Big Themes": {"relation": {"database_id": "0235e414-576a-4531-9ed6-535867f7172a", "type": "dual_property", "dual_property": {}}},
    "Estado": {"select": {"options": [
      {"name": "Sin revisar", "color": "yellow"},
      {"name": "Destilado", "color": "green"},
      {"name": "Descartado", "color": "gray"}
    ]}},
    "Reflexión": {"relation": {"database_id": "e269b467-6578-48b3-8acd-1f48367b0e2a", "type": "dual_property", "dual_property": {}}}
  }
}' > /tmp/journal-db.json

python3 - <<'PY'
import json
d = json.load(open('/tmp/journal-db.json'))
db_id = d['id']
props = sorted(d['properties'])
print('DB creada:', db_id)
print('Propiedades:', props)
assert len(props) == 10, f'esperaba 10 propiedades, hay {len(props)}'
open('daemon-v2/src/journal-ids.ts', 'w').write(f'''// IDs de Notion del sistema de Journal. Generado por la Task 1 del plan
// docs/superpowers/plans/2026-07-27-journal-terapia-notion.md
export const JOURNAL_DB_ID = "{db_id}";
export const RESONATE_DB_ID = "e269b467-6578-48b3-8acd-1f48367b0e2a";
export const TOPICS_DB_ID = "39fdd6fd-abe5-4971-ab1e-0ecc0e8528d7";
export const BIG_THEMES_DB_ID = "0235e414-576a-4531-9ed6-535867f7172a";
export const MENTAL_HEALTH_PAGE_ID = "f2cab0c2-f8d0-48c3-a37f-c4f55c59cc39";
''')
print('journal-ids.ts escrito')
PY
```

Esperado: `DB creada: <uuid>`, la lista de 10 propiedades, y `journal-ids.ts escrito`.

Si `properties` sale vacío o incompleto, olvidaste `--notion-version 2022-06-28` — borrá la DB y repetí.

- [ ] **Step 3: Agregar la propiedad `Journal` a Resonate Calendar**

Las relaciones `dual_property` del Step 2 ya crean la contraparte en Topics, Big Themes y Resonate Calendar, pero Notion la nombra `Journal` o `Related to Journal (Reflexión)` según el caso. Verificá cómo quedó:

```bash
ntn api -X GET /v1/databases/e269b467-6578-48b3-8acd-1f48367b0e2a --notion-version 2022-06-28 \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for k,v in d['properties'].items():
    if v['type']=='relation':
        print(repr(k), '->', v['relation'].get('database_id'))
"
```

Esperado: entre las relaciones aparece una nueva apuntando al `JOURNAL_DB_ID` del Step 2.

Si el nombre no es exactamente `Journal`, renombralo:

```bash
ntn api -X PATCH /v1/databases/e269b467-6578-48b3-8acd-1f48367b0e2a --notion-version 2022-06-28 \
  -d '{"properties": {"Related to Journal (Reflexión)": {"name": "Journal"}}}'
```

- [ ] **Step 4: Commit**

```bash
git add daemon-v2/src/journal-ids.ts
git commit -m "feat(journal): crear DB Journal en Notion y fijar los IDs"
```

---

### Task 2: Tipos compartidos

**Files:**
- Create: `daemon-v2/src/journal-types.ts`

Sin tests: es solo declaraciones de tipos y constantes. Las tareas siguientes las consumen.

- [ ] **Step 1: Escribir el archivo**

```typescript
// journal-types.ts — tipos y constantes compartidas del sistema de Journal.

export const ANIMOS = [
  "😔 Bajo",
  "😐 Neutro",
  "🙂 Bien",
  "😤 Tensionado",
  "😰 Ansioso",
] as const;

export type Animo = (typeof ANIMOS)[number];

export type Origen = "Texto" | "Voz" | "Sesión terapia";

export type Estado = "Sin revisar" | "Destilado" | "Descartado";

/** Referencia a una página de Notion (Topic o Big Theme). */
export interface NotionRef {
  id: string;
  name: string;
}

/** Lo que el LLM propone tras leer el texto crudo. */
export interface EnrichResult {
  titulo: string;
  animo: Animo;
  intensidad: number;
  topics: string[];
  bigTheme: string | null;
  /** null si el pensamiento no contiene una reflexión destilable. */
  reflexion: { titulo: string; situacion: string } | null;
}

/** Propuesta de metadata sobre una entrada ya creada. */
export interface MetaProposal {
  kind: "journal-meta";
  entryId: string;
  titulo: string;
  animo: Animo;
  intensidad: number;
  /** Todos los topics candidatos; los excluidos NO se escriben. */
  topics: NotionRef[];
  topicsExcluidos: string[];
  bigTheme: NotionRef | null;
  extracto: string;
  fechaHora: string;
  textoCrudo: string;
  reflexion: { titulo: string; situacion: string } | null;
  messageId: number;
}

/** Propuesta de fila en Resonate Calendar. */
export interface ReflexionProposal {
  kind: "journal-reflexion";
  entryId: string;
  titulo: string;
  situacion: string;
  topics: NotionRef[];
  bigTheme: NotionRef | null;
  fecha: string;
  textoCrudo: string;
  messageId: number;
}

export type JournalProposal = MetaProposal | ReflexionProposal;

/** Snapshot para deshacer la aplicación de metadata (la entrada queda como recién creada). */
export interface MetaUndo {
  kind: "journal-meta";
  entryId: string;
}

/** Snapshot para deshacer la creación en Resonate (se archiva la fila creada). */
export interface ReflexionUndo {
  kind: "journal-reflexion";
  entryId: string;
  resonateId: string;
}

export type JournalUndo = MetaUndo | ReflexionUndo;

/** Estado del modo journal, persistido en KV. */
export interface JournalMode {
  abiertoEn: number;
  anchorMessageId: number;
  origen: Origen;
  guardadas: number;
  pendientes: number;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git add daemon-v2/src/journal-types.ts
git commit -m "feat(journal): tipos compartidos del sistema de journal"
```

---

### Task 3: Funciones puras de texto

Tres funciones: detectar el prefijo, armar el extracto, y partir el texto en bloques que Notion acepte.

**Files:**
- Create: `daemon-v2/src/journal-text.ts`
- Test: `daemon-v2/src/journal-text.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, it, expect } from "vitest";
import { parseJournalPrefix, buildExtracto, chunkParagraphs } from "./journal-text.js";

describe("parseJournalPrefix", () => {
  it("detecta 'journal:' y devuelve el resto", () => {
    expect(parseJournalPrefix("journal: hoy me sentí raro")).toBe("hoy me sentí raro");
  });

  it("detecta 'diario:' y no distingue mayúsculas", () => {
    expect(parseJournalPrefix("Diario: algo")).toBe("algo");
    expect(parseJournalPrefix("DIARIO:algo")).toBe("algo");
  });

  it("acepta el prefijo sin espacio después de los dos puntos", () => {
    expect(parseJournalPrefix("journal:sin espacio")).toBe("sin espacio");
  });

  it("devuelve null si no hay prefijo", () => {
    expect(parseJournalPrefix("qué vuelos hay mañana")).toBeNull();
  });

  it("devuelve null si el prefijo está en el medio", () => {
    expect(parseJournalPrefix("le dije journal: nada")).toBeNull();
  });

  it("devuelve null si después del prefijo no hay texto", () => {
    expect(parseJournalPrefix("journal:   ")).toBeNull();
  });

  it("conserva el texto literal, incluidos saltos de línea", () => {
    expect(parseJournalPrefix("journal: línea 1\nlínea 2")).toBe("línea 1\nlínea 2");
  });
});

describe("buildExtracto", () => {
  it("devuelve el texto entero si es corto", () => {
    expect(buildExtracto("corto")).toBe("corto");
  });

  it("corta en el último espacio antes del límite y agrega elipsis", () => {
    const texto = "a".repeat(150) + " " + "b".repeat(100);
    const out = buildExtracto(texto);
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("b");
  });

  it("corta duro si no hay espacios", () => {
    const out = buildExtracto("x".repeat(500));
    expect(out).toBe("x".repeat(200) + "…");
  });

  it("colapsa saltos de línea en espacios", () => {
    expect(buildExtracto("uno\ndos")).toBe("uno dos");
  });
});

describe("chunkParagraphs", () => {
  it("un texto corto es un solo bloque", () => {
    expect(chunkParagraphs("hola")).toEqual(["hola"]);
  });

  it("parte por párrafos cuando el texto los tiene", () => {
    expect(chunkParagraphs("uno\n\ndos")).toEqual(["uno", "dos"]);
  });

  it("ningún chunk supera 1900 caracteres", () => {
    const largo = "palabra ".repeat(1000);
    const chunks = chunkParagraphs(largo);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1900);
  });

  it("no pierde texto al partir", () => {
    const largo = "palabra ".repeat(1000).trim();
    const chunks = chunkParagraphs(largo);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(largo.replace(/\s+/g, " "));
  });

  it("parte un párrafo sin espacios más largo que el límite", () => {
    const chunks = chunkParagraphs("z".repeat(4000));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.length).toBe(1900);
  });

  it("un texto vacío devuelve un array vacío", () => {
    expect(chunkParagraphs("   ")).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/journal-text.test.ts --root daemon-v2`
Expected: FAIL — `Failed to resolve import "./journal-text.js"`

- [ ] **Step 3: Implementar**

```typescript
// journal-text.ts — funciones puras de texto del Journal. Sin red, sin estado.

const PREFIJOS = ["journal:", "diario:"];
const EXTRACTO_MAX = 200;
/** Notion corta cada rich_text a 2000 chars; dejamos margen. */
const CHUNK_MAX = 1900;

/**
 * Devuelve el texto que sigue al prefijo `journal:`/`diario:`, o null si el mensaje
 * no lo tiene al principio. El texto se devuelve LITERAL (solo se recortan los
 * espacios que rodean al prefijo) — nunca se reescribe.
 */
export function parseJournalPrefix(text: string): string | null {
  const lower = text.toLowerCase();
  for (const p of PREFIJOS) {
    if (!lower.startsWith(p)) continue;
    const resto = text.slice(p.length).trim();
    return resto.length > 0 ? resto : null;
  }
  return null;
}

/** Preview de una línea para la vista de tabla de Notion. */
export function buildExtracto(texto: string): string {
  const plano = texto.replace(/\s+/g, " ").trim();
  if (plano.length <= EXTRACTO_MAX) return plano;
  const corte = plano.slice(0, EXTRACTO_MAX);
  const ultimoEspacio = corte.lastIndexOf(" ");
  const base = ultimoEspacio > 0 ? corte.slice(0, ultimoEspacio) : corte;
  return `${base}…`;
}

/**
 * Parte el texto en trozos que Notion acepta como bloques `paragraph`.
 * Respeta los párrafos originales; si uno solo excede el límite, lo corta
 * por palabras (y por caracteres si ni siquiera hay espacios).
 */
export function chunkParagraphs(texto: string): string[] {
  const parrafos = texto
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const out: string[] = [];
  for (const parrafo of parrafos) {
    if (parrafo.length <= CHUNK_MAX) {
      out.push(parrafo);
      continue;
    }
    let resto = parrafo;
    while (resto.length > CHUNK_MAX) {
      const corte = resto.slice(0, CHUNK_MAX);
      const ultimoEspacio = corte.lastIndexOf(" ");
      const cortePunto = ultimoEspacio > 0 ? ultimoEspacio : CHUNK_MAX;
      out.push(resto.slice(0, cortePunto).trim() || corte);
      resto = resto.slice(cortePunto).trim();
    }
    if (resto.length > 0) out.push(resto);
  }
  return out;
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/journal-text.test.ts --root daemon-v2`
Expected: PASS — 17 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/journal-text.ts daemon-v2/src/journal-text.test.ts
git commit -m "feat(journal): funciones puras de texto (prefijo, extracto, chunking)"
```

---

### Task 4: Builders de properties de Notion

Funciones puras que arman el JSON que se le manda a la API. Separadas de la escritura para poder testearlas sin red.

**Files:**
- Create: `daemon-v2/src/journal-payloads.ts`
- Test: `daemon-v2/src/journal-payloads.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, it, expect } from "vitest";
import {
  buildEntryProperties,
  buildBodyBlocks,
  buildMetadataProperties,
  buildResonateProperties,
  buildQuoteBlocks,
} from "./journal-payloads.js";

describe("buildEntryProperties", () => {
  it("arma la fila cruda con estado Sin revisar", () => {
    const props = buildEntryProperties({
      texto: "hoy me sentí raro en la reunión",
      origen: "Voz",
      fechaHora: "2026-07-27T14:32:00-04:00",
    });
    expect(props["Origen"]).toEqual({ select: { name: "Voz" } });
    expect(props["Estado"]).toEqual({ select: { name: "Sin revisar" } });
    expect(props["Fecha y hora"]).toEqual({ date: { start: "2026-07-27T14:32:00-04:00" } });
    expect(props["Extracto"]).toEqual({
      rich_text: [{ text: { content: "hoy me sentí raro en la reunión" } }],
    });
  });

  it("usa el extracto como título provisional para que la fila no quede sin nombre", () => {
    const props = buildEntryProperties({
      texto: "a".repeat(500),
      origen: "Texto",
      fechaHora: "2026-07-27T14:32:00-04:00",
    });
    const title = props["Pensamiento"] as { title: Array<{ text: { content: string } }> };
    expect(title.title[0]!.text.content.endsWith("…")).toBe(true);
    expect(title.title[0]!.text.content.length).toBeLessThanOrEqual(201);
  });
});

describe("buildBodyBlocks", () => {
  it("convierte el texto en bloques paragraph", () => {
    expect(buildBodyBlocks("uno\n\ndos")).toEqual([
      { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "uno" } }] } },
      { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "dos" } }] } },
    ]);
  });
});

describe("buildMetadataProperties", () => {
  it("escribe título, ánimo, intensidad y relaciones", () => {
    const props = buildMetadataProperties({
      titulo: "Miedo a la confrontación",
      animo: "😤 Tensionado",
      intensidad: 4,
      topics: [{ id: "t1", name: "Terapia" }, { id: "t2", name: "Autoestima" }],
      bigTheme: { id: "b1", name: "Better Me" },
    });
    expect(props["Pensamiento"]).toEqual({
      title: [{ text: { content: "Miedo a la confrontación" } }],
    });
    expect(props["Ánimo"]).toEqual({ select: { name: "😤 Tensionado" } });
    expect(props["Intensidad"]).toEqual({ number: 4 });
    expect(props["Topics"]).toEqual({ relation: [{ id: "t1" }, { id: "t2" }] });
    expect(props["Big Themes"]).toEqual({ relation: [{ id: "b1" }] });
  });

  it("manda relación vacía cuando no hay big theme", () => {
    const props = buildMetadataProperties({
      titulo: "x",
      animo: "😐 Neutro",
      intensidad: 3,
      topics: [],
      bigTheme: null,
    });
    expect(props["Big Themes"]).toEqual({ relation: [] });
    expect(props["Topics"]).toEqual({ relation: [] });
  });
});

describe("buildResonateProperties", () => {
  it("arma la fila de Resonate con Type Reflexion y Tag Terapia", () => {
    const props = buildResonateProperties({
      titulo: "Un amigo hombre con quien conversar",
      situacion: "Sesión con Valeria",
      fecha: "2026-07-27",
      topics: [{ id: "t1", name: "Terapia" }],
      bigTheme: { id: "b1", name: "Better Me" },
      entryId: "e1",
    });
    expect(props["Name"]).toEqual({
      title: [{ text: { content: "Un amigo hombre con quien conversar" } }],
    });
    expect(props["Type"]).toEqual({ select: { name: "Reflexion" } });
    expect(props["Tags"]).toEqual({ multi_select: [{ name: "Terapia" }] });
    expect(props["Fecha"]).toEqual({ date: { start: "2026-07-27" } });
    expect(props["Situacion"]).toEqual({ rich_text: [{ text: { content: "Sesión con Valeria" } }] });
    expect(props["Journal"]).toEqual({ relation: [{ id: "e1" }] });
  });

  it("omite Situacion cuando viene vacía", () => {
    const props = buildResonateProperties({
      titulo: "x",
      situacion: "",
      fecha: "2026-07-27",
      topics: [],
      bigTheme: null,
      entryId: "e1",
    });
    expect(props["Situacion"]).toBeUndefined();
  });
});

describe("buildQuoteBlocks", () => {
  it("copia el texto crudo como quote", () => {
    const blocks = buildQuoteBlocks("pensamiento original");
    expect(blocks[0]).toEqual({
      object: "block",
      type: "quote",
      quote: { rich_text: [{ type: "text", text: { content: "pensamiento original" } }] },
    });
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/journal-payloads.test.ts --root daemon-v2`
Expected: FAIL — `Failed to resolve import "./journal-payloads.js"`

- [ ] **Step 3: Implementar**

```typescript
// journal-payloads.ts — builders puros del JSON que consume la API de Notion.
// Separados de tools/journal.ts para poder testearlos sin red.

import { buildExtracto, chunkParagraphs } from "./journal-text.js";
import type { Animo, NotionRef, Origen } from "./journal-types.js";

export type NotionProps = Record<string, unknown>;

export interface NotionBlock {
  object: "block";
  type: string;
  [key: string]: unknown;
}

export function buildEntryProperties(input: {
  texto: string;
  origen: Origen;
  fechaHora: string;
}): NotionProps {
  const extracto = buildExtracto(input.texto);
  return {
    // Título provisional: el enriquecimiento lo reemplaza, pero si ese paso falla
    // la fila igual es identificable en la vista de tabla.
    Pensamiento: { title: [{ text: { content: extracto } }] },
    "Fecha y hora": { date: { start: input.fechaHora } },
    Extracto: { rich_text: [{ text: { content: extracto } }] },
    Origen: { select: { name: input.origen } },
    Estado: { select: { name: "Sin revisar" } },
  };
}

export function buildBodyBlocks(texto: string): NotionBlock[] {
  return chunkParagraphs(texto).map((chunk) => ({
    object: "block" as const,
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
  }));
}

export function buildMetadataProperties(input: {
  titulo: string;
  animo: Animo;
  intensidad: number;
  topics: NotionRef[];
  bigTheme: NotionRef | null;
}): NotionProps {
  return {
    Pensamiento: { title: [{ text: { content: input.titulo } }] },
    "Ánimo": { select: { name: input.animo } },
    Intensidad: { number: input.intensidad },
    Topics: { relation: input.topics.map((t) => ({ id: t.id })) },
    "Big Themes": { relation: input.bigTheme ? [{ id: input.bigTheme.id }] : [] },
  };
}

export function buildResonateProperties(input: {
  titulo: string;
  situacion: string;
  fecha: string;
  topics: NotionRef[];
  bigTheme: NotionRef | null;
  entryId: string;
}): NotionProps {
  const props: NotionProps = {
    Name: { title: [{ text: { content: input.titulo } }] },
    Fecha: { date: { start: input.fecha } },
    Type: { select: { name: "Reflexion" } },
    Tags: { multi_select: [{ name: "Terapia" }] },
    Topics: { relation: input.topics.map((t) => ({ id: t.id })) },
    "Big Themes": { relation: input.bigTheme ? [{ id: input.bigTheme.id }] : [] },
    Journal: { relation: [{ id: input.entryId }] },
  };
  if (input.situacion.trim().length > 0) {
    props["Situacion"] = { rich_text: [{ text: { content: input.situacion } }] };
  }
  return props;
}

export function buildQuoteBlocks(texto: string): NotionBlock[] {
  return chunkParagraphs(texto).map((chunk) => ({
    object: "block" as const,
    type: "quote",
    quote: { rich_text: [{ type: "text", text: { content: chunk } }] },
  }));
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/journal-payloads.test.ts --root daemon-v2`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/journal-payloads.ts daemon-v2/src/journal-payloads.test.ts
git commit -m "feat(journal): builders puros de properties de Notion"
```

---

### Task 5: Store de propuestas y modo en KV

Espejo de `proposal-store.ts` de Pecunia, más el estado del modo journal.

**Files:**
- Create: `daemon-v2/src/journal-store.ts`
- Test: `daemon-v2/src/journal-store.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, it, expect } from "vitest";
import { JournalStore } from "./journal-store.js";
import type { MetaProposal } from "./journal-types.js";

/** CfKv falso en memoria — registra los TTL para poder afirmar sobre ellos. */
class FakeKv {
  store = new Map<string, unknown>();
  ttls = new Map<string, number | undefined>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.store.set(key, value);
    this.ttls.set(key, ttlSeconds);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function makeProposal(): MetaProposal {
  return {
    kind: "journal-meta",
    entryId: "entry-1",
    titulo: "Miedo a la confrontación",
    animo: "😤 Tensionado",
    intensidad: 4,
    topics: [{ id: "t1", name: "Terapia" }],
    topicsExcluidos: [],
    bigTheme: { id: "b1", name: "Better Me" },
    extracto: "hoy...",
    fechaHora: "2026-07-27T14:32:00-04:00",
    textoCrudo: "hoy me sentí raro",
    reflexion: null,
    messageId: 99,
  };
}

describe("JournalStore — propuestas", () => {
  it("guarda y recupera una propuesta por shortId", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    const id = await store.createProposal(1, makeProposal());
    expect(await store.getProposal(1, id)).toMatchObject({ entryId: "entry-1" });
  });

  it("guarda la propuesta con TTL de 1 hora", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    const id = await store.createProposal(1, makeProposal());
    expect(kv.ttls.get(`jano:journal:prop:1:${id}`)).toBe(3600);
  });

  it("aísla las propuestas por chat", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    const id = await store.createProposal(1, makeProposal());
    expect(await store.getProposal(2, id)).toBeNull();
  });

  it("clearProposal la borra", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    const id = await store.createProposal(1, makeProposal());
    await store.clearProposal(1, id);
    expect(await store.getProposal(1, id)).toBeNull();
  });

  it("genera shortIds distintos", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    const a = await store.createProposal(1, makeProposal());
    const b = await store.createProposal(1, makeProposal());
    expect(a).not.toBe(b);
  });
});

describe("JournalStore — undo", () => {
  it("guarda el snapshot con TTL de 10 minutos y lo recupera", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.setUndo(1, "entry-1", { kind: "journal-meta", entryId: "entry-1" });
    expect(kv.ttls.get("jano:journal:undo:1:entry-1")).toBe(600);
    expect(await store.getUndo(1, "entry-1")).toEqual({ kind: "journal-meta", entryId: "entry-1" });
  });

  it("clearUndo lo borra", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.setUndo(1, "entry-1", { kind: "journal-meta", entryId: "entry-1" });
    await store.clearUndo(1, "entry-1");
    expect(await store.getUndo(1, "entry-1")).toBeNull();
  });
});

describe("JournalStore — modo journal", () => {
  it("abre el modo con TTL de 2 horas", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.openMode(1, { abiertoEn: 1000, anchorMessageId: 5, origen: "Texto", guardadas: 0, pendientes: 0 });
    expect(kv.ttls.get("jano:journal-mode:1")).toBe(7200);
    expect(await store.getMode(1)).toMatchObject({ anchorMessageId: 5 });
  });

  it("devuelve null si el modo no está abierto", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    expect(await store.getMode(1)).toBeNull();
  });

  it("bumpMode incrementa contadores y refresca el TTL", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.openMode(1, { abiertoEn: 1000, anchorMessageId: 5, origen: "Texto", guardadas: 0, pendientes: 0 });
    await store.bumpMode(1, { guardadas: 1, pendientes: 1 });
    const mode = await store.getMode(1);
    expect(mode).toMatchObject({ guardadas: 1, pendientes: 1, anchorMessageId: 5 });
    expect(kv.ttls.get("jano:journal-mode:1")).toBe(7200);
  });

  it("bumpMode no hace nada si el modo ya expiró", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.bumpMode(1, { guardadas: 1, pendientes: 0 });
    expect(await store.getMode(1)).toBeNull();
  });

  it("closeMode borra el estado", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.openMode(1, { abiertoEn: 1000, anchorMessageId: 5, origen: "Texto", guardadas: 0, pendientes: 0 });
    await store.closeMode(1);
    expect(await store.getMode(1)).toBeNull();
  });
});

describe("JournalStore — edición pendiente", () => {
  it("guarda a qué campo apunta la próxima respuesta de Cal", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.setPendingEdit(1, { campo: "titulo", shortId: "ab12", messageId: 7 });
    expect(await store.getPendingEdit(1)).toEqual({ campo: "titulo", shortId: "ab12", messageId: 7 });
    expect(kv.ttls.get("jano:journal:edit:1")).toBe(600);
  });

  it("devuelve null si no hay edición pendiente", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    expect(await store.getPendingEdit(1)).toBeNull();
  });

  it("clearPendingEdit la borra", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.setPendingEdit(1, { campo: "reflexion", shortId: "cd34", messageId: 9 });
    await store.clearPendingEdit(1);
    expect(await store.getPendingEdit(1)).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/journal-store.test.ts --root daemon-v2`
Expected: FAIL — `Failed to resolve import "./journal-store.js"`

- [ ] **Step 3: Implementar**

```typescript
// journal-store.ts — propuestas, snapshots de undo y estado del modo journal en CF KV.
// Espejo de `proposal-store.ts` de Pecunia (pecunia-agent/daemon/src/proposal-store.ts).

import type { CfKv } from "./cf-kv.js";
import type { JournalMode, JournalProposal, JournalUndo } from "./journal-types.js";

/** 1 hora: Cal journalea de noche y puede tardar en tocar los botones. */
const PROPOSAL_TTL_SEC = 3600;
/** 10 min de ventana para deshacer, igual que Pecunia. */
const UNDO_TTL_SEC = 600;
/** 2 horas: si el modo queda abierto por olvido, expira solo. */
const MODE_TTL_SEC = 7200;

export class JournalStore {
  constructor(private kv: CfKv) {}

  private propKey(chatId: number, shortId: string): string {
    return `jano:journal:prop:${chatId}:${shortId}`;
  }

  private undoKey(chatId: number, entryId: string): string {
    return `jano:journal:undo:${chatId}:${entryId}`;
  }

  private modeKey(chatId: number): string {
    return `jano:journal-mode:${chatId}`;
  }

  async createProposal(chatId: number, payload: JournalProposal): Promise<string> {
    const shortId = Math.random().toString(36).slice(2, 10);
    await this.kv.set(this.propKey(chatId, shortId), payload, PROPOSAL_TTL_SEC);
    return shortId;
  }

  async getProposal(chatId: number, shortId: string): Promise<JournalProposal | null> {
    return await this.kv.get<JournalProposal>(this.propKey(chatId, shortId));
  }

  /** Reemplaza el payload conservando el mismo shortId (pickers que mutan la propuesta). */
  async updateProposal(chatId: number, shortId: string, payload: JournalProposal): Promise<void> {
    await this.kv.set(this.propKey(chatId, shortId), payload, PROPOSAL_TTL_SEC);
  }

  async clearProposal(chatId: number, shortId: string): Promise<void> {
    await this.kv.delete(this.propKey(chatId, shortId));
  }

  async setUndo(chatId: number, entryId: string, snapshot: JournalUndo): Promise<void> {
    await this.kv.set(this.undoKey(chatId, entryId), snapshot, UNDO_TTL_SEC);
  }

  async getUndo(chatId: number, entryId: string): Promise<JournalUndo | null> {
    return await this.kv.get<JournalUndo>(this.undoKey(chatId, entryId));
  }

  async clearUndo(chatId: number, entryId: string): Promise<void> {
    await this.kv.delete(this.undoKey(chatId, entryId));
  }

  async openMode(chatId: number, mode: JournalMode): Promise<void> {
    await this.kv.set(this.modeKey(chatId), mode, MODE_TTL_SEC);
  }

  async getMode(chatId: number): Promise<JournalMode | null> {
    return await this.kv.get<JournalMode>(this.modeKey(chatId));
  }

  /** Suma a los contadores y refresca el TTL. No-op si el modo ya expiró. */
  async bumpMode(chatId: number, delta: { guardadas: number; pendientes: number }): Promise<void> {
    const mode = await this.getMode(chatId);
    if (!mode) return;
    await this.openMode(chatId, {
      ...mode,
      guardadas: mode.guardadas + delta.guardadas,
      pendientes: mode.pendientes + delta.pendientes,
    });
  }

  async closeMode(chatId: number): Promise<void> {
    await this.kv.delete(this.modeKey(chatId));
  }

  private editKey(chatId: number): string {
    return `jano:journal:edit:${chatId}`;
  }

  /** Marca que la PRÓXIMA respuesta de texto de Cal es la edición de un campo. */
  async setPendingEdit(chatId: number, pending: PendingEdit): Promise<void> {
    await this.kv.set(this.editKey(chatId), pending, UNDO_TTL_SEC);
  }

  async getPendingEdit(chatId: number): Promise<PendingEdit | null> {
    return await this.kv.get<PendingEdit>(this.editKey(chatId));
  }

  async clearPendingEdit(chatId: number): Promise<void> {
    await this.kv.delete(this.editKey(chatId));
  }
}
```

Y agregá el tipo a `journal-types.ts`:

```typescript
/** Edición de un campo esperando la respuesta de texto de Cal. */
export interface PendingEdit {
  campo: "titulo" | "reflexion";
  shortId: string;
  messageId: number;
}
```

Importalo en `journal-store.ts` junto a los demás tipos:

```typescript
import type { JournalMode, JournalProposal, JournalUndo, PendingEdit } from "./journal-types.js";
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/journal-store.test.ts --root daemon-v2`
Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/journal-store.ts daemon-v2/src/journal-store.test.ts
git commit -m "feat(journal): store de propuestas, undo y modo en CF KV"
```

---

### Task 6: Render de tarjetas y teclados

Todo puro: recibe la propuesta, devuelve texto HTML + teclado. Sin red.

Aplica el skill `telegram-bot-ux`: parse mode HTML (escapar solo `< > &`), bullets `•`, sin separadores Markdown, máximo 3 botones por fila.

**Presupuesto de `callback_data`:** Telegram corta a 64 bytes. El peor caso acá es `jnl:togtopic:{shortId}:{uuid}` = 13 + 8 + 1 + 36 = **58 bytes**, y `jnl:undo:{uuid}` = 45. Entra, pero sin margen: si alguna vez alargás el prefijo o el `shortId`, revisá esta cuenta primero — Telegram no da error, simplemente el botón deja de funcionar.

**Files:**
- Create: `daemon-v2/src/journal-card.ts`
- Test: `daemon-v2/src/journal-card.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, it, expect } from "vitest";
import {
  renderMetaCard,
  renderAnimoPicker,
  renderTopicsPicker,
  renderBigThemePicker,
  renderReflexionCard,
  renderSweepSelector,
  renderModeOpen,
  renderModeClosed,
  renderApplied,
} from "./journal-card.js";
import type { MetaProposal, ReflexionProposal } from "./journal-types.js";

function meta(overrides: Partial<MetaProposal> = {}): MetaProposal {
  return {
    kind: "journal-meta",
    entryId: "entry-1",
    titulo: "Miedo a la confrontación en reuniones",
    animo: "😤 Tensionado",
    intensidad: 4,
    topics: [
      { id: "t1", name: "Terapia" },
      { id: "t2", name: "Autoestima" },
    ],
    topicsExcluidos: [],
    bigTheme: { id: "b1", name: "Better Me" },
    extracto: "Hoy en la sesión me di cuenta de que...",
    fechaHora: "2026-07-27T14:32:00-04:00",
    textoCrudo: "Hoy en la sesión me di cuenta de que...",
    reflexion: null,
    messageId: 99,
    ...overrides,
  };
}

function flat(kb: { inline_keyboard: Array<Array<{ callback_data: string }>> }): string[] {
  return kb.inline_keyboard.flat().map((b) => b.callback_data);
}

describe("renderMetaCard", () => {
  it("muestra fecha, hora, extracto y los 4 campos propuestos", () => {
    const { text } = renderMetaCard(meta(), "ab12");
    expect(text).toContain("27/07");
    expect(text).toContain("14:32");
    expect(text).toContain("Miedo a la confrontación en reuniones");
    expect(text).toContain("😤 Tensionado");
    expect(text).toContain("4/5");
    expect(text).toContain("Terapia, Autoestima");
    expect(text).toContain("Better Me");
  });

  it("ofrece aplicar, los 4 ajustes y descartar", () => {
    const { keyboard } = renderMetaCard(meta(), "ab12");
    expect(flat(keyboard)).toEqual([
      "jnl:apply:ab12",
      "jnl:edit-title:ab12",
      "jnl:pick-animo:ab12",
      "jnl:pick-topics:ab12",
      "jnl:pick-theme:ab12",
      "jnl:nometa:ab12",
    ]);
  });

  it("no lista los topics excluidos", () => {
    const { text } = renderMetaCard(meta({ topicsExcluidos: ["t2"] }), "ab12");
    expect(text).toContain("Terapia");
    expect(text).not.toContain("Autoestima");
  });

  it("escapa HTML del texto de Cal", () => {
    const { text } = renderMetaCard(meta({ extracto: "me dijo <jefe> & se fue" }), "ab12");
    expect(text).toContain("&lt;jefe&gt; &amp; se fue");
  });

  it("dice cuando no hay big theme", () => {
    const { text } = renderMetaCard(meta({ bigTheme: null }), "ab12");
    expect(text).toContain("sin asignar");
  });
});

describe("renderAnimoPicker", () => {
  it("ofrece los 5 ánimos y las 5 intensidades", () => {
    const datas = flat(renderAnimoPicker(meta(), "ab12").keyboard);
    expect(datas).toContain("jnl:animo:ab12:0");
    expect(datas).toContain("jnl:animo:ab12:4");
    expect(datas).toContain("jnl:inten:ab12:1");
    expect(datas).toContain("jnl:inten:ab12:5");
    expect(datas).toContain("jnl:back:ab12");
  });

  it("marca el ánimo actual", () => {
    const { text } = renderAnimoPicker(meta(), "ab12");
    expect(text).toContain("😤 Tensionado");
  });
});

describe("renderTopicsPicker", () => {
  it("muestra un toggle por topic con su estado", () => {
    const { keyboard } = renderTopicsPicker(meta({ topicsExcluidos: ["t2"] }), "ab12");
    const botones = keyboard.inline_keyboard.flat();
    expect(botones[0]!.text).toBe("✅ Terapia");
    expect(botones[0]!.callback_data).toBe("jnl:togtopic:ab12:t1");
    expect(botones[1]!.text).toBe("⬜ Autoestima");
  });

  it("cierra con el botón de volver", () => {
    expect(flat(renderTopicsPicker(meta(), "ab12").keyboard)).toContain("jnl:back:ab12");
  });
});

describe("renderBigThemePicker", () => {
  it("lista los temas recibidos y permite quitarlo", () => {
    const themes = [
      { id: "b1", name: "Better Me" },
      { id: "b2", name: "Better Leader" },
    ];
    const datas = flat(renderBigThemePicker(meta(), "ab12", themes).keyboard);
    expect(datas).toContain("jnl:theme:ab12:b1");
    expect(datas).toContain("jnl:theme:ab12:b2");
    expect(datas).toContain("jnl:theme:ab12:none");
  });
});

describe("renderReflexionCard", () => {
  const refl: ReflexionProposal = {
    kind: "journal-reflexion",
    entryId: "entry-1",
    titulo: "Un amigo hombre con quien conversar",
    situacion: "Sesión con Valeria, 27/07",
    topics: [{ id: "t1", name: "Terapia" }],
    bigTheme: { id: "b1", name: "Better Me" },
    fecha: "2026-07-27",
    textoCrudo: "texto",
    messageId: 99,
  };

  it("muestra el título, la situación y el tipo fijo", () => {
    const { text } = renderReflexionCard(refl, "cd34");
    expect(text).toContain("Un amigo hombre con quien conversar");
    expect(text).toContain("Sesión con Valeria, 27/07");
    expect(text).toContain("Reflexion");
    expect(text).toContain("Terapia");
  });

  it("ofrece guardar, editar y posponer", () => {
    expect(flat(renderReflexionCard(refl, "cd34").keyboard)).toEqual([
      "jnl:resonate:cd34",
      "jnl:edit-refl:cd34",
      "jnl:later:cd34",
    ]);
  });
});

describe("renderSweepSelector", () => {
  const entries = [
    { id: "e1", titulo: "Miedo a la confrontación", fecha: "2026-07-22" },
    { id: "e2", titulo: "Culpa con mis papás", fecha: "2026-07-23" },
  ];

  it("enumera las entradas con su fecha", () => {
    const { text } = renderSweepSelector(entries);
    expect(text).toContain("2 pensamientos sin destilar");
    expect(text).toContain("1. Miedo a la confrontación · 22/07");
    expect(text).toContain("2. Culpa con mis papás · 23/07");
  });

  it("ofrece un botón por entrada más revisar todos y descartar", () => {
    const datas = flat(renderSweepSelector(entries).keyboard);
    expect(datas).toEqual(["jnl:sweep:e1", "jnl:sweep:e2", "jnl:sweep:all", "jnl:sweep:none"]);
  });

  it("muestra como máximo 5 entradas pero las cuenta todas", () => {
    const muchas = Array.from({ length: 9 }, (_, i) => ({
      id: `e${i}`,
      titulo: `t${i}`,
      fecha: "2026-07-22",
    }));
    const { text, keyboard } = renderSweepSelector(muchas);
    expect(text).toContain("9 pensamientos sin destilar");
    expect(text).toContain("(y 4 más)");
    expect(flat(keyboard).filter((d) => d.startsWith("jnl:sweep:e"))).toHaveLength(5);
  });
});

describe("renderModeOpen / renderModeClosed / renderApplied", () => {
  it("el modo abierto ofrece cerrar", () => {
    const { text, keyboard } = renderModeOpen();
    expect(text).toContain("Modo journal abierto");
    expect(flat(keyboard)).toEqual(["jnl:mode:close"]);
  });

  it("el cierre resume la tanda sin botones", () => {
    const { text, keyboard } = renderModeClosed(5, 1);
    expect(text).toContain("5 entradas");
    expect(text).toContain("1 reflexión pendiente");
    expect(keyboard.inline_keyboard).toEqual([]);
  });

  it("el cierre usa plural correcto en cero", () => {
    expect(renderModeClosed(1, 0).text).toContain("1 entrada");
    expect(renderModeClosed(1, 0).text).not.toContain("pendiente");
  });

  it("tras aplicar ofrece deshacer", () => {
    const { text, keyboard } = renderApplied(meta(), "entry-1");
    expect(text).toContain("Guardado");
    expect(flat(keyboard)).toEqual(["jnl:undo:entry-1"]);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/journal-card.test.ts --root daemon-v2`
Expected: FAIL — `Failed to resolve import "./journal-card.js"`

- [ ] **Step 3: Implementar**

```typescript
// journal-card.ts — render PURO de las tarjetas y teclados del Journal.
// Sin red ni estado: entra una propuesta, sale {text, keyboard}. Parse mode HTML
// (skill telegram-bot-ux): escapar solo < > &, bullets •, sin Markdown.

import { ANIMOS, type MetaProposal, type NotionRef, type ReflexionProposal } from "./journal-types.js";

export interface Keyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface Card {
  text: string;
  keyboard: Keyboard;
}

const SWEEP_MAX_BOTONES = 5;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "2026-07-27T14:32:00-04:00" → "27/07" */
function ddmm(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  void y;
  return `${d}/${m}`;
}

/** "2026-07-27T14:32:00-04:00" → "14:32" */
function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

function topicsIncluidos(p: MetaProposal): NotionRef[] {
  const fuera = new Set(p.topicsExcluidos);
  return p.topics.filter((t) => !fuera.has(t.id));
}

export function renderMetaCard(p: MetaProposal, shortId: string): Card {
  const incluidos = topicsIncluidos(p);
  const lines = [
    `📓 <b>Guardado</b> — ${ddmm(p.fechaHora)} · ${hhmm(p.fechaHora)}`,
    "",
    `<i>"${esc(p.extracto)}"</i>`,
    "",
    "Propongo completar:",
    `• Título — ${esc(p.titulo)}`,
    `• Ánimo — ${p.animo} · Intensidad ${p.intensidad}/5`,
    `• Topics — ${incluidos.length > 0 ? esc(incluidos.map((t) => t.name).join(", ")) : "ninguno"}`,
    `• Big Theme — ${p.bigTheme ? esc(p.bigTheme.name) : "sin asignar"}`,
  ];
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          { text: "✅ Aplicar", callback_data: `jnl:apply:${shortId}` },
          { text: "✏️ Título", callback_data: `jnl:edit-title:${shortId}` },
        ],
        [
          { text: "🎭 Ánimo", callback_data: `jnl:pick-animo:${shortId}` },
          { text: "🏷️ Topics", callback_data: `jnl:pick-topics:${shortId}` },
        ],
        [
          { text: "🎯 Big Theme", callback_data: `jnl:pick-theme:${shortId}` },
          { text: "❌ Sin metadata", callback_data: `jnl:nometa:${shortId}` },
        ],
      ],
    },
  };
}

export function renderAnimoPicker(p: MetaProposal, shortId: string): Card {
  const animoRows: Array<Array<{ text: string; callback_data: string }>> = [];
  ANIMOS.forEach((a, i) => {
    const marca = a === p.animo ? "✅ " : "";
    const fila = Math.floor(i / 2);
    animoRows[fila] ??= [];
    animoRows[fila]!.push({ text: `${marca}${a}`, callback_data: `jnl:animo:${shortId}:${i}` });
  });
  const intensidadRow = [1, 2, 3, 4, 5].map((n) => ({
    text: n === p.intensidad ? `[${n}]` : String(n),
    callback_data: `jnl:inten:${shortId}:${n}`,
  }));
  return {
    text: `🎭 <b>Ánimo e intensidad</b>\nActual: ${p.animo} · ${p.intensidad}/5`,
    keyboard: {
      inline_keyboard: [
        ...animoRows,
        intensidadRow,
        [{ text: "⬅️ Volver", callback_data: `jnl:back:${shortId}` }],
      ],
    },
  };
}

export function renderTopicsPicker(p: MetaProposal, shortId: string): Card {
  const fuera = new Set(p.topicsExcluidos);
  const rows = p.topics.map((t) => [
    {
      text: `${fuera.has(t.id) ? "⬜" : "✅"} ${t.name}`,
      callback_data: `jnl:togtopic:${shortId}:${t.id}`,
    },
  ]);
  rows.push([{ text: "⬅️ Volver", callback_data: `jnl:back:${shortId}` }]);
  return {
    text: "🏷️ <b>Topics</b>\nTap para incluir o excluir. Si falta uno, escribime el nombre y lo creo.",
    keyboard: { inline_keyboard: rows },
  };
}

export function renderBigThemePicker(p: MetaProposal, shortId: string, themes: NotionRef[]): Card {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  themes.forEach((t, i) => {
    const fila = Math.floor(i / 2);
    rows[fila] ??= [];
    const marca = p.bigTheme?.id === t.id ? "✅ " : "";
    rows[fila]!.push({ text: `${marca}${t.name}`, callback_data: `jnl:theme:${shortId}:${t.id}` });
  });
  rows.push([
    { text: "🚫 Sin big theme", callback_data: `jnl:theme:${shortId}:none` },
    { text: "⬅️ Volver", callback_data: `jnl:back:${shortId}` },
  ]);
  return {
    text: "🎯 <b>Big Theme</b>\nElegí uno.",
    keyboard: { inline_keyboard: rows },
  };
}

export function renderReflexionCard(p: ReflexionProposal, shortId: string): Card {
  const lines = [
    "🌟 <b>Acá hay una reflexión</b>",
    "",
    `• Título — ${esc(p.titulo)}`,
    `• Situación — ${esc(p.situacion) || "—"}`,
    "• Type — Reflexion · Tags — Terapia",
    `• Topics — ${p.topics.length > 0 ? esc(p.topics.map((t) => t.name).join(", ")) : "ninguno"}`,
    `• Big Theme — ${p.bigTheme ? esc(p.bigTheme.name) : "sin asignar"}`,
  ];
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [{ text: "✅ Guardar en Resonate", callback_data: `jnl:resonate:${shortId}` }],
        [
          { text: "✏️ Editar", callback_data: `jnl:edit-refl:${shortId}` },
          { text: "⏭️ Ahora no", callback_data: `jnl:later:${shortId}` },
        ],
      ],
    },
  };
}

export function renderSweepSelector(
  entries: Array<{ id: string; titulo: string; fecha: string }>,
): Card {
  const visibles = entries.slice(0, SWEEP_MAX_BOTONES);
  const lines = [
    `📓 <b>${entries.length} ${entries.length === 1 ? "pensamiento" : "pensamientos"} sin destilar</b>`,
    "",
    ...visibles.map((e, i) => `${i + 1}. ${esc(e.titulo)} · ${ddmm(e.fecha)}`),
  ];
  if (entries.length > visibles.length) {
    lines.push(`(y ${entries.length - visibles.length} más)`);
  }
  const numeros = visibles.map((e, i) => ({
    text: String(i + 1),
    callback_data: `jnl:sweep:${e.id}`,
  }));
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        numeros,
        [
          { text: "✅ Revisar todos", callback_data: "jnl:sweep:all" },
          { text: "❌ Ahora no", callback_data: "jnl:sweep:none" },
        ],
      ],
    },
  };
}

export function renderModeOpen(): Card {
  return {
    text: "📓 <b>Modo journal abierto</b>\nTodo lo que mandes —texto o voz— se guarda tal cual.",
    keyboard: { inline_keyboard: [[{ text: "⏹️ Cerrar", callback_data: "jnl:mode:close" }]] },
  };
}

export function renderModeClosed(guardadas: number, pendientes: number): Card {
  const partes = [`Guardé ${guardadas} ${guardadas === 1 ? "entrada" : "entradas"}`];
  if (pendientes > 0) {
    partes.push(`${pendientes} ${pendientes === 1 ? "reflexión pendiente" : "reflexiones pendientes"}`);
  }
  return {
    text: `📓 <b>Modo journal cerrado</b>\n${partes.join(" · ")}.`,
    keyboard: { inline_keyboard: [] },
  };
}

export function renderApplied(p: MetaProposal, entryId: string): Card {
  const incluidos = topicsIncluidos(p);
  const lines = [
    `📓 <b>Guardado</b> — ${ddmm(p.fechaHora)} · ${hhmm(p.fechaHora)}`,
    "",
    `<b>${esc(p.titulo)}</b>`,
    `${p.animo} · Intensidad ${p.intensidad}/5`,
    `🏷️ ${incluidos.length > 0 ? esc(incluidos.map((t) => t.name).join(", ")) : "sin topics"}`,
    `🎯 ${p.bigTheme ? esc(p.bigTheme.name) : "sin big theme"}`,
  ];
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [[{ text: "↩️ Deshacer", callback_data: `jnl:undo:${entryId}` }]],
    },
  };
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/journal-card.test.ts --root daemon-v2`
Expected: PASS — 19 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/journal-card.ts daemon-v2/src/journal-card.test.ts
git commit -m "feat(journal): render puro de tarjetas y teclados"
```

---

### Task 7: Escrituras y lecturas contra Notion

Envuelve `notionApi` de `tools/notion-cli.ts`. La lógica pura ya está testeada en las Tasks 3-4; acá se testea solo la resolución de nombres a IDs, que es la que tiene reglas propias.

**Files:**
- Create: `daemon-v2/src/tools/journal.ts`
- Test: `daemon-v2/src/tools/journal.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, it, expect } from "vitest";
import { resolveRefs, parseUnreviewedRows } from "./journal.js";

describe("resolveRefs", () => {
  const index = new Map([
    ["terapia", { id: "t1", name: "Terapia" }],
    ["autoestima", { id: "t2", name: "Autoestima" }],
  ]);

  it("resuelve nombres existentes sin distinguir mayúsculas ni acentos sobrantes", () => {
    expect(resolveRefs(["Terapia", "AUTOESTIMA"], index)).toEqual({
      encontrados: [
        { id: "t1", name: "Terapia" },
        { id: "t2", name: "Autoestima" },
      ],
      faltantes: [],
    });
  });

  it("reporta los nombres que no existen", () => {
    expect(resolveRefs(["Terapia", "Inventado"], index)).toEqual({
      encontrados: [{ id: "t1", name: "Terapia" }],
      faltantes: ["Inventado"],
    });
  });

  it("ignora duplicados", () => {
    expect(resolveRefs(["Terapia", "terapia"], index).encontrados).toHaveLength(1);
  });

  it("ignora nombres vacíos", () => {
    expect(resolveRefs(["  ", "Terapia"], index).faltantes).toEqual([]);
  });
});

describe("parseUnreviewedRows", () => {
  it("extrae id, título y fecha de la respuesta de Notion", () => {
    const res = {
      results: [
        {
          id: "e1",
          properties: {
            Pensamiento: { type: "title", title: [{ plain_text: "Miedo a la confrontación" }] },
            "Fecha y hora": { type: "date", date: { start: "2026-07-22T09:00:00-04:00" } },
          },
        },
      ],
    };
    expect(parseUnreviewedRows(res)).toEqual([
      { id: "e1", titulo: "Miedo a la confrontación", fecha: "2026-07-22T09:00:00-04:00" },
    ]);
  });

  it("usa un placeholder si la fila no tiene título", () => {
    const res = {
      results: [
        {
          id: "e1",
          properties: {
            Pensamiento: { type: "title", title: [] },
            "Fecha y hora": { type: "date", date: { start: "2026-07-22T09:00:00-04:00" } },
          },
        },
      ],
    };
    expect(parseUnreviewedRows(res)[0]!.titulo).toBe("(sin título)");
  });

  it("devuelve vacío si la respuesta no trae results", () => {
    expect(parseUnreviewedRows({ error: "boom" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/tools/journal.test.ts --root daemon-v2`
Expected: FAIL — `Failed to resolve import "./journal.js"`

- [ ] **Step 3: Implementar**

```typescript
// tools/journal.ts — escrituras y lecturas del Journal contra Notion vía `ntn`.
// Las funciones puras (payloads, texto) viven en journal-payloads.ts / journal-text.ts.

import { notionApi } from "./notion-cli.js";
import {
  BIG_THEMES_DB_ID,
  JOURNAL_DB_ID,
  RESONATE_DB_ID,
  TOPICS_DB_ID,
} from "../journal-ids.js";
import {
  buildBodyBlocks,
  buildEntryProperties,
  buildMetadataProperties,
  buildQuoteBlocks,
  buildResonateProperties,
} from "../journal-payloads.js";
import type { Animo, NotionRef, Origen } from "../journal-types.js";

export interface UnreviewedRow {
  id: string;
  titulo: string;
  fecha: string;
}

/** Cache en memoria de los índices nombre→ref. Se refresca cada 10 min. */
const INDEX_TTL_MS = 10 * 60 * 1000;
const indexCache = new Map<string, { at: number; index: Map<string, NotionRef> }>();

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/** Resuelve una lista de nombres contra un índice; separa encontrados de faltantes. */
export function resolveRefs(
  names: string[],
  index: Map<string, NotionRef>,
): { encontrados: NotionRef[]; faltantes: string[] } {
  const encontrados: NotionRef[] = [];
  const faltantes: string[] = [];
  const vistos = new Set<string>();
  for (const raw of names) {
    const key = normalize(raw);
    if (key.length === 0 || vistos.has(key)) continue;
    vistos.add(key);
    const ref = index.get(key);
    if (ref) encontrados.push(ref);
    else faltantes.push(raw.trim());
  }
  return { encontrados, faltantes };
}

/** Lee la respuesta de un query a la DB Journal y devuelve las filas mínimas. */
export function parseUnreviewedRows(res: unknown): UnreviewedRow[] {
  const results = (res as { results?: unknown[] }).results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => {
    const row = r as {
      id: string;
      properties: Record<string, { title?: Array<{ plain_text: string }>; date?: { start: string } | null }>;
    };
    const title = row.properties["Pensamiento"]?.title ?? [];
    const titulo = title.map((t) => t.plain_text).join("").trim();
    return {
      id: row.id,
      titulo: titulo.length > 0 ? titulo : "(sin título)",
      fecha: row.properties["Fecha y hora"]?.date?.start ?? "",
    };
  });
}

/** Índice nombre→ref de una DB de catálogo (Topics o Big Themes), cacheado 10 min. */
export function fetchIndex(dbId: string): Map<string, NotionRef> {
  const cached = indexCache.get(dbId);
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.index;

  const index = new Map<string, NotionRef>();
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body["start_cursor"] = cursor;
    const res = notionApi("POST", `/v1/databases/${dbId}/query`, body) as {
      results?: Array<{ id: string; properties: Record<string, { type: string; title?: Array<{ plain_text: string }> }> }>;
      has_more?: boolean;
      next_cursor?: string;
    };
    for (const row of res.results ?? []) {
      const titleProp = Object.values(row.properties).find((p) => p.type === "title");
      const name = (titleProp?.title ?? []).map((t) => t.plain_text).join("").trim();
      if (name.length > 0) index.set(normalize(name), { id: row.id, name });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  indexCache.set(dbId, { at: Date.now(), index });
  return index;
}

export const fetchTopicsIndex = (): Map<string, NotionRef> => fetchIndex(TOPICS_DB_ID);
export const fetchBigThemesIndex = (): Map<string, NotionRef> => fetchIndex(BIG_THEMES_DB_ID);

/** Crea un Topic nuevo y lo agrega al cache para que quede disponible al toque. */
export function createTopic(name: string): NotionRef | null {
  const res = notionApi("POST", "/v1/pages", {
    parent: { database_id: TOPICS_DB_ID },
    properties: { Topic: { title: [{ text: { content: name } }] } },
  }) as { id?: string };
  if (!res.id) return null;
  const ref = { id: res.id, name };
  indexCache.get(TOPICS_DB_ID)?.index.set(normalize(name), ref);
  return ref;
}

/**
 * Escritura MECÁNICA (paso 1): crea la fila con el texto íntegro en el cuerpo.
 * No pasa por el LLM — es lo que garantiza que un pensamiento nunca se pierda.
 */
export function createRawEntry(input: {
  texto: string;
  origen: Origen;
  fechaHora: string;
}): { ok: true; entryId: string } | { ok: false; error: string } {
  const res = notionApi("POST", "/v1/pages", {
    parent: { database_id: JOURNAL_DB_ID },
    properties: buildEntryProperties(input),
    children: buildBodyBlocks(input.texto),
  }) as { id?: string; error?: string; detail?: string };
  if (!res.id) return { ok: false, error: res.detail ?? res.error ?? "Notion no devolvió id" };
  return { ok: true, entryId: res.id };
}

/** Escritura del paso 2: aplica la metadata aprobada. */
export function applyMetadata(
  entryId: string,
  meta: { titulo: string; animo: Animo; intensidad: number; topics: NotionRef[]; bigTheme: NotionRef | null },
): { ok: boolean; error?: string } {
  const res = notionApi("PATCH", `/v1/pages/${entryId}`, {
    properties: buildMetadataProperties(meta),
  }) as { id?: string; error?: string; detail?: string };
  return res.id ? { ok: true } : { ok: false, error: res.detail ?? res.error ?? "PATCH sin id" };
}

/** Undo de applyMetadata: vacía los campos que el paso 2 había completado. */
export function clearMetadata(entryId: string): { ok: boolean } {
  const res = notionApi("PATCH", `/v1/pages/${entryId}`, {
    properties: {
      "Ánimo": { select: null },
      Intensidad: { number: null },
      Topics: { relation: [] },
      "Big Themes": { relation: [] },
    },
  }) as { id?: string };
  return { ok: Boolean(res.id) };
}

export function setEstado(entryId: string, estado: string): { ok: boolean } {
  const res = notionApi("PATCH", `/v1/pages/${entryId}`, {
    properties: { Estado: { select: { name: estado } } },
  }) as { id?: string };
  return { ok: Boolean(res.id) };
}

/** Crea la fila en Resonate Calendar con la cita del texto crudo en el cuerpo. */
export function createResonateEntry(input: {
  titulo: string;
  situacion: string;
  fecha: string;
  topics: NotionRef[];
  bigTheme: NotionRef | null;
  entryId: string;
  textoCrudo: string;
}): { ok: true; resonateId: string } | { ok: false; error: string } {
  const res = notionApi("POST", "/v1/pages", {
    parent: { database_id: RESONATE_DB_ID },
    properties: buildResonateProperties(input),
    children: buildQuoteBlocks(input.textoCrudo),
  }) as { id?: string; error?: string; detail?: string };
  if (!res.id) return { ok: false, error: res.detail ?? res.error ?? "Notion no devolvió id" };
  return { ok: true, resonateId: res.id };
}

/** Undo de createResonateEntry: archiva la fila creada. */
export function archiveResonateEntry(resonateId: string): { ok: boolean } {
  const res = notionApi("PATCH", `/v1/pages/${resonateId}`, { in_trash: true }) as { id?: string };
  return { ok: Boolean(res.id) };
}

/** Entradas `Sin revisar` desde una fecha (ISO), más viejas primero. */
export function queryUnreviewed(sinceIso: string): UnreviewedRow[] {
  const res = notionApi("POST", `/v1/databases/${JOURNAL_DB_ID}/query`, {
    filter: {
      and: [
        { property: "Estado", select: { equals: "Sin revisar" } },
        { property: "Fecha y hora", date: { on_or_after: sinceIso } },
      ],
    },
    sorts: [{ property: "Fecha y hora", direction: "ascending" }],
    page_size: 50,
  });
  return parseUnreviewedRows(res);
}

/** Una entrada puntual, para reabrir su checkpoint desde el barrido. */
export function getEntry(entryId: string): { titulo: string; fecha: string; texto: string } | null {
  const page = notionApi("GET", `/v1/pages/${entryId}`) as {
    id?: string;
    properties?: Record<string, { title?: Array<{ plain_text: string }>; date?: { start: string } | null }>;
  };
  if (!page.id || !page.properties) return null;
  const titulo = (page.properties["Pensamiento"]?.title ?? []).map((t) => t.plain_text).join("").trim();
  const fecha = page.properties["Fecha y hora"]?.date?.start ?? "";

  const blocks = notionApi("GET", `/v1/blocks/${entryId}/children?page_size=100`) as {
    results?: Array<{ type: string; paragraph?: { rich_text: Array<{ plain_text: string }> } }>;
  };
  const texto = (blocks.results ?? [])
    .filter((b) => b.type === "paragraph")
    .map((b) => (b.paragraph?.rich_text ?? []).map((t) => t.plain_text).join(""))
    .join("\n\n");

  return { titulo: titulo || "(sin título)", fecha, texto };
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/tools/journal.test.ts --root daemon-v2`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/tools/journal.ts daemon-v2/src/tools/journal.test.ts
git commit -m "feat(journal): escrituras y lecturas contra Notion"
```

---

### Task 8: Enriquecimiento con LLM

Llamada acotada con Haiku y cero tools, mismo patrón que `compact.ts`. Devuelve JSON estricto.

**Files:**
- Create: `daemon-v2/src/journal-enrich.ts`
- Test: `daemon-v2/src/journal-enrich.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, it, expect } from "vitest";
import { buildEnrichPrompt, parseEnrichResult } from "./journal-enrich.js";

describe("buildEnrichPrompt", () => {
  it("incluye el texto y los catálogos disponibles", () => {
    const prompt = buildEnrichPrompt("me sentí mal", ["Terapia", "Foco"], ["Better Me"]);
    expect(prompt).toContain("me sentí mal");
    expect(prompt).toContain("Terapia, Foco");
    expect(prompt).toContain("Better Me");
  });

  it("explica el criterio de reflexión y el default conservador", () => {
    const prompt = buildEnrichPrompt("x", [], []);
    expect(prompt).toContain("sigue siendo cierto mañana");
    expect(prompt).toContain("ante la duda");
  });
});

describe("parseEnrichResult", () => {
  it("parsea una respuesta bien formada", () => {
    const out = parseEnrichResult(
      JSON.stringify({
        titulo: "Miedo a la confrontación",
        animo: "😤 Tensionado",
        intensidad: 4,
        topics: ["Terapia"],
        bigTheme: "Better Me",
        reflexion: { titulo: "T", situacion: "S" },
      }),
    );
    expect(out).toEqual({
      titulo: "Miedo a la confrontación",
      animo: "😤 Tensionado",
      intensidad: 4,
      topics: ["Terapia"],
      bigTheme: "Better Me",
      reflexion: { titulo: "T", situacion: "S" },
    });
  });

  it("tolera que el modelo envuelva el JSON en un fence", () => {
    const out = parseEnrichResult('```json\n{"titulo":"T","animo":"🙂 Bien","intensidad":2,"topics":[],"bigTheme":null,"reflexion":null}\n```');
    expect(out?.titulo).toBe("T");
  });

  it("devuelve null si no es JSON", () => {
    expect(parseEnrichResult("no puedo hacer eso")).toBeNull();
  });

  it("cae a Neutro si el ánimo no está en la lista", () => {
    const out = parseEnrichResult('{"titulo":"T","animo":"eufórico","intensidad":3,"topics":[],"bigTheme":null,"reflexion":null}');
    expect(out?.animo).toBe("😐 Neutro");
  });

  it("recorta la intensidad al rango 1-5", () => {
    expect(parseEnrichResult('{"titulo":"T","animo":"😐 Neutro","intensidad":9,"topics":[],"bigTheme":null,"reflexion":null}')?.intensidad).toBe(5);
    expect(parseEnrichResult('{"titulo":"T","animo":"😐 Neutro","intensidad":0,"topics":[],"bigTheme":null,"reflexion":null}')?.intensidad).toBe(1);
  });

  it("devuelve null si falta el título", () => {
    expect(parseEnrichResult('{"animo":"😐 Neutro","intensidad":3,"topics":[],"bigTheme":null,"reflexion":null}')).toBeNull();
  });

  it("descarta una reflexión sin título", () => {
    const out = parseEnrichResult('{"titulo":"T","animo":"😐 Neutro","intensidad":3,"topics":[],"bigTheme":null,"reflexion":{"titulo":"","situacion":"S"}}');
    expect(out?.reflexion).toBeNull();
  });

  it("ignora topics que no son strings", () => {
    const out = parseEnrichResult('{"titulo":"T","animo":"😐 Neutro","intensidad":3,"topics":["Terapia",5,null],"bigTheme":null,"reflexion":null}');
    expect(out?.topics).toEqual(["Terapia"]);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/journal-enrich.test.ts --root daemon-v2`
Expected: FAIL — `Failed to resolve import "./journal-enrich.js"`

- [ ] **Step 3: Implementar**

```typescript
// journal-enrich.ts — paso 2 del guardado: propone metadata leyendo el texto crudo.
// Llamada acotada (Haiku, maxTurns 1, sin tools), mismo patrón que compact.ts.
// El texto YA está guardado cuando esto corre: si falla, no se pierde nada.

import { startup } from "@anthropic-ai/claude-agent-sdk";
import { ANIMOS, type Animo, type EnrichResult } from "./journal-types.js";

const MODEL = "claude-haiku-4-5-20251001";

export function buildEnrichPrompt(texto: string, topics: string[], bigThemes: string[]): string {
  return [
    "Sos un asistente que clasifica entradas de un diario personal de terapia.",
    "Leé el texto y devolvé SOLO un objeto JSON, sin explicación ni fences.",
    "",
    "Campos:",
    '- "titulo": frase breve (máx 60 caracteres) que nombre el pensamiento. En español.',
    `- "animo": uno exacto de: ${ANIMOS.join(" | ")}`,
    '- "intensidad": entero 1-5 (1 = apenas registrable, 5 = muy intenso).',
    `- "topics": array con 0-4 nombres, SOLO de esta lista: ${topics.join(", ")}`,
    `- "bigTheme": uno de esta lista o null: ${bigThemes.join(", ")}`,
    '- "reflexion": objeto {"titulo","situacion"} o null.',
    "",
    "Criterio para reflexion: hay reflexión cuando el texto contiene un aprendizaje,",
    "patrón o decisión que sigue siendo cierto mañana. NO la hay cuando es solo registro",
    "de estado ('hoy amanecí cansado') o narración sin conclusión. Ante la duda, devolvé null.",
    "",
    "Texto:",
    texto,
  ].join("\n");
}

export function parseEnrichResult(raw: string): EnrichResult | null {
  const limpio = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(limpio) as Record<string, unknown>;
  } catch {
    return null;
  }

  const titulo = typeof obj["titulo"] === "string" ? obj["titulo"].trim() : "";
  if (titulo.length === 0) return null;

  const animoRaw = obj["animo"];
  const animo: Animo = ANIMOS.includes(animoRaw as Animo) ? (animoRaw as Animo) : "😐 Neutro";

  const intensidadRaw = Number(obj["intensidad"]);
  const intensidad = Number.isFinite(intensidadRaw)
    ? Math.min(5, Math.max(1, Math.round(intensidadRaw)))
    : 3;

  const topics = Array.isArray(obj["topics"])
    ? (obj["topics"] as unknown[]).filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];

  const bigTheme = typeof obj["bigTheme"] === "string" && obj["bigTheme"].trim().length > 0
    ? obj["bigTheme"].trim()
    : null;

  let reflexion: EnrichResult["reflexion"] = null;
  const r = obj["reflexion"];
  if (r && typeof r === "object") {
    const rt = (r as Record<string, unknown>)["titulo"];
    const rs = (r as Record<string, unknown>)["situacion"];
    if (typeof rt === "string" && rt.trim().length > 0) {
      reflexion = { titulo: rt.trim(), situacion: typeof rs === "string" ? rs.trim() : "" };
    }
  }

  return { titulo: titulo.slice(0, 60), animo, intensidad, topics, bigTheme, reflexion };
}

/** Corre la llamada real. Devuelve null si el modelo falla o responde algo inutilizable. */
export async function enrichEntry(
  texto: string,
  topics: string[],
  bigThemes: string[],
): Promise<EnrichResult | null> {
  const handle = await startup({
    options: { model: MODEL, maxTurns: 1, allowedTools: [] },
  });

  let out = "";
  for await (const event of handle.query(buildEnrichPrompt(texto, topics, bigThemes))) {
    const e = event as { type?: string; subtype?: string; result?: string };
    if (e.type === "result" && e.subtype === "success") {
      out = e.result ?? "";
      break;
    }
  }
  return parseEnrichResult(out);
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/journal-enrich.test.ts --root daemon-v2`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/journal-enrich.ts daemon-v2/src/journal-enrich.test.ts
git commit -m "feat(journal): enriquecimiento con LLM acotado (Haiku, sin tools)"
```

---

### Task 9: Orquestador de captura

Une todo: guarda mecánicamente, manda confirmación, y dispara el enriquecimiento sin bloquear.

**Files:**
- Create: `daemon-v2/src/journal-capture.ts`
- Test: `daemon-v2/src/journal-capture.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, it, expect } from "vitest";
import { nowInLaPaz, buildMetaProposal } from "./journal-capture.js";
import type { EnrichResult, NotionRef } from "./journal-types.js";

describe("nowInLaPaz", () => {
  it("formatea con offset fijo -04:00", () => {
    const iso = nowInLaPaz(new Date("2026-07-27T18:32:05.000Z"));
    expect(iso).toBe("2026-07-27T14:32:05-04:00");
  });

  it("retrocede de día cuando corresponde", () => {
    expect(nowInLaPaz(new Date("2026-07-27T02:00:00.000Z"))).toBe("2026-07-26T22:00:00-04:00");
  });
});

describe("buildMetaProposal", () => {
  const enrich: EnrichResult = {
    titulo: "Miedo a la confrontación",
    animo: "😤 Tensionado",
    intensidad: 4,
    topics: ["Terapia", "Inventado"],
    bigTheme: "Better Me",
    reflexion: { titulo: "R", situacion: "S" },
  };
  const topicIndex = new Map<string, NotionRef>([["terapia", { id: "t1", name: "Terapia" }]]);
  const themeIndex = new Map<string, NotionRef>([["better me", { id: "b1", name: "Better Me" }]]);

  it("resuelve topics y big theme a refs reales", () => {
    const p = buildMetaProposal({
      entryId: "e1",
      enrich,
      topicIndex,
      themeIndex,
      fechaHora: "2026-07-27T14:32:05-04:00",
      textoCrudo: "texto crudo",
      messageId: 7,
    });
    expect(p.topics).toEqual([{ id: "t1", name: "Terapia" }]);
    expect(p.bigTheme).toEqual({ id: "b1", name: "Better Me" });
  });

  it("descarta topics inventados en vez de fallar", () => {
    const p = buildMetaProposal({
      entryId: "e1",
      enrich,
      topicIndex,
      themeIndex,
      fechaHora: "2026-07-27T14:32:05-04:00",
      textoCrudo: "texto crudo",
      messageId: 7,
    });
    expect(p.topics.map((t) => t.name)).not.toContain("Inventado");
  });

  it("deja bigTheme null si el nombre no existe", () => {
    const p = buildMetaProposal({
      entryId: "e1",
      enrich: { ...enrich, bigTheme: "No Existe" },
      topicIndex,
      themeIndex,
      fechaHora: "2026-07-27T14:32:05-04:00",
      textoCrudo: "texto crudo",
      messageId: 7,
    });
    expect(p.bigTheme).toBeNull();
  });

  it("arranca sin topics excluidos y con el extracto derivado del texto", () => {
    const p = buildMetaProposal({
      entryId: "e1",
      enrich,
      topicIndex,
      themeIndex,
      fechaHora: "2026-07-27T14:32:05-04:00",
      textoCrudo: "texto crudo",
      messageId: 7,
    });
    expect(p.topicsExcluidos).toEqual([]);
    expect(p.extracto).toBe("texto crudo");
    expect(p.kind).toBe("journal-meta");
  });

  it("conserva la reflexión propuesta", () => {
    const p = buildMetaProposal({
      entryId: "e1",
      enrich,
      topicIndex,
      themeIndex,
      fechaHora: "2026-07-27T14:32:05-04:00",
      textoCrudo: "texto crudo",
      messageId: 7,
    });
    expect(p.reflexion).toEqual({ titulo: "R", situacion: "S" });
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/journal-capture.test.ts --root daemon-v2`
Expected: FAIL — `Failed to resolve import "./journal-capture.js"`

- [ ] **Step 3: Implementar**

```typescript
// journal-capture.ts — orquesta la captura de un pensamiento.
// Paso 1 (mecánico) y paso 2 (LLM) están separados a propósito: el texto se
// persiste ANTES de que el modelo vea nada. Ver el spec, sección 2.

import { editMessage, sendMessage } from "@cos/shared";
import { renderMetaCard } from "./journal-card.js";
import { enrichEntry } from "./journal-enrich.js";
import { buildExtracto } from "./journal-text.js";
import type { JournalStore } from "./journal-store.js";
import type { EnrichResult, MetaProposal, NotionRef, Origen } from "./journal-types.js";
import {
  createRawEntry,
  fetchBigThemesIndex,
  fetchTopicsIndex,
  resolveRefs,
} from "./tools/journal.js";

/** Fecha/hora con el offset fijo de Bolivia (-04:00, sin horario de verano). */
export function nowInLaPaz(now: Date = new Date()): string {
  const laPaz = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return `${laPaz.toISOString().slice(0, 19)}-04:00`;
}

export function buildMetaProposal(input: {
  entryId: string;
  enrich: EnrichResult;
  topicIndex: Map<string, NotionRef>;
  themeIndex: Map<string, NotionRef>;
  fechaHora: string;
  textoCrudo: string;
  messageId: number;
}): MetaProposal {
  const { encontrados: topics } = resolveRefs(input.enrich.topics, input.topicIndex);
  const bigTheme = input.enrich.bigTheme
    ? (resolveRefs([input.enrich.bigTheme], input.themeIndex).encontrados[0] ?? null)
    : null;

  return {
    kind: "journal-meta",
    entryId: input.entryId,
    titulo: input.enrich.titulo,
    animo: input.enrich.animo,
    intensidad: input.enrich.intensidad,
    topics,
    topicsExcluidos: [],
    bigTheme,
    extracto: buildExtracto(input.textoCrudo),
    fechaHora: input.fechaHora,
    textoCrudo: input.textoCrudo,
    reflexion: input.enrich.reflexion,
    messageId: input.messageId,
  };
}

export interface CaptureDeps {
  botToken: string;
  store: JournalStore;
  log: (obj: Record<string, unknown>) => void;
}

/**
 * Guarda un pensamiento y manda la tarjeta.
 * PASO 1 es sincrónico y bloqueante: si falla, Cal se entera al toque.
 * PASO 2 corre después; si falla, la entrada ya está a salvo.
 */
export async function captureThought(
  deps: CaptureDeps,
  chatId: number,
  texto: string,
  origen: Origen,
): Promise<{ guardada: boolean; conReflexion: boolean }> {
  const fechaHora = nowInLaPaz();

  // ---- PASO 1: escritura mecánica, sin LLM ----
  const creada = createRawEntry({ texto, origen, fechaHora });
  if (!creada.ok) {
    deps.log({ msg: "journal_create_failed", err: creada.error });
    await sendMessage(deps.botToken, {
      chatId,
      text: "⚠️ <b>No pude guardar el pensamiento en Notion</b>\nRevisá el log del daemon. Tu texto no se perdió: volvé a mandarlo cuando esté resuelto.",
      parseMode: "HTML",
    }).catch(() => {});
    return { guardada: false, conReflexion: false };
  }

  const ack = await sendMessage(deps.botToken, {
    chatId,
    text: "📓 <b>Guardado</b>\n<i>Buscando de qué se trata...</i>",
    parseMode: "HTML",
  });
  deps.log({ msg: "journal_saved", entryId: creada.entryId, origen, chars: texto.length });

  // ---- PASO 2: enriquecimiento con LLM ----
  let enrich: EnrichResult | null = null;
  let topicIndex = new Map<string, NotionRef>();
  let themeIndex = new Map<string, NotionRef>();
  try {
    topicIndex = fetchTopicsIndex();
    themeIndex = fetchBigThemesIndex();
    enrich = await enrichEntry(
      texto,
      [...topicIndex.values()].map((t) => t.name),
      [...themeIndex.values()].map((t) => t.name),
    );
  } catch (err) {
    deps.log({ msg: "journal_enrich_error", entryId: creada.entryId, err: String(err) });
  }

  if (!enrich) {
    await editMessage(
      deps.botToken,
      chatId,
      ack.message_id,
      "📓 <b>Guardado</b>\nNo pude proponerte metadata esta vez — la entrada quedó sin revisar y te la muestro en el barrido del domingo.",
      "HTML",
      { inline_keyboard: [] },
    ).catch(() => {});
    return { guardada: true, conReflexion: false };
  }

  const proposal = buildMetaProposal({
    entryId: creada.entryId,
    enrich,
    topicIndex,
    themeIndex,
    fechaHora,
    textoCrudo: texto,
    messageId: ack.message_id,
  });
  const shortId = await deps.store.createProposal(chatId, proposal);
  const card = renderMetaCard(proposal, shortId);
  await editMessage(deps.botToken, chatId, ack.message_id, card.text, "HTML", card.keyboard).catch(
    (err) => deps.log({ msg: "journal_card_edit_error", err: String(err) }),
  );

  return { guardada: true, conReflexion: proposal.reflexion != null };
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/journal-capture.test.ts --root daemon-v2`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/journal-capture.ts daemon-v2/src/journal-capture.test.ts
git commit -m "feat(journal): orquestador de captura (guardado en dos tiempos)"
```

---

### Task 10: Handlers de callbacks

**Files:**
- Create: `daemon-v2/src/journal-callbacks.ts`
- Test: `daemon-v2/src/journal-callbacks.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, it, expect } from "vitest";
import { isJournalCallback, parseJournalCallback, applyToggleTopic, applyAnimoPick } from "./journal-callbacks.js";
import type { MetaProposal } from "./journal-types.js";

function meta(): MetaProposal {
  return {
    kind: "journal-meta",
    entryId: "e1",
    titulo: "T",
    animo: "😐 Neutro",
    intensidad: 3,
    topics: [{ id: "t1", name: "Terapia" }, { id: "t2", name: "Foco" }],
    topicsExcluidos: [],
    bigTheme: null,
    extracto: "x",
    fechaHora: "2026-07-27T14:32:00-04:00",
    textoCrudo: "x",
    reflexion: null,
    messageId: 1,
  };
}

describe("isJournalCallback", () => {
  it("reconoce los callbacks del journal", () => {
    expect(isJournalCallback("jnl:apply:ab12")).toBe(true);
    expect(isJournalCallback("jnl:mode:close")).toBe(true);
  });

  it("ignora los demás", () => {
    expect(isJournalCallback("j:resu:save")).toBe(false);
    expect(isJournalCallback(undefined)).toBe(false);
  });
});

describe("parseJournalCallback", () => {
  it("separa acción, shortId y argumento", () => {
    expect(parseJournalCallback("jnl:togtopic:ab12:t1")).toEqual({
      accion: "togtopic",
      shortId: "ab12",
      arg: "t1",
    });
  });

  it("deja arg undefined cuando no hay", () => {
    expect(parseJournalCallback("jnl:apply:ab12")).toEqual({
      accion: "apply",
      shortId: "ab12",
      arg: undefined,
    });
  });

  it("devuelve null si el formato no es válido", () => {
    expect(parseJournalCallback("jnl:")).toBeNull();
    expect(parseJournalCallback("otra:cosa")).toBeNull();
  });
});

describe("applyToggleTopic", () => {
  it("excluye un topic incluido", () => {
    expect(applyToggleTopic(meta(), "t1").topicsExcluidos).toEqual(["t1"]);
  });

  it("vuelve a incluir uno excluido", () => {
    const p = { ...meta(), topicsExcluidos: ["t1"] };
    expect(applyToggleTopic(p, "t1").topicsExcluidos).toEqual([]);
  });

  it("ignora un id que no está en la lista", () => {
    expect(applyToggleTopic(meta(), "zzz").topicsExcluidos).toEqual([]);
  });
});

describe("applyAnimoPick", () => {
  it("cambia el ánimo por índice", () => {
    expect(applyAnimoPick(meta(), "4").animo).toBe("😰 Ansioso");
  });

  it("ignora un índice fuera de rango", () => {
    expect(applyAnimoPick(meta(), "9").animo).toBe("😐 Neutro");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/journal-callbacks.test.ts --root daemon-v2`
Expected: FAIL — `Failed to resolve import "./journal-callbacks.js"`

- [ ] **Step 3: Implementar**

```typescript
// journal-callbacks.ts — handlers de los callbacks jnl:*. Todos son HEAVY
// (escriben en Notion) y corren en el daemon, nunca en el worker.

import { answerCallbackQuery, editMessage } from "@cos/shared";
import {
  renderAnimoPicker,
  renderApplied,
  renderBigThemePicker,
  renderMetaCard,
  renderReflexionCard,
  renderTopicsPicker,
} from "./journal-card.js";
import type { JournalStore } from "./journal-store.js";
import { ANIMOS, type MetaProposal, type ReflexionProposal } from "./journal-types.js";
import {
  applyMetadata,
  archiveResonateEntry,
  clearMetadata,
  createResonateEntry,
  fetchBigThemesIndex,
  setEstado,
} from "./tools/journal.js";

export interface ParsedCallback {
  accion: string;
  shortId: string;
  arg: string | undefined;
}

export function isJournalCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith("jnl:");
}

export function parseJournalCallback(data: string): ParsedCallback | null {
  const parts = data.split(":");
  if (parts[0] !== "jnl" || !parts[1] || !parts[2]) return null;
  return { accion: parts[1], shortId: parts[2], arg: parts[3] };
}

export function applyToggleTopic(p: MetaProposal, topicId: string): MetaProposal {
  if (!p.topics.some((t) => t.id === topicId)) return p;
  const fuera = new Set(p.topicsExcluidos);
  if (fuera.has(topicId)) fuera.delete(topicId);
  else fuera.add(topicId);
  return { ...p, topicsExcluidos: [...fuera] };
}

export function applyAnimoPick(p: MetaProposal, idxRaw: string): MetaProposal {
  const idx = Number(idxRaw);
  if (!Number.isInteger(idx) || idx < 0 || idx >= ANIMOS.length) return p;
  return { ...p, animo: ANIMOS[idx]! };
}

export interface JournalCallbackDeps {
  botToken: string;
  store: JournalStore;
  log: (obj: Record<string, unknown>) => void;
}

function topicsIncluidos(p: MetaProposal) {
  const fuera = new Set(p.topicsExcluidos);
  return p.topics.filter((t) => !fuera.has(t.id));
}

/**
 * Procesa un callback jnl:*. Devuelve true si lo manejó.
 * El caller ya hizo answerCallbackQuery y tomó el lock anti-doble-tap.
 */
export async function handleJournalCallback(
  deps: JournalCallbackDeps,
  chatId: number,
  messageId: number,
  data: string,
): Promise<boolean> {
  const parsed = parseJournalCallback(data);
  if (!parsed) return false;
  const { accion, shortId, arg } = parsed;

  // ↩️ Deshacer usa el entryId, no un shortId de propuesta.
  if (accion === "undo") {
    const snapshot = await deps.store.getUndo(chatId, shortId);
    if (!snapshot) {
      await editMessage(deps.botToken, chatId, messageId, "⌛ La ventana para deshacer ya pasó.", "HTML", { inline_keyboard: [] }).catch(() => {});
      return true;
    }
    if (snapshot.kind === "journal-meta") {
      clearMetadata(snapshot.entryId);
    } else {
      archiveResonateEntry(snapshot.resonateId);
      setEstado(snapshot.entryId, "Sin revisar");
    }
    await deps.store.clearUndo(chatId, shortId);
    await editMessage(deps.botToken, chatId, messageId, "↩️ <b>Deshecho</b>\nLa entrada volvió a como estaba.", "HTML", { inline_keyboard: [] }).catch(() => {});
    return true;
  }

  const proposal = await deps.store.getProposal(chatId, shortId);
  if (!proposal) {
    await editMessage(deps.botToken, chatId, messageId, "⌛ Esta propuesta expiró. La entrada quedó guardada sin revisar — te la muestro en el barrido del domingo.", "HTML", { inline_keyboard: [] }).catch(() => {});
    return true;
  }

  // --- Propuesta de metadata ---
  if (proposal.kind === "journal-meta") {
    const p = proposal;

    const repaint = async (next: MetaProposal) => {
      await deps.store.updateProposal(chatId, shortId, next);
      const card = renderMetaCard(next, shortId);
      await editMessage(deps.botToken, chatId, messageId, card.text, "HTML", card.keyboard).catch(() => {});
    };

    switch (accion) {
      case "pick-animo": {
        const card = renderAnimoPicker(p, shortId);
        await editMessage(deps.botToken, chatId, messageId, card.text, "HTML", card.keyboard).catch(() => {});
        return true;
      }
      case "pick-topics": {
        const card = renderTopicsPicker(p, shortId);
        await editMessage(deps.botToken, chatId, messageId, card.text, "HTML", card.keyboard).catch(() => {});
        return true;
      }
      case "pick-theme": {
        const themes = [...fetchBigThemesIndex().values()];
        const card = renderBigThemePicker(p, shortId, themes);
        await editMessage(deps.botToken, chatId, messageId, card.text, "HTML", card.keyboard).catch(() => {});
        return true;
      }
      case "animo":
        await repaint(applyAnimoPick(p, arg ?? ""));
        return true;
      case "inten": {
        const n = Number(arg);
        if (Number.isInteger(n) && n >= 1 && n <= 5) await repaint({ ...p, intensidad: n });
        return true;
      }
      case "togtopic":
        await repaint(applyToggleTopic(p, arg ?? ""));
        return true;
      case "theme": {
        if (arg === "none") await repaint({ ...p, bigTheme: null });
        else {
          const ref = [...fetchBigThemesIndex().values()].find((t) => t.id === arg) ?? null;
          await repaint({ ...p, bigTheme: ref });
        }
        return true;
      }
      case "back":
        await repaint(p);
        return true;
      case "edit-title": {
        await deps.store.setPendingEdit(chatId, { campo: "titulo", shortId, messageId });
        await editMessage(deps.botToken, chatId, messageId, "✏️ <b>Mandame el título que querés</b>\nRespondé con el texto y lo aplico a la propuesta.", "HTML", { inline_keyboard: [] }).catch(() => {});
        return true;
      }
      case "nometa": {
        await deps.store.clearProposal(chatId, shortId);
        await editMessage(deps.botToken, chatId, messageId, "📓 <b>Guardado sin metadata</b>\nQueda sin revisar para el barrido del domingo.", "HTML", { inline_keyboard: [] }).catch(() => {});
        return true;
      }
      case "apply": {
        const incluidos = topicsIncluidos(p);
        const res = applyMetadata(p.entryId, {
          titulo: p.titulo,
          animo: p.animo,
          intensidad: p.intensidad,
          topics: incluidos,
          bigTheme: p.bigTheme,
        });
        if (!res.ok) {
          deps.log({ msg: "journal_apply_failed", entryId: p.entryId, err: res.error });
          await editMessage(deps.botToken, chatId, messageId, "⚠️ No pude escribir la metadata en Notion. La entrada sigue guardada con su texto.", "HTML", { inline_keyboard: [] }).catch(() => {});
          return true;
        }
        await deps.store.setUndo(chatId, p.entryId, { kind: "journal-meta", entryId: p.entryId });
        await deps.store.clearProposal(chatId, shortId);

        // Si había reflexión, la MISMA tarjeta se transforma en el checkpoint de Resonate.
        if (p.reflexion) {
          const refl: ReflexionProposal = {
            kind: "journal-reflexion",
            entryId: p.entryId,
            titulo: p.reflexion.titulo,
            situacion: p.reflexion.situacion,
            topics: incluidos,
            bigTheme: p.bigTheme,
            fecha: p.fechaHora.slice(0, 10),
            textoCrudo: p.textoCrudo,
            messageId,
          };
          const reflShortId = await deps.store.createProposal(chatId, refl);
          const card = renderReflexionCard(refl, reflShortId);
          await editMessage(deps.botToken, chatId, messageId, card.text, "HTML", card.keyboard).catch(() => {});
          return true;
        }

        const done = renderApplied(p, p.entryId);
        await editMessage(deps.botToken, chatId, messageId, done.text, "HTML", done.keyboard).catch(() => {});
        return true;
      }
      default:
        return false;
    }
  }

  // --- Propuesta de reflexión ---
  const r = proposal;
  switch (accion) {
    case "later": {
      await deps.store.clearProposal(chatId, shortId);
      await editMessage(deps.botToken, chatId, messageId, "⏭️ <b>Queda sin destilar</b>\nTe la vuelvo a mostrar en el barrido del domingo.", "HTML", { inline_keyboard: [] }).catch(() => {});
      return true;
    }
    case "edit-refl": {
      await deps.store.setPendingEdit(chatId, { campo: "reflexion", shortId, messageId });
      await editMessage(deps.botToken, chatId, messageId, "✏️ <b>Mandame el título de la reflexión</b>\nRespondé con el texto y lo aplico antes de guardar.", "HTML", { inline_keyboard: [] }).catch(() => {});
      return true;
    }
    case "resonate": {
      const res = createResonateEntry({
        titulo: r.titulo,
        situacion: r.situacion,
        fecha: r.fecha,
        topics: r.topics,
        bigTheme: r.bigTheme,
        entryId: r.entryId,
        textoCrudo: r.textoCrudo,
      });
      if (!res.ok) {
        deps.log({ msg: "journal_resonate_failed", entryId: r.entryId, err: res.error });
        await editMessage(deps.botToken, chatId, messageId, "⚠️ No pude crear la reflexión en Resonate. La entrada quedó sin revisar.", "HTML", { inline_keyboard: [] }).catch(() => {});
        return true;
      }
      setEstado(r.entryId, "Destilado");
      await deps.store.setUndo(chatId, r.entryId, {
        kind: "journal-reflexion",
        entryId: r.entryId,
        resonateId: res.resonateId,
      });
      await deps.store.clearProposal(chatId, shortId);
      await editMessage(
        deps.botToken,
        chatId,
        messageId,
        `🌟 <b>${r.titulo}</b>\nGuardada en Resonate Calendar.`,
        "HTML",
        { inline_keyboard: [[{ text: "↩️ Deshacer", callback_data: `jnl:undo:${r.entryId}` }]] },
      ).catch(() => {});
      return true;
    }
    default:
      return false;
  }
}

/**
 * Consume un mensaje de texto de Cal como la edición pendiente de un botón ✏️.
 * Devuelve true si lo consumió (el caller NO debe seguir procesando el mensaje).
 */
export async function applyPendingEdit(
  deps: JournalCallbackDeps,
  chatId: number,
  texto: string,
): Promise<boolean> {
  const pending = await deps.store.getPendingEdit(chatId);
  if (!pending) return false;
  await deps.store.clearPendingEdit(chatId);

  const proposal = await deps.store.getProposal(chatId, pending.shortId);
  if (!proposal) {
    await editMessage(deps.botToken, chatId, pending.messageId, "⌛ Esa propuesta expiró; no pude aplicar el cambio.", "HTML", { inline_keyboard: [] }).catch(() => {});
    return true;
  }

  const nuevo = texto.trim().slice(0, 200);
  if (pending.campo === "titulo" && proposal.kind === "journal-meta") {
    const next = { ...proposal, titulo: nuevo };
    await deps.store.updateProposal(chatId, pending.shortId, next);
    const card = renderMetaCard(next, pending.shortId);
    await editMessage(deps.botToken, chatId, pending.messageId, card.text, "HTML", card.keyboard).catch(() => {});
    return true;
  }
  if (pending.campo === "reflexion" && proposal.kind === "journal-reflexion") {
    const next = { ...proposal, titulo: nuevo };
    await deps.store.updateProposal(chatId, pending.shortId, next);
    const card = renderReflexionCard(next, pending.shortId);
    await editMessage(deps.botToken, chatId, pending.messageId, card.text, "HTML", card.keyboard).catch(() => {});
    return true;
  }

  // El tipo de propuesta cambió bajo los pies (ej. la metadata ya se aplicó y
  // pasó a ser una propuesta de reflexión) — no aplicamos nada y lo decimos.
  await editMessage(deps.botToken, chatId, pending.messageId, "⚠️ Esa edición ya no aplica a la tarjeta actual.", "HTML", { inline_keyboard: [] }).catch(() => {});
  return true;
}

/** Ack corto para los callbacks que Telegram espera responder rápido. */
export async function ackJournal(botToken: string, callbackId: string, texto?: string): Promise<void> {
  await answerCallbackQuery(botToken, callbackId, texto).catch(() => {});
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/journal-callbacks.test.ts --root daemon-v2`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/journal-callbacks.ts daemon-v2/src/journal-callbacks.test.ts
git commit -m "feat(journal): handlers de callbacks jnl:*"
```

---

### Task 11: Wiring en index.ts (captura, modo y callbacks)

**Files:**
- Modify: `daemon-v2/src/index.ts`

- [ ] **Step 1: Agregar imports y la instancia del store**

Después del import de `./tools/resumir.js` (línea 22), agregá:

```typescript
import { JournalStore } from "./journal-store.js";
import { captureThought } from "./journal-capture.js";
import { applyPendingEdit, handleJournalCallback, isJournalCallback } from "./journal-callbacks.js";
import { parseJournalPrefix } from "./journal-text.js";
import { renderModeClosed, renderModeOpen } from "./journal-card.js";
```

Después de la declaración de `const kv = ...` (buscala con `grep -n "^const kv" daemon-v2/src/index.ts`), agregá:

```typescript
const journalStore = new JournalStore(kv);
```

- [ ] **Step 2: Interceptar los callbacks `jnl:` antes que el resto**

Dentro del bloque `if (payload.callback_query) {`, inmediatamente **antes** del `if (cb.data === "j:resu:save" ...)`, insertá:

```typescript
    // Callbacks del Journal (jnl:*) → mecánicos, sin LLM. Escriben en Notion, así que
    // llevan el mismo lock anti-doble-tap que mlog:/mskip:/msel:.
    if (isJournalCallback(cb.data)) {
      const jchat = cb.message.chat.id;
      const janchor = cb.message.message_id;

      // jnl:mode:close — cierra el modo journal y resume la tanda.
      if (cb.data === "jnl:mode:close") {
        await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id).catch(() => {});
        const mode = await journalStore.getMode(jchat);
        await journalStore.closeMode(jchat);
        const card = renderModeClosed(mode?.guardadas ?? 0, mode?.pendientes ?? 0);
        await editMessage(env.COS_TELEGRAM_BOT_TOKEN, jchat, janchor, card.text, "HTML", card.keyboard).catch(() => {});
        return;
      }

      const lockUserId = cb.from.id;
      const acquired = await tryAcquireLock(kv, jchat, lockUserId, MEETING_FLOW_LOCK_TTL_SEC);
      if (!acquired) {
        await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id, "⏳ Todavía estoy procesando tu toque anterior...").catch(() => {});
        return;
      }
      await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id).catch(() => {});
      // Fire-and-forget por el mismo motivo que resu-pick:: escribir en Notion vía `ntn`
      // puede tardar segundos y el loop principal del daemon es secuencial.
      void handleJournalCallback(
        { botToken: env.COS_TELEGRAM_BOT_TOKEN, store: journalStore, log },
        jchat,
        janchor,
        cb.data!,
      )
        .catch((err) => log({ msg: "journal_callback_error", err: String(err) }))
        .finally(() => releaseLock(kv, jchat, lockUserId).catch(() => {}));
      return;
    }
```

- [ ] **Step 3: Interceptar la captura antes del LLM**

Justo **después** del bloque `/menu` (el `if (text && ["/menu", "menu", ...])`) y **antes** de `// Typing indicator + placeholder en <1s`, insertá:

```typescript
  // ---- Captura del Journal (mecánica, ANTES del LLM) ----
  // Dos entradas: prefijo `journal:`/`diario:` o modo journal abierto.
  // El texto se persiste sin pasar por el modelo (ver spec, sección 2).
  {
    // Una edición pendiente (botón ✏️) gana sobre todo lo demás: el próximo texto
    // es el título nuevo, no un pensamiento nuevo — incluso con el modo abierto.
    if (text) {
      const consumido = await applyPendingEdit(
        { botToken: env.COS_TELEGRAM_BOT_TOKEN, store: journalStore, log },
        chatId,
        text,
      );
      if (consumido) return;
    }

    const journalMode = await journalStore.getMode(chatId);
    let journalTexto: string | null = null;
    let journalOrigen: "Texto" | "Voz" | "Sesión terapia" = "Texto";

    if (text) {
      const prefijado = parseJournalPrefix(text);
      if (prefijado) {
        journalTexto = prefijado;
      } else if (journalMode) {
        journalTexto = text;
        journalOrigen = journalMode.origen;
      }
    } else if (voice && journalMode) {
      const transcript = await processVoice(env.COS_TELEGRAM_BOT_TOKEN, voice.file_id);
      if (!transcript) {
        await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, {
          chatId,
          text: "⚠️ <b>No pude transcribir el audio</b>\nReintenta o escribilo, por favor.",
          parseMode: "HTML",
        }).catch(() => {});
        return;
      }
      journalTexto = transcript;
      journalOrigen = journalMode.origen === "Sesión terapia" ? "Sesión terapia" : "Voz";
      await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, {
        chatId,
        text: `🎤 <i>"${escapeHtml(transcript)}"</i>`,
        parseMode: "HTML",
        replyToMessageId: m.message_id,
      }).catch(() => {});
    }

    if (journalTexto) {
      const res = await captureThought(
        { botToken: env.COS_TELEGRAM_BOT_TOKEN, store: journalStore, log },
        chatId,
        journalTexto,
        journalOrigen,
      );
      if (journalMode && res.guardada) {
        await journalStore.bumpMode(chatId, {
          guardadas: 1,
          pendientes: res.conReflexion ? 1 : 0,
        });
      }
      return;
    }
  }
```

- [ ] **Step 4: Abrir el modo desde el menú**

En el bloque de callbacks, junto a los handlers `j:star`/`j:ytpl`, agregá el handler del botón nuevo. Insertá **antes** del bloque `isMeetingFlowCallback`:

```typescript
    // 📓 Journal → abre el modo (mecánico, sin LLM).
    if (cb.data === "j:journal") {
      await answerCallbackQuery(env.COS_TELEGRAM_BOT_TOKEN, cb.id).catch(() => {});
      const jchat = cb.message.chat.id;
      const card = renderModeOpen();
      const anchor = await sendMessage(env.COS_TELEGRAM_BOT_TOKEN, {
        chatId: jchat,
        text: card.text,
        parseMode: "HTML",
        replyMarkup: card.keyboard,
      });
      await journalStore.openMode(jchat, {
        abiertoEn: Date.now(),
        anchorMessageId: anchor.message_id,
        origen: "Texto",
        guardadas: 0,
        pendientes: 0,
      });
      return;
    }
```

- [ ] **Step 5: Typecheck y tests**

Run: `npm run typecheck -w @cos/daemon && npm run test -w @cos/daemon`
Expected: sin errores de tipos; toda la suite en verde.

Si `escapeHtml`, `processVoice`, `editMessage` o `sendMessage` dan "not defined", verificá que ya estén importados arriba en `index.ts` — todos existen; `grep -n "escapeHtml\|processVoice" daemon-v2/src/index.ts` lo confirma.

- [ ] **Step 6: Commit**

```bash
git add daemon-v2/src/index.ts
git commit -m "feat(journal): wiring de captura, modo y callbacks en el daemon"
```

---

### Task 12: Botón del menú y routing del worker

**Files:**
- Modify: `daemon-v2/src/menu.ts`
- Modify: `worker-v2/src/callback-router.ts`

- [ ] **Step 1: Agregar el botón al menú principal**

En `daemon-v2/src/menu.ts`, dentro de `buildMainMenu()`, reemplazá la última fila:

```typescript
        [
          { text: "📋 Estado del resumidor", callback_data: "j:estado" },
        ],
```

por:

```typescript
        [
          { text: "📓 Journal", callback_data: "j:journal" },
          { text: "📋 Estado del resumidor", callback_data: "j:estado" },
        ],
```

- [ ] **Step 2: Verificar que el worker no intercepte los callbacks del journal**

`isLightCallback` en `worker-v2/src/callback-router.ts` solo devuelve `true` para los prefijos de `LIGHT_PREFIXES` (`menu`, `t:d`, `t:c`, `t:s`, `t:sd`, `nav`). `jnl:*` y `j:journal` no están, así que ya caen al daemon como HEAVY por default.

Agregá un test que fije ese comportamiento para que nadie lo rompa después:

Create `worker-v2/src/callback-router.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isLightCallback } from "./callback-router.js";

describe("isLightCallback", () => {
  it("los callbacks del journal NO son light — escriben en Notion", () => {
    expect(isLightCallback("jnl:apply:ab12")).toBe(false);
    expect(isLightCallback("jnl:resonate:cd34")).toBe(false);
    expect(isLightCallback("jnl:mode:close")).toBe(false);
    expect(isLightCallback("j:journal")).toBe(false);
  });

  it("los de navegación siguen siendo light", () => {
    expect(isLightCallback("menu:health")).toBe(true);
    expect(isLightCallback("nav:main")).toBe(true);
  });
});
```

- [ ] **Step 3: Correr el test**

Run: `npx vitest run src/callback-router.test.ts --root worker-v2`
Expected: PASS — 2 tests.

Si vitest no está configurado en `worker-v2`, corré `npm i -D vitest -w @cos/worker` primero y agregá `"test": "vitest run"` a los scripts de `worker-v2/package.json`.

- [ ] **Step 4: Commit**

```bash
git add daemon-v2/src/menu.ts worker-v2/src/callback-router.test.ts worker-v2/package.json
git commit -m "feat(journal): botón de menú y test de routing del worker"
```

---

### Task 13: Barrido dominical

**Files:**
- Create: `daemon-v2/src/proactive/journal-sweep.ts`
- Test: `daemon-v2/src/proactive/journal-sweep.test.ts`
- Modify: `daemon-v2/src/index.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, it, expect } from "vitest";
import { sevenDaysAgo, sweepDedupKey } from "./journal-sweep.js";

describe("sevenDaysAgo", () => {
  it("devuelve la fecha ISO de hace 7 días en hora de La Paz", () => {
    expect(sevenDaysAgo(new Date("2026-07-27T23:00:00.000Z"))).toBe("2026-07-20T19:00:00-04:00");
  });
});

describe("sweepDedupKey", () => {
  it("usa el domingo como clave para no repetir el aviso esa semana", () => {
    expect(sweepDedupKey(new Date("2026-07-26T23:00:00.000Z"))).toBe("jano:journal:sweep:2026-07-26");
  });

  it("dos corridas del mismo día comparten clave", () => {
    expect(sweepDedupKey(new Date("2026-07-26T23:00:00.000Z"))).toBe(
      sweepDedupKey(new Date("2026-07-26T23:59:00.000Z")),
    );
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/proactive/journal-sweep.test.ts --root daemon-v2`
Expected: FAIL — `Failed to resolve import "./journal-sweep.js"`

- [ ] **Step 3: Implementar**

```typescript
// proactive/journal-sweep.ts — barrido dominical de entradas `Sin revisar`.
// Tercera excepción a la arquitectura reactiva de Jano (decisión de Cal, 2026-07-27).

import { sendMessage } from "@cos/shared";
import type { CfKv } from "../cf-kv.js";
import { renderSweepSelector } from "../journal-card.js";
import { nowInLaPaz } from "../journal-capture.js";
import { queryUnreviewed } from "../tools/journal.js";

const DEDUP_TTL_SEC = 7 * 24 * 60 * 60;

export function sevenDaysAgo(now: Date = new Date()): string {
  return nowInLaPaz(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
}

export function sweepDedupKey(now: Date = new Date()): string {
  return `jano:journal:sweep:${nowInLaPaz(now).slice(0, 10)}`;
}

export interface SweepOpts {
  kv: CfKv;
  botToken: string;
  chatId: number;
  log: (obj: Record<string, unknown>) => void;
}

export async function checkJournalSweep(opts: SweepOpts): Promise<void> {
  const { kv, botToken, chatId, log } = opts;
  const dedupKey = sweepDedupKey();

  try {
    if (await kv.get<boolean>(dedupKey)) return;

    const pendientes = queryUnreviewed(sevenDaysAgo());
    if (pendientes.length === 0) {
      await kv.set(dedupKey, true, DEDUP_TTL_SEC);
      log({ msg: "journal_sweep_empty" });
      return;
    }

    const card = renderSweepSelector(pendientes);
    await sendMessage(botToken, {
      chatId,
      text: card.text,
      parseMode: "HTML",
      replyMarkup: card.keyboard,
    });
    await kv.set(dedupKey, true, DEDUP_TTL_SEC);
    log({ msg: "journal_sweep_sent", pendientes: pendientes.length });
  } catch (err) {
    // Mismo criterio que health-sync-check: no dejar escapar la excepción,
    // el caller la invoca con `void` desde un callback de cron.
    log({ msg: "journal_sweep_error", err: String(err) });
  }
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/proactive/journal-sweep.test.ts --root daemon-v2`
Expected: PASS — 3 tests.

- [ ] **Step 5: Registrar el cron en index.ts**

Agregá el import junto a los otros de `proactive/`:

```typescript
import { checkJournalSweep } from "./proactive/journal-sweep.js";
```

Después de la función `scheduleHealthSyncCheck()` (línea ~1079), agregá:

```typescript
function scheduleJournalSweep(): void {
  // Domingos 19:00 hora La Paz. Tercera excepción a la arquitectura reactiva
  // (decisión de Cal, 2026-07-27 — ver CLAUDE.md, "Automatización — dos capas").
  cron.schedule("0 19 * * 0", () => {
    void checkJournalSweep({
      kv,
      botToken: env.COS_TELEGRAM_BOT_TOKEN,
      chatId: ALERT_CHAT_ID,
      log,
    });
  }, { timezone: "America/La_Paz" });
  log({ msg: "journal_sweep_scheduled" });
}
```

Y dentro de `loop()`, junto a `scheduleHealthSyncCheck();`:

```typescript
  scheduleJournalSweep();
```

- [ ] **Step 6: Manejar el selector del barrido en los callbacks**

En `daemon-v2/src/journal-callbacks.ts`, dentro de `handleJournalCallback`, agregá este bloque justo **después** del bloque `if (accion === "undo")`:

```typescript
  // Selector del barrido dominical: jnl:sweep:{entryId|all|none}
  if (accion === "sweep") {
    if (shortId === "none") {
      await editMessage(deps.botToken, chatId, messageId, "👍 Los dejo para la próxima.", "HTML", { inline_keyboard: [] }).catch(() => {});
      return true;
    }
    const ids = shortId === "all"
      ? queryUnreviewed(sevenDaysAgoIso()).map((e) => e.id)
      : [shortId];
    if (ids.length === 0) {
      await editMessage(deps.botToken, chatId, messageId, "✅ No quedó nada sin destilar.", "HTML", { inline_keyboard: [] }).catch(() => {});
      return true;
    }
    await editMessage(deps.botToken, chatId, messageId, `📓 Reviso ${ids.length === 1 ? "el pensamiento" : `los ${ids.length} pensamientos`}...`, "HTML", { inline_keyboard: [] }).catch(() => {});
    for (const id of ids) {
      const entry = getEntry(id);
      if (!entry) continue;
      await reopenCheckpoint(deps, chatId, id, entry);
    }
    return true;
  }
```

Ajustá los imports de `journal-callbacks.ts` — **fusionalos con los que ya existen**, no agregues un segundo `import` del mismo módulo:

```typescript
// era: import { answerCallbackQuery, editMessage } from "@cos/shared";
import { answerCallbackQuery, editMessage, sendMessage } from "@cos/shared";

// era: import { applyMetadata, archiveResonateEntry, clearMetadata, createResonateEntry, fetchBigThemesIndex, setEstado } from "./tools/journal.js";
import {
  applyMetadata,
  archiveResonateEntry,
  clearMetadata,
  createResonateEntry,
  fetchBigThemesIndex,
  fetchTopicsIndex,
  getEntry,
  queryUnreviewed,
  setEstado,
} from "./tools/journal.js";

// nuevos
import { sevenDaysAgo as sevenDaysAgoIso } from "./proactive/journal-sweep.js";
import { buildMetaProposal } from "./journal-capture.js";
import { enrichEntry } from "./journal-enrich.js";
```

Y la función auxiliar, al final del archivo:

```typescript
/** Re-corre el enriquecimiento sobre una entrada vieja y manda su tarjeta. */
async function reopenCheckpoint(
  deps: JournalCallbackDeps,
  chatId: number,
  entryId: string,
  entry: { titulo: string; fecha: string; texto: string },
): Promise<void> {
  const topicIndex = fetchTopicsIndex();
  const themeIndex = fetchBigThemesIndex();
  const enrich = await enrichEntry(
    entry.texto,
    [...topicIndex.values()].map((t) => t.name),
    [...themeIndex.values()].map((t) => t.name),
  ).catch(() => null);
  if (!enrich) {
    deps.log({ msg: "journal_sweep_enrich_failed", entryId });
    return;
  }
  const anchor = await sendMessage(deps.botToken, {
    chatId,
    text: "📓 <i>Revisando...</i>",
    parseMode: "HTML",
  });
  const proposal = buildMetaProposal({
    entryId,
    enrich,
    topicIndex,
    themeIndex,
    fechaHora: entry.fecha,
    textoCrudo: entry.texto,
    messageId: anchor.message_id,
  });
  const shortId = await deps.store.createProposal(chatId, proposal);
  const card = renderMetaCard(proposal, shortId);
  await editMessage(deps.botToken, chatId, anchor.message_id, card.text, "HTML", card.keyboard).catch(() => {});
}
```

- [ ] **Step 7: Typecheck y suite completa**

Run: `npm run typecheck -w @cos/daemon && npm run test -w @cos/daemon`
Expected: sin errores; toda la suite en verde.

- [ ] **Step 8: Commit**

```bash
git add daemon-v2/src/proactive/journal-sweep.ts daemon-v2/src/proactive/journal-sweep.test.ts daemon-v2/src/journal-callbacks.ts daemon-v2/src/index.ts
git commit -m "feat(journal): barrido dominical de entradas sin destilar"
```

---

### Task 14: Tool de consulta y system prompt

**Files:**
- Modify: `daemon-v2/src/agent-tools.ts`
- Modify: `daemon-v2/src/system-prompt.ts`
- Modify: `daemon-v2/src/agent.ts`

- [ ] **Step 1: Agregar la tool de lectura**

En `daemon-v2/src/agent-tools.ts`, dentro de `buildSdkTools`, agregá (seguí el formato exacto de las tools vecinas — mirá `getFocoCalStatus` como referencia con `grep -n "getFocoCalStatus" daemon-v2/src/agent-tools.ts`):

```typescript
    tool(
      "consultarJournal",
      "Lee entradas del Journal de reflexión de Cal (DB Notion bajo Mental Health). Úsalo cuando Cal pregunte cómo estuvo su semana, de qué viene hablando, qué ánimo predominó, o quiera repasar sus pensamientos. SOLO LECTURA: para guardar un pensamiento, Cal usa el prefijo 'journal:' o el modo journal — no hay tool de escritura.",
      {
        desde: z.string().describe("Fecha ISO desde la que leer, ej. '2026-07-01'."),
        soloSinRevisar: z.boolean().optional().describe("Si es true, solo las entradas que todavía no se destilaron."),
      },
      async (args) => {
        const filtros: unknown[] = [
          { property: "Fecha y hora", date: { on_or_after: args.desde } },
        ];
        if (args.soloSinRevisar) {
          filtros.push({ property: "Estado", select: { equals: "Sin revisar" } });
        }
        const res = notionApi("POST", `/v1/databases/${JOURNAL_DB_ID}/query`, {
          filter: { and: filtros },
          sorts: [{ property: "Fecha y hora", direction: "descending" }],
          page_size: 50,
        });
        return { content: [{ type: "text", text: JSON.stringify(res).slice(0, 20000) }] };
      },
    ),
```

Y los imports que necesita, arriba del archivo:

```typescript
import { JOURNAL_DB_ID } from "./journal-ids.js";
```

(`notionApi` ya está importado en `agent-tools.ts` — verificalo con `grep -n "notionApi" daemon-v2/src/agent-tools.ts`; si no está, agregá `import { notionApi } from "./tools/notion-cli.js";`.)

- [ ] **Step 2: Agregar el mensaje de progreso**

En `daemon-v2/src/agent.ts`, dentro de `TOOL_MESSAGES`:

```typescript
  "mcp__cos-tools__consultarJournal": "📓 Leyendo tu journal...",
```

- [ ] **Step 3: Documentar el journal en el system prompt**

En `daemon-v2/src/system-prompt.ts`, agregá una sección nueva:

```
## Journal de reflexión (terapia)

Cal tiene un journal en Notion (DB "Journal", bajo la página Mental Health) donde
descarga pensamientos tal cual, con fecha y hora.

- **Guardar NO es tu trabajo.** Cal guarda con el prefijo `journal:` / `diario:` o con
  el modo journal del menú. Ese camino es mecánico y no pasa por vos. Si Cal te dice
  "guardá esto en el journal", explicale que use el prefijo o el botón 📓 Journal.
- **Leer sí:** usá `mcp__cos-tools__consultarJournal` cuando Cal pregunte cómo estuvo
  su semana, qué ánimo predominó, de qué viene hablando, o quiera repasar. Devuelve
  las filas crudas de Notion; resumilas vos en lenguaje natural.
- Las reflexiones destiladas viven en la DB "Resonate Calendar" con
  `Type: Reflexion` y `Tags: Terapia`. El puente entre ambas es la propiedad `Journal`.
- **Nunca reescribas ni corrijas** el texto de un pensamiento al citarlo. Es material
  de terapia: se lee literal.
```

- [ ] **Step 4: Typecheck, tests y snapshot**

Run: `npm run typecheck -w @cos/daemon && npm run test -w @cos/daemon`
Expected: sin errores de tipos.

Si hay un snapshot test de la lista de tools (buscalo con `grep -rn "buildSdkTools" daemon-v2/src/*.test.ts`), agregá `"consultarJournal"` al array en orden alfabético y volvé a correr.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/agent-tools.ts daemon-v2/src/agent.ts daemon-v2/src/system-prompt.ts
git commit -m "feat(journal): tool de consulta y documentación en el system prompt"
```

---

### Task 15: Review, build y prueba end-to-end

**Files:**
- Modify: `daemon-v2/CLAUDE.md` no; `CLAUDE.md` (raíz del repo Jano)

- [ ] **Step 1: Correr el review de daemon**

Se editaron `index.ts`, `agent-tools.ts`, `agent.ts` y `system-prompt.ts` — la regla del repo obliga a pasar por el subagent `daemon-health-reviewer`.

Lanzá el subagent `daemon-health-reviewer` con este scope: *"Revisá los cambios del sistema de Journal (commits desde la Task 1 de docs/superpowers/plans/2026-07-27-journal-terapia-notion.md). Solo revisión, no modifiques nada — devolvé hallazgos agrupados en blocking / warning / info."*

Resolvé todo lo que marque como **blocking** antes de seguir.

- [ ] **Step 2: Build**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/shared run build && npm -w @cos/daemon run build
```

Expected: ambos builds sin errores.

- [ ] **Step 3: Deploy del worker**

```bash
cd worker-v2 && npx wrangler deploy
```

Expected: deploy exitoso. (No hubo cambios de lógica en el worker, pero el test nuevo fija su comportamiento; deployá igual para que quede la versión en sync.)

- [ ] **Step 4: Restart del daemon**

**Pedile a Cal que corra esto** — el clasificador bloquea `launchctl` en sesión interactiva (ver memoria `classifier-bloquea-launchctl-y-escrituras-boa`). Sugerile que lo pegue con el prefijo `!`:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
```

- [ ] **Step 5: Confirmar que el cron arrancó**

```bash
grep -E "journal_sweep_scheduled" ~/Library/Logs/cos-agent-v2.out.log | tail -3
```

Expected: al menos una línea con `"msg":"journal_sweep_scheduled"`.

- [ ] **Step 6: Prueba end-to-end con Cal**

Pedile a Cal que mande por Telegram:

```
journal: prueba del sistema nuevo, esto es una entrada de descarte
```

Verificá que:
1. Llega la tarjeta con los 4 campos propuestos y los 6 botones.
2. Los pickers de Ánimo, Topics y Big Theme editan el **mismo** mensaje (no crean uno nuevo).
3. `✅ Aplicar` escribe en Notion y aparece `↩️ Deshacer`.
4. La fila existe en la DB Journal con el texto **completo** en el cuerpo:

```bash
ntn api -X POST /v1/databases/$(grep JOURNAL_DB_ID daemon-v2/src/journal-ids.ts | grep -oE '"[0-9a-f-]{36}"' | tr -d '"')/query \
  --notion-version 2022-06-28 -d '{"page_size":1,"sorts":[{"property":"Fecha y hora","direction":"descending"}]}' \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
r=d['results'][0]
p=r['properties']
print('id:', r['id'])
print('titulo:', ''.join(x['plain_text'] for x in p['Pensamiento']['title']))
print('estado:', p['Estado']['select'])
print('animo:', p['Ánimo']['select'])
print('topics:', len(p['Topics']['relation']))
"
```

- [ ] **Step 7: Borrar la entrada de prueba**

⚠️ **Mostrale a Cal el `id` y el título exactos de la entrada de prueba y pedile autorización explícita antes de ejecutar el borrado.** Regla dura del repo — nunca borrar sin el "sí".

Con su autorización:

```bash
ntn api -X PATCH /v1/pages/<ID_DE_LA_ENTRADA> --notion-version 2022-06-28 -d '{"in_trash": true}'
```

- [ ] **Step 8: Documentar en CLAUDE.md**

Agregá a `CLAUDE.md` (raíz de Jano):

En el **índice de tools**, dentro de "Custom (`cos-tools`)": `· consultarJournal (leer el Journal de reflexión)`.

En la sección **"Automatización — dos capas"**, dentro de la lista de crons internos:

```
- `scheduleJournalSweep()` — **ACTIVO 2026-07-27** (pedido de Cal). Cron `0 19 * * 0`
  (domingos 19:00 La Paz), mecánico salvo el enriquecimiento — junta las entradas
  `Sin revisar` de los últimos 7 días de la DB Journal y manda un selector para
  destilarlas a Resonate Calendar. Dedup en CF KV (TTL 7 días). **Tercera excepción**
  a la arquitectura reactiva decidida el 2026-07-14.
```

Y actualizá el "Estado real" de esa sección: pasan a ser **3 proactivos internos activos**.

Agregá también una sección corta del sistema:

```
## Journal de reflexión (terapia)

DB `Journal` en Notion (bajo *Mental Health*) para captura cruda con fecha y hora, con
puente a Resonate Calendar. Diseño completo:
`docs/superpowers/specs/2026-07-27-journal-terapia-notion-design.md`.

- **Captura mecánica, sin LLM:** prefijo `journal:`/`diario:` o modo journal (botón
  📓 del menú, TTL 2h en KV). El texto se persiste ANTES de que el modelo lo vea —
  por eso "Jano escribe tal cual" es literal. El texto va al **cuerpo** de la página,
  no a una propiedad: `rich_text` corta a 2000 chars y una descarga de voz larga
  perdería texto en silencio.
- **Metadata en un segundo paso** (Haiku, sin tools, patrón `compact.ts`) → tarjeta
  `propose → botones` copiada de Pecunia. Si ese paso falla, la entrada ya está a salvo.
- **Callbacks `jnl:*` son todos HEAVY** (escriben en Notion) con lock anti-doble-tap.
- **Gotcha del modo journal:** mientras está abierto intercepta TODOS los mensajes del
  chat, incluidos los que eran pedidos normales. Mitigado con el TTL de 2h y el mensaje
  ancla visible, no eliminado.
```

- [ ] **Step 9: Commit final**

```bash
git add CLAUDE.md
git commit -m "docs(journal): documentar el sistema de journal en CLAUDE.md"
```

---

## Verificación final

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm run typecheck -w @cos/daemon
npm run test -w @cos/daemon
npm -w @cos/shared run build && npm -w @cos/daemon run build
```

Los tres en verde y la prueba end-to-end de la Task 15 confirmada por Cal = listo.
