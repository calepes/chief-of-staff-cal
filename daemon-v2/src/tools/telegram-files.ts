import { writeFile, mkdir } from "node:fs/promises";
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
    oga: "audio/ogg",
    ogg: "audio/ogg",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
  };
  return map[ext];
}
