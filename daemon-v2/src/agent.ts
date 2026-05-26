import type { WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ConversationMessage } from "./state.js";

export interface AgentDeps {
  warm: WarmQuery;
  history: ConversationMessage[];
  contextHeader?: string;
  onProgress?: (text: string) => Promise<void>;
}

export interface AgentResult {
  reply: string;
  sdkMs: number;
  firstEventMs: number;
}

const TOOL_MESSAGES: Record<string, string> = {
  // Custom cos-tools
  "mcp__cos-tools__getOutlookEvents":    "📋 Leyendo calendario Outlook...",
  "mcp__cos-tools__runBriefing":         "📰 Generando briefing...",
  "mcp__cos-tools__searchPlace":         "🗺️ Buscando lugar...",
  "mcp__cos-tools__travelTime":          "🚗 Calculando tiempo de viaje...",
  "mcp__cos-tools__manageLearnEntry":    "🧠 Procesando aprendizaje...",
  "mcp__cos-tools__getTokenUsage":       "📊 Consultando consumo de tokens...",
  "mcp__cos-tools__getWhatsappContacts": "📱 Leyendo contactos de WhatsApp...",
  "mcp__cos-tools__saveWhatsappContact": "💾 Guardando contacto de WhatsApp...",
  "mcp__cos-tools__readPersistedOutput":  "📂 Leyendo resultado completo...",
  "mcp__cos-tools__fetchAsUser":         "🔐 Accediendo con sesión de Safari...",
  "mcp__cos-tools__fetchAndSummarize":   "🔄 Descargando y resumiendo en background...",
  "mcp__cos-tools__getFocoCalStatus":   "🎯 Revisando Foco CAL...",
  "mcp__cos-tools__logFocoProgress":    "✅ Loggeando avance en Foco CAL...",
  "mcp__cos-tools__showMeetingCards":   "📋 Enviando tarjetas de reuniones...",
  "mcp__cos-tools__reviewMeetings":     "🔍 Consultando reuniones en Notion...",
  "mcp__cos-tools__analyzeMeeting":     "🧠 Analizando reunión...",
  "mcp__cos-tools__pptWizardSave":       "📊 Guardando avance de la presentación...",
  "mcp__cos-tools__pptWizardLoad":       "📊 Cargando estado de la presentación...",
  "mcp__cos-tools__addDigestSource":     "📰 Agregando fuente al Digest...",
  // MCPs externos
  "mcp__youtube-transcribe__transcribeYoutube":        "🎬 Transcribiendo video...",
  "mcp__apple-reminders__addReminder":                 "🔔 Agregando recordatorio...",
  "mcp__apple-reminders__editReminder":                "🔔 Editando recordatorio...",
  "mcp__apple-reminders__completeReminder":            "✅ Completando recordatorio...",
  "mcp__apple-reminders__deleteReminder":              "🗑️ Eliminando recordatorio...",
  "mcp__apple-reminders__listReminderLists":            "🔔 Leyendo listas...",
  "mcp__apple-reminders__listReminders":               "🔔 Leyendo recordatorios...",
  "mcp__apple-notes__create-note":                     "📝 Creando nota...",
  "mcp__apple-notes__search-notes":                    "🔍 Buscando notas...",
  "mcp__apple-notes__get-note-content":                "📝 Leyendo nota...",
  "mcp__apple-notes__get-note-markdown":               "📝 Leyendo nota...",
  "mcp__apple-notes__get-note-by-id":                  "📝 Cargando nota...",
  "mcp__apple-notes__get-note-details":                "📝 Cargando detalles...",
  "mcp__apple-notes__update-note":                     "✏️ Actualizando nota...",
  "mcp__apple-notes__delete-note":                     "🗑️ Eliminando nota...",
  "mcp__apple-notes__move-note":                       "📁 Moviendo nota...",
  "mcp__apple-notes__list-notes":                      "📝 Listando notas...",
  "mcp__apple-notes__list-folders":                    "📁 Leyendo carpetas...",
  "mcp__combustible__getFuelStatus":                   "⛽ Revisando combustible...",
  "mcp__naabol-flights__getFlights":                   "✈️ Consultando vuelos...",
  "mcp__naabol-flights__getFlight":                    "✈️ Consultando vuelo...",
  "mcp__naabol-flights__getAirportFlights":            "✈️ Consultando aeropuerto...",
  "mcp__health__getHealthSummary":                     "💪 Cargando datos de salud...",
  "mcp__health__getHealthTrend":                       "📈 Analizando tendencia de salud...",
  "mcp__health__getWorkouts":                          "🏋️ Leyendo entrenamientos...",
  "mcp__exchange-rate-bolivia__getBcbRate":             "💱 Consultando tipo de cambio...",
  "mcp__exchange-rate-bolivia__getBinanceP2PRate":      "💱 Consultando Binance P2P...",
  "mcp__serpapi-flights__searchFlights":               "✈️ Buscando vuelos...",
  "mcp__serpapi-flights__getReturnFlights":            "✈️ Buscando vuelos de regreso...",
  "mcp__feedbin__getUnreadEntries":                    "📰 Leyendo artículos...",
  "mcp__feedbin__getEntryContent":                     "📰 Leyendo artículo...",
  "mcp__feedbin__searchEntries":                       "🔍 Buscando en Feedbin...",
  // Claude.ai MCPs
  "mcp__claude_ai_Google_Calendar__list_events":       "📅 Leyendo Google Calendar...",
  "mcp__claude_ai_Google_Calendar__create_event":      "📅 Creando evento...",
  "mcp__claude_ai_Google_Calendar__update_event":      "📅 Actualizando evento...",
  "mcp__claude_ai_Google_Calendar__delete_event":      "📅 Eliminando evento...",
  "mcp__claude_ai_Gmail__search_threads":              "📧 Revisando Gmail...",
  "mcp__claude_ai_Gmail__get_thread":                  "📧 Leyendo correo...",
  "mcp__claude_ai_Notion__notion-query-database-view": "📊 Consultando Notion...",
  "mcp__claude_ai_Notion__notion-search":              "🔍 Buscando en Notion...",
  "mcp__claude_ai_Notion__notion-fetch":               "📄 Leyendo página Notion...",
  "mcp__claude_ai_Notion__notion-create-pages":        "📝 Creando página Notion...",
  "mcp__claude_ai_Notion__notion-update-page":         "✏️ Actualizando Notion...",
  "mcp__inversiones-query__recordTransaction":          "📈 Registrando transacción...",
  "mcp__inversiones-query__kuberaCashFlow":             "📊 Registrando cash flow en Kubera...",
  "mcp__inversiones-query__kuberaUpdateShares":         "📊 Actualizando shares en Kubera...",
  "mcp__inversiones-query__kuberaFindCustodian":        "🔍 Buscando custodian en Kubera...",
  // Achoradazos (Fraternidad Peruana)
  "mcp__achoradazos__searchFraterno":                  "🔍 Buscando fraterno en Airtable...",
  "mcp__achoradazos__listPendingPayments":              "📊 Consultando pagos pendientes...",
  "mcp__achoradazos__registerDeposit":                 "💾 Registrando depósito en Airtable...",
  "mcp__achoradazos__uploadReceipt":                   "📤 Subiendo comprobante...",
  "mcp__achoradazos__getActiveConcepto":               "📋 Verificando concepto de cobro activo...",
  "mcp__achoradazos__getActiveEvento":                 "📅 Verificando evento activo...",
  "mcp__achoradazos__createEvento":                    "📅 Creando evento...",
  "mcp__achoradazos__createConceptoCobro":             "💰 Creando concepto de cobro...",
  "mcp__achoradazos__getPendingPaymentMessage":        "💬 Generando mensaje de cobros...",
  // Notion tasks
  "mcp__cos-tools__getNotionTasks":                    "📋 Leyendo tareas en Notion...",
  "mcp__cos-tools__createNotionTask":                  "📋 Creando tarea en Notion...",
  "mcp__cos-tools__updateNotionTask":                  "✏️ Actualizando tarea en Notion...",
  // Notifications
  "mcp__notifications__sendNotification":              "🔔 Enviando notificación...",
};

export async function runAgent(userMessage: string, deps: AgentDeps): Promise<AgentResult> {
  const summaryMsg = deps.history.find((m) => m.role === "summary");
  const recentMsgs = deps.history.filter((m) => m.role !== "summary");

  const recentBlock = recentMsgs.length
    ? recentMsgs.map((m) => `${m.role === "user" ? "Cal" : "CoS"}: ${m.content}`).join("\n")
    : "";

  const prompt = [
    deps.contextHeader && deps.contextHeader,
    summaryMsg && `Contexto anterior:\n${summaryMsg.content}`,
    recentBlock && `Historial reciente:\n${recentBlock}`,
    `Mensaje: ${userMessage}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const sdkStart = Date.now();
  const q = deps.warm.query(prompt);
  let firstEventMs = 0;
  let finalText = "";
  const toolCalls: Array<{ name: string; ok?: boolean; err?: string }> = [];

  for await (const message of q) {
    if (firstEventMs === 0) firstEventMs = Date.now() - sdkStart;

    if (message.type === "assistant") {
      const content =
        (message as { message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> } })
          .message?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_use" && block.name) {
          toolCalls.push({ name: block.name });
          console.log(JSON.stringify({ ts: Date.now(), msg: "tool_use", name: block.name, input: block.input }));
          const progressMsg = TOOL_MESSAGES[block.name];
          if (progressMsg && deps.onProgress) {
            await deps.onProgress(progressMsg).catch(() => {});
          }
        }
      }
    } else if (message.type === "user") {
      const content =
        (message as {
          message?: { content?: Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }> };
        }).message?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_result") {
          const last = toolCalls[toolCalls.length - 1];
          if (last) {
            last.ok = !block.is_error;
            if (block.is_error) last.err = JSON.stringify(block.content).slice(0, 200);
          }
          console.log(
            JSON.stringify({
              ts: Date.now(),
              msg: "tool_result",
              is_error: block.is_error,
              content_preview: JSON.stringify(block.content).slice(0, 300),
            }),
          );
        }
      }
    }

    if (message.type === "result" && message.subtype === "success") {
      finalText = (message as { result?: string }).result ?? "";
      const modelUsage = (
        message as {
          modelUsage?: Record<
            string,
            {
              inputTokens?: number;
              outputTokens?: number;
              cacheReadInputTokens?: number;
              cacheCreationInputTokens?: number;
              costUSD?: number;
            }
          >;
        }
      ).modelUsage;
      if (modelUsage) {
        console.log(JSON.stringify({ ts: Date.now(), msg: "usage", modelUsage }));
      }
      break;
    }
  }

  console.log(JSON.stringify({ ts: Date.now(), msg: "turn_summary", toolCalls }));

  return {
    reply: finalText.trim() || "(sin respuesta)",
    sdkMs: Date.now() - sdkStart,
    firstEventMs,
  };
}
