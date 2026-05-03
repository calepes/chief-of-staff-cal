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
  "ToolSearch",
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
];

// MCPs heredados que SÍ usa CoS. allowedTools es allowlist estricto.
export const CLAUDE_AI_COS_TOOLS: string[] = [
  // Skills globales (vuelos-bolivia, telegram-bot-ux, briefing-pais)
  "Skill",
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
  // Notion — DB Tareas, People, Memoria, búsquedas
  "mcp__notion__notion-search",
  "mcp__notion__notion-fetch",
  "mcp__notion__notion-create-pages",
  "mcp__notion__notion-update-page",
  "mcp__notion__notion-query-database-view",
  "mcp__notion__notion-get-users",
  // YouTube — transcripción de audio via whisper local (no depende de captions)
  "mcp__youtube-transcribe__transcribeYoutube",
  // Tipo de cambio Bolivia — oficial (BCB) y paralelo (Binance P2P USDT/BOB)
  "mcp__exchange-rate-bolivia__getBcbRate",
  "mcp__exchange-rate-bolivia__getBinanceP2PRate",
  // Vuelos NAABOL (Bolivia) — útil para viajes laborales Yape (LPB-VVI, VVI-LIM, etc.)
  "mcp__naabol-flights__getFlight",
  "mcp__naabol-flights__getFlights",
  "mcp__naabol-flights__getAirportFlights",
  // Feedbin — RSS reader: no leídos, contenido completo, marcar leídos, buscar
  "mcp__feedbin__getUnreadCount",
  "mcp__feedbin__getUnreadEntries",
  "mcp__feedbin__getEntryContent",
  "mcp__feedbin__markRead",
  "mcp__feedbin__markUnread",
  "mcp__feedbin__getSubscriptions",
  "mcp__feedbin__searchEntries",
  "mcp__feedbin__deleteSubscription",
  "mcp__feedbin__savePage",
  "mcp__feedbin__addSubscription",
  // Readwise Reader — artículos guardados: listar, buscar, mover, tags, highlights
  "mcp__readwise__reader_list_documents",
  "mcp__readwise__reader_get_document_details",
  "mcp__readwise__reader_search_documents",
  "mcp__readwise__reader_move_documents",
  "mcp__readwise__reader_add_tags_to_document",
  "mcp__readwise__reader_remove_tags_from_document",
  "mcp__readwise__reader_get_document_highlights",
  "mcp__readwise__reader_create_document",
  "mcp__readwise__reader_bulk_edit_document_metadata",
  // Apple Health — métricas diarias, tendencias, workouts (migrado de custom tools a MCP)
  "mcp__health__getHealthSummary",
  "mcp__health__getHealthTrend",
  "mcp__health__getWorkouts",
  // iOS Reminders — listas personales de Cal (Mercado, Tareas Familia, etc.)
  "mcp__apple-reminders__listReminderLists",
  "mcp__apple-reminders__listReminders",
  "mcp__apple-reminders__addReminder",
  "mcp__apple-reminders__editReminder",
  "mcp__apple-reminders__completeReminder",
  "mcp__apple-reminders__deleteReminder",
  // Learning system — MCP externo (evita warm pool stale del in-process cos-tools)
  "mcp__agent-learnings__addLearning",
  // Combustible Santa Cruz — disponibilidad y distancia a estaciones de gasolina
  "mcp__combustible__getFuelStatus",
  // Google Maps — búsqueda de lugares y tiempo de viaje en tráfico real
  "mcp__cos-tools__searchPlace",
  "mcp__cos-tools__travelTime",
  // Readwise Reader + Highlights — 22 tools (confirmados 2026-05-02)
  "mcp__readwise__reader_list_documents",
  "mcp__readwise__reader_search_documents",
  "mcp__readwise__reader_get_document_details",
  "mcp__readwise__reader_create_document",
  "mcp__readwise__reader_move_documents",
  "mcp__readwise__reader_get_document_highlights",
  "mcp__readwise__reader_add_tags_to_document",
  "mcp__readwise__reader_remove_tags_from_document",
  "mcp__readwise__reader_bulk_edit_document_metadata",
  "mcp__readwise__reader_list_tags",
  "mcp__readwise__reader_add_tags_to_highlight",
  "mcp__readwise__reader_remove_tags_from_highlight",
  "mcp__readwise__reader_set_highlight_notes",
  "mcp__readwise__reader_create_highlight",
  "mcp__readwise__reader_export_documents",
  "mcp__readwise__reader_get_export_documents_status",
  "mcp__readwise__readwise_list_highlights",
  "mcp__readwise__readwise_search_highlights",
  "mcp__readwise__readwise_get_daily_review",
  "mcp__readwise__readwise_create_highlights",
  "mcp__readwise__readwise_update_highlight",
  "mcp__readwise__readwise_delete_highlight",
];
