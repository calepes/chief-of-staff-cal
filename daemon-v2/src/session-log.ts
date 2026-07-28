// session-log.ts — registro histórico de qué sessionIds del Agent SDK son DEL DAEMON.
//
// Por qué existe: el SDK persiste cada sesión completa (tool calls + resultados) en
// ~/.claude/projects/<proyecto>/<sessionId>.jsonl. Ese directorio lo comparten el daemon
// de Jano Y cualquier sesión interactiva de Claude Code que trabaje sobre este mismo
// repo (desarrollo, este mismo cambio incluido). El pase nocturno de learnings necesita
// reflexionar SOLO sobre conversaciones reales de Cal con el bot — sin este registro,
// leería también sesiones de desarrollo y propondría learnings sin sentido para el bot
// ("Cal prefiere que los tests corran antes del commit").
//
// `sessions.json` (session-store.ts) no alcanza para esto: guarda solo la sesión VIGENTE
// por chat y la pierde al rotar (techo de turnos o TTL de 12h) — el pase nocturno necesita
// TODAS las sesiones que hubo en el día, no solo la última.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nowInLaPaz } from "./journal-capture.js";

export const SESSION_LOG_PATH = join(process.env.HOME!, ".cos-agent", "sessions-log.jsonl");

/** 30 días: el pase nocturno solo mira el día anterior; no hay razón para acumular más. */
const PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface SessionLogEntry {
  sessionId: string;
  chatId: number;
  startedAt: number;
}

function isValidEntry(v: unknown): v is SessionLogEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.sessionId === "string" && typeof e.chatId === "number" && typeof e.startedAt === "number";
}

/**
 * Día calendario en hora de La Paz (offset fijo -04:00, Bolivia no tiene horario de verano) para
 * un timestamp arbitrario. IMPORTANTE: nunca usar getFullYear()/getMonth() sobre la timezone del
 * sistema — este mismo repo tuvo un bug real por eso (fechas corriéndose al día siguiente entre
 * las 20:00 y medianoche hora de Cal cuando el cálculo se hacía en UTC).
 */
function dayInLaPaz(ts: number): string {
  return nowInLaPaz(new Date(ts)).slice(0, 10);
}

function readEntries(path: string): SessionLogEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: SessionLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isValidEntry(parsed)) out.push(parsed);
      // línea corrupta o con forma inesperada: se ignora, no invalida el resto del registro
    } catch {
      // ídem: JSON inválido en una línea no rompe la lectura de las demás
    }
  }
  return out;
}

/**
 * Anota una sesión del daemon en el registro histórico. Idempotente (no duplica el mismo
 * sessionId) y NUNCA lanza: se llama en el camino crítico de cada turno (ver saveSessionId en
 * session-store.ts) y no debe romperlo por un problema de disco.
 */
export function recordSession(
  path: string,
  sessionId: string,
  chatId: number,
  startedAt: number = Date.now(),
): void {
  try {
    const existing = readEntries(path);
    if (existing.some((e) => e.sessionId === sessionId)) return;
    mkdirSync(dirname(path), { recursive: true });
    const entry: SessionLogEntry = { sessionId, chatId, startedAt };
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Nunca romper un turno de Cal por no poder anotar el registro histórico: en el peor caso,
    // el pase nocturno simplemente no ve esta sesión.
  }
}

/** sessionIds registrados cuyo `startedAt`, en hora de La Paz, cae dentro de `fecha` (YYYY-MM-DD). */
export function sessionIdsForDay(path: string, fecha: string): string[] {
  return readEntries(path)
    .filter((e) => dayInLaPaz(e.startedAt) === fecha)
    .map((e) => e.sessionId);
}

/** Purga los registros de más de 30 días. Best-effort: un fallo acá no es crítico. */
export function pruneSessionLog(path: string, now: number = Date.now()): void {
  try {
    const cutoff = now - PRUNE_MAX_AGE_MS;
    const kept = readEntries(path).filter((e) => e.startedAt >= cutoff);
    mkdirSync(dirname(path), { recursive: true });
    const content = kept.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(path, kept.length ? `${content}\n` : "", "utf8");
  } catch {
    // best-effort: si falla, el archivo simplemente sigue creciendo hasta el próximo intento
  }
}
