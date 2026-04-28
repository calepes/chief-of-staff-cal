# CoS Agent v2 — diseño (2026-04-28)

## Contexto y motivación

El daemon actual `com.cal.cos-agent` ejecuta `claude --channels plugin:telegram@claude-plugins-official` como binario de Claude Code Cli, con plugin Telegram en modo polling. Sufre dos problemas conocidos:

1. **TCC reset en cada update del binario `claude`** — macOS pide diálogo gráfico que el daemon launchd no puede aprobar. Mitigación actual: TTY humano (Cal abre sesión interactiva post-update). Fragil.
2. **Conflict 409 con sesiones interactivas** del mismo bot `@calclaudecode_bot` — Telegram solo permite un poller por token. Mitigación actual: hooks `cos-channel-bootout/bootstrap.sh` (cableados 2026-04-28) que descargan el daemon cuando arranca una sesión.

Pecunia v2 y Family/Vesta v2 ya migraron al patrón **Node + Agent SDK como librería + webhook + CF Queue**. Resultado: sin TCC reset, sin conflict 409 (webhook reemplaza polling). Esta migración aplica el mismo patrón al CoS.

## Scope (decidido en brainstorming)

**Solo el bot conversacional.** Los crons (heartbeat, briefings país, nightly-report, eisenhower-weekly, morning-build, skill-detector, proactive-ideas, outlook-cache, extract-learnings, sync-learnings) NO entran al daemon v2. Siguen como hoy: pausados en `disabled-2026-04-21/` o ejecutándose como `claude -p` programados separados. No sufren TCC reset porque corren on-demand en sesiones nuevas, no como daemon persistente.

Razones de scope mínimo:
- El bot conversacional es el componente que sufre los dos problemas críticos. Justifica la migración.
- Permite validar la migración con riesgo mínimo y extender en iteraciones futuras.
- Match con Vesta v2 — mismo patrón, consistencia operativa.

Trade-off aceptado: heartbeat tasks/briefings que se reactiven siguen como plists separados con `claude -p`. Tienen su propio gotcha (TCC reset si actualiza binario claude) pero al menos no afectan el bot conversacional.

## Arquitectura

```
Telegram → CF Worker /telegram/webhook
              ├─ light callback? → callback-router edge → Telegram API (~300ms)
              └─ heavy / message → CF Queue cos-events
                                       ↓
                                 Mac daemon Node (Agent SDK + OAuth Max)
                                       ↓
                                 Tools custom + MCPs heredados → Telegram API
```

### Componentes

| Componente | Rol |
|---|---|
| `worker-v2/` (Hono) | Webhook, callback router en edge, queue producer, endpoints `/internal/*` |
| `daemon-v2/` (Node 22) | Queue poller, Agent SDK, tools custom, processMessage, `startup()` fresco por turn |
| `shared-v2/` | Types (TelegramUpdate, QueueMessage, callback types) + helpers (sendMessage, editMessage, sendChatAction, escapeMarkdownV2) |
| `~/Library/LaunchAgents/com.cal.cos-agent-v2.plist` | KeepAlive del daemon Node |
| `~/.cos-agent/.env` | Secrets locales (chmod 600) |
| `~/.cos-agent/webhook-secret.txt` | Backup del webhook secret (wrangler secrets son one-way) |

### Recursos Cloudflare

- Queue `cos-events` con `wrangler queues consumer http add` para pull mode.
- KV `cos-state` para conversation context y callback state.
- Worker `cos-agent-worker.carlos-cb4.workers.dev`.
- Secrets: `COS_TELEGRAM_BOT_TOKEN`, `COS_WEBHOOK_SECRET`, `PECUNIA_INTERNAL_SECRET` (compartido para llamadas cross-project si fuera necesario).

## Tools custom (MCP `cos-tools`)

| Tool | Args | Descripción |
|---|---|---|
| `listTasks` | `{ status?, assignee?, dueRange?, limit? }` | Query Notion DB Tareas con filtros |
| `createTask` | `{ title, status?, assignee?, due?, project? }` | Crear tarea |
| `markTaskDone` | `{ pageId }` | Marca como done (status field) |
| `completeTask` | `{ pageId }` | Idem (alias semántico) |
| `setTaskStatus` | `{ pageId, status }` | Cambiar a cualquier status válido |
| `setTaskDate` | `{ pageId, dueIso }` | Cambiar fecha |
| `getPersonas` | `{}` | Mapping pageId → nombre, cacheado in-memory TTL 1h |
| `getOutlookEvents` | `{ when?: 'today'\|'tomorrow' }` | Lee `~/.claude/hooks/cache/outlook-events.txt` (pre-procesado por cron `outlook-cache`) |
| `getHealthSummary` | `{ date? }` | HTTP GET a `health.carlos-cb4.workers.dev/summary?date=...&key=$HEALTH_API_KEY` |
| `getHealthTrend` | `{ metric, days }` | HTTP GET a `/trend?metric=...&days=...&key=...` |

### MCPs heredados (allowedTools)

- Google Calendar (8 tools)
- Notion (search, fetch, create-pages, update-page, query-database-view, get-users)
- Gmail readers (search_threads, get_thread, list_drafts, list_labels)

### Builtins permitidas

- `Skill` (para invocar `vuelos-bolivia` y otros skills globales)
- `WebFetch`
- `WebSearch`

### Bloqueadas (`DISALLOWED_BUILTINS`)

Bash, BashOutput, KillShell, Read, Write, Edit, NotebookEdit, Glob, Grep, Task, Agent, TodoWrite, Task*, MCP discovery, ScheduleWakeup, Cron*, Worktree*, Airtable writes, Gmail writes, Drive writes.

## Callback router (worker edge, light)

Lógica del actual `telegram-plugin/callback-router.ts` portada a Hono Worker. Resolución mecánica sin LLM, latencia ~200-300ms.

| Prefix | Acción | Datos |
|---|---|---|
| `menu:<section>` | `editMessageReplyMarkup` con menú estático de la sección | `~/.claude/channels/telegram/menu.json` (cargado en KV o hardcoded en worker) |
| `t:d:<pageId32>` | Notion: mark task done + `editMessageText` con confirmación | pageId32 = 32 hex chars del Notion page |
| `t:c:<pageId32>` | Notion: complete task (status=Done) | idem |
| `t:s:<pageId32>` | Skip (mantiene visible pero quita del menú) | local state |
| `t:sd:<pageId32>` | Set date today | Notion update |
| `nav:<section>` | Navegación del menú | render |

### Callbacks heavy (al daemon vía queue)

- `task:date:<pageId>` → input de fecha libre, requiere LLM para parsear "el viernes" → ISO
- `task:change:<pageId>` → cambiar campos arbitrarios, conversacional
- `build:approve:<id>` → morning-build executor (fuera de scope inicial pero hueco abierto)
- `learn:keep|drop|keepall|dropall:<id>` → fuera de scope (lo maneja el cron de extract-learnings)

## Webhook coordination con sesiones interactivas

Riesgo conocido (aprendido en migración Family): si Cal abre `claude --channels` con default channel (`@calclaudecode_bot`), grammY internamente llama `bot.start()` → `deleteWebhook(token)` automático. Eso borra el webhook v2 hasta que el watchdog del daemon lo restaure (1 min).

### Mitigación dual

1. **Hooks SessionStart/End globales adaptados** (`~/.claude/hooks/cos-channel-bootout.sh` actualmente descarga el daemon viejo): cuando arranca sesión interactiva con default channel, hacer `deleteWebhook` controlado y bootear plugin polling. Cuando termina, restaurar webhook al worker. Esto evita el ciclo borrar/watchdog/restaurar.
2. **Watchdog en daemon** (cada 1 min): si encuentra `webhook url:""`, restaura desde `~/.cos-agent/webhook-secret.txt`. Defensa en profundidad por si los hooks fallan.

Ambas medidas activas.

## Conversation state

KV `cos-state` con clave `cos-ctx:{chatId}`:
- Últimos 10 mensajes (TTL 600s)
- Estado de menú actual (qué sección está mirando el usuario)
- Sesiones de tareas activas (ej. esperando input de fecha post-callback `task:date:`)

Comando `/reset` limpia el contexto.

## Crons (NO embebidos)

Quedan fuera del daemon v2. La lista pausada/activa actual no cambia. Si Cal decide reactivar alguno, queda como `claude -p` programado separado (riesgo TCC asumido).

## Tracking y logs

- Logs daemon: `~/Library/Logs/cos-agent-v2.{out,err}.log`
- Heartbeat file: `~/.cos-agent/heartbeat`
- Telemetry per-turn: `agent_run_done` con `timing` (queueWaitMs, kvLoadMs, sdkMs, sendMs, totalMs)
- Modelo y costo: `usage` log con `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD` (cubierto por OAuth Max, $0/mes)

## Migración (Phases)

| Phase | Trabajo | Tiempo |
|---|---|---|
| 1 | Scaffolding workspaces (`daemon-v2/`, `worker-v2/`, `shared-v2/`) | ~1h |
| 2 | Worker CF (webhook + queue + secrets + callback router con menus básicos) | ~2-3h |
| 3 | Daemon Node (queue poller, agent SDK, tools custom Notion/Outlook/Health, system prompt, callbacks heavy) | ~3-4h |
| 4 | Plist `com.cal.cos-agent-v2` + tests E2E paralelo | ~1h |
| 5 | Cutover: setWebhook + bootout viejo + smoke test | ~30min |
| 6 | Adaptación de hooks SessionStart/End (deleteWebhook/setWebhook controlado) | ~1h |
| Total | | ~9-11h |

Margen sobre estimación original (6-8h) para el callback router edge (~3-4h adicionales) — vale la pena por la latencia de ~200ms en menus.

## Rollback

- `deleteWebhook` (vuelve a polling).
- `launchctl bootstrap com.cal.cos-agent` (daemon viejo).
- `launchctl bootout com.cal.cos-agent-v2` (daemon nuevo en stand-by).
- Plist viejo se preserva en `disabled-2026-04-28/` por si se requiere fast revert.

## Testing

- Smoke E2E: mandar mensaje en DM al bot, validar que el daemon procese y responda.
- Test callback light: tap en menú, validar latencia <500ms (edge).
- Test callback heavy: tap en `task:date:`, validar que abra sesión de input.
- Test webhook drift: simular `setWebhook url:""`, esperar 1 min, validar que watchdog restaure.
- Test sesión interactiva concurrente: abrir `claude --channels`, validar que hooks coordinen sin romper el webhook permanentemente.

## No-goals (out of scope explícito)

- Spotify control (callback router actual en plugin fork ya optimizado, mejor dejar fuera por ahora)
- BoA check-in (osascript Safari + Accessibility — skill standalone)
- Heartbeat engine
- Briefings país (Bolivia/Perú/Colombia)
- Morning build executor
- Skill detector
- Learnings system (capture + sync)
- Outlook cache refresh (sigue siendo cron separado)
- Apple Health worker en sí (solo lo consumimos)
- Spotify Mini App (worker independiente)

Estos componentes pueden migrar al patrón v2 en iteraciones futuras si se justifican.

## Estado post-migración esperado

- ✅ Bot CoS responde a mensajes y callbacks via webhook (~300ms light, ~1s heavy)
- ✅ Sin TCC reset (Node + SDK lib)
- ✅ Sin conflict 409 (webhook reemplaza polling)
- ✅ Watchdog auto-recupera webhook si algún proceso lo borra
- ✅ Sesiones interactivas coordinadas via hooks
- ✅ Crons separados siguen operando como hoy

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Lógica del callback-router viejo (TS bun) tiene casos no documentados | Code review del fork antes de portar; tests por prefix |
| KV state diverge entre worker y daemon | KV es source of truth, worker writes ack inmediato, daemon lee en cada turn |
| Watchdog floja en window de 60s | Hooks SessionStart/End mitigan el caso más frecuente (sesión interactiva) |
| Costos OAuth Max — uso intensivo del CoS puede exceder el plan | Monitoreo `usage.costUSD` post-migración; si excede, tirar warning a Cal |
| Daemon Node crash leak en queue (mensajes sin procesar) | CF Queue retry built-in; daemon usa try/catch + ack solo en éxito |
