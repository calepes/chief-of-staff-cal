import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse") as {
  PDFParse: new (opts: { data: Uint8Array }) => { getText(): Promise<{ text: string }> };
};

export interface PdfExtractResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export async function extractPdfFromBuffer(buf: Uint8Array): Promise<PdfExtractResult> {
  try {
    const parsed = await new PDFParse({ data: buf }).getText();
    const text = parsed.text.trim();
    return text ? { ok: true, text } : { ok: false, error: "sin texto extraíble (PDF escaneado sin capa de texto)" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const FETCH_TIMEOUT_MS = 15_000; // mismo criterio que fetchAsUser (fetch-as-user.ts)

export interface PdfBufferResult {
  ok: boolean;
  buf?: Uint8Array;
  error?: string;
}

// Descarga cruda (sin parsear) — expuesta para que el caller pueda reintentar con OCR sobre los
// MISMOS bytes si extractPdfFromBuffer no encuentra texto, sin volver a pegarle a la red.
export async function fetchPdfBuffer(url: string): Promise<PdfBufferResult> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { ok: false, error: `http ${res.status}` };
  return { ok: true, buf: new Uint8Array(await res.arrayBuffer()) };
}

export async function extractPdfFromUrl(url: string): Promise<PdfExtractResult> {
  const f = await fetchPdfBuffer(url);
  if (!f.ok || !f.buf) return { ok: false, error: f.error };
  return extractPdfFromBuffer(f.buf);
}
