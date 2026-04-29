// Tool runBriefing: dispara on-demand un subprocess `claude -p /briefing-pais`
// Reusa el mismo comando que el cron `com.claude.daily-briefings` (`~/.claude/hooks/daily-briefing.sh`)
// pero permite invocación desde Telegram via tool del LLM.
//
// Async: el tool retorna inmediatamente "started"; el child process se encarga
// de notificar a Telegram cuando termina (el prompt mismo incluye la notif).
// Si el child falla (timeout/exit≠0), este módulo manda un mensaje de error.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sendMessage } from "@cos/shared";

const LOCK_DIR = path.join(process.env.HOME!, ".cos-agent", "briefing-locks");
const PROJECT_DIR = "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal";
const GITHUB_PAGES_DIR = "/Users/calepes/Documents/Claude Projects/Personal/Apps/calepes.github.io";
const CLAUDE_BIN = "/Users/calepes/.local/bin/claude";
const TIMEOUT_SEC = 900; // 15 min, igual que el cron

const TZ_BY_PAIS: Record<string, string> = {
  Bolivia: "America/La_Paz",
  Peru: "America/Lima",
  Colombia: "America/Bogota",
};

export interface BriefingDeps {
  botToken: string;
}

export interface RunBriefingArgs {
  pais: string;
  fecha?: string;
}

export interface RunBriefingResult {
  status: "started" | "already_running" | "error";
  pais: string;
  fecha: string;
  message: string;
}

interface LockData {
  pid: number;
  pais: string;
  fecha: string;
  startedAt: number;
  chatId: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readStaleOrActiveLock(lockFile: string): Promise<LockData | null> {
  try {
    const raw = await fs.readFile(lockFile, "utf8");
    const data = JSON.parse(raw) as LockData;
    if (isProcessAlive(data.pid)) return data;
    return null; // stale
  } catch {
    return null;
  }
}

export async function runBriefing(
  deps: BriefingDeps,
  chatId: number,
  args: RunBriefingArgs,
): Promise<RunBriefingResult> {
  const tz = TZ_BY_PAIS[args.pais];
  if (!tz) {
    return {
      status: "error",
      pais: args.pais,
      fecha: args.fecha ?? "",
      message: `País inválido: ${args.pais}. Usar Bolivia, Peru o Colombia.`,
    };
  }

  const fecha = args.fecha ?? new Date().toLocaleDateString("en-CA", { timeZone: tz });

  await fs.mkdir(LOCK_DIR, { recursive: true });
  const lockFile = path.join(LOCK_DIR, `${args.pais}.lock`);

  const existing = await readStaleOrActiveLock(lockFile);
  if (existing) {
    const ageMin = Math.round((Date.now() - existing.startedAt) / 60000);
    return {
      status: "already_running",
      pais: args.pais,
      fecha,
      message: `Ya hay un briefing de ${args.pais} corriendo (pid ${existing.pid}, hace ${ageMin}min). Esperá a que termine o si ya pasaron >15min hay que matarlo manual.`,
    };
  }

  const prompt =
    `Genera el briefing ejecutivo diario de ${args.pais}. Usa el skill /briefing-pais. Zona horaria: ${tz}. ` +
    `Fecha del briefing = ${fecha}. El repo de GitHub Pages está en: ${GITHUB_PAGES_DIR}. ` +
    `Guarda el HTML en ${GITHUB_PAGES_DIR}/dailynews/${args.pais}/. Después de generar el HTML, ` +
    `haz git add + commit + push en ese repo y envía notificación a Telegram (chat_id ${chatId}) ` +
    `con los top 3 titulares y el link https://apps.lepesqueur.net/dailynews/${args.pais}/.`;

  const child = spawn(
    "/opt/homebrew/bin/timeout",
    [
      String(TIMEOUT_SEC),
      CLAUDE_BIN,
      "-p",
      "--dangerously-skip-permissions",
      "--allowedTools",
      "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Skill",
      "-d",
      PROJECT_DIR,
      prompt,
    ],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HOME: process.env.HOME!, PATH: process.env.PATH! },
    },
  );

  if (!child.pid) {
    return {
      status: "error",
      pais: args.pais,
      fecha,
      message: "No se pudo arrancar el subprocess (sin PID).",
    };
  }

  child.unref();

  const lockData: LockData = {
    pid: child.pid,
    pais: args.pais,
    fecha,
    startedAt: Date.now(),
    chatId,
  };
  await fs.writeFile(lockFile, JSON.stringify(lockData, null, 2));

  child.on("exit", async (code) => {
    try {
      await fs.unlink(lockFile);
    } catch {
      // ignore
    }

    // El child OK ya manda la notificación (el prompt lo instruye). Solo notificamos errores.
    if (code !== 0) {
      const reason = code === 124 ? `timeout (${TIMEOUT_SEC}s)` : `exit code ${code}`;
      const html =
        `⚠️ <b>Briefing ${args.pais} falló</b>\n` +
        `📅 ${fecha}\n` +
        `Motivo: ${reason}\n` +
        `Revisá los logs del cron o reintentá.`;
      try {
        await sendMessage(deps.botToken, {
          chatId,
          text: html,
          parseMode: "HTML",
        });
      } catch {
        // best-effort
      }
    }
  });

  return {
    status: "started",
    pais: args.pais,
    fecha,
    message: `Briefing de ${args.pais} arrancado para ${fecha}. Te aviso por mensaje nuevo cuando termine (suele ser unos minutos).`,
  };
}
