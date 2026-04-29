const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// DB Tareas schema (ver ~/Claude Projects/notion-reference.md):
// - "Nombre de tarea" (title)
// - "Estado" (status): Backlog | Sin empezar | En curso | Focus | Waiting for | Cancelada | Listo
// - "Asignado a" (relation → People DB) — array de page_ids
// - "Fecha" (date) — fecha trabajo
// - "Deadline" (date) — fecha límite
// - "Prioridad CAL" (select): P1 | P2 | P3 | P4

export interface NotionTasksDeps {
  notionToken: string;
  tareasDbId: string;
}

export interface Task {
  pageId: string;
  title: string;
  status: string;
  assigneePageIds?: string[];
  fecha?: string; // ISO date
  deadline?: string; // ISO date
  prioridad?: string;
  url?: string;
}

export interface ListTasksFilters {
  status?: string;
  assigneePageId?: string;
  fromDate?: string; // ISO YYYY-MM-DD — filtra por Fecha o Deadline >= fromDate
  toDate?: string;   // ISO YYYY-MM-DD — filtra por Fecha o Deadline <= toDate
  limit?: number;
}

export async function listTasks(deps: NotionTasksDeps, filters: ListTasksFilters = {}): Promise<Task[]> {
  const andClauses: Record<string, unknown>[] = [];
  if (filters.status) andClauses.push({ property: "Estado", status: { equals: filters.status } });
  if (filters.assigneePageId) andClauses.push({ property: "Asignado a", relation: { contains: filters.assigneePageId } });
  if (filters.fromDate) {
    andClauses.push({
      or: [
        { property: "Fecha", date: { on_or_after: filters.fromDate } },
        { property: "Deadline", date: { on_or_after: filters.fromDate } },
      ],
    });
  }
  if (filters.toDate) {
    andClauses.push({
      or: [
        { property: "Fecha", date: { on_or_before: filters.toDate } },
        { property: "Deadline", date: { on_or_before: filters.toDate } },
      ],
    });
  }

  const body: Record<string, unknown> = { page_size: filters.limit ?? 50 };
  if (andClauses.length > 0) body.filter = { and: andClauses };

  const res = await fetch(`${NOTION_API}/databases/${deps.tareasDbId}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${deps.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`listTasks failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { results: Array<Record<string, unknown>> };
  return data.results.map(parseTask);
}

function parseTask(page: Record<string, unknown>): Task {
  const props = (page as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
  const titleArr = (props["Nombre de tarea"]?.title as Array<{ plain_text: string }>) ?? [];
  const assigneeRel = (props["Asignado a"]?.relation as Array<{ id: string }>) ?? [];
  return {
    pageId: (page as { id: string }).id,
    title: titleArr.map((t) => t.plain_text).join(""),
    status: ((props.Estado?.status as { name?: string })?.name) ?? "",
    assigneePageIds: assigneeRel.map((r) => r.id),
    fecha: ((props.Fecha?.date as { start?: string })?.start) ?? undefined,
    deadline: ((props.Deadline?.date as { start?: string })?.start) ?? undefined,
    prioridad: ((props["Prioridad CAL"]?.select as { name?: string })?.name) ?? undefined,
    url: (page as { url?: string }).url,
  };
}

export interface CreateTaskArgs {
  title: string;
  status?: string;
  assigneePageId?: string;
  fechaIso?: string;
  deadlineIso?: string;
  prioridad?: string;
}

export async function createTask(deps: NotionTasksDeps, args: CreateTaskArgs): Promise<{ pageId: string; url?: string }> {
  const properties: Record<string, unknown> = {
    "Nombre de tarea": { title: [{ text: { content: args.title } }] },
  };
  if (args.status) properties.Estado = { status: { name: args.status } };
  if (args.assigneePageId) properties["Asignado a"] = { relation: [{ id: args.assigneePageId }] };
  if (args.fechaIso) properties.Fecha = { date: { start: args.fechaIso } };
  if (args.deadlineIso) properties.Deadline = { date: { start: args.deadlineIso } };
  if (args.prioridad) properties["Prioridad CAL"] = { select: { name: args.prioridad } };

  const res = await fetch(`${NOTION_API}/pages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${deps.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: deps.tareasDbId },
      properties,
    }),
  });
  if (!res.ok) throw new Error(`createTask failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { id: string; url?: string };
  return { pageId: data.id, url: data.url };
}

export async function setTaskStatus(deps: NotionTasksDeps, pageId: string, status: string): Promise<void> {
  await patchPage(deps, pageId, { Estado: { status: { name: status } } });
}

export async function setTaskFecha(deps: NotionTasksDeps, pageId: string, fechaIso: string): Promise<void> {
  await patchPage(deps, pageId, { Fecha: { date: { start: fechaIso } } });
}

export async function setTaskDeadline(deps: NotionTasksDeps, pageId: string, deadlineIso: string): Promise<void> {
  await patchPage(deps, pageId, { Deadline: { date: { start: deadlineIso } } });
}

async function patchPage(deps: NotionTasksDeps, pageId: string, properties: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${deps.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) throw new Error(`patchPage failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}
