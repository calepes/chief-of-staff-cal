import { startup } from "@anthropic-ai/claude-agent-sdk";
import type { EntityConfig } from "./research-competencia-entities.js";
import type { EntitySnapshot, Hallazgo } from "./research-competencia-types.js";

export interface MechanicalFacts {
  ios: { version: string; rating: number | null; releaseNotes: string | null } | null;
  android: { version: string | null; rating: number | null; releaseNotes: string | null } | null;
  siteText: string | null;
}

export function buildEntityPrompt(
  entity: EntityConfig,
  baseline: EntitySnapshot | null,
  facts: MechanicalFacts,
  timeframeDias: number,
): string {
  const baselineText = baseline ? JSON.stringify(baseline, null, 2) : "(sin baseline — primera corrida para esta entidad)";
  return [
    `Sos un analista de inteligencia competitiva para Yape Bolivia. Estás investigando a "${entity.nombre}".`,
    `Buscá en la web (prensa boliviana y LinkedIn — consultá algo como "${entity.linkedinQuery}") novedades de los últimos ${timeframeDias} días sobre: alianzas, comunicados, posicionamiento, cambios de T&C (dimensión Estrategia); campañas, promos, canales, lanzamientos (dimensión GTM); roles nuevos publicados o posts institucionales en LinkedIn (dimensión Hiring).`,
    ``,
    `Estado anterior conocido (baseline):`,
    baselineText,
    ``,
    `Datos mecánicos NUEVOS de esta corrida (app stores + sitio web):`,
    JSON.stringify(facts, null, 2),
    ``,
    `Comparalos contra el baseline. Si hay una versión de app nueva, un rating que cambió de forma notoria, o texto de sitio con una diferencia real (no ruido de maquetación), generá un hallazgo de dimensión Producto.`,
    ``,
    `Devolvé SOLO un JSON (sin texto alrededor, sin markdown) con esta forma exacta:`,
    `{"hallazgos": [{"dimension": "Producto"|"Estrategia"|"GTM"|"Hiring", "descripcion": "string corto y concreto", "fuente": "URL o vacío"}], "notas": "string corto con contexto para la próxima corrida (ej. último rol visto en LinkedIn), o vacío"}`,
    `Si no encontrás nada relevante, devolvé {"hallazgos": [], "notas": ""}. No inventes hallazgos ni fuentes.`,
  ].join("\n");
}

export interface AgentResponse {
  hallazgos: Hallazgo[];
  notas: string;
}

const VALID_DIMENSIONS = new Set(["Producto", "Estrategia", "GTM", "Hiring"]);

export function parseAgentJson(text: string): AgentResponse {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { hallazgos: [], notas: "" };
  try {
    const parsed = JSON.parse(match[0]) as { hallazgos?: unknown[]; notas?: unknown };
    const hallazgos: Hallazgo[] = Array.isArray(parsed.hallazgos)
      ? parsed.hallazgos
          .filter(
            (h): h is { dimension: string; descripcion: string; fuente?: string } =>
              !!h && typeof h === "object" && VALID_DIMENSIONS.has((h as { dimension?: string }).dimension ?? "") &&
              typeof (h as { descripcion?: unknown }).descripcion === "string",
          )
          .map((h) => ({
            dimension: h.dimension as Hallazgo["dimension"],
            descripcion: h.descripcion,
            fuente: typeof h.fuente === "string" ? h.fuente : "",
          }))
      : [];
    return { hallazgos, notas: typeof parsed.notas === "string" ? parsed.notas : "" };
  } catch {
    return { hallazgos: [], notas: "" };
  }
}

export async function runEntityAgent(prompt: string): Promise<string> {
  const handle = await startup({
    options: { model: "claude-sonnet-5", maxTurns: 8, allowedTools: ["WebSearch"] },
  });
  let result = "";
  for await (const event of handle.query(prompt)) {
    if ((event as { type?: string }).type === "result" && (event as { subtype?: string }).subtype === "success") {
      result = (event as { result?: string }).result ?? "";
      break;
    }
  }
  return result;
}
