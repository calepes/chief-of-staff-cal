import { tool, startup } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
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
import { fetchAsUser } from "./tools/fetch-as-user.js";
import { readPersistedOutput } from "./tools/read-persisted.js";
import { fetchAndSummarize } from "./tools/fetch-and-summarize.js";
import { addDigestSource, type DigestSection } from "./tools/digest.js";
import {
  searchBooks,
  addBook,
  updateBook,
  logReadingProgress,
  setBookCover,
  type EstadoLibro,
  type AddBookParams,
  type UpdateBookParams,
  type LogProgressParams,
  type SetCoverParams,
} from "./tools/books.js";
import { runSubAgent } from "./agent.js";
import {
  formatFechaEs,
  queryMeetingsByDate,
  parseFocoCalTopics,
  escapeHtml,
  tgSend,
  tgEdit,
  type MeetingNote,
  type FocoTopic,
} from "./tools/meeting-notes.js";
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
  getOptions: () => Options;
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
      "readPersistedOutput",
      "Lee el contenido completo de un archivo persisted-output del SDK (tool result demasiado grande para el contexto). " +
      "Usar EXCLUSIVAMENTE cuando un tool result anterior devuelva un bloque <persisted-output> con un path a ~/.claude/projects/*/tool-results/toolu_*.json. " +
      "Extrae el path del mensaje y pásalo aquí para obtener el contenido completo.",
      { path: z.string().describe("Ruta absoluta al archivo .json del persisted-output") },
      async ({ path }) => asText(readPersistedOutput(path)),
      READ_ONLY,
    ),
    tool(
      "fetchAsUser",
      "Hace fetch de una URL usando las cookies de Safari de Cal, permitiendo acceder a contenido paywalled (NYT, FT, The Economist, Substack, El País, etc.) donde Cal tiene suscripción activa. " +
      "Devuelve el texto extraído del HTML (scripts/estilos removidos, máx 50K chars). " +
      "Si no puede leer las cookies (TCC), indica el paso exacto para otorgar permiso. " +
      "Usar cuando Cal comparte un link de un artículo que requiere login o suscripción.",
      { url: z.string().url().describe("URL completa del artículo o página a leer") },
      async ({ url }) => asText(await fetchAsUser(url)),
      READ_ONLY,
    ),
    tool(
      "fetchAndSummarize",
      "Descarga una URL usando las cookies de Safari de Cal y genera un resumen/análisis en background " +
      "(proceso separado — no afecta el contexto de Jano). " +
      "Usar cuando Cal comparte un link con instrucción de resumir, analizar, extraer puntos clave, etc. " +
      "Envía progress updates y el resultado final como mensajes nuevos en Telegram. " +
      "NO usar fetchAsUser directamente para artículos largos — usar esta tool.",
      {
        url: z.string().url().describe("URL del artículo a procesar"),
        instruction: z.string().describe(
          "Instrucción específica: 'resume los puntos principales', 'extrae las citas más importantes', " +
          "'dame un resumen ejecutivo de 300 palabras', etc."
        ),
      },
      async ({ url, instruction }) => {
        const result = await fetchAndSummarize(
          { botToken: deps.botToken },
          deps.getCurrentChatId(),
          { url, instruction },
        );
        return asText(result);
      },
      READ_ONLY,
    ),
    tool(
      "addDigestSource",
      "Agrega una fuente RSS nueva al Digest Diario (rss-sources.js). Edita el archivo directamente y la pone en la sección correcta ordenada por weight. Llamar cuando Cal quiera agregar un feed de noticias al digest. Args: feedUrl (URL del RSS), feedName (nombre display), section (bolivia|peru|colombia|fintech), weight? (0.5-1.0, default 0.8). Después de confirmar con Cal, recordarle que haga wrangler deploy.",
      {
        feedUrl:  z.string().url().describe("URL completa del feed RSS"),
        feedName: z.string().describe("Nombre display de la fuente, ej: 'Los Tiempos'"),
        section:  z.enum(["bolivia", "peru", "colombia", "fintech"]).describe("Sección del digest"),
        weight:   z.number().min(0.5).max(1.0).optional().describe("Peso editorial 0.5-1.0 (default 0.8). Usar 1.0 para fuentes premium, 0.7-0.8 para secundarias"),
      },
      async ({ feedUrl, feedName, section, weight }) => {
        const result = addDigestSource({ feedUrl, feedName, section: section as DigestSection, weight });
        return asText(result);
      },
    ),
    tool(
      "showMeetingCards",
      "Envía una tarjeta Telegram (Nivel 1) por cada reunión. " +
      "Si meetings se omite o está vacío, lee la lista del KV guardada por reviewMeetings (usar para msel:all). " +
      "Si meetings se pasa explícito, usa esos datos directamente (usar para foco-check pm). " +
      "Cada tarjeta muestra título + fecha y botones para loguear, analizar o saltar. " +
      "También almacena los datos de cada reunión en CF KV para uso posterior por analyzeMeeting. " +
      "Máximo 5 reuniones por llamada.",
      {
        meetings: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            fecha: z.string().describe("YYYY-MM-DD"),
            hasFocoCal: z.boolean(),
            resumenFocoCal: z.string().nullable().optional(),
            resumen: z.string().nullable().optional(),
          }),
        ).max(5).optional().describe(
          "Omitir cuando viene de msel:all — la tool lee del KV. " +
          "Pasar solo cuando el prompt incluye los datos directamente (foco-check pm).",
        ),
      },
      async ({ meetings }) => {
        const chatId = deps.getCurrentChatId();

        const toShow: MeetingNote[] =
          meetings && meetings.length > 0
            ? (meetings as MeetingNote[]).slice(0, 5)
            : ((await deps.kv.get<MeetingNote[]>(`meeting-list:${chatId}`)) ?? []).slice(0, 5);

        if (toShow.length === 0) {
          return asText({ error: "No hay meetings en caché. Llama reviewMeetings primero." });
        }

        let sent = 0;

        for (const m of toShow) {
          // Guardar datos en KV para analyzeMeeting
          await deps.kv.set(
            `meeting:${chatId}:${m.id}`,
            m as MeetingNote,
            4 * 3600,
          );

          const hasFoco = m.hasFocoCal ?? false;
          const flag = hasFoco ? " 🎯" : "";
          const dateStr = formatFechaEs(m.fecha);
          const text = `📋 <b>${escapeHtml(m.title)}</b> · ${dateStr}${flag}`;

          const keyboard = hasFoco
            ? {
                inline_keyboard: [[
                  { text: "✅ Loguear", callback_data: `mlog:${m.id}:focoCal` },
                  { text: "⏭ Saltar", callback_data: `mskip:${m.id}` },
                  { text: "🔍 Transcript", callback_data: `mlog:${m.id}:transcript` },
                ]],
              }
            : {
                inline_keyboard: [[
                  { text: "📄 Analizar", callback_data: `mlog:${m.id}:resumen` },
                  { text: "🎙 Transcript", callback_data: `mlog:${m.id}:transcript` },
                  { text: "⏭ Saltar", callback_data: `mskip:${m.id}` },
                ]],
              };

          try {
            await tgSend(deps.botToken, chatId, text, keyboard);
            sent++;
          } catch (err) {
            console.error(`showMeetingCards: tgSend failed for ${m.id}:`, err);
          }
        }

        return asText({ ok: true, sent });
      },
    ),
    tool(
      "reviewMeetings",
      "Consulta las reuniones de un rango de fechas en la DB de Meetings de Notion y envía un " +
      "mensaje de selección (Fase 1) al chat de Cal. " +
      "Cal selecciona qué reuniones procesar con botones numerados o [Todas]. " +
      "Args: { from, to } en formato YYYY-MM-DD — el LLM parsea lenguaje natural antes de llamar. " +
      "Llamar cuando Cal pida 'revisa mis meetings de X a Y' o 'reuniones de esta semana'.",
      {
        from: z.string().describe("Fecha inicio YYYY-MM-DD"),
        to: z.string().describe("Fecha fin YYYY-MM-DD"),
      },
      async ({ from, to }) => {
        const notionToken = process.env.NOTION_TOKEN;
        if (!notionToken) return asText({ error: "NOTION_TOKEN no configurado" });

        const meetings = await queryMeetingsByDate({ from, to, notionToken });

        if (meetings.length === 0) {
          return asText({ ok: true, message: "No hay reuniones en ese rango.", count: 0 });
        }

        const chatId = deps.getCurrentChatId();

        // Guardar lista completa en KV para cuando llegue callback msel:*
        await deps.kv.set(`meeting-list:${chatId}`, meetings, 4 * 3600);

        // Guardar datos individuales también (mismo TTL que showMeetingCards para consistencia)
        for (const m of meetings) {
          await deps.kv.set(`meeting:${chatId}:${m.id}`, m, 4 * 3600);
        }

        // Construir mensaje de selección
        const lines = meetings.map((m, i) => {
          const flag = m.hasFocoCal ? " 🎯" : "";
          const dateStr = formatFechaEs(m.fecha);
          return `${i + 1}. <b>${escapeHtml(m.title)}</b> · <i>${dateStr}</i>${flag}`;
        });

        const text = [
          `<b>📋 Meetings ${formatFechaEs(from)}–${formatFechaEs(to)}</b> (${meetings.length})`,
          "",
          lines.join("\n"),
          "",
          "<i>🎯 = tiene análisis de Foco CAL</i>",
          "",
          "¿Cuáles cruzamos contra tu Foco?",
        ].join("\n");

        // Botones numerados (máx 5 por fila) + Todas
        type TgButton = { text: string; callback_data: string };
        const numButtons: TgButton[] = meetings.map((m, i) => ({
          text: `${i + 1}`,
          callback_data: `msel:${m.id}`,
        }));
        const rows: TgButton[][] = [];
        for (let i = 0; i < numButtons.length; i += 5) {
          rows.push(numButtons.slice(i, i + 5));
        }
        rows.push([{ text: "✅ Todas", callback_data: "msel:all" }]);

        await tgSend(deps.botToken, chatId, text, { inline_keyboard: rows });

        return asText({ ok: true, count: meetings.length });
      },
    ),
    tool(
      "analyzeMeeting",
      "Procesa una reunión para extraer temas del Foco CAL y presentarlos para validación (Nivel 2). " +
      "Llamar cuando llegue callback mlog:{meetingId}:{mode}. " +
      "mode='focoCal': usa el campo Resumen Foco CAL pre-computado (rápido). " +
      "mode='resumen': devuelve el Resumen para que el LLM analice. " +
      "mode='transcript': devuelve instrucciones para que el LLM use notion-fetch. " +
      "Después de llamar este tool con mode='focoCal', usar buildApprovalFlow con los topics " +
      "retornados y confirmVerb='✅ Sí', rejectVerb='⏭ No'. " +
      "Mapping de callbacks jano-wiz-ok: stepApprovalWizard({ action: 'ok' }) → logFocoProgress({ itemText: topic.text, section: topic.section }).",
      {
        meetingId: z.string().describe("Notion page ID de la reunión"),
        mode: z
          .enum(["focoCal", "resumen", "transcript"])
          .describe("Fuente de análisis"),
      },
      async ({ meetingId, mode }) => {
        const chatId = deps.getCurrentChatId();
        const meeting = await deps.kv.get<MeetingNote>(
          `meeting:${chatId}:${meetingId}`,
        );

        if (!meeting) {
          return asText({
            error:
              "Reunión no encontrada en caché. Intenta con reviewMeetings o showMeetingCards primero.",
          });
        }

        if (mode === "focoCal") {
          if (!meeting.resumenFocoCal) {
            return asText({
              error:
                "Esta reunión no tiene Resumen Foco CAL. Usa mode='resumen' o mode='transcript'.",
            });
          }
          const topics: FocoTopic[] = parseFocoCalTopics(meeting.resumenFocoCal);
          return asText({
            ok: true,
            meetingTitle: meeting.title,
            topics,
            instruction:
              `Llama buildApprovalFlow con: ` +
              `title="${meeting.title} — ¿qué logueamos?", ` +
              `items=topics.map((t, i) => ({ id: \`t\${i}\`, label: t.text, meta: t.section })), ` +
              `confirmVerb="✅ Sí", rejectVerb="⏭ No". ` +
              `Cuando llegue jano-wiz-ok, llama stepApprovalWizard({ action: "ok" }) ` +
              `y luego logFocoProgress({ itemText: item.label, section: item.meta }).`,
          });
        }

        if (mode === "resumen") {
          if (!meeting.resumen) {
            return asText({
              error:
                "Esta reunión no tiene Resumen. Usa mode='transcript'.",
            });
          }
          return asText({
            ok: true,
            meetingTitle: meeting.title,
            contentForAnalysis: meeting.resumen,
            instruction:
              `Analiza el contenido de la reunión "${meeting.title}" y extrae qué temas ` +
              `del Foco CAL de Cal se avanzaron (Foco CAL tiene secciones: CAL personal, ` +
              `Prioridades, Rufino, Christian, KPIs, Tareas). ` +
              `Luego llama buildApprovalFlow con los temas encontrados para que Cal valide. ` +
              `confirmVerb="✅ Sí", rejectVerb="⏭ No". ` +
              `Cuando llegue jano-wiz-ok: stepApprovalWizard({ action: "ok" }) → logFocoProgress.`,
          });
        }

        // mode === "transcript"
        return asText({
          ok: true,
          meetingTitle: meeting.title,
          meetingPageId: meetingId,
          instruction:
            `Llama analyzeTranscriptAgent({ meetingId: "${meetingId}", meetingTitle: "${meeting.title.replace(/"/g, "'")}" }). ` +
            `El subagente lee el transcript en un contexto aislado, envía mensajes de estado a Telegram, ` +
            `y retorna los topics directamente. ` +
            `NO uses mcp__claude_ai_Notion__notion-fetch directamente — el transcript llenaría este contexto.`,
        });
      },
    ),
    tool(
      "analyzeTranscriptAgent",
      "Analiza una reunión para extraer temas del Foco CAL. Auto-selecciona el modo más rápido: " +
      "(1) si tiene Resumen Foco CAL → parse local inmediato, " +
      "(2) si tiene Resumen → devuelve texto para análisis inline del LLM, " +
      "(3) si ninguno → subagente aislado lee el transcript en Notion. " +
      "El título se busca en KV (no lo pase el LLM). Incluye dedup para evitar doble análisis. " +
      "Retorna { ok, topics, instruction } para llamar buildApprovalFlow.",
      {
        meetingId: z.string().describe("Notion page ID de la reunión"),
      },
      async ({ meetingId }) => {
        const chatId = deps.getCurrentChatId();
        const botToken = deps.botToken;

        // Title siempre desde KV — nunca confiar en el LLM para esto
        const meeting = await deps.kv.get<MeetingNote>(`meeting:${chatId}:${meetingId}`);
        const meetingTitle = meeting?.title ?? meetingId;

        const mkInstruction = (topics: FocoTopic[]) => {
          if (topics.length === 0) return `Sin temas del Foco CAL. Informa brevemente a Cal.`;
          const safeTitle = meetingTitle.replace(/"/g, "'");
          return (
            `Llama buildApprovalFlow con: title="${safeTitle} — ¿qué logueamos?", ` +
            `items=topics.map((t, i) => ({ id: \`t\${i}\`, label: t.text, meta: t.section })), ` +
            `confirmVerb="✅ Sí", rejectVerb="⏭ No". ` +
            `Cuando llegue jano-wiz-ok: stepApprovalWizard({ action: "ok" }) → logFocoProgress({ itemText: item.label, section: item.meta }).`
          );
        };

        // Fast path 1: tiene resumenFocoCal → parse local, sin API
        if (meeting?.resumenFocoCal) {
          const topics = parseFocoCalTopics(meeting.resumenFocoCal);
          if (topics.length > 0) {
            return asText({ ok: true, meetingTitle, topics, instruction: mkInstruction(topics) });
          }
        }

        // Fast path 2: tiene resumen → devuelve para análisis inline del LLM
        if (meeting?.resumen) {
          return asText({
            ok: true,
            meetingTitle,
            mode: "resumen",
            contentForAnalysis: meeting.resumen,
            instruction:
              `Analiza el resumen de "${escapeHtml(meetingTitle)}" y extrae temas del Foco CAL ` +
              `(secciones: CAL, Prioridades, Rufino, Christian, KPIs, Tareas). ` +
              `Llama buildApprovalFlow con los temas. confirmVerb="✅ Sí", rejectVerb="⏭ No". ` +
              `Cuando llegue jano-wiz-ok: stepApprovalWizard → logFocoProgress.`,
          });
        }

        // Dedup: evita que el subagente se lance dos veces para el mismo meeting
        const dedupKey = `transcript_analyzed:${chatId}:${meetingId}`;
        const alreadyDone = await deps.kv.get<boolean>(dedupKey);
        if (alreadyDone) {
          return asText({
            ok: false,
            error: `Transcript de "${meetingTitle}" ya fue analizado en este ciclo. Usa el resultado anterior.`,
          });
        }
        await deps.kv.set(dedupKey, true, 4 * 3600);

        // Slow path: subagente aislado con notion-fetch.
        // Un solo mensaje de estado que se edita en cada fase (no pila de mensajes nuevos).
        const statusMsgId = await tgSend(botToken, chatId,
          `🔍 Leyendo transcript de <b>${escapeHtml(meetingTitle)}</b>...`,
        ).catch(() => 0);

        let subResult = "[]";
        try {
          const subOptions: Options = {
            ...deps.getOptions(),
            allowedTools: ["mcp__claude_ai_Notion__notion-fetch"],
            maxTurns: 6,
            systemPrompt: [
              "You are Cal's Foco CAL analyzer. Cal leads Yape Bolivia (mobile payment app).",
              "Fetch the Notion meeting page, read the transcript/notes, and extract ACTIONABLE items.",
              "",
              "Cal's Foco CAL has 6 sections — map every item to exactly one:",
              "• CAL — Cal's own strategic objectives, personal leadership decisions, things only Cal can decide",
              "• Prioridades — What must be prioritized this week/sprint: key trade-offs, scope decisions, focus shifts",
              "• Rufino — Topics involving Rufino Arribas (BCP Bolivia stakeholder): commitments, asks, follow-ups",
              "• Christian — Topics involving Christian Hausher (BCP Bolivia): decisions, dependencies, action items",
              "• KPIs — Yape Bolivia metrics: DAU, TRX (transactions), Afiliaciones (new users). Include specific numbers or targets when mentioned.",
              "• Tareas — Concrete tasks: who does what by when. Must be specific and actionable.",
              "",
              "EXTRACTION RULES:",
              "1. Only extract ACTIONABLE items — something to DO, DECIDE, or FOLLOW UP on",
              "2. Skip pure FYI/status items unless they trigger a required action",
              "3. Be specific: 'Definir roadmap Q3 con Gonzo' NOT 'discuss strategy'",
              "4. Section mapping priority: if it mentions Rufino → Rufino; if it mentions Christian → Christian; if KPI number → KPIs; if concrete task → Tareas; if strategic decision → CAL or Prioridades",
              "5. Max 8 items. Prefer quality over quantity.",
              "",
              'Return ONLY a valid JSON array, no other text: [{"text": "item in Spanish", "section": "SectionName"}, ...]',
              "If no actionable items found, return: []",
            ].join("\n"),
          };

          const subWarm = await startup({ options: subOptions });

          if (statusMsgId) {
            await tgEdit(botToken, chatId, statusMsgId, "🧠 Analizando temas del Foco CAL...").catch(() => {});
          }

          const subPrompt =
            `Fetch the Notion page with id="${meetingId}". ` +
            `Read the full content — focus on transcript, notas, acuerdos, and follow-up sections. ` +
            `Extract actionable Foco CAL items following the system prompt rules. ` +
            `Return ONLY the JSON array.`;

          const { reply } = await runSubAgent(subWarm, subPrompt);
          subResult = reply;
        } catch (err) {
          console.error("analyzeTranscriptAgent: sub-agent error:", err);
          if (statusMsgId) {
            await tgEdit(botToken, chatId, statusMsgId, `⚠️ Error leyendo transcript de <b>${escapeHtml(meetingTitle)}</b>.`).catch(() => {});
          }
          return asText({ ok: false, error: String(err).slice(0, 200), topics: [] });
        }

        const VALID_SECTIONS = new Set(["CAL", "Prioridades", "Rufino", "Christian", "KPIs", "Tareas"]);
        let topics: FocoTopic[] = [];
        try {
          const jsonMatch = subResult.match(/\[[\s\S]*?\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]) as Array<{ text?: unknown; section?: unknown }>;
            topics = parsed
              .filter((t) => typeof t.text === "string" && (t.text as string).length > 5)
              .map((t) => ({
                text: (t.text as string).trim(),
                section: (VALID_SECTIONS.has(String(t.section)) ? String(t.section) : "CAL") as FocoSection,
              }))
              .slice(0, 8);
          }
        } catch {
          // Keep empty on parse error
        }

        const finalStatusText = topics.length === 0
          ? `⚠️ <b>${escapeHtml(meetingTitle)}</b> — sin temas accionables del Foco CAL`
          : `✅ <b>${escapeHtml(meetingTitle)}</b> — ${topics.length} tema${topics.length === 1 ? "" : "s"}`;

        if (statusMsgId) {
          await tgEdit(botToken, chatId, statusMsgId, finalStatusText).catch(() => {});
        } else {
          await tgSend(botToken, chatId, finalStatusText).catch(() => {});
        }

        return asText({ ok: true, meetingTitle, topics, instruction: mkInstruction(topics) });
      },
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
    tool(
      "searchBooks",
      "Busca libros en la BD de Notion de Cal. Filtra por nombre y/o estado. Devuelve lista con título, estado, % avance y link.",
      {
        query:  z.string().optional().describe("Texto a buscar en el título del libro"),
        estado: z.enum(["Goal","Reading","Read","Focus","Stand-By","Reference","wish list"]).optional(),
      },
      async ({ query, estado }) =>
        asText(await searchBooks(query, estado as EstadoLibro | undefined)),
      READ_ONLY,
    ),
    tool(
      "addBook",
      "Agrega un libro nuevo a la BD de Notion. Busca y setea el cover automáticamente si hay ISBN o título. Setea cover e icono con la misma imagen.",
      {
        name:           z.string().describe("Título del libro"),
        subtitle:       z.string().optional(),
        isbn:           z.string().optional(),
        estado:         z.enum(["Goal","Reading","Read","Focus","Stand-By","Reference","wish list"]),
        planningToRead: z.enum(["2021","2022","2023","2024","2025","2026"]).optional(),
        totalPaginas:   z.number().int().positive().optional(),
        startDate:      z.string().optional().describe("ISO date YYYY-MM-DD"),
        finishDate:     z.string().optional().describe("ISO date YYYY-MM-DD"),
        url:            z.string().optional().describe("URL del libro (Apple Books, Amazon, etc.)"),
        fetchCover:     z.boolean().optional().describe("Buscar y setear cover automáticamente. Default true."),
      },
      async (params) => asText(await addBook(params as AddBookParams)),
    ),
    tool(
      "updateBook",
      "Actualiza propiedades de un libro existente en la BD de Notion. Solo actualiza los campos provistos.",
      {
        pageId:         z.string().describe("ID de la página Notion del libro"),
        estado:         z.enum(["Goal","Reading","Read","Focus","Stand-By","Reference","wish list"]).optional(),
        rating:         z.enum(["🥱","😶","😊","😍"]).optional(),
        startDate:      z.string().optional().describe("ISO date YYYY-MM-DD"),
        finishDate:     z.string().optional().describe("ISO date YYYY-MM-DD"),
        totalPaginas:   z.number().int().positive().optional(),
        isbn:           z.string().optional(),
        subtitle:       z.string().optional(),
        url:            z.string().optional(),
        planningToRead: z.enum(["2021","2022","2023","2024","2025","2026"]).optional(),
      },
      async (params) => asText(await updateBook(params as UpdateBookParams)),
    ),
    tool(
      "logReadingProgress",
      "Registra una sesión de lectura en el tracking de libros. Los porcentajes son decimales: 0.10 = 10%, 0.25 = 25%.",
      {
        pageId:            z.string().describe("ID de la página Notion del libro"),
        porcentajeInicial: z.number().min(0).max(1).describe("% al inicio de la sesión (0.0–1.0)"),
        porcentajeFinal:   z.number().min(0).max(1).describe("% al final de la sesión (0.0–1.0)"),
        fecha:             z.string().optional().describe("ISO date YYYY-MM-DD. Default: hoy."),
      },
      async (params) => asText(await logReadingProgress(params as LogProgressParams)),
    ),
    tool(
      "setBookCover",
      "Busca el cover del libro en internet (Open Library por ISBN, Google Books como fallback) y lo aplica como banner e ícono de la página en Notion.",
      {
        pageId: z.string().describe("ID de la página Notion del libro"),
        isbn:   z.string().optional(),
        title:  z.string().optional().describe("Título del libro para búsqueda si no hay ISBN"),
        author: z.string().optional().describe("Autor para refinar la búsqueda"),
      },
      async (params) => asText(await setBookCover(params as SetCoverParams)),
    ),
  ];
}
