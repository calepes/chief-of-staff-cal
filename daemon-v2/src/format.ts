/**
 * Post-processing safety net for Telegram HTML messages.
 * Converts common Markdown patterns to HTML when the model generates Markdown
 * instead of following the HTML-only instruction in the system prompt.
 */

export function sanitizeForTelegram(text: string): string {
  let result = text;

  // 1. Tables first (before bold/italic, to avoid conflicts with ** in cells)
  result = convertMarkdownTables(result);

  // 2. Headings (#/##/###) → título normal en negrilla (<b>Título</b>), NO <h3>/<h4>
  // (decisión de Cal 2026-08-09, tras probar ambos: los headings de bloque de Rich
  // Messages traen margen propio impredecible — con varios headings seguidos, típico de
  // un resumen (TL;DR + secciones + Citas + Takeaways + Fuente), el mensaje quedaba con
  // huecos grandes sin importar cuánto se ajustara el \n alrededor del tag). `<b>` es
  // INLINE — no fuerza salto de línea solo, así que acá NO se toca el \n original de la
  // línea (a diferencia de un heading de bloque): se preserva la separación normal que ya
  // trae el Markdown fuente (típicamente una línea en blanco antes/después). Va antes de
  // listas/bold para no competir con esos regex.
  result = convertMarkdownHeadings(result);

  // 3. Listas (- / * / 1.) → <ul>/<ol> reales — antes "- item" quedaba como "• item"
  // (bullet de texto plano), visualmente indistinguible de HTML clásico.
  result = convertMarkdownLists(result);

  // 4. **bold** → <b>bold</b>
  result = result.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');

  // 5. *italic* → <i>italic</i> (only when not surrounded by word chars)
  result = result.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, '<i>$1</i>');

  // 6. Horizontal rules (--- or ___) → remove
  result = result.replace(/^[-_]{3,}\s*$/gm, '');

  // 7. Collapse 3+ blank lines to 2
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

function convertMarkdownHeadings(text: string): string {
  return text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
}

const UL_RE = /^[-*]\s+(.+)$/;
const OL_RE = /^\d+\.\s+(.+)$/;

/** Agrupa líneas consecutivas "- item"/"* item" en <ul> y "1. item" en <ol> — cada
 * línea se vuelve un <li> real en vez de un bullet de texto plano. Tolera UNA línea en
 * blanco entre items del MISMO tipo (frecuente cuando el modelo separa puntos con aire
 * para legibilidad en Markdown) sin cortar la lista en dos — solo cierra si la línea en
 * blanco no está seguida de otro item del mismo tipo (hallazgo de daemon-health-reviewer). */
function convertMarkdownLists(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const isUl = UL_RE.test(lines[i]);
    const isOl = OL_RE.test(lines[i]);
    if (isUl || isOl) {
      const re = isUl ? UL_RE : OL_RE;
      const items: string[] = [];
      while (i < lines.length) {
        if (re.test(lines[i])) {
          items.push(`<li>${lines[i].match(re)![1]}</li>`);
          i++;
        } else if (lines[i].trim() === '' && i + 1 < lines.length && re.test(lines[i + 1])) {
          i++; // línea en blanco entre items del mismo tipo — saltar sin cerrar la lista
        } else {
          break;
        }
      }
      out.push(isUl ? `<ul>${items.join('')}</ul>` : `<ol>${items.join('')}</ol>`);
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

function parseTableRow(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1)
    .map(cell => cell.trim());
}

function convertMarkdownTables(text: string): string {
  // Match: header row + separator row + one or more data rows
  const tablePattern = /(\|[^\n]+\|\n\|[-|: ]+\|\n(?:\|[^\n]+\|?\n?)+)/g;

  return text.replace(tablePattern, (match) => {
    const lines = match.trim().split('\n').filter(l => l.trim() !== '');
    if (lines.length < 3) return match;

    const headers = parseTableRow(lines[0]);
    const rows = lines.slice(2).map(parseTableRow);

    if (headers.length === 0) return match;

    const headerCells = headers.map(h => `<th>${h}</th>`).join('');
    const dataRows = rows.map(
      r => `<tr>${headers.map((_, i) => `<td>${r[i] ?? ''}</td>`).join('')}</tr>`,
    );

    return `\n<table><tr>${headerCells}</tr>${dataRows.join('')}</table>\n`;
  });
}
