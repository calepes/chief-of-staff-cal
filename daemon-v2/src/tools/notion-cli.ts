/**
 * notion-cli.ts — wrapper de `ntn` CLI para que el daemon use Notion vía CLI
 * en vez del MCP heredado. Patrón tool-wrapper (el agente no tiene Bash).
 *
 * Auth: token de integración del daemon (`NOTION_TOKEN`) pasado por env
 * `NOTION_API_TOKEN` (override del Keychain → sin TCC bajo launchd).
 * NO setear NOTION_KEYRING=0: fuerza auth de archivo e ignora el token env.
 *
 * ⚠️ Alcance: la integración "Claude CoS" solo ve páginas COMPARTIDAS con ella.
 * Si un call devuelve 403/vacío, compartir esa página/DB con la integración en Notion.
 */
import { spawnSync } from "node:child_process";

const NTN = "/opt/homebrew/bin/ntn";
const VERSION = "2022-06-28";

function token(): string {
  return process.env.NOTION_TOKEN ?? "";
}

function runNtn(args: string[]): Record<string, unknown> {
  const tok = token();
  if (!tok) return { error: "Falta NOTION_TOKEN en el env del daemon." };
  const r = spawnSync(NTN, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 5_000_000,
    env: { ...process.env, NOTION_API_TOKEN: tok },
  });
  if (r.error) return { error: "No se pudo ejecutar ntn", detail: String(r.error) };
  if (r.status !== 0) {
    return { error: "ntn falló", detail: (r.stderr || r.stdout || "").trim().slice(0, 500) };
  }
  const out = r.stdout.trim();
  if (!out) return { ok: true };
  try {
    return JSON.parse(out);
  } catch {
    return { markdown: out }; // `ntn pages get` devuelve Markdown, no JSON
  }
}

/**
 * Serializa el body para `ntn api -d`.
 *
 * El schema del tool declara `body` como objeto, pero el modelo manda un STRING con JSON adentro
 * bastante seguido. Con un `JSON.stringify()` a secas eso se doble-encodea — `{"a":1}` sale como
 * `"{\"a\":1}"`, o sea un string JSON, no un objeto — y Notion responde `400 invalid_json`.
 *
 * No es teórico: pasó en dos turnos reales de Cal (2026-07-27), 14 llamadas fallidas entre los dos,
 * uno de ellos muerto por agotar los turnos y el otro respondiendo sin datos tras 233 s y $1.55.
 * Desde afuera se ve como "Jano no puede leer Notion", sin ninguna pista del motivo.
 *
 * Un string que ya es JSON válido se pasa tal cual. Uno que NO es JSON se stringifica, porque ahí
 * la intención sí era mandar un string literal.
 */
function serializeBody(body: unknown): string {
  if (typeof body !== "string") return JSON.stringify(body);
  try {
    JSON.parse(body);
    return body;
  } catch {
    return JSON.stringify(body);
  }
}

/** Llamada genérica a la API de Notion. path tipo "/v1/databases/ID/query". */
export function notionApi(method: string, path: string, body?: unknown): Record<string, unknown> {
  const args = ["api", "-X", method, path, "--notion-version", VERSION];
  if (body !== undefined && body !== null) args.push("-d", serializeBody(body));
  return runNtn(args);
}

/** Exportado solo para tests. */
export const __serializeBodyForTest = serializeBody;

/** Lee el body de una página como Markdown. */
export function notionPageMarkdown(pageId: string): Record<string, unknown> {
  return runNtn(["pages", "get", pageId]);
}

/** Reemplaza el body de una página con Markdown (REEMPLAZA todo el body). */
export function notionUpdateBody(pageId: string, markdown: string): Record<string, unknown> {
  return runNtn(["pages", "update", pageId, "--content", markdown, "--allow-deleting-content"]);
}
