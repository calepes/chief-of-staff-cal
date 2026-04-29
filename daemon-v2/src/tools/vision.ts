import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";

export interface AnalyzePhotoOpts {
  apiKey: string;
  imagePath: string;
  mimeType?: string;
  caption?: string;
  task?: "ocr" | "classify" | "describe";
  model?: string;
}

export interface PhotoAnalysis {
  text: string;
  rawTokens: { input: number; output: number };
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

const TASK_PROMPTS: Record<NonNullable<AnalyzePhotoOpts["task"]>, string> = {
  ocr: "Extrae todo el texto visible en la foto. Si hay datos estructurados (lista, tabla, formulario), preserva la estructura. Responde solo con el texto extraído, sin comentarios.",
  classify:
    "Clasifica esta foto en una de estas categorías y resume su contenido relevante para coordinación familiar (cumple, evento escolar, lista de mercado, ticket, recordatorio de salud, foto familiar, otro). Responde con: <categoría>: <resumen 1-2 líneas>.",
  describe:
    "Describe brevemente el contenido relevante de la foto en 1-3 líneas, enfocándote en información útil para una familia (Cal, Noe y sus hijas Antonia y Catalina).",
};

export async function analyzePhoto(opts: AnalyzePhotoOpts): Promise<PhotoAnalysis> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const buf = await readFile(opts.imagePath);
  const base64 = buf.toString("base64");
  const mediaType = (opts.mimeType ?? "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

  const task = opts.task ?? "describe";
  const userText = [TASK_PROMPTS[task], opts.caption && `Caption del usuario: ${opts.caption}`]
    .filter(Boolean)
    .join("\n\n");

  const response = await client.messages.create({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return {
    text: textBlock && "text" in textBlock ? textBlock.text.trim() : "",
    rawTokens: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}
