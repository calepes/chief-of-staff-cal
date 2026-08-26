import { spawn } from "node:child_process";

/**
 * todoist.ts — Todoist desde el daemon (el agente no tiene Bash).
 *
 * A diferencia de Things (ver el `things.ts` que reemplaza — conservado en git history),
 * `td` es un CLI HTTP puro (auth vía token en macOS Keychain, sin AppleScript/Apple Events)
 * → no hay split lectura/escritura por TCC. Confirmado headless bajo env stripeado
 * (simulando launchd) el 2026-08-26: `td project list --json` funciona sin prompt.
 */
const TD_BIN = "/Users/calepes/.npm-global/bin/td";
const TIMEOUT_MS = 15000;

export async function executeTd(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(TD_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `/usr/local/bin:/Users/calepes/.npm-global/bin:/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      reject(new Error(`td timeout (15s).`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err: Error) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(new Error(`td error: ${String(err)}`));
    });
    child.on("close", (code: number | null) => {
      if (timedOut) return;
      clearTimeout(timer);
      // td devuelve JSON de error con exit code != 0 en fallos de validación — no tratar como excepción.
      resolve(stdout || stderr || "(ok, sin salida)");
    });
  });
}
