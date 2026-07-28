import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseLearnings } from "./learning-file.js";
import { LEARNING_TAGS, type Learning, type LearningTag } from "./learning-types.js";

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

/** Título legible por categoría, en el orden en que se muestran en el system prompt. */
const CATEGORY_TITLES: Record<LearningTag, string> = {
  pref: "Preferencias de Cal",
  err: "Errores a evitar",
  flujo: "Flujos que Cal repite",
  hecho: "Hechos sobre Cal y su contexto",
};

/** Mismo orden que CATEGORY_TITLES — pref, err, flujo, hecho. */
const CATEGORY_ORDER: readonly LearningTag[] = ["pref", "err", "flujo", "hecho"];

function renderCategory(tag: LearningTag, items: Learning[]): string {
  const lines = items.map((l) => `- ${l.text}`).join("\n");
  return `### ${CATEGORY_TITLES[tag]}\n\n${lines}`;
}

/**
 * Arma la sección "Aprendizajes acumulados" del system prompt, agrupada por categoría.
 *
 * Por qué cambió (2026-07-28): la versión anterior volcaba el archivo tal cual y terminaba
 * pidiéndole al modelo que llamara `addLearning` cuando detectara algo nuevo en medio del turno.
 * Ese diseño produjo 4 entries en 3 meses — la reflexión in-turn compite con la tarea que Cal
 * pidió y siempre pierde. Ahora la captura de aprendizajes nuevos la hace el pase nocturno
 * (proactive/learning-reflect.ts, Haiku sobre el transcript del día + tarjeta de aprobación) y el
 * único camino manual es que Cal diga explícitamente "recuerda que...". Esta función ya no invita
 * al modelo a escribir — solo le entrega lo aprendido antes para que lo aplique en silencio.
 */
export function buildLearningsSection(path: string): string {
  const content = loadLearnings(path);
  const learnings = parseLearnings(content);

  const header = "## Aprendizajes acumulados";

  if (learnings.length === 0) {
    return `\n\n${header}\n\n(Sin learnings todavía)`;
  }

  const byTag = new Map<LearningTag, Learning[]>();
  for (const tag of LEARNING_TAGS) byTag.set(tag, []);
  for (const l of learnings) byTag.get(l.tag)!.push(l);

  const bloques = CATEGORY_ORDER
    .filter((tag) => byTag.get(tag)!.length > 0)
    .map((tag) => renderCategory(tag, byTag.get(tag)!));

  return [
    "",
    "",
    header,
    "",
    bloques.join("\n\n"),
    "",
    "Estas son cosas que aprendiste de Cal en conversaciones anteriores. Aplícalas sin anunciarlas.",
  ].join("\n");
}
