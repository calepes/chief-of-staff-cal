/**
 * Regenera el snapshot de `src/proactive/task-people.ts` contando el uso REAL de cada persona en
 * la propiedad "Asignado a" de la DB Tareas.
 *
 * Uso:  npx tsx scripts/refresh-task-people.ts [--write]
 *
 * Sin --write solo imprime el bloque TS para revisar; con --write reemplaza el array in situ.
 * El snapshot es estático a propósito (decisión de Cal, 2026-07-28): el picker de la tarjeta
 * renderiza sin tocar Notion. Correr esto cuando el ranking envejezca — no editar los ids a mano.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TAREAS_DS = "1f2c4876-09dd-80d2-8c0c-000b7f35059b";
const PEOPLE_DS = "d9b5e172-edd2-4f08-bf2e-9a2f5f39c92f";
const TOP_N = 20;
const CAL_ID = "2f2fc7e7-5230-43b2-b65c-19d38f608de7";

const token = process.env.NOTION_TOKEN;
if (!token) {
  console.error("Falta NOTION_TOKEN (está en ~/.cos-agent/.env y en ~/.claude/secrets/apps.env).");
  process.exit(1);
}

async function queryAll(dataSourceId: string): Promise<any[]> {
  const rows: any[] = [];
  let cursor: string | undefined;
  do {
    const res = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (!res.ok) throw new Error(`notion query ${dataSourceId} -> ${res.status}`);
    const data = (await res.json()) as { results: any[]; has_more: boolean; next_cursor?: string };
    rows.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return rows;
}

function titleOf(row: any): string {
  const prop = Object.values(row.properties ?? {}).find((p: any) => p?.type === "title") as any;
  return (prop?.title ?? []).map((t: any) => t.plain_text).join("").trim();
}

const tareas = await queryAll(TAREAS_DS);
const uso = new Map<string, number>();
for (const t of tareas) {
  for (const rel of t.properties?.["Asignado a"]?.relation ?? []) {
    uso.set(rel.id, (uso.get(rel.id) ?? 0) + 1);
  }
}

const people = new Map<string, string>();
for (const p of await queryAll(PEOPLE_DS)) people.set(p.id, titleOf(p) || "(sin nombre)");

const top = [...uso.entries()]
  .sort((a, b) => b[1] - a[1])
  // CAL siempre primero: es el default de la tarjeta, no solo el más usado.
  .sort((a, b) => (a[0] === CAL_ID ? -1 : b[0] === CAL_ID ? 1 : 0))
  .slice(0, TOP_N);

const bloque = [
  "export const TASK_PEOPLE: TaskPerson[] = [",
  ...top.map(([id]) => `  { id: ${JSON.stringify(id)}, nombre: ${JSON.stringify(people.get(id) ?? "?")} },`),
  "];",
].join("\n");

console.log(`# ${tareas.length} tareas · ${people.size} personas · top ${top.length}`);
for (const [id, n] of top) console.log(`  ${String(n).padStart(4)}  ${people.get(id)}`);
console.log("");
console.log(bloque);

if (process.argv.includes("--write")) {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "proactive", "task-people.ts");
  const src = readFileSync(file, "utf8");
  const next = src.replace(/export const TASK_PEOPLE: TaskPerson\[\] = \[[\s\S]*?\n\];/, bloque);
  if (next === src) {
    console.error("\n⚠️ No encontré el array TASK_PEOPLE para reemplazar — revisa el archivo a mano.");
    process.exit(1);
  }
  writeFileSync(file, next, "utf8");
  console.log(`\n✅ Actualizado ${file}`);
}
