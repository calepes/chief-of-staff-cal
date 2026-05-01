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
import { runBriefing } from "./tools/briefing.js";
// getHealthSummary, getHealthTrend, getWorkouts migradas al MCP global `health`
// (mcp__health__getHealthSummary / getHealthTrend / getWorkouts).

const READ_ONLY = { annotations: { readOnlyHint: true } };

function asText(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

export interface ToolDeps {
  notionToken: string;
  tareasDbId: string;
  peopleDbId: string;
  botToken: string;
  getCurrentChatId: () => number;
}

export function buildSdkTools(deps: ToolDeps) {
  const notionDeps = { notionToken: deps.notionToken, tareasDbId: deps.tareasDbId };
  const personasDeps = { notionToken: deps.notionToken, peopleDbId: deps.peopleDbId };
  const briefingDeps = { botToken: deps.botToken };

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
      "runBriefing",
      "Dispara on-demand la generación del briefing ejecutivo de un país (Bolivia, Peru, Colombia). Async: arranca un subprocess en background y retorna inmediatamente. El subprocess genera el HTML, lo pushea a GitHub Pages y manda al chat de Cal un mensaje nuevo con los top 3 titulares y el link cuando termina (suele tardar minutos). Si falla por timeout o error, el daemon manda un aviso. NO uses este tool si Cal solo quiere consultar un briefing existente — para eso usar WebFetch al URL del briefing publicado. Args: { pais: 'Bolivia'|'Peru'|'Colombia', fecha?: 'YYYY-MM-DD' (default: hoy en la zona horaria del país) }.",
      {
        pais: z.enum(["Bolivia", "Peru", "Colombia"]),
        fecha: z.string().optional(),
      },
      async (args) => asText(await runBriefing(briefingDeps, deps.getCurrentChatId(), args)),
    ),
    // addLearning migrada al MCP global agent-learnings (evita warm pool stale).
    // Disponible como mcp__agent-learnings__addLearning({ agent: "jano", text }).
  ];
}
