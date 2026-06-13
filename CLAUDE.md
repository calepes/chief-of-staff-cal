# Jano

**Chief of Staff digital de Cal.** Copilot personal (familia, bienestar, claridad, hábitos); también ayuda con trabajo (Yape) cuando Yapito no está. Se presenta como "Jano". Daemon `com.cal.cos-agent-v2`.

> Este CLAUDE.md es la guía **dev/ops** para trabajar SOBRE el repo. El **comportamiento** del bot en runtime vive en `daemon-v2/src/system-prompt.ts` (fuente de verdad), no acá.

## Scope de herramientas
- **Jano (personal):** pendientes en Apple Reminders — lista "Personal" (tareas) y "Vibe Projects" (ideas/backlog). NO Notion para tareas.
- **Yapito (trabajo):** pendientes en Notion DB Tareas. Ver `Yapito/CLAUDE.md`.
- Notion en Jano solo para: búsquedas/memoria, Metas Salud, otras DBs.

## Dónde vive qué
| Tema | Fuente de verdad |
|---|---|
| Comportamiento / reglas / formato Telegram | `daemon-v2/src/system-prompt.ts` |
| Tools custom (implementación) | `daemon-v2/src/agent-tools.ts` |
| Permisos / DISALLOWED_BUILTINS / allowlist | `daemon-v2/src/agent-options.ts` |
| Registro de MCPs + su env | `daemon-v2/src/index.ts` (`BASE_OPTIONS.mcpServers`) |
| Schema de MCPs custom | `~/Claude Projects/Personal/MCP Servers/mcp-servers/CLAUDE.md` |
| Worker CF (webhook/callbacks) | `worker-v2/src/index.ts` |
| Arquitectura completa | `docs/ARCHITECTURE.md` |

## Comandos operativos
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
# Build (REQUERIDO antes de restart si tocaste shared/ o daemon/)
npm -w @cos/shared run build && npm -w @cos/daemon run build
# Restart daemon
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
# Logs / estado del proceso
tail -f ~/Library/Logs/cos-agent-v2.{out,err}.log
launchctl print gui/$(id -u)/com.cal.cos-agent-v2 | grep -E "state|pid"
# Deploy worker CF (tras cambiar worker-v2/)
cd worker-v2 && npx wrangler deploy
```
El watchdog re-setea el webhook solo cada 1 min. Re-set manual de webhook + debug de contexto en CF KV: ver `docs/ARCHITECTURE.md`.

## Índice de tools + MCPs
Implementación y detalle en código (ver "dónde vive qué"). Inventario:
- **Custom (`cos-tools`):** getOutlookEvents · runBriefing · searchPlace · travelTime · requestUserLocation · getTokenUsage · getWhatsappContacts/saveWhatsappContact · pptWizardSave/Load · getFocoCalStatus/logFocoProgress · fetchAsUser · fetchAndSummarize · readPersistedOutput · readwiseGetDailyReview.
- **Built-ins:** Skill · WebFetch · WebSearch.
- **MCPs heredados (OAuth Max):** Google Calendar · Notion · Gmail (lectura).
- **MCPs custom:** youtube-transcribe · exchange-rate-bolivia · naabol-flights · health · apple-reminders · combustible · feedbin · readwise · inversiones-query · worldcup · spark · panini-mundial.

## .env / secrets — carga en runtime
Fuente: `daemon-v2/src/index.ts`.
1. **dotenv first-wins:** `~/.cos-agent/.env` PRIMERO → `~/.claude/secrets/apps.env`. No-override → el del agente pisa al compartido.
2. **Validación:** críticas con `requireEnv()` (throw si faltan): `CF_*`, `COS_TELEGRAM_BOT_TOKEN`, `NOTION_*`. Opcionales → `""`.
3. **Anthropic auth:** `delete process.env.ANTHROPIC_API_KEY` fuerza OAuth Max (creds en macOS Keychain `Claude Code-credentials`, NO en .env; si no se borra, API key Tier 1 → 429).
4. **MCPs custom:** cada uno spawneado con solo sus tokens vía `mcpServers[].env` (least-privilege).

| Credencial | Origen en runtime |
|---|---|
| API keys de servicios + bot token + Notion token | `.env` files (dotenv) |
| Auth Claude/Anthropic + MCPs heredados | OAuth Max en macOS Keychain |
| Tokens por-MCP custom | inyectados en `mcpServers[].env` |

## Gotchas del entorno
- **`ntn api` query:** usar `/v1/data_sources/{ds_id}/query`, NO `/v1/databases/{id}/query` (devuelve 400). El `data_source_id` ≠ `db_id`.
- **MCP prefijo Notion:** `mcp__claude_ai_Notion__*` (heredado OAuth Max). NO `mcp__notion__*` → "permissions not granted" silencioso. Igual para Gmail/Calendar.
- **SDK librería NO lee `~/.claude/.mcp.json`:** registrar MCPs custom en `BASE_OPTIONS.mcpServers` (`daemon-v2/src/index.ts`). Sin esto: "permissions not granted".
- **Formato Telegram = HTML:** parse mode HTML, escapar solo `< > &`. NO MarkdownV2. `sanitizeForTelegram()` convierte Markdown rezagado. Detalle en `system-prompt.ts`.
- **PDF/DOCX:** `processDocument()` en `index.ts` (pdf-parse v2 / mammoth), trunca a 50K.
- **SNI filtering bloquea Telegram** en algunas redes (WiFi guest/hoteles): "Connection reset" en TLS. Daemon arranca pero el bot queda mudo. Diagnóstico: `curl -s https://api.telegram.org/bot$TOKEN/getMe` vacío mientras google.com funciona. Fix: cambiar red.
- **Debug estado launchd:** `launchctl print gui/$(id -u)/com.cal.cos-agent-v2` (más útil que `launchctl list | grep`).
- **`reminders` con pantalla bloqueada cuelga** (espera TCC). En procesos sin sesión: `timeout 30s reminders ...`.
- **`fetchAsUser` requiere FDA** en `~/.npm-global/bin/node` (lee Cookies.binarycookies de Safari).
- **SDK persisted-output loop:** tool result >~25KB → SDK persiste a `toulu_*.json`; el LLM reintenta el tool. Solución: usar `fetchAndSummarize` (el texto no entra al contexto).
- **compact.ts → Markdown en historial:** si reaparece Markdown en respuestas largas, revisar el prompt de `daemon-v2/src/compact.ts` ("sin Markdown, texto plano").

## Notion
- Integración "Claude CoS" (DB Tareas + People). Prefijo MCP: `mcp__claude_ai_Notion__*`.
- Referencia cross-project: `~/Claude Projects/notion-reference.md` (bajo demanda).

## Referencias (cargar bajo demanda)
- Menú interactivo + callbacks + flujos de tareas: `docs/references/menu-telegram.md`
- Viajes, calendarios, briefings, health, audio, /today: `docs/references/viajes-calendarios.md`
- Arquitectura completa: `docs/ARCHITECTURE.md` · Backlog: `BACKLOG.md`
- Telegram cross-project: `~/Claude Projects/telegram-reference.md`
- Contexto Yape: `~/Claude Projects/Yape/CLAUDE.md`
- Specs/Planes: `docs/superpowers/specs/` y `docs/superpowers/plans/`

## Automatización — DESACTIVADA 2026-06-13 (dormida)
Crons/heartbeat/learnings están apagados: 7 plists `bootout` + archivados en `~/Library/LaunchAgents/disabled-2026-06-13/`. Las carpetas `heartbeat-tasks/`, `hooks/`, `launchd/` se conservan. Jano corre **100% reactivo** (responde mensajes; sin proactividad). Cómo era y cómo reactivar: `docs/references/hooks-automatizacion.md`.
