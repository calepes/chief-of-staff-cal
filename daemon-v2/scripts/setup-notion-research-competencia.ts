import { callNtn } from "../src/shared/ntn.js";
import { ENTITIES } from "../src/tools/research-competencia-entities.js";

const YAPE_BOLIVIA_PAGE_ID = "1f3c487609dd800a97e7c11870f3bd3f";

interface DbCreateResult {
  id: string;
  data_sources: Array<{ id: string }>;
}

interface ChildBlock {
  id: string;
  type: string;
  child_database?: { title?: string };
  child_page?: { title?: string };
}

function must<T>(res: { ok: boolean; data?: T; error?: string }, label: string): T {
  if (!res.ok || res.data === undefined) {
    console.error(`❌ ${label} falló:`, res.error);
    process.exit(1);
  }
  return res.data;
}

/**
 * Lista los hijos directos de YAPE_BOLIVIA_PAGE_ID (paginado).
 *
 * Deliberadamente NO usa `/v1/search` para chequear idempotencia: el índice
 * de búsqueda de Notion tiene demora real en indexar contenido recién creado
 * (confirmado en vivo 2026-09-01 — un segundo run del script, segundos
 * después del primero, no encontró nada por `search` y creó TODO duplicado).
 * Listar los children de la página sí es consistente al instante — es una
 * lectura directa del árbol de bloques, no un índice separado.
 */
async function listYapeBoliviaChildren(): Promise<ChildBlock[]> {
  const children: ChildBlock[] = [];
  let cursor: string | undefined;
  do {
    const path = cursor
      ? `v1/blocks/${YAPE_BOLIVIA_PAGE_ID}/children?page_size=100&start_cursor=${cursor}`
      : `v1/blocks/${YAPE_BOLIVIA_PAGE_ID}/children?page_size=100`;
    const res = callNtn(path);
    const page = must<{ results: ChildBlock[]; has_more: boolean; next_cursor: string | null }>(
      res,
      "listar hijos de la página Yape Bolivia",
    );
    children.push(...page.results);
    cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
  } while (cursor);
  return children;
}

async function findExistingDb(children: ChildBlock[], title: string): Promise<DbCreateResult | null> {
  const match = children.find((c) => c.type === "child_database" && c.child_database?.title === title);
  if (!match) return null;
  return must<DbCreateResult>(callNtn(`v1/databases/${match.id}`), `releer DB existente (${title})`);
}

function findExistingPage(children: ChildBlock[], title: string): { id: string } | null {
  const match = children.find((c) => c.type === "child_page" && c.child_page?.title === title);
  return match ? { id: match.id } : null;
}

async function main(): Promise<void> {
  const children = await listYapeBoliviaChildren();

  console.log("Procesando DB 'Competencia — Cambios'...");
  let cambios: DbCreateResult;
  const existingCambios = await findExistingDb(children, "Competencia — Cambios");
  if (existingCambios) {
    cambios = existingCambios;
    console.log(`↩️ Ya existe: db=${cambios.id} ds=${cambios.data_sources[0].id}`);
  } else {
    const cambiosRes = callNtn("v1/databases", {
      method: "POST",
      body: {
        parent: { type: "page_id", page_id: YAPE_BOLIVIA_PAGE_ID },
        is_inline: false,
        title: [{ type: "text", text: { content: "Competencia — Cambios" } }],
        properties: {
          Hallazgo: { title: {} },
          Entidad: { select: { options: ENTITIES.map((e) => ({ name: e.nombre })) } },
          "Dimensión": {
            select: { options: [{ name: "Producto" }, { name: "Estrategia" }, { name: "GTM" }, { name: "Hiring" }] },
          },
          Fecha: { date: {} },
          "Descripción": { rich_text: {} },
          Fuente: { url: {} },
        },
      },
    });
    cambios = must<DbCreateResult>(cambiosRes, "crear DB Cambios");
    console.log(`✅ Cambios: db=${cambios.id} ds=${cambios.data_sources[0].id}`);
  }

  console.log("Procesando DB 'Informe Análisis Competencia'...");
  let informe: DbCreateResult;
  const existingInforme = await findExistingDb(children, "Informe Análisis Competencia");
  if (existingInforme) {
    informe = existingInforme;
    console.log(`↩️ Ya existe: db=${informe.id} ds=${informe.data_sources[0].id}`);
  } else {
    const informeRes = callNtn("v1/databases", {
      method: "POST",
      body: {
        parent: { type: "page_id", page_id: YAPE_BOLIVIA_PAGE_ID },
        is_inline: false,
        title: [{ type: "text", text: { content: "Informe Análisis Competencia" } }],
        properties: {
          Informe: { title: {} },
          Fecha: { date: {} },
          "Timeframe (días)": { number: {} },
          "Entidades incluidas": { rich_text: {} },
          Hallazgos: { number: {} },
        },
      },
    });
    informe = must<DbCreateResult>(informeRes, "crear DB Informe");
    console.log(`✅ Informe: db=${informe.id} ds=${informe.data_sources[0].id}`);
  }

  console.log("Procesando 6 páginas de estado...");
  const statusPageIds: Record<string, string> = {};
  for (const entity of ENTITIES) {
    const pageTitle = `Estado — ${entity.nombre}`;
    const existingPage = findExistingPage(children, pageTitle);
    if (existingPage) {
      console.log(`↩️ ${entity.nombre}: ${existingPage.id}`);
      statusPageIds[entity.id] = existingPage.id;
    } else {
      const pageRes = callNtn("v1/pages", {
        method: "POST",
        body: {
          parent: { type: "page_id", page_id: YAPE_BOLIVIA_PAGE_ID },
          properties: { title: { title: [{ type: "text", text: { content: pageTitle } }] } },
        },
      });
      const page = must<{ id: string }>(pageRes, `crear página de estado (${entity.nombre})`);
      statusPageIds[entity.id] = page.id;
      console.log(`✅ ${entity.nombre}: ${page.id}`);
    }
  }

  console.log("\n--- Pegar esto en research-competencia-ids.ts ---\n");
  console.log(`export const CAMBIOS_DB = ${JSON.stringify(cambios.id)};`);
  console.log(`export const CAMBIOS_DS = ${JSON.stringify(cambios.data_sources[0].id)};`);
  console.log(`export const INFORME_DB = ${JSON.stringify(informe.id)};`);
  console.log(`export const INFORME_DS = ${JSON.stringify(informe.data_sources[0].id)};`);
  console.log(`export const STATUS_PAGE_IDS: Record<string, string> = ${JSON.stringify(statusPageIds, null, 2)};`);
}

main();
