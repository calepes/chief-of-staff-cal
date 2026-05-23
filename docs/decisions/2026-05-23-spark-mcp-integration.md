# Spark MCP Integration

**Fecha:** 2026-05-23
**Autor:** Cal + Claude
**Estado:** Implementado
**Formato:** Decision Capture (Paweł Model — Bloque 2)

## Contexto

Jano (CoS daemon Node + `@anthropic-ai/claude-agent-sdk`) tiene acceso a Gmail vía el MCP heredado de OAuth Max (`mcp__claude_ai_Gmail__*`), pero ese MCP solo cubre Gmail. Cal usa Spark Desktop como cliente unificado para múltiples cuentas (Lepesqueur + Gmail + otras) y maneja calendar + contactos + meetings desde ahí.

Spark Desktop (Readdle) expone un binario IPC (`/opt/homebrew/bin/spark`, symlink a `SparklyRemote` dentro del app bundle) **diseñado explícitamente por Readdle para agentes AI** — output ya formateado en tablas legibles con IDs claros y mensajes de error con remediation. Cubre 15 capacidades: 11 read-only (accounts, folders, emails, search, threads, events, availability, contacts, teams, meetings) + 4 write (drafts, comments, email actions, contact actions).

Jano no puede invocar el CLI directamente: tiene `Bash` en `DISALLOWED_BUILTINS` por seguridad. Necesita un MCP wrapper.

## Alternativas evaluadas

### A. MCP wrapper local (stdio, monorepo)
Crear `servers/spark/` en el monorepo de MCPs (`Personal/MCP Servers/mcp-servers/`). Helper `runSpark` con `execFile('/opt/homebrew/bin/spark', args)`, 15 tools wrappers que mapean 1:1 al CLI, output passthrough sin re-formateo. Registrar en `BASE_OPTIONS.mcpServers` de Jano y allowlist `CLAUDE_AI_COS_TOOLS`.

- **Pros:** patrón establecido (apple-reminders, feedbin, naabol-flights ya lo hacen), code reuse del monorepo, Mac-only es OK porque Spark Desktop ya lo es, output passthrough mantiene drift mínimo si Readdle actualiza el CLI.
- **Cons:** Mac-only — no migra a Cloudflare Workers (Fase 2 de Pecunia cloud). Suma a lista existente de MCPs Mac-bound (`apple-reminders`, `youtube-transcribe`).

### B. Esperar API REST de Spark
Readdle no expone API REST pública; Spark es IPC-only. La única vía es el binario CLI.

- **Pros:** ninguna realmente — la opción no existe.
- **Cons:** bloquea el feature indefinidamente.

### C. Adapter HTTP local + Cloudflare Worker proxy
Correr un servidor HTTP local en Mac que wrappea el CLI, exponerlo a un Worker remoto vía tunnel/proxy para que el MCP sea consumible desde un daemon cloud.

- **Pros:** abriría camino a uso desde Pecunia cloud (si algún día Pecunia necesitara email).
- **Cons:** YAGNI severo — Pecunia no necesita email, Jano corre en Mac, complejidad operacional (tunnel auth, lifecycle del servidor local, latencia). Resuelve un problema que nadie tiene.

## Decisión

**Elegida: A — MCP wrapper local stdio en el monorepo.**

Implementado en `servers/spark/` siguiendo exactamente el patrón de `apple-reminders` (single `src/index.ts`, `execFile` helper con timeout, output passthrough, errores como `isError: true` con stderr crudo). 15 tools registradas en Jano: `mcp__spark__{listAccounts, listFolders, listEmails, searchEmails, readThread, listEvents, findAvailability, searchContacts, listTeams, listMeetings, readMeeting, createDraft, postComment, emailAction, contactAction}`.

## Razonamiento

1. **Spark CLI ya está optimizado para LLMs** — Readdle lo diseñó así. Re-formatear introduce drift y trabajo sin valor.
2. **Patrón monorepo establecido** — usar la convención del repo elimina decisiones; cualquier daemon futuro (Vesta para "qué tareas familiares mandó Noe por email") puede consumir sin refactor.
3. **YAGNI sobre cloud-readiness** — Spark Desktop es Mac-only por naturaleza. Resolver Mac-bound antes de que sea problema no agrega valor.
4. **Sin Zod, schemas mínimos** — el CLI valida sus argumentos; si falla, stderr fluye al LLM. Mantiene código corto (~300 líneas total).
5. **Sin caching** — Spark Desktop es la fuente de verdad y maneja su propio cache. Re-llamar es O(IPC), no O(network).

## Trade-offs aceptados

| Trade-off | Por qué OK |
|---|---|
| Mac-only (no migra a Workers) | Spark Desktop también es Mac-only; problema inherente, no del wrapper |
| Output texto (no JSON estructurado) | LLM parsea texto nativamente; CLI ya optimizado para AI |
| Sin override de binary path via env | YAGNI — agregar si Vesta/Pecunia corren en otro Mac con setup distinto |
| Write tools fallan hasta activar `triage` en Spark | Error claro del CLI; user puede subir access level cuando quiera |
| Sin tests unitarios de las 15 tools (solo de `runSpark`) | Wrappers 1:1; testing real es integration contra Spark Desktop |

## Implementación

- Plan: `Personal/MCP Servers/mcp-servers/docs/superpowers/plans/2026-05-23-spark-mcp.md`
- Spec: `Personal/MCP Servers/mcp-servers/docs/superpowers/specs/2026-05-23-spark-mcp-design.md`
- Server: `Personal/MCP Servers/mcp-servers/servers/spark/`
- Wire en Jano:
  - `daemon-v2/src/index.ts` — registro en `BASE_OPTIONS.mcpServers`
  - `daemon-v2/src/agent-options.ts` — 15 tools en `CLAUDE_AI_COS_TOOLS`
  - `daemon-v2/src/system-prompt.ts` — sección "Spark (email + calendar unificado)" con guidance

## Validación

1. `npm -w mcp-spark run build` — OK
2. `npm run build` en `daemon-v2` — OK (Tasks 7 y 8)
3. Reload daemon Jano (Task 10 — pendiente)
4. E2E vía Telegram a Jano (Task 11 — pendiente): "emails sin leer hoy", "qué tengo mañana", "busca emails sobre Yape", draft → error de triage
