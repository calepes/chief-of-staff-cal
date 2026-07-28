import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Mapa chatId → sessionId del Agent SDK, persistido en disco.
 *
 * Por qué existe: el daemon hace `startup()` fresco en cada mensaje (ver el comentario
 * de `takeWarm()` en index.ts — reusar un WarmQuery prefetcheado desregistra el MCP
 * in-process de cos-tools). Sin `resume`, cada turno arranca con contexto vacío y lo
 * único que sobrevive entre mensajes es el historial de TEXTO en CF KV (`state.ts`),
 * que nunca guarda los parámetros ni los resultados crudos de las tool calls.
 *
 * Ese gap es el bug del PNR de BoA (2026-07-14): Jano encontró el localizador dentro de
 * una tool call, respondió bien, pero el KV solo guardó el texto de la respuesta — que no
 * lo mencionaba — así que dos mensajes después se lo volvió a pedir a Cal.
 *
 * El SDK ya persiste la sesión COMPLETA (tool calls + resultados) en
 * `~/.claude/projects/<proyecto>/<sessionId>.jsonl`. Guardando el sessionId acá y
 * pasándolo como `resume`, el turno siguiente retoma ese contexto real en vez de
 * reconstruirlo desde 40 mensajes de texto.
 *
 * IO síncrono a propósito: se lee en el camino crítico, justo antes de `takeWarm()`, y
 * es un archivo de pocos KB. Un `await` acá retrasaría el arranque del subprocess del SDK,
 * que es exactamente lo que ese solapamiento intenta ganar.
 */

const SESSIONS_PATH = join(process.env.HOME!, ".cos-agent", "sessions.json");

/**
 * Mismo TTL que el historial en KV (`state.ts`), a propósito: los dos mecanismos
 * representan "la conversación en curso" y desincronizarlos daría el peor de los casos
 * — una sesión del SDK viva con un historial de texto ya vencido, o al revés.
 */
const TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Techo de turnos por sesión antes de arrancar una nueva.
 *
 * Por qué existe: `resume` reintroduce a propósito el crecimiento monotónico de contexto que la
 * arquitectura de "startup() fresco por mensaje" había eliminado. Ese modo de falla ya tumbó a Jano
 * CUATRO veces documentadas ("Autocompact is thrashing": Readwise 2026-05-23, FIFA ×2 2026-07-06,
 * BoA 2026-07-13) — el SDK aborta el turno y devuelve su texto de diagnóstico como si fuera la
 * respuesta. El TTL de 12 h no es un techo: en un día activo entran decenas de turnos.
 *
 * Al llegar al tope, el chat arranca sesión nueva y vuelve a apoyarse en el historial de texto de
 * KV — se pierde el detalle de tool calls viejas, pero no la conversación. Es exactamente el
 * comportamiento previo a este cambio, o sea el peor caso es "como antes", no peor que antes.
 *
 * 20 es conservador y ajustable con `JANO_MAX_SESSION_TURNS`. Señalado por daemon-health-reviewer
 * como decisión de diseño que había que tomar explícitamente en vez de dejar el resume sin freno.
 */
const DEFAULT_MAX_TURNS_PER_SESSION = 20;

function maxTurnsPerSession(): number {
  const raw = process.env.JANO_MAX_SESSION_TURNS;
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TURNS_PER_SESSION;
}

interface SessionRecord {
  id: string;
  ts: number;
  /** Turnos acumulados sobre esta sesión. Ausente en registros escritos antes del techo. */
  turns?: number;
}

type SessionsFile = Record<string, SessionRecord>;

function readAll(): SessionsFile {
  try {
    return JSON.parse(readFileSync(SESSIONS_PATH, "utf8")) as SessionsFile;
  } catch {
    // Archivo inexistente (primer arranque) o corrupto: arrancar de cero es seguro —
    // el peor caso es perder el resume de un turno y caer al historial de KV.
    return {};
  }
}

function writeAll(data: SessionsFile): void {
  try {
    mkdirSync(dirname(SESSIONS_PATH), { recursive: true });
    writeFileSync(SESSIONS_PATH, JSON.stringify(data), "utf8");
  } catch {
    // Nunca romper un turno por no poder persistir el sessionId: sin él, el turno
    // siguiente simplemente arranca sin resume y usa el historial de KV.
  }
}

/**
 * Devuelve el sessionId vigente del chat, o undefined si no hay, ya venció, o alcanzó el techo de
 * turnos. En los tres casos el turno arranca limpio y cae al historial de KV.
 */
export function loadSessionId(chatId: number): string | undefined {
  const rec = readAll()[String(chatId)];
  if (!rec) return undefined;
  if (Date.now() - rec.ts > TTL_MS) return undefined;
  if ((rec.turns ?? 0) >= maxTurnsPerSession()) {
    console.log(JSON.stringify({
      ts: Date.now(),
      msg: "session_turn_cap_reached",
      chatId,
      turns: rec.turns,
      cap: maxTurnsPerSession(),
    }));
    return undefined;
  }
  return rec.id;
}

/**
 * Guarda el sessionId del chat. Se llama después de CADA turno, no solo del primero:
 * el SDK puede forkear a un sessionId nuevo al retomar (`forkSession`), y quedarnos con
 * el viejo iría acumulando resumes sobre una sesión que ya no crece.
 *
 * De paso purga los registros vencidos de otros chats — sin esto el archivo crecería
 * sin techo con un registro muerto por cada chat que dejó de usarse.
 */
export function saveSessionId(chatId: number, id: string): void {
  const data = readAll();
  const cutoff = Date.now() - TTL_MS;
  for (const [key, rec] of Object.entries(data)) {
    if (rec.ts < cutoff) delete data[key];
  }
  const prev = data[String(chatId)];
  // El contador sigue a la SESIÓN, no al chat: si el SDK asignó un id nuevo (sesión fresca tras
  // el techo, o un fork), arranca de 1. Si es la misma sesión, incrementa.
  const turns = prev && prev.id === id ? (prev.turns ?? 0) + 1 : 1;
  data[String(chatId)] = { id, ts: Date.now(), turns };
  writeAll(data);
}

/** Olvida la sesión del chat. Lo usa `/reset`, que debe limpiar KV *y* sesión del SDK. */
export function clearSessionId(chatId: number): void {
  const data = readAll();
  delete data[String(chatId)];
  writeAll(data);
}
