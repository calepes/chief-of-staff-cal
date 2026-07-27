// journal-text.ts — funciones puras de texto del Journal. Sin red, sin estado.

const PREFIJOS = ["journal:", "diario:"];
const EXTRACTO_MAX = 200;
/** Notion corta cada rich_text a 2000 chars; dejamos margen. */
const CHUNK_MAX = 1900;

/**
 * Devuelve el texto que sigue al prefijo `journal:`/`diario:`, o null si el mensaje
 * no lo tiene al principio. El texto se devuelve LITERAL (solo se recortan los
 * espacios que rodean al prefijo) — nunca se reescribe.
 */
export function parseJournalPrefix(text: string): string | null {
  const lower = text.toLowerCase();
  for (const p of PREFIJOS) {
    if (!lower.startsWith(p)) continue;
    const resto = text.slice(p.length).trim();
    return resto.length > 0 ? resto : null;
  }
  return null;
}

/** Preview de una línea para la vista de tabla de Notion. */
export function buildExtracto(texto: string): string {
  const plano = texto.replace(/\s+/g, " ").trim();
  if (plano.length <= EXTRACTO_MAX) return plano;
  const corte = plano.slice(0, EXTRACTO_MAX);
  const ultimoEspacio = corte.lastIndexOf(" ");
  const base = ultimoEspacio > 0 ? corte.slice(0, ultimoEspacio) : corte;
  return `${base}…`;
}

/**
 * Parte el texto en trozos que Notion acepta como bloques `paragraph`.
 * Respeta los párrafos originales; si uno solo excede el límite, lo corta
 * por palabras (y por caracteres si ni siquiera hay espacios).
 */
export function chunkParagraphs(texto: string): string[] {
  const parrafos = texto
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const out: string[] = [];
  for (const parrafo of parrafos) {
    if (parrafo.length <= CHUNK_MAX) {
      out.push(parrafo);
      continue;
    }
    let resto = parrafo;
    while (resto.length > CHUNK_MAX) {
      const corte = resto.slice(0, CHUNK_MAX);
      const ultimoEspacio = corte.lastIndexOf(" ");
      const cortePunto = ultimoEspacio > 0 ? ultimoEspacio : CHUNK_MAX;
      out.push(resto.slice(0, cortePunto).trim() || corte);
      resto = resto.slice(cortePunto).trim();
    }
    if (resto.length > 0) out.push(resto);
  }
  return out;
}
