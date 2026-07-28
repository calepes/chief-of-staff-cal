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
    .replace(/[̀-ͯ]/g, "")
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
