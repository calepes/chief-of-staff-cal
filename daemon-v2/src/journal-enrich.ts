// journal-enrich.ts — paso 2 del guardado: propone metadata leyendo el texto crudo.
// Llamada acotada (Haiku, maxTurns 1, sin tools), mismo patrón que compact.ts.
// El texto YA está guardado cuando esto corre: si falla, no se pierde nada.

import { startup } from "@anthropic-ai/claude-agent-sdk";
import { ANIMOS, type Animo, type EnrichResult } from "./journal-types.js";

const MODEL = "claude-haiku-4-5-20251001";

export function buildEnrichPrompt(texto: string, topics: string[], bigThemes: string[]): string {
  return [
    "Sos un asistente que clasifica entradas de un diario personal de terapia.",
    "Leé el texto y devolvé SOLO un objeto JSON, sin explicación ni fences.",
    "",
    "Campos:",
    '- "titulo": frase breve (máx 60 caracteres) que nombre el pensamiento. En español.',
    `- "animo": uno exacto de: ${ANIMOS.join(" | ")}`,
    '- "intensidad": entero 1-5 (1 = apenas registrable, 5 = muy intenso).',
    `- "topics": array con 0-4 nombres, SOLO de esta lista: ${topics.join(", ")}`,
    `- "bigTheme": uno de esta lista o null: ${bigThemes.join(", ")}`,
    '- "reflexion": objeto {"titulo","situacion"} o null.',
    "",
    "Criterio para reflexion: hay reflexión cuando el texto contiene un aprendizaje,",
    "patrón o decisión que sigue siendo cierto mañana. NO la hay cuando es solo registro",
    "de estado ('hoy amanecí cansado') o narración sin conclusión. Ante la duda, devolvé null.",
    "",
    "Texto:",
    texto,
  ].join("\n");
}

export function parseEnrichResult(raw: string): EnrichResult | null {
  const limpio = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(limpio) as Record<string, unknown>;
  } catch {
    return null;
  }

  const titulo = typeof obj["titulo"] === "string" ? obj["titulo"].trim() : "";
  if (titulo.length === 0) return null;

  const animoRaw = obj["animo"];
  const animo: Animo = ANIMOS.includes(animoRaw as Animo) ? (animoRaw as Animo) : "😐 Neutro";

  const intensidadRaw = Number(obj["intensidad"]);
  const intensidad = Number.isFinite(intensidadRaw)
    ? Math.min(5, Math.max(1, Math.round(intensidadRaw)))
    : 3;

  const topics = Array.isArray(obj["topics"])
    ? (obj["topics"] as unknown[]).filter(
        (t): t is string => typeof t === "string" && t.trim().length > 0,
      )
    : [];

  const bigTheme =
    typeof obj["bigTheme"] === "string" && obj["bigTheme"].trim().length > 0
      ? obj["bigTheme"].trim()
      : null;

  let reflexion: EnrichResult["reflexion"] = null;
  const r = obj["reflexion"];
  if (r && typeof r === "object") {
    const rt = (r as Record<string, unknown>)["titulo"];
    const rs = (r as Record<string, unknown>)["situacion"];
    if (typeof rt === "string" && rt.trim().length > 0) {
      reflexion = { titulo: rt.trim(), situacion: typeof rs === "string" ? rs.trim() : "" };
    }
  }

  return { titulo: titulo.slice(0, 60), animo, intensidad, topics, bigTheme, reflexion };
}

/** Corre la llamada real. Devuelve null si el modelo falla o responde algo inutilizable. */
export async function enrichEntry(
  texto: string,
  topics: string[],
  bigThemes: string[],
): Promise<EnrichResult | null> {
  const handle = await startup({
    options: { model: MODEL, maxTurns: 1, allowedTools: [] },
  });

  let out = "";
  for await (const event of handle.query(buildEnrichPrompt(texto, topics, bigThemes))) {
    const e = event as { type?: string; subtype?: string; result?: string };
    if (e.type === "result" && e.subtype === "success") {
      out = e.result ?? "";
      break;
    }
  }
  return parseEnrichResult(out);
}
