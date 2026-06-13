# Arquitectura — Jano (Chief of Staff Cal)

> **Estado:** post-migración 2026-05-03 al modelo Pecunia.
> Jano opera 100% via webhook + daemon Node con Agent SDK librería. NO hay flujo `claude --channels` interactivo.

## Qué es

Asistente personal event-driven. La pieza central NO es Claude CLI long-running con plugin Telegram (modelo viejo, eliminado), sino:
- Un daemon Node 22 que importa `@anthropic-ai/claude-agent-sdk` como librería
- Un Cloudflare Worker que recibe el webhook de Telegram
- Una CF Queue (`cos-events`) que desacopla worker → daemon

El resto del sistema (cron agents, hooks globales, scripts standalone) sigue siendo orquestación de archivos + launchd + bash + skills.

## Topología (post-migración 2026-05-03)

```
   Telegram Bot API
   (@cal_jano_bot)
         │
         │ webhook POST (X-Telegram-Bot-Api-Secret-Token)
         ▼
   ┌──────────────────────────────────────────┐
   │ Cloudflare                               │
   │  ┌────────────────────────────────────┐  │
   │  │ cos-agent-worker (Hono)            │  │
   │  │  ├─ valida secret token            │  │
   │  │  ├─ light callbacks → edge resolve │  │
   │  │  │  (menu/t:d/t:c/t:s/t:sd/nav)    │  │
   │  │  └─ heavy → enqueue                │  │
   │  └─────────────┬──────────────────────┘  │
   │                ▼                          │
   │  ┌────────────────────────────────────┐  │
   │  │ CF Queue: cos-events               │  │
   │  │  (http_pull mode habilitado)       │  │
   │  └─────────────┬──────────────────────┘  │
   └────────────────┼─────────────────────────┘
                    │ HTTP pull
                    ▼
   ┌──────────────────────────────────────────┐
   │ macOS (la Mac de Cal)                    │
   │                                          │
   │  ┌────────────────────────────────────┐  │
   │  │ launchd: com.cal.cos-agent-v2      │  │
   │  │  Node 22 daemon (KeepAlive)        │  │
   │  │  ├─ @anthropic-ai/claude-agent-sdk │  │
   │  │  │  (librería, OAuth Max creds)    │  │
   │  │  ├─ poll cos-events                │  │
   │  │  ├─ tools custom + MCPs heredados  │  │
   │  │  ├─ multimodal (voice/photo/PDF)   │  │
   │  │  └─ watchdog cron 1m: re-set       │  │
   │  │      webhook si fue borrado        │  │
   │  └────────────────────────────────────┘  │
   │                                          │
   │  ┌────────────────────────────────────┐  │
   │  │ Cron agents (launchd) →            │  │
   │  │  invocan claude -p one-shot:       │  │
   │  │  briefings, heartbeat, nightly,    │  │
   │  │  eisenhower, learnings, etc.       │  │
   │  └────────────────────────────────────┘  │
   │                                          │
   │  Secretos: ~/.cos-agent/.env             │
   │   + shared: ~/.claude/secrets/apps.env   │
   └──────────────────────────────────────────┘

   External (Cloudflare Workers):
     • health.carlos-cb4.workers.dev (Apple Health summary)
     • apps.lepesqueur.net/dailynews/ (GH Pages briefings)
```

## Componentes principales

### 1. Daemon Node (proceso long-running, NO es Claude CLI)
- **`com.cal.cos-agent-v2`** — Node 22 + `@anthropic-ai/claude-agent-sdk` librería + OAuth Max (`~/.claude/.credentials.json`). Polea `cos-events` queue y procesa cada update con un `startup()` fresco por turno (no warm pool — ver gotchas).
- Source: `daemon-v2/src/index.ts`. Multimodal: voice (whisper-cli), photo (Vision Sonnet 4.6), PDF/DOCX (`pdf-parse`/`mammoth`).
- KeepAlive vía launchd. NO sufre TCC reset porque es Node ejecutando librería, no el binario `claude`.

### 2. Worker Cloudflare
- **`cos-agent-worker.carlos-cb4.workers.dev`** (Hono). Source: `worker-v2/src/index.ts`.
- Valida `X-Telegram-Bot-Api-Secret-Token` contra `COS_WEBHOOK_SECRET` (wrangler secret).
- Light callbacks resueltos en edge (~300ms, sin LLM): `menu:*`, `nav:*`, `t:d`, `t:c`, `t:s`, `t:sd`.
- Heavy callbacks y mensajes → encola en `cos-events` (modo `http_pull`).

### 3. Shared package
- `shared-v2/src/` — types (`TelegramUpdate`, `QueueMessage`) + helpers Telegram (`sendMessage`, `editMessage`, `escapeMarkdownV2`, `answerCallbackQuery`, `escapeHtml`).
- npm workspaces: `package.json` define `daemon-v2`, `worker-v2`, `shared-v2`.

### 4. Cron agents (tareas recurrentes vía launchd)
> **Estado 2026-06-13:** DESACTIVADOS (dormidos). Los crons/heartbeat/learnings fueron `bootout` + archivados en `~/Library/LaunchAgents/disabled-2026-06-13/`. Jano corre 100% reactivo. Lo de abajo describe el diseño original; cómo reactivar en `docs/references/hooks-automatizacion.md`.

Invocan `claude -p "<prompt>"` una vez por ejecución (sesión one-shot). Tabla abajo. Estos sí usan el binario CLI; son ortogonales al daemon.

### 5. Hooks globales (`~/.claude/hooks/`)
Scripts que el harness de Claude ejecuta automáticamente. Aplican a sesiones interactivas y a invocaciones `claude -p` de los crons. NO aplican al daemon Node (que no usa el CLI).

### 6. MCPs / integraciones externas
Wired explícitamente en `BASE_OPTIONS.mcpServers` del daemon (gotcha: SDK librería NO lee `~/.claude/.mcp.json`). Ver `Jano/CLAUDE.md` sección "Tools registradas" para la lista completa.

## Launchd agents (tabla)

| Agent | Schedule | Disparo | Qué hace |
|---|---|---|---|
| `com.cal.cos-agent-v2` | 24/7 (KeepAlive) | boot | **Daemon Node CoS (webhook puller).** Único proceso en runtime para Telegram. |
| `com.cal.family-agent-v2` | 24/7 (KeepAlive) | boot | Daemon Node Vesta (mismo patrón) |
| `com.claude.heartbeat` | cada 30min (7:00–22:30) | cron | Ejecuta `~/.claude/heartbeat-tasks/*.md` y agrupa ALERTs a Telegram |
| `com.claude.outlook-cache` | cada 4h + boot | cron | Refresca cache ICS de Outlook |
| `com.claude.daily-briefings` | 5:00 | cron | Briefings Bolivia/Perú/Colombia (HTML → GH Pages → Telegram) |
| `com.claude.nightly-report` | 22:00 | cron | Resumen del día + plan mañana |
| `com.claude.eisenhower-weekly` | dom 21:00 | cron | Clasifica tareas Notion en matriz Q1–Q4 |
| `com.claude.extract-learnings` | 21:55 | cron | Red de seguridad: extrae learnings de transcripts |
| `com.claude.sync-learnings` | dom 21:00 | cron (creado, NO cargado) | Sync `~/.claude/learnings/cos/` → `docs/learnings/` |
| `com.claude.morning-build` | 22:30 | cron (creado, NO cargado) | Genera propuesta de mejora; aprueba vía Telegram |
| `com.claude.skill-detector` | dom 21:30 | cron (creado, NO cargado) | Detecta skills frecuentes |
| `com.claude.proactive-ideas` | 9, 14, 19 | cron (creado, NO cargado) | Genera ideas → Notion + Telegram |

> **Plists viejos retirados:** `com.cal.cos-agent` (plugin Telegram polling, sufría TCC reset y conflict 409) → `disabled-2026-04-29/`. `com.cal.cos-health-check` ya no es necesario porque el daemon v2 corre estable y tiene watchdog interno.

**Invariantes launchd vigentes:**
- Plists que invocan `claude` o `bun` DEBEN incluir `/Users/calepes/.local/bin` y `/Users/calepes/.bun/bin` en `EnvironmentVariables.PATH`.
- El daemon Node NO usa `--channels`, NO usa `script -q /dev/null` PTY wrapper, NO necesita marker env var anti-bootout.
- `bash 3.2` macOS no tiene `declare -A` — usar parallel arrays con pipe delimiter.

## Hooks

### Hooks globales activos (`~/.claude/settings.json`)

| Hook script | Evento | Qué hace |
|---|---|---|
| `session-start-context.sh` | SessionStart | Inyecta fecha + recordatorios Apple + eventos Outlook cache |
| `stop-telegram-notify.sh` | Stop | (NO registrado por defecto — ruidoso en crons) |
| `pre-compact-snapshot.sh` | PreCompact | Copia transcript a `~/.claude/compact-snapshots/` |
| `notion-audit.sh` | PostToolUse (`mcp__notion__*` writes) | Loguea writes a `~/.claude/logs/notion-audit.log` |
| `learn-error.sh` | PostToolUse (`exit_code != 0`) | Captura errores como learnings automáticos |

### Hooks ELIMINADOS (2026-05-03)

- ~~`cos-channel-bootout.sh`~~ (SessionStart) — descargaba `com.cal.cos-agent` al abrir sesión `--channels`
- ~~`cos-channel-bootstrap.sh`~~ (SessionEnd) — recargaba el daemon al cerrar la sesión
- ~~`family-channel-bootout.sh`~~ / ~~`family-channel-bootstrap.sh`~~ — equivalentes para Vesta
- ~~`check-telegram-conflicts.sh`~~ — detector legado del conflict de bot

**Motivo de eliminación:** ya no hay flujo `claude --channels` para Jano/Vesta. El daemon webhook es el único consumidor. Los hooks eran innecesarios y participaron en el incidente del 2026-05-03 (ver "Lección aprendida" abajo). Sus 4 entradas en `~/.claude/settings.json` (2 SessionStart + 2 SessionEnd) fueron removidas.

### Scripts standalone (no son hooks de Claude — los invocan crons)

Viven en `~/.claude/hooks/` por convención: `heartbeat.sh`, `heartbeat-status.sh`, `refresh-outlook-cache.sh`, `eisenhower-weekly.sh`, `nightly-report.sh`, `extract-learnings.sh`, `morning-build.sh` + `morning-build-execute.sh`, `skill-detector.sh` + `skill-install.sh`, `proactive-ideas.sh`.

## Flujos clave

### Flujo 1: Mensaje de Telegram → respuesta del bot (modelo webhook)
```
1. Cal escribe al bot desde su iPhone
2. Telegram POST → cos-agent-worker.carlos-cb4.workers.dev/telegram/webhook
3. Worker valida X-Telegram-Bot-Api-Secret-Token contra COS_WEBHOOK_SECRET
4. Worker enqueua QueueMessage en cos-events
5. Daemon Node (com.cal.cos-agent-v2) hace HTTP pull periódico, recibe el batch
6. Por cada update: startup() fresco del Agent SDK, system prompt, tools custom + MCPs
7. LLM procesa: detecta intent, llama tools (Notion, GCal, Apple Reminders, etc.)
8. Termina con sendMessage/editMessage HTTP a Telegram API
9. Daemon ack del mensaje en la queue
```

### Flujo 2: Callback inline button
```
1. Cal toca botón con callback_data (ej. "t:d:<pageId32>")
2. Telegram POST → worker
3. Worker clasifica:
   a. Light callback (menu:*, nav:*, t:d, t:c, t:s, t:sd) →
      callback-router edge ejecuta acción directa (Notion API), edita mensaje,
      responde answerCallbackQuery. Total ~300ms. NO toca queue, NO toca daemon.
   b. Heavy callback (task:date, task:change, build:approve, etc.) →
      worker enqueua como mensaje sintético "[callback] data" → daemon → LLM
```

### Flujo 3: Cron (ejemplo: briefings 5am)
```
1. launchd dispara com.claude.daily-briefings a las 5:00
2. Ejecuta `gtimeout 15m claude -p "/briefing-pais bolivia"` (binario CLI, no daemon)
3. Claude genera HTML, publica a apps.lepesqueur.net/dailynews/, notifica Telegram
4. Repite para Perú y Colombia secuencial
```

> El cron usa el binario `claude` con OAuth Max. Es ortogonal al daemon Node.

### Flujo 4: Heartbeat (monitoreo interno)
```
1. launchd com.claude.heartbeat dispara cada 30min (7:00-22:30)
2. heartbeat.sh lee ~/.claude/heartbeat-tasks/*.md (frontmatter: schedule, priority)
3. Para cada check aplicable: invoca `claude -p` con el body
4. Check devuelve "ALERT\n<msg>" o "HEARTBEAT_OK"
5. Agrupa ALERTs por prioridad en un único mensaje Telegram (vía curl directo)
6. Failure counter en ~/.claude/state/heartbeat-failures → alerta si ≥3 consecutivos
```

### Flujo 5: Watchdog del webhook (defensa interna del daemon)
```
1. Daemon Node corre cron interno cada 1 minuto
2. GET https://api.telegram.org/bot<TOKEN>/getWebhookInfo
3. Si url != "https://cos-agent-worker.carlos-cb4.workers.dev/telegram/webhook":
   → POST setWebhook con URL correcta + secret_token
4. Esto cubre el caso (en teoría imposible post-2026-05-03) de que algún proceso
   externo llame deleteWebhook. Sin estado-dir interactivo y con token rotado,
   no debería disparar nunca.
```

### Flujo 6: Morning build (propuesta + aprobación Telegram)
```
22:30 cron → morning-build.sh:
1. Lee git log, learnings pending, heartbeat log, tareas mañana
2. Invoca `claude -p` con morning-build-prompt.md → propuesta JSON
3. Guarda a ~/.claude/morning-builds/proposals/<id>.json
4. Envía a Telegram con botones ✅ Aprobar / ❌ Rechazar

Cal tap ✅:
1. Worker recibe callback build:approve:<id> (heavy) → enqueua → daemon
2. Daemon (o callback-router edge en variantes) lanza morning-build-execute.sh async
3. Executor invoca `claude -p` con scope restringido (solo commands/, hooks/, docs)
4. Clasifica output: DONE → commit; ABORT/FAIL → archiva
5. Notifica Telegram con commit hash
```

## Lección aprendida (2026-05-03)

**Incidente:** loop de drift cíclico del webhook + queue colgada + bot mudo intermitente durante ~3 días.

**Causa raíz:** durante una transición previa (~2026-04-30) el token de Jano quedó copiado en `~/.claude/channels/telegram/.env` (state dir genérico del plugin Telegram). Cualquier proceso CLI que cargara el plugin con ese state dir disparaba grammY → `bot.start()` → `deleteWebhook(token)` automático (es el comportamiento estándar de grammY para evitar conflict polling+webhook). El watchdog del daemon detectaba el webhook borrado y lo restauraba ~60s después → loop de borrado/restauración mientras siguiera vivo el otro proceso.

**Por qué los hooks `cos-channel-*.sh` no salvaron:** estaban diseñados para coordinar el daemon viejo (`com.cal.cos-agent`, plugin polling) con sesiones interactivas `--channels` cargadas explícitamente con `TELEGRAM_STATE_DIR=~/.claude/channels/telegram-cos`. NO contemplaban que un proceso ajeno (cron, otra sesión) cargara el plugin con el state dir genérico — porque originalmente ese state dir no tenía el token de Jano.

**Fix definitivo (2026-05-03):**
1. Token rotado vía BotFather (invalidó cualquier copia rezagada).
2. Eliminado `~/.claude/channels/telegram-cos/` (state dir aislado que brevemente existió).
3. Eliminado `~/.claude/channels/telegram/.env` (donde estaba el token leak).
4. Eliminados los hooks `cos-channel-bootout.sh`, `cos-channel-bootstrap.sh` y sus equivalentes Family + sus 4 entradas en `~/.claude/settings.json`.
5. Eliminada toda mención al flujo `claude --channels` en `Jano/CLAUDE.md` y `Vesta/CLAUDE.md`.
6. Modelo unificado: webhook puro, idéntico a Pecunia. El daemon Node es el ÚNICO consumidor del bot.

**Por qué eliminar el modo plugin interactivo:**
- No aportaba capacidades extra (el daemon ya cubre 100% del flujo).
- Generaba acoplamiento frágil (state dirs, hooks de coordinación, env vars marker).
- Multiplicaba superficies de fallo (TCC reset, conflict 409, webhook drift).
- Pecunia llevaba un mes operando estable solo con webhook → patrón validado.

**Invariante nuevo:** ningún proceso fuera del daemon Node debe poseer el token de Jano. Si en el futuro se necesita debug interactivo, hacerlo via logs (`tail -f ~/Library/Logs/cos-agent-v2.{out,err}.log`) y restart del daemon, NO via plugin Telegram.

## Gotchas / invariantes clave (vigentes)

- **Token isolation:** `COS_TELEGRAM_BOT_TOKEN` vive ÚNICAMENTE en `~/.cos-agent/.env`. NO copiar a `~/.claude/channels/*/.env` ni a ninguna otra ubicación. Cualquier copia revive el riesgo de drift.
- **CF Queue requiere `wrangler queues consumer http add cos-events`** para que el daemon haga pull (modo HTTP REST). Sin esto: `pull failed: 405 messages cannot be pulled unless http_pull mode is enabled`.
- **Agent SDK warm pool stale rompe MCP custom:** `startup()` fresco por invocación (no `prewarmNext()`). Costo: ~3-5s extra de spawn por turn, ganancia: tools custom registran confiablemente.
- **SDK librería NO lee `~/.claude/.mcp.json`:** registrar custom MCPs explícitamente en `Options.mcpServers` al hacer `startup()`. Síntoma cuando se olvida: "No such tool available" o "permissions not granted" para `mcp__<name>__*`.
- **`ANTHROPIC_API_KEY` heredada en process.env → rate limit Tier 1:** el subprocess `claude` del SDK la prefiere sobre OAuth Max. Fix: `delete process.env.ANTHROPIC_API_KEY` después de leerla en const local, ANTES del primer `startup()`.
- **`bun` y `claude` NO están en PATH default de launchd** — plists DEBEN añadir `/Users/calepes/.bun/bin` y `/Users/calepes/.local/bin`.
- **bash 3.2 macOS** sin `declare -A` — parallel arrays con pipe delimiter.
- **`set -e` + `grep -c` sin match** mata scripts silenciosamente — usar `set -uo pipefail` (sin `-e`) en scripts de conteo/status.
- **SNI filtering** en ciertas WiFi bloquea `api.telegram.org` — diagnóstico: `curl` a Telegram devuelve vacío; fix: cambiar de red.
- **macOS `find -newermt "@epoch"` no funciona** — usar `-mtime` o `touch -t` + `-newer <ref>`.
- **PostToolUse hook `tool_response`** no tiene `exit_code` top-level para Bash — el hook asume 0 por default.

## Convenciones

- **Source of truth de hooks:** `~/.claude/hooks/` (lo que ejecuta el harness/launchd)
- **Copias de backup:** `hooks/` del repo del proyecto correspondiente (para git)
- **Estado runtime:** `~/.claude/state/`, `~/.claude/learnings/`, `~/.claude/morning-builds/`
- **Logs daemon:** `~/Library/Logs/cos-agent-v2.{out,err}.log`
- **Logs hooks globales:** `~/.claude/logs/`
- **Secretos daemon:** `~/.cos-agent/.env` (chmod 600). NO duplicar tokens en otros archivos.
- **Webhook secret:** env var `COS_WEBHOOK_SECRET` en `~/.cos-agent/.env` (espejo en wrangler secret de CF). Archivo legacy `webhook-secret.txt` eliminado 2026-05-23.
- **Plists:** `~/Library/LaunchAgents/com.claude.*.plist` (CoS crons) y `com.cal.*.plist` (daemons + Family crons)

## Referencias cruzadas
- `CLAUDE.md` — contexto operativo completo (incluye lista de tools, MCPs, comandos, gotchas)
- `CHANGELOG.md` — historia de cambios
- `BACKLOG.md` — pendientes
- `docs/superpowers/specs/` y `docs/superpowers/plans/` — diseños implementados
- `~/.claude/CLAUDE.md` — instrucciones globales
- `~/Claude Projects/telegram-reference.md` — referencia cross-project Telegram
- `~/Claude Projects/Yape/CLAUDE.md` — contexto Yape
