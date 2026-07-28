// learning-file.ts — parseo, serialización, dedupe y presupuesto de ~/.cos-agent/learnings.md.
//
// El archivo entero se inyecta en el system prompt en CADA turno (ver learnings.ts), así que su
// tamaño es contexto fijo que se paga siempre. De ahí el semáforo de tokens.
//
// Compatibilidad: las 4 entries escritas antes de este cambio no tienen tag. Se parsean igual y
// caen a "hecho" — romper con ellas habría significado perder los únicos learnings que existían.

import { LEARNING_TAGS, type Learning, type LearningCandidate, type LearningTag } from "./learning-types.js";

/**
 * Presupuesto BLANDO. Al superarlo el pase nocturno avisa y propone podar; nunca corta solo.
 * 4000 tokens ≈ 80-100 learnings, sobre un system prompt que ya pesa 18-20K.
 */
export const LEARNING_BUDGET_TOKENS = 4000;

const LINE_RE = /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(?:\[([a-z]+)\]\s*)?(.+)$/;

function isTag(v: string | undefined): v is LearningTag {
  return typeof v === "string" && (LEARNING_TAGS as readonly string[]).includes(v);
}

export function parseLearnings(content: string): Learning[] {
  const out: Learning[] = [];
  for (const line of content.split("\n")) {
    const m = LINE_RE.exec(line.trim());
    if (!m) continue;
    const text = m[3].trim();
    if (!text) continue;
    out.push({ date: m[1], tag: isTag(m[2]) ? m[2] : "hecho", text });
  }
  return out;
}

export function formatLearning(l: Learning): string {
  return `- [${l.date}] [${l.tag}] ${l.text}`;
}

/** Estimación por caracteres. Suficiente para un semáforo; no justifica un tokenizer real. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function totalTokens(learnings: Learning[]): number {
  return estimateTokens(learnings.map(formatLearning).join("\n"));
}

export function overBudget(learnings: Learning[]): boolean {
  return totalTokens(learnings) > LEARNING_BUDGET_TOKENS;
}

const STOPWORDS = new Set([
  "el", "la", "los", "las", "un", "una", "de", "del", "que", "y", "o", "a", "en", "con", "por",
  "para", "es", "no", "se", "su", "lo", "al", "como", "cal", "jano",
]);

function bagOfWords(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function similarity(a: string, b: string): number {
  const A = bagOfWords(a);
  const B = bagOfWords(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** Por encima de esto se considera el mismo learning dicho con otras palabras. */
const DUP_THRESHOLD = 0.6;

/**
 * Filtra candidatos que ya están cubiertos por un learning existente, y duplicados internos del
 * propio batch. Heurística deliberadamente simple: el costo de un falso positivo es perder un
 * learning que Cal puede volver a fijar a mano; el de un falso negativo es ruido permanente en
 * el system prompt.
 */
export function dedupeCandidates(
  candidates: LearningCandidate[],
  existentes: Learning[],
): LearningCandidate[] {
  const kept: LearningCandidate[] = [];
  for (const c of candidates) {
    const contraExistentes = existentes.some((e) => similarity(c.text, e.text) >= DUP_THRESHOLD);
    if (contraExistentes) continue;
    const contraBatch = kept.some((k) => similarity(c.text, k.text) >= DUP_THRESHOLD);
    if (contraBatch) continue;
    kept.push(c);
  }
  return kept;
}
