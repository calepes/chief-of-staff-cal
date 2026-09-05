import { callNtn } from "../shared/ntn.js";
import { CAMBIOS_DB, INFORME_DB, STATUS_PAGE_IDS } from "./research-competencia-ids.js";
import { getEntity } from "./research-competencia-entities.js";
import type { BattlecardPunto, EntitySnapshot, Hallazgo, EntityRunResult } from "./research-competencia-types.js";

// Igual patrón que hallazgoBullet: si el punto trae fuente, aparece como hipervínculo real —
// permite verificar de dónde salió cada fortaleza/debilidad en vez de confiar a ciegas.
function puntoBullet(p: BattlecardPunto): unknown {
  const rich_text: unknown[] = [{ type: "text", text: { content: p.texto } }];
  if (p.fuente) {
    rich_text.push({ type: "text", text: { content: " " } });
    rich_text.push({ type: "text", text: { content: "(fuente)", link: { url: p.fuente } } });
  }
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text } };
}

function amenazaParagraph(amenaza: string): unknown {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        { type: "text", text: { content: "Amenaza: " }, annotations: { bold: true } },
        { type: "text", text: { content: amenaza } },
      ],
    },
  };
}

// ponytail: callNtn es spawnSync — cada llamada bloquea el proceso Node ENTERO (single-thread),
// no solo esta corrida. Una corrida completa hace ~20-50 de estas llamadas (6 entidades ×
// read/write de estado + filas de Cambios + informe). Riesgo aceptado a propósito (decisión de
// Cal, 2026-09-01): esto corre 1x/semana + on-demand ocasional, no es un hot path, y cada
// llamada individual es rápida (sub-segundo típico). Si algún día se vuelve fricción real
// (Jano tarda notablemente en responder otros chats durante una corrida), migrar callNtn de
// shared/ntn.ts a execFile async — mismo patrón que ya usa consultarJson en tools/consultar-json.ts
// por este mismo motivo.

async function replacePageBody(pageId: string, blocks: unknown[]): Promise<void> {
  const listRes = callNtn(`v1/blocks/${pageId}/children?page_size=100`);
  if (listRes.ok) {
    const data = listRes.data as { results?: Array<{ id: string }> };
    for (const block of data.results ?? []) {
      callNtn(`v1/blocks/${block.id}`, { method: "DELETE" });
    }
  }
  const appendRes = callNtn(`v1/blocks/${pageId}/children`, { method: "PATCH", body: { children: blocks } });
  if (!appendRes.ok) {
    throw new Error(`No se pudo escribir el contenido de la página ${pageId}: ${appendRes.error}`);
  }
}

function codeBlock(json: string, chunkFn: (t: string, n: number) => string[]): unknown {
  return {
    object: "block",
    type: "code",
    code: {
      language: "json",
      rich_text: chunkFn(json, 2000).map((chunk) => ({ type: "text", text: { content: chunk } })),
    },
  };
}

function paragraphBlock(text: string, italic = false): unknown {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: text }, annotations: { italic } }] },
  };
}

function headingBlock(text: string): unknown {
  return {
    object: "block",
    type: "heading_3",
    heading_3: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

// Cada hallazgo es un bullet con la dimensión en negrita y la fuente como hipervínculo real
// (no una URL pegada como texto) — pedido de Cal 2026-09-01 tras ver el informe como texto plano.
function hallazgoBullet(h: Hallazgo): unknown {
  const rich_text: unknown[] = [
    { type: "text", text: { content: `${h.dimension}: ` }, annotations: { bold: true } },
    { type: "text", text: { content: h.descripcion.slice(0, 1900) } },
  ];
  if (h.fuente) {
    rich_text.push({ type: "text", text: { content: " " } });
    rich_text.push({ type: "text", text: { content: "(fuente)", link: { url: h.fuente } } });
  }
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text } };
}

export async function readEntityState(entityId: string): Promise<EntitySnapshot | null> {
  const pageId = STATUS_PAGE_IDS[entityId];
  if (!pageId) throw new Error(`Sin página de estado para ${entityId}`);
  // page_size=100 (no 10): el battlecard antepone varios bloques (heading/paragraphs/bullets)
  // antes del code block con el JSON real — con page_size=10 el code block podía quedar fuera
  // de la primera página y el baseline se perdía en silencio (encontrado 2026-09-01, una entidad
  // con baseline real volvió a reportar "primera corrida").
  const res = callNtn(`v1/blocks/${pageId}/children?page_size=100`);
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

// Resumen ejecutivo legible arriba del JSON crudo (que se mantiene para el diff de la próxima
// corrida) — pedido de Cal 2026-09-01: la página de estado era ilegible como battlecard.
export function buildBattlecardBlocks(snapshot: EntitySnapshot): unknown[] {
  const bc = snapshot.battlecard;
  if (!bc) return [];
  const blocks: unknown[] = [headingBlock("Battlecard"), amenazaParagraph(bc.amenaza)];
  if (bc.resumen) blocks.push(paragraphBlock(bc.resumen));
  if (bc.fortalezas.length > 0) {
    blocks.push(headingBlock("Fortalezas"));
    for (const f of bc.fortalezas) blocks.push(puntoBullet(f));
  }
  if (bc.debilidades.length > 0) {
    blocks.push(headingBlock("Debilidades"));
    for (const d of bc.debilidades) blocks.push(puntoBullet(d));
  }
  return blocks;
}

export async function writeEntityState(
  entityId: string,
  snapshot: EntitySnapshot,
  chunkFn: (t: string, n: number) => string[],
): Promise<void> {
  const pageId = STATUS_PAGE_IDS[entityId];
  if (!pageId) throw new Error(`Sin página de estado para ${entityId}`);
  await replacePageBody(pageId, [...buildBattlecardBlocks(snapshot), codeBlock(JSON.stringify(snapshot, null, 2), chunkFn)]);
}

export async function appendCambios(
  entityId: string,
  hallazgos: Hallazgo[],
  informePageId: string,
  fecha: string,
): Promise<void> {
  const entity = getEntity(entityId);
  const failures: string[] = [];
  let written = 0;
  for (const h of hallazgos) {
    const res = callNtn("v1/pages", {
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
    if (!res.ok) {
      failures.push(`"${h.descripcion.slice(0, 60)}": ${res.error}`);
    } else {
      written++;
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `appendCambios: ${written}/${hallazgos.length} hallazgos escritos, ${failures.length} fallaron — ${failures.join(" | ")}`,
    );
  }
}

function tableCell(texto: string): unknown[] {
  return [{ type: "text", text: { content: texto } }];
}

function tableRow(cells: string[]): unknown {
  return { object: "block", type: "table_row", table_row: { cells: cells.map(tableCell) } };
}

// Tabla comparativa de KPIs de ads — solo tiene sentido si AL MENOS una entidad trae `adsKpis`
// (una entidad que falló antes de llegar a ese bloque, ver `r.error` en research-competencia.ts,
// no lo trae). Va ANTES de las secciones por entidad porque es justamente para COMPARAR entre las
// 6, no un dato de una sola — a diferencia del resto del informe, organizado por entidad.
export function buildAdsKpisBlocks(entidades: EntityRunResult[]): unknown[] {
  if (!entidades.some((e) => e.adsKpis)) return [];
  const header = ["Entidad", "Creativos activos", "Campañas nuevas", "Duración prom. (días)", "Formato (img/disp/?)"];
  const filas = entidades.map((e) => {
    const k = e.adsKpis;
    return tableRow([
      e.entityNombre,
      k ? String(k.creativosActivos) : "—",
      k ? String(k.campanasNuevas) : "—",
      k?.duracionPromedioDias != null ? String(k.duracionPromedioDias) : "—",
      k ? `${k.mixFormato.imagen} / ${k.mixFormato.display} / ${k.mixFormato.desconocido}` : "—",
    ]);
  });
  return [
    headingBlock("Actividad publicitaria — comparativa"),
    // Disclaimer explícito pedido por Cal: son proxies de VOLUMEN, nunca gasto real — ni Google Ads
    // Transparency Center ni Meta Ad Library exponen presupuesto/impresiones/alcance gratis para
    // anuncios comerciales (ver research-competencia-ads.ts).
    paragraphBlock(
      "Proxies de volumen/actividad publicitaria (creativos recuperados, campañas nuevas, duración, formato) — " +
        "NO son gasto real ni impresiones/alcance: ninguna fuente gratuita los expone para anuncios comerciales.",
      true,
    ),
    {
      object: "block",
      type: "table",
      table: {
        table_width: header.length,
        has_column_header: true,
        has_row_header: false,
        children: [tableRow(header), ...filas],
      },
    },
  ];
}

/** "Instagram: 45.231 (+1.302 vs. semana pasada)" — solo si hay al menos un dato de seguidores en
 * esta corrida. Sin gráficos ni serie completa (YAGNI, pedido explícito) — el delta contra el
 * punto anterior de `seguidoresHistorial` alcanza para el informe semanal. */
function buildFollowersLine(snapshot: EntitySnapshot): unknown | null {
  const historial = snapshot.seguidoresHistorial;
  if (!historial || historial.length === 0) return null;
  const actual = historial[historial.length - 1];
  const anterior = historial.length >= 2 ? historial[historial.length - 2] : undefined;
  const partes: string[] = [];
  for (const [label, valor] of [["Instagram", actual.instagram], ["Facebook", actual.facebook]] as const) {
    if (valor === null) continue;
    const previo = anterior?.[label === "Instagram" ? "instagram" : "facebook"] ?? null;
    const delta = previo !== null ? valor - previo : null;
    const deltaTxt = delta !== null ? ` (${delta >= 0 ? "+" : ""}${delta.toLocaleString("es-BO")} vs. semana pasada)` : "";
    partes.push(`${label}: ${valor.toLocaleString("es-BO")}${deltaTxt}`);
  }
  if (partes.length === 0) return null;
  return paragraphBlock(`Seguidores — ${partes.join(" · ")}`, true);
}

export function buildInformeBlocks(entidades: EntityRunResult[]): unknown[] {
  const blocks: unknown[] = [...buildAdsKpisBlocks(entidades)];
  for (const e of entidades) {
    blocks.push(headingBlock(e.entityNombre));
    const followersLine = buildFollowersLine(e.snapshot);
    if (followersLine) blocks.push(followersLine);
    if (e.error) {
      blocks.push(paragraphBlock(`Error en esta corrida: ${e.error}`, true));
    } else if (e.primeraCorrida) {
      if (e.hallazgos.length === 0) {
        blocks.push(paragraphBlock("Primera corrida — se guardó el estado inicial, sin comparación.", true));
      } else {
        blocks.push(paragraphBlock("Primera corrida — hallazgos iniciales (sin comparación con corridas futuras):", true));
        for (const h of e.hallazgos) blocks.push(hallazgoBullet(h));
      }
    } else if (e.hallazgos.length === 0) {
      blocks.push(paragraphBlock("Sin novedades.", true));
    } else {
      for (const h of e.hallazgos) blocks.push(hallazgoBullet(h));
    }
  }
  return blocks;
}

export async function createInformePage(
  fecha: string,
  timeframeDias: number,
  entidades: EntityRunResult[],
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
  await replacePageBody(page.id, buildInformeBlocks(entidades));
  return { pageId: page.id, url: page.url };
}
