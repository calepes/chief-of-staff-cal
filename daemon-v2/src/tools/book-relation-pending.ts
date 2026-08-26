import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Gate técnico real para confirmCreateBookRelation — sin esto, la única barrera contra
 * "crear una relación con datos arbitrarios" era prosa en system-prompt.ts (findable por
 * daemon-health-reviewer como vector de prompt injection: Jano tiene web search/fetch
 * activos en la misma sesión que gestiona libros).
 *
 * addBook/updateBook registran acá cada relación que NO pudieron resolver 1:1 (not_found o
 * ambiguous); confirmCreateBookRelation solo ejecuta si encuentra una entrada pendiente que
 * matchee exacto (bookPageId + tipo + nombre normalizado), y la consume al usarla.
 */

const PENDING_PATH = join(process.env.HOME!, ".cos-agent", "book-relation-pending.json");

// Alcanza para que Cal confirme en el mismo intercambio de chat sin dejar la ventana abierta
// más de lo necesario — mismo orden de magnitud que otros locks cortos de este daemon.
const TTL_MS = 15 * 60 * 1000;

interface PendingEntry {
  bookPageId: string;
  tipo: string;
  nombre: string; // normalizado (trim + lowercase) para comparar
  ts: number;
}

function readAll(): PendingEntry[] {
  try {
    return JSON.parse(readFileSync(PENDING_PATH, "utf8")) as PendingEntry[];
  } catch {
    return [];
  }
}

function writeAll(data: PendingEntry[]): void {
  try {
    mkdirSync(dirname(PENDING_PATH), { recursive: true });
    writeFileSync(PENDING_PATH, JSON.stringify(data), "utf8");
  } catch {
    // Nunca romper el turno por esto — el peor caso es que confirmCreateBookRelation
    // rechace una confirmación legítima (comportamiento seguro, no silencioso).
  }
}

function normalize(nombre: string): string {
  return nombre.trim().toLowerCase();
}

function purgeExpired(data: PendingEntry[]): PendingEntry[] {
  const cutoff = Date.now() - TTL_MS;
  return data.filter((e) => e.ts >= cutoff);
}

export function addPendingRelation(bookPageId: string, tipo: string, nombre: string): void {
  const data = purgeExpired(readAll());
  const key = normalize(nombre);
  if (!data.some((e) => e.bookPageId === bookPageId && e.tipo === tipo && e.nombre === key)) {
    data.push({ bookPageId, tipo, nombre: key, ts: Date.now() });
  }
  writeAll(data);
}

/** Consume (borra) la propuesta pendiente si matchea exacto. Devuelve false si no hay match. */
export function consumePendingRelation(bookPageId: string, tipo: string, nombre: string): boolean {
  const data = purgeExpired(readAll());
  const key = normalize(nombre);
  const idx = data.findIndex((e) => e.bookPageId === bookPageId && e.tipo === tipo && e.nombre === key);
  if (idx === -1) {
    writeAll(data);
    return false;
  }
  data.splice(idx, 1);
  writeAll(data);
  return true;
}
