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

// Piso de caracteres REALES (sin contar whitespace) para dar por buena la capa de
// texto de un PDF. Por debajo se asume escaneado y se cae al OCR por visión.
//
// BUG REAL 2026-08-04: el fallback a OCR vivía detrás de un `if (!text)` — o sea
// solo se disparaba con texto exactamente vacío. Un PDF escaneado casi nunca da
// 0 chars: pdf-parse saca un artefacto mínimo (número de página, marca del
// generador). El comprobante que adjuntó Cal devolvió 12 caracteres, y como 12 es
// truthy el OCR nunca corrió: esos 12 chars llegaron al modelo como si fueran el
// documento entero, y Jano tuvo que pedirle una foto.
//
// 100 es holgado: una página con texto real lo supera por mucho. El costo del
// falso positivo (un PDF legítimamente cortísimo) es una llamada de visión de
// más, no un error — y el caller se queda con el mejor de los dos textos.
export const MIN_PDF_TEXT_CHARS = 100;

/** ¿La capa de texto es tan pobre que conviene intentar OCR sobre las imágenes? */
export function necesitaOcr(text: string | null | undefined): boolean {
  if (!text) return true;
  // Se cuenta el texto SIN whitespace: un escaneo puede traer cientos de saltos
  // de línea y casi ninguna letra, y el largo crudo pasaría el umbral sin
  // contenido real.
  return text.replace(/\s+/g, "").length < MIN_PDF_TEXT_CHARS;
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
