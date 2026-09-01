import { callNtn } from "../src/shared/ntn.js";
import { ENTITIES } from "../src/tools/research-competencia-entities.js";

const YAPE_BOLIVIA_PAGE_ID = "1f3c487609dd800a97e7c11870f3bd3f";

interface DbCreateResult {
  id: string;
  data_sources: Array<{ id: string }>;
}

function must<T>(res: { ok: boolean; data?: T; error?: string }, label: string): T {
  if (!res.ok || res.data === undefined) {
    console.error(`❌ ${label} falló:`, res.error);
    process.exit(1);
  }
  return res.data;
}

async function main(): Promise<void> {
  console.log("Creando DB 'Competencia — Cambios'...");
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
  const cambios = must<DbCreateResult>(cambiosRes, "crear DB Cambios");
  console.log(`✅ Cambios: db=${cambios.id} ds=${cambios.data_sources[0].id}`);

  console.log("Creando DB 'Informe Análisis Competencia'...");
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
  const informe = must<DbCreateResult>(informeRes, "crear DB Informe");
  console.log(`✅ Informe: db=${informe.id} ds=${informe.data_sources[0].id}`);

  console.log("Creando 6 páginas de estado...");
  const statusPageIds: Record<string, string> = {};
  for (const entity of ENTITIES) {
    const pageRes = callNtn("v1/pages", {
      method: "POST",
      body: {
        parent: { type: "page_id", page_id: YAPE_BOLIVIA_PAGE_ID },
        properties: { title: { title: [{ type: "text", text: { content: `Estado — ${entity.nombre}` } }] } },
      },
    });
    const page = must<{ id: string }>(pageRes, `crear página de estado (${entity.nombre})`);
    statusPageIds[entity.id] = page.id;
    console.log(`✅ ${entity.nombre}: ${page.id}`);
  }

  console.log("\n--- Pegar esto en research-competencia-ids.ts ---\n");
  console.log(`export const CAMBIOS_DB = ${JSON.stringify(cambios.id)};`);
  console.log(`export const CAMBIOS_DS = ${JSON.stringify(cambios.data_sources[0].id)};`);
  console.log(`export const INFORME_DB = ${JSON.stringify(informe.id)};`);
  console.log(`export const INFORME_DS = ${JSON.stringify(informe.data_sources[0].id)};`);
  console.log(`export const STATUS_PAGE_IDS: Record<string, string> = ${JSON.stringify(statusPageIds, null, 2)};`);
}

main();
