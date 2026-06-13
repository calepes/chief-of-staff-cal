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

/** Llamada genérica a la API de Notion. path tipo "/v1/databases/ID/query". */
export function notionApi(method: string, path: string, body?: unknown): Record<string, unknown> {
  const args = ["api", "-X", method, path, "--notion-version", VERSION];
  if (body !== undefined && body !== null) args.push("-d", JSON.stringify(body));
  return runNtn(args);
}

/** Lee el body de una página como Markdown. */
export function notionPageMarkdown(pageId: string): Record<string, unknown> {
  return runNtn(["pages", "get", pageId]);
}

/** Reemplaza el body de una página con Markdown (REEMPLAZA todo el body). */
export function notionUpdateBody(pageId: string, markdown: string): Record<string, unknown> {
  return runNtn(["pages", "update", pageId, "--content", markdown, "--allow-deleting-content"]);
}
