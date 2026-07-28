// tools/backlog-discovery.ts — descubrimiento en vivo de los BACKLOG.md del árbol de Cal.
//
// Por qué se descubre y no se lista: Cal tiene 14 backlogs hoy y agrega proyectos seguido.
// Una allowlist hardcodeada quedaría vieja en silencio, y el pedido explícito fue ver el mapa
// "desde el root hasta el último proyecto".
//
// La seguridad NO la da la lista, la dan cuatro invariantes verificados en cada escritura:
//   1. El modelo pasa una CLAVE, nunca una ruta.
//   2. El realpath debe seguir cayendo dentro del root.
//   3. El basename debe ser exactamente backlog.md (case-insensitive).
//   4. El resuelto debe ser un archivo regular (no directorio, no symlink roto).
// El invariante 2 usa realpathSync y va ANTES de cualquier uso del path — misma lección que
// consultar-json.ts, donde validar sobre el string sin resolver dejaba pasar `..` y symlinks.
//
// Por qué el find sigue SÍNCRONO (execFileSync) a propósito, en vez de async como
// consultar-json.ts: medido en 10-70 ms sobre los 14 backlogs reales de Cal. Pasarlo a async
// obligaría a volver asíncrona toda la cadena que cuelga de acá (resolve, labels, tools,
// callbacks) por esos 70 ms — consultar-json.ts documenta por qué eso importaría en el caso
// general (congelar el poll loop de Telegram de todos los chats, los edits de progreso, el
// watchdog del webhook y los 4 crons proactivos), pero ese costo solo es real si el caso normal
// tarda segundos, no milisegundos. Lo inaceptable es el PEOR caso (disco lento, `find` que no
// vuelve) congelando el daemon entero 10s — por eso el timeout bajó de 10_000 a 2_000ms: es el
// techo del peor caso, no una estimación del tiempo esperado.
//
// maxdepth 6, no 4 (2026-07-28): con 4 quedaban afuera backlogs reales anidados un par de
// carpetas más abajo del proyecto (ej. Personal/Agents/Pecunia/pfm-dashboard/BACKLOG.md o
// Personal/Apps/Combustible/repo/docs/BACKLOG.md). Subir el maxdepth a secas trae basura a esa
// profundidad, así que además de `node_modules` (ya podado) se podan tres carpetas más:
//   - `commands/` — son slash commands de Claude Code (`.claude`-style, ej.
//     Personal/Agents/Jano/commands/backlog.md), no backlogs de ningún proyecto.
//   - `_archive/` — proyectos dados de baja (ej. Personal/Apps/_archive/Pulse/BACKLOG.md); su
//     backlog ya no es accionable.
//   - `.git/` — puede contener blobs/refs con nombres que calcen el patrón por casualidad; nunca
//     es contenido de proyecto.
// El prune de varios nombres en un solo `find` va con la expresión `( -name a -o -name b -o
// -name c ) -prune -o ...`: los paréntesis agrupan el OR de nombres ANTES de aplicarle `-prune`,
// para que se pode cualquiera de los cuatro y no solo el último. Los paréntesis se pasan como
// argumentos SUELTOS del array (sin backslash): no hay shell de por medio (execFileSync llama al
// binario directo), así que no hace falta escaparlos como en un `find` tipeado a mano en una
// terminal.

import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
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

/**
 * El PROYECTO es el primer segmento significativo del path relativo al root — no la carpeta
 * inmediata que contiene el BACKLOG.md (esa puede ser cualquier cosa, "docs", "repo", el nombre
 * de un dashboard interno, etc., una vez que el find bajó a maxdepth 6). Reglas:
 *   - `Personal/Agents/X/...` → proyecto X
 *   - `Personal/Apps/X/...`   → proyecto X
 *   - `X/...` (cualquier otra carpeta de primer nivel, ej. "Claude Code Setup") → proyecto X
 */
function projectNameFor(relDir: string): string {
  const parts = relDir.split(sep);
  if (parts[0] === "Personal" && (parts[1] === "Agents" || parts[1] === "Apps") && parts.length >= 3) {
    return parts[2];
  }
  return parts[0];
}

function entryFor(path: string, root: string): BacklogEntry {
  const relDir = relative(root, dirname(path));
  if (relDir === "" || relDir === ".") {
    return { key: "claude-projects", path, label: "General", group: "Raíz" };
  }
  const project = projectNameFor(relDir);
  return {
    key: deriveKey(project),
    path,
    label: project,
    group: groupFor(relDir),
  };
}

/**
 * Encuentra clave y label libres para una entrada cuya clave de proyecto ya está tomada, sin
 * descartar nunca una entrada por colisión. Como los paths se procesan ordenados por profundidad
 * (ver `discoverBacklogs`), el backlog menos profundo de un proyecto ya se quedó con la clave
 * pelada antes de llegar acá — esta función solo corre para los que llegan después.
 * Orden de intento: (1) la clave pelada + " · carpeta contenedora" (la carpeta que contiene
 * directamente el BACKLOG.md, ej. "agente" en Inversiones/docs/agente/backlog.md — es la que
 * distingue de verdad entre dos backlogs del MISMO proyecto), (2) sufijos numéricos si hasta esa
 * carpeta contenedora colisiona (ej. dos módulos que ambos anidan un "docs/BACKLOG.md").
 */
function pickFreeKey(
  path: string,
  baseKey: string,
  baseLabel: string,
  seen: Map<string, BacklogEntry>,
): { key: string; label: string } {
  if (!seen.has(baseKey)) return { key: baseKey, label: baseLabel };

  const containingFolder = basename(dirname(path));
  const prefixedKey = `${baseKey}-${deriveKey(containingFolder)}`;
  const prefixedLabel = `${baseLabel} · ${containingFolder}`;
  if (!seen.has(prefixedKey)) return { key: prefixedKey, label: prefixedLabel };

  let n = 2;
  while (seen.has(`${prefixedKey}-${n}`)) n++;
  return { key: `${prefixedKey}-${n}`, label: `${prefixedLabel} (${n})` };
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
      [
        root,
        "-maxdepth",
        "6",
        "(",
        "-name",
        "node_modules",
        "-o",
        "-name",
        "_archive",
        "-o",
        "-name",
        "commands",
        "-o",
        "-name",
        ".git",
        ")",
        "-prune",
        "-o",
        "-iname",
        "backlog.md",
        "-print",
      ],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch {
    // El cache de OTRO root no sirve de fallback acá: son árboles distintos, y devolver paths
    // de rootA cuando se pidió rootB sería peor que devolver una lista vacía.
    return cache?.root === root ? cache.entries : [];
  }

  const rootPrefix = root + sep;
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    const path = line.trim();
    if (!path) continue;
    // find se parsea por \n sin -print0: un directorio con un salto de línea en el nombre parte
    // la ruta en dos líneas y produce una entrada con path RELATIVO. Ese relativo se resolvería
    // (más abajo, en resolveBacklogPath, vía realpathSync) contra el cwd DEL DAEMON — que vive
    // dentro de ~/Claude Projects (Personal/Agents/Jano) — y podría terminar pasando los demás
    // invariantes sin colgar en realidad del root pedido. Se descarta toda línea que no cuelgue
    // literalmente de `root`.
    if (path !== root && !path.startsWith(rootPrefix)) continue;
    if (!BACKLOG_BASENAME_RE.test(basename(path))) continue;
    paths.push(path);
  }

  // Orden determinista ANTES de asignar claves: primero por PROFUNDIDAD y recién como desempate
  // por nombre. El orden en que `find` (y por debajo, `readdir`) devuelve las entradas NO es
  // alfabético (verificado: devolvió "zeta, mike, yankee, alpha, bravo" en una corrida real), así
  // que sin ordenar antes de asignar, una clave podía pasar a apuntar a otro proyecto entre
  // corridas sin que nada lo avisara. El criterio de profundidad importa además por diseño: dos
  // backlogs del mismo proyecto (ej. Inversiones en la raíz + Inversiones/docs/agente) deben
  // asignarse en orden "menos profundo primero" para que el backlog PRINCIPAL del proyecto —
  // el que está más arriba en el árbol — se quede con la clave pelada, y el anidado sea el que
  // se desambigua en `pickFreeKey`.
  paths.sort((a, b) => {
    const depthA = a.split(sep).length;
    const depthB = b.split(sep).length;
    return depthA !== depthB ? depthA - depthB : a.localeCompare(b);
  });

  const seen = new Map<string, BacklogEntry>();
  for (const path of paths) {
    const entry = entryFor(path, root);
    if (!entry.key) continue;
    const { key, label } = pickFreeKey(path, entry.key, entry.label, seen);
    entry.key = key;
    entry.label = label;
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
 * se sale del root, si el basename no es backlog.md, o si no es un archivo regular.
 */
export function resolveBacklogPath(key: string, root: string = BACKLOG_ROOT): string {
  const entry = discoverBacklogs(root).find((e) => e.key === key);
  if (!entry) {
    const disponibles = discoverBacklogs(root).map((e) => e.key).join(", ");
    throw new Error(`No reconozco el backlog "${key}". Disponibles: ${disponibles}`);
  }

  let resolved: string;
  try {
    resolved = realpathSync(entry.path);
  } catch {
    // Puede desaparecer del disco (borrado, symlink roto) dentro de la ventana de 10 min del
    // cache. Sin este catch, un ENOENT crudo del sistema se cuela en vez de un mensaje en el
    // mismo tono cuidado que las otras ramas de error de esta función.
    throw new Error(`No pude leer el backlog "${key}" (¿se movió o se borró?).`);
  }
  const rootReal = realpathSync(root);
  if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
    throw new Error(`El backlog "${key}" resuelve fuera del árbol de proyectos. No lo voy a tocar.`);
  }
  if (!BACKLOG_BASENAME_RE.test(basename(resolved))) {
    throw new Error(`El backlog "${key}" no apunta a un backlog.md.`);
  }
  if (!statSync(resolved).isFile()) {
    throw new Error(`El backlog "${key}" no es un archivo (¿es una carpeta?). No lo voy a tocar.`);
  }
  return resolved;
}
