import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

/**
 * Effort — cuánto piensa y cuánto explora el modelo antes de responder.
 *
 * Estuvo sin setear hasta el 2026-07-27 (se usaba el default del modelo). Es el dial que evita
 * tener que elegir entre "Sonnet barato para todo" y "Opus caro para todo": el mismo modelo
 * rinde distinto según el effort, y un "¿qué tengo en la agenda?" no necesita lo mismo que
 * "proyectá cuándo llegamos a 5MM transacciones".
 */

const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function isValidEffort(v: string | undefined): v is EffortLevel {
  return v !== undefined && (VALID_EFFORTS as readonly string[]).includes(v);
}

/**
 * Default de un turno normal. `high` es el punto de equilibrio recomendado para trabajo agéntico.
 * `xhigh` queda para cuando Cal lo pide explícitamente, porque consume bastante más de la cuota de
 * Claude Max — la MISMA cuota que Cal usa en sus sesiones interactivas, no un presupuesto aparte.
 *
 * Es una FUNCIÓN, no un `const` de módulo, por orden de evaluación en ESM: el cuerpo de este módulo
 * corre ANTES que el de `index.ts`, que es donde se llama `loadEnv()`. Como `const`, un
 * `JANO_EFFORT` puesto en `~/.cos-agent/.env` o en `apps.env` se leía siempre como `undefined` y se
 * ignoraba en silencio — solo funcionaba vía `EnvironmentVariables` del plist. Señalado por
 * daemon-health-reviewer.
 *
 * Un valor inválido (typo tipo "higth") se descarta con un log en vez de pasarse al SDK: si
 * `startup()` lo rechaza, el turno muere en TODOS los chats, no solo en uno.
 */
export function defaultEffort(): EffortLevel {
  const fromEnv = process.env.JANO_EFFORT;
  if (fromEnv === undefined || fromEnv === "") return "high";
  if (isValidEffort(fromEnv)) return fromEnv;
  console.log(JSON.stringify({
    ts: Date.now(),
    msg: "invalid_jano_effort",
    value: fromEnv,
    validos: VALID_EFFORTS,
    usando: "high",
  }));
  return "high";
}

/**
 * Prefijos con los que Cal sube el effort de un turno puntual.
 *
 * Deliberadamente EXPLÍCITOS en vez de una heurística que adivine si un mensaje "parece
 * analítico": una heurística mal calibrada gastaría cuota de más sin que Cal entienda por qué,
 * y al fallar hacia el otro lado dejaría los pedidos difíciles en effort bajo justo cuando más
 * importa. Con un prefijo, la decisión es de Cal y es visible.
 */
const DEEP_PREFIXES = ["/deep", "/fondo", "++"];

export interface EffortDecision {
  effort: EffortLevel;
  /** El mensaje sin el prefijo — es lo que se le manda al modelo. */
  text: string;
}

/** Decide el effort del turno y devuelve el texto ya sin prefijo. */
export function effortForMessage(text: string): EffortDecision {
  const trimmed = text.trimStart();
  const lower = trimmed.toLowerCase();
  for (const prefix of DEEP_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { effort: "xhigh", text: trimmed.slice(prefix.length).trimStart() };
    }
  }
  return { effort: defaultEffort(), text };
}
