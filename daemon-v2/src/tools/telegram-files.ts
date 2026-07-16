import { writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TG_API = "https://api.telegram.org";

export async function downloadTelegramFile(
  token: string,
  fileId: string,
  destDir: string = tmpdir(),
): Promise<{ path: string; mimeType?: string; sizeBytes: number }> {
  const metaRes = await fetch(`${TG_API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const meta = (await metaRes.json()) as {
    ok: boolean;
    result?: { file_path: string; file_size?: number };
    description?: string;
  };
  if (!meta.ok || !meta.result?.file_path) {
    throw new Error(`getFile failed: ${meta.description ?? "unknown"}`);
  }

  const fileRes = await fetch(`${TG_API}/file/bot${token}/${meta.result.file_path}`);
  if (!fileRes.ok) throw new Error(`download failed: ${fileRes.status}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());

  await mkdir(destDir, { recursive: true });
  const filename = meta.result.file_path.split("/").pop() ?? `tg-${Date.now()}`;
  const dest = join(destDir, filename);
  await writeFile(dest, buf);

  return {
    path: dest,
    mimeType: inferMime(filename),
    sizeBytes: buf.length,
  };
}

function inferMime(path: string): string | undefined {
  const ext = path.toLowerCase().split(".").pop();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
  };
  return map[ext];
}

/** Manda un archivo LOCAL (no URL pública) como documento — usado por el .pkpass de boa-checkin, que no tiene URL pública. */
export async function enviarDocumentoLocal(
  token: string,
  chatId: number | string,
  filePath: string,
  filename: string,
  caption?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const buf = await readFile(filePath);
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (caption) fd.append("caption", caption);
    fd.append("document", new Blob([new Uint8Array(buf)]), filename);
    const res = await fetch(`${TG_API}/bot${token}/sendDocument`, {
      method: "POST",
      body: fd,
      signal: AbortSignal.timeout(30000),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    return data.ok ? { ok: true } : { ok: false, error: data.description };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
