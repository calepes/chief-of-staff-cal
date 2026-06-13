# Rediseño de documentación de Jano — Spec

**Fecha:** 2026-06-13
**Estado:** Diseño aprobado, pendiente plan de implementación

## Problema

El `CLAUDE.md` de Jano (156 líneas) tiene tres dolores, priorizados por Cal:

1. **Desactualizado** — describe crons/heartbeat/learnings como activos, pero fueron desactivados el 2026-06-13 (7 plists `bootout` + archivados en `~/Library/LaunchAgents/disabled-2026-06-13/`).
2. **Muy largo / quema tokens** — se carga en cada sesión interactiva sobre el repo; mucho contenido es duplicación de lo que ya vive en código.
3. **Mezcla operación y producto** — combina "cómo opero el daemon" (dev/ops) con "qué es Jano y cómo se comporta" (producto/runtime). El comportamiento ya es canónico en `daemon-v2/src/system-prompt.ts`.

**Aclaración de audiencia:** este `CLAUDE.md` es para Claude trabajando *sobre* el repo (dev/ops), NO es el system-prompt del daemon en runtime (ese es `system-prompt.ts`). Esto refuerza la separación operación↔producto.

## Objetivo

`CLAUDE.md` = **guía operativa dev/ops + índice**, ~80 líneas. Una sola fuente de verdad por tema (producto → punteros al código; no duplicar). Sin contenido muerto. Pasada full de docs para consistencia.

## Decisiones de diseño

- **Forma del CLAUDE.md:** guía operativa + índice (no split en OPERATIONS.md, no stub mínimo).
- **Automatización:** marcar **dormida** (no purgar). Una línea + puntero al anexo; conservar carpetas `heartbeat-tasks/`, `hooks/`, `launchd/` por si se reactiva. Reversible.
- **Producto/comportamiento:** índice mínimo (tools/MCPs 1 línea c/u) + punteros a la fuente de verdad en código. No duplicar reglas de formato/Notion/scope en extenso.
- **Ítem 7 (.env/secrets):** documentar la **cadena de carga de tokens en runtime** (ver abajo), no "dónde comprar tokens".
- **Alcance:** pasada full de docs (CLAUDE.md + cruft + anexos + ARCHITECTURE + README + BACKLOG).

## Arquitectura de docs objetivo

| Doc | Propósito | Acción |
|---|---|---|
| `CLAUDE.md` | Guía dev/ops + índice | Reescribir (~80 líneas) |
| `docs/ARCHITECTURE.md` | Arquitectura profunda | Verificar + marcar automatización dormida |
| `docs/references/hooks-automatizacion.md` | Anexo crons/heartbeat | Banner "DORMIDO 2026-06-13" arriba |
| `docs/references/menu-telegram.md`, `viajes-calendarios.md` | Anexos | Verificar coherencia |
| `docs/briefing-pais-instructions.md` | Prompt operativo de `runBriefing` (vivo) | Dejar; verificar runBriefing wired |
| `docs/HANDOFF-2026-06-11.md` | WIP migración Notion | Dejar (WIP activo) |
| `BACKLOG.md` | Backlog | Limpiar items de automatización muerta |
| `CHANGELOG.md` | Historia append-only | NO tocar |
| `README.md` (stub 3 líneas) | Orientación de entrada | Rellenar ~10 líneas → apunta a CLAUDE.md + ARCHITECTURE |
| `TODO.md`, `diseno-agente-telegram.md`, `guia-implementacion-copilot.md` | Cruft pre-build | Archivar → `docs/archive/` |

## Nuevo CLAUDE.md — outline (~80 líneas)

1. **Qué es** (3 líneas)
2. **Scope** (2 líneas: Jano personal → Apple Reminders · Yapito trabajo → Notion Tareas)
3. **Dónde vive qué** *(bloque nuevo)*: comportamiento → `system-prompt.ts` · tools → `agent-tools.ts` · MCPs → `mcp-servers/CLAUDE.md` · arquitectura → `docs/ARCHITECTURE.md`
4. **Comandos operativos** (build / restart / deploy worker / logs / webhook) — inline
5. **Índice tools + MCPs** (1 línea c/u, apunta al código)
6. **Gotchas del entorno** (conservar, trim leve)
7. **.env / secrets — cadena de carga en runtime** (ver detalle abajo)
8. **Referencias** (anexos) + línea: **Automatización: desactivada 2026-06-13 (dormida, ver `hooks-automatizacion.md`)**

### Detalle ítem 7 — cadena de tokens en runtime

Fuente: `daemon-v2/src/index.ts`.

1. **dotenv first-wins** (líneas 27-28): `loadEnv(~/.cos-agent/.env)` PRIMERO → `loadEnv(~/.claude/secrets/apps.env)` SEGUNDO. No-override: el del agente pisa al compartido.
2. **Validación** (30-60): críticas con `requireEnv()` (throw): `CF_*`, `COS_TELEGRAM_BOT_TOKEN`, `NOTION_*`. Opcionales → `""`.
3. **Anthropic auth** (62-64): `delete process.env.ANTHROPIC_API_KEY` para forzar **OAuth Max** (credenciales en macOS Keychain `Claude Code-credentials`, NO en .env). Sin esto: API key Tier 1 → 429.
4. **MCPs custom** (226-279): cada uno spawneado con solo sus tokens (`mcpServers[].env`) — least-privilege.
5. **MCPs heredados** (Notion/GCal/Gmail): OAuth Max del Keychain, no .env.

Tabla resumen:

| Credencial | Origen en runtime |
|---|---|
| API keys de servicios + bot token + Notion token | `.env` files (dotenv first-wins) |
| Auth Claude/Anthropic + MCPs heredados | OAuth Max en macOS Keychain (no .env) |
| Tokens por-MCP custom | inyectados en `mcpServers[].env` |

## Lo que NO se toca

- Código (`daemon-v2/`, `worker-v2/`, `shared-v2/`, `telegram-plugin/`).
- `CHANGELOG.md` (historia append-only).
- `system-prompt.ts` (fuente de verdad de comportamiento — solo se apunta a él).
- Las carpetas de automatización (se conservan dormidas).

## Criterios de éxito

- `CLAUDE.md` ≤ ~90 líneas, sin mención de automatización activa, con el bloque "dónde vive qué" y la cadena de tokens en runtime.
- Cero duplicación de listas de tools/reglas que ya viven en código (solo índice + punteros).
- 3 archivos cruft fuera del root (en `docs/archive/`).
- Anexos coherentes; `hooks-automatizacion.md` con banner dormido.
- Ningún valor de secreto en ningún `.md` (verificado: hoy no hay).
