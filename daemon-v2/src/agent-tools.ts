import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getOutlookEvents } from "./tools/outlook.js";
import { runBriefing } from "./tools/briefing.js";
import { manageLearning } from "./tools/learnings.js";
import { searchPlaces, travelTime as calcTravelTime } from "./tools/maps.js";
// getHealthSummary, getHealthTrend, getWorkouts migradas al MCP global `health`
// (mcp__health__getHealthSummary / getHealthTrend / getWorkouts).
// listTasks, createTask, setTaskStatus, setTaskFecha, setTaskDeadline, getPersonas
// removidas 2026-05-02 — pendientes en Apple Reminders (Personal / Vibe Projects), no Notion.

const READ_ONLY = { annotations: { readOnlyHint: true } };

function asText(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

export interface ToolDeps {
  botToken: string;
  getCurrentChatId: () => number;
  gmapsApiKey?: string;
  homePin?: string;
}

export function buildSdkTools(deps: ToolDeps) {
  const briefingDeps = { botToken: deps.botToken };

  return [
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
    tool(
      "searchPlace",
      "Busca un lugar en Google Places (texto libre). Devuelve hasta 5 candidatos con id, name, address, location lat/lng y googleMapsUri. Útil para resolver coords de un destino antes de calcular tiempo de viaje.",
      { query: z.string() },
      async ({ query }) => {
        if (!deps.gmapsApiKey) return asText({ error: "Google Maps API key no configurado" });
        return asText(await searchPlaces(query, { apiKey: deps.gmapsApiKey, homePin: deps.homePin }));
      },
      READ_ONLY,
    ),
    tool(
      "travelTime",
      "Calcula tiempo de viaje en tráfico real desde origen hasta destino (Google Routes API, modo DRIVE traffic-aware). Args: { destLatLng: 'lat,lng', originLatLng?: 'lat,lng' (default HOME_PIN de Cal) }. Devuelve { durationMin, distanceKm }.",
      {
        destLatLng: z.string(),
        originLatLng: z.string().optional(),
      },
      async ({ destLatLng, originLatLng }) => {
        if (!deps.gmapsApiKey) return asText({ error: "Google Maps API key no configurado" });
        return asText(
          await calcTravelTime(destLatLng, { apiKey: deps.gmapsApiKey, homePin: deps.homePin }, originLatLng),
        );
      },
      READ_ONLY,
    ),
    // addLearning migrada al MCP global agent-learnings (evita warm pool stale).
    // Disponible como mcp__agent-learnings__addLearning({ agent: "jano", text }).
    tool(
      "requestUserLocation",
      "Solicita al usuario que comparta su ubicación GPS vía un botón nativo de Telegram (ReplyKeyboard con request_location). Llamar cuando Cal pida combustible, distancias, o cualquier cosa que requiera coordenadas y NO ha enviado ubicación en la conversación.",
      {},
      async () => {
        const chatId = deps.getCurrentChatId();
        const token = deps.botToken;
        if (!chatId || !token) return asText({ error: "No chatId/token disponible" });
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: "📍 Para calcular distancias necesito tu ubicación. Toca el botón:",
              reply_markup: {
                keyboard: [[{ text: "📍 Compartir ubicación", request_location: true }]],
                one_time_keyboard: true,
                resize_keyboard: true,
              },
            }),
          });
          const data = (await res.json()) as { ok: boolean; description?: string };
          if (!data.ok) return asText({ error: data.description ?? "API error" });
          return asText({ ok: true });
        } catch (err) {
          return asText({ error: String(err) });
        }
      },
    ),
    tool(
      "manageLearnEntry",
      "Gestiona un learning del CoS: keep (marcar válido), drop (marcar inválido), promote (válido + promover tier), keepall (batch), dropall (batch). Para keep/drop/promote: id = ID del learning (ej: err-2026-04-28-002). Para keepall/dropall: id = batch_id del archivo ~/.claude/state/learn-batches/<batch_id>. Llamar cuando llegue un [callback] learn:keep|drop|promote|keepall|dropall:<id>.",
      {
        action: z.enum(["keep", "drop", "promote", "keepall", "dropall"]),
        id: z.string().describe("ID del learning o batch_id"),
      },
      async ({ action, id }) => asText(await manageLearning(action, id)),
    ),
  ];
}
