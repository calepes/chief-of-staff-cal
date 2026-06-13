import { spawn } from "node:child_process";

/**
 * things.ts — Things 3 desde el daemon (el agente no tiene Bash).
 *
 * IMPORTANTE — arquitectura híbrida por TCC bajo launchd:
 *  - LECTURAS via `clings` (lee el SQLite del contenedor de Things, FDA). OK headless.
 *  - ESCRITURAS via URL scheme `things:///…` con `open`. Las escrituras de `clings`
 *    usan osascript/JXA (Apple Events) → bajo launchd cuelgan esperando el permiso
 *    TCC de Automatización que no se puede responder en background. El URL scheme NO
 *    usa Apple Events → funciona headless. (Confirmado 2026-06-13.)
 *
 * `things:///add` NO requiere token; `things:///update`/`update-project` SÍ
 * (THINGS3_AUTH_TOKEN) — el wrapper lo agrega solo. El binario `clings` está
 * `brew pin`-eado (no actualizar: rompería el binding FDA del path versionado).
 */
const CLINGS_BIN = "/opt/homebrew/bin/clings";
const OPEN_BIN = "/usr/bin/open";
const TIMEOUT_MS = 15000;

function run(bin: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      reject(new Error(`${bin} timeout (15s).`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err: Error) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(new Error(`${bin} error: ${String(err)}`));
    });
    child.on("close", (code: number | null) => {
      if (timedOut) return;
      clearTimeout(timer);
      if (code === 0) resolve(stdout || "(ok, sin salida)");
      else reject(new Error(`${bin} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/** LECTURAS de Things via clings (SQLite). Subcomandos read-only: today/inbox/
 *  anytime/upcoming/someday/logbook/projects/areas/tags/search/show/stats/filter. */
export async function executeClings(args: string[]): Promise<string> {
  return run(CLINGS_BIN, args);
}

export interface ThingsWriteParams {
  command: "add" | "update" | "add-project" | "update-project";
  id?: string;          // requerido para update/update-project (uuid del --json de una lectura)
  title?: string;
  notes?: string;       // soporta saltos de línea — el wrapper los encodea
  when?: string;        // today | tomorrow | evening | anytime | someday | YYYY-MM-DD
  deadline?: string;    // YYYY-MM-DD
  tags?: string;        // coma-separados
  list?: string;        // (TAREAS/add) nombre de proyecto o área contenedora
  area?: string;        // (PROYECTOS/add-project/update-project) nombre del área (ej. "⚡️ Cal")
  checklistItems?: string; // saltos de línea entre ítems
  completed?: boolean;
  canceled?: boolean;
}

/** ESCRITURAS de Things via URL scheme (open). Headless-safe. */
export async function thingsWrite(p: ThingsWriteParams): Promise<string> {
  const parts: string[] = [];
  const add = (k: string, v: string) => parts.push(`${k}=${encodeURIComponent(v)}`);
  if (p.id) add("id", p.id);
  if (p.title) add("title", p.title);
  if (p.notes) add("notes", p.notes);
  if (p.when) add("when", p.when);
  if (p.deadline) add("deadline", p.deadline);
  if (p.tags) add("tags", p.tags);
  if (p.list) add("list", p.list);
  if (p.area) add("area", p.area);
  if (p.checklistItems) add("checklist-items", p.checklistItems);
  if (p.completed) add("completed", "true");
  if (p.canceled) add("canceled", "true");

  const needsToken = p.command === "update" || p.command === "update-project";
  if (needsToken) {
    const tok = process.env.THINGS3_AUTH_TOKEN;
    if (!tok) return JSON.stringify({ ok: false, error: "Falta THINGS3_AUTH_TOKEN para update." });
    add("auth-token", tok);
  }
  if ((p.command === "update" || p.command === "update-project") && !p.id) {
    return JSON.stringify({ ok: false, error: "update requiere 'id' (uuid de una lectura)." });
  }

  const url = `things:///${p.command}?${parts.join("&")}`;
  await run(OPEN_BIN, [url]);
  return JSON.stringify({
    ok: true,
    command: p.command,
    note: "Enviado a Things vía URL scheme. Si es crítico, verificá con una lectura (executeClings).",
  });
}
