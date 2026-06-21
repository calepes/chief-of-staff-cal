import { createRequire } from "node:module";
import { callNtn } from "../shared/ntn.js";

const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse") as {
  PDFParse: new (opts: { data: Uint8Array }) => { getText(): Promise<{ text: string }> };
};

export const SCHEDULE_CAL_DS = "f66c31e7-a4c1-4b6e-9f65-c28ecaf50ce3";

export interface VacacionEntry {
  pageId: string;
  url: string;
  name: string;
  fecha?: { start: string; end?: string };
  status?: string;
  clase?: string;
  tipo?: string[];
  anoVacaciones?: string;
  diasVacas?: number;
  pais?: string;
  pptoUsd?: number;
  registroVacaciones?: boolean;
}

export interface VacacionDetail extends VacacionEntry {
  blocks?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function prop(page: any, name: string): any {
  return page?.properties?.[name];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseVacacion(page: any): VacacionEntry {
  const name = prop(page, "Name")?.title?.[0]?.plain_text ?? "(sin nombre)";

  const fechaRaw = prop(page, "Fecha ")?.date ?? null;
  const fecha = fechaRaw
    ? { start: fechaRaw.start as string, end: (fechaRaw.end ?? undefined) as string | undefined }
    : undefined;

  const status: string | undefined = prop(page, "Status")?.select?.name ?? undefined;
  const clase: string | undefined = prop(page, "Clase")?.select?.name ?? undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tipoArr: any[] = prop(page, "Tipo")?.multi_select ?? [];
  const tipo: string[] = tipoArr.map((t: { name: string }) => t.name);

  const anoVacaciones: string | undefined =
    prop(page, "Año Vacaciones")?.select?.name ?? undefined;

  // Nota: propiedad tiene espacio inicial — " D. Vacas"
  const diasVacasRaw = prop(page, " D. Vacas");
  const diasVacas: number | undefined =
    diasVacasRaw?.rollup?.type === "number" && diasVacasRaw.rollup.number != null
      ? (diasVacasRaw.rollup.number as number)
      : undefined;

  // Pais es rollup show_original de la relación Ciudad → array de selects
  const paisRaw = prop(page, "Pais");
  let pais: string | undefined;
  if (paisRaw?.rollup?.type === "array") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arr: any[] = paisRaw.rollup.array ?? [];
    const names = arr
      .flatMap((item: any) => (item?.select?.name ? [item.select.name as string] : []))
      .join(", ");
    pais = names || undefined;
  }

  const pptoRaw = prop(page, "Ppto US$");
  const pptoUsd: number | undefined =
    pptoRaw?.formula?.type === "number" && pptoRaw.formula.number != null
      ? (pptoRaw.formula.number as number)
      : undefined;

  const registroVacaciones: boolean | undefined =
    prop(page, "Registro Vacaciones")?.checkbox ?? undefined;

  return {
    pageId: page.id as string,
    url: page.url as string,
    name,
    fecha,
    status,
    clase,
    tipo: tipo.length > 0 ? tipo : undefined,
    anoVacaciones,
    diasVacas,
    pais,
    pptoUsd,
    registroVacaciones,
  };
}

function formatFechaRango(fecha?: { start: string; end?: string }): string {
  if (!fecha) return "";
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const fmt = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("es-ES", opts);
  return fecha.end ? `${fmt(fecha.start)} – ${fmt(fecha.end)}` : fmt(fecha.start);
}

function calcDias(fecha?: { start: string; end?: string }): number | undefined {
  if (!fecha?.end) return undefined;
  const ms = new Date(fecha.end).getTime() - new Date(fecha.start).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

function formatEntryHtml(v: VacacionEntry): string {
  const icon = v.clase === "Viaje" ? "✈️" : v.clase === "Hito" ? "🎯" : "🏖️";
  const lines: string[] = [`${icon} <b>${v.name}</b>`];

  if (v.fecha) {
    const rango = formatFechaRango(v.fecha);
    const dias = v.diasVacas ?? calcDias(v.fecha);
    lines.push(`📅 ${rango}${dias != null ? ` · ${dias} días` : ""}`);
  }

  const locParts: string[] = [];
  if (v.pais) locParts.push(`📍 ${v.pais}`);
  if (v.pptoUsd != null) locParts.push(`💰 $${v.pptoUsd}`);
  if (locParts.length > 0) lines.push(locParts.join(" · "));

  if (v.status) lines.push(`Estado: ${v.status}`);
  lines.push(`<a href="${v.url}">Ver en Notion →</a>`);
  lines.push(`[pageId: ${v.pageId}]`);

  return lines.join("\n");
}

export function listVacaciones(filters?: {
  year?: string;
  status?: "Not started" | "In progress" | "Done" | "Canceled";
}): string {
  const andFilters: unknown[] = [
    { property: "Tipo", multi_select: { contains: "Vacaciones" } },
  ];
  if (filters?.year) {
    andFilters.push({ property: "Año Vacaciones", select: { equals: filters.year } });
  }
  if (filters?.status) {
    andFilters.push({ property: "Status", select: { equals: filters.status } });
  }

  const body =
    andFilters.length === 1
      ? { filter: andFilters[0] }
      : { filter: { and: andFilters } };

  const res = callNtn(`v1/data_sources/${SCHEDULE_CAL_DS}/query`, { body });
  if (!res.ok) return `❌ Error consultando Schedule CAL: ${res.error}`;

  const data = res.data as { results?: unknown[] };
  const pages = data?.results ?? [];

  if (pages.length === 0) {
    const suffix = filters?.year ? ` para ${filters.year}` : "";
    return `🏖️ No se encontraron vacaciones${suffix}.`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries = pages.map((p) => parseVacacion(p as any));
  const yearLabel = filters?.year ? ` ${filters.year}` : "";
  const header = `🏖️ <b>Vacaciones${yearLabel}</b> (${entries.length} entrada${entries.length !== 1 ? "s" : ""})`;
  return `${header}\n\n${entries.map(formatEntryHtml).join("\n\n")}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBlockText(b: any): string {
  const type: string = b?.type ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const richText: any[] = b?.[type]?.rich_text ?? b?.[type]?.text ?? [];
  return richText.map((rt: any) => (rt?.plain_text as string) ?? "").join("");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getItemTitle(page: any): string {
  const props = page?.properties ?? {};
  for (const prop of Object.values(props) as any[]) {
    if (prop?.type === "title") {
      return (prop?.title?.[0]?.plain_text as string) ?? "(sin nombre)";
    }
  }
  return "(sin nombre)";
}

async function summarizeTextWithLlm(text: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return text.slice(0, 3000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/calepes/jano",
      },
      body: JSON.stringify({
        model: "google/gemini-3.1-flash-lite",
        max_tokens: 600,
        messages: [{
          role: "user",
          content: `Extrae los datos clave de este documento en español. Si es confirmación, reserva, ticket o factura, incluye: nombre, fechas, número de confirmación/reserva, precio, dirección, condiciones importantes. Sé conciso. Solo los datos relevantes, sin preámbulo.\n\n---\n${text}`,
        }],
      }),
    });
    if (!res.ok) return text.slice(0, 3000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any;
    return (data?.choices?.[0]?.message?.content as string) ?? text.slice(0, 3000);
  } catch {
    return text.slice(0, 3000);
  }
}

async function extractPdfUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) return "[PDF — error al descargar]";
    const buf = await res.arrayBuffer();
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const parsed = await parser.getText();
    const fullText = parsed.text.trim();
    if (!fullText) return "[PDF sin texto extraíble]";
    return await summarizeTextWithLlm(fullText);
  } catch {
    return "[PDF — error al procesar]";
  }
}

async function describeImage(url: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return "[imagen — sin clave OpenRouter]";
  try {
    const imgRes = await fetch(url);
    if (!imgRes.ok) return "[imagen — error al descargar]";
    const imgBuf = await imgRes.arrayBuffer();
    const base64 = Buffer.from(imgBuf).toString("base64");
    const mimeType = (imgRes.headers.get("content-type") ?? "image/jpeg").split(";")[0];
    const apiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/calepes/jano",
      },
      body: JSON.stringify({
        model: "google/gemini-3.1-flash-lite",
        max_tokens: 600,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
            { type: "text", text: "Describe el contenido de esta imagen en español. Si es una confirmación, reserva, ticket o documento, extrae los datos clave: nombre, fechas, número de confirmación, precio, dirección, etc. Responde solo con los datos relevantes, sin preámbulo." },
          ],
        }],
      }),
    });
    if (!apiRes.ok) return "[imagen — error al analizar]";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await apiRes.json() as any;
    return (data?.choices?.[0]?.message?.content as string) ?? "[imagen — sin descripción]";
  } catch {
    return "[imagen — error al procesar]";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getFileUrl(b: any): { url: string; name: string; isPdf: boolean; isImage: boolean } | null {
  const type: string = b?.type ?? "";
  let url = "";
  let name = "";
  let isPdf = false;
  let isImage = false;

  if (type === "pdf") {
    url = b?.pdf?.file?.url ?? b?.pdf?.external?.url ?? "";
    name = b?.pdf?.name ?? "documento.pdf";
    isPdf = true;
  } else if (type === "file") {
    url = b?.file?.file?.url ?? b?.file?.external?.url ?? "";
    name = (b?.file?.name as string) ?? "";
    isPdf = name.toLowerCase().endsWith(".pdf");
    isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(name);
  } else if (type === "image") {
    url = b?.image?.file?.url ?? b?.image?.external?.url ?? "";
    name = "imagen";
    isImage = true;
  }

  if (!url) return null;
  return { url, name, isPdf, isImage };
}

async function readItemBlocksAsync(itemId: string): Promise<string> {
  const res = callNtn(`v1/blocks/${itemId}/children`);
  if (!res.ok) return "";
  const data = res.data as { results?: unknown[] };
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const b of (data?.results ?? []) as any[]) {
    const fileInfo = getFileUrl(b);
    if (fileInfo) {
      const label = fileInfo.name ? ` (${fileInfo.name})` : "";
      if (fileInfo.isPdf) {
        const text = await extractPdfUrl(fileInfo.url);
        lines.push(`  📄 PDF${label}:\n${text.split("\n").map((l) => `    ${l}`).join("\n")}`);
      } else if (fileInfo.isImage) {
        const desc = await describeImage(fileInfo.url);
        lines.push(`  🖼️ Imagen${label}:\n${desc.split("\n").map((l) => `    ${l}`).join("\n")}`);
      }
      continue;
    }
    const text = extractBlockText(b);
    if (text.trim()) lines.push(`  ${text}`);
  }
  return lines.join("\n");
}

const VIAJE_DBS: Array<{ id: string; label: string }> = [
  { id: "44f70e0b-35eb-4b2f-bc9d-93c569d87831", label: "Alojamiento" },
  { id: "19201a50-d4dd-44ff-93d6-b32d1c95b4de", label: "Pasajes" },
  { id: "9769869a-df35-4a22-906b-436c0bd093d2", label: "Plan de Viaje" },
];

export async function getVacacionDetail(pageId: string): Promise<string> {
  const pageRes = callNtn(`v1/pages/${pageId}`);
  if (!pageRes.ok) return `❌ Error leyendo página: ${pageRes.error}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entry = parseVacacion(pageRes.data as any);

  // Text blocks from the page itself
  const blocksRes = callNtn(`v1/blocks/${pageId}/children`);
  const textLines: string[] = [];
  if (blocksRes.ok) {
    const data = blocksRes.data as { results?: unknown[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const b of (data?.results ?? []) as any[]) {
      const type: string = b?.type ?? "";
      if (type === "child_database") continue;
      const text = extractBlockText(b);
      if (!text.trim()) continue;
      const prefix =
        type === "bulleted_list_item" || type === "to_do" ? "• " :
        type === "numbered_list_item" ? "- " : "";
      textLines.push(`${prefix}${text}`);
    }
  }

  // Build output
  const lines: string[] = [`📋 <b>${entry.name}</b>`, ""];
  if (entry.fecha) {
    const rango = formatFechaRango(entry.fecha);
    const dias = entry.diasVacas ?? calcDias(entry.fecha);
    lines.push(`📅 ${rango}${dias != null ? ` · ${dias} días` : ""}`);
  }
  if (entry.pais) lines.push(`📍 ${entry.pais}`);
  if (entry.pptoUsd != null) lines.push(`💰 Presupuesto: $${entry.pptoUsd}`);
  if (entry.registroVacaciones != null)
    lines.push(`✅ Registro vacaciones: ${entry.registroVacaciones ? "sí" : "no"}`);
  if (entry.anoVacaciones) lines.push(`Año: ${entry.anoVacaciones}`);
  if (textLines.length > 0) lines.push("", "<b>Notas:</b>", textLines.join("\n").slice(0, 1500));

  // Query central DBs filtered by Viaje relation
  const filter = { property: "Viaje", relation: { contains: pageId } };
  for (const db of VIAJE_DBS) {
    const queryRes = callNtn(`v1/data_sources/${db.id}/query`, { body: { filter } });
    if (!queryRes.ok) continue;
    const items = (queryRes.data as { results?: unknown[] })?.results ?? [];
    if (items.length === 0) continue;

    lines.push("", `<b>${db.label}</b>`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const item of items as any[]) {
      const name = getItemTitle(item);
      lines.push(`• ${name}`);
      const itemText = await readItemBlocksAsync(item.id as string);
      if (itemText) lines.push(itemText);
    }
  }

  lines.push("", `<a href="${entry.url}">Ver en Notion →</a>`);
  return lines.join("\n");
}
