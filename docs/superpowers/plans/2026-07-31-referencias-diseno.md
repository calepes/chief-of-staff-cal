# Referencias de Diseño Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar a Jano y a las sesiones interactivas de Claude Code la capacidad de capturar un link
(X, Instagram, dashboards, webs) como referencia visual de diseño — screenshot + análisis con
visión + ficha — guardada en `Personal/Referencias de Diseño/`, para usarla como contexto al
rediseñar apps de Cal.

**Architecture:** Dos puntos de entrada (Jano por Telegram, un skill para sesión interactiva)
comparten carpeta de datos y formato de archivo, pero cada uno resuelve captura/análisis con lo
que ya tiene: ambos usan el MCP de Playwright ya permitido (navigate + cookies inyectadas del
Cookie Broker + screenshot); Jano analiza con `vision.ts` (OpenRouter), el skill analiza con la
visión nativa de Claude vía `Read`. El Cookie Broker gana una función nueva (`getStructuredCookies`)
que traduce su header HTTP a cookies estructuradas inyectables en un contexto de Playwright.

**Tech Stack:** TypeScript + `@anthropic-ai/claude-agent-sdk` (Jano, `daemon-v2/`), vitest, MCP
`plugin_playwright_playwright`, Node scripts (`.mjs`) para la sesión interactiva.

**Spec:** `docs/superpowers/specs/2026-07-31-referencias-diseno-design.md`

---

### Task 1: Carpeta de datos

**Files:**
- Create: `/Users/calepes/Claude Projects/Personal/Referencias de Diseño/INDEX.md`
- Create: `/Users/calepes/Claude Projects/Personal/Referencias de Diseño/_FORMATO.md`

- [ ] **Step 1: Crear `INDEX.md`**

```markdown
# Referencias de Diseño

Índice de referencias visuales guardadas para inspirarse al rediseñar apps. Fichas completas en
`refs/`, screenshots en `shots/`. No editar a mano el bloque de entradas — lo escribe
`guardarReferenciaDiseno` (Jano) o el skill `guardar-referencia-diseno` (sesión interactiva).

<!-- ENTRIES -->
```

- [ ] **Step 2: Crear `_FORMATO.md`**

````markdown
# Formato de Referencias de Diseño

Fuente única del formato de ficha e índice — referenciado por `guardarReferenciaDiseno` (Jano,
`daemon-v2/src/tools/design-refs.ts`) y por el skill `guardar-referencia-diseno` (sesión
interactiva de Claude Code). Si el formato cambia, actualizar los dos consumidores.

## Ficha (`refs/<fecha>-<slug>.md`)

```markdown
---
fuente: <url original>
tipo: dashboard | landing | componente | paleta | tipografia | microinteraccion | otro
tags: [tag-uno, tag-dos]
capturado: <YYYY-MM-DD>
shot: ../shots/<fecha>-<slug>.png
---

**Qué es:** <1 línea>

**Por qué funciona:** <2-4 líneas — el patrón concreto, no una descripción genérica>

**Aplicable a:** <apps de Cal, si aplica — omitir la línea si no aplica>
```

## Slug

Del título corto, normalizado: minúsculas, sin tildes, espacios y símbolos a guiones. Colisión el
mismo día → sufijo `-2`, `-3`, ...

## Línea de INDEX.md

Una por referencia, la más nueva PRIMERO (se inserta justo después de `<!-- ENTRIES -->`):

```markdown
- [<fecha>] **<título>** · `<tipo>` · <tags separados por coma> — [ficha](refs/<fecha>-<slug>.md)
```
````

- [ ] **Step 3: Verificar**

```bash
ls -la "/Users/calepes/Claude Projects/Personal/Referencias de Diseño/"
cat "/Users/calepes/Claude Projects/Personal/Referencias de Diseño/INDEX.md"
```
Expected: los dos archivos existen y `INDEX.md` termina en `<!-- ENTRIES -->`.

No hay commit — esta carpeta vive fuera de cualquier repo git (`~/Claude Projects` no es un
repositorio).

---

### Task 2: Cookie Broker — cookies estructuradas para Playwright

**Files:**
- Modify: `daemon-v2/src/tools/cookie-jar.ts`
- Test: `daemon-v2/src/tools/cookie-jar.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `daemon-v2/src/tools/cookie-jar.test.ts`:

```typescript
import type { CfKv } from "../cf-kv.js";
import { getStructuredCookies } from "./cookie-jar.js";

function fakeKv(header: string | null): CfKv {
  return {
    async getText(): Promise<string | null> {
      return header;
    },
  } as unknown as CfKv;
}

describe("getStructuredCookies", () => {
  it("devuelve whitelisted:false para un dominio fuera de la whitelist", async () => {
    const result = await getStructuredCookies("noestaenlawhitelist.com", fakeKv(null));
    expect(result).toEqual({ whitelisted: false, domain: null, cookies: [] });
  });

  it("parsea el header en cookies estructuradas cuando el dominio está whitelisteado", async () => {
    const result = await getStructuredCookies("www.iupana.com", fakeKv("a=1; b=2"));
    expect(result.whitelisted).toBe(true);
    expect(result.domain).toBe("iupana.com");
    expect(result.cookies).toEqual([
      { name: "a", value: "1", url: "https://iupana.com" },
      { name: "b", value: "2", url: "https://iupana.com" },
    ]);
  });

  it("devuelve cookies:[] si está whitelisteado pero sin cookie sincronizada", async () => {
    const result = await getStructuredCookies("iupana.com", fakeKv(null));
    expect(result).toEqual({ whitelisted: true, domain: "iupana.com", cookies: [] });
  });

  it("preserva valores de cookie que contienen '=' (ej. base64/JWT)", async () => {
    const result = await getStructuredCookies("iupana.com", fakeKv("sid=abc=def=="));
    expect(result.cookies).toEqual([{ name: "sid", value: "abc=def==", url: "https://iupana.com" }]);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm run test -w @cos/daemon -- cookie-jar`
Expected: FAIL — `getStructuredCookies is not exported` (o similar, no existe todavía).

- [ ] **Step 3: Implementar**

Agregar al final de `daemon-v2/src/tools/cookie-jar.ts`:

```typescript
export interface StructuredCookie {
  name: string;
  value: string;
  url: string;
}

export interface StructuredCookiesResult {
  whitelisted: boolean;
  domain: string | null;
  cookies: StructuredCookie[];
}

function parseCookieHeaderToStructured(header: string, domain: string): StructuredCookie[] {
  return header
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      return { name: pair.slice(0, idx), value: pair.slice(idx + 1), url: `https://${domain}` };
    });
}

/**
 * Como getCookieHeader, pero en el formato que acepta context.addCookies() de Playwright
 * ({name, value, url} por cookie) en vez del header HTTP crudo — ese header solo sirve para
 * fetchAsUser. Usado por guardarReferenciaDiseno para autenticar la captura de X/Instagram.
 */
export async function getStructuredCookies(hostname: string, kv: CfKv): Promise<StructuredCookiesResult> {
  const domain = findWhitelistedDomain(hostname);
  if (!domain) return { whitelisted: false, domain: null, cookies: [] };
  const header = await kv.getText(`cookie:${domain}`);
  return { whitelisted: true, domain, cookies: header ? parseCookieHeaderToStructured(header, domain) : [] };
}
```

Y agregar el import de `CfKv` al inicio del archivo si no está ya (verificar antes de duplicar):

```typescript
import type { CfKv } from "../cf-kv.js";
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npm run test -w @cos/daemon -- cookie-jar`
Expected: PASS — las 4 nuevas + las existentes de `matchesDomain`/`isDomainAllowed`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/cookie-jar.ts daemon-v2/src/tools/cookie-jar.test.ts
git commit -m "feat(jano): cookies estructuradas del Cookie Broker para Playwright"
```

---

### Task 3: `vision.ts` — task "design_critique"

**Files:**
- Modify: `daemon-v2/src/tools/vision.ts`

- [ ] **Step 1: Ampliar el tipo de `task`**

En `daemon-v2/src/tools/vision.ts`, cambiar:

```typescript
export interface AnalyzePhotoOpts {
  imagePath: string;
  mimeType?: string;
  caption?: string;
  task?: "ocr" | "classify" | "describe";
}
```

por:

```typescript
export interface AnalyzePhotoOpts {
  imagePath: string;
  mimeType?: string;
  caption?: string;
  task?: "ocr" | "classify" | "describe" | "design_critique";
}
```

- [ ] **Step 2: Agregar el prompt nuevo**

En el mismo archivo, agregar una entrada a `TASK_PROMPTS`:

```typescript
const TASK_PROMPTS: Record<NonNullable<AnalyzePhotoOpts["task"]>, string> = {
  ocr: "Extrae todo el texto visible en la foto. Si hay datos estructurados (lista, tabla, formulario), preserva la estructura. Responde solo con el texto extraído, sin comentarios.",
  classify:
    "Clasifica esta foto en una de estas categorías y resume su contenido relevante para coordinación familiar (cumple, evento escolar, lista de mercado, ticket, recordatorio de salud, foto familiar, otro). Responde con: <categoría>: <resumen 1-2 líneas>.",
  describe:
    "Describe brevemente el contenido relevante de la foto en 1-3 líneas, enfocándote en información útil para una familia (Cal, Noe y sus hijas Antonia y Catalina).",
  design_critique:
    "Sos un crítico de diseño de producto evaluando este screenshot para guardarlo como referencia " +
    "de inspiración. Respondé EXACTAMENTE en este formato, un campo por línea (sin markdown, sin " +
    "viñetas extra):\n" +
    "TITULO: <3-6 palabras, ej. 'Linear — paleta de comandos'>\n" +
    "TIPO: <una sola palabra de: dashboard, landing, componente, paleta, tipografia, microinteraccion, otro>\n" +
    "QUE_ES: <1 línea, qué es lo que se ve>\n" +
    "POR_QUE_FUNCIONA: <2-4 líneas. El patrón CONCRETO que hace que funcione — jerarquía, spacing, " +
    "contraste, densidad, el truco puntual. NUNCA una descripción genérica de \"qué se ve\".>\n" +
    "TAGS: <3-6 tags cortos en inglés, separados por coma, ej. dark-mode, data-density, glass>\n" +
    "Si la imagen muestra un muro de login o no cargó contenido real, decilo explícito en QUE_ES " +
    "en vez de inventar contenido que no viste.",
};
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores (el `Record` sigue siendo exhaustivo con las 4 claves).

- [ ] **Step 4: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/vision.ts
git commit -m "feat(jano): task design_critique en vision.ts"
```

---

### Task 4: `telegram-files.ts` — exportar validador + aceptar `disref-*.png`

**Files:**
- Modify: `daemon-v2/src/tools/telegram-files.ts`
- Test: `daemon-v2/src/tools/telegram-files.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `daemon-v2/src/tools/telegram-files.test.ts`:

```typescript
describe("enviarFotoLocal — disref-*.png (Referencias de Diseño)", () => {
  it("acepta un archivo disref-*.png dentro de tmpdir", async () => {
    const path = join(tmpdir(), "disref-linear-command-palette.png");
    await writeFile(path, Buffer.from("fake-png"));
    testFiles.push(path);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const result = await enviarFotoLocal("tok", 123, path, "disref.png");

    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm run test -w @cos/daemon -- telegram-files`
Expected: FAIL — `disref-*.png` todavía no matchea el regex de `enviarFotoLocal`.

- [ ] **Step 3: Implementar**

En `daemon-v2/src/tools/telegram-files.ts`:

1. Agregar `export` a la función de validación (queda igual por dentro, solo cambia la palabra clave):

```typescript
export async function resolveAllowedLocalFile(filePath: string, allowedName: RegExp): Promise<string | null> {
```

2. Ampliar el regex de `enviarFotoLocal` (dentro de la función, línea con el comentario
   `// boa-wallet-*: ...`):

```typescript
  // boa-wallet-*: tarjeta de embarque BoA. kpi-card-*: tarjeta diaria de KPIs Yape.
  // cine-*: mapa/resumen/QR/entradas del MCP de cine. disref-*: capturas de Referencias de Diseño.
  const resolved = await resolveAllowedLocalFile(filePath, /^(boa-wallet|kpi-card|cine|disref)-.+\.png$/);
  if (!resolved) {
    return {
      ok: false,
      error: `Path no permitido: solo se puede enviar boa-wallet-*.png, kpi-card-*.png, cine-*.png o disref-*.png dentro de ${tmpdir()}.`,
    };
  }
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npm run test -w @cos/daemon -- telegram-files`
Expected: PASS — el nuevo test más los 3 existentes.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/telegram-files.ts daemon-v2/src/tools/telegram-files.test.ts
git commit -m "feat(jano): telegram-files acepta disref-*.png y exporta el validador de paths"
```

---

### Task 5: `design-refs.ts` — parseo del análisis + escritura de ficha/índice

**Files:**
- Create: `daemon-v2/src/tools/design-refs.ts`
- Test: `daemon-v2/src/tools/design-refs.test.ts`

- [ ] **Step 1: Escribir el test que falla (parseDesignCritique)**

Crear `daemon-v2/src/tools/design-refs.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDesignCritique, slugify, writeDesignRef } from "./design-refs.js";

describe("parseDesignCritique", () => {
  it("parsea los 5 campos de una respuesta bien formada", () => {
    const text = [
      "TITULO: Linear — paleta de comandos",
      "TIPO: dashboard",
      "QUE_ES: paleta de comandos con búsqueda difusa",
      "POR_QUE_FUNCIONA: la jerarquía tipográfica separa acción de contexto.",
      "Además el spacing vertical es generoso pese a la densidad.",
      "TAGS: dark-mode, data-density, glass",
    ].join("\n");

    const result = parseDesignCritique(text);

    expect(result.titulo).toBe("Linear — paleta de comandos");
    expect(result.tipo).toBe("dashboard");
    expect(result.queEs).toBe("paleta de comandos con búsqueda difusa");
    expect(result.porQueFunciona).toBe(
      "la jerarquía tipográfica separa acción de contexto.\nAdemás el spacing vertical es generoso pese a la densidad.",
    );
    expect(result.tags).toEqual(["dark-mode", "data-density", "glass"]);
  });

  it("cae a 'otro' si TIPO no es uno de los válidos", () => {
    const result = parseDesignCritique("TITULO: X\nTIPO: infografia\nQUE_ES: y\nPOR_QUE_FUNCIONA: z\nTAGS: a");
    expect(result.tipo).toBe("otro");
  });

  it("nunca tira excepción con texto sin ninguna etiqueta", () => {
    const result = parseDesignCritique("esto no tiene el formato esperado para nada");
    expect(result.titulo).toBe("Referencia sin título");
    expect(result.tipo).toBe("otro");
    expect(result.tags).toEqual([]);
    expect(result.queEs).toContain("esto no tiene el formato esperado");
  });
});

describe("slugify", () => {
  it("normaliza tildes, mayúsculas y símbolos", () => {
    expect(slugify("Linear — Paleta de Comandos")).toBe("linear-paleta-de-comandos");
  });

  it("colapsa espacios/símbolos repetidos y recorta guiones en los bordes", () => {
    expect(slugify("  ¿Qué tal esto?!  ")).toBe("que-tal-esto");
  });
});

describe("writeDesignRef", () => {
  const ROOT = join(tmpdir(), "jano-test-design-refs");

  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  function fakeScreenshot(): string {
    const src = join(tmpdir(), `jano-test-shot-${process.pid}.png`);
    writeFileSync(src, Buffer.from("fake-png"));
    return src;
  }

  it("escribe la ficha, copia el screenshot y prepende la línea en INDEX.md", () => {
    const result = writeDesignRef(
      {
        fuente: "https://x.com/usuario/status/123",
        fecha: "2026-07-31",
        critique: {
          titulo: "Linear — paleta de comandos",
          tipo: "dashboard",
          queEs: "paleta de comandos",
          porQueFunciona: "jerarquía clara",
          tags: ["dark-mode", "glass"],
        },
      },
      fakeScreenshot(),
      ROOT,
    );

    expect(result.slug).toBe("linear-paleta-de-comandos");
    expect(existsSync(result.fichaPath)).toBe(true);
    expect(existsSync(result.shotPath)).toBe(true);

    const ficha = readFileSync(result.fichaPath, "utf8");
    expect(ficha).toContain("fuente: https://x.com/usuario/status/123");
    expect(ficha).toContain("tipo: dashboard");
    expect(ficha).toContain("**Qué es:** paleta de comandos");
    expect(ficha).toContain("**Por qué funciona:** jerarquía clara");

    const index = readFileSync(join(ROOT, "INDEX.md"), "utf8");
    expect(index).toContain(
      "- [2026-07-31] **Linear — paleta de comandos** · `dashboard` · dark-mode, glass — [ficha](refs/2026-07-31-linear-paleta-de-comandos.md)",
    );
  });

  it("agrega Aplicable a solo si viene en el input", () => {
    const result = writeDesignRef(
      {
        fuente: "https://ejemplo.com",
        fecha: "2026-07-31",
        critique: { titulo: "Algo", tipo: "otro", queEs: "x", porQueFunciona: "y", tags: [] },
        aplicableA: "Combustible",
      },
      fakeScreenshot(),
      ROOT,
    );
    expect(readFileSync(result.fichaPath, "utf8")).toContain("**Aplicable a:** Combustible");
  });

  it("resuelve colisión del mismo día con sufijo -2", () => {
    const critique = { titulo: "Mismo Título", tipo: "otro" as const, queEs: "x", porQueFunciona: "y", tags: [] };
    const r1 = writeDesignRef({ fuente: "https://a.com", fecha: "2026-07-31", critique }, fakeScreenshot(), ROOT);
    const r2 = writeDesignRef({ fuente: "https://b.com", fecha: "2026-07-31", critique }, fakeScreenshot(), ROOT);
    expect(r1.slug).toBe("mismo-titulo");
    expect(r2.slug).toBe("mismo-titulo-2");
  });

  it("la entrada más nueva queda primero en INDEX.md", () => {
    const critique = { titulo: "Uno", tipo: "otro" as const, queEs: "x", porQueFunciona: "y", tags: [] };
    writeDesignRef({ fuente: "https://a.com", fecha: "2026-07-30", critique: { ...critique, titulo: "Primero" } }, fakeScreenshot(), ROOT);
    writeDesignRef({ fuente: "https://b.com", fecha: "2026-07-31", critique: { ...critique, titulo: "Segundo" } }, fakeScreenshot(), ROOT);
    const index = readFileSync(join(ROOT, "INDEX.md"), "utf8");
    expect(index.indexOf("Segundo")).toBeLessThan(index.indexOf("Primero"));
  });

  it("crea INDEX.md con el marcador si todavía no existe", () => {
    mkdirSync(ROOT, { recursive: true });
    const critique = { titulo: "Primera", tipo: "otro" as const, queEs: "x", porQueFunciona: "y", tags: [] };
    writeDesignRef({ fuente: "https://a.com", fecha: "2026-07-31", critique }, fakeScreenshot(), ROOT);
    const index = readFileSync(join(ROOT, "INDEX.md"), "utf8");
    expect(index).toContain("<!-- ENTRIES -->");
    expect(index).toContain("Primera");
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm run test -w @cos/daemon -- design-refs`
Expected: FAIL — `./design-refs.js` no existe todavía.

- [ ] **Step 3: Implementar**

Crear `daemon-v2/src/tools/design-refs.ts`:

```typescript
// tools/design-refs.ts — escritura de "Personal/Referencias de Diseño/": la ficha, el screenshot
// y la línea de INDEX.md que arma guardarReferenciaDiseno. El análisis de visión (vision.ts) vive
// aparte; acá solo se parsea su salida y se escribe a disco.
//
// El formato (ficha + índice) está documentado UNA sola vez en
// "Personal/Referencias de Diseño/_FORMATO.md" — este módulo y el skill guardar-referencia-diseno
// (sesión interactiva) lo siguen al pie de la letra para no divergir.

import { readFileSync, writeFileSync, renameSync, unlinkSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DESIGN_REFS_ROOT = join(homedir(), "Claude Projects", "Personal", "Referencias de Diseño");

const TIPOS_VALIDOS = ["dashboard", "landing", "componente", "paleta", "tipografia", "microinteraccion", "otro"] as const;
export type TipoReferencia = (typeof TIPOS_VALIDOS)[number];

export interface DesignCritique {
  titulo: string;
  tipo: TipoReferencia;
  queEs: string;
  porQueFunciona: string;
  tags: string[];
}

/** Extrae un bloque LABEL: ... hasta la próxima etiqueta en mayúsculas o el final del texto. */
function grabBlock(text: string, label: string): string {
  const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

/**
 * Parsea la salida de vision.ts (task "design_critique"). Best-effort: un campo faltante nunca
 * tira excepción, queda vacío o con el fallback correspondiente — una ficha incompleta sigue
 * siendo útil para revisar a mano, y esto no es una escritura sensible que amerite fallar duro.
 */
export function parseDesignCritique(text: string): DesignCritique {
  const tipoRaw = grabBlock(text, "TIPO").toLowerCase().replace(/[^a-z]/g, "");
  const tagsRaw = grabBlock(text, "TAGS");
  return {
    titulo: grabBlock(text, "TITULO") || "Referencia sin título",
    tipo: (TIPOS_VALIDOS as readonly string[]).includes(tipoRaw) ? (tipoRaw as TipoReferencia) : "otro",
    queEs: grabBlock(text, "QUE_ES") || text.slice(0, 300).trim(),
    porQueFunciona: grabBlock(text, "POR_QUE_FUNCIONA"),
    tags: tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [],
  };
}

/** "Linear — Paleta de Comandos" → "linear-paleta-de-comandos". Mismo criterio que deriveKey de backlog-discovery.ts. */
export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueSlug(refsDir: string, fecha: string, base: string): string {
  const safeBase = base || "referencia";
  let slug = safeBase;
  let n = 2;
  while (existsSync(join(refsDir, `${fecha}-${slug}.md`))) {
    slug = `${safeBase}-${n}`;
    n++;
  }
  return slug;
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* el temporal puede no existir */ }
    throw e;
  }
}

function copyAtomic(src: string, dest: string): void {
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* el temporal puede no existir */ }
    throw e;
  }
}

function prependIndexLine(indexPath: string, line: string): void {
  let existing: string;
  try {
    existing = readFileSync(indexPath, "utf8");
  } catch {
    existing = "# Referencias de Diseño\n\n<!-- ENTRIES -->\n";
  }
  const marker = "<!-- ENTRIES -->";
  const idx = existing.indexOf(marker);
  const out =
    idx >= 0
      ? existing.slice(0, idx + marker.length) + "\n" + line + existing.slice(idx + marker.length)
      : existing.trimEnd() + "\n\n" + marker + "\n" + line + "\n";
  writeAtomic(indexPath, out);
}

export interface WriteDesignRefInput {
  fuente: string;
  fecha: string; // YYYY-MM-DD
  critique: DesignCritique;
  aplicableA?: string;
}

export interface DesignRefResult {
  slug: string;
  fichaPath: string;
  shotPath: string;
  indexLine: string;
}

/**
 * Escribe la ficha + copia el screenshot + prepende la línea de INDEX.md. screenshotSourcePath ya
 * tiene que estar validado por el caller (ver resolveAllowedLocalFile en telegram-files.ts) — este
 * módulo no valida de dónde viene, solo lo copia.
 */
export function writeDesignRef(
  input: WriteDesignRefInput,
  screenshotSourcePath: string,
  root: string = DESIGN_REFS_ROOT,
): DesignRefResult {
  const refsDir = join(root, "refs");
  const shotsDir = join(root, "shots");
  mkdirSync(refsDir, { recursive: true });
  mkdirSync(shotsDir, { recursive: true });

  const baseSlug = slugify(input.critique.titulo);
  const slug = uniqueSlug(refsDir, input.fecha, baseSlug);
  const filename = `${input.fecha}-${slug}`;
  const fichaPath = join(refsDir, `${filename}.md`);
  const shotPath = join(shotsDir, `${filename}.png`);

  copyAtomic(screenshotSourcePath, shotPath);

  const { critique } = input;
  const lines = [
    "---",
    `fuente: ${input.fuente}`,
    `tipo: ${critique.tipo}`,
    `tags: [${critique.tags.join(", ")}]`,
    `capturado: ${input.fecha}`,
    `shot: ../shots/${filename}.png`,
    "---",
    "",
    `**Qué es:** ${critique.queEs}`,
    "",
    `**Por qué funciona:** ${critique.porQueFunciona}`,
    "",
  ];
  if (input.aplicableA) lines.push(`**Aplicable a:** ${input.aplicableA}`, "");
  writeAtomic(fichaPath, lines.join("\n"));

  const indexLine = `- [${input.fecha}] **${critique.titulo}** · \`${critique.tipo}\` · ${critique.tags.join(", ")} — [ficha](refs/${filename}.md)`;
  prependIndexLine(join(root, "INDEX.md"), indexLine);

  return { slug, fichaPath, shotPath, indexLine };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npm run test -w @cos/daemon -- design-refs`
Expected: PASS — las 3 de `parseDesignCritique`, las 2 de `slugify`, las 5 de `writeDesignRef`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/design-refs.ts daemon-v2/src/tools/design-refs.test.ts
git commit -m "feat(jano): design-refs.ts — parseo de crítica de diseño y escritura de ficha/índice"
```

---

### Task 6: Tools nuevas en `agent-tools.ts`

**Files:**
- Modify: `daemon-v2/src/agent-tools.ts`

- [ ] **Step 1: Ampliar imports existentes**

Cambiar:

```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
```

por:

```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
```

Cambiar:

```typescript
import { addDomainAndSync } from "./tools/cookie-jar.js";
```

por:

```typescript
import { addDomainAndSync, getStructuredCookies } from "./tools/cookie-jar.js";
```

Cambiar:

```typescript
import { enviarDocumentoLocal, enviarFotoLocal } from "./tools/telegram-files.js";
```

por:

```typescript
import { enviarDocumentoLocal, enviarFotoLocal, resolveAllowedLocalFile } from "./tools/telegram-files.js";
```

- [ ] **Step 2: Agregar imports nuevos**

Justo debajo del import de `telegram-files.js`, agregar:

```typescript
import { analyzePhoto } from "./tools/vision.js";
import { parseDesignCritique, writeDesignRef } from "./tools/design-refs.js";
```

- [ ] **Step 3: Agregar las dos tools**

Ubicar el bloque de la tool `addCookieJarDomain` (busca `"addCookieJarDomain"` en el archivo) y
agregar las dos tools nuevas justo después de su cierre `),`:

```typescript
    tool(
      "obtenerCookiesReferenciaDiseno",
      "Devuelve las cookies guardadas del Cookie Broker para el dominio de una URL, en formato " +
      "listo para inyectar a un contexto de Playwright con context.addCookies(...). " +
      "Usar ANTES de navegar con Playwright a un link que se vaya a guardar como referencia de " +
      "diseño (mcp__cos-tools__guardarReferenciaDiseno) — así la captura sale logueada en vez de " +
      "mostrar un muro de login. Si el dominio no está whitelisteado o no hay cookie sincronizada, " +
      "devuelve cookies:[] y hay que navegar igual sin inyectar nada.",
      { url: z.string().url().describe("URL completa del recurso a capturar") },
      async ({ url }) => {
        const hostname = new URL(url).hostname;
        return asText(await getStructuredCookies(hostname, deps.cookieJarKv));
      },
      READ_ONLY,
    ),
    tool(
      "guardarReferenciaDiseno",
      "Guarda un screenshot ya capturado como referencia de diseño: lo analiza con visión " +
      "(jerarquía, paleta, spacing, el patrón concreto que lo hace bueno) y escribe la ficha + el " +
      "screenshot en 'Personal/Referencias de Diseño/'. Usar DESPUÉS de capturar el screenshot con " +
      "Playwright (navigate + opcionalmente obtenerCookiesReferenciaDiseno + browser_run_code_unsafe " +
      "para inyectar cookies + browser_take_screenshot con filename 'disref-<algo>.png'). " +
      "Después de llamar esta tool, mandá el screenshot a Cal con enviarFotoLocal usando el shotPath " +
      "devuelto y un caption corto (título + tipo). No hace falta pedir confirmación: es informativo.",
      {
        fuente: z.string().url().describe("URL original del recurso"),
        screenshotPath: z.string().describe("Path absoluto del PNG capturado por Playwright — debe estar dentro de tmpdir() y nombrarse disref-*.png"),
        aplicableA: z.string().optional().describe("Apps de Cal a las que aplica esta referencia, SOLO si es evidente por el contexto de la charla (ej. 'Combustible, Presupuesto Privado'). Omitir si no está claro."),
      },
      async ({ fuente, screenshotPath, aplicableA }) => {
        try {
          const validated = await resolveAllowedLocalFile(screenshotPath, /^disref-.+\.png$/i);
          if (!validated) {
            return asText({ ok: false, error: `Path no permitido: solo un PNG disref-*.png dentro de ${tmpdir()}.` });
          }
          const analysis = await analyzePhoto({ imagePath: validated, task: "design_critique" });
          const critique = parseDesignCritique(analysis.text);
          const fecha = nowInLaPaz(new Date()).slice(0, 10);
          const result = writeDesignRef({ fuente, fecha, critique, aplicableA }, validated);
          return asText({ ok: true, ...result, titulo: critique.titulo, tipo: critique.tipo, tags: critique.tags });
        } catch (e) {
          return asText({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      },
    ),
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores. Si `nowInLaPaz` no está importado en `agent-tools.ts`, el error lo va a
señalar — ya está importado (`import { nowInLaPaz } from "./journal-capture.js";`, usado por el
backlog); si el import faltara, agregarlo desde `./journal-capture.js`.

- [ ] **Step 5: Build**

Run: `npm -w @cos/shared run build && npm -w @cos/daemon run build`
Expected: build limpio.

- [ ] **Step 6: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/agent-tools.ts
git commit -m "feat(jano): tools obtenerCookiesReferenciaDiseno y guardarReferenciaDiseno"
```

---

### Task 7: `system-prompt.ts` — instrucciones del flujo

**Files:**
- Modify: `daemon-v2/src/system-prompt.ts`

- [ ] **Step 1: Insertar la sección nueva**

Ubicar el final del archivo (busca `- No setear Author/Tags/Big Themes via tool (son relaciones
complejas — Cal las asigna en Notion)`, la última línea de la sección "## Libros (Notion BD)",
justo antes del backtick de cierre del template string) e insertar ANTES del backtick de cierre:

```typescript
- No setear Author/Tags/Big Themes via tool (son relaciones complejas — Cal las asigna en Notion)

## Referencias de Diseño

Cal guarda inspiración visual (dashboards, UI, paletas, patrones de X/Instagram/webs) para
rediseñar sus apps más adelante. Vos hacés la captura y el guardado — Cal no hace nada manual.

**Disparo:** cuando Cal comparta un link con intención de guardarlo como inspiración de diseño
("guarda esto de diseño", "guárdame esta referencia", "esto está bueno para inspirarme") — NO
cualquier link que toque temas de diseño (un artículo sobre UX o una noticia van al resumidor,
\`mcp__cos-tools__resumirContenido\`, no acá).

**Flujo (siempre en este orden):**

1. \`mcp__cos-tools__obtenerCookiesReferenciaDiseno({ url })\` — chequea si el dominio tiene
   cookies guardadas del Cookie Broker.
2. Si \`whitelisted: true\` y \`cookies\` no está vacío: usar
   \`mcp__plugin_playwright_playwright__browser_run_code_unsafe\` con este código EXACTO (solo
   reemplazá \`COOKIES_JSON\` por el array que devolvió el paso 1 y \`TARGET_URL\` por la URL real):
   \`\`\`javascript
   async (page) => {
     await page.context().addCookies(COOKIES_JSON);
     await page.goto("TARGET_URL", { waitUntil: "networkidle", timeout: 20000 });
     return await page.title();
   }
   \`\`\`
   Si \`whitelisted: false\` o \`cookies\` viene vacío: usar
   \`mcp__plugin_playwright_playwright__browser_navigate\` directo con la URL, sin inyectar nada.
3. \`mcp__plugin_playwright_playwright__browser_take_screenshot\` con
   \`filename: "disref-<algo-corto>.png"\` (el prefijo \`disref-\` es OBLIGATORIO — sin él,
   \`guardarReferenciaDiseno\` rechaza el path) y \`fullPage: true\`.
4. \`mcp__cos-tools__guardarReferenciaDiseno({ fuente, screenshotPath, aplicableA? })\` — analiza
   el screenshot con visión y escribe la ficha. \`screenshotPath\` es el path que devolvió el paso 3.
   \`aplicableA\` es opcional: pasalo solo si por el contexto de la charla es evidente a qué app de
   Cal aplica (ej. mencionó que está rediseñando Combustible).
5. \`mcp__cos-tools__enviarFotoLocal({ path, filename, caption })\` con \`path\` = el \`shotPath\`
   que devolvió el paso 4, caption con el título y el tipo (ej. "🎨 Linear — paleta de comandos
   (dashboard)"). Después de esto NO generes texto adicional: la foto + caption son la confirmación.

Si el screenshot capturado muestra un muro de login (dominio sin cookie sincronizada), decíselo a
Cal en vez de guardar la ficha igual — pedile que mande el screenshot a mano si lo necesita ahora.
`;
```

(El backtick + `;` finales de arriba son el cierre real del archivo — no agregar nada después.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @cos/daemon`
Expected: sin errores (es un template string, cualquier backtick sin escapar rompe el archivo —
si falla, revisar que los backticks internos de los bloques de código estén escapados como \`\`\`\`).

- [ ] **Step 3: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/system-prompt.ts
git commit -m "feat(jano): instrucciones de Referencias de Diseño en el system prompt"
```

---

### Task 8: Whitelist del Cookie Broker

**Files:**
- Modify: `/Users/calepes/.claude/config/cookie-jar-domains.json`

- [ ] **Step 1: Editar el archivo**

Reemplazar el contenido completo por:

```json
{
  "_comment": "Whitelist de dominios permitidos en el Cookie Broker KV (namespace 'cookie-jar', Cloudflare account id de Cal). REGLA DURA: solo medios de noticias/lectura, MAS la excepcion puntual x.com/twitter.com/instagram.com (autorizada por Cal 2026-07-31, solo para guardarReferenciaDiseno -- ver Personal/Agents/Jano/docs/superpowers/specs/2026-07-31-referencias-diseno-design.md). NUNCA banca, financieras, Gmail/email, ni ningun sitio con datos sensibles. Editar a mano para sumar/quitar dominios -- ver ~/Claude Projects/HANDOFF-cookie-broker-kv.md.",
  "ttlSeconds": 86400,
  "domains": [
    { "domain": "iupana.com" },
    { "domain": "x.com" },
    { "domain": "twitter.com" },
    { "domain": "instagram.com" }
  ]
}
```

- [ ] **Step 2: Validar el JSON**

Run: `cat ~/.claude/config/cookie-jar-domains.json | python3 -m json.tool > /dev/null && echo OK`
Expected: `OK`.

- [ ] **Step 3: Sincronizar las cookies ahora (requiere que Cal esté logueado en Safari en esos sitios)**

Run: `~/.claude/bin/node-fda ~/.claude/scripts/sync-safari-cookies.mjs`
Expected: una línea `[sync-safari-cookies] x.com: cookie actualizada (...)` por cada dominio
logueado; si alguno sale como "sin cookies relevantes en Safari", Cal necesita loguearse ahí
primero — no es un error del script.

No hay commit — este archivo vive fuera de cualquier repo git (`~/.claude/config/`).

---

### Task 9: Script standalone de cookies para el skill

**Files:**
- Create: `/Users/calepes/.claude/scripts/design-ref-cookies.mjs`

- [ ] **Step 1: Crear el script**

```javascript
#!/usr/bin/env node
// design-ref-cookies.mjs — lee el Cookie Broker (mismo KV que usa Jano vía cookie-jar.ts) y
// devuelve cookies estructuradas para inyectar a un contexto de Playwright, para el skill
// guardar-referencia-diseno (sesión interactiva de Claude Code, que no tiene el binding directo al
// KV que sí tiene el daemon de Jano — acá se lee vía `wrangler kv key get`, mismo mecanismo que
// sync-safari-cookies.mjs usa para ESCRIBIR).
//
// Uso: node design-ref-cookies.mjs "<url-o-hostname>"
// Salida: JSON { whitelisted: bool, domain: string|null, cookies: [{name,value,url}] }
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadCloudflareToken } from "./cf-token-env.mjs";

const execFileAsync = promisify(execFile);
const DOMAINS_CONFIG = `${homedir()}/.claude/config/cookie-jar-domains.json`;
const NAMESPACE_ID = "f6bfb90d3dbc48a29b4dc431e9d83c5b";

function matchesDomain(candidate, configured) {
  const a = candidate.toLowerCase();
  const b = configured.toLowerCase();
  return a === b || a.endsWith("." + b) || b.endsWith("." + a);
}

function extractHostname(input) {
  try {
    return new URL(input).hostname;
  } catch {
    return input;
  }
}

function findWhitelistedDomain(hostname) {
  const cfg = JSON.parse(readFileSync(DOMAINS_CONFIG, "utf8"));
  const domains = Array.isArray(cfg.domains) ? cfg.domains : [];
  const hit = domains.find((d) => matchesDomain(hostname, d.domain));
  return hit ? hit.domain : null;
}

function parseCookieHeader(header, domain) {
  if (!header) return [];
  return header
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      return { name: pair.slice(0, idx), value: pair.slice(idx + 1), url: `https://${domain}` };
    });
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("Uso: design-ref-cookies.mjs <url-o-hostname>");
    process.exit(1);
  }
  const hostname = extractHostname(input);
  const domain = findWhitelistedDomain(hostname);
  if (!domain) {
    console.log(JSON.stringify({ whitelisted: false, domain: null, cookies: [] }));
    return;
  }
  loadCloudflareToken(); // expone CLOUDFLARE_API_TOKEN a wrangler desde apps.env
  let header = "";
  try {
    const { stdout } = await execFileAsync(
      "wrangler",
      ["kv", "key", "get", `cookie:${domain}`, "--namespace-id", NAMESPACE_ID, "--remote"],
      { maxBuffer: 1024 * 1024 * 5 },
    );
    header = stdout.trim();
  } catch {
    header = "";
  }
  console.log(JSON.stringify({ whitelisted: true, domain, cookies: parseCookieHeader(header, domain) }));
}

main();
```

- [ ] **Step 2: Dar permiso de ejecución**

Run: `chmod +x ~/.claude/scripts/design-ref-cookies.mjs`

- [ ] **Step 3: Probar con un dominio whitelisteado**

Run: `node ~/.claude/scripts/design-ref-cookies.mjs "https://x.com/algunusuario/status/123"`
Expected: JSON con `"whitelisted":true,"domain":"x.com"` y un array `cookies` (vacío si Task 8
Step 3 no encontró sesión, o con entradas si Cal está logueado en Safari).

- [ ] **Step 4: Probar con un dominio NO whitelisteado**

Run: `node ~/.claude/scripts/design-ref-cookies.mjs "https://ejemplo-cualquiera.com"`
Expected: `{"whitelisted":false,"domain":null,"cookies":[]}`.

No hay commit — vive fuera de cualquier repo git (`~/.claude/scripts/`).

---

### Task 10: Skill `guardar-referencia-diseno`

**Files:**
- Create: `/Users/calepes/.claude/skills/guardar-referencia-diseno/SKILL.md`

- [ ] **Step 1: Crear el skill**

```markdown
---
name: guardar-referencia-diseno
description: Guarda un link (X, Instagram, un dashboard, una web) como referencia visual de inspiración para rediseñar apps de Cal — captura un screenshot con Playwright (con cookies logueadas si el dominio está en el Cookie Broker), lo analiza con visión, y escribe la ficha + el screenshot en "Personal/Referencias de Diseño/". Triggers: Cal comparte un link y dice "guarda esto de diseño", "guárdame esta referencia", "esto está bueno para inspirarme", o pide explícitamente guardar algo como referencia visual. NO usar para links que solo pide resumir o leer (artículos, noticias) — eso es contenido a leer, no inspiración visual a guardar.
---

# Guardar Referencia de Diseño

Mismo flujo que la tool `guardarReferenciaDiseno` de Jano (ver
`Personal/Agents/Jano/docs/superpowers/specs/2026-07-31-referencias-diseno-design.md`), adaptado a
sesión interactiva de Claude Code: acá no hay `vision.ts` (OpenRouter) — el análisis lo hacés vos
directo, leyendo el screenshot con `Read`.

El formato de ficha/índice es el ÚNICO en `Personal/Referencias de Diseño/_FORMATO.md` — seguilo al
pie de la letra, no inventes tu propio formato.

Cargá los tools de Playwright si están diferidos:
`ToolSearch("select:mcp__plugin_playwright_playwright__browser_navigate,mcp__plugin_playwright_playwright__browser_run_code_unsafe,mcp__plugin_playwright_playwright__browser_take_screenshot")`

## Paso 1 — Cookies (si el dominio puede tener login wall, ej. X/Instagram)

```bash
node ~/.claude/scripts/design-ref-cookies.mjs "<URL>"
```

Devuelve JSON `{ whitelisted, domain, cookies: [{name, value, url}] }`. Si `cookies` viene vacío,
saltá al Paso 2 sin inyectar nada.

## Paso 2 — Captura

Si `cookies` no está vacío, usá `mcp__plugin_playwright_playwright__browser_run_code_unsafe` con
este código EXACTO (reemplazando `COOKIES_JSON` por el array del paso 1 y `TARGET_URL` por la URL
real):

```javascript
async (page) => {
  await page.context().addCookies(COOKIES_JSON);
  await page.goto("TARGET_URL", { waitUntil: "networkidle", timeout: 20000 });
  return await page.title();
}
```

Si `cookies` está vacío, usá `mcp__plugin_playwright_playwright__browser_navigate` directo con la
URL.

Después, `mcp__plugin_playwright_playwright__browser_take_screenshot` con `fullPage: true` y un
`filename` descriptivo (ej. `linear-command-palette.png`) — acá NO hace falta el prefijo
`disref-` (esa validación es solo del lado de Jano/tmpdir; en sesión interactiva no aplica).

## Paso 3 — Análisis

`Read` sobre el PNG capturado. Escribí tu propia crítica de diseño — jerarquía visual, paleta,
spacing, tipografía, y **el patrón concreto que hace que funcione** (nunca una descripción
genérica de "qué se ve"). Si la imagen muestra un muro de login, decilo en vez de inventar
contenido que no viste.

Definí: `titulo` (3-6 palabras), `tipo` (uno de: dashboard, landing, componente, paleta,
tipografia, microinteraccion, otro), `queEs` (1 línea), `porQueFunciona` (2-4 líneas), `tags`
(3-6 tags cortos en inglés).

## Paso 4 — Escritura

Derivá el slug: título normalizado (minúsculas, sin tildes, espacios/símbolos a guiones). Si ya
existe `refs/<fecha>-<slug>.md` para hoy, agregá sufijo `-2`, `-3`, etc. (`fecha` = hoy, formato
`YYYY-MM-DD`.)

1. Copiá el screenshot a `Personal/Referencias de Diseño/shots/<fecha>-<slug>.png` (`Bash: cp`).
2. `Write` la ficha en `Personal/Referencias de Diseño/refs/<fecha>-<slug>.md` siguiendo
   `_FORMATO.md` exacto (frontmatter `fuente`/`tipo`/`tags`/`capturado`/`shot`, luego **Qué es**,
   **Por qué funciona**, y **Aplicable a** solo si aplica).
3. `Edit` `Personal/Referencias de Diseño/INDEX.md`: insertá la línea nueva inmediatamente después
   de `<!-- ENTRIES -->` (la más nueva siempre primero):
   `- [<fecha>] **<título>** · \`<tipo>\` · <tags separados por coma> — [ficha](refs/<fecha>-<slug>.md)`

## Paso 5 — Confirmación

Mostrale a Cal el screenshot (`Read` sobre el PNG lo renderiza inline) + un resumen corto: título,
tipo, tags, y dónde quedó guardada la ficha.
```

- [ ] **Step 2: Verificar**

Run: `cat ~/.claude/skills/guardar-referencia-diseno/SKILL.md | head -5`
Expected: el frontmatter con `name: guardar-referencia-diseno` se ve bien formado.

No hay commit — vive fuera de cualquier repo git (`~/.claude/skills/`).

---

### Task 11: `design-style-router` — leer referencias antes de preguntar

**Files:**
- Modify: `/Users/calepes/.claude/skills/design-style-router/SKILL.md`

- [ ] **Step 1: Agregar la sección**

Insertar, ANTES de la sección `## Skills instalados que NO entran en este router` (buscar ese
heading exacto), la sección nueva:

```markdown
## Referencias visuales de Cal (antes de preguntar la línea)

Cal guarda inspiración de diseño en `Personal/Referencias de Diseño/INDEX.md` (fichas con
capturas + análisis, ver
`Personal/Agents/Jano/docs/superpowers/specs/2026-07-31-referencias-diseno-design.md`). Antes de
preguntar la línea con `AskUserQuestion`, si el archivo existe, leelo y fijate si alguna entrada
aplica al proyecto/app de este pedido (por nombre en el campo "Aplicable a" de la ficha, o por
tags relacionados). Si hay 1-3 que apliquen, mencionalas en una línea antes de la pregunta ("Tenés
N referencias guardadas que podrían aplicar acá: ...") — no bloquea el flujo, es solo contexto
adicional. Si el archivo no existe o no hay ninguna que aplique, seguí directo a la pregunta sin
mencionarlo.

```

- [ ] **Step 2: Verificar**

Run: `grep -n "Referencias visuales de Cal" ~/.claude/skills/design-style-router/SKILL.md`
Expected: una coincidencia.

No hay commit — vive fuera de cualquier repo git.

---

### Task 12: Documentar en `Jano/CLAUDE.md`

**Files:**
- Modify: `/Users/calepes/Claude Projects/Personal/Agents/Jano/CLAUDE.md`

- [ ] **Step 1: Ampliar el inventario de tools**

Ubicar, dentro de la sección `## Índice de tools + MCPs`, el fragmento:

```
**mapaBacklogs/leerBacklog/proponerItemBacklog** (leer y escribir los `BACKLOG.md` de los proyectos de Cal — ver sección "Backlogs de proyectos" abajo).
```

y agregar justo después, antes del punto final:

```
 · **obtenerCookiesReferenciaDiseno/guardarReferenciaDiseno** (capturar y guardar referencias visuales de diseño en `Personal/Referencias de Diseño/` — ver sección "Referencias de Diseño" abajo)
```

- [ ] **Step 2: Insertar la sección nueva**

Insertar, ANTES de la sección `## Runtime del SDK — modelo, effort, turnos y sesión (2026-07-27)`,
la sección nueva:

```markdown
## Referencias de Diseño — agregado 2026-07-31

Jano captura links de inspiración de diseño (X, Instagram, dashboards, webs) y los guarda en
`Personal/Referencias de Diseño/` (fuera de este repo, hermano de `Personal/Agents/`) — ficha +
screenshot + análisis de visión, para que Claude los use como contexto al rediseñar apps de Cal.
Mismo flujo replicado en sesión interactiva vía el skill `guardar-referencia-diseno`. Spec:
`docs/superpowers/specs/2026-07-31-referencias-diseno-design.md`.

- **Dos tools nuevas:** `obtenerCookiesReferenciaDiseno` (cookies del Cookie Broker en formato
  `{name,value,url}`, listo para `context.addCookies()` de Playwright) y `guardarReferenciaDiseno`
  (analiza el screenshot con `vision.ts` — task nuevo `design_critique` — y escribe ficha+shot+
  índice). La CAPTURA (navegar, inyectar cookies, screenshot) la hace el propio agente encadenando
  el MCP de Playwright ya permitido — no hay tool ni script de captura nuevo.
- **El Cookie Broker (`cookie-jar.ts`) solo daba un header HTTP para `fetchAsUser`, no servía para
  autenticar un navegador real.** `getStructuredCookies` lo parsea a `{name,value,url}` — formato
  mínimo que acepta `addCookies()` sin necesitar path/expiry/domain por cookie.
- **Excepción puntual a la regla dura del Cookie Broker:** `x.com`, `twitter.com` e
  `instagram.com` se agregaron a la whitelist (`~/.claude/config/cookie-jar-domains.json`),
  autorizado explícitamente por Cal el 2026-07-31 — la regla "solo medios de noticias/lectura"
  sigue aplicando para cualquier otro dominio nuevo.
- **`screenshotPath` se valida igual que `boa-wallet-*`/`kpi-card-*`/`cine-*`:** solo
  `disref-*.png` dentro de `tmpdir()`, con `realpath()` antes de aceptar el path (mismo
  `resolveAllowedLocalFile` de `telegram-files.ts`, ahora exportado y reusado).
- **El formato de ficha/índice vive en un solo lugar:** `Personal/Referencias de Diseño/_FORMATO.md`
  — lo siguen tanto `design-refs.ts` (Jano) como el skill de sesión interactiva, para que no
  diverjan con el tiempo.
- **Sin tarjeta de confirmación** (informativo, como `mapaBacklogs`): no hay nada sensible que
  aprobar, Jano manda el screenshot con `enviarFotoLocal` y un caption corto.
- **`design-style-router`** (skill global) lee `INDEX.md` antes de preguntar la línea visual de un
  rediseño y menciona referencias guardadas que apliquen.

```

- [ ] **Step 3: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add CLAUDE.md
git commit -m "docs(jano): documentar Referencias de Diseño en CLAUDE.md"
```

---

### Task 13: Verificación end-to-end + restart

**Files:** ninguno nuevo — solo comandos.

- [ ] **Step 1: Suite completa + typecheck + build**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm run test -w @cos/daemon
npm run typecheck -w @cos/daemon
npm -w @cos/shared run build && npm -w @cos/daemon run build
```

Expected: todos los tests en verde (incluidos los 4 archivos tocados/creados en este plan), 0
errores de typecheck, build limpio.

- [ ] **Step 2: Restart del daemon**

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl print gui/$(id -u)/com.cal.cos-agent-v2 | grep -E "state|pid"
```

Expected: `state = running` con un pid nuevo.

- [ ] **Step 3: Smoke test real por Telegram (requiere a Cal)**

Cal manda a Jano un link real de X o Instagram (logueado en Safari) con "guarda esto de diseño".
Verificar en el chat: Jano manda el screenshot con caption de título+tipo, y en el filesystem:

```bash
ls "/Users/calepes/Claude Projects/Personal/Referencias de Diseño/refs/"
ls "/Users/calepes/Claude Projects/Personal/Referencias de Diseño/shots/"
cat "/Users/calepes/Claude Projects/Personal/Referencias de Diseño/INDEX.md"
```

Expected: una ficha nueva, un screenshot nuevo, y `INDEX.md` con la entrada arriba de todo.

- [ ] **Step 4: Smoke test del skill en sesión interactiva**

En una sesión de Claude Code (cualquier directorio), invocar el skill `guardar-referencia-diseno`
con un link de prueba (idealmente uno SIN login wall, para no depender de cookies en este smoke
test) y confirmar que el resultado sigue exactamente el mismo formato que el de Jano (mismo
frontmatter, misma estructura de `INDEX.md`).

- [ ] **Step 5: Revisar logs por errores**

```bash
tail -100 ~/Library/Logs/cos-agent-v2.out.log | grep -i "disref\|design.ref\|cookie"
tail -100 ~/Library/Logs/cos-agent-v2.err.log
```

Expected: sin stack traces relacionados al flujo nuevo.
