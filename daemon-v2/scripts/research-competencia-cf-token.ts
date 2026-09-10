import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// scripts/research-competencia-cf-token.ts — resuelve el token de Cloudflare + el database ID de
// D1 desde 1Password para research-competencia-now.ts / setup-d1-research-competencia.ts. Mismo
// patrón que research-competencia-apify-token.ts (ver ese archivo para el porqué del mecanismo:
// Service Account de solo lectura del daemon, sin `op run` para todo el script).
//
// Por qué UN ítem con DOS campos, y no dos resolvers: `credential` (token CF) y `database_id`
// vienen del MISMO ítem 1Password ("Research Competencia D1", vault Daemons) y siempre se usan
// juntos (sin uno, D1 no funciona igual) — se leen y se devuelven como una sola unidad.
//
// Reemplaza el patrón viejo (leer DIGEST_CF_API_TOKEN/D1_RESEARCH_COMPETENCIA_DATABASE_ID de
// apps.env en texto plano) por pedido explícito de Cal 2026-09-09 — el ítem 1Password ya existe,
// confirmado con `op item get "Research Competencia D1" --vault Daemons`.

const TOKEN_FILE_PATH = `${process.env.HOME}/.claude/secrets/op-service-account-token-daemons`;
const CREDENTIAL_OP_REF = "op://Daemons/Research Competencia D1/credential";
const DATABASE_ID_OP_REF = "op://Daemons/Research Competencia D1/database_id";

export interface D1CredentialsResult {
  token: string;
  databaseId: string;
}

export interface D1CredentialsDeps {
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
 * Devuelve `{ token, databaseId }` leídos del vault `Daemons`, o `null` ante cualquier problema
 * (archivo del Service Account ausente/vacío, `op` no instalado, vault inaccesible, cualquiera de
 * los dos campos vacío). Fail-soft por diseño, igual que `resolveApifyToken()` — nunca tira: el
 * caller sigue corriendo igual sin D1 esta corrida (mismo criterio de
 * `research_competencia_d1_missing_config` en research-competencia-d1.ts, que es la red de
 * seguridad final si esto tampoco resuelve nada).
 */
export function resolveD1Credentials(deps: Partial<D1CredentialsDeps> = {}): D1CredentialsResult | null {
  const readTokenFile = deps.readTokenFile ?? readTokenFileReal;
  const readFromOnePassword = deps.readFromOnePassword ?? readFromOnePasswordReal;
  try {
    const serviceAccountToken = readTokenFile();
    if (!serviceAccountToken) throw new Error("token del Service Account vacío");
    const token = readFromOnePassword(serviceAccountToken, CREDENTIAL_OP_REF);
    const databaseId = readFromOnePassword(serviceAccountToken, DATABASE_ID_OP_REF);
    if (!token || !databaseId) return null;
    return { token, databaseId };
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_d1_token_resolve_error", err: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}
