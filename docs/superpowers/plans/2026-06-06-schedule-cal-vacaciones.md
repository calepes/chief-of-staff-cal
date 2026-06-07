# Schedule CAL Vacaciones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exponer `listVacaciones` y `getVacacionDetail` en Jano y Vesta para consultar la BD Schedule CAL de Notion vía el CLI `ntn`.

**Architecture:** `callNtn` se extrae de `books.ts` a un módulo compartido (`mcp-servers/shared/ntn.ts`) copiado manualmente a cada daemon. `schedule-cal.ts` usa `callNtn` para consultar la data source `f66c31e7-a4c1-4b6e-9f65-c28ecaf50ce3` con el filtro `Tipo contains "Vacaciones"`, y formatea HTML para Telegram.

**Tech Stack:** TypeScript, Node.js `spawnSync`, `ntn` CLI en `/opt/homebrew/bin/ntn`, Vitest para tests, Claude Agent SDK `tool()`.

---

## File Map

| Acción | Archivo |
|--------|---------|
| Crear | `Personal/MCP Servers/mcp-servers/shared/ntn.ts` |
| Crear | `Personal/Agents/Jano/daemon-v2/src/shared/ntn.ts` (copia) |
| Modificar | `Personal/Agents/Jano/daemon-v2/src/tools/books.ts` (import desde shared) |
| Crear | `Personal/Agents/Vesta/daemon-v2/src/shared/ntn.ts` (copia) |
| Crear | `Personal/Agents/Jano/daemon-v2/src/tools/schedule-cal.ts` |
| Crear | `Personal/Agents/Jano/daemon-v2/src/tools/schedule-cal.test.ts` |
| Modificar | `Personal/Agents/Jano/daemon-v2/src/agent-tools.ts` (agregar imports + tools) |
| Modificar | `Personal/Agents/Jano/daemon-v2/src/agent.ts` (agregar TOOL_MESSAGES) |
| Crear | `Personal/Agents/Vesta/daemon-v2/src/tools/schedule-cal.ts` (copia de Jano) |
| Modificar | `Personal/Agents/Vesta/daemon-v2/src/agent-tools.ts` (agregar imports + tools) |
| Modificar | `Personal/Agents/Vesta/daemon-v2/src/agent.ts` (agregar TOOL_MESSAGES) |

---

## Task 1: Crear módulo compartido `ntn.ts`

**Files:**
- Create: `Personal/MCP Servers/mcp-servers/shared/ntn.ts`
- Create: `Personal/Agents/Jano/daemon-v2/src/shared/ntn.ts`
- Create: `Personal/Agents/Vesta/daemon-v2/src/shared/ntn.ts`

- [ ] **Step 1: Crear `mcp-servers/shared/ntn.ts`**

```typescript
// ~/Claude Projects/Personal/MCP Servers/mcp-servers/shared/ntn.ts
import { spawnSync } from "node:child_process";

export const NTN_BIN = "/opt/homebrew/bin/ntn";

export interface NtnResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export function callNtn(
  path: string,
  opts: { method?: "POST" | "PATCH" | "DELETE"; body?: unknown } = {}
): NtnResult {
  const args = ["api"];
  if (opts.method) args.push("-X", opts.method);
  args.push(path);
  if (opts.body !== undefined) args.push("-d", JSON.stringify(opts.body));

  const result = spawnSync(NTN_BIN, args, { encoding: "utf8", timeout: 15_000 });

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

- [ ] **Step 2: Copiar a `Jano/daemon-v2/src/shared/ntn.ts`**

Contenido idéntico al de mcp-servers/shared/ntn.ts (misma licencia/mismos exports).

- [ ] **Step 3: Copiar a `Vesta/daemon-v2/src/shared/ntn.ts`**

Contenido idéntico.

- [ ] **Step 4: Commit**

```bash
cd ~/Claude\ Projects
git -C "Personal/MCP Servers/mcp-servers" add shared/ntn.ts
git -C "Personal/Agents/Jano" add daemon-v2/src/shared/ntn.ts
git -C "Personal/Agents/Vesta" add daemon-v2/src/shared/ntn.ts
# (commits separados por repo si tienen git propio, o como convenga)
```

---

## Task 2: Refactorizar `books.ts` para importar `callNtn` desde shared

**Files:**
- Modify: `Personal/Agents/Jano/daemon-v2/src/tools/books.ts`

- [ ] **Step 1: Agregar import al inicio de `books.ts`**

En la línea 1, antes de cualquier otro código, agregar:

```typescript
import { callNtn, NTN_BIN } from "../shared/ntn.js";
```

- [ ] **Step 2: Eliminar la definición local de `NTN_BIN` y `callNtn`**

Eliminar de `books.ts` las líneas:

```typescript
import { spawnSync } from "node:child_process";

const NTN_BIN = "/opt/homebrew/bin/ntn";
```

Y eliminar la función completa:

```typescript
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

> Nota: `callNtn` era `export function` en books.ts pero otros archivos no la importan de ahí — solo se usa internamente. `NTN_BIN` tampoco se importa desde fuera. La única regresión posible es si algún test mockea `books.callNtn`; verificar en step siguiente.

- [ ] **Step 3: Correr tests de books para verificar no-regresión**

```bash
cd ~/Claude\ Projects/Personal/Agents/Jano
npm run test -- --reporter=verbose 2>&1 | head -60
```

Expected: todos los tests de `books.test.ts` pasan (o los que pasaban antes siguen pasando).

- [ ] **Step 4: Commit**

```bash
# en el repo de Jano
git add daemon-v2/src/tools/books.ts daemon-v2/src/shared/ntn.ts
git commit -m "refactor: extract callNtn to shared/ntn.ts"
```

---

## Task 3: Crear `schedule-cal.ts` con tests en Jano

**Files:**
- Create: `Personal/Agents/Jano/daemon-v2/src/tools/schedule-cal.ts`
- Create: `Personal/Agents/Jano/daemon-v2/src/tools/schedule-cal.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `Personal/Agents/Jano/daemon-v2/src/tools/schedule-cal.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseVacacion } from "./schedule-cal.js";

function makePage(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-page-id",
    url: "https://notion.so/test",
    properties: {
      Name: { title: [{ plain_text: "Vacaciones Lima" }] },
      "Fecha ": { date: { start: "2025-07-15", end: "2025-07-22" } },
      Status: { select: { name: "Not started" } },
      Clase: { select: { name: "Viaje" } },
      Tipo: { multi_select: [{ name: "Vacaciones" }, { name: "Internacional" }] },
      "Año Vacaciones": { select: { name: "2025 - 2026" } },
      " D. Vacas": { rollup: { type: "number", number: 7 } },
      Pais: { rollup: { type: "array", array: [{ select: { name: "Perú" } }] } },
      "Ppto US$": { formula: { type: "number", number: 580 } },
      "Registro Vacaciones": { checkbox: true },
      ...overrides,
    },
  };
}

describe("parseVacacion", () => {
  it("extrae name correctamente", () => {
    expect(parseVacacion(makePage()).name).toBe("Vacaciones Lima");
  });

  it("extrae pageId y url", () => {
    const r = parseVacacion(makePage());
    expect(r.pageId).toBe("test-page-id");
    expect(r.url).toBe("https://notion.so/test");
  });

  it("extrae fecha con rango", () => {
    const r = parseVacacion(makePage());
    expect(r.fecha?.start).toBe("2025-07-15");
    expect(r.fecha?.end).toBe("2025-07-22");
  });

  it("extrae status y clase", () => {
    const r = parseVacacion(makePage());
    expect(r.status).toBe("Not started");
    expect(r.clase).toBe("Viaje");
  });

  it("extrae tipo como array de strings", () => {
    expect(parseVacacion(makePage()).tipo).toEqual(["Vacaciones", "Internacional"]);
  });

  it("extrae anoVacaciones", () => {
    expect(parseVacacion(makePage()).anoVacaciones).toBe("2025 - 2026");
  });

  it("extrae diasVacas del rollup number", () => {
    expect(parseVacacion(makePage()).diasVacas).toBe(7);
  });

  it("extrae pais del rollup array", () => {
    expect(parseVacacion(makePage()).pais).toBe("Perú");
  });

  it("extrae pptoUsd de formula", () => {
    expect(parseVacacion(makePage()).pptoUsd).toBe(580);
  });

  it("extrae registroVacaciones checkbox", () => {
    expect(parseVacacion(makePage()).registroVacaciones).toBe(true);
  });

  it("maneja fecha null → undefined", () => {
    const r = parseVacacion(makePage({ "Fecha ": { date: null } }));
    expect(r.fecha).toBeUndefined();
  });

  it("maneja rollup de dias con null → undefined", () => {
    const r = parseVacacion(
      makePage({ " D. Vacas": { rollup: { type: "number", number: null } } })
    );
    expect(r.diasVacas).toBeUndefined();
  });

  it("maneja pais vacío en rollup array → undefined", () => {
    const r = parseVacacion(
      makePage({ Pais: { rollup: { type: "array", array: [] } } })
    );
    expect(r.pais).toBeUndefined();
  });
});
```

- [ ] **Step 2: Correr test para verificar que falla**

```bash
cd ~/Claude\ Projects/Personal/Agents/Jano
npm run test -- src/tools/schedule-cal.test.ts 2>&1 | head -20
```

Expected: FAIL — `Cannot find module './schedule-cal.js'`

- [ ] **Step 3: Crear `schedule-cal.ts`**

Crear `Personal/Agents/Jano/daemon-v2/src/tools/schedule-cal.ts`:

```typescript
import { callNtn } from "../shared/ntn.js";

export const SCHEDULE_CAL_DS = "f66c31e7-a4c1-4b6e-9f65-c28ecaf50ce3";

export interface VacacionEntry {
  pageId: string;
  url: string;
  name: string;
  fecha?: { start: string; end?: string };
  status?: string;
  clase?: string;
  tipo?: string[];
  anoVacaciones?: string;
  diasVacas?: number;
  pais?: string;
  pptoUsd?: number;
  registroVacaciones?: boolean;
}

export interface VacacionDetail extends VacacionEntry {
  blocks?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function prop(page: any, name: string): any {
  return page?.properties?.[name];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseVacacion(page: any): VacacionEntry {
  const name = prop(page, "Name")?.title?.[0]?.plain_text ?? "(sin nombre)";

  const fechaRaw = prop(page, "Fecha ")?.date ?? null;
  const fecha = fechaRaw
    ? { start: fechaRaw.start as string, end: (fechaRaw.end ?? undefined) as string | undefined }
    : undefined;

  const status: string | undefined = prop(page, "Status")?.select?.name ?? undefined;
  const clase: string | undefined = prop(page, "Clase")?.select?.name ?? undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tipoArr: any[] = prop(page, "Tipo")?.multi_select ?? [];
  const tipo: string[] = tipoArr.map((t: { name: string }) => t.name);

  const anoVacaciones: string | undefined =
    prop(page, "Año Vacaciones")?.select?.name ?? undefined;

  // Nota: propiedad tiene espacio inicial — " D. Vacas"
  const diasVacasRaw = prop(page, " D. Vacas");
  const diasVacas: number | undefined =
    diasVacasRaw?.rollup?.type === "number" && diasVacasRaw.rollup.number != null
      ? (diasVacasRaw.rollup.number as number)
      : undefined;

  // Pais es rollup show_original de la relación Ciudad → array de selects
  const paisRaw = prop(page, "Pais");
  let pais: string | undefined;
  if (paisRaw?.rollup?.type === "array") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arr: any[] = paisRaw.rollup.array ?? [];
    const names = arr
      .flatMap((item: any) => (item?.select?.name ? [item.select.name as string] : []))
      .join(", ");
    pais = names || undefined;
  }

  const pptoRaw = prop(page, "Ppto US$");
  const pptoUsd: number | undefined =
    pptoRaw?.formula?.type === "number" && pptoRaw.formula.number != null
      ? (pptoRaw.formula.number as number)
      : undefined;

  const registroVacaciones: boolean | undefined =
    prop(page, "Registro Vacaciones")?.checkbox ?? undefined;

  return {
    pageId: page.id as string,
    url: page.url as string,
    name,
    fecha,
    status,
    clase,
    tipo: tipo.length > 0 ? tipo : undefined,
    anoVacaciones,
    diasVacas,
    pais,
    pptoUsd,
    registroVacaciones,
  };
}

function formatFechaRango(fecha?: { start: string; end?: string }): string {
  if (!fecha) return "";
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const fmt = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("es-ES", opts);
  return fecha.end ? `${fmt(fecha.start)} – ${fmt(fecha.end)}` : fmt(fecha.start);
}

function calcDias(fecha?: { start: string; end?: string }): number | undefined {
  if (!fecha?.end) return undefined;
  const ms = new Date(fecha.end).getTime() - new Date(fecha.start).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

function formatEntryHtml(v: VacacionEntry): string {
  const icon = v.clase === "Viaje" ? "✈️" : v.clase === "Hito" ? "🎯" : "🏖️";
  const lines: string[] = [`${icon} <b>${v.name}</b>`];

  if (v.fecha) {
    const rango = formatFechaRango(v.fecha);
    const dias = v.diasVacas ?? calcDias(v.fecha);
    lines.push(`📅 ${rango}${dias != null ? ` · ${dias} días` : ""}`);
  }

  const locParts: string[] = [];
  if (v.pais) locParts.push(`📍 ${v.pais}`);
  if (v.pptoUsd != null) locParts.push(`💰 $${v.pptoUsd}`);
  if (locParts.length > 0) lines.push(locParts.join(" · "));

  if (v.status) lines.push(`Estado: ${v.status}`);
  lines.push(`<a href="${v.url}">Ver en Notion →</a>`);

  return lines.join("\n");
}

export function listVacaciones(filters?: {
  year?: string;
  status?: "Not started" | "In progress" | "Done" | "Canceled";
}): string {
  const andFilters: unknown[] = [
    { property: "Tipo", multi_select: { contains: "Vacaciones" } },
  ];
  if (filters?.year) {
    andFilters.push({ property: "Año Vacaciones", select: { equals: filters.year } });
  }
  if (filters?.status) {
    andFilters.push({ property: "Status", select: { equals: filters.status } });
  }

  const body =
    andFilters.length === 1
      ? { filter: andFilters[0] }
      : { filter: { and: andFilters } };

  const res = callNtn(`v1/data_sources/${SCHEDULE_CAL_DS}/query`, { body });
  if (!res.ok) return `❌ Error consultando Schedule CAL: ${res.error}`;

  const data = res.data as { results?: unknown[] };
  const pages = data?.results ?? [];

  if (pages.length === 0) {
    const suffix = filters?.year ? ` para ${filters.year}` : "";
    return `🏖️ No se encontraron vacaciones${suffix}.`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries = pages.map((p) => parseVacacion(p as any));
  const yearLabel = filters?.year ? ` ${filters.year}` : "";
  const header = `🏖️ <b>Vacaciones${yearLabel}</b> (${entries.length} entrada${entries.length !== 1 ? "s" : ""})`;
  return `${header}\n\n${entries.map(formatEntryHtml).join("\n\n")}`;
}

export function getVacacionDetail(pageId: string): string {
  const pageRes = callNtn(`v1/pages/${pageId}`);
  if (!pageRes.ok) return `❌ Error leyendo página: ${pageRes.error}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entry = parseVacacion(pageRes.data as any);

  const blocksRes = callNtn(`v1/blocks/${pageId}/children`);
  let blocksText = "";
  if (blocksRes.ok) {
    const data = blocksRes.data as { results?: unknown[] };
    const lines: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const b of (data?.results ?? []) as any[]) {
      const type: string = b?.type ?? "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const richText: any[] = b?.[type]?.rich_text ?? b?.[type]?.text ?? [];
      const text = richText.map((rt: any) => (rt?.plain_text as string) ?? "").join("");
      if (!text.trim()) continue;
      const prefix =
        type === "bulleted_list_item" || type === "to_do"
          ? "• "
          : type === "numbered_list_item"
          ? "- "
          : "";
      lines.push(`${prefix}${text}`);
    }
    blocksText = lines.join("\n").slice(0, 3000);
  }

  const lines: string[] = [`📋 <b>${entry.name}</b>`, ""];
  if (entry.fecha) {
    const rango = formatFechaRango(entry.fecha);
    const dias = entry.diasVacas ?? calcDias(entry.fecha);
    lines.push(`📅 ${rango}${dias != null ? ` · ${dias} días` : ""}`);
  }
  if (entry.pais) lines.push(`📍 ${entry.pais}`);
  if (entry.pptoUsd != null) lines.push(`💰 Presupuesto: $${entry.pptoUsd}`);
  if (entry.registroVacaciones != null)
    lines.push(`✅ Registro vacaciones: ${entry.registroVacaciones ? "sí" : "no"}`);
  if (entry.anoVacaciones) lines.push(`Año: ${entry.anoVacaciones}`);
  if (blocksText) lines.push("", "<b>Notas:</b>", blocksText);

  return lines.join("\n");
}
```

- [ ] **Step 4: Correr tests para verificar que pasan**

```bash
cd ~/Claude\ Projects/Personal/Agents/Jano
npm run test -- src/tools/schedule-cal.test.ts --reporter=verbose 2>&1
```

Expected: 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/tools/schedule-cal.ts daemon-v2/src/tools/schedule-cal.test.ts
git commit -m "feat: add schedule-cal.ts with listVacaciones and getVacacionDetail"
```

---

## Task 4: Registrar tools en Jano (`agent-tools.ts` + `agent.ts`)

**Files:**
- Modify: `Personal/Agents/Jano/daemon-v2/src/agent-tools.ts`
- Modify: `Personal/Agents/Jano/daemon-v2/src/agent.ts`

- [ ] **Step 1: Agregar import en `agent-tools.ts`**

Después de la última línea de imports (cerca de la línea 78, después de `readwiseDeleteHighlight`), agregar:

```typescript
import {
  listVacaciones,
  getVacacionDetail,
} from "./tools/schedule-cal.js";
```

- [ ] **Step 2: Registrar las tools en `buildSdkTools`**

Al final del array `return [...]` en `buildSdkTools`, antes del `]` de cierre, agregar:

```typescript
    tool(
      "listVacaciones",
      "Consulta las vacaciones de Cal en Schedule CAL (Notion). Filtros opcionales: año (ej. '2025 - 2026'), status. Devuelve lista con nombre, fechas, días disponibles, país, presupuesto. Llamar cuando Cal pregunte por sus vacaciones, días disponibles, viajes planeados, o quiera revisar el plan de vacaciones.",
      {
        year: z.string().optional(),
        status: z.enum(["Not started", "In progress", "Done", "Canceled"]).optional(),
      },
      async (filters) => asText(listVacaciones(filters)),
      READ_ONLY,
    ),
    tool(
      "getVacacionDetail",
      "Obtiene detalle completo de una entrada de vacaciones en Schedule CAL: propiedades + contenido de la página (notas, itinerario, checklist). Llamar cuando Cal pregunte por el contenido específico de unas vacaciones, quiera ver el itinerario, o cuando listVacaciones no tenga suficiente detalle.",
      { pageId: z.string() },
      async ({ pageId }) => asText(getVacacionDetail(pageId)),
      READ_ONLY,
    ),
```

- [ ] **Step 3: Agregar TOOL_MESSAGES en `agent.ts`**

En el objeto `TOOL_MESSAGES` de `agent.ts` (alrededor de la línea 103, después de la entrada de `setBookCover`), agregar:

```typescript
  // Schedule CAL — Vacaciones
  "mcp__cos-tools__listVacaciones":     "🏖️ Consultando vacaciones...",
  "mcp__cos-tools__getVacacionDetail":  "📋 Leyendo detalle de vacaciones...",
```

- [ ] **Step 4: Commit**

```bash
git add daemon-v2/src/agent-tools.ts daemon-v2/src/agent.ts
git commit -m "feat: register listVacaciones and getVacacionDetail tools in Jano"
```

---

## Task 5: Build y restart Jano

**Files:** (ninguno — solo build)

- [ ] **Step 1: Correr build completo de Jano**

```bash
cd ~/Claude\ Projects/Personal/Agents/Jano
npm run build 2>&1
```

Expected: `tsc` completa sin errores. Si hay errores de tipo (`any`, imports, etc.), corregirlos antes de continuar.

- [ ] **Step 2: Correr todos los tests de Jano**

```bash
npm run test 2>&1 | tail -20
```

Expected: todos los tests pasan (books, foco-cal, whatsapp, schedule-cal).

- [ ] **Step 3: Restart daemon Jano**

```bash
launchctl stop com.cal.cos-agent-v2 && launchctl start com.cal.cos-agent-v2
```

- [ ] **Step 4: Verificar que Jano levantó correctamente**

```bash
sleep 3 && tail -20 ~/Library/Logs/cos-agent-v2.out.log
```

Expected: sin errores de startup, daemon conectado y esperando mensajes.

- [ ] **Step 5: Smoke test en Telegram**

Enviar a Jano vía Telegram: `¿cuándo son mis vacaciones?`

Expected: Jano llama `listVacaciones`, retorna lista de entradas con emojis, fechas y links.

---

## Task 6: Crear e integrar `schedule-cal.ts` en Vesta

**Files:**
- Create: `Personal/Agents/Vesta/daemon-v2/src/tools/schedule-cal.ts` (copia de Jano)
- Modify: `Personal/Agents/Vesta/daemon-v2/src/agent-tools.ts`
- Modify: `Personal/Agents/Vesta/daemon-v2/src/agent.ts`

- [ ] **Step 1: Crear `Vesta/daemon-v2/src/tools/schedule-cal.ts`**

Copiar el contenido exacto de `Jano/daemon-v2/src/tools/schedule-cal.ts` — el archivo es idéntico porque ambos agentes operan sobre la misma DB de Cal.

- [ ] **Step 2: Agregar import en `Vesta/daemon-v2/src/agent-tools.ts`**

Al final de los imports existentes, agregar:

```typescript
import {
  listVacaciones,
  getVacacionDetail,
} from "./tools/schedule-cal.js";
```

- [ ] **Step 3: Registrar tools en `buildSdkTools` de Vesta**

Al final del array `return [...]` en Vesta's `buildSdkTools`, agregar:

```typescript
    tool(
      "listVacaciones",
      "Consulta las vacaciones de Cal en Schedule CAL (Notion). Filtros opcionales: año (ej. '2025 - 2026'), status. Devuelve lista con nombre, fechas, días disponibles, país, presupuesto. Llamar cuando Cal pregunte por sus vacaciones, días disponibles, viajes planeados, o quiera revisar el plan de vacaciones.",
      {
        year: z.string().optional(),
        status: z.enum(["Not started", "In progress", "Done", "Canceled"]).optional(),
      },
      async (filters) => asText(listVacaciones(filters)),
      READ_ONLY,
    ),
    tool(
      "getVacacionDetail",
      "Obtiene detalle completo de una entrada de vacaciones en Schedule CAL: propiedades + contenido de la página (notas, itinerario, checklist). Llamar cuando Cal pregunte por el contenido específico de unas vacaciones, quiera ver el itinerario, o cuando listVacaciones no tenga suficiente detalle.",
      { pageId: z.string() },
      async ({ pageId }) => asText(getVacacionDetail(pageId)),
      READ_ONLY,
    ),
```

> Verificar que `READ_ONLY` y `asText` ya estén definidos en Vesta's `agent-tools.ts` — sí están (líneas 11-16 del archivo).

- [ ] **Step 4: Agregar TOOL_MESSAGES en `Vesta/daemon-v2/src/agent.ts`**

En el objeto `TOOL_MESSAGES` de Vesta (prefijo `mcp__vesta-tools__`), agregar después de la última entrada existente:

```typescript
  // Schedule CAL — Vacaciones
  "mcp__vesta-tools__listVacaciones":     "🏖️ Consultando vacaciones...",
  "mcp__vesta-tools__getVacacionDetail":  "📋 Leyendo detalle de vacaciones...",
```

- [ ] **Step 5: Commit**

```bash
cd ~/Claude\ Projects/Personal/Agents/Vesta
git add daemon-v2/src/tools/schedule-cal.ts daemon-v2/src/shared/ntn.ts
git add daemon-v2/src/agent-tools.ts daemon-v2/src/agent.ts
git commit -m "feat: add schedule-cal vacaciones tools to Vesta"
```

---

## Task 7: Build y restart Vesta

- [ ] **Step 1: Build Vesta**

```bash
cd ~/Claude\ Projects/Personal/Agents/Vesta
npm run build 2>&1
```

Expected: `tsc` sin errores.

- [ ] **Step 2: Restart daemon Vesta**

```bash
launchctl stop com.cal.family-agent-v2 && launchctl start com.cal.family-agent-v2
```

- [ ] **Step 3: Verificar que Vesta levantó**

```bash
sleep 3 && tail -20 ~/Library/Logs/family-agent-v2.out.log
```

Expected: sin errores de startup.

- [ ] **Step 4: Smoke test Vesta en Telegram**

Enviar a Vesta vía Telegram: `¿cuántos días de vacaciones le quedan a Cal?`

Expected: Vesta llama `listVacaciones`, retorna las entradas con status/días disponibles.

- [ ] **Step 5: Smoke test de detalle**

Enviar: `dame el detalle de [nombre de vacaciones que apareció en el paso anterior]`

Expected: Vesta llama `getVacacionDetail` con el pageId correcto, retorna notas/itinerario de la página.

---

## Criterios de éxito finales

- [ ] Jano responde `¿cuándo son mis vacaciones?` con lista formateada (HTML con emojis)
- [ ] Jano responde a pedido de detalle con notas de la página
- [ ] Vesta hace lo mismo sin errores
- [ ] `callNtn` ya no se define en `books.ts` — se importa desde `../shared/ntn.js`
- [ ] `mcp-servers/shared/ntn.ts` existe como fuente de verdad documentada
- [ ] Build limpio en ambos agentes (sin errores de tipo)
- [ ] Tests de `books.test.ts` pasan sin regresión
- [ ] 13 tests de `schedule-cal.test.ts` pasan
