import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";

const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const WHISPER_CLI = "/opt/homebrew/bin/whisper-cli";

function findModel(): string {
  const baseDir = "/opt/homebrew/Cellar/whisper-cpp";
  try {
    const versions = readdirSync(baseDir);
    for (const v of versions) {
      const modelDir = join(baseDir, v, "share/whisper-cpp/models");
      const small = join(modelDir, "ggml-small.bin");
      const base = join(modelDir, "ggml-base.bin");
      try {
        readdirSync(modelDir);
        return small;
      } catch {
        // try base
      }
      return base;
    }
  } catch {
    // fallthrough
  }
  throw new Error("No whisper model found in /opt/homebrew/Cellar/whisper-cpp/*");
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

export async function transcribeAudio(audioPath: string, language = "es"): Promise<string> {
  const wavPath = join(tmpdir(), `vesta-${Date.now()}.wav`);
  await run(FFMPEG, ["-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]);

  const model = findModel();
  const { stdout } = await run(WHISPER_CLI, ["-m", model, "-l", language, "-f", wavPath, "-nt"]);
  return stdout.trim();
}
