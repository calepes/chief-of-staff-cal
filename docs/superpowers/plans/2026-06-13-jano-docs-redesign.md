# Rediseño de docs de Jano — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reescribir el `CLAUDE.md` de Jano como guía operativa dev/ops + índice (~80 líneas), eliminar contenido muerto, separar operación de producto, y dejar el resto de docs coherente.

**Architecture:** Trabajo de documentación, no código. Cada tarea modifica/crea/archiva archivos `.md` con contenido concreto, se verifica con `grep`/`wc`, y se commitea por separado. Sin tests unitarios.

**Tech Stack:** Markdown, git, bash (`grep`, `wc`, `mv`, `mkdir`).

**Spec:** `docs/superpowers/specs/2026-06-13-jano-docs-redesign-design.md`

---

## Task 1: Archivar cruft pre-build

**Files:**
- Create dir: `docs/archive/`
- Move: `TODO.md`, `diseno-agente-telegram.md`, `guia-implementacion-copilot.md` → `docs/archive/`

- [ ] **Step 1: Crear carpeta de archivo y mover los 3 archivos**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
mkdir -p docs/archive
git mv TODO.md docs/archive/TODO.md
git mv diseno-agente-telegram.md docs/archive/diseno-agente-telegram.md
git mv guia-implementacion-copilot.md docs/archive/guia-implementacion-copilot.md
```

- [ ] **Step 2: Añadir un README de archivo que explique por qué están ahí**

Create `docs/archive/README.md`:

```markdown
# Archivo

Docs pre-build de Jano (antes de construir el daemon v2). Históricos, no operativos.

- `TODO.md` — checklist original de setup ("Semana 1").
- `diseno-agente-telegram.md` — doc de diseño previo a la implementación.
- `guia-implementacion-copilot.md` — guía basada en el framework de Tal Raviv (inspiración inicial).
```

- [ ] **Step 3: Verificar que el root quedó limpio**

Run: `ls TODO.md diseno-agente-telegram.md guia-implementacion-copilot.md 2>&1`
Expected: 3 líneas "No such file or directory".
Run: `ls docs/archive/`
Expected: los 3 archivos + README.md.

- [ ] **Step 4: Commit**

```bash
git add -A docs/archive TODO.md diseno-agente-telegram.md guia-implementacion-copilot.md
git commit -m "docs: archivar cruft pre-build (TODO, diseno-agente, guia-copilot) a docs/archive/"
```

---

## Task 2: Reescribir CLAUDE.md (núcleo)

**Files:**
- Modify (overwrite): `CLAUDE.md`

Antes de escribir: el contenido de las gotchas se preserva del CLAUDE.md actual; solo se quitan las que refieren a automatización dormida. La sección "Tools registradas" extensa se reemplaza por el índice.

- [ ] **Step 1: Sobrescribir `CLAUDE.md` con el nuevo contenido**

Contenido completo del nuevo `CLAUDE.md`:

````markdown
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
````

- [ ] **Step 2: Verificar longitud y ausencia de contenido muerto**

Run: `wc -l CLAUDE.md`
Expected: ≤ 95 líneas.
Run: `grep -niE "cron.*activo|heartbeat.*cada 30|extract-learnings \(21|sync-learnings \(Dom" CLAUDE.md`
Expected: sin matches (no describe automatización como activa).
Run: `grep -c "DESACTIVADA 2026-06-13" CLAUDE.md`
Expected: ≥ 1.

- [ ] **Step 3: Verificar que el bloque "dónde vive qué" y la cadena de tokens existen**

Run: `grep -E "Dónde vive qué|delete process.env.ANTHROPIC_API_KEY|OAuth Max en macOS Keychain" CLAUDE.md`
Expected: las 3 líneas presentes.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: reescribir CLAUDE.md de Jano como guía operativa + índice (slim, separar operación/producto, automatización dormida)"
```

---

## Task 3: Banner "dormido" en hooks-automatizacion.md

**Files:**
- Modify: `docs/references/hooks-automatizacion.md:1` (insertar banner al inicio)

- [ ] **Step 1: Insertar el banner al inicio del archivo**

Insertar como primeras líneas (antes del primer `#` existente):

```markdown
> ⚠️ **DORMIDO desde 2026-06-13.** Todos los crons/heartbeat/learnings descritos aquí están desactivados (`bootout` + plists archivados en `~/Library/LaunchAgents/disabled-2026-06-13/`). Los plists archivados están **corruptos** (un script de update de schedule los sobrescribió con solo el fragmento JSON) — reactivar requiere reconstruir el plist primero, no solo moverlo de vuelta. Este doc es la referencia de cómo eran y cómo reactivarlos.

```

- [ ] **Step 2: Verificar**

Run: `head -3 docs/references/hooks-automatizacion.md | grep -c "DORMIDO desde 2026-06-13"`
Expected: 1.

- [ ] **Step 3: Commit**

```bash
git add docs/references/hooks-automatizacion.md
git commit -m "docs: marcar hooks-automatizacion.md como dormido (2026-06-13)"
```

---

## Task 4: Actualizar ARCHITECTURE.md (automatización dormida + verificación)

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Localizar la sección de crons/heartbeat/automatización**

Run: `grep -niE "cron|heartbeat|learnings|automatiz" docs/ARCHITECTURE.md`
Expected: lista de líneas. Anotar el rango de la sección de automatización.

- [ ] **Step 2: Insertar nota de estado al inicio de esa sección**

Insertar, justo antes de la primera mención de crons/heartbeat de esa sección:

```markdown
> **Estado 2026-06-13:** automatización (crons/heartbeat/learnings) DESACTIVADA. Ver `docs/references/hooks-automatizacion.md`. Lo de abajo describe el diseño original.
```

Si ARCHITECTURE.md no tiene una sección de automatización propia, agregar la nota en la sección que más la mencione (la identificada en Step 1).

- [ ] **Step 3: Verificar el resto de la arquitectura sigue vigente (webhook→queue→daemon)**

Run: `grep -niE "webhook|CF Queue|cos-events|polea|polling" docs/ARCHITECTURE.md | head`
Expected: describe webhook → CF Queue → daemon (vigente). Si menciona `claude --channels` o polling como activo, corregir a webhook (modelo Pecunia). Anotar cualquier inconsistencia encontrada.

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: marcar automatización dormida en ARCHITECTURE.md + verificar vigencia"
```

---

## Task 5: Limpiar BACKLOG.md de items de automatización muerta

**Files:**
- Modify: `BACKLOG.md`

- [ ] **Step 1: Identificar items que dependen de automatización apagada**

Run: `grep -niE "heartbeat|cron|learnings|skill-detector|proactive-ideas|morning.build|eisenhower|nightly" BACKLOG.md`
Expected: lista de items. Anotar cuáles asumen crons activos.

- [ ] **Step 2: Marcar esos items como bloqueados por la pausa**

Para cada item identificado que NO esté ya hecho, anteponer el marcador `[BLOQUEADO — automatización dormida 2026-06-13]`. No borrar items (preservar historia del backlog). Si no hay items relevantes, anotar "sin cambios" y saltar al commit.

- [ ] **Step 3: Verificar**

Run: `grep -c "BLOQUEADO — automatización dormida" BACKLOG.md`
Expected: ≥ 0 (igual al número de items marcados; documentar el número).

- [ ] **Step 4: Commit**

```bash
git add BACKLOG.md
git commit -m "docs: marcar items de automatización dormida en BACKLOG"
```

---

## Task 6: Rellenar README.md

**Files:**
- Modify (overwrite): `README.md`

- [ ] **Step 1: Sobrescribir README.md**

```markdown
# Jano

Chief of Staff digital de Cal — daemon Telegram (`com.cal.cos-agent-v2`) sobre Agent SDK + OAuth Max, webhook → CF Queue.

- **Cómo trabajar sobre el repo, comandos, gotchas:** ver `CLAUDE.md`.
- **Arquitectura:** ver `docs/ARCHITECTURE.md`.
- **Comportamiento del bot (runtime):** `daemon-v2/src/system-prompt.ts`.
- **Workspaces:** `daemon-v2/` (daemon Node), `worker-v2/` (CF Worker), `shared-v2/` (tipos/helpers).

> Automatización (crons/heartbeat/learnings) desactivada 2026-06-13 — ver `docs/references/hooks-automatizacion.md`.
```

- [ ] **Step 2: Verificar**

Run: `wc -l README.md && grep -c "CLAUDE.md" README.md`
Expected: ~10 líneas, ≥ 1 referencia a CLAUDE.md.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rellenar README de Jano con orientación de entrada"
```

---

## Task 7: Verificar anexos vivos coherentes

**Files:**
- Read-only verify: `docs/references/menu-telegram.md`, `docs/references/viajes-calendarios.md`, `docs/briefing-pais-instructions.md`

- [ ] **Step 1: Verificar que menu-telegram y viajes-calendarios no referencian automatización muerta**

Run: `grep -niE "heartbeat|cron|learnings" docs/references/menu-telegram.md docs/references/viajes-calendarios.md`
Expected: sin matches relevantes. Si los hay, marcarlos con nota "(dormido 2026-06-13)".

- [ ] **Step 2: Verificar que runBriefing sigue wired (briefing-pais-instructions.md vivo)**

Run: `grep -n "runBriefing" "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2/src/agent-tools.ts"`
Expected: ≥ 1 match (tool sigue registrada → el doc sigue vivo). Si no hay match, marcar el doc como dormido también.

- [ ] **Step 3: Commit (solo si hubo cambios)**

```bash
git add docs/references/ docs/briefing-pais-instructions.md
git commit -m "docs: verificar y reconciliar anexos vivos (menu, viajes, briefing)" || echo "sin cambios"
```

---

## Self-Review (cobertura del spec)

- Spec "CLAUDE.md ≤ ~90 líneas + bloque dónde-vive-qué + cadena tokens" → Task 2 ✓
- Spec "automatización dormida + carpetas conservadas" → Task 2 (línea) + Task 3 (anexo) + Task 4 (architecture) ✓
- Spec "índice mínimo, no duplicar producto" → Task 2 (sección Índice) ✓
- Spec "3 cruft → docs/archive/" → Task 1 ✓
- Spec "README rellenar" → Task 6 ✓
- Spec "BACKLOG limpiar" → Task 5 ✓
- Spec "anexos coherentes" → Task 3, Task 7 ✓
- Spec "no tocar código/CHANGELOG/system-prompt.ts" → ninguna tarea los modifica ✓
- Spec "ningún secreto en .md" → ya verificado; las tareas no introducen valores ✓
