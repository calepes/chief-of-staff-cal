import { callNtn } from "../src/shared/ntn.js";
import { ENTITIES } from "../src/tools/research-competencia-entities.js";

const YAPE_BOLIVIA_PAGE_ID = "1f3c487609dd800a97e7c11870f3bd3f";

interface DbCreateResult {
  id: string;
  data_sources: Array<{ id: string }>;
}

interface SearchResult {
  object: string;
  id: string;
  parent?: { page_id?: string; type?: string };
  title?: Array<{ plain_text?: string }>;
}

function must<T>(res: { ok: boolean; data?: T; error?: string }, label: string): T {
  if (!res.ok || res.data === undefined) {
    console.error(`❌ ${label} falló:`, res.error);
    process.exit(1);
  }
  return res.data;
}

async function findExistingByTitle(title: string, objectType: "database" | "page"): Promise<SearchResult | null> {
  const res = callNtn("v1/search", {
    method: "POST",
    body: {
      query: title,
      filter: { value: objectType, property: "object" },
    },
  });
  const search = must<{ results: SearchResult[] }>(res, `buscar ${objectType} existente`);

  // Filtrar por título exacto bajo YAPE_BOLIVIA_PAGE_ID
  const match = search.results.find(
    (r) =>
      r.object === objectType &&
      r.title?.[0]?.plain_text === title &&
      (objectType === "database" || r.parent?.page_id === YAPE_BOLIVIA_PAGE_ID)
  );

  return match || null;
}

async function main(): Promise<void> {
  console.log("Procesando DB 'Competencia — Cambios'...");
  let cambios: DbCreateResult;
  const existingCambios = await findExistingByTitle("Competencia — Cambios", "database");
  if (existingCambios) {
    console.log(`↩️ Ya existe: db=${existingCambios.id}`);
    cambios = existingCambios as DbCreateResult;
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
  const existingInforme = await findExistingByTitle("Informe Análisis Competencia", "database");
  if (existingInforme) {
    console.log(`↩️ Ya existe: db=${existingInforme.id}`);
    informe = existingInforme as DbCreateResult;
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
    const existingPage = await findExistingByTitle(pageTitle, "page");
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
