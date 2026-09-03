// Validación de las 3 credenciales que este script necesita, separada del script principal por
// el mismo motivo que research-competencia-notify.ts: para poder testearla sin pagar los side
// effects de import de research-competencia-now.ts (loadEnv, delete ANTHROPIC_API_KEY).

export interface RequiredEnvVar {
  key: string;
  /** Para qué se usa + dónde debería vivir, para que el mensaje de error sea accionable sin abrir código. */
  hint: string;
}

// Jano ya está migrado a 1Password (vault `Daemons`) — el día que se limpie apps.env en texto
// plano, `vision.ts` (OPENROUTER_API_KEY) y whisper.ts (ELEVENLABS_API_KEY) tragan el error
// tool-por-tool y el informe sale sin análisis de imágenes/video en silencio; NOTIF_BOT_TOKEN
// faltante ya se reporta solo (research-competencia-notify.ts), pero recién DESPUÉS de correr
// el research entero. Validar acá, antes de arrancar, falla fuerte y temprano en vez de a mitad
// de camino y en silencio.
export const REQUIRED_ENV_VARS: RequiredEnvVar[] = [
  { key: "OPENROUTER_API_KEY", hint: "análisis de imágenes (vision.ts) — vault Daemons en 1Password / ~/.claude/secrets/apps.env" },
  { key: "ELEVENLABS_API_KEY", hint: "transcripción de video (whisper.ts) — vault Daemons en 1Password / ~/.claude/secrets/apps.env" },
  { key: "NOTIF_BOT_TOKEN", hint: "notificación por @ClaudeCalbot — vault Daemons en 1Password / ~/.claude/notifications/.env" },
];

/** Devuelve las vars de REQUIRED_ENV_VARS que faltan en `env`. Pura — sin leer process.env directo, para poder testear sin mutar el proceso real. */
export function findMissingEnvVars(env: NodeJS.ProcessEnv): RequiredEnvVar[] {
  return REQUIRED_ENV_VARS.filter((v) => !env[v.key]);
}

export function formatMissingEnvError(missing: RequiredEnvVar[]): string {
  const lineas = missing.map((v) => `  - ${v.key}: ${v.hint}`);
  return `Faltan variables de entorno requeridas:\n${lineas.join("\n")}`;
}
