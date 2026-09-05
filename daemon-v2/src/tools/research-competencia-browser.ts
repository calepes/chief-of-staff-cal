import { spawn, type ChildProcess } from "node:child_process";
import { accessSync } from "node:fs";
import { createServer } from "node:net";
import { chromium, type Browser, type BrowserContext } from "playwright";

// Chrome REAL (no el Chromium que trae Playwright) con un perfil propio persistente, conectado vía
// CDP — mismo patrón validado en `boa-checkin` (servers/boa-checkin/src/browser.ts): ese spike
// encontró que `chromium.launch()` propio es bloqueado por el WAF de BoA, pero conectando a un
// Chrome real vía CDP no lo es. Acá el motivo es distinto (detección de bot de Instagram/TikTok/
// Facebook/X con Chromium headless, no un WAF puntual — ver el research-competencia-cookies.ts que
// este módulo REEMPLAZA), pero el mecanismo que lo resuelve es el mismo.
//
// La sesión vive en el PERFIL, no en cookies inyectadas: a diferencia del diseño anterior (leer
// Cookies.binarycookies de Safari con FDA), acá Cal se loguea UNA VEZ en este perfil dedicado
// (`scripts/research-competencia-chrome-login.ts`, a mano, con ventana visible) y Chrome persiste
// la sesión en disco entre corridas — ya no hace falta Full Disk Access ni el Cookie Broker para
// esto. Perfil separado del de `boa-checkin` (`~/.boa-checkin/chrome-profile`) y del Chrome
// personal de Cal — nunca se toca su navegación real.
const CHROME_PATHS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
const PROFILE_DIR = `${process.env.HOME}/.cos-agent/research-competencia-chrome-profile`;

function resolveChromePath(): string {
  for (const p of CHROME_PATHS) {
    try {
      accessSync(p);
      return p;
    } catch {
      /* probar siguiente */
    }
  }
  throw new Error("No se encontró el binario de Google Chrome en las rutas conocidas.");
}

/** Pide al SO un puerto TCP libre, lo liga un instante y lo suelta — mismo helper que
 * `boa-checkin/src/port.ts`, duplicado acá (9 líneas) en vez de una dependencia cross-package
 * entre dos workspaces npm separados por 9 líneas. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no address")));
      }
    });
  });
}

async function waitForCdp(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* Chrome todavía no levantó el puerto */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome no respondió en el puerto CDP ${port} después de ${timeoutMs}ms.`);
}

export interface ResearchBrowserSession {
  context: BrowserContext;
  close(): Promise<void>;
}

export interface OpenBrowserSessionOpts {
  /** Default true (el cron real corre desatendido, sin sesión gráfica activa que tolere una
   * ventana). `scripts/research-competencia-chrome-login.ts` pasa `false` a propósito — Cal
   * necesita VER la ventana para loguearse a mano la primera vez. */
  headless?: boolean;
}

/** Lanza (o reusa) el Chrome del perfil dedicado y conecta Playwright vía CDP. */
export async function openResearchBrowserSession(opts: OpenBrowserSessionOpts = {}): Promise<ResearchBrowserSession> {
  const headless = opts.headless ?? true;
  const port = await findFreePort();
  const chromePath = resolveChromePath();

  const proc: ChildProcess = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${PROFILE_DIR}`,
      ...(headless ? ["--headless=new"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );

  try {
    await waitForCdp(port);
  } catch (err) {
    proc.kill();
    throw err;
  }

  const browser: Browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());

  return {
    context,
    async close() {
      await browser.close().catch(() => {});
      proc.kill();
    },
  };
}
