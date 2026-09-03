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

// ffprobe solo lee metadata del contenedor (rápido); ffmpeg decodifica audio/frames de hasta
// MAX_VIDEO_DURATION_SEC (5 min) de video y necesita bastante más margen. Sin timeout explícito,
// un video corrupto deja el `await` colgado para siempre — con el pipeline recorriendo hasta 24
// cuentas × 4 videos en secuencia, UN video problemático cuelga la corrida semanal completa, y de
// paso el `finally` que borra el temporal nunca corre (fuga de disco). Bloqueante de la revisión
// de calidad de esta tarea.
const FFPROBE_TIMEOUT_MS = 10_000;
const FFMPEG_TIMEOUT_MS = 120_000;
// Mismo techo que consultar-json.ts: execFile trunca stdout/stderr a 1MB por default y ffmpeg es
// verborrágico incluso con -loglevel error.
const FFMPEG_MAX_BUFFER = 64 * 1024 * 1024;

/** Descarga una URL de media a disco. Devuelve false ante cualquier falla — nunca tira. */
export async function downloadMedia(
  url: string,
  destPath: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<boolean> {
  try {
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(timeoutMs),
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
  hasAudioFn?: (videoPath: string) => Promise<boolean>;
  downloadTimeoutMs?: number;
}

/** Duración en segundos vía ffprobe. null si no se puede determinar. */
export async function videoDurationSec(videoPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER },
    );
    const d = Number(stdout.trim());
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

/**
 * true si el video tiene al menos un stream de audio. Ante cualquier falla del probe (video
 * corrupto, ffprobe caído) asume que SÍ hay audio — mejor intentar una transcripción de más que
 * saltear una legítima; si ffmpeg falla después extrayendo el audio, ESE fallo se loguea como
 * error real (ver `analyzeVideo`). Sin este probe, un video mudo (slideshow, clip sin sonido —
 * común en redes) hacía fallar la extracción de audio con "Output file does not contain any
 * stream" y quedaba logueado como el MISMO error que una key de ElevenLabs vencida, tapando la
 * señal real en ~96 videos/semana.
 */
export async function hasAudioStream(videoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", videoPath],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER },
    );
    return stdout.trim().length > 0;
  } catch {
    return true;
  }
}

/**
 * Arma los argumentos de ffmpeg para extraer hasta `maxFrames` frames MUESTREADOS POR BUCKET
 * CENTRADO a lo largo del video: el frame k cae en (k+0.5)·(dur/maxFrames), nunca en
 * k·(dur/maxFrames). Con el filtro `fps` arrancando en t=0, el último de 6 frames caía en
 * ~0.83·dur — en un video de 4 min se perdían los últimos ~40s, justo donde suele ir el CTA/
 * oferta. Centrar el bucket se logra arrancando la decodificación en offset=interval/2 (`-ss`
 * ANTES de `-i` — seek de entrada preciso por default en ffmpeg moderno) y muestreando desde ahí
 * a fps=1/interval. Sin duración conocida no hay bucket que centrar contra el total: cae al
 * fallback de 1 frame cada 2s desde el arranque, igual que antes de este fix.
 */
export function buildFrameExtractArgs(videoPath: string, outDir: string, maxFrames: number, dur: number | null): string[] {
  const interval = dur && dur > 0 ? dur / maxFrames : 2;
  const offset = dur && dur > 0 ? interval / 2 : 0;
  const fps = 1 / interval;
  return [
    "-y",
    ...(offset > 0 ? ["-ss", offset.toFixed(3)] : []),
    "-i", videoPath,
    "-vf", `fps=${fps.toFixed(4)}`,
    "-frames:v", String(maxFrames),
    "-loglevel", "error",
    join(outDir, "frame_%02d.jpg"),
  ];
}

async function defaultRunFfmpeg(args: string[]): Promise<void> {
  await execFileAsync(FFMPEG, args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER });
}

/**
 * Descarga un video, transcribe su audio (si tiene) y describe frames muestreados a lo largo del
 * video. Devuelve null si la descarga falla, si supera MAX_VIDEO_DURATION_SEC, o si no se pudo
 * sacar ni transcripción ni un solo frame. Nunca tira: un video roto no corta la corrida.
 */
export async function analyzeVideo(url: string, opts: AnalyzeVideoOpts = {}): Promise<VideoAnalysis | null> {
  const maxFrames = opts.maxFrames ?? MAX_FRAMES_PER_VIDEO;
  const fetchFn = opts.fetchFn ?? fetch;
  const durationFn = opts.durationFn ?? videoDurationSec;
  const runFfmpeg = opts.runFfmpegFn ?? ((args: string[]) => defaultRunFfmpeg(args));
  const hasAudioFn = opts.hasAudioFn ?? hasAudioStream;
  // Un video de red pesa bastante más que las imágenes que ya cubre describeImage (30s) — ese
  // mismo timeout expiraría sobre una descarga válida de varios MB desde una CDN lenta.
  const downloadTimeoutMs = opts.downloadTimeoutMs ?? 120_000;

  const dir = await mkdtemp(join(tmpdir(), "rc-vid-"));
  try {
    const videoPath = join(dir, "video.mp4");
    if (!(await downloadMedia(url, videoPath, fetchFn, downloadTimeoutMs))) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_video_download_error", url }));
      return null;
    }

    const dur = await durationFn(videoPath);
    if (dur !== null && dur > MAX_VIDEO_DURATION_SEC) return null;

    let transcripcion = "";
    if (await hasAudioFn(videoPath)) {
      try {
        const audioPath = join(dir, "audio.wav");
        await runFfmpeg(["-y", "-loglevel", "error", "-i", videoPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", audioPath], dir);
        transcripcion = (await transcribeAudio(audioPath, "es", process.env.ELEVENLABS_API_KEY)).trim();
      } catch (err) {
        // Este cron corre desatendido — sin este log, un ffmpeg roto o whisper caído deja el
        // pipeline devolviendo transcripción vacía para siempre, sin ninguna señal (mismo criterio
        // que describeImage).
        console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_video_transcribe_error", err: String(err) }));
        transcripcion = "";
      }
    } else {
      // Video sin pista de audio (slideshow, clip mudo) — común en redes, no es una falla real.
      // Msg SIN "_error" a propósito: no es la misma señal que una key vencida o un ffmpeg roto.
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_video_no_audio_track" }));
    }

    const frames: string[] = [];
    try {
      await runFfmpeg(buildFrameExtractArgs(videoPath, dir, maxFrames, dur), dir);
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
