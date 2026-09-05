import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// scripts/research-competencia-apify-token.ts — resuelve APIFY_TOKEN desde 1Password para
// research-competencia-now.ts. Separado del script principal por el mismo motivo que
// research-competencia-env.ts/-notify.ts: testeable sin pagar los side effects de import de
// research-competencia-now.ts (loadEnv, delete ANTHROPIC_API_KEY).
//
// Por qué esto y no sumar APIFY_TOKEN a apps.env como las otras 3 credenciales del script
// (OPENROUTER_API_KEY/ELEVENLABS_API_KEY/NOTIF_BOT_TOKEN, ver research-competencia-env.ts): esas
// son deuda YA documentada (Jano migró a 1Password; este script standalone, invocado directo por
// node-fda desde el plist sin pasar por `op run`, todavía no). APIFY_TOKEN es un secreto NUEVO —
// la regla dura del repo (Personal/Agents/CLAUDE.md: "cualquier secreto NUEVO de un agente va
// directo al vault Daemons, nunca a un .env nuevo") aplica de lleno acá. Sin tocar el plist/wrapper
// de producción (ver apps-env.1password.tpl, que sí tiene la referencia para cuando este script
// se rutee por `op run` algún día), se resuelve con una llamada puntual a `op read` usando el
// MISMO Service Account de solo lectura que usa el daemon
// (`~/.claude/secrets/op-service-account-token-daemons`) — no requiere desbloqueo interactivo de
// la app de 1Password, funciona igual bajo un cron desatendido de launchd.

const TOKEN_FILE_PATH = `${process.env.HOME}/.claude/secrets/op-service-account-token-daemons`;
const APIFY_OP_REF = "op://Daemons/Apify/credential";

export interface ApifyTokenDeps {
  /** Lee el archivo del token del Service Account — inyectable para testear sin filesystem real. */
  readTokenFile: () => string;
  /** Corre `op read` con ese Service Account — inyectable para testear sin `op` real. */
  readFromOnePassword: (serviceAccountToken: string) => string;
}

function readTokenFileReal(): string {
  return readFileSync(TOKEN_FILE_PATH, "utf8").trim();
}

function readFromOnePasswordReal(serviceAccountToken: string): string {
  return execFileSync("op", ["read", APIFY_OP_REF], {
    env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: serviceAccountToken },
    encoding: "utf8",
  }).trim();
}

/**
 * Devuelve el valor de APIFY_TOKEN leído del vault `Daemons`, o `null` ante cualquier problema
 * (archivo del Service Account ausente/vacío, `op` no instalado, vault inaccesible, credencial sin
 * permiso). Fail-soft por diseño, igual que el resto de las fuentes opcionales del research: nunca
 * tira — el caller (research-competencia-now.ts) sigue corriendo igual sin este dato, y
 * Facebook/TikTok orgánico quedan sin datos esta corrida (mismo criterio de
 * `research_competencia_apify_missing_token` en research-competencia-apify.ts, que es la red de
 * seguridad final si esto tampoco resuelve nada).
 */
export function resolveApifyToken(deps: Partial<ApifyTokenDeps> = {}): string | null {
  const readTokenFile = deps.readTokenFile ?? readTokenFileReal;
  const readFromOnePassword = deps.readFromOnePassword ?? readFromOnePasswordReal;
  try {
    const serviceAccountToken = readTokenFile();
    if (!serviceAccountToken) throw new Error("token del Service Account vacío");
    const apifyToken = readFromOnePassword(serviceAccountToken);
    return apifyToken || null;
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_apify_token_resolve_error", err: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}
