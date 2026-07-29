// task-extract.ts — síntesis del cuerpo de un mail (Tarea) a los campos que pide la tarea de
// Notion. Llamada acotada (Haiku, maxTurns 1, sin tools), mismo patrón que journal-enrich.ts —
// el mail ya fue detectado y matcheado por asunto/remitente (mecánico) antes de llegar acá; este
// paso solo redacta, nunca decide si el mail es válido.

import { startup } from "@anthropic-ai/claude-agent-sdk";

// Sonnet, no Haiku (cambio pedido por Cal 2026-07-28): estos correos son hilos reenviados de
// trabajo, con contexto implícito y varios interlocutores — la síntesis alimenta una tarea real y
// se paga una sola vez por mail, así que la calidad importa más que el costo del turno.
const MODEL = "claude-sonnet-5";

export interface TaskExtractResult {
  resumen: string;
  accionRequerida: string;
  contextoRelevante: string | null;
  /** ISO yyyy-mm-dd — solo si el mail menciona una fecha límite CLARA. */
  deadline: string | null;
  /** ISO yyyy-mm-dd — solo si el mail indica EXPLÍCITAMENTE cuándo debe trabajarse. */
  fecha: string | null;
  /** true si el correo no deja una acción concreta pedida — la tarea se crea igual, como inbox
   * para revisión manual (spec: "no inventar... si no hay acción clara, crear como inbox"). */
  sinAccionClara: boolean;
}

/**
 * Tope duro del cuerpo que entra al prompt. Un hilo reenviado largo o un reporte pegado inline
 * arma un prompt enorme, y esa es exactamente la forma que produjo los cuatro incidentes de
 * "Autocompact is thrashing" documentados en CLAUDE.md — con el agravante de que acá ahora corre
 * Sonnet, no Haiku. Lo que importa para redactar la tarea está siempre arriba (el pedido), no en
 * la cola de citas del hilo.
 */
export const MAX_BODY_CHARS = 40_000;

/** Notion rechaza un rich_text de más de 2000 caracteres: un campo largo haría fallar la creación
 * de la página con un validation_error que Cal ve como "no pude crear la tarea" sin poder hacer
 * nada. El prompt pide "frase corta", pero eso no lo garantiza. */
const MAX_FIELD_CHARS = 1800;

export function buildExtractPrompt(subject: string, fechaRecepcionIso: string, bodyText: string): string {
  const cuerpo =
    bodyText.length > MAX_BODY_CHARS
      ? `${bodyText.slice(0, MAX_BODY_CHARS)}\n\n[…correo recortado: era más largo que ${MAX_BODY_CHARS} caracteres]`
      : bodyText;
  return [
    "Sos un asistente que convierte un correo reenviado por Cal en los campos de una tarea.",
    "Leé el correo y devolvé SOLO un objeto JSON, sin explicación ni fences.",
    "",
    "Reglas estrictas (no inventar):",
    "- No completes ni supongas nada que no esté literalmente en el correo.",
    "- No inventes fechas, responsables ni contexto que el correo no mencione.",
    '- "deadline" y "fecha" van null salvo que el correo indique una fecha CLARA y explícita',
    `  (resolvé fechas relativas — "para el viernes", "mañana" — contra la fecha de recepción: ${fechaRecepcionIso}).`,
    "",
    "Campos:",
    '- "resumen": síntesis corta (máx 280 caracteres) de la acción pedida. En español, breve y accionable.',
    '- "accionRequerida": frase corta con la acción concreta a hacer.',
    '- "contextoRelevante": contexto útil del correo (quién pide, por qué) o null si no agrega nada.',
    '- "deadline": fecha límite ISO yyyy-mm-dd, o null.',
    '- "fecha": fecha en que debe trabajarse ISO yyyy-mm-dd, o null.',
    '- "sinAccionClara": true si el correo NO deja una acción concreta pedida, false si sí.',
    "",
    `Asunto: ${subject}`,
    "Cuerpo:",
    cuerpo,
  ].join("\n");
}

function toIsoDateOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
}

export function parseExtractResult(raw: string): TaskExtractResult | null {
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

  const resumen = typeof obj["resumen"] === "string" ? obj["resumen"].trim() : "";
  const accionRequerida = typeof obj["accionRequerida"] === "string" ? obj["accionRequerida"].trim() : "";
  if (!resumen || !accionRequerida) return null;

  const contextoRaw = obj["contextoRelevante"];
  const contextoRelevante = typeof contextoRaw === "string" && contextoRaw.trim().length > 0 ? contextoRaw.trim() : null;

  return {
    resumen: resumen.slice(0, 280),
    accionRequerida: accionRequerida.slice(0, MAX_FIELD_CHARS),
    contextoRelevante: contextoRelevante ? contextoRelevante.slice(0, MAX_FIELD_CHARS) : null,
    deadline: toIsoDateOrNull(obj["deadline"]),
    fecha: toIsoDateOrNull(obj["fecha"]),
    sinAccionClara: obj["sinAccionClara"] === true,
  };
}

/** Corre la llamada real. Devuelve null si el modelo falla o responde algo inutilizable — el
 * caller debe crear igual la tarea como inbox sin síntesis (nunca perder el mail por esto). */
export async function extractTaskFields(
  subject: string,
  fechaRecepcionIso: string,
  bodyText: string,
): Promise<TaskExtractResult | null> {
  const handle = await startup({
    options: { model: MODEL, maxTurns: 1, allowedTools: [] },
  });

  let out = "";
  try {
    for await (const event of handle.query(buildExtractPrompt(subject, fechaRecepcionIso, bodyText))) {
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
