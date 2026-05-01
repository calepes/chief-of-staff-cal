import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function loadLearnings(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

export function appendLearning(path: string, text: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync(path, `- [${date}] ${text.trim()}\n`, "utf8");
}

export function buildLearningsSection(path: string): string {
  const content = loadLearnings(path);
  const base = content
    ? `## Aprendizajes acumulados\n\n${content}`
    : `## Aprendizajes acumulados\n\n(Sin learnings todavía)`;
  return `\n\n${base}\n\nCuando detectes algo genuinamente nuevo que vale para futuras sesiones — una preferencia confirmada de Cal, un error que debes evitar, un patrón de comportamiento — llama \`addLearning(text)\`. Solo learnings no obvios. Máx 2 líneas por learning. No anotar comportamiento ya descrito en el system prompt.`;
}
