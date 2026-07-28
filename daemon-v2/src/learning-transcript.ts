// learning-transcript.ts — lectura recortada de los .jsonl que el Agent SDK persiste por sesión.
//
// Qué se conserva y por qué (fuente de los learnings del cron nocturno):
// - Texto de Cal y de Jano: de ahí salen preferencias, hechos y flujos.
// - NOMBRE de cada tool call, sin el payload: el payload satura el transcript sin enseñar nada
//   (ver el test de notionApi con un input de 5000 chars — solo debe quedar "TOOL notionApi").
// - Mensaje de error de los tool calls fallidos: ESTA es la fuente de los learnings tipo "err",
//   los que Cal no puede notar desde Telegram porque el fallo ocurre puertas adentro del daemon.
// - Resultado de un tool exitoso: se descarta ENTERO. Es el grueso del archivo (verificado sobre
//   sesiones reales) y no enseña nada sobre Cal ni sobre cómo falla Jano.
//
// Gotcha verificado contra 40 sesiones reales del SDK: `message.content` NO siempre es un array.
// En 144 casos (todos de rol "user") viene como STRING PLANO — o sea los mensajes de Cal, la
// fuente principal de learnings de preferencia. Un `if (!Array.isArray(content)) continue` los
// descartaría en silencio, con todos los tests en verde si los fixtures solo cubren la forma de
// array. Por eso `content` string se trata como texto del rol correspondiente, no se ignora.
//
// También verificado: `is_error` en los bloques `tool_result` SÍ existe de forma consistente
// (381 de 1067 bloques lo traen, 27 en `true`), así que detectarlo por ese campo es correcto.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Tope del transcript final que se manda a Haiku. */
const MAX_TRANSCRIPT_CHARS = 60_000;
/** Tope por bloque de texto (Cal/Jano), para que un mensaje gigante no ahogue al resto. */
const MAX_TEXT_CHARS = 1_500;
/** Tope del mensaje de error de un tool fallido. */
const MAX_ERROR_CHARS = 300;

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  is_error?: boolean;
  content?: unknown;
}

interface SdkEvent {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function roleLabel(role: string | undefined): "CAL" | "JANO" | null {
  if (role === "user") return "CAL";
  if (role === "assistant") return "JANO";
  return null;
}

/** El content de un tool_result puede ser string o un array de bloques con `.text`. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as ContentBlock).text === "string" ? (b as ContentBlock).text : ""))
      .filter((s): s is string => Boolean(s))
      .join(" ");
  }
  return "";
}

function linesFromEvent(event: SdkEvent): string[] {
  const message = event.message;
  if (!message) return [];
  const label = roleLabel(message.role);
  const content = message.content;

  const lines: string[] = [];

  if (typeof content === "string") {
    const text = content.trim();
    if (text.length > 0 && label) {
      lines.push(`${label}: ${truncate(text, MAX_TEXT_CHARS)}`);
    }
    return lines;
  }

  if (!Array.isArray(content)) return lines;

  for (const block of content as ContentBlock[]) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text" && typeof block.text === "string") {
      const text = block.text.trim();
      if (text.length > 0 && label) {
        lines.push(`${label}: ${truncate(text, MAX_TEXT_CHARS)}`);
      }
      continue;
    }

    if (block.type === "tool_use" && typeof block.name === "string") {
      lines.push(`TOOL ${block.name}`);
      continue;
    }

    if (block.type === "tool_result" && block.is_error === true) {
      const errText = toolResultText(block.content).trim();
      if (errText.length > 0) {
        lines.push(`TOOL ERROR: ${truncate(errText, MAX_ERROR_CHARS)}`);
      }
      continue;
    }

    // tool_result exitoso (is_error falsy) y cualquier otro bloque: se ignora a propósito.
  }

  return lines;
}

/** Lee un .jsonl de sesión y devuelve el transcript recortado. Vacío si no existe o está corrupto. */
export function readTranscript(path: string): string {
  if (!existsSync(path)) return "";

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "";
  }

  const lines: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: SdkEvent;
    try {
      event = JSON.parse(line) as SdkEvent;
    } catch {
      continue; // línea corrupta: se ignora, no debe tumbar el resto del archivo.
    }
    lines.push(...linesFromEvent(event));
  }

  return lines.join("\n");
}

/**
 * Concatena el transcript de las sesiones del día indicadas (solo las del daemon, ver
 * session-log.ts). Si el resultado excede el tope, conserva la COLA: lo más reciente del día
 * es lo más representativo para el cron nocturno, no el principio.
 */
export function buildDayTranscript(dir: string, sessionIds: string[]): string {
  const parts: string[] = [];
  for (const id of sessionIds) {
    const t = readTranscript(join(dir, `${id}.jsonl`));
    if (t.length === 0) continue;
    parts.push(`--- sesión ${id} ---\n${t}`);
  }

  const full = parts.join("\n\n");
  if (full.length <= MAX_TRANSCRIPT_CHARS) return full;
  return full.slice(full.length - MAX_TRANSCRIPT_CHARS);
}
