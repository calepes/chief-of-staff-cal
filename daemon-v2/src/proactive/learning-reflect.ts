// proactive/learning-reflect.ts — pase nocturno de self-learning.
// Quinta excepción a la arquitectura reactiva de Jano (junto a health-sync-check,
// kpi-ingest-check, journal-sweep y daily-note-check). Corre una vez al día: una sola
// llamada a Haiku, costo despreciable. Reemplaza el diseño viejo donde el propio modelo
// decidía en medio del turno cuándo guardar un learning (4 entries en 3 meses — la
// reflexión in-turn compite con la tarea y pierde). Ver CLAUDE.md, "Automatización — dos capas".
//
// Mismo patrón que journal-sweep.ts (dedup en KV, misma estructura) — leerlo antes de tocar este.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import cron from "node-cron";
import { sendMessage } from "@cos/shared";
import type { CfKv } from "../cf-kv.js";
import { nowInLaPaz } from "../journal-capture.js";
import { renderBatch, type Card } from "../learning-card.js";
import { dedupeCandidates, parseLearnings, totalTokens } from "../learning-file.js";
import { extractLearnings } from "../learning-extract.js";
import { LearningStore } from "../learning-store.js";
import { buildDayTranscript } from "../learning-transcript.js";
import type { Learning, LearningCandidate } from "../learning-types.js";
import { pruneSessionLog, sessionIdsForDay, SESSION_LOG_PATH } from "../session-log.js";

/**
 * Directorio donde el Agent SDK persiste las sesiones .jsonl DE ESTE repo (uno por proyecto,
 * derivado del path absoluto con "/" -> "-"). Verificado con `ls -d` que existe de verdad —
 * si el path del repo cambia de nombre/ubicación, este directorio también cambia.
 */
export const SDK_SESSIONS_DIR = join(
  process.env.HOME!,
  ".claude",
  "projects",
  "-Users-calepes-Claude-Projects-Personal-Agents-Jano",
);

export const LEARNINGS_PATH = join(process.env.HOME!, ".cos-agent", "learnings.md");

const DEDUP_TTL_SEC = 48 * 60 * 60;

/**
 * Clave de dedup con la fecha en hora de La Paz — NUNCA getFullYear()/getMonth()/getDate() del
 * sistema. Este repo ya tuvo dos bugs por exactamente eso (fechas corriéndose al día siguiente
 * entre las 20:00 y medianoche hora de Cal cuando el cálculo se hacía en UTC/timezone del
 * proceso). Acá importa doble: la misma fecha decide además qué sesiones se leen — un desfase
 * haría que el pase de las 22:00 lea las sesiones del día equivocado.
 */
export function reflectDedupKey(now: Date = new Date()): string {
  return `jano:learning:reflect:${nowInLaPaz(now).slice(0, 10)}`;
}

export interface ReflectionDeps {
  sessionIds: string[];
  transcript: string;
  existentes: Learning[];
  extract: (transcript: string, existentes: Learning[]) => Promise<LearningCandidate[]>;
  createBatch: (candidates: LearningCandidate[], tokensActuales: number) => Promise<string>;
  send: (card: Card) => Promise<void>;
  log: (obj: Record<string, unknown>) => void;
}

/**
 * Lógica pura del pase nocturno, con TODAS las dependencias inyectadas — testeable de punta a
 * punta sin tocar el SDK, el disco ni la red.
 */
export async function runReflection(deps: ReflectionDeps, fecha: string): Promise<void> {
  const { sessionIds, transcript, existentes, extract, createBatch, send, log } = deps;

  if (sessionIds.length === 0) {
    log({ msg: "learning_reflect_no_sessions", fecha });
    return;
  }

  let candidates: LearningCandidate[];
  try {
    candidates = await extract(transcript, existentes);
  } catch (err) {
    // Un fallo del extractor no debe romper el cron ni dejar rastro en el chat de Cal —
    // mañana vuelve a correr.
    log({ msg: "learning_reflect_extract_failed", fecha, err: String(err) });
    return;
  }

  const frescos = dedupeCandidates(candidates, existentes);
  if (frescos.length === 0) {
    // Camino esperado la mayoría de los días.
    log({ msg: "learning_reflect_empty", fecha, raw: candidates.length });
    return;
  }

  const tokensActuales = totalTokens(existentes);
  const batchId = await createBatch(frescos, tokensActuales);
  const card = renderBatch(frescos, batchId, tokensActuales);
  await send(card);
  log({ msg: "learning_reflect_sent", fecha, count: frescos.length, raw: candidates.length });
}

export interface ScheduleOpts {
  kv: CfKv;
  botToken: string;
  chatId: number;
  log: (obj: Record<string, unknown>) => void;
}

/** Wrapper que arma las dependencias reales (disco, SDK, KV, Telegram) y llama a runReflection. */
export async function checkLearningReflect(opts: ScheduleOpts): Promise<void> {
  const { kv, botToken, chatId, log } = opts;
  const now = new Date();
  const dedupKey = reflectDedupKey(now);
  const fecha = dedupKey.slice("jano:learning:reflect:".length);

  try {
    if (await kv.get<boolean>(dedupKey)) return;

    const sessionIds = sessionIdsForDay(SESSION_LOG_PATH, fecha);
    const transcript = buildDayTranscript(SDK_SESSIONS_DIR, sessionIds);
    const existentesRaw = existsSync(LEARNINGS_PATH) ? readFileSync(LEARNINGS_PATH, "utf8") : "";
    const existentes = parseLearnings(existentesRaw);

    const store = new LearningStore(kv);

    const deps: ReflectionDeps = {
      sessionIds,
      transcript,
      existentes,
      extract: extractLearnings,
      createBatch: (candidates, tokensActuales) =>
        store.createBatch(chatId, {
          fecha,
          candidates,
          cursor: 0,
          tokensActuales,
          guardados: 0,
          descartados: 0,
        }),
      send: async (card) => {
        await sendMessage(botToken, { chatId, text: card.text, parseMode: "HTML", replyMarkup: card.keyboard });
      },
      log,
    };

    await runReflection(deps, fecha);
    await kv.set(dedupKey, true, DEDUP_TTL_SEC);
  } catch (err) {
    log({ msg: "learning_reflect_error", fecha, err: String(err) });
  } finally {
    pruneSessionLog(SESSION_LOG_PATH);
  }
}

export function scheduleLearningReflect(opts: ScheduleOpts): void {
  cron.schedule(
    "0 22 * * *",
    () => {
      void checkLearningReflect(opts).catch((err) =>
        opts.log({ msg: "learning_reflect_unhandled_error", err: String(err) }),
      );
    },
    { timezone: "America/La_Paz" },
  );
  opts.log({ msg: "learning_reflect_scheduled", interval: "daily 22:00" });
}
