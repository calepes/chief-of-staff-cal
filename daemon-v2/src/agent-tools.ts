import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { getOutlookEvents } from "./tools/outlook.js";
import { runBriefing } from "./tools/briefing.js";
import { manageLearning } from "./tools/learnings.js";
import { searchPlaces, travelTime as calcTravelTime } from "./tools/maps.js";
import { buildApprovalFlowImpl, stepApprovalWizardImpl } from "./tools/approval-flow.js";
import { getWhatsappContacts, saveWhatsappContact, type WaContact } from "./tools/whatsapp.js";
import { pptWizardSaveImpl, pptWizardLoadImpl } from "./tools/ppt-wizard.js";
import type { CfKv } from "./cf-kv.js";
import {
  appendFocoProgress,
  readFocoProgress,
  peekCurrentSection,
  FOCO_PAGE_ID,
  FOCO_KPIS_VIEW_URL,
  FOCO_TAREAS_VIEW_URL,
  FOCO_SECTIONS,
  type FocoProgressEntry,
  type FocoSection,
} from "./tools/foco-cal.js";
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
  kv: CfKv;
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
      "getTokenUsage",
      "Devuelve el consumo real de tokens Claude Max (todos los clientes: CC + web + iOS). % semanal real vía API headers. Llamar cuando Cal pregunte cuánto ha consumido, cómo van los tokens, si va a llegar al límite, o cuál es el estado de la sesión.",
      {},
      async () => {
        const script = `${homedir()}/.claude/scripts/claude-usage.py`;
        const result = spawnSync("python3", [script, "json"], { encoding: "utf8", timeout: 20_000 });
        if (result.error || result.status !== 0) {
          return asText({ error: "No se pudo obtener el consumo de tokens", detail: result.stderr?.trim() });
        }

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(result.stdout);
        } catch {
          return asText({ error: "Respuesta inesperada del script", raw: result.stdout.slice(0, 200) });
        }

        const totalPct = data.total_pct as number;
        const hasLiveData = data.has_live_data as boolean;
        const localTokensW = data.local_tokens_w as number;
        const localBurnPerH = data.local_burn_per_h as number;
        const hRem = data.hours_remaining as number;
        const byDay = data.by_day as Record<string, number>;
        const live = data.live as Record<string, unknown> | undefined;

        const fmtN = (n: number): string => {
          if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
          if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
          return `${Math.round(n / 1e3)}K`;
        };

        const DOW = ["Do", "Lu", "Ma", "Mi", "Ju", "Vi", "Sa"];

        // Bolivia: UTC-4
        const todayLocal = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);

        const sortedDays = Object.keys(byDay).sort();
        const pastDays = sortedDays.filter((d) => d < todayLocal);

        // Semáforo relativo al promedio de días anteriores
        const avgPast =
          pastDays.length > 0
            ? pastDays.reduce((s, d) => s + byDay[d], 0) / pastDays.length
            : 0;
        const semaforo = (w: number): string => {
          if (avgPast === 0) return "⚪";
          const r = w / avgPast;
          if (r <= 1.0) return "🟢";
          if (r <= 1.5) return "🟡";
          if (r <= 2.0) return "🟠";
          return "🔴";
        };

        let tendencia = "—";
        if (pastDays.length >= 2) {
          const yesterW = byDay[pastDays[pastDays.length - 1]];
          const prevW = byDay[pastDays[pastDays.length - 2]];
          if (yesterW < prevW * 0.9) tendencia = "↓ bajando ✅";
          else if (yesterW > prevW * 1.1) tendencia = "↑ subiendo ⚠️";
          else tendencia = "→ estable";
        }

        const rows = sortedDays.slice(-5).map((d) => {
          const [y, m, day] = d.split("-").map(Number);
          const dow = DOW[new Date(y, m - 1, day).getDay()];
          const dd = d.slice(8);
          const w = byDay[d];
          const marker = d === todayLocal ? " <b>←hoy</b>" : "";
          return `${semaforo(w)} <code>${dow}${dd}  ${fmtN(w).padStart(5)}</code>${marker}`;
        });

        const dRem = Math.floor(hRem / 24);
        const hRemMod = Math.floor(hRem % 24);

        const sessionStatus = live?.["5h_status"] as string | undefined;
        const overageActive = live?.["overage_in_use"] as boolean | undefined;
        let statusLine = "";
        if (sessionStatus === "rejected") {
          const h5Rem = Math.ceil(5 - ((live?.["5h_util"] as number) ?? 0) * 5);
          statusLine = `🛑 Sesión pausada · ventana 5h agotada (reset en ~${Math.max(0, h5Rem)}h)`;
        } else if (overageActive) {
          statusLine = "⚡ Overage activo";
        }

        const liveWarning = hasLiveData ? "" : "\n<i>⚠️ Dato de ciclo: caché local (sin conexión a API)</i>";

        const msg = [
          `☀️ <b>Claude Max · ${todayLocal}</b>`,
          "",
          `Ciclo (todos los clientes): <b>${totalPct.toFixed(1)}%</b> · reset en ${dRem}d${hRemMod}h`,
          ...(statusLine ? [statusLine] : []),
          "",
          `📊 CC local — últimos días:`,
          ...rows,
          "",
          `Tendencia: ${tendencia}`,
          `Burn CC: ${fmtN(localBurnPerH)}/h · acumulado ${fmtN(localTokensW)}`,
          liveWarning,
        ]
          .filter((l) => l !== undefined)
          .join("\n");

        return { content: [{ type: "text" as const, text: msg }] };
      },
      READ_ONLY,
    ),
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
    tool(
      "buildApprovalFlow",
      "Crea un flujo de aprobación visual en Telegram cuando hay ≥2 items que Cal necesita revisar individualmente. Envía un summary card con la lista y botones 'Revisar uno a uno' + bulk actions. Guarda el estado del wizard en KV (TTL 30 min). Usar para: Feedbin triage, Reader inbox, reminders pendientes, learnings batch, cualquier lista con ≥2 decisiones individuales donde 'confirmar todos' NO es la respuesta obvia. NO usar para listas informativas ni cuando hay 1 solo item.",
      {
        title: z.string().describe("Título del wizard, ej: 'Feedbin triage', 'Reminders vencidos'"),
        items: z.array(z.object({
          id: z.string().describe("ID opaco que el LLM usa para llamar la acción correspondiente"),
          label: z.string().describe("Texto principal del item visible en el wizard"),
          meta: z.string().optional().describe("Info secundaria: fuente, fecha, categoría, etc."),
        })).describe("Lista de items a revisar"),
        confirmVerb: z.string().optional().describe("Texto del botón confirmar, default '✅ Confirmar'"),
        rejectVerb: z.string().optional().describe("Texto del botón descartar, default '🗑️ Descartar'"),
      },
      async (args) => asText(await buildApprovalFlowImpl(
        { kv: deps.kv, botToken: deps.botToken, getCurrentChatId: deps.getCurrentChatId },
        args,
      )),
    ),
    tool(
      "stepApprovalWizard",
      "Avanza el wizard de aprobación activo. Llamar siempre que llegue [callback] jano-wiz-*. La tool edita el mensaje de Telegram automáticamente y retorna el item actual (con su id) para que el LLM ejecute la acción correspondiente. Mapping de acciones: 'start' (jano-wiz-start), 'ok' (jano-wiz-ok → ejecutar acción: markRead/completeReminder/manageLearnEntry/etc. con item.id), 'no' (jano-wiz-no → no ejecutar acción, avanzar), 'skip' (jano-wiz-skip → saltar sin procesar), 'prev' (jano-wiz-prev), 'back' (jano-wiz-back → volver al resumen), 'bulk-ok' (jano-wiz-all-ok → retorna TODOS los items pendientes para acción bulk), 'bulk-no' (jano-wiz-all-no). Si done=true: responder con confirmación breve. Si item retorna con action 'ok': llamar la tool de acción correspondiente con item.id antes de responder.",
      {
        action: z.enum(["start", "ok", "no", "skip", "prev", "back", "bulk-ok", "bulk-no"]),
      },
      async ({ action }) => asText(await stepApprovalWizardImpl(
        { kv: deps.kv, botToken: deps.botToken, getCurrentChatId: deps.getCurrentChatId },
        { action },
      )),
    ),
    tool(
      "getWhatsappContacts",
      "Lista todos los contactos guardados en ~/.claude/whatsapp-contacts.md. Devuelve array de { nombre, alias?, relacion?, numero } donde numero es el número internacional sin '+' (ej: '59172345678'). Llamar cuando Cal quiera preparar un WhatsApp o buscar un contacto.",
      {},
      async () => asText(await getWhatsappContacts()),
      READ_ONLY,
    ),
    tool(
      "pptWizardSave",
      "Guarda o actualiza el estado del wizard PPT en curso para el chat activo (KV, TTL 2h). Llamar después de cada intercambio del wizard para persistir el progreso: topic (título tentativo), audience (quiénes son + tiempo disponible), step (1=SCQA, 2=Storyline, 3=Tipos de slide, 4=Contenido, 5=Listo), scqa ({ s, c, q, a }), storyline (array de assertions ordenadas), slides (array de slides con assertion, type, mensaje, cuerpo, pendiente). Solo pasar los campos que cambien en este turno — el resto se preserva.",
      {
        topic:     z.string().optional().describe("Título tentativo del deck"),
        audience:  z.string().optional().describe("Audiencia: quiénes son, qué les importa, tiempo disponible"),
        step:      z.number().int().min(1).max(5).optional().describe("Paso actual del wizard: 1=SCQA 2=Storyline 3=Tipos 4=Contenido 5=Done"),
        scqa:      z.object({
          s: z.string().optional(),
          c: z.string().optional(),
          q: z.string().optional(),
          a: z.string().optional(),
        }).optional().describe("Marco SCQA parcial o completo"),
        storyline: z.array(z.string()).optional().describe("Assertions ordenadas que soportan el Answer"),
        slides:    z.array(z.object({
          n:         z.number().int(),
          assertion: z.string(),
          type:      z.enum(["Chart", "Table", "Subtitle", "Framework", "Visual"]),
          mensaje:   z.string().optional(),
          cuerpo:    z.string().optional(),
          pendiente: z.string().optional(),
        })).optional().describe("Slides del deck con assertion-headline y tipo"),
      },
      async (args) => {
        const chatId = deps.getCurrentChatId();
        const state = await pptWizardSaveImpl(deps.kv, chatId, args);
        return asText(state);
      },
    ),
    tool(
      "pptWizardLoad",
      "Lee el estado actual del wizard PPT para el chat activo. Devuelve el objeto PptWizardState (topic, audience, step, scqa, storyline, slides) o null si no hay wizard activo. Llamar al inicio de un turno cuando Cal retoma una PPT o cuando necesitas saber en qué paso estás.",
      {},
      async () => {
        const chatId = deps.getCurrentChatId();
        return asText(await pptWizardLoadImpl(deps.kv, chatId));
      },
      READ_ONLY,
    ),
    tool(
      "saveWhatsappContact",
      "Agrega un contacto nuevo a ~/.claude/whatsapp-contacts.md. Args: { nombre, alias?, relacion?, numero } donde numero es el número internacional sin '+' (ej: '59172345678'). Llamar después de confirmar los datos con Cal.",
      {
        nombre: z.string().describe("Nombre completo"),
        alias: z.string().optional().describe("Alias o apodo — default: primera palabra del nombre"),
        relacion: z.string().optional().describe("Relación con Cal — ej: Agente de viajes, Pareja"),
        numero: z.string().describe("Número internacional sin '+' ni espacios — ej: 59172345678"),
      },
      async (args) => { await saveWhatsappContact(args as WaContact); return asText(`Contacto ${(args as WaContact).nombre} guardado.`); },
    ),
    tool(
      "getFocoCalStatus",
      "Lee el estado del Foco CAL de Cal: progreso local reciente por sección + punteros a los datos en vivo de Notion. " +
      "Llamar cuando Cal pregunte sobre el Foco, su progreso, en qué enfocarse, qué lleva sin mover, " +
      "cómo van los KPIs de Yape Bolivia (DAU, afiliaciones, TRX), o sus tareas de Notion de la semana. " +
      "Después de este tool, usar notion-fetch(focoPageId) para estado de checkboxes, " +
      "notion-query-database-view(kpisViewUrl) para KPIs, notion-query-database-view(tareaViewUrl) para tareas.",
      {},
      async () => {
        const progress = readFocoProgress(30);
        const section = await peekCurrentSection(deps.kv);
        return asText({
          recentProgress: progress,
          currentSection: section,
          focoPageId: FOCO_PAGE_ID,
          kpisViewUrl: FOCO_KPIS_VIEW_URL,
          tareaViewUrl: FOCO_TAREAS_VIEW_URL,
        });
      },
      READ_ONLY,
    ),
    tool(
      "logFocoProgress",
      "Loggea el avance de Cal en un item del Foco CAL. " +
      "Llamar cuando Cal confirme 'hecho' en un check-in del Foco (via jano-wiz-ok → stepApprovalWizard → logFocoProgress), " +
      "o cuando Cal mencione explícitamente haber completado o avanzado algo del Foco CAL. " +
      "Retorna string de confirmación.",
      {
        itemText: z.string().describe("Texto del item tal como aparece en el Foco CAL"),
        section: z
          .enum(FOCO_SECTIONS)
          .describe("Sección del Foco CAL"),
        note: z.string().optional().describe("Nota opcional de Cal sobre el avance"),
      },
      async ({ itemText, section, note }) => {
        const now = new Date();
        const entry: FocoProgressEntry = {
          date: now.toISOString().slice(0, 10),
          ts: Math.floor(now.getTime() / 1000),
          section: section as FocoSection,
          itemText,
          note: note ?? null,
        };
        appendFocoProgress(entry);
        return asText(`Progreso loggeado: ${itemText}`);
      },
    ),
  ];
}
