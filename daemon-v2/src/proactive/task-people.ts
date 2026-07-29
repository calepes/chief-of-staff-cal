// task-people.ts — snapshot ESTÁTICO de la DB People de Yape (57e58779-c09c-4dea-8a61-023fb6c9a0a0),
// ordenado por uso real en la propiedad "Asignado a" de la DB Tareas.
//
// Por qué estático y no una query: el picker de la tarjeta de tareas tiene que renderizar sin
// tocar Notion (decisión de Cal, 2026-07-28) — la DB People tiene 639 filas y traerlas por cada
// mail sería un round-trip caro en el camino crítico del cron. Los 20 de acá cubren el 99% de los
// casos reales; el resto entra por el escape "✍️ Otro", que SÍ consulta Notion (ver
// findPersonInNotion) y es el ÚNICO camino que lo hace.
//
// ⚠️ Regenerar con `npx tsx scripts/refresh-task-people.ts` (imprime este archivo listo para
// pegar) cuando el ranking envejezca — no editar los ids a mano.
// Snapshot tomado el 2026-07-28 sobre 763 tareas.

export interface TaskPerson {
  id: string;
  nombre: string;
}

/** Top 20 por uso en "Asignado a". CAL primero: 525 de 763 tareas son suyas. */
export const TASK_PEOPLE: TaskPerson[] = [
  { id: "2f2fc7e7-5230-43b2-b65c-19d38f608de7", nombre: "CAL" },
  { id: "1a8c4876-09dd-8031-b1de-d5c21624045d", nombre: "Lorena Velasco" },
  { id: "233c4876-09dd-808e-9082-c483062ceb26", nombre: "Matias Papini" },
  { id: "5b864a96-3b22-4fc3-9513-ccbde6cdaed1", nombre: "Dieter Belmonte" },
  { id: "1f4c4876-09dd-80cf-9719-faed2e04cfae", nombre: "Cinthia Ibañez" },
  { id: "1f2c4876-09dd-80d5-ba7f-c16a75af4eb4", nombre: "Karina Olazabal" },
  { id: "1f4c4876-09dd-8044-94e0-d184f3212327", nombre: "Alicia Vargas" },
  { id: "1f8c4876-09dd-80a0-998e-d156d9666c7a", nombre: "Maria Elena Canahua" },
  { id: "1f3c4876-09dd-8007-975c-f9bf5fac6d5e", nombre: "Mauricio Rojas" },
  { id: "1f4c4876-09dd-8071-b3a0-c2b2fb34c0c7", nombre: "Jessica Hurtado" },
  { id: "2a2c4876-09dd-80d3-aafb-c18a57b2f933", nombre: "Ivan Contreras" },
  { id: "1f1c4876-09dd-805a-b86b-d069db5b6eb2", nombre: "Giovana Diaz" },
  { id: "1f4c4876-09dd-80cb-9872-c8765ac5b3fc", nombre: "Fernanda Dalence" },
  { id: "1f1c4876-09dd-802d-93cb-c983190f34d8", nombre: "Jenner Castillo" },
  { id: "33dc4876-09dd-8058-808f-daa64b372cf5", nombre: "Alonso Romani" },
  { id: "208c4876-09dd-8094-bf64-eb8e49f80bc4", nombre: "Helbert Romero" },
  { id: "1f3c4876-09dd-80b1-9f1c-dce6969be6a5", nombre: "Juan Diego Leon" },
  { id: "1f8c4876-09dd-806e-abcf-fcc5225185f5", nombre: "Rodrigo Valdez" },
  { id: "202c4876-09dd-806a-ab73-c180661ca951", nombre: "Yalile Uriarte" },
  { id: "2f7c4876-09dd-8064-94fc-ff8596e0cf54", nombre: "Migdo Quispe" },
];

/** Cal — default de "Asignado a" y "Solicitado por" (mismo id que CAL_PEOPLE_PAGE_ID). */
export const CAL_PERSON: TaskPerson = TASK_PEOPLE[0]!;

export const PEOPLE_DATA_SOURCE_ID = "d9b5e172-edd2-4f08-bf2e-9a2f5f39c92f";

/** Sin acentos, sin case, sin espacios de más — "cinthia ibanez" matchea "Cinthia Ibañez". */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Busca en el snapshot: exacto primero, después "empieza con" y por último nombre de pila.
 * Solo devuelve resultado si es INEQUÍVOCO — con 2+ candidatos devuelve null y el caller le
 * pregunta a Cal, nunca elige por él (mismo criterio que el tildado del backlog). */
export function findPersonInSnapshot(query: string): TaskPerson | null {
  const q = normalizeName(query);
  if (!q) return null;

  const exact = TASK_PEOPLE.filter((p) => normalizeName(p.nombre) === q);
  if (exact.length === 1) return exact[0]!;

  const prefix = TASK_PEOPLE.filter((p) => normalizeName(p.nombre).startsWith(q));
  if (prefix.length === 1) return prefix[0]!;

  const anyPart = TASK_PEOPLE.filter((p) =>
    normalizeName(p.nombre).split(" ").some((parte) => parte === q),
  );
  if (anyPart.length === 1) return anyPart[0]!;

  return null;
}

interface NotionSearchDeps {
  notionToken: string;
  fetchFn?: typeof fetch;
}

/**
 * Escape del snapshot: consulta la DB People real por título. ÚNICO camino de este pipeline que
 * pega a Notion para resolver una persona — se llega acá solo si Cal escribió un nombre que no
 * está entre los 20 de arriba.
 *
 * Devuelve null si hay 0 o 2+ coincidencias: con ambigüedad se le vuelve a preguntar a Cal en vez
 * de asignarle la tarea a la persona equivocada.
 */
export async function findPersonInNotion(
  query: string,
  deps: NotionSearchDeps,
): Promise<TaskPerson | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(`https://api.notion.com/v1/data_sources/${PEOPLE_DATA_SOURCE_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      page_size: 10,
      // La propiedad title de la DB People se llama "Name" (verificado contra el schema real,
      // 2026-07-28) — con "Nombre" la query devuelve 400 y el escape queda muerto.
      filter: { property: "Name", title: { contains: query.trim() } },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`notion people query -> ${res.status}`);

  const data = (await res.json()) as { results?: Array<{ id: string; properties?: Record<string, any> }> };
  const found: TaskPerson[] = [];
  for (const row of data.results ?? []) {
    const titleProp = Object.values(row.properties ?? {}).find((p: any) => p?.type === "title") as any;
    const nombre = (titleProp?.title ?? []).map((t: any) => t.plain_text).join("").trim();
    if (nombre) found.push({ id: row.id, nombre });
  }

  if (found.length === 1) return found[0]!;

  // `contains` de Notion es amplio ("Ana" trae "Ana" y "Mariana"): si hay varias, un match
  // exacto de nombre completo sigue siendo inequívoco y vale usarlo.
  const q = normalizeName(query);
  const exact = found.filter((p) => normalizeName(p.nombre) === q);
  return exact.length === 1 ? exact[0]! : null;
}
