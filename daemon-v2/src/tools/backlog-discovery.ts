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
 * Encuentra una clave libre para `entry.key`, sin descartar nunca una entrada por colisión.
 * Orden de intento: (1) la clave pelada, (2) prefijada con la carpeta ABUELA del archivo — dos
 * niveles arriba del BACKLOG.md, porque la carpeta PADRE (ej. "Agents") suele repetirse entre
 * proyectos distintos y no alcanza para desambiguar (verificado: A/Agents/Jano, B/Agents/Jano y
 * C/Agents/Jano comparten el mismo padre "Agents" pero no la misma abuela "A"/"B"/"C") —,
 * (3) sufijos numéricos si hasta el prefijo de abuela colisiona.
 */
function pickFreeKey(path: string, baseKey: string, seen: Map<string, BacklogEntry>): string {
  if (!seen.has(baseKey)) return baseKey;

  const grandparent = basename(dirname(dirname(dirname(path))));
  const prefixed = `${deriveKey(grandparent)}-${baseKey}`;
  if (!seen.has(prefixed)) return prefixed;

  let n = 2;
  while (seen.has(`${prefixed}-${n}`)) n++;
  return `${prefixed}-${n}`;
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

  // Orden determinista por nombre ANTES de asignar claves. El orden en que `find` (y por debajo,
  // `readdir`) devuelve las entradas NO es alfabético (verificado: devolvió "zeta, mike, yankee,
  // alpha, bravo" en una corrida real) — el `.sort()` de más abajo se aplicaba DESPUÉS de asignar
  // claves, así que no estabilizaba nada: si el orden de `find` flipeaba entre corridas, una
  // clave podía pasar a apuntar a otro proyecto sin que nada lo avisara.
  paths.sort();

  const seen = new Map<string, BacklogEntry>();
  for (const path of paths) {
    const entry = entryFor(path, root);
    if (!entry.key) continue;
    entry.key = pickFreeKey(path, entry.key, seen);
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
