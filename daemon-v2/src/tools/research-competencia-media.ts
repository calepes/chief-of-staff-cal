import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzePhoto } from "./vision.js";

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
