import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { sendMessage } from "@cos/shared";
import { fetchAsUser } from "./fetch-as-user.js";
import type { CfKv } from "../cf-kv.js";

const CLAUDE_BIN = `${homedir()}/.npm-global/bin/claude`;
const TIMEOUT_SEC = 120;

export interface FetchAndSummarizeDeps {
  botToken: string;
  cookieJarKv: CfKv;
}

export interface FetchAndSummarizeArgs {
  url: string;
  instruction: string;
}

export async function fetchAndSummarize(
  deps: FetchAndSummarizeDeps,
  chatId: number,
  args: FetchAndSummarizeArgs,
): Promise<{ status: string; message: string }> {
  const { url, instruction } = args;
  const { botToken } = deps;

  // 1. Descargar con cookie del Cookie Broker si el dominio está whitelisteado (en Node — fuera del contexto del LLM)
  await sendMessage(botToken, { chatId, text: "📥 Descargando artículo...", parseMode: "HTML" });

  const content = await fetchAsUser(url, deps.cookieJarKv);
  if (!content.ok) {
    await sendMessage(botToken, {
      chatId,
      text: `❌ Error al descargar: ${content.error ?? "sin detalles"}`,
      parseMode: "HTML",
    });
    return { status: "error", message: content.error ?? "fetch failed" };
  }

  const kChars = Math.round(content.text.length / 1000);
  await sendMessage(botToken, {
    chatId,
    text: `📄 Artículo descargado (${kChars}K chars, ${content.cookiesUsed} cookies). Generando resumen...`,
    parseMode: "HTML",
  });

  // 2. Construir prompt para el subprocess — el texto va directo en el prompt
  const subPrompt =
    `Tienes el siguiente artículo de ${url}:\n\n` +
    content.text +
    `\n\n---\n` +
    instruction +
    `\n\nReglas de formato:\n` +
    `- Responde en español neutro.\n` +
    `- Usa HTML de Telegram: <b>negrita</b>, <i>itálica</i>, sin markdown (**).\n` +
    `- Sin preámbulo ("Aquí tienes el resumen..."). Empieza directo con el contenido.`;

  // 3. Lanzar subprocess — prompt via stdin para evitar límites de arg length con textos largos
  const child = spawn(
    "/opt/homebrew/bin/timeout",
    [String(TIMEOUT_SEC), CLAUDE_BIN, "-p", "--tools", ""],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    },
  );
  child.stdin?.write(subPrompt);
  child.stdin?.end();

  if (!child.pid) {
    return { status: "error", message: "No se pudo arrancar el subprocess (sin PID)." };
  }

  let output = "";
  child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });

  child.on("close", async (code) => {
    if (code === 0 && output.trim()) {
      // Intentar con HTML; si falla, reenviar como texto plano
      const sent = await sendMessage(botToken, {
        chatId,
        text: output.trim(),
        parseMode: "HTML",
      }).catch(() => null);

      if (!sent) {
        await sendMessage(botToken, {
          chatId,
          text: output.trim(),
        }).catch(() => {});
      }
    } else {
      const reason = code === 124 ? `timeout (${TIMEOUT_SEC}s)` : `exit ${code}`;
      await sendMessage(botToken, {
        chatId,
        text: `❌ Error generando resumen (${reason}). Intentá de nuevo.`,
        parseMode: "HTML",
      }).catch(() => {});
    }
  });

  child.unref();

  return {
    status: "started",
    message: `Procesando ${kChars}K chars en background. El resumen llega en ~1 min como mensaje nuevo.`,
  };
}
