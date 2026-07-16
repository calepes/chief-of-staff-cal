// Tools de Claude Code CLI built-in que CoS no debe usar — bloqueamos para
// que el LLM se enfoque en tools custom + MCPs heredados de claude.ai.
export const DISALLOWED_BUILTINS: string[] = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  // WebFetch and WebSearch are NOT blocked — CoS uses them to resolve URLs,
  // briefings de país, búsquedas de noticias.
  "Task",
  "Agent",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskOutput",
  "TaskStop",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  // "ToolSearch" intentionally NOT blocked (desde 2026-07-14, experimento): estaba bloqueada
  // desde el día 1 del daemon (28 abr) junto a otros builtins de orquestación de CLI, sin
  // relación con tool-bloat — en ese momento Jano tenía 9 tools, no 164. Es el mecanismo nativo
  // del SDK para diferir la carga de schemas de tools (mismo patrón que recomienda Anthropic en
  // "code execution / tool search" para evitar el piso fijo de tokens por tool call). Hipótesis:
  // bloquearla fuerza a cargar los 164 tools completos en CADA llamada interna del turno, dejando
  // poco margen antes de "autocompact is thrashing" (visto 4 veces: Readwise 23-may, FIFA x2
  // 6-jul, BoA 13-jul — ver Jano/CLAUDE.md). Agregada también a CLAUDE_AI_COS_TOOLS abajo.
  // Interactiva de Claude Code CLI: en un daemon headless no hay quién responda,
  // falla siempre con "Answer questions?" y hace perder ~1min por turno mientras
  // el modelo reintenta con otra tool (visto en flujo de tags del resumidor y en
  // confirmación de fechas de calendario, 2026-07-12).
  "AskUserQuestion",
  // "Skill" intentionally NOT blocked — CoS needs it to invoke global skills
  // (vuelos-bolivia, telegram-bot-ux, briefing-pais).
  "ScheduleWakeup",
  "Monitor",
  "PushNotification",
  "RemoteTrigger",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterWorktree",
  "ExitWorktree",
  "ExitPlanMode",
  // MCPs personales fuera del dominio CoS (Yape work)
  "mcp__claude_ai_Airtable__create_records_for_table",
  "mcp__claude_ai_Airtable__update_records_for_table",
  "mcp__claude_ai_Airtable__delete_records_for_table",
  "mcp__claude_ai_Airtable__create_table",
  "mcp__claude_ai_Airtable__update_table",
  "mcp__claude_ai_Airtable__create_field",
  "mcp__claude_ai_Airtable__update_field",
  // Gmail writes — CoS no manda emails
  "mcp__claude_ai_Gmail__create_draft",
  "mcp__claude_ai_Gmail__create_label",
  "mcp__claude_ai_Gmail__label_message",
  "mcp__claude_ai_Gmail__label_thread",
  "mcp__claude_ai_Gmail__unlabel_message",
  "mcp__claude_ai_Gmail__unlabel_thread",
  // Drive writes — CoS no crea archivos en Drive
  "mcp__claude_ai_Google_Drive__create_file",
  // 3rd party YouTube transcript MCP heredado de OAuth Max — usamos el custom
  // mcp__youtube-transcribe en su lugar (caption fast-path + whisper fallback).
  // El viejo solo lee captions y rompe con videos sin captions.
  "mcp__youtube-transcript__get_transcripts",
  // Notion tools que el LLM intenta usar pero no están en allowlist y confunden el loop
  // de msel:all (LLM ve "permissions not granted" y reintenta reviewMeetings en loop)
  "mcp__claude_ai_Notion__notion-query-meeting-notes",
  // Playwright — bloqueado: Jano no necesita control de navegador. Fue visto
  // intentando leer file:// paths de persisted-output (2026-05-23) — no es el patrón correcto.
  "mcp__plugin_playwright_playwright__browser_navigate",
  "mcp__plugin_playwright_playwright__browser_snapshot",
  "mcp__plugin_playwright_playwright__browser_click",
  "mcp__plugin_playwright_playwright__browser_fill_form",
  "mcp__plugin_playwright_playwright__browser_type",
  "mcp__plugin_playwright_playwright__browser_evaluate",
  "mcp__plugin_playwright_playwright__browser_take_screenshot",
];

// MCPs heredados que SÍ usa CoS. allowedTools es allowlist estricto.
export const CLAUDE_AI_COS_TOOLS: string[] = [
  // Skills globales (vuelos-bolivia, telegram-bot-ux, briefing-pais)
  "Skill",
  // Deferred tool loading (experimento 2026-07-14, ver comentario en DISALLOWED_BUILTINS)
  "ToolSearch",
  // Resumidor universal — link (artículo/paywall, YouTube, podcast/audio) o título de libro.
  // Reutiliza los scripts del skill `resumir` vía spawn (sin Bash). Lee cookies de Safari
  // con ~/.claude/bin/node-fda (requiere Full Disk Access en ese binario).
  "mcp__cos-tools__resumirContenido",
  "mcp__cos-tools__guardarResumenReadwise",
  "mcp__cos-tools__editarPropuestaResumen",
  "mcp__cos-tools__saltarResumen",
  "mcp__cos-tools__detenerResumidor",
  "mcp__cos-tools__revisarPlaylistResumir",
  "mcp__cos-tools__revisarStarredResumir",
  "mcp__cos-tools__estadoResumidor",
  // Web — briefings país, links de Notion/GCal, búsquedas
  "WebFetch",
  "WebSearch",
  // Gmail (solo lecturas) — preparar reuniones, ver invitaciones
  "mcp__claude_ai_Gmail__search_threads",
  "mcp__claude_ai_Gmail__get_thread",
  "mcp__claude_ai_Gmail__list_drafts",
  "mcp__claude_ai_Gmail__list_labels",
  // Google Calendar — calendario laboral
  "mcp__claude_ai_Google_Calendar__list_calendars",
  "mcp__claude_ai_Google_Calendar__list_events",
  "mcp__claude_ai_Google_Calendar__get_event",
  "mcp__claude_ai_Google_Calendar__create_event",
  "mcp__claude_ai_Google_Calendar__update_event",
  "mcp__claude_ai_Google_Calendar__delete_event",
  "mcp__claude_ai_Google_Calendar__suggest_time",
  "mcp__claude_ai_Google_Calendar__respond_to_event",
  // Notion — vía ntn CLI (migrado desde MCP heredado 2026-06-13).
  // DB Tareas, People, Memoria, búsquedas, KPIs/Foco, bodies de página.
  "mcp__cos-tools__notionCli",
  "mcp__cos-tools__notionPageMarkdown",
  "mcp__cos-tools__notionUpdateBody",
  // YouTube — transcripción de audio via whisper local (no depende de captions)
  "mcp__youtube-transcribe__transcribeYoutube",
  // Tipo de cambio Bolivia — oficial (BCB) y paralelo (Binance P2P USDT/BOB)
  "mcp__exchange-rate-bolivia__getBcbRate",
  "mcp__exchange-rate-bolivia__getBinanceP2PRate",
  // Vuelos NAABOL (Bolivia) — útil para viajes laborales Yape (LPB-VVI, VVI-LIM, etc.)
  "mcp__naabol-flights__getFlight",
  "mcp__naabol-flights__getAirportFlights",
  // Check-in online BoA (Boliviana de Aviación) — automatizado vía Chrome real + CDP
  "mcp__boa-checkin__prepareBoaCheckin",
  "mcp__boa-checkin__confirmBoaCheckin",
  "mcp__boa-checkin__manageBoaSeat",
  "mcp__boa-checkin__getBoaBoardingPass",
  "mcp__boa-checkin__setBoaFrequentFlyer",
  "mcp__boa-checkin__generateBoaWalletPass",
  // Feedbin — RSS reader (CF Worker): no leídos por feed/carpeta, contenido, marcar leídos, buscar
  "mcp__feedbin__getUnreadCount",
  "mcp__feedbin__getUnreadEntries",
  "mcp__feedbin__getUnreadByFeed",
  "mcp__feedbin__getTaggings",
  "mcp__feedbin__getEntryContent",
  "mcp__feedbin__markRead",
  "mcp__feedbin__markUnread",
  "mcp__feedbin__getSubscriptions",
  "mcp__feedbin__searchEntries",
  "mcp__feedbin__deleteSubscription",
  "mcp__feedbin__savePage",
  "mcp__feedbin__addSubscription",
  "mcp__feedbin__getEntriesByFeed",
  "mcp__feedbin__getEntriesByTag",
  "mcp__feedbin__markFeedRead",
  "mcp__feedbin__markTagRead",
  "mcp__feedbin__getReadEntriesByFeed",
  "mcp__feedbin__getReadEntriesByTag",
  "mcp__feedbin__getStarredEntries",
  "mcp__feedbin__starEntries",
  "mcp__feedbin__unstarEntries",
  "mcp__feedbin__createTagging",
  "mcp__feedbin__deleteTagging",
  "mcp__feedbin__renameTag",
  "mcp__feedbin__deleteTag",
  // Apple Health — métricas diarias, tendencias, workouts (migrado de custom tools a MCP)
  "mcp__health__getHealthSummary",
  "mcp__health__getHealthTrend",
  "mcp__health__getWorkouts",
  "mcp__health__getHealthSyncStatus",
  // Learning system — MCP externo (evita warm pool stale del in-process cos-tools)
  "mcp__agent-learnings__addLearning",
  // Combustible Santa Cruz — disponibilidad y distancia a estaciones de gasolina
  "mcp__combustible__getFuelStatus",
  "mcp__combustible__getFuelMonitorConfig",
  "mcp__combustible__getFuelMonitorStatus",
  "mcp__combustible__setFuelMonitorConfig",
  // Mundial 2026 — datos en vivo (API-Football) + predicciones (predictor Python)
  "mcp__worldcup__getFixtures",
  "mcp__worldcup__getStandings",
  "mcp__worldcup__getMatchDetail",
  "mcp__worldcup__getLineups",
  "mcp__worldcup__getMatchStats",
  "mcp__worldcup__getLiveFixtures",
  "mcp__worldcup__getMatchEvents",
  "mcp__worldcup__getPlayerStats",
  "mcp__worldcup__getTopScorers",
  "mcp__worldcup__getTopAssists",
  "mcp__worldcup__getInjuries",
  "mcp__worldcup__getH2H",
  "mcp__worldcup__getOdds",
  "mcp__worldcup__getApiPrediction",
  "mcp__worldcup__getSquad",
  "mcp__worldcup__predictMatch",
  "mcp__worldcup__forecastTournament",
  "mcp__worldcup__syncResults",
  "mcp__worldcup__getFifaStatDictionary",
  "mcp__worldcup__getFifaMatchStats",
  "mcp__worldcup__getFifaPlayerStats",
  "mcp__worldcup__getFifaPowerRanking",
  "mcp__worldcup__getFifaMatchTimeline",
  "mcp__worldcup__getFifaLineups",
  "mcp__worldcup__getFifaTeamHistory",
  "mcp__worldcup__getFifaStandings",
  "mcp__worldcup__getMatchReport",
  "mcp__worldcup__getMatchPreview",
  "mcp__worldcup__getWorldcupCapabilities",
  // Google Flights via SerpAPI — vuelos internacionales (no Bolivia NAABOL)
  "mcp__serpapi-flights__searchFlights",
  "mcp__serpapi-flights__getReturnFlights",
  // Apple Notes — notas personales de Cal
  "mcp__apple-notes__create-note",
  "mcp__apple-notes__search-notes",
  "mcp__apple-notes__get-note-content",
  "mcp__apple-notes__get-note-by-id",
  "mcp__apple-notes__get-note-details",
  "mcp__apple-notes__update-note",
  "mcp__apple-notes__delete-note",
  "mcp__apple-notes__move-note",
  "mcp__apple-notes__list-notes",
  "mcp__apple-notes__list-folders",
  "mcp__apple-notes__list-accounts",
  "mcp__apple-notes__get-note-markdown",
  "mcp__apple-notes__get-checklist-state",
  // Digest Diario — agregar fuentes RSS
  "mcp__cos-tools__addDigestSource",
  // Google Maps — búsqueda de lugares y tiempo de viaje en tráfico real
  "mcp__cos-tools__searchPlace",
  "mcp__cos-tools__travelTime",
  // Consumo de tokens Claude Max — ciclo activo, burn rate, presupuesto
  "mcp__cos-tools__getTokenUsage",
  // Foco CAL — check-ins proactivos y revisión on-demand
  "mcp__cos-tools__getFocoCalStatus",
  "mcp__cos-tools__logFocoProgress",
  // Meetings → Foco Log — tarjetas por meeting, revisión on-demand, análisis
  "mcp__cos-tools__showMeetingCards",
  "mcp__cos-tools__reviewMeetings",
  "mcp__cos-tools__analyzeMeeting",
  "mcp__cos-tools__analyzeTranscriptAgent",
  // Spark — email, calendar, contacts y teams via Spark Desktop
  "mcp__spark__listAccounts",
  "mcp__spark__listFolders",
  "mcp__spark__listEmails",
  "mcp__spark__searchEmails",
  "mcp__spark__readThread",
  "mcp__spark__listEvents",
  "mcp__spark__findAvailability",
  "mcp__spark__searchContacts",
  "mcp__spark__listTeams",
  "mcp__spark__listMeetings",
  "mcp__spark__readMeeting",
  "mcp__spark__createDraft",
  "mcp__spark__postComment",
  "mcp__spark__emailAction",
  "mcp__spark__contactAction",
  // Fraternidad Peruana (Achoradazos) — gestión de fraternos, eventos, pagos
  "mcp__achoradazos__searchFraterno",
  "mcp__achoradazos__listPendingPayments",
  "mcp__achoradazos__registerDeposit",
  "mcp__achoradazos__uploadReceipt",
  "mcp__achoradazos__createEvento",
  "mcp__achoradazos__createConceptoCobro",
  "mcp__achoradazos__getActiveEvento",
  "mcp__achoradazos__getActiveConcepto",
  "mcp__achoradazos__getPendingPaymentMessage",
  // inversiones-query — portfolio de inversiones de Cal (Kubera + Yahoo Finance + Airtable)
  "mcp__inversiones-query__getPortfolioSummary",
  "mcp__inversiones-query__getDailyMovers",
  "mcp__inversiones-query__getPositionDetail",
  "mcp__inversiones-query__getPortfolioPerformance",
  "mcp__inversiones-query__getPriceHistory",
  "mcp__inversiones-query__getTransactionHistory",
  "mcp__inversiones-query__getPortfolioConcentration",
  "mcp__inversiones-query__searchPosition",
  "mcp__inversiones-query__recordTransaction",
  "mcp__inversiones-query__kuberaCashFlow",
  "mcp__inversiones-query__kuberaUpdateShares",
  "mcp__inversiones-query__kuberaFindCustodian",
  // Libros (Notion BD) — gestión de la biblioteca personal de Cal
  "mcp__cos-tools__searchBooks",
  "mcp__cos-tools__addBook",
  "mcp__cos-tools__updateBook",
  "mcp__cos-tools__logReadingProgress",
  "mcp__cos-tools__setBookCover",
];
