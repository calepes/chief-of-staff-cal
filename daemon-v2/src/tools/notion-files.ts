/**
 * notion-files.ts — resuelve los archivos adjuntos de una página de Notion
 * (propiedades tipo `files` + bloques `pdf`/`file`/`image`) y devuelve sus URLs
 * frescas para enviarlas por Telegram.
 *
 * Idéntico en Vesta y Jano (igual que schedule-cal.ts). Al tocarlo, copiar a
 * ambos (`cp`) y rebuildar los dos daemons.
 */
import { callNtn } from "../shared/ntn.js";

export interface NotionAttachment {
  url: string;
  name: string;
  isImage: boolean;
}

// Solo formatos que Telegram acepta en sendPhoto por URL. SVG/HEIC/HEIF/BMP
// se mandan como documento (sendPhoto los rechaza).
const IMG_EXT = /\.(jpe?g|png|gif|webp)(\?|$)/i;

function looksImage(url: string, name: string): boolean {
  return IMG_EXT.test(name) || IMG_EXT.test(url);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromFileItem(item: any): NotionAttachment | null {
  const url: string = item?.file?.url ?? item?.external?.url ?? "";
  if (!url) return null;
  const name: string = item?.name ?? "";
  return { url, name, isImage: looksImage(url, name) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromBlock(b: any): NotionAttachment | null {
  const type: string = b?.type ?? "";
  if (type === "pdf") {
    const url = b?.pdf?.file?.url ?? b?.pdf?.external?.url ?? "";
    if (!url) return null;
    const name = b?.pdf?.name ?? "documento.pdf";
    return { url, name, isImage: false };
  }
  if (type === "file") {
    const url = b?.file?.file?.url ?? b?.file?.external?.url ?? "";
    if (!url) return null;
    const name = (b?.file?.name as string) ?? "";
    return { url, name, isImage: looksImage(url, name) };
  }
  if (type === "image") {
    const url = b?.image?.file?.url ?? b?.image?.external?.url ?? "";
    if (!url) return null;
    return { url, name: "imagen", isImage: true };
  }
  return null;
}

/** Función pura: junta adjuntos de las propiedades `files` + los bloques. Dedup por url. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectAttachments(page: any, blocks: any[]): NotionAttachment[] {
  const out: NotionAttachment[] = [];
  const seen = new Set<string>();
  const push = (a: NotionAttachment | null) => {
    if (a && !seen.has(a.url)) {
      seen.add(a.url);
      out.push(a);
    }
  };

  const props = page?.properties ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const prop of Object.values(props) as any[]) {
    if (prop?.type === "files" && Array.isArray(prop.files)) {
      for (const item of prop.files) push(fromFileItem(item));
    }
  }
  for (const b of blocks ?? []) push(fromBlock(b));

  return out;
}

/** I/O: lee la página + sus bloques vía ntn y devuelve los adjuntos. */
export function fetchNotionAttachments(
  pageId: string,
): { attachments?: NotionAttachment[]; error?: string } {
  const pageRes = callNtn(`v1/pages/${pageId}`);
  if (!pageRes.ok) return { error: pageRes.error ?? "error leyendo página" };
  const blocksRes = callNtn(`v1/blocks/${pageId}/children`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks = blocksRes.ok ? ((blocksRes.data as any)?.results ?? []) : [];
  return { attachments: collectAttachments(pageRes.data, blocks) };
}
