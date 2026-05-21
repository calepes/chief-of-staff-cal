import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import type { CfKv } from "../cf-kv.js";

// ── Constantes ────────────────────────────────────────────────────────────────

export const FOCO_PAGE_ID = "365c4876-09dd-806b-b602-f408c50a077b";
export const FOCO_KPIS_VIEW_URL = "view://35920029-b0cc-4af9-bac1-0bff18afdb5c";
export const FOCO_TAREAS_VIEW_URL = "view://366c4876-09dd-8062-944d-000c6c57c26a";

const FOCO_KV_COUNTER = "foco_checkin_counter";
const COUNTER_TTL = 365 * 24 * 3600; // 1 año — siempre se refresca en cada check-in

export const FOCO_SECTIONS = [
  "CAL",
  "Prioridades",
  "Rufino",
  "Christian",
  "KPIs",
  "Tareas",
] as const;
export type FocoSection = (typeof FOCO_SECTIONS)[number];

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface FocoProgressEntry {
  date: string;       // YYYY-MM-DD
  ts: number;         // Unix timestamp (segundos)
  section: FocoSection;
  itemText: string;
  note: string | null;
}

// ── Progress file ─────────────────────────────────────────────────────────────

export const DEFAULT_PROGRESS_PATH = `${homedir()}/.cos-agent/foco-progress.json`;

export function appendFocoProgress(
  entry: FocoProgressEntry,
  path = DEFAULT_PROGRESS_PATH,
): void {
  const all = readAllProgress(path);
  all.push(entry);
  writeFileSync(path, JSON.stringify(all, null, 2));
}

export function readFocoProgress(
  days = 30,
  path = DEFAULT_PROGRESS_PATH,
): FocoProgressEntry[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return readAllProgress(path).filter((e) => e.date >= cutoffStr);
}

function readAllProgress(path = DEFAULT_PROGRESS_PATH): FocoProgressEntry[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FocoProgressEntry[];
  } catch {
    return [];
  }
}

// ── Section rotation (KV) ─────────────────────────────────────────────────────

/** Avanza el contador y retorna la siguiente sección. Llamar en cada check-in. */
export async function getNextSection(
  kv: CfKv,
): Promise<{ section: FocoSection; counter: number }> {
  const current = (await kv.get<number>(FOCO_KV_COUNTER)) ?? -1;
  const next = current + 1;
  await kv.set(FOCO_KV_COUNTER, next, COUNTER_TTL);
  return { section: FOCO_SECTIONS[next % FOCO_SECTIONS.length], counter: next };
}

/** Lee la sección actual sin avanzar el contador. */
export async function peekCurrentSection(kv: CfKv): Promise<FocoSection> {
  const current = (await kv.get<number>(FOCO_KV_COUNTER)) ?? 0;
  return FOCO_SECTIONS[current % FOCO_SECTIONS.length];
}

/** Función pura para tests — calcula sección dado un contador. */
export function sectionFromCounter(n: number): FocoSection {
  return FOCO_SECTIONS[((n % FOCO_SECTIONS.length) + FOCO_SECTIONS.length) % FOCO_SECTIONS.length];
}
