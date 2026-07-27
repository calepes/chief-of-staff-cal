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

// El SDK a veces aborta un turno internamente (contexto creciendo sin control dentro
// de la sesión warm) y devuelve su propio texto de diagnóstico marcado como "success".
// Sin este filtro ese texto se reenvía a Telegram tal cual, como si fuera la respuesta del agente.
const SDK_DIAGNOSTIC_PATTERNS = [/autocompact is thrashing/i, /context refilled to the limit/i];

const TOOL_MESSAGES: Record<string, string> = {
  "ToolSearch":                                         "🔎 Buscando la herramienta correcta...",
  // Custom cos-tools
  "mcp__cos-tools__getOutlookEvents":    "📋 Leyendo calendario Outlook...",
  "mcp__cos-tools__searchPlace":         "🗺️ Buscando lugar...",
  "mcp__cos-tools__travelTime":          "🚗 Calculando tiempo de viaje...",
  "mcp__cos-tools__manageLearnEntry":    "🧠 Procesando aprendizaje...",
  "mcp__cos-tools__getTokenUsage":       "📊 Consultando consumo de tokens...",
  "mcp__cos-tools__notionCli":           "🗂️ Consultando Notion (ntn)...",
  "mcp__cos-tools__notionPageMarkdown":  "🗂️ Leyendo página de Notion...",
  "mcp__cos-tools__notionUpdateBody":    "🗂️ Actualizando página de Notion...",
  "mcp__cos-tools__executeClings":       "🗂️ Leyendo tareas de Things...",
  "mcp__cos-tools__thingsWrite":         "✅ Guardando en Things...",
  "mcp__cos-tools__getWhatsappContacts": "📱 Leyendo contactos de WhatsApp...",
  "mcp__cos-tools__saveWhatsappContact": "💾 Guardando contacto de WhatsApp...",
  "mcp__cos-tools__readPersistedOutput":  "📂 Leyendo resultado completo...",
  "mcp__cos-tools__fetchAsUser":         "🔐 Accediendo con sesión de Safari...",
  "mcp__cos-tools__fetchAndSummarize":   "🔄 Descargando y resumiendo en background...",
  "mcp__cos-tools__getFocoCalStatus":   "🎯 Revisando Foco CAL...",
  "mcp__cos-tools__consultarJournal":   "📓 Leyendo tu journal...",
  "mcp__cos-tools__logFocoProgress":    "✅ Loggeando avance en Foco CAL...",
  "mcp__cos-tools__showMeetingCards":          "📋 Enviando tarjetas de reuniones...",
  "mcp__cos-tools__reviewMeetings":            "🔍 Consultando reuniones en Notion...",
  "mcp__cos-tools__analyzeMeeting":            "🧠 Analizando reunión...",
  "mcp__cos-tools__analyzeTranscriptAgent":    "🤖 Lanzando subagente de transcript...",
  "mcp__cos-tools__pptWizardSave":       "📊 Guardando avance de la presentación...",
  "mcp__cos-tools__pptWizardLoad":       "📊 Cargando estado de la presentación...",
  "mcp__cos-tools__addDigestSource":     "📰 Agregando fuente al Digest...",
  "mcp__cos-tools__enviarArchivoNotion": "📤 Enviando archivo...",
  // MCPs externos
  "mcp__youtube-transcribe__transcribeYoutube":        "🎬 Transcribiendo video...",
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
  "mcp__naabol-flights__getFlight":                    "✈️ Consultando vuelo...",
  "mcp__naabol-flights__getAirportFlights":            "✈️ Consultando aeropuerto...",
  "mcp__health__getHealthSummary":                     "💪 Cargando datos de salud...",
  "mcp__health__getHealthTrend":                       "📈 Analizando tendencia de salud...",
  "mcp__health__getWorkouts":                          "🏋️ Leyendo entrenamientos...",
  "mcp__exchange-rate-bolivia__getBcbRate":             "💱 Consultando tipo de cambio...",
  "mcp__exchange-rate-bolivia__getBinanceP2PRate":      "💱 Consultando Binance P2P...",
  "mcp__boa-checkin__prepareBoaCheckin":                "🎫 Preparando tu check-in...",
  "mcp__boa-checkin__confirmBoaCheckin":                "🎫 Confirmando el check-in...",
  "mcp__boa-checkin__manageBoaSeat":                    "💺 Gestionando tu asiento...",
  "mcp__boa-checkin__getBoaBoardingPass":               "🎫 Buscando tu boarding pass...",
  "mcp__boa-checkin__setBoaFrequentFlyer":               "✈️ Guardando tu número de viajero frecuente...",
  "mcp__cine__getCartelera":                           "🎬 Consultando la cartelera...",
  "mcp__cine__iniciarCompraCine":                      "🎟️ Abriendo la compra en Cinemark...",
  "mcp__cine__elegirAsientosCine":                     "🪑 Reservando tus asientos...",
  "mcp__cine__confirmarCompraCine":                    "📲 Generando el QR de pago...",
  "mcp__cine__verificarPagoCine":                      "🔎 Verificando el pago...",
  "mcp__cine__cancelarCompraCine":                     "🚫 Cancelando la compra...",
  "mcp__cine__estadoCompraCine":                       "🎬 Revisando la compra en curso...",
  "mcp__worldcup__getFixtures":                        "📅 Buscando partidos...",
  "mcp__worldcup__getStandings":                       "📊 Revisando las tablas...",
  "mcp__worldcup__getMatchDetail":                     "⚽ Revisando el partido...",
  "mcp__worldcup__getLineups":                         "📋 Buscando alineaciones...",
  "mcp__worldcup__getMatchStats":                      "📈 Cargando estadísticas...",
  "mcp__worldcup__getLiveFixtures":                    "🔴 Buscando partidos en vivo...",
  "mcp__worldcup__getMatchEvents":                     "⏱️ Cargando el minuto a minuto...",
  "mcp__worldcup__getPlayerStats":                     "👤 Cargando rendimiento de jugadores...",
  "mcp__worldcup__getTopScorers":                      "⚽ Revisando goleadores...",
  "mcp__worldcup__getTopAssists":                      "🅰️ Revisando asistencias...",
  "mcp__worldcup__getInjuries":                        "🏥 Revisando lesionados...",
  "mcp__worldcup__getH2H":                             "🆚 Buscando el historial...",
  "mcp__worldcup__getOdds":                            "💰 Consultando cuotas...",
  "mcp__worldcup__getApiPrediction":                   "🔮 Cargando predicción API...",
  "mcp__worldcup__getSquad":                           "📋 Buscando la plantilla...",
  "mcp__worldcup__predictMatch":                       "⚽ Prediciendo el partido...",
  "mcp__worldcup__forecastTournament":                 "🏆 Simulando el Mundial...",
  "mcp__worldcup__syncResults":                        "🔄 Sincronizando resultados...",
  "mcp__worldcup__getFifaStatDictionary":               "📖 Buscando el stat en el diccionario FIFA...",
  "mcp__worldcup__getFifaMatchTimeline":                "⏱️ Cargando la cronología FIFA...",
  "mcp__worldcup__getFifaLineups":                      "📋 Buscando la alineación FIFA...",
  "mcp__worldcup__getFifaTeamHistory":                  "🆚 Revisando el historial FIFA...",
  "mcp__worldcup__getFifaStandings":                    "📊 Calculando la tabla del grupo...",
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
  // Libros (Notion BD)
  "mcp__cos-tools__searchBooks":                       "📚 Buscando libros...",
  "mcp__cos-tools__addBook":                           "📖 Creando libro en Notion...",
  "mcp__cos-tools__updateBook":                        "✏️ Actualizando libro...",
  "mcp__cos-tools__logReadingProgress":                "📊 Registrando progreso de lectura...",
  "mcp__cos-tools__setBookCover":                      "🖼️ Buscando cover del libro...",
  // Schedule CAL — Vacaciones
  "mcp__cos-tools__listVacaciones":     "🏖️ Consultando vacaciones...",
  "mcp__cos-tools__getVacacionDetail":  "📋 Leyendo detalle de vacaciones...",
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
  let terminalReason: string | undefined;
  let deferredToolUse: { id: string; name: string; input: unknown } | undefined;
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
      const result = message as {
        result?: string;
        terminal_reason?: string;
        deferred_tool_use?: { id: string; name: string; input: unknown };
      };
      finalText = result.result ?? "";
      terminalReason = result.terminal_reason;
      deferredToolUse = result.deferred_tool_use;
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

  // Desde que "ToolSearch" dejó de estar bloqueada (2026-07-14), el SDK puede cortar el turno
  // con subtype "success" pero terminal_reason "tool_deferred" — el modelo intentó usar una tool
  // que todavía no había buscado/cargado. `result` en ese caso no es una respuesta real; sin este
  // chequeo se le reenviaría a Cal tal cual (vacía o a medio armar) sin rastro en logs.
  if (terminalReason === "tool_deferred") {
    console.log(JSON.stringify({ ts: Date.now(), msg: "tool_deferred_unresolved", deferredToolUse, finalText }));
    finalText =
      "Necesitaba cargar una herramienta que no tenía lista y el turno se cortó ahí. ¿Puedes repetirme el pedido?";
  } else if (SDK_DIAGNOSTIC_PATTERNS.some((p) => p.test(finalText))) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "sdk_diagnostic_leak", finalText }));
    finalText =
      "Se me acumuló demasiado contexto procesando eso y tuve que cortar la respuesta. ¿Puedes repetirme la pregunta? Si vuelve a pasar en la misma conversación, probemos de nuevo en un rato.";
  }

  return {
    reply: finalText.trim(),
    sdkMs: Date.now() - sdkStart,
    firstEventMs,
  };
}

export async function runSubAgent(
  warm: WarmQuery,
  prompt: string,
): Promise<AgentResult> {
  const sdkStart = Date.now();
  const q = warm.query(prompt);
  let firstEventMs = 0;
  let finalText = "";

  for await (const message of q) {
    if (firstEventMs === 0) firstEventMs = Date.now() - sdkStart;

    if (message.type === "assistant") {
      const content =
        (message as { message?: { content?: Array<{ type?: string; name?: string }> } })
          .message?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_use" && block.name) {
          console.log(JSON.stringify({ ts: Date.now(), msg: "subagent_tool_use", name: block.name }));
        }
      }
    }

    if (message.type === "result" && message.subtype === "success") {
      finalText = (message as { result?: string }).result ?? "";
      break;
    }
  }

  return {
    reply: finalText.trim() || "[]",
    sdkMs: Date.now() - sdkStart,
    firstEventMs,
  };
}
