import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { readdirSync } from "node:fs";

const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const WHISPER_CLI = "/opt/homebrew/bin/whisper-cli";

// ── ElevenLabs STT ────────────────────────────────────────────────────────────

async function transcribeWithElevenLabs(audioPath: string, language: string, apiKey: string): Promise<string> {
  const audio = await readFile(audioPath);
  const ext = extname(audioPath).toLowerCase().replace(".", "") || "ogg";
  const mime: Record<string, string> = {
    oga: "audio/ogg", ogg: "audio/ogg", mp3: "audio/mpeg",
    wav: "audio/wav", m4a: "audio/mp4", webm: "audio/webm", mp4: "audio/mp4",
  };
  const form = new FormData();
  form.append("file", new Blob([audio.buffer as ArrayBuffer], { type: mime[ext] ?? "audio/ogg" }), `audio.${ext}`);
  form.append("model_id", "scribe_v1");
  form.append("language_code", language);

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs STT ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = (await res.json()) as { text?: string };
  return data.text?.trim() ?? "";
}

// ── Whisper local (fallback) ──────────────────────────────────────────────────

function findModel(): string {
  const baseDir = "/opt/homebrew/Cellar/whisper-cpp";
  try {
    for (const v of readdirSync(baseDir)) {
      const modelDir = join(baseDir, v, "share/whisper-cpp/models");
      try { readdirSync(modelDir); } catch { continue; }
      const small = join(modelDir, "ggml-small.bin");
      const base = join(modelDir, "ggml-base.bin");
      try { readdirSync(small); return small; } catch { /* try base */ }
      return base;
    }
  } catch { /* fallthrough */ }
  throw new Error("No whisper model found");
}

function run(cmd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve({ stdout }) : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 300)}`)),
    );
  });
}

async function transcribeWithWhisper(audioPath: string, language: string): Promise<string> {
  const wavPath = join(tmpdir(), `vesta-${Date.now()}.wav`);
  await run(FFMPEG, ["-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]);
  const { stdout } = await run(WHISPER_CLI, ["-m", findModel(), "-l", language, "-f", wavPath, "-nt"]);
  return stdout.trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function transcribeAudio(audioPath: string, language = "es", elevenlabsApiKey?: string): Promise<string> {
  if (elevenlabsApiKey) {
    return transcribeWithElevenLabs(audioPath, language, elevenlabsApiKey);
  }
  return transcribeWithWhisper(audioPath, language);
}
