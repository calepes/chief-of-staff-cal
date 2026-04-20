# Arquitectura — Chief of Staff Cal

## Qué es

Asistente personal event-driven basado en Claude CLI + macOS `launchd` + hooks. NO es una aplicación tradicional con servidor propio: todo el trabajo lo hace Claude CLI invocado en distintos contextos (daemon, cron, sesión interactiva, agente SessionStart). La "aplicación" vive como orquestación de archivos, agentes launchd, scripts bash y configuraciones.

## Topología

```
                  ┌──────────────────────────────────────────────┐
                  │              macOS (la Mac de Cal)           │
                  │                                              │
   Telegram       │   ┌────────────┐         ┌────────────────┐ │
   ──────────────────▶│ cos-agent  │◀───────▶│ Claude CLI     │ │
   @calclaudecode_bot │  (daemon)  │         │ (long-running) │ │
                  │   └────────────┘         └───────┬────────┘ │
                  │                                  │          │
                  │   ┌────────────┐                 │          │
                  │   │ Cron agents│───────┐         │          │
                  │   │ (launchd)  │       │         │          │
                  │   └────────────┘       │         │          │
                  │                        ▼         ▼          │
                  │                   ┌─────────────────┐       │
                  │                   │   claude -p     │       │
                  │                   │ (sesiones one-  │       │
                  │                   │  shot agentic)  │       │
                  │                   └────────┬────────┘       │
                  │                            │                │
                  │     ┌──────────────────────┴──────────────┐ │
                  │     ▼      ▼            ▼        ▼        │ │
                  │  ┌──────┐ ┌──────┐ ┌────────┐ ┌────────┐ │ │
                  │  │Notion│ │ GCal │ │Outlook │ │Tele API│ │ │
                  │  │ MCP  │ │ MCP  │ │  ICS   │ │  (bot) │ │ │
                  │  └──────┘ └──────┘ └────────┘ └────────┘ │ │
                  └──────────────────────────────────────────┘ │
                                                               │
   External (Cloudflare Workers):                              │
     • health.carlos-cb4.workers.dev (Apple Health summary)    │
     • apps.lepesqueur.net/dailynews/ (GH Pages briefings)     │
```

## Componentes principales

### 1. Daemons (procesos long-running)
- **`com.cal.cos-agent`** — `claude --channels plugin:telegram` corriendo 24/7. Es UN proceso Claude CLI conectado al bot `@calclaudecode_bot` via long-polling. Cuando llega un mensaje, lanza un turno completo de Claude.
- **`com.cal.family-agent`** — mismo patrón pero con bot `@antocatanoecal_bot` y `TELEGRAM_STATE_DIR` propio (`~/.claude/channels/telegram-family`).

### 2. Cron agents (tareas recurrentes vía launchd)
Invocan `claude -p "<prompt>"` una vez por ejecución (sesión one-shot). Ver tabla abajo.

### 3. Sesiones interactivas
Cal abre `claude` en terminal. Dos modos:
- **Sin `--channels`** (recomendado para dev): el daemon Telegram sigue activo en paralelo
- **Con `--channels`**: sesión recibe mensajes Telegram también; los hooks descargan el daemon para evitar conflict

### 4. Hooks (dentro del CLI de Claude)
Scripts que el harness de Claude ejecuta automáticamente en ciertos eventos (SessionStart, SessionEnd, PreToolUse, etc.).

### 5. Scripts standalone
No son hooks de Claude — son scripts bash invocados por launchd o por otros scripts. Suelen invocar `claude -p` internamente para trabajo agentic.

### 6. MCPs / integraciones externas
Notion (directo + workspace), Google Calendar, Outlook (ICS), Airtable, Readwise, Playwright, Telegram plugin, Health worker, etc.

## Launchd agents (tabla completa)

| Agent | Schedule | Disparo | Qué hace |
|---|---|---|---|
| `com.cal.cos-agent` | 24/7 (KeepAlive) | boot | Daemon Telegram CoS |
| `com.cal.family-agent` | 24/7 (KeepAlive) | boot | Daemon Telegram Family |
| `com.claude.heartbeat` | cada 30min (7:00–22:30) | cron | Ejecuta checks de `~/.claude/heartbeat-tasks/*.md` y agrupa ALERTs a Telegram |
| `com.claude.outlook-cache` | cada 4h + boot | cron | Refresca cache ICS de Outlook |
| `com.claude.daily-briefings` | 5:00 | cron | Genera briefings Bolivia/Perú/Colombia (HTML → GH Pages → Telegram) |
| `com.claude.nightly-report` | 22:00 | cron | Resumen del día + plan mañana, review de learnings pending |
| `com.claude.eisenhower-weekly` | dom 21:00 | cron | Clasifica tareas Notion en matriz Q1–Q4 |
| `com.claude.extract-learnings` | 21:55 | cron | Red de seguridad: extrae learnings de transcripts |
| `com.claude.sync-learnings` | dom 21:00 | cron (creado, NO cargado) | Sync `~/.claude/learnings/cos/` → `docs/learnings/` |
| `com.claude.morning-build` | 22:30 | cron (creado, NO cargado) | Genera propuesta de mejora; aprueba vía Telegram botones |
| `com.claude.skill-detector` | dom 21:30 | cron (creado, NO cargado) | Detecta skills frecuentes y propone auto-instalación |
| `com.claude.proactive-ideas` | 9, 14, 19 | cron (creado, NO cargado) | Lee X+Threads+tareas → idea a Notion + Telegram |
| `com.cal.cos-health-check` | cada 15min | cron | Detecta cuelgue silencioso del daemon CoS, auto-kickstart |
| `com.cal.family-briefing-am/pm` | 6:30 / 21:30 | cron | Briefings familiares |
| `com.cal.family-check-recordatorios` | cada 15min | cron | Recordatorios familiares |
| `com.cal.family-extrae-aprendizajes` | 22:00 | cron | Learnings del agent familiar |
| `com.cal.family-health-check` | cada 15min | cron | Auto-recover del daemon Family |

**Invariantes launchd:**
- Todos los plists que invocan `claude` o `bun` DEBEN incluir `/Users/calepes/.local/bin` (claude) y `/Users/calepes/.bun/bin` (bun) en `EnvironmentVariables.PATH`
- Plists que invocan `--channels` DEBEN usar wrapper `/usr/bin/script -q /dev/null` (crea PTY falso — sin esto, el CLI crashea pidiendo stdin)
- Daemons Telegram DEBEN setear env var `COS_AGENT_BG=1` o `FAMILY_AGENT_BG=1` para que los SessionStart hooks se auto-ignoren

## Hooks

### Globales (`~/.claude/hooks/`)

| Hook script | Evento | Contexto | Qué hace |
|---|---|---|---|
| `session-start-context.sh` | SessionStart | global | Inyecta fecha + tareas vencidas Notion + eventos Outlook cache |
| `cos-channel-bootout.sh` | SessionStart (CoS) | proyecto CoS | Descarga `com.cal.cos-agent` al abrir sesión interactiva con `--channels` |
| `cos-channel-bootstrap.sh` | SessionEnd (CoS) | proyecto CoS | Recarga `com.cal.cos-agent` al cerrar la última sesión interactiva |
| `family-channel-bootout.sh` | SessionStart (Family) | proyecto Family | Equivalente para daemon Family |
| `family-channel-bootstrap.sh` | SessionEnd (Family) | proyecto Family | Equivalente para daemon Family |
| `check-telegram-conflicts.sh` | SessionStart | legado | Detecta conflict de bot en sesión (solo avisa; reemplazado por bootout/bootstrap) |
| `stop-telegram-notify.sh` | Stop | global | Push notification a Telegram cuando Claude termina un turno (`end_turn`) |
| `pre-compact-snapshot.sh` | PreCompact | global | Copia transcript a `~/.claude/compact-snapshots/` antes de compactar (últimos 20) |
| `notion-audit.sh` | PostToolUse (`mcp__notion__*`) | global | Loguea writes a Notion en audit log |
| `learn-error.sh` | PostToolUse | global | Captura errores (`exit_code != 0`) como learnings automáticos |

### Hooks invocados por cron (scripts standalone, NO son hooks de Claude)

Viven en `~/.claude/hooks/` pero son scripts bash tipo worker:
- `heartbeat.sh` + `heartbeat-status.sh` — engine de checks periódicos
- `refresh-outlook-cache.sh` — descarga ICS
- `daily-briefing.sh` — obsoleto, reemplazado por skill `/briefing-pais`
- `eisenhower-weekly.sh` — clasifica tareas
- `nightly-report.sh` — resumen del día
- `extract-learnings.sh` — batch nocturno de learnings
- `morning-build.sh` + `morning-build-execute.sh` — generador + ejecutor
- `skill-detector.sh` + `skill-install.sh` — detector + instalador de skills
- `proactive-ideas.sh` — generador de ideas

## Flujos clave

### Flujo 1: Mensaje de Telegram → respuesta del bot
```
1. Cal escribe al bot desde su iPhone
2. Telegram API recibe mensaje, lo encola para el bot
3. El daemon cos-agent (launchd) hace long-poll y recibe el update
4. El plugin Telegram (bun server.ts) entrega el update al CLI de Claude como "channel message"
5. Claude arranca un turno: lee el mensaje + contexto del proyecto (CLAUDE.md, skills, hooks)
6. Si el mensaje es un comando registrado (/today, /tareas, /menu), ejecuta el skill correspondiente
7. Si es texto libre, usa tool calls (Notion, GCal, etc.) según intent
8. Termina con tool `reply` → plugin Telegram envía mensaje al chat
```

### Flujo 2: Mensaje con botón inline (callback)
```
1. Cal toca un botón con callback_data "t:d:<pageId>" (task:done)
2. Telegram manda callback_query al bot
3. Plugin Telegram (fork personalizado) intercepta el callback:
   a. Si prefix es mecánico (t:d, t:c, t:s, t:sd, spotify:*): callback-router.ts
      → ejecuta acción directa (Notion API), edita mensaje, responde a Telegram
      → NO pasa por el LLM (~200ms total)
   b. Si prefix requiere razonamiento (task:date, task:change, approve:*, menu:*):
      → plugin hace edit mecánico "⏳ Cargando..." y reenvía callback al CLI como mensaje
      → Claude procesa, responde con reply nuevo (no edit)
```

### Flujo 3: Cron (ejemplo: briefings 5am)
```
1. launchd dispara com.claude.daily-briefings a las 5:00
2. Ejecuta ~/.claude/hooks/daily-briefing.sh (wrapper) o invoca skill /briefing-pais por país
3. Script invoca `gtimeout 15m claude -p "/briefing-pais bolivia"`
4. Claude genera HTML, publica a apps.lepesqueur.net/dailynews/, notifica Telegram
5. Repite para Perú y Colombia secuencial
```

### Flujo 4: Heartbeat (monitoreo interno)
```
1. launchd com.claude.heartbeat dispara cada 30min (7:00-22:30)
2. heartbeat.sh lee ~/.claude/heartbeat-tasks/*.md (frontmatter: schedule, priority)
3. Para cada check aplicable al horario: invoca `claude -p` con el body del archivo
4. Check devuelve "ALERT\n<msg>" o "HEARTBEAT_OK"
5. Agrupa ALERTs por prioridad en un único mensaje Telegram
6. Failure counter en ~/.claude/state/heartbeat-failures → alerta "heartbeat caído" si ≥3 consecutivos
```

### Flujo 5: Channel conflict guard (sesión interactiva vs daemon)
```
Estado inicial: daemon cos-agent activo haciendo polling.

Cal abre terminal: `claude --channels plugin:telegram@claude-plugins-official`
1. CLI dispara SessionStart hook chain
2. cos-channel-bootout.sh chequea:
   - ¿Tiene --channels? sí
   - ¿TELEGRAM_STATE_DIR custom? no
   - ¿COS_AGENT_BG=1? no (estamos en sesión interactiva, no en el daemon)
3. Ejecuta: launchctl bootout gui/$(id -u) <cos-agent.plist>
4. Daemon muere; KeepAlive NO respawns (bootout permanente)
5. Sesión interactiva toma el polling del bot

Cal cierra terminal (/exit, Ctrl+D):
1. CLI dispara SessionEnd hook chain
2. cos-channel-bootstrap.sh cuenta otras sesiones vivas con --channels
3. Si quedan 0: launchctl bootstrap del daemon → retoma polling en background
4. Si quedan >0: no recarga (otra sesión interactiva aún activa)

Invariante: exactamente UN consumidor del bot en todo momento.
```

### Flujo 6: Morning build (propuesta + aprobación Telegram)
```
22:30 cron → morning-build.sh:
1. Lee git log últimas 24h, learnings pending, heartbeat log, tareas mañana
2. Invoca `claude -p` con morning-build-prompt.md → genera UNA propuesta JSON
3. Guarda a ~/.claude/morning-builds/proposals/<id>.json
4. Envía a Telegram con botones ✅ Aprobar / ❌ Rechazar

Cal tap ✅:
1. Callback build:approve:<id> llega al plugin
2. callback-router.ts lanza morning-build-execute.sh <id> async (spawn detached)
3. Executor invoca `claude -p` con scope restringido (solo commands/, hooks/, docs)
4. Clasifica output: DONE → commit; ABORT → archiva; FAIL → archiva + avisa
5. Notifica Telegram con commit hash
```

## Gotchas / invariantes clave

- **Una instancia por bot token** — Telegram long-poll permite UN getUpdates simultáneo; múltiples procesos causan conflict 409 y mensajes se reparten aleatoriamente
- **`bun` NO está en PATH default** de launchd — plists DEBEN añadir `/Users/calepes/.bun/bin`
- **`claude` NO está en PATH default** de launchd — plists DEBEN añadir `/Users/calepes/.local/bin`
- **launchd plists con `--channels` requieren PTY wrapper** — `/usr/bin/script -q /dev/null` antes del claude
- **SessionStart hooks también disparan en daemons launchd** — si el hook modifica launchd, necesita env var marker (`COS_AGENT_BG=1`) para no auto-sabotearse
- **bash 3.2 macOS no tiene `declare -A`** — usar parallel arrays con pipe delimiter
- **`set -e` + `grep -c` sin match** mata scripts silenciosamente — usar `set -uo pipefail` (sin `-e`) en scripts de conteo/status
- **SNI filtering** en ciertas WiFi bloquea `api.telegram.org` — diagnóstico: `curl` a Telegram devuelve vacío; fix: cambiar de red
- **macOS `find -newermt "@epoch"` no funciona** — usar `-mtime` o `touch -t` + `-newer <ref>`

## Convenciones

- **Source of truth de hooks:** `~/.claude/hooks/` (lo que ejecuta el harness/launchd)
- **Copias de backup:** `hooks/` del repo del proyecto correspondiente (para git)
- **Estado runtime:** `~/.claude/state/`, `~/.claude/channels/`, `~/.claude/learnings/`, `~/.claude/morning-builds/`
- **Logs:** `~/Library/Logs/` (por agente launchd) o `~/.claude/logs/` (por hook global)
- **Secretos:** `~/.claude/channels/telegram/.env` (chmod 600) — prefijo por proyecto (`TELEGRAM_BOT_TOKEN`, `FAMILY_TELEGRAM_BOT_TOKEN`, etc.)
- **Plists:** `~/Library/LaunchAgents/com.claude.*.plist` (CoS crons) y `com.cal.*.plist` (daemons + Family crons)
- **Deploy plugin fork:** editar en `telegram-plugin/` → `cp ... plugin cache 0.0.5+0.0.6`

## Referencias cruzadas
- `CLAUDE.md` — contexto operativo completo
- `CHANGELOG.md` — historia de cambios
- `BACKLOG.md` — pendientes
- `docs/superpowers/specs/` y `docs/superpowers/plans/` — diseños implementados
- `~/.claude/CLAUDE.md` — instrucciones globales
- `~/Documents/Claude Projects/telegram-reference.md` — referencia cross-project Telegram
- `~/Documents/Claude Projects/Yape/CLAUDE.md` — contexto Yape
