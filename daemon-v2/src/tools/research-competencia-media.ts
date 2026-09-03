import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzePhoto } from "./vision.js";
import { transcribeAudio } from "./whisper.js";

export const execFileAsync = promisify(execFile);
export const FFMPEG = "/opt/homebrew/bin/ffmpeg";
export const FFPROBE = "/opt/homebrew/bin/ffprobe";

/** Descarga una URL de media a disco. Devuelve false ante cualquier falla — nunca tira. */
export async function downloadMedia(url: string, destPath: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(30_000),
      // Los CDN de IG/TikTok/FB devuelven 403 a clientes sin User-Agent de browser.
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" },
    });
    if (!res.ok) {
      // Sin esto, undici puede dejar la conexión colgada hasta el GC en vez de liberarla ya.
      await res.body?.cancel();
      return false;
    }
    await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

/** Descarga una imagen y la describe con visión. null si algo falla — nunca tira. */
export async function describeImage(url: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "rc-img-"));
  try {
    const path = join(dir, "image.jpg");
    if (!(await downloadMedia(url, path, fetchFn))) return null;
    const analysis = await analyzePhoto({ imagePath: path, task: "describe" });
    return analysis.text.trim() || null;
  } catch (err) {
    // downloadMedia ya devuelve false (nunca tira) para fallas de red esperables — si llegamos
    // acá fue analyzePhoto quien tiró (típicamente OPENROUTER_API_KEY faltante o OpenRouter caído).
    // Este cron corre semanal y desatendido: sin este log, una key vencida deja el pipeline
    // devolviendo null para todas las imágenes, para siempre, sin ninguna señal.
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_describe_image_error", err: String(err) }));
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const MAX_FRAMES_PER_VIDEO = 6;
export const MAX_VIDEO_DURATION_SEC = 300;

export interface VideoAnalysis {
  transcripcion: string;
  frames: string[];
}

export interface AnalyzeVideoOpts {
  maxFrames?: number;
  fetchFn?: typeof fetch;
  durationFn?: (videoPath: string) => Promise<number | null>;
  runFfmpegFn?: (args: string[], dir: string) => Promise<void>;
}

/** Duración en segundos vía ffprobe. null si no se puede determinar. */
export async function videoDurationSec(videoPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(FFPROBE, [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", videoPath,
    ]);
    const d = Number(stdout.trim());
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

async function defaultRunFfmpeg(args: string[]): Promise<void> {
  await execFileAsync(FFMPEG, args);
}

/**
 * Descarga un video, transcribe su audio y describe frames muestreados parejo a lo largo del
 * video. Devuelve null si la descarga falla, si supera MAX_VIDEO_DURATION_SEC, o si no se pudo
 * sacar ni transcripción ni un solo frame. Nunca tira: un video roto no corta la corrida.
 */
export async function analyzeVideo(url: string, opts: AnalyzeVideoOpts = {}): Promise<VideoAnalysis | null> {
  const maxFrames = opts.maxFrames ?? MAX_FRAMES_PER_VIDEO;
  const fetchFn = opts.fetchFn ?? fetch;
  const durationFn = opts.durationFn ?? videoDurationSec;
  const runFfmpeg = opts.runFfmpegFn ?? ((args: string[]) => defaultRunFfmpeg(args));

  const dir = await mkdtemp(join(tmpdir(), "rc-vid-"));
  try {
    const videoPath = join(dir, "video.mp4");
    if (!(await downloadMedia(url, videoPath, fetchFn))) return null;

    const dur = await durationFn(videoPath);
    if (dur !== null && dur > MAX_VIDEO_DURATION_SEC) return null;

    let transcripcion = "";
    try {
      const audioPath = join(dir, "audio.wav");
      await runFfmpeg(["-y", "-i", videoPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", audioPath], dir);
      transcripcion = (await transcribeAudio(audioPath, "es", process.env.ELEVENLABS_API_KEY)).trim();
    } catch (err) {
      // Este cron corre desatendido — sin este log, un ffmpeg roto o whisper caído deja el
      // pipeline devolviendo transcripción vacía para siempre, sin ninguna señal (mismo criterio
      // que describeImage).
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_video_transcribe_error", err: String(err) }));
      transcripcion = "";
    }

    const frames: string[] = [];
    try {
      // Muestreo parejo: maxFrames repartidos a lo largo de toda la duración. Sin duración
      // conocida, 1 frame cada 2s como aproximación conservadora.
      const fps = dur && dur > 0 ? Math.max(maxFrames / dur, 0.01) : 0.5;
      await runFfmpeg(
        ["-y", "-i", videoPath, "-vf", `fps=${fps.toFixed(4)}`, "-frames:v", String(maxFrames), join(dir, "frame_%02d.jpg")],
        dir,
      );
      const files = (await readdir(dir)).filter((f) => f.startsWith("frame_")).sort().slice(0, maxFrames);
      for (const f of files) {
        try {
          const a = await analyzePhoto({ imagePath: join(dir, f), task: "describe" });
          if (a.text.trim()) frames.push(a.text.trim());
        } catch (err) {
          // Un frame que falla no corta los demás, pero sí queda logueado — mismo criterio que
          // describeImage: esto corre desatendido y una key vencida no debe fallar en silencio.
          console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_video_frame_error", err: String(err) }));
        }
      }
    } catch (err) {
      // Sin frames: si hay transcripción, igual sirve — pero el fallo de ffmpeg queda logueado.
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_video_frames_error", err: String(err) }));
    }

    if (!transcripcion && frames.length === 0) return null;
    return { transcripcion, frames };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
