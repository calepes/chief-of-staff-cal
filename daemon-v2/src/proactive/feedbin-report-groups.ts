// feedbin-report-groups.ts — agrupa por tema una lista de entries de Feedbin ya clasificados
// (abrir o saltar), usando el perfil de intereses como contexto. Mismo patrón que
// classifyEntries/parseClassifyResult en feedbin-daily-report.ts (Haiku, maxTurns 1, sin tools).
//
// Principio de seguridad (mismo que feedbinEntryUrl / las citas [ID] del perfil semanal):
// el link/id final SIEMPRE sale de datos que nosotros ya conocíamos, nunca de texto que el
// modelo inventó — parseGroupingResult descarta cualquier id que no esté en `validIds`.

import { startup } from "@anthropic-ai/claude-agent-sdk";
import type { FeedbinEntry } from "../tools/feedbin-client.js";

const MODEL = "claude-haiku-4-5-20251001";

export interface ThemeGroup {
  label: string;
  entryIds: number[];
}

export function buildGroupingPrompt(perfil: string, entries: FeedbinEntry[]): string {
  const lista = entries.map((e) => `${e.id} | ${e.title ?? "(sin título)"}`).join("\n");
  return [
    "Perfil de temas de interés actuales de la persona:",
    perfil,
    "",
    "Artículos (id | título):",
    lista,
    "",
    "Agrupá estos artículos en temas concretos y específicos (no genéricos como \"tecnología\").",
    "Cada artículo va en EXACTAMENTE un grupo — el que mejor calce. Un número razonable de",
    "grupos para este conjunto (ni un grupo por artículo, ni todo en un solo grupo).",
    "",
    "Devolvé SOLO un JSON, sin explicación ni fences:",
    '{"grupos":[{"tema":"...","ids":[N,N,...]}, ...]}',
  ].join("\n");
}

export function parseGroupingResult(raw: string, validIds: Set<number>): ThemeGroup[] {
  const limpio = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(limpio);
  } catch {
    return [];
  }

  const grupos = (parsed as { grupos?: unknown }).grupos;
  if (!Array.isArray(grupos)) return [];

  const out: ThemeGroup[] = [];
  for (const g of grupos as Array<Record<string, unknown>>) {
    const label = typeof g.tema === "string" ? g.tema.trim() : "";
    if (!label) continue;
    const ids = Array.isArray(g.ids)
      ? (g.ids as unknown[]).filter((id): id is number => typeof id === "number" && validIds.has(id))
      : [];
    if (ids.length === 0) continue;
    out.push({ label, entryIds: ids });
  }
  return out;
}

/** Corre la llamada real a Haiku. Sin entries, no llama al modelo. Cierra SIEMPRE el handle. */
export async function groupEntries(perfil: string, entries: FeedbinEntry[]): Promise<ThemeGroup[]> {
  if (entries.length === 0) return [];

  const validIds = new Set(entries.map((e) => e.id));
  const handle = await startup({ options: { model: MODEL, maxTurns: 1, allowedTools: [] } });
  let out = "";
  try {
    for await (const event of handle.query(buildGroupingPrompt(perfil, entries))) {
      const e = event as { type?: string; subtype?: string; result?: string };
      if (e.type === "result" && e.subtype === "success") {
        out = e.result ?? "";
        break;
      }
    }
  } finally {
    try {
      await handle.close();
    } catch {
      /* cerrar es best-effort */
    }
  }

  return parseGroupingResult(out, validIds);
}
