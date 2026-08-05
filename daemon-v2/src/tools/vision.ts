import { readFile, readdir, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join } from "node:path";

const execFileAsync = promisify(execFile);

export interface AnalyzePhotoOpts {
  imagePath: string;
  mimeType?: string;
  caption?: string;
  task?: "ocr" | "classify" | "describe" | "design_critique";
}

export interface PhotoAnalysis {
  text: string;
  /** Solo lo setea analyzePdf: páginas realmente OCR-eadas (ver OCR_MAX_PAGES). */
  pagesOcr?: number;
  rawTokens: { input: number; output: number };
}

const MODEL = "google/gemini-3.1-flash-lite";

const TASK_PROMPTS: Record<NonNullable<AnalyzePhotoOpts["task"]>, string> = {
  ocr: "Extrae todo el texto visible en la foto. Si hay datos estructurados (lista, tabla, formulario), preserva la estructura. Responde solo con el texto extraído, sin comentarios.",
  classify:
    "Clasifica esta foto en una de estas categorías y resume su contenido relevante para coordinación familiar (cumple, evento escolar, lista de mercado, ticket, recordatorio de salud, foto familiar, otro). Responde con: <categoría>: <resumen 1-2 líneas>.",
  describe:
    "Describe brevemente el contenido relevante de la foto en 1-3 líneas, enfocándote en información útil para una familia (Cal, Noe y sus hijas Antonia y Catalina).",
  design_critique:
    "Sos un crítico de diseño de producto evaluando este screenshot para guardarlo como referencia " +
    "de inspiración. Respondé EXACTAMENTE en este formato, un campo por línea (sin markdown, sin " +
    "viñetas extra):\n" +
    "TITULO: <3-6 palabras, ej. 'Linear — paleta de comandos'>\n" +
    "TIPO: <una sola palabra de: dashboard, landing, componente, paleta, tipografia, microinteraccion, otro>\n" +
    "QUE_ES: <1 línea, qué es lo que se ve>\n" +
    "POR_QUE_FUNCIONA: <2-4 líneas. El patrón CONCRETO que hace que funcione — jerarquía, spacing, " +
    "contraste, densidad, el truco puntual. NUNCA una descripción genérica de \"qué se ve\".>\n" +
    "TAGS: <3-6 tags cortos en inglés, separados por coma, ej. dark-mode, data-density, glass>\n" +
    "Si la imagen muestra un muro de login o no cargó contenido real, decilo explícito en QUE_ES " +
    "en vez de inventar contenido que no viste.",
};

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  return key;
}

// Tope de páginas que se convierten a imagen para el OCR. Es un límite de costo
// (cada página son ~1024 tokens de visión), NO del documento: un PDF más largo se
// lee PARCIAL. El caller tiene que avisar de ese recorte — ver `pagesOcr` abajo.
export const OCR_MAX_PAGES = 5;

// Converts a PDF to images (up to OCR_MAX_PAGES pages) and analyzes with vision.
export async function analyzePdf(opts: AnalyzePhotoOpts): Promise<PhotoAnalysis> {
  const prefix = `/tmp/jano_pdf_${Date.now()}`;
  await execFileAsync("pdftoppm", ["-jpeg", "-r", "150", "-f", "1", "-l", String(OCR_MAX_PAGES), opts.imagePath, prefix]);

  const prefixBase = basename(prefix);
  const pageFiles = (await readdir("/tmp"))
    .filter((f) => f.startsWith(prefixBase) && f.endsWith(".jpg"))
    .sort()
    .map((f) => join("/tmp", f));

  if (pageFiles.length === 0) throw new Error("pdftoppm produced no output");

  const results = await Promise.all(
    pageFiles.map((pagePath) =>
      analyzePhoto({ imagePath: pagePath, mimeType: "image/jpeg", caption: opts.caption, task: opts.task ?? "ocr" })
        .finally(() => unlink(pagePath).catch(() => {}))
    )
  );

  return {
    text: results.length === 1 ? results[0].text : results.map((r, i) => `[Página ${i + 1}]\n${r.text}`).join("\n\n"),
    // Cuántas páginas se leyeron de verdad. Si llegó al tope, el documento puede
    // tener más y lo devuelto es PARCIAL — el caller debe decirlo, si no presenta
    // 3 páginas como si fueran el documento entero.
    pagesOcr: pageFiles.length,
    rawTokens: {
      input: results.reduce((s, r) => s + r.rawTokens.input, 0),
      output: results.reduce((s, r) => s + r.rawTokens.output, 0),
    },
  };
}

/** Nota de recorte para anexar al texto OCR-eado, o "" si se leyó todo. */
export function notaOcrParcial(pagesOcr: number | undefined): string {
  return pagesOcr && pagesOcr >= OCR_MAX_PAGES
    ? `\n\n[... OCR limitado a las primeras ${OCR_MAX_PAGES} páginas — si el documento tiene más, ese contenido NO está acá ...]`
    : "";
}

export async function analyzePhoto(opts: AnalyzePhotoOpts): Promise<PhotoAnalysis> {
  const apiKey = getApiKey();
  const buf = await readFile(opts.imagePath);
  const base64 = buf.toString("base64");
  const mediaType = opts.mimeType ?? "image/jpeg";

  const task = opts.task ?? "describe";
  const userText = [TASK_PROMPTS[task], opts.caption && `Caption del usuario: ${opts.caption}`]
    .filter(Boolean)
    .join("\n\n");

  // OpenAI-compatible format (OpenRouter)
  const body = {
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:${mediaType};base64,${base64}` },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/calepes/jano",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${res.status} ${err}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  const text = data.choices[0]?.message?.content?.trim() ?? "";
  return {
    text,
    rawTokens: {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    },
  };
}
