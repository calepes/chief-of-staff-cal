import { writeFile, mkdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename, sep } from "node:path";

const TG_API = "https://api.telegram.org";

/**
 * Valida que `filePath` sea un archivo dentro de `tmpdir()` cuyo nombre
 * matchea `allowedName`, Y resuelve symlinks (`realpath`) antes de confirmar
 * — `resolve()` solo normaliza `..`/segmentos relativos a nivel de string,
 * no sigue links. Sin este segundo chequeo, un symlink plantado en `tmpdir()`
 * con nombre `boa-wallet-*.{pkpass,png}` pero apuntando afuera (ej. a
 * `~/.ssh/id_ed25519`) pasaría la validación de superficie y se leería/
 * mandaría igual. Devuelve el path real ya verificado, o `null` si no pasa.
 */
export async function resolveAllowedLocalFile(filePath: string, allowedName: RegExp): Promise<string | null> {
  const allowedDir = tmpdir();
  const resolved = resolve(filePath);
  if (!resolved.startsWith(allowedDir + sep) || !allowedName.test(basename(resolved))) return null;
  let real: string;
  let allowedDirReal: string;
  try {
    real = await realpath(resolved);
    // macOS: tmpdir() devuelve /var/folders/... pero /var es symlink a
    // /private/var, así que realpath(resolved) siempre resuelve a
    // /private/var/folders/... — comparar contra el allowedDir crudo nunca
    // matcheaba y rechazaba cualquier archivo real. Resolver también allowedDir
    // por realpath antes de comparar (mismo lado, misma forma).
    allowedDirReal = await realpath(allowedDir);
  } catch {
    return null;
  }
  if (!real.startsWith(allowedDirReal + sep) || !allowedName.test(basename(real))) return null;
  return real;
}

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

/**
 * Manda un archivo LOCAL (no URL pública) como documento — usado por el
 * .pkpass de boa-checkin, que no tiene URL pública. `filePath` NUNCA debe
 * aceptarse tal cual del LLM: sin esta validación, cualquier prompt-injection
 * (foto/PDF/mensaje de grupo con contenido no confiable) podría inducir a
 * leer y exfiltrar por Telegram un archivo arbitrario (ej. `~/.ssh/id_ed25519`).
 * Se restringe a archivos `boa-wallet-*.pkpass` dentro de `tmpdir()` — el
 * único patrón que `generateBoaWalletPass` produce realmente.
 */
export async function enviarDocumentoLocal(
  token: string,
  chatId: number | string,
  filePath: string,
  filename: string,
  caption?: string,
): Promise<{ ok: boolean; error?: string }> {
  const resolved = await resolveAllowedLocalFile(filePath, /^boa-wallet-.+\.pkpass$/);
  if (!resolved) {
    return {
      ok: false,
      error: `Path no permitido: solo se puede enviar un .pkpass generado por boa-checkin en ${tmpdir()} (patrón boa-wallet-*.pkpass).`,
    };
  }
  try {
    const buf = await readFile(resolved);
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

/**
 * Manda una foto LOCAL (no URL pública) — usada por la tarjeta .png
 * decorativa de boa-checkin (diseño navy/dorado aprobado, generada junto al
 * .pkpass). Mismo criterio de seguridad que `enviarDocumentoLocal`: `filePath`
 * NUNCA se acepta tal cual del LLM — se restringe a `boa-wallet-*.png` dentro
 * de `tmpdir()`, el único patrón que `generateBoaWalletPass` produce.
 *
 * Usa el endpoint `sendDocument` (no `sendPhoto`): Telegram recomprime toda
 * foto enviada por `sendPhoto` a JPEG, que no soporta canal alfa — las
 * esquinas redondeadas de la tarjeta (transparentes en el PNG original)
 * volvían a verse blancas del lado de Telegram, aunque el archivo estuviera
 * bien (confirmado con Cal probando ambos caminos, 2026-07-17).
 * `sendDocument` no recomprime, preserva el PNG (y su transparencia) tal cual.
 */
export async function enviarFotoLocal(
  token: string,
  chatId: number | string,
  filePath: string,
  filename: string,
  caption?: string,
): Promise<{ ok: boolean; error?: string }> {
  // boa-wallet-*: tarjeta de embarque BoA. kpi-card-*: tarjeta diaria de KPIs Yape.
  // cine-*: mapa/resumen/QR/entradas del MCP de cine. disref-*: capturas de Referencias de Diseño
  // — png/jpg/jpeg/webp/gif porque captureDesignScreenshot a veces descarga la imagen real del
  // post en vez de sacar un screenshot (siempre .png), y esa imagen puede venir en cualquiera de
  // esos formatos según lo que sirva el CDN de origen.
  const resolved = await resolveAllowedLocalFile(filePath, /^(boa-wallet|kpi-card|cine)-.+\.png$|^disref-.+\.(png|jpe?g|webp|gif)$/i);
  if (!resolved) {
    return {
      ok: false,
      error: `Path no permitido: solo se puede enviar boa-wallet-*.png, kpi-card-*.png, cine-*.png o disref-*.{png,jpg,jpeg,webp,gif} dentro de ${tmpdir()}.`,
    };
  }
  try {
    const buf = await readFile(resolved);
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
