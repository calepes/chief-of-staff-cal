# Self-improving Learnings — Diseño (Fase 5.1)

**Fecha:** 2026-04-19
**Status:** Aprobado
**Fase:** 5.1 (CoS Auto-mejora continua)

## Goal

El CoS captura aprendizajes de cada sesión (correcciones, errores, decisiones, ideas, patterns repetitivos), los acumula en filesystem indexado bajo `~/.claude/learnings/cos/`, y propone reviews diarios vía Telegram para que Cal valide qué entries quedan como "verdad" del agente. CLAUDE.md queda lean — todo el conocimiento histórico vive en learnings/ y se consulta lazy via index.md.

## Principios

1. **CLAUDE.md lean**: solo instrucciones operativas y pointers. Conocimiento histórico vive en learnings/
2. **Propose before apply**: nada se aplica sin que Cal toque un botón. Los entries empiezan `pending: true` y solo se activan tras review en Telegram
3. **Captura tolerante a fallas**: en vivo + batch nocturno como red de seguridad. No depender de SessionEnd (frágil)
4. **Filesystem-RAG**: el agente lee `index.md` (chico) primero, abre archivos de detalle solo cuando hace falta

## Arquitectura

### Layout

```
~/.claude/
├── learnings/cos/
│   ├── index.md                 # mapa central (tag-indexed)
│   ├── corrections.md           # tipo A
│   ├── patterns.md              # tipo B
│   ├── errors.md                # tipo C
│   ├── decisions.md             # tipo D
│   ├── feature_requests.md      # tipo E
│   └── archive/2026-04.md       # entries rechazadas (no se borran)
├── hooks/
│   ├── extract-learnings.sh     # batch 21:55 — red de seguridad + patterns B
│   ├── learn-error.sh           # PostToolUse — captura errores C en vivo
│   ├── nightly-report.sh        # MODIFICADO — agrega sección review Learnings
│   ├── rebuild-learnings-index.sh  # recovery: regenera index desde archivos
│   └── learnings-status.sh      # observabilidad
├── commands/
│   └── learn.md                 # skill /learn — captura intencional
├── state/
│   ├── learnings-cursor         # último timestamp procesado por el batch
│   └── learnings-stats.json     # entries por tipo/mes
├── logs/
│   └── learnings.log            # log con rotación 5MB
└── channels/telegram/.env       # NOTION_TOKEN ya existe (no requiere cambio)

CoS repo:
├── docs/learnings/              # sync semanal (domingo 21:00)
└── scripts/sync-learnings.sh    # cron del sync
```

### CLAUDE.md changes

Agregar **un solo bullet** a CLAUDE.md global del CoS:

```markdown
## Learnings históricos
- **Index:** `~/.claude/learnings/cos/index.md` — consultar antes de tomar decisiones técnicas, cambios estructurales, o cuando Cal mencione un tema con histórico (telegram, notion, heartbeat, etc). El index es chico (~1-2KB), abrir archivo de detalle solo si la línea relevante lo amerita
```

## Componentes

### 1. Skill `/learn` (captura intencional)

`~/.claude/commands/learn.md` — invocable por Cal o por el agente.

**Sintaxis:**
```
/learn <tipo> "<descripción>"
```

Tipos: `correction | decision | idea | error | pattern`

**Comportamiento:**
1. Genera id: `<prefix>-YYYY-MM-DD-NNN` (ver "Schema" abajo)
2. Genera anchor: slug del primer fragmento de la descripción (sufijo `-N` si colisiona)
3. Append al archivo correcto con frontmatter `pending: true`
4. Update `index.md` con la nueva línea
5. Tags inferidos del contexto reciente (tools usados, archivos tocados — heurística simple grep en últimos N tool_uses)
6. Confirma al agente: `✓ captured <id>`

**Errores:**
- Tipo inválido → mensaje claro, no escribe nada
- Descripción vacía o `<5` chars → error
- Hash duplicado de entry abierta o aprobada en últimas 24h → skip silencioso (correction/decision/idea) o increment frecuencia (error/pattern)

### 2. Hook `learn-error.sh` (errores C en vivo)

PostToolUse hook filtrado a tool failures.

**Triggers:**
- Bash exit code ≠ 0
- MCP errors (response contiene "error" en JSON top-level)
- API timeouts patterns: `ETIMEDOUT`, `ECONNRESET`, `401 Unauthorized`, `429 Too Many Requests`, `gtimeout: failed`

**Lógica:**
1. Lee el último tool result (vía hook env)
2. Si pattern conocido (regex match) → entry directa con descripción mapeada
3. Si error nuevo (no match) → entry con descripción genérica + tool + cwd + primeras 200 chars del error
4. Hash(error_normalized + tool) → busca en errors.md:
   - Si existe entry abierta o aprobada con mismo hash → increment `frecuencia`, update `last_seen`
   - Si no existe → crear nueva con `frecuencia: 1`
5. Update index.md
6. Rate limit: máx 5 entries del mismo error_hash por día

**Filtrado:**
- Skip errores en hooks de learnings mismo (evita feedback loop)
- Skip errores tipo "user cancelled" / "permission denied by user"

### 3. Batch `extract-learnings.sh` (21:55, red de seguridad + patterns)

Cron via launchd `com.claude.extract-learnings` corre 21:55 diario.

**Pseudocódigo:**

```bash
#!/usr/bin/env bash
set -euo pipefail

CURSOR_FILE="$HOME/.claude/state/learnings-cursor"
LOG="$HOME/.claude/logs/learnings.log"
DRY_RUN=${DRY_RUN:-0}

# 1. Cargar cursor (timestamp Unix)
CURSOR=$(cat "$CURSOR_FILE" 2>/dev/null || echo "0")

# 2. Glob transcripts modificados después del cursor
TRANSCRIPTS=$(find "$HOME/.claude/projects" -name '*.jsonl' -newermt "@$CURSOR" 2>/dev/null)

if [[ -z "$TRANSCRIPTS" ]]; then
  echo "[$(date)] no transcripts to process" >> "$LOG"
  exit 0
fi

NEWEST_TS=$CURSOR

# 3. Para cada transcript, extraer interacciones nuevas
for f in $TRANSCRIPTS; do
  # Extraer mensajes después del cursor
  CHUNK=$(jq -c "select(.timestamp > $CURSOR) | {role, content}" "$f")
  [[ -z "$CHUNK" ]] && continue

  # Invocar claude -p con prompt fijo
  if (( DRY_RUN )); then
    echo "WOULD process: $f"
    continue
  fi

  # EXTRACT_PROMPT vive en archivo separado para versionar prompts sin tocar bash
  PROMPT_FILE="$HOME/.claude/hooks/extract-learnings-prompt.md"
  ENTRIES=$(echo "$CHUNK" | gtimeout 90s claude -p "$(cat "$PROMPT_FILE")" 2>>"$LOG" || echo "[]")

  # Para cada entry: dedup, append, update index
  echo "$ENTRIES" | jq -c '.[]' | while read entry; do
    process_entry "$entry"  # función que dedupea + escribe + updatea index
  done

  # Track newest timestamp procesado
  LAST_TS=$(jq -r 'select(.timestamp > '$CURSOR') | .timestamp' "$f" | sort -n | tail -1)
  [[ "$LAST_TS" > "$NEWEST_TS" ]] && NEWEST_TS=$LAST_TS
done

# 4. Detección de patterns B (cross-transcript del día)
detect_patterns_today  # función que escanea acciones repetidas

# 5. Update cursor
echo "$NEWEST_TS" > "$CURSOR_FILE"

echo "[$(date)] batch completed, cursor=$NEWEST_TS" >> "$LOG"
```

**EXTRACT_PROMPT** vive en `~/.claude/hooks/extract-learnings-prompt.md` (versionado en repo `hooks/extract-learnings-prompt.md`):

> Lee este transcript de una sesión de Claude Code. Identifica:
>
> - **correction**: momentos donde Cal te corrigió ("no así", "stop", "prefiero X") o validó un approach no obvio ("sí, exacto")
> - **decision**: decisiones técnicas no triviales que Cal aceptó sin pushback (típicamente "ok dale así" después de propuesta no obvia)
> - **idea**: ideas que Cal mencionó en pasada y no se implementaron en esta sesión
>
> Responde JSON puro:
>
> ```json
> [
>   {
>     "tipo": "correction|decision|idea",
>     "descripcion": "máx 80 chars, capturando la regla/decisión/idea",
>     "trigger": "el fragmento textual de Cal que originó esto",
>     "contexto": "qué se estaba haciendo en ese momento (1-2 frases)",
>     "tags": ["tag1", "tag2"]
>   }
> ]
> ```
>
> Si no hay nada extraíble, responde `[]`. NO captures correcciones triviales (typos, formato). NO captures decisiones obvias (default behavior).

**Detección de patterns B:**

Función `detect_patterns_today` lee:
- `~/.claude/projects/*/`*.jsonl del día (slash commands invocados)
- Cross-correlate con state file `~/.claude/state/learnings-pattern-counts.json`
- Si un slash command (o secuencia de tool calls similar) se repitió ≥3 veces en 7 días → genera entry tipo `pattern`

**Costo estimado:** ~10-15k tokens/día × $5/M = $1.5/mes

### 4. nightly-report.sh modificado (review UX 22:00)

**Cambio:** agregar sección al final del reporte que ya envías a Telegram.

**Lógica:**
1. Lee `~/.claude/learnings/cos/index.md`
2. Filtra líneas con `[pending]`
3. Agrupa por tipo (correction/error/decision/pattern/idea)
4. Si 0 pending → omite la sección, manda solo el reporte normal
5. Si ≥1 pending → agrega sección con botones inline

**Formato del Telegram:**

```
🌙 Reporte nocturno — 2026-04-19

[... resumen del día, plan mañana — sin cambios ...]

─────────────
📚 Learnings hoy (5 pendientes)

A. Correcciones (2):
1. CLAUDE.md debe quedarse lean
2. Diario mejor que semanal para review

C. Errores (1):
3. ⚠️ launchd PATH sin ~/.local/bin (frec: 3)

D. Decisiones (1):
4. Index local por dir, no super-index aún

E. Ideas (1):
5. Aplicar filesystem-RAG completo en futuro

[1✅] [1❌] [2✅] [2❌]
[3✅] [3❌] [4✅] [4❌]
[5✅] [5❌] [✅ Todo] [❌ Todo]
```

**Constraints:**
- MAX_KEYBOARD_ROWS = 4 → si hay >4 entries, chunkear el review en mensajes consecutivos (no editar el mismo mensaje)
- Cada botón callback: `learn:keep:<entry_id>` o `learn:drop:<entry_id>`
- Botones globales: `learn:keepall:<batch_id>` / `learn:dropall:<batch_id>` donde batch_id = hash de los IDs incluidos
- Frec ≥5 → entry marcada con ⚠️ (señala "alta frecuencia, considerar")

### 5. Callback handlers `learn:*`

Extender `telegram-plugin/callback-router.ts`:

```typescript
// callback-router.ts
case 'learn': {
  const action = parts[1]  // keep | drop | keepall | dropall
  const id = parts[2]
  return await handleLearnCallback(action, id)
}

async function handleLearnCallback(action, id) {
  const indexPath = `${HOME}/.claude/learnings/cos/index.md`
  const indexLine = await findEntryInIndex(id)
  if (!indexLine) return { text: "❌ entry no encontrada", buttons: null }

  const filePath = parseFilePathFromIndexLine(indexLine)

  switch (action) {
    case 'keep':
      await flipPending(filePath, id, { pending: false, valid: true })
      await removePendingFlagFromIndex(id)
      return { toast: "✓ kept" }

    case 'drop':
      await moveEntryToArchive(filePath, id)
      await removeEntryFromIndex(id)
      return { toast: "✓ dropped" }

    case 'keepall':
    case 'dropall':
      const ids = await getEntryIdsFromBatch(id)
      for (const eid of ids) {
        await handleLearnCallback(action.replace('all', ''), eid)
      }
      return { toast: `✓ ${action} ${ids.length} entries` }
  }
}
```

**Mecánico (no pasa por LLM)** — ~200ms.

### 6. `sync-learnings.sh` (domingo 21:00)

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
SOURCE="$HOME/.claude/learnings/cos"
DEST="$REPO/docs/learnings"

cd "$REPO"

# Verificar working tree limpio en docs/learnings/
if ! git diff --quiet docs/learnings/ 2>/dev/null; then
  curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=94137698" \
    --data-urlencode "text=⚠️ sync-learnings: docs/learnings/ tiene cambios sin commit. Resolver manual."
  exit 1
fi

mkdir -p "$DEST"
rsync -a --delete "$SOURCE/" "$DEST/"

if git diff --quiet docs/learnings/; then
  echo "no changes to sync"
  exit 0
fi

WEEK=$(date +%Y-W%V)
git add docs/learnings/
git commit -m "chore(learnings): sync $WEEK"
git push

# Notify
COUNT=$(grep -c "^- " "$DEST/index.md" || echo 0)
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=94137698" \
  --data-urlencode "text=📚 Learnings sync $WEEK: $COUNT entries totales"
```

Cron via launchd `com.claude.sync-learnings` — domingo 21:00.

## Schema de entries

### `index.md`

Una línea por entry:

```
- YYYY-MM-DD [tipo] [tags] Descripción ≤80 chars → archivo.md#anchor [pending]
```

- `[tipo]`: `correction | pattern | error | decision | idea`
- `[tags]`: csv en bracket, máx 3 tags
- `[pending]`: solo aparece si está esperando review
- `anchor`: slug del primer fragmento del título

Ejemplos:
```
- 2026-04-19 [correction] [claude-md, scope] CLAUDE.md debe quedarse lean → corrections.md#claude-md-lean [pending]
- 2026-04-19 [error] [launchd, claude-cli] PATH debe incluir ~/.local/bin → errors.md#launchd-path
- 2026-04-19 [decision] [heartbeat, anti-spam] State file JSON con key por check → decisions.md#heartbeat-state-json
```

### Archivos de detalle

Cada entry es un H2 + frontmatter HTML comment:

```markdown
## claude-md-lean
<!--
id: corr-2026-04-19-001
date: 2026-04-19
captured_by: /learn
session: 97db0c47
pending: true
valid: null
tags: [claude-md, scope]
-->

**Trigger:** Cal dijo "dejemos el claude lo más lean posible"

**Contexto:** Diseñando Fase 5.1, evaluábamos qué se promueve a CLAUDE.md vs queda en learnings/

**Regla:** CLAUDE.md mantiene solo instrucciones operativas y pointers. Conocimiento histórico vive en learnings/

**Aplica en:** Cada propuesta de update a CLAUDE.md — preguntar primero "¿esto puede vivir en learnings/?"
```

### Schema diferenciado por tipo

Mismos campos base + 1-2 específicos:

| Tipo | Campos extra |
|---|---|
| **correction** | `aplica_en` (contextos donde la regla aplica) |
| **decision** | `alternativas_descartadas` (qué se consideró y por qué no) |
| **error** | `frecuencia` (cuántas veces ocurrió), `last_seen`, `fix_aplicado` (si hay) |
| **pattern** | `ocurrencias` (lista timestamps), `candidate_skill` (sí/no + nombre) |
| **idea** | `impacto_estimado` (high/med/low), `relacionado_con` (entries linked) |

### `archive/YYYY-MM.md` (rechazadas)

Mismo formato + `valid: false` + `rejected_at: YYYY-MM-DD`. Header `## Rechazadas — abril 2026` al inicio. NO se borran (Cal puede recuperar; sirve como señal anti-recapture al batch).

### IDs

`<prefix>-YYYY-MM-DD-NNN`:
- `corr-2026-04-19-001`
- `err-2026-04-19-001`
- `dec-2026-04-19-002`
- `idea-2026-04-19-001`
- `pat-2026-04-19-001`

NNN incrementa por tipo+día.

### Deduplicación

1. Hash sha1(`tipo + descripcion_normalizada`) — normalizada = lowercase + sin tildes + sin puntuación
2. Buscar hash en `<!-- hashes: --> ` comment al final de cada archivo
3. Si match en entry abierta o aprobada:
   - Tipo error/pattern → increment `frecuencia`, update `last_seen`
   - Tipo correction/decision/idea → skip silencioso

## Edge cases

| Caso | Comportamiento |
|---|---|
| Batch corre y no hay transcripts nuevos | exit 0, log "no transcripts to process" |
| `claude -p` falla en batch | retry 1 vez. Si vuelve a fallar, log error y skip ese transcript. Cursor NO avanza para ese archivo |
| Cursor corrupto / no existe | tratar como `0`, procesar solo día actual (no días pasados — evita re-trabajo masivo) |
| Entry duplicada con hash match | error/pattern → increment frecuencia. correction/decision/idea → skip silencioso |
| Index.md corrupto / borrado | `rebuild-learnings-index.sh` regenera scaneando archivos |
| Callback Telegram falla (red, MCP caído) | botón sin respuesta. Entry sigue pending al siguiente nightly-report |
| Sync semanal: cambios locales sin commit en docs/learnings/ | abort + alerta Telegram. Cal resuelve manual |
| Entry con `frecuencia: 50` pero pending | nightly-report la marca con ⚠️ "alta frecuencia" |
| Hook genera muchos errores misma run | rate limit: máx 5 entries del mismo error_hash por día. Resto solo incrementa frecuencia |
| Cal corrige sobre algo ya rechazado en archive/ | batch detecta hash en archive → re-abre con `pending: true` + comment "previously rejected on YYYY-MM-DD" |

## Testing

| Componente | Test |
|---|---|
| Skill `/learn` | Invocar válido → archivo + index actualizado. Invocar 2x mismo → dedup. Tipo inválido → error claro |
| Hook `learn-error.sh` | Forzar `gtimeout: failed` → entry. Repetir → frecuencia=2. Comando exitoso → no entry |
| Batch `extract-learnings.sh` | `--dry-run` con cursor=hace 1h → muestra entries sin escribir. Run real → escribe esperadas. Re-run → cursor avanzó, no duplica |
| Nightly-report con sección Learnings | Mock 5 entries pending → formato Telegram correcto. Verificar chunking si >4 filas |
| Callbacks `learn:*` | Probar keep/drop en Telegram → archivo modificado. Probar keepall/dropall → bulk OK |
| Sync semanal | Forzar run → commit + push. Sin cambios → exit 0. Conflicto local → abort + alerta |

## Observabilidad

- **Logs:** `~/.claude/logs/learnings.log` (rotación 5MB)
- **State:** `~/.claude/state/learnings-cursor`, `~/.claude/state/learnings-stats.json`
- **Status script:** `~/.claude/hooks/learnings-status.sh` muestra:
  - Cursor actual (timestamp + fecha legible)
  - Entries pendientes por tipo
  - Último batch run (timestamp + status)
  - Últimos 5 entries (cualquier tipo)
  - Top 3 errores por frecuencia

## Rollout

1. Implementar componentes 1+2 (skill `/learn` + hook `learn-error.sh`) — captura empieza inmediato
2. Implementar componente 3 (batch) en `--dry-run` por 3 días para validar quality del extract
3. Activar batch real
4. Implementar componentes 4+5 (nightly-report con sección + callbacks `learn:*`)
5. Esperar 1 semana de uso real
6. Implementar componente 6 (sync semanal)
7. Ajustar EXTRACT_PROMPT si Cal nota ruido o señal escapada

## Entregables

- `~/.claude/commands/learn.md` (skill) + copia en `commands/` del repo
- `~/.claude/hooks/extract-learnings.sh` + `~/.claude/hooks/extract-learnings-prompt.md` + copias en `hooks/` del repo
- `~/.claude/hooks/learn-error.sh` + copia en `hooks/` del repo
- `~/.claude/hooks/rebuild-learnings-index.sh` + copia en `hooks/` del repo
- `~/.claude/hooks/learnings-status.sh` + copia en `hooks/` del repo
- Edit `~/.claude/hooks/nightly-report.sh` para agregar sección Learnings
- Edit `telegram-plugin/callback-router.ts` para handlers `learn:*` (+ deploy a plugin cache)
- `scripts/sync-learnings.sh` en repo
- `~/Library/LaunchAgents/com.claude.extract-learnings.plist` + copia en `launchd/` del repo
- `~/Library/LaunchAgents/com.claude.sync-learnings.plist` + copia en `launchd/` del repo
- Edit `CLAUDE.md` (CoS) — agregar 1 bullet de Learnings históricos
- Update `BACKLOG.md` (5.1 marcado done)
- Update `CHANGELOG.md` (entrada 2026-04-XX)

## No-goals (Fase 5.1)

- ❌ Generación automática de skills (eso es 5.3)
- ❌ Morning builds (eso es 5.2)
- ❌ Auto-promoción a CLAUDE.md
- ❌ Multi-agente (eso es 6.x)
- ❌ Filesystem-RAG super-index global (Fase futura)
- ❌ Búsqueda semántica con embeddings (innecesaria — grep + tags suficiente)
