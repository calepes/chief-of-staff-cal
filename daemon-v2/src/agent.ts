import type { WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ConversationMessage } from "./state.js";

export interface AgentDeps {
  warm: WarmQuery;
  history: ConversationMessage[];
  contextHeader?: string;
  onProgress?: (text: string) => Promise<void>;
  /**
   * true cuando el WarmQuery se creó con `resume`. En ese caso el SDK ya tiene la
   * conversación completa cargada, así que reinyectar el historial de texto de KV la
   * duplicaría: el mismo intercambio aparecería dos veces (una como turnos reales de la
   * sesión y otra como bloque "Historial reciente"), gastando contexto y dándole al modelo
   * dos versiones del pasado — la real y una resumida por Haiku que puede contradecirla.
   */
  resumed?: boolean;
  /**
   * Se llama apenas el SDK emite el sessionId (evento `init`), no al final del turno. Importa
   * porque un turno que falla a mitad IGUAL dejó una sesión válida en disco: si solo se
   * persistiera con el return, una racha de errores dejaría el sessionId sin refrescar hasta
   * que venciera el TTL, tirando contexto que sí existía. Señalado por daemon-health-reviewer.
   */
  onSessionId?: (sessionId: string) => void;
}

export interface AgentResult {
  reply: string;
  sdkMs: number;
  firstEventMs: number;
  /**
   * sessionId que el SDK asignó a este turno. El caller lo persiste (`session-store.ts`)
   * para pasarlo como `resume` en el turno siguiente y así conservar el contexto REAL
   * — tool calls y sus resultados incluidos — en vez de reconstruirlo desde el historial
   * de texto en KV. Puede venir undefined si el turno murió antes del evento `init`.
   */
  sessionId?: string;
}

// El SDK a veces aborta un turno internamente (contexto creciendo sin control dentro
// de la sesión warm) y devuelve su propio texto de diagnóstico marcado como "success".
// Sin este filtro ese texto se reenvía a Telegram tal cual, como si fuera la respuesta del agente.
const SDK_DIAGNOSTIC_PATTERNS = [/autocompact is thrashing/i, /context refilled to the limit/i];

const TOOL_MESSAGES: Record<string, string> = {
  "ToolSearch":                                         "🔎 Buscando la herramienta correcta...",
  // Custom cos-tools
  "mcp__cos-tools__getOutlookEvents":    "📋 Leyendo calendario Outlook...",
  // El camino OCR son varias llamadas de visión: decenas de segundos con el
  // placeholder congelado si no se avisa.
  "mcp__cos-tools__leerPdfLocal":        "📄 Releyendo el PDF...",
  "mcp__cos-tools__searchPlace":         "🗺️ Buscando lugar...",
  "mcp__cos-tools__travelTime":          "🚗 Calculando tiempo de viaje...",
  "mcp__cos-tools__manageLearnEntry":    "🧠 Procesando aprendizaje...",
  "mcp__cos-tools__getTokenUsage":       "📊 Consultando consumo de tokens...",
  "mcp__cos-tools__notionCli":           "🗂️ Consultando Notion (ntn)...",
  "mcp__cos-tools__notionPageMarkdown":  "🗂️ Leyendo página de Notion...",
  "mcp__cos-tools__notionUpdateBody":    "🗂️ Actualizando página de Notion...",
  "mcp__cos-tools__executeTd":           "✅ Consultando Todoist...",
  "mcp__cos-tools__getWhatsappContacts": "📱 Leyendo contactos de WhatsApp...",
  "mcp__cos-tools__saveWhatsappContact": "💾 Guardando contacto de WhatsApp...",
  "mcp__cos-tools__readPersistedOutput":  "📂 Leyendo resultado completo...",
  "mcp__cos-tools__consultarJson":       "🔬 Filtrando los datos...",
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
  "mcp__inversiones-query__recordTransaction":          "📈 Registrando transacción...",
  "mcp__inversiones-query__kuberaCashFlow":             "📊 Registrando cash flow en Kubera...",
  "mcp__inversiones-query__kuberaUpdateShares":         "📊 Actualizando shares en Kubera...",
  "mcp__inversiones-query__kuberaFindCustodian":        "🔍 Buscando custodian en Kubera...",
  // Achoradazos (Fraternidad Peruana)
  "mcp__achoradazos__searchFraterno":                  "🔍 Buscando fraterno en Airtable...",
  "mcp__achoradazos__listPendingPayments":              "📊 Consultando pagos pendientes...",
  "mcp__achoradazos__listGrupoCobros":                  "💰 Consultando grupos de cobro...",
  "mcp__achoradazos__listEventos":                      "📅 Consultando juntes...",
  "mcp__achoradazos__listExpensesByEvento":             "💸 Consultando gastos del junte...",
  "mcp__achoradazos__registerDeposit":                 "💾 Registrando depósito en Airtable...",
  "mcp__achoradazos__registerExpense":                 "💸 Registrando gasto en Airtable...",
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
  "mcp__cos-tools__confirmCreateBookRelation":         "🔗 Creando y vinculando...",
  "mcp__cos-tools__getReadingHistory":                 "📈 Buscando historial de lectura...",
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

  // Con la sesión retomada, el SDK ya trae el historial real (incluidos los resultados de
  // tools); el bloque de texto de KV solo se usa como fallback cuando NO hubo resume.
  const prompt = [
    deps.contextHeader && deps.contextHeader,
    !deps.resumed && summaryMsg && `Contexto anterior:\n${summaryMsg.content}`,
    !deps.resumed && recentBlock && `Historial reciente:\n${recentBlock}`,
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
  let sessionId: string | undefined;
  const toolCalls: Array<{ name: string; ok?: boolean; err?: string }> = [];

  for await (const message of q) {
    if (firstEventMs === 0) firstEventMs = Date.now() - sdkStart;

    // El SDK emite el sessionId en su mensaje `init`, al principio del turno. Se captura acá
    // (y no al final) porque un turno que falla a mitad igual dejó una sesión válida en disco:
    // conservarla permite que el turno siguiente retome el contexto en vez de empezar de cero.
    if (message.type === "system" && (message as { subtype?: string }).subtype === "init") {
      sessionId = (message as { session_id?: string }).session_id;
      if (sessionId) {
        try {
          deps.onSessionId?.(sessionId);
        } catch {
          // Persistir el sessionId nunca debe tumbar el turno: si falla, el peor caso es que el
          // turno siguiente arranque sin resume y use el historial de KV.
        }
      }
    }

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

  // El SDK puede cortar un turno con subtype "success" pero un `terminal_reason` que indica que
  // `result` NO es una respuesta real — viene vacío o a medio armar. Sin este mapeo, ese texto se
  // le reenvía a Cal tal cual y sin rastro en logs (fue el bug de 2026-07-14 con "tool_deferred").
  //
  // El union `TerminalReason` se AMPLIÓ en el SDK 0.3.x (sdk.d.ts:6909). Chequear solo el string
  // viejo dejaba pasar a los hermanos nuevos — en particular `tool_deferred_unavailable`, señalado
  // por daemon-health-reviewer. Se mapean por nombre y hay un `default` para los que se agreguen
  // en el futuro: un mensaje genérico entendible es mejor que reenviar un `result` vacío.
  const TERMINAL_REASON_MESSAGES: Record<string, string> = {
    tool_deferred:
      "Necesitaba cargar una herramienta que no tenía lista y el turno se cortó ahí. ¿Puedes repetirme el pedido?",
    tool_deferred_unavailable:
      "Quise usar una herramienta que no está disponible ahora y el turno se cortó. ¿Puedes repetirme el pedido?",
    prompt_too_long:
      "Se me hizo demasiado largo el contexto de esta conversación. Manda <code>/reset</code> y volvemos a empezar.",
    max_turns:
      "Este pedido me llevó más pasos de los que tengo permitidos y tuve que cortar. ¿Lo probamos por partes?",
    budget_exhausted:
      "Me quedé sin presupuesto de tokens a mitad del pedido. ¿Lo intentamos otra vez, más acotado?",
    structured_output_retry_exhausted:
      "No logré armar la respuesta en el formato correcto después de varios intentos. ¿Puedes reformular?",
    turn_setup_failed:
      "No pude arrancar bien el turno. Intenta de nuevo en un momento.",
    model_error: "Hubo un error del modelo procesando eso. Intenta de nuevo, por favor.",
    api_error: "Hubo un error de la API procesando eso. Intenta de nuevo, por favor.",
  };

  // Solo se interviene si NO hay respuesta utilizable: algunos cortes (ej. `max_turns`) igual
  // dejan texto parcial que a Cal le sirve más que un mensaje de error genérico.
  const terminalIsFatal = terminalReason !== undefined
    && terminalReason !== "completed"
    && finalText.trim().length === 0;

  if (terminalIsFatal) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "turn_terminal_reason", terminalReason, deferredToolUse, finalText }));
    finalText = TERMINAL_REASON_MESSAGES[terminalReason!]
      ?? "El turno se cortó antes de que pudiera responderte. ¿Puedes repetirme el pedido?";
  } else if (terminalReason === "tool_deferred" || terminalReason === "tool_deferred_unavailable") {
    // Estos dos sí se pisan aunque haya texto: lo que queda es el preámbulo previo al tool call
    // que nunca corrió, así que como respuesta es engañoso — parece completo y no lo está.
    console.log(JSON.stringify({ ts: Date.now(), msg: "tool_deferred_unresolved", terminalReason, deferredToolUse, finalText }));
    finalText = TERMINAL_REASON_MESSAGES[terminalReason];
  } else if (SDK_DIAGNOSTIC_PATTERNS.some((p) => p.test(finalText))) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "sdk_diagnostic_leak", finalText }));
    finalText =
      "Se me acumuló demasiado contexto procesando eso y tuve que cortar la respuesta. ¿Puedes repetirme la pregunta? Si vuelve a pasar en la misma conversación, probemos de nuevo en un rato.";
  }

  return {
    reply: finalText.trim(),
    sdkMs: Date.now() - sdkStart,
    firstEventMs,
    sessionId,
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
