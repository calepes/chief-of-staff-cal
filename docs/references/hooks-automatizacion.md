# Hooks & Automatización (Jano)

## Hooks registrados en `~/.claude/settings.json`

| Hook | Script | Estado | Función |
|------|--------|--------|---------|
| SessionStart | `session-start-context.sh` | Registrado | Inyecta fecha/hora + recordatorios Apple + instrucción GCal |
| PostToolUse | `learn-error.sh` | Registrado | Captura errores de tools (solo `exit_code != 0`) |
| PostToolUse (Notion) | `notion-audit.sh` | Registrado | Loguea writes `mcp__claude_ai_Notion__.*` a `~/.claude/logs/notion-audit.log` (rotación 5MB) |
| PreCompact | `pre-compact-snapshot.sh` | Registrado | Copia transcript a `~/.claude/compact-snapshots/` (últimos 20); notifica Telegram si trigger=manual |
| Stop | `stop-telegram-notify.sh` | NO registrado | Notifica vía @ClaudeCalbot en `end_turn`. Demasiado ruidoso (dispara en crons) |

## Crons launchd

| Plist | Schedule | Script / función |
|-------|----------|------------------|
| `com.claude.outlook-cache` | cada 4h + boot | `refresh-outlook-cache.sh` — descarga ICS BCP, expande RRULE con Python `recurring_ical_events`, escribe `~/.claude/hooks/cache/outlook-events.txt` (consumido por tool `getOutlookEvents`) |
| `com.claude.daily-briefings` | 5:00am | Briefings Bolivia + Perú + Colombia via claude CLI. `gtimeout` 15min/país |
| `com.claude.nightly-report` | 22:00 | `nightly-report.sh` — resumen día + plan mañana. Readwise prefix `mcp__claude_ai_Readwise__*`. Python post-processor stripea preamble antes del `📊` |
| `com.claude.eisenhower-weekly` | Dom 21:00 | `eisenhower-weekly.sh` — matriz Q1-Q4 de recordatorios. timeout 600s, scope Personal + Tareas Familia (NO Vibe Projects). Envía via curl con token Jano. Prompt incluye reglas FORMATO HTML completas |
| `com.claude.heartbeat` | cada 30min 7am-22:30 | Ver sección Heartbeat abajo |
| `com.claude.morning-build` | 22:30 | Ver sección Morning Builds abajo |
| `com.claude.skill-detector` | Dom 21:30 (NO cargado) | Ver sección Skill Detector abajo |
| `com.claude.proactive-ideas` | 9am/14:00/19:00 (NO cargado) | Ver sección Proactive Ideas abajo |

**Gotcha launchd PATH:** Plists que invocan `claude` CLI DEBEN incluir `/Users/calepes/.npm-global/bin` (claude) y `/Users/calepes/.bun/bin` (bun, MCP servers de plugins) en `EnvironmentVariables.PATH`. Sin claude: `gtimeout: failed to run command 'claude'` y silencio. Sin bun: plugin MCP falla, daemon arranca pero sin polling.

## Heartbeat engine

`com.claude.heartbeat` — cada 30min de 7am a 22:30. `~/.claude/hooks/heartbeat.sh` lee `~/.claude/heartbeat-tasks/*.md` (frontmatter `schedule`+`priority`), ejecuta cada check con `claude -p` (timeout 60s), agrupa ALERTs por prioridad en un único mensaje a Telegram. Failure counter en `~/.claude/state/heartbeat-failures` → alerta si ≥3 consecutivos.

- **Status:** `~/.claude/hooks/heartbeat-status.sh`
- **Flags:** `--dry-run`, `--only <name>` (bypassa filtro de `schedule` para testing)
- **Repo copies:** `hooks/heartbeat*.sh`, `heartbeat-tasks/`, `launchd/com.claude.heartbeat.plist`

**Recovery:**
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claude.heartbeat.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.heartbeat.plist
echo 0 > ~/.claude/state/heartbeat-failures
~/.claude/hooks/heartbeat.sh --only <check-name> --dry-run  # smoke test
```

**Checks actuales:**
- **Tasks/calendario:** `overdue-reminders.md` (every/high), `incomplete-tasks.md` (morning-only/medium), `midday-steps.md` (midday-only/medium).
- **Token usage:** `usage-morning.md` (morning-wake/low), `usage-evening.md` (every/low).
- **Health:** `health-sleep.md` (morning-wake/high — anoche <6h), `health-steps-evening.md` (evening/medium — <6k a las 17-19h), `health-sedentary.md` (business-hours/low — <70% stand hours), `health-hrv-weekly.md` (weekly-monday-am/medium — HRV <80% baseline 4 sem), `health-daylight.md` (late-afternoon/low — <15min daylight), `health-strength-weekly.md` (weekly-monday-am/medium — <3 sesiones strength/sem), `health-bodycomp-weekly.md` (weekly-monday-am/low).
- **Schedules:** `morning-wake` (7-9am), `evening` (17-19h), `business-hours` (10-19h L-V), `weekly-monday-am` (Lun 8-9am), `late-afternoon` (17-18h).
- **Anti-spam:** state file `~/.claude/state/health-alerts-YYYY-MM-DD.json` con 1 alerta/día por tipo. Cleanup >7 días al inicio de cada run.
- **Spec/plan:** `docs/superpowers/specs/2026-04-19-health-alerts-design.md` + plan correspondiente.

**Agregar nuevo check:** Crear `~/.claude/heartbeat-tasks/<name>.md` con frontmatter `name`, `schedule`, `priority`. Body = prompt para `claude -p`. Output esperado: `ALERT\n<msg>` o `HEARTBEAT_OK`. Copiar también a repo `heartbeat-tasks/`. Sin reload — engine lee dinámicamente. Si el schedule dispara múltiples veces/día (`every`, `morning-only`, `business-hours`) DEBE incluir dedup via `seen_today`/`mark_seen` con state file (patrón de `overdue-reminders.md`) o spameará.

## Morning Builds (Fase 5.2)

- **Generator:** `~/.cos-agent/morning-build.sh` (cron 22:30) — lee contexto del día (git log, learnings pending, heartbeat log, tareas mañana), invoca `claude -p` con `morning-build-prompt.md`, guarda propuesta JSON a `~/.claude/morning-builds/proposals/`, manda a Telegram con botones ✅/❌.
- **Executor:** `~/.claude/hooks/morning-build-execute.sh <id>` — disparado por callback `build:approve:<id>` (async detached). Corre `claude -p` con scope restringido, clasifica output `DONE|ABORT|FAIL`, mueve a `implemented/failed/`, notifica.
- **Scope permitido (estricto):** `commands/*`, `heartbeat-tasks/*`, `hooks/*.sh`, `CLAUDE.md`, `BACKLOG.md`, `CHANGELOG.md`, `docs/**/*.md`. NO plugin TS, NO workers, NO plists, NO settings.json.
- **Callbacks:** `build:approve:<id>` dispara exec async; `build:reject:<id>` archiva a `rejected/`.

## Skill Detector (Fase 5.3)

- **Detector:** `~/.claude/hooks/skill-detector.sh` (cron Dom 21:30, NO cargado) — escanea transcripts de 7 días, detecta patrones ≥3/semana, genera JSON con skill completo.
- **Installer:** `~/.claude/hooks/skill-install.sh <id>` (callback `skill:approve:<id>`) — escribe `commands/<name>.md` + `~/.claude/commands/<name>.md`, commit + push. Mecánico (body ya generado en el JSON).
- **Criterio:** solo skills con frecuencia ≥3/semana que no dupliquen existentes. Si duda → `null`.
- **Gotcha find macOS:** `find -newermt "@epoch"` NO funciona en macOS. Usar `-mtime -7`, o `touch -t` + `-newer <ref>` para cursor exacto.

## Proactive Ideas

`com.claude.proactive-ideas` (9am/14:00/19:00, plist creado NO cargado) — `proactive-ideas.sh` lee posts X+Threads últimas 24h + tareas Notion → idea JSON → escribe a Notion DB "Ideas Proactivas (CoS)" (`59e0439d7fe0483ab735575b9e0c1007`) + Telegram. Slots: foco 🎯, tactical ⚡, lookahead 🔮. Requiere `X_BEARER_TOKEN`, `X_USER_ID`, `THREADS_TOKEN`, `THREADS_USER_ID`, `NOTION_TASKS_DB_ID`, `NOTION_IDEAS_DB_ID` en `~/.cos-agent/.env`. Cargar: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.proactive-ideas.plist`.

## Learnings históricos

- **Index:** `~/.claude/learnings/cos/index.md` — consultar antes de decisiones técnicas o cuando Cal mencione un tema con histórico. Index chico (~1-2KB); abrir archivo de detalle solo si la línea lo amerita.
- **Captura:** skill `/learn <tipo> "<desc>"` (intencional) + hook `learn-error.sh` (errores, solo `exit_code != 0`) + batch nocturno 21:55 `extract-learnings.sh`.
- **Review:** integrado en nightly-report 22:00 con botones `learn:keep|drop|keepall|dropall`.
- **Sync:** Dom 21:00 a `docs/learnings/` del repo.
- **Status:** `~/.claude/hooks/learnings-status.sh`. **Recovery:** `rebuild-learnings-index.sh`.
- **Tipos:** `correction | pattern | error | decision | idea`.
- **Spec/plan:** `docs/superpowers/specs/2026-04-19-self-improving-learnings-design.md` + plan.

## Otros

- **Status line:** `fecha hora | proyecto | contexto | modelo`, refreshInterval 60s. Config: `~/.claude/statusline-command.sh`.
- **Menú bot Telegram:** `scripts/setup-menu-button.sh` — configura setChatMenuButton con Mini App (actual: Spotify). Re-ejecutar para cambiar label/URL.
- **Deploy plugin fork:** `cp telegram-plugin/{server,notion-client,callback-router}.ts ~/.claude/plugins/cache/claude-plugins-official/telegram/*/`.
