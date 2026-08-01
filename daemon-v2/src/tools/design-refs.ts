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
