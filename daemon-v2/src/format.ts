/**
 * Post-processing safety net for Telegram HTML messages.
 * Converts common Markdown patterns to HTML when the model generates Markdown
 * instead of following the HTML-only instruction in the system prompt.
 */

export function sanitizeForTelegram(text: string): string {
  let result = text;

  // 1. Tables first (before bold/italic, to avoid conflicts with ** in cells)
  result = convertMarkdownTables(result);

  // 2. **bold** → <b>bold</b>
  result = result.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');

  // 3. *italic* → <i>italic</i> (only when not surrounded by word chars)
  result = result.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, '<i>$1</i>');

  // 4. Horizontal rules (--- or ___) → remove
  result = result.replace(/^[-_]{3,}\s*$/gm, '');

  // 5. "- item" list bullets → "• item" (only at line start)
  result = result.replace(/^- /gm, '• ');

  // 6. Collapse 3+ blank lines to 2
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
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

    const colWidths = headers.map((h, i) => {
      const dataMax = rows.reduce((mx, r) => Math.max(mx, (r[i] ?? '').length), 0);
      return Math.max(h.length, dataMax, 3);
    });

    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

    const headerRow = headers.map((h, i) => pad(h, colWidths[i])).join('  ');
    const separator = colWidths.map(w => '─'.repeat(w)).join('  ');
    const dataRows = rows.map(r =>
      headers.map((_, i) => pad(r[i] ?? '', colWidths[i])).join('  ')
    );

    return `\n<pre>${[headerRow, separator, ...dataRows].join('\n')}</pre>\n`;
  });
}
