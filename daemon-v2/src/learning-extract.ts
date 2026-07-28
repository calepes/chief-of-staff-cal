// learning-extract.ts — paso de reflexión del cron nocturno: lee el transcript recortado del día
// (ver learning-transcript.ts) y le pide a Haiku que proponga candidatos a aprendizaje.
// Mismo patrón que journal-enrich.ts (Haiku, maxTurns 1, sin tools) — leer ese archivo antes de
// tocar este.

import { startup } from "@anthropic-ai/claude-agent-sdk";
import { formatLearning } from "./learning-file.js";
import { LEARNING_TAGS, type Learning, type LearningCandidate, type LearningTag } from "./learning-types.js";

const MODEL = "claude-haiku-4-5-20251001";

const MAX_TEXT_CHARS = 300;
const MAX_EVIDENCIA_CHARS = 200;

function isLearningTag(v: unknown): v is LearningTag {
  return typeof v === "string" && (LEARNING_TAGS as readonly string[]).includes(v);
}

/**
 * Arma el prompt para el pase de reflexión. Termina con la lista de aprendizajes ya conocidos
 * (para que Haiku no repita) y el transcript del día.
 *
 * Todo el texto va en español neutro, sin voseo: estos learnings se inyectan después en el
 * system prompt de Jano (ver learnings.ts) y el estilo se contagia a cómo le responde a Cal —
 * si el módulo de reflexión escribe en voseo, Jano empieza a sonar distinto sin que nadie lo pida.
 */
export function buildExtractPrompt(transcript: string, existentes: Learning[]): string {
  const listaExistentes =
    existentes.length > 0
      ? existentes.map(formatLearning).join("\n")
      : "(todavía no hay ningún aprendizaje guardado)";

  return [
    "Eres el módulo de reflexión nocturna de Jano, el asistente personal de Cal en Telegram.",
    "Tu única tarea es leer el transcript de las conversaciones de hoy y proponer aprendizajes",
    "candidatos que Jano debería recordar de ahora en adelante.",
    "",
    "Devuelve SOLO un array JSON, sin explicación ni fences de markdown, con elementos:",
    '{"tag": "...", "text": "...", "evidencia": "..."}',
    "",
    "Los cuatro tags posibles:",
    "- pref: una preferencia de Cal sobre CÓMO quiere que Jano le responda (formato, tono, qué",
    "  priorizar, qué evitar).",
    "- hecho: un dato no obvio sobre Cal, su familia, su trabajo o su contexto (Bolivia/Perú,",
    "  Yape, rutinas) que Jano debería tener presente.",
    "- err: un error operativo de Jano — una tool que falló y por qué. Los bloques 'TOOL ERROR'",
    "  del transcript son la MEJOR fuente para este tag.",
    "- flujo: una secuencia de pasos o pedidos que Cal repite seguido.",
    "",
    "'text' va en máximo 2 líneas, redactado como instrucción o hecho (ej. 'Cal prefiere que las",
    "cifras de dinero vayan con separador de miles'), NUNCA como narración de lo que pasó en la",
    "charla. 'evidencia' es una cita corta del transcript que justifica el candidato.",
    "",
    "Reglas, en orden de importancia:",
    "1. No repitas nada que ya esté en la lista de aprendizajes existentes (más abajo) — ni con",
    "   las mismas palabras ni parafraseado.",
    "2. No anotes algo que pasó una sola vez. Un pedido puntual no es una preferencia; hace falta",
    "   un patrón, no un incidente aislado.",
    "3. Nada genérico ni obvio ('Cal usa Telegram', 'Jano debe ser útil').",
    "4. Los bloques 'TOOL ERROR' del transcript son la mejor fuente de candidatos 'err'.",
    "5. Si no encuentras nada que valga la pena, devuelve un array vacío: []. Devolver vacío es el",
    "   resultado ESPERADO la mayoría de los días — no inventes un candidato débil solo para",
    "   justificar la llamada.",
    "6. Escribe SIEMPRE en español NEUTRO, sin voseo (di 'puedes', nunca 'podés'). Esto no es",
    "   un detalle de estilo: estos textos se inyectan después en el system prompt de Jano, y el",
    "   estilo de este módulo se contagia a cómo Jano le responde a Cal.",
    "",
    "Aprendizajes que Jano YA tiene (no los repitas):",
    listaExistentes,
    "",
    "Transcript de hoy:",
    transcript,
  ].join("\n");
}

/**
 * Parsea la respuesta de Haiku. Tolera fences de markdown; exige un array (un objeto suelto se
 * descarta); valida el tag contra LEARNING_TAGS; descarta candidatos sin texto; recorta texto y
 * evidencia a un tamaño razonable para la tarjeta de Telegram.
 */
export function parseExtractResult(raw: string): LearningCandidate[] {
  const limpio = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(limpio);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const out: LearningCandidate[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    if (!isLearningTag(obj["tag"])) continue;

    const text = typeof obj["text"] === "string" ? obj["text"].trim() : "";
    if (text.length === 0) continue;

    const evidencia = typeof obj["evidencia"] === "string" ? obj["evidencia"].trim() : "";

    out.push({
      tag: obj["tag"],
      text: text.slice(0, MAX_TEXT_CHARS),
      evidencia: evidencia.slice(0, MAX_EVIDENCIA_CHARS),
    });
  }

  return out;
}

/**
 * Corre la llamada real a Haiku. Si el transcript viene vacío, no llama al modelo — no hay nada
 * que reflexionar. Cierra SIEMPRE el handle (finally): sin close() queda un subprocess huérfano,
 * y este daemon corre semanas sin reiniciar.
 */
export async function extractLearnings(
  transcript: string,
  existentes: Learning[],
): Promise<LearningCandidate[]> {
  if (transcript.trim().length === 0) return [];

  const handle = await startup({
    options: { model: MODEL, maxTurns: 1, allowedTools: [] },
  });

  let out = "";
  try {
    for await (const event of handle.query(buildExtractPrompt(transcript, existentes))) {
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
      /* cerrar es best-effort: si ya murió, no hay nada que hacer */
    }
  }

  return parseExtractResult(out);
}
