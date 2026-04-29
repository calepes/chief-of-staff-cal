import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  listTasks,
  createTask,
  setTaskStatus,
  setTaskFecha,
  setTaskDeadline,
  type ListTasksFilters,
} from "./tools/notion-tasks.js";
import { getPersonas } from "./tools/personas.js";
import { getOutlookEvents } from "./tools/outlook.js";
import { getHealthSummary, getHealthTrend } from "./tools/health.js";

const READ_ONLY = { annotations: { readOnlyHint: true } };

function asText(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

export interface ToolDeps {
  notionToken: string;
  tareasDbId: string;
  peopleDbId: string;
  healthApiKey: string;
}

export function buildSdkTools(deps: ToolDeps) {
  const notionDeps = { notionToken: deps.notionToken, tareasDbId: deps.tareasDbId };
  const personasDeps = { notionToken: deps.notionToken, peopleDbId: deps.peopleDbId };

  return [
    tool(
      "listTasks",
      "Query Notion DB Tareas. Args: { status?: 'Backlog'|'Sin empezar'|'En curso'|'Focus'|'Waiting for'|'Cancelada'|'Listo', assigneePageId? (32 hex sin guiones — usar getPersonas para resolver nombre→pageId), fromDate? (YYYY-MM-DD), toDate? (YYYY-MM-DD), limit? }. fromDate/toDate filtran por Fecha O Deadline. Devuelve [{pageId, title, status, assigneePageIds, fecha?, deadline?, prioridad?, url}].",
      {
        status: z.string().optional(),
        assigneePageId: z.string().optional(),
        fromDate: z.string().optional(),
        toDate: z.string().optional(),
        limit: z.coerce.number().int().optional(),
      },
      async (args) => asText(await listTasks(notionDeps, args as ListTasksFilters)),
      READ_ONLY,
    ),
    tool(
      "createTask",
      "Crear tarea en Notion DB Tareas. Args: { title, status?, assigneePageId?, fechaIso? (YYYY-MM-DD), deadlineIso?, prioridad? ('P1'|'P2'|'P3'|'P4') }. Devuelve { pageId, url }.",
      {
        title: z.string(),
        status: z.string().optional(),
        assigneePageId: z.string().optional(),
        fechaIso: z.string().optional(),
        deadlineIso: z.string().optional(),
        prioridad: z.string().optional(),
      },
      async (args) => asText(await createTask(notionDeps, args)),
    ),
    tool(
      "setTaskStatus",
      "Cambiar status de tarea. Status válidos: 'Backlog', 'Sin empezar', 'En curso', 'Focus', 'Waiting for', 'Cancelada', 'Listo'. Para marcar como done usar 'Listo'.",
      { pageId: z.string(), status: z.string() },
      async ({ pageId, status }) => {
        await setTaskStatus(notionDeps, pageId, status);
        return asText({ ok: true });
      },
    ),
    tool(
      "setTaskFecha",
      "Cambiar la fecha (campo 'Fecha' — fecha en la que se trabaja la tarea). Args: { pageId, fechaIso (YYYY-MM-DD) }.",
      { pageId: z.string(), fechaIso: z.string() },
      async ({ pageId, fechaIso }) => {
        await setTaskFecha(notionDeps, pageId, fechaIso);
        return asText({ ok: true });
      },
    ),
    tool(
      "setTaskDeadline",
      "Cambiar el deadline (fecha límite real). Args: { pageId, deadlineIso (YYYY-MM-DD) }.",
      { pageId: z.string(), deadlineIso: z.string() },
      async ({ pageId, deadlineIso }) => {
        await setTaskDeadline(notionDeps, pageId, deadlineIso);
        return asText({ ok: true });
      },
    ),
    tool(
      "getPersonas",
      "Devuelve mapping de personas (pageId, pageIdUuid, name, rol?) de la DB People. Cacheado in-memory TTL 1h. Personas conocidas: Cal, Lorena Velasco (Comercial), Mauricio Rojas (Marketing/Growth), Matias Papini (Producto), Ivan Contreras (Tech Lead), Adrian Montaño, Yalile Uriarte (Data). Usar pageId (32 hex sin guiones) en filtros de listTasks.assigneePageId.",
      {},
      async () => asText(await getPersonas(personasDeps)),
      READ_ONLY,
    ),
    tool(
      "getOutlookEvents",
      "Lee cache pre-procesado de eventos de Outlook (calendario laboral). Args: { when?: 'today'|'tomorrow'|'both' (default today) }. Cache se refresca por cron com.claude.outlook-cache cada 4h. Devuelve [{when, startTime?, title, location?}].",
      { when: z.enum(["today", "tomorrow", "both"]).optional() },
      async ({ when }) => asText(await getOutlookEvents(when)),
      READ_ONLY,
    ),
    tool(
      "getHealthSummary",
      "Resumen Apple Health del día (sleep, steps, HR, calories, etc.). Args: { date? (YYYY-MM-DD, default hoy) }.",
      { date: z.string().optional() },
      async ({ date }) => asText(await getHealthSummary({ apiKey: deps.healthApiKey }, date)),
      READ_ONLY,
    ),
    tool(
      "getHealthTrend",
      "Tendencia de una métrica de Apple Health. Args: { metric (steps|sleep|hr|...), days (int) }.",
      { metric: z.string(), days: z.coerce.number().int() },
      async ({ metric, days }) => asText(await getHealthTrend({ apiKey: deps.healthApiKey }, metric, days)),
      READ_ONLY,
    ),
  ];
}
