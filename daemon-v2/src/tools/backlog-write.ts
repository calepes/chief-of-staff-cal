// tools/backlog-write.ts — las escrituras permitidas sobre un backlog: append, tildar como
// hecho/descartado, y restaurar un snapshot (↩️ Deshacer).
//
// NUNCA edición libre de líneas: el riesgo de que el modelo reformatee o pierda contenido de un
// archivo de 287 líneas no vale la flexibilidad (decisión de Cal en el spec).
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
 * Encuentra el único pendiente que contenga `needle` y aplica `transform` a esa línea.
 * Falla explícito con 0 o ≥2 coincidencias — adivinar cuál tocar sería peor que no hacer nada.
 * `line` en el resultado es el texto ORIGINAL (antes de `transform`), para mostrarle a Cal el
 * ítem limpio en la tarjeta sin importar qué marcas agregue la transformación.
 */
function markBacklogLine(
  path: string,
  needle: string,
  transform: (originalLine: string) => string,
): MarkResult {
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
  const cleanText = lines[i].replace(PENDING_RE, "$2").trim().slice(0, 120);
  lines[i] = transform(lines[i]);
  writeAtomic(path, lines.join("\n"));
  return { ok: true, line: cleanText };
}

/** Tilda el pendiente como hecho: `[ ]` → `[x]`, sin tocar el texto. */
export function markBacklogDone(path: string, needle: string): MarkResult {
  return markBacklogLine(path, needle, (original) => original.replace(PENDING_RE, "$1[x]$2"));
}

/**
 * Tilda el pendiente como DESCARTADO — distinto de hecho: tacha el texto y anota el motivo,
 * para que no se lea como trabajo completado al pasar la vista por el archivo.
 */
export function markBacklogDiscarded(path: string, needle: string, fecha: string): MarkResult {
  return markBacklogLine(path, needle, (original) => {
    const m = PENDING_RE.exec(original);
    if (!m) return original;
    const [, prefix, body] = m;
    return `${prefix}[x] ~~${body.trim()}~~ — ❌ descartado ${fecha}`;
  });
}

/** Restaura un snapshot completo (↩️ Deshacer). Misma escritura atómica que las de arriba. */
export function restoreBacklogSnapshot(path: string, content: string): void {
  writeAtomic(path, content);
}
