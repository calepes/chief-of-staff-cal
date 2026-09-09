import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Resuelve CF_API_TOKEN_D1_RESEARCH_COMPETENCIA desde 1Password para research-competencia-now.ts.
// Secreto NUEVO (2026-09-08) → vault Daemons, mismo criterio que APIFY_TOKEN
// (research-competencia-apify-token.ts) y la regla dura de Personal/Agents/CLAUDE.md.

const TOKEN_FILE_PATH = `${process.env.HOME}/.claude/secrets/op-service-account-token-daemons`;
const CF_D1_OP_REF = "op://Daemons/Research Competencia D1/credential";

export interface CfD1TokenDeps {
  readTokenFile: () => string;
  readFromOnePassword: (serviceAccountToken: string) => string;
}

function readTokenFileReal(): string {
  return readFileSync(TOKEN_FILE_PATH, "utf8").trim();
}

function readFromOnePasswordReal(serviceAccountToken: string): string {
  return execFileSync("op", ["read", CF_D1_OP_REF], {
    env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: serviceAccountToken },
    encoding: "utf8",
  }).trim();
}

/**
 * Devuelve el token de Cloudflare (scope D1:Edit) para research-competencia, o `null` ante
 * cualquier problema. Fail-soft por diseño — research-competencia-now.ts sigue corriendo igual sin esto.
 * El histórico de posts queda sin actualizarse esta corrida, nada más.
 */
export function resolveD1Token(deps: Partial<CfD1TokenDeps> = {}): string | null {
  const readTokenFile = deps.readTokenFile ?? readTokenFileReal;
  const readFromOnePassword = deps.readFromOnePassword ?? readFromOnePasswordReal;
  try {
    const serviceAccountToken = readTokenFile();
    if (!serviceAccountToken) throw new Error("token del Service Account vacío");
    const cfToken = readFromOnePassword(serviceAccountToken);
    return cfToken || null;
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_d1_token_resolve_error", err: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}
