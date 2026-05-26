import { readFile, readdir, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join } from "node:path";

const execFileAsync = promisify(execFile);

export interface AnalyzePhotoOpts {
  imagePath: string;
  mimeType?: string;
  caption?: string;
  task?: "ocr" | "classify" | "describe";
}

export interface PhotoAnalysis {
  text: string;
  rawTokens: { input: number; output: number };
}

const MODEL = "google/gemini-3.1-flash-lite";

const TASK_PROMPTS: Record<NonNullable<AnalyzePhotoOpts["task"]>, string> = {
  ocr: "Extrae todo el texto visible en la foto. Si hay datos estructurados (lista, tabla, formulario), preserva la estructura. Responde solo con el texto extraído, sin comentarios.",
  classify:
    "Clasifica esta foto en una de estas categorías y resume su contenido relevante para coordinación familiar (cumple, evento escolar, lista de mercado, ticket, recordatorio de salud, foto familiar, otro). Responde con: <categoría>: <resumen 1-2 líneas>.",
  describe:
    "Describe brevemente el contenido relevante de la foto en 1-3 líneas, enfocándote en información útil para una familia (Cal, Noe y sus hijas Antonia y Catalina).",
};

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  return key;
}

// Converts a PDF to images (up to 3 pages) and analyzes with vision.
export async function analyzePdf(opts: AnalyzePhotoOpts): Promise<PhotoAnalysis> {
  const prefix = `/tmp/jano_pdf_${Date.now()}`;
  await execFileAsync("pdftoppm", ["-jpeg", "-r", "150", "-f", "1", "-l", "3", opts.imagePath, prefix]);

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
    rawTokens: {
      input: results.reduce((s, r) => s + r.rawTokens.input, 0),
      output: results.reduce((s, r) => s + r.rawTokens.output, 0),
    },
  };
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
