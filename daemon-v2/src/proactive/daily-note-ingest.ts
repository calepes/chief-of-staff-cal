export const DAILY_NOTES_DB_ID = "156c4876-09dd-8051-8154-c82769a316a5";

/** El tag lo agrega Cal a mano al reenviar un mail que quiere guardar en "Daily Notes Yape" —
 * no es un tag automático de ningún sistema, así que no hace falta tolerar variantes raras,
 * solo mayúscula/minúscula ("(DN)"/"(dn)"). */
export function hasDnTag(subject: string): boolean {
  return /\(dn\)/i.test(subject);
}

/** Quita el tag (y espacios sobrantes alrededor) para usar el resto del asunto como título de
 * la página en Notion — nunca queda un "(DN) " residual en el título. */
export function stripDnTag(subject: string): string {
  return subject.replace(/\(dn\)\s*/gi, "").trim();
}

/**
 * Conversión HTML→Markdown liviana, pensada para el cuerpo de un mail reenviado (no HTML
 * arbitrario de la web) — preserva links y bold/italic, que es lo que más se pierde con un
 * strip a lo bruto. Orden importante: primero <a>/<b>/<i> (necesitan ver los tags originales),
 * después separadores de bloque, al final strip de lo que quede + decode de entidades.
 */
export function htmlToMarkdown(html: string): string {
  let out = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");

  // Links: [texto](url) — el texto interno puede traer sus propios tags (ej. <b>), se limpian
  // aparte con un strip acotado a ese fragmento, nunca al doc completo (evita perder el href).
  out = out.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, url, inner) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    return text ? `[${text}](${url})` : url;
  });

  // Lookahead `(?=[\s>/])` en las etiquetas de apertura: sin esto, `<b[^>]*>` matchea también
  // `<br>` (empieza con "b") y `<li[^>]*>` matchea `<link>` — el wildcard `[^>]*` no distingue
  // "termina el nombre de la etiqueta acá" de "sigue el nombre de la etiqueta".
  out = out
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:b|strong)>/gi, "**")
    .replace(/<(?:b|strong)(?=[\s>/])[^>]*>/gi, "**")
    .replace(/<\/(?:i|em)>/gi, "_")
    .replace(/<(?:i|em)(?=[\s>/])[^>]*>/gi, "_")
    .replace(/<li(?=[\s>/])[^>]*>/gi, "- ")
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");

  out = out
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&");

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

const NOTION_TEXT_LIMIT = 1900; // margen bajo el límite real de 2000 chars por rich_text

export interface RichTextItem {
  type: "text";
  text: { content: string; link?: { url: string } | null };
  annotations?: { bold?: boolean; italic?: boolean };
}

interface ParagraphBlock {
  object: "block";
  type: "paragraph";
  paragraph: { rich_text: RichTextItem[] };
}

function plainRun(content: string): RichTextItem {
  return { type: "text", text: { content } };
}

// Orden de alternativas importa: link primero (si no, "**" dentro de un link se comería el `]`).
// Italic exige borde sin espacio (`_(\S(?:[^_]*\S)?)_`) — reduce falsos positivos con underscores
// sueltos de contenido real (usuario_admin, archivo_final.pdf) que no son italic intencional;
// no los elimina del todo (limitación conocida de cualquier parser de markdown por regex simple).
const INLINE_MD_RE = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|_(\S(?:[^_]*\S)?)_/g;

/** Parser de markdown inline MUY acotado (solo lo que genera htmlToMarkdown: bold/italic/links,
 * sin nesting) — convierte "**bold**"/"_italic_"/"[texto](url)" en runs de `rich_text` con
 * `annotations`/`link` reales de Notion, en vez de dejar los caracteres de markdown como texto
 * literal (bug real encontrado en la primera prueba end-to-end: sin esto, Cal veía "**De:**" y
 * "[link](url)" tal cual en la página, no negrita/hyperlink de verdad). */
export function parseInlineMarkdown(text: string): RichTextItem[] {
  const items: RichTextItem[] = [];
  let lastIndex = 0;
  const re = new RegExp(INLINE_MD_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) items.push(plainRun(text.slice(lastIndex, m.index)));
    if (m[1] !== undefined) {
      items.push({ type: "text", text: { content: m[1], link: { url: m[2] } } });
    } else if (m[3] !== undefined) {
      items.push({ type: "text", text: { content: m[3] }, annotations: { bold: true } });
    } else if (m[4] !== undefined) {
      items.push({ type: "text", text: { content: m[4] }, annotations: { italic: true } });
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) items.push(plainRun(text.slice(lastIndex)));
  return items.length ? items : [plainRun("")];
}

/** Convierte texto (típicamente el resultado de htmlToMarkdown) a bloques `paragraph` de Notion
 * — un bloque por párrafo (separado por línea en blanco), partiendo los que excedan el límite de
 * caracteres de un rich_text, y con el markdown inline (bold/italic/links) ya resuelto a
 * anotaciones reales vía parseInlineMarkdown(). Los `\n` simples DENTRO de un párrafo quedan
 * como salto de línea literal en el mismo bloque (Notion los renderiza como soft break). */
export function textToParagraphBlocks(text: string): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    for (let i = 0; i < trimmed.length; i += NOTION_TEXT_LIMIT) {
      const chunk = trimmed.slice(i, i + NOTION_TEXT_LIMIT);
      blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: parseInlineMarkdown(chunk) } });
    }
  }
  return blocks;
}

const NOTION_CHILDREN_PER_CALL = 100;

async function notionRequest(notionToken: string, method: string, path: string, body: unknown, fetchFn: typeof fetch): Promise<any> {
  const res = await fetchFn(`https://api.notion.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`notion ${method} ${path} -> ${res.status}`);
  return res.json();
}

export interface CreateDailyNoteInput {
  /** Ya sin el tag "(DN)" — ver stripDnTag(). */
  title: string;
  /** ISO yyyy-mm-dd. */
  fecha: string;
  /** Markdown (típicamente ya pasado por htmlToMarkdown) — se convierte a bloques `paragraph`. */
  bodyMarkdown: string;
}

export interface CreateDailyNoteResult {
  pageId: string;
}

/** Crea una página NUEVA en "Daily Notes Yape" por cada mail (DN) — a diferencia de las DBs de
 * KPIs, acá no hay upsert por fecha: cada mail es su propia nota, aunque coincida el día con
 * otra nota ya existente (pedido explícito de Cal). */
export async function createDailyNotePage(
  notionToken: string,
  input: CreateDailyNoteInput,
  fetchFn: typeof fetch = fetch,
): Promise<CreateDailyNoteResult> {
  const blocks = textToParagraphBlocks(input.bodyMarkdown);
  const firstBatch = blocks.slice(0, NOTION_CHILDREN_PER_CALL);
  const rest = blocks.slice(NOTION_CHILDREN_PER_CALL);

  const page = await notionRequest(
    notionToken,
    "POST",
    "/v1/pages",
    {
      parent: { database_id: DAILY_NOTES_DB_ID },
      properties: {
        Name: { title: [{ text: { content: input.title } }] },
        Date: { date: { start: input.fecha } },
      },
      children: firstBatch,
    },
    fetchFn,
  );

  for (let i = 0; i < rest.length; i += NOTION_CHILDREN_PER_CALL) {
    await notionRequest(
      notionToken,
      "PATCH",
      `/v1/blocks/${page.id}/children`,
      { children: rest.slice(i, i + NOTION_CHILDREN_PER_CALL) },
      fetchFn,
    );
  }

  return { pageId: page.id };
}
