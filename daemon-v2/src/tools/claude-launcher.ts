import { spawn } from "node:child_process";
import { homedir } from "node:os";

/**
 * claude-launcher.ts — abrir un proyecto de Cal en VS Code o cmux desde Jano.
 *
 * Wrapper angosto de ~/.claude/skills/claude-launcher/scripts/claude-launcher-helper.sh
 * (mismo script que usa el skill claude-launcher en sesión interactiva) — Jano NO tiene
 * Bash (bloqueado en DISALLOWED_BUILTINS), así que esto spawnea el binario fijo del helper
 * en vez de exponerle shell genérico al LLM (mismo patrón que todoist.ts/qr-aduana/cine).
 *
 * `open -a "Visual Studio Code"` y `cmux new-workspace` no usan Apple Events, así que
 * deberían funcionar headless bajo launchd — mismo criterio que todoist.ts (sin dependencias
 * de Apple Events/TCC).
 */
const HELPER_BIN = `${homedir()}/.claude/skills/claude-launcher/scripts/claude-launcher-helper.sh`;
const TIMEOUT_MS = 40000; // open-parallel puede tardar ~25s (arranque de cmux + reintentos de new-workspace)

function run(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(HELPER_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      resolve({ ok: false, stdout, stderr: stderr || `timeout (${TIMEOUT_MS / 1000}s)` });
    }, TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err: Error) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: String(err) });
    });
    child.on("close", (code: number | null) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

export interface ClaudeProject {
  name: string;
  path: string;
  preparado: boolean;
}

function parseListOutput(stdout: string): ClaudeProject[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, path, status] = line.split("|");
      return { name, path, preparado: status === "preparado" };
    });
}

/** Lista los proyectos registrados en el Claude Launcher (fuente: ~/bin/claude-launcher-cli.sh). */
export async function listClaudeProjects(): Promise<string> {
  const res = await run(["list"]);
  if (!res.ok) return JSON.stringify({ ok: false, error: res.stderr.trim() || "no se pudo listar" });
  return JSON.stringify({ ok: true, proyectos: parseListOutput(res.stdout) });
}

export interface OpenClaudeProjectParams {
  nombre: string;
  /** Sin default a propósito — quien llama (agent-tools.ts) tiene que resolverlo siempre;
   *  el default vivía acá antes y permitía abrir VS Code en silencio sin que el LLM preguntara. */
  modo: "vscode" | "paralelo";
}

/**
 * Abre un proyecto en VS Code (modo "vscode") o en una sesión nueva de cmux (modo "paralelo"
 * — no deduplica, sirve para correr otro agente en simultáneo sobre la misma carpeta). El
 * nombre tiene que coincidir EXACTO (case-insensitive) con el de `list`.
 */
export async function openClaudeProject(p: OpenClaudeProjectParams): Promise<string> {
  const cmd = p.modo === "paralelo" ? "open-parallel" : "open";
  const res = await run([cmd, p.nombre]);
  if (!res.ok) {
    const listRes = await run(["list"]);
    return JSON.stringify({
      ok: false,
      error: res.stderr.trim() || "no se pudo abrir",
      proyectosDisponibles: listRes.ok ? parseListOutput(listRes.stdout).map((pr) => pr.name) : undefined,
    });
  }
  return JSON.stringify({ ok: true, salida: res.stdout.trim() });
}
