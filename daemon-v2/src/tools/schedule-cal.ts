import { callNtn } from "../shared/ntn.js";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readItemBlocks(itemId: string): string {
  const res = callNtn(`v1/blocks/${itemId}/children`);
  if (!res.ok) return "";
  const data = res.data as { results?: unknown[] };
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const b of (data?.results ?? []) as any[]) {
    const text = extractBlockText(b);
    if (text.trim()) lines.push(`  ${text}`);
  }
  return lines.join("\n");
}

export function getVacacionDetail(pageId: string): string {
  const pageRes = callNtn(`v1/pages/${pageId}`);
  if (!pageRes.ok) return `❌ Error leyendo página: ${pageRes.error}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entry = parseVacacion(pageRes.data as any);

  const blocksRes = callNtn(`v1/blocks/${pageId}/children`);
  const textLines: string[] = [];
  const childDbs: Array<{ id: string; title: string }> = [];

  if (blocksRes.ok) {
    const data = blocksRes.data as { results?: unknown[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const b of (data?.results ?? []) as any[]) {
      const type: string = b?.type ?? "";
      if (type === "child_database") {
        childDbs.push({
          id: b.id as string,
          title: (b?.child_database?.title as string) ?? "Items",
        });
        continue;
      }
      const text = extractBlockText(b);
      if (!text.trim()) continue;
      const prefix =
        type === "bulleted_list_item" || type === "to_do"
          ? "• "
          : type === "numbered_list_item"
          ? "- "
          : "";
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

  // Query inline databases (child_database blocks)
  for (const db of childDbs) {
    const queryRes = callNtn(`v1/data_sources/${db.id}/query`);
    if (!queryRes.ok) continue;
    const qdata = queryRes.data as { results?: unknown[] };
    const items = qdata?.results ?? [];
    if (items.length === 0) continue;

    lines.push("", `<b>${db.title}</b>`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const item of items as any[]) {
      const name = getItemTitle(item);
      lines.push(`• ${name}`);
      const itemText = readItemBlocks(item.id as string);
      if (itemText) lines.push(itemText);
    }
  }

  lines.push("", `<a href="${entry.url}">Ver en Notion →</a>`);

  return lines.join("\n").slice(0, 4000);
}
