import { callNtn } from "../shared/ntn.js";
import { CAMBIOS_DB, INFORME_DB, STATUS_PAGE_IDS } from "./research-competencia-ids.js";
import { getEntity } from "./research-competencia-entities.js";
import type { EntitySnapshot, Hallazgo, EntityRunResult } from "./research-competencia-types.js";

async function replacePageBody(pageId: string, blocks: unknown[]): Promise<void> {
  const listRes = callNtn(`v1/blocks/${pageId}/children?page_size=100`);
  if (listRes.ok) {
    const data = listRes.data as { results?: Array<{ id: string }> };
    for (const block of data.results ?? []) {
      callNtn(`v1/blocks/${block.id}`, { method: "DELETE" });
    }
  }
  callNtn(`v1/blocks/${pageId}/children`, { method: "PATCH", body: { children: blocks } });
}

function codeBlock(json: string): unknown {
  return {
    object: "block",
    type: "code",
    code: { language: "json", rich_text: [{ type: "text", text: { content: json.slice(0, 2000) } }] },
  };
}

function paragraphBlocks(text: string, chunkFn: (t: string, n: number) => string[]): unknown[] {
  return chunkFn(text, 1900).map((chunk) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
  }));
}

export async function readEntityState(entityId: string): Promise<EntitySnapshot | null> {
  const pageId = STATUS_PAGE_IDS[entityId];
  if (!pageId) throw new Error(`Sin página de estado para ${entityId}`);
  const res = callNtn(`v1/blocks/${pageId}/children?page_size=10`);
  if (!res.ok) return null;
  const data = res.data as {
    results?: Array<{ type?: string; code?: { rich_text?: Array<{ plain_text?: string }> } }>;
  };
  const found = (data.results ?? []).find((b) => b.type === "code");
  const raw = found?.code?.rich_text?.map((t) => t.plain_text ?? "").join("") ?? "";
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EntitySnapshot;
  } catch {
    return null;
  }
}

export async function writeEntityState(entityId: string, snapshot: EntitySnapshot): Promise<void> {
  const pageId = STATUS_PAGE_IDS[entityId];
  if (!pageId) throw new Error(`Sin página de estado para ${entityId}`);
  await replacePageBody(pageId, [codeBlock(JSON.stringify(snapshot, null, 2))]);
}

export async function appendCambios(
  entityId: string,
  hallazgos: Hallazgo[],
  informePageId: string,
  fecha: string,
): Promise<void> {
  const entity = getEntity(entityId);
  for (const h of hallazgos) {
    callNtn("v1/pages", {
      method: "POST",
      body: {
        parent: { database_id: CAMBIOS_DB },
        properties: {
          Hallazgo: { title: [{ text: { content: h.descripcion.slice(0, 100) } }] },
          Entidad: { select: { name: entity.nombre } },
          "Dimensión": { select: { name: h.dimension } },
          Fecha: { date: { start: fecha } },
          "Descripción": { rich_text: [{ text: { content: h.descripcion } }] },
          Fuente: h.fuente ? { url: h.fuente } : { url: null },
          Corrida: { relation: [{ id: informePageId }] },
        },
      },
    });
  }
}

export function buildInformeReportText(fecha: string, timeframeDias: number, entidades: EntityRunResult[]): string {
  const lines: string[] = [`Informe de análisis de competencia — ${fecha} (últimos ${timeframeDias} días)`, ""];
  for (const e of entidades) {
    lines.push(`— ${e.entityNombre} —`);
    if (e.error) {
      lines.push(`  Error en esta corrida: ${e.error}`);
    } else if (e.primeraCorrida) {
      lines.push("  Primera corrida — se guardó el estado inicial, sin comparación.");
    } else if (e.hallazgos.length === 0) {
      lines.push("  Sin novedades.");
    } else {
      for (const h of e.hallazgos) {
        lines.push(`  [${h.dimension}] ${h.descripcion}${h.fuente ? ` (${h.fuente})` : ""}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function createInformePage(
  fecha: string,
  timeframeDias: number,
  entidades: EntityRunResult[],
  chunkFn: (t: string, n: number) => string[],
): Promise<{ pageId: string; url: string }> {
  const totalHallazgos = entidades.reduce((sum, e) => sum + e.hallazgos.length, 0);
  const nombres = entidades.map((e) => e.entityNombre).join(", ");
  const createRes = callNtn("v1/pages", {
    method: "POST",
    body: {
      parent: { database_id: INFORME_DB },
      properties: {
        Informe: { title: [{ text: { content: `Competencia — ${fecha}` } }] },
        Fecha: { date: { start: fecha } },
        "Timeframe (días)": { number: timeframeDias },
        "Entidades incluidas": { rich_text: [{ text: { content: nombres } }] },
        Hallazgos: { number: totalHallazgos },
      },
    },
  });
  if (!createRes.ok || !createRes.data) {
    throw new Error(`No se pudo crear la página de informe: ${createRes.error}`);
  }
  const page = createRes.data as { id: string; url: string };
  const reportText = buildInformeReportText(fecha, timeframeDias, entidades);
  await replacePageBody(page.id, paragraphBlocks(reportText, chunkFn));
  return { pageId: page.id, url: page.url };
}
