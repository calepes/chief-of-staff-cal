import { spawn } from "node:child_process";

const REMCTL_BIN = "/Users/calepes/bin/remctl";
const TIMEOUT_MS = 10000;

export async function executeRemctl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(REMCTL_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/Users/calepes/bin" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      reject(new Error("remctl timeout (10s). Si persiste: remctl doctor --for-agent"));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("error", (err: Error) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(new Error(`remctl error: ${String(err)}`));
    });

    child.on("close", (code: number | null) => {
      if (timedOut) return;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`remctl exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}
