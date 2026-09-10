import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// scripts/research-competencia-shared-secrets.ts — resuelve las 3 credenciales compartidas que
// research-competencia-now.ts YA carga desde apps.env en texto plano (OPENROUTER_API_KEY,
// ELEVENLABS_API_KEY, NOTIF_BOT_TOKEN — ver research-competencia-env.ts), pero ahora desde el
// vault `Daemons` de 1Password. Pedido explícito de Cal 2026-09-09: los 4 ítems ya existen ahí
// (los usa el daemon real vía apps-env.1password.tpl) — no hace falta crear nada nuevo.
//
// A diferencia de APIFY_TOKEN/D1 (secretos NUEVOS, sin ningún valor previo), acá apps.env YA tiene
// una copia funcionando de estos 3 — por eso el caller (research-competencia-now.ts) sigue cargando
// apps.env primero y solo SOBREESCRIBE con el valor de 1Password si la resolución funciona. Mismo
// mecanismo de Service Account de solo lectura que resolveApifyToken/resolveD1Credentials — sin
// desbloqueo interactivo, funciona igual bajo el cron desatendido de launchd.

const TOKEN_FILE_PATH = `${process.env.HOME}/.claude/secrets/op-service-account-token-daemons`;

const SHARED_SECRETS: Array<{ envVar: string; ref: string }> = [
  { envVar: "OPENROUTER_API_KEY", ref: "op://Daemons/OpenRouter/credential" },
  { envVar: "ELEVENLABS_API_KEY", ref: "op://Daemons/ElevenLabs/credential" },
  { envVar: "NOTIF_BOT_TOKEN", ref: "op://Daemons/Notifications Bot Token/credential" },
];

export interface SharedSecretsDeps {
  /** Lee el archivo del token del Service Account — inyectable para testear sin filesystem real. */
  readTokenFile: () => string;
  /** Corre `op read` sobre una referencia dada con ese Service Account — inyectable para testear sin `op` real. */
  readFromOnePassword: (serviceAccountToken: string, ref: string) => string;
}

function readTokenFileReal(): string {
  return readFileSync(TOKEN_FILE_PATH, "utf8").trim();
}

function readFromOnePasswordReal(serviceAccountToken: string, ref: string): string {
  return execFileSync("op", ["read", ref], {
    env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: serviceAccountToken },
    encoding: "utf8",
  }).trim();
}

/**
 * Devuelve un Map envVar->valor solo para las credenciales que se pudieron leer del vault
 * `Daemons`. Fail-soft POR CREDENCIAL (no todo-o-nada): si el archivo del Service Account falta o
 * `op` no está instalado, devuelve un Map vacío entero; si el Service Account funciona pero UNA
 * referencia puntual falla (ítem renombrado, permiso revocado), esa queda afuera del Map y las
 * demás se resuelven igual — el caller (research-competencia-now.ts) ya tiene el valor de
 * apps.env cargado como red de seguridad para lo que falte acá.
 */
export function resolveSharedSecrets(deps: Partial<SharedSecretsDeps> = {}): Map<string, string> {
  const readTokenFile = deps.readTokenFile ?? readTokenFileReal;
  const readFromOnePassword = deps.readFromOnePassword ?? readFromOnePasswordReal;
  const result = new Map<string, string>();
  let serviceAccountToken: string;
  try {
    serviceAccountToken = readTokenFile();
    if (!serviceAccountToken) throw new Error("token del Service Account vacío");
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_shared_secrets_resolve_error", err: err instanceof Error ? err.message : String(err) }));
    return result;
  }
  for (const { envVar, ref } of SHARED_SECRETS) {
    try {
      const value = readFromOnePassword(serviceAccountToken, ref);
      if (value) result.set(envVar, value);
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_shared_secret_resolve_error", envVar, err: err instanceof Error ? err.message : String(err) }));
    }
  }
  return result;
}
