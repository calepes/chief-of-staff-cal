# Self-improving Learnings — Implementation Plan (Fase 5.1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sistema de captura de aprendizajes (correcciones, errores, decisiones, ideas, patterns) con review diario vía Telegram, manteniendo CLAUDE.md lean y todo el conocimiento histórico en filesystem indexado.

**Architecture:** Library bash compartida + skill `/learn` para captura intencional + PostToolUse hook para errores + batch nocturno como red de seguridad + nightly-report extendido + callbacks Telegram mecánicos. Todos los entries empiezan `pending: true` y solo se activan tras review explícito de Cal.

**Tech Stack:** Bash 5.x (jq, find, grep, sha1sum), TypeScript (callback-router.ts plugin), launchd plists, Telegram Bot API, Claude CLI (claude -p).

**Spec:** `docs/superpowers/specs/2026-04-19-self-improving-learnings-design.md`

---

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `~/.claude/hooks/learnings-lib.sh` | Library compartida: `generate_id`, `slug`, `hash_normalize`, `append_entry`, `update_index`, `move_to_archive`, `find_entry_in_index`, `flip_pending` |
| `~/.claude/commands/learn.md` | Skill `/learn <tipo> "<descripción>"` — prompt para agente |
| `~/.claude/hooks/learn-error.sh` | PostToolUse hook — captura errores C automáticos |
| `~/.claude/hooks/extract-learnings.sh` | Batch nocturno 21:55 — red de seguridad + patterns B |
| `~/.claude/hooks/extract-learnings-prompt.md` | Prompt fijo para `claude -p` (versionado aparte para iteración) |
| `~/.claude/hooks/nightly-report.sh` | MODIFICADO — agrega sección Learnings con botones |
| `~/.claude/hooks/rebuild-learnings-index.sh` | Recovery: regenera index desde archivos |
| `~/.claude/hooks/learnings-status.sh` | Observabilidad: cursor, pendientes, último run |
| `telegram-plugin/callback-router.ts` | MODIFICADO — handlers `learn:keep|drop|keepall|dropall` |
| `scripts/sync-learnings.sh` | Cron domingo 21:00 — copia a repo + commit + push |
| `~/Library/LaunchAgents/com.claude.extract-learnings.plist` | Cron 21:55 daily |
| `~/Library/LaunchAgents/com.claude.sync-learnings.plist` | Cron domingo 21:00 |
| `CLAUDE.md` (CoS) | MODIFICADO — agrega 1 bullet |

**Convención del repo:** todo lo que vive en `~/.claude/` se duplica en `hooks/`, `commands/`, `launchd/` del repo CoS. Los `cp` los hace cada task explícitamente.

---

### Task 1: Scaffolding + library bash compartida

**Files:**
- Create: `~/.claude/hooks/learnings-lib.sh` + copia en `hooks/learnings-lib.sh`
- Create: `~/.claude/learnings/cos/index.md`
- Create: `~/.claude/learnings/cos/corrections.md`
- Create: `~/.claude/learnings/cos/patterns.md`
- Create: `~/.claude/learnings/cos/errors.md`
- Create: `~/.claude/learnings/cos/decisions.md`
- Create: `~/.claude/learnings/cos/feature_requests.md`
- Create: `~/.claude/learnings/cos/archive/.gitkeep`
- Create: `~/.claude/state/learnings-cursor` (con `0` inicial)

- [ ] **Step 1: Crear estructura de directorios**

```bash
mkdir -p ~/.claude/learnings/cos/archive
mkdir -p ~/.claude/state
touch ~/.claude/learnings/cos/archive/.gitkeep
echo "0" > ~/.claude/state/learnings-cursor
```

- [ ] **Step 2: Crear `index.md` inicial vacío**

Contenido:

```markdown
# Index — Learnings CoS

Mapa central de aprendizajes capturados del CoS. Una línea por entry.

Formato: `- YYYY-MM-DD [tipo] [tags] Descripción → archivo.md#anchor [pending]`

Tipos: `correction | pattern | error | decision | idea`

---

<!-- entries: -->
```

```bash
cat > ~/.claude/learnings/cos/index.md << 'EOF'
# Index — Learnings CoS

Mapa central de aprendizajes capturados del CoS. Una línea por entry.

Formato: `- YYYY-MM-DD [tipo] [tags] Descripción → archivo.md#anchor [pending]`

Tipos: `correction | pattern | error | decision | idea`

---

<!-- entries: -->
EOF
```

- [ ] **Step 3: Crear archivos de detalle vacíos con header**

```bash
for file in corrections patterns errors decisions feature_requests; do
  cat > ~/.claude/learnings/cos/$file.md << EOF
# $(echo "$file" | tr '[:lower:]' '[:upper:]')

Entries del tipo \`$file\`. Ver \`index.md\` para mapa central.

---

<!-- hashes: -->
EOF
done
```

- [ ] **Step 4: Implementar library `learnings-lib.sh`**

```bash
cat > ~/.claude/hooks/learnings-lib.sh << 'EOF'
#!/usr/bin/env bash
# learnings-lib.sh — funciones compartidas para captura/manipulación de entries

LEARNINGS_DIR="${LEARNINGS_DIR:-$HOME/.claude/learnings/cos}"

# generate_id <tipo> → echo "<prefix>-YYYY-MM-DD-NNN"
generate_id() {
  local tipo="$1"
  local prefix
  case "$tipo" in
    correction) prefix="corr" ;;
    decision) prefix="dec" ;;
    error) prefix="err" ;;
    pattern) prefix="pat" ;;
    idea) prefix="idea" ;;
    *) echo "ERROR: tipo invalido: $tipo" >&2; return 1 ;;
  esac
  local date=$(date +%Y-%m-%d)
  local file="$LEARNINGS_DIR/$(tipo_to_filename "$tipo")"
  local last_n=$(grep -oE "id: ${prefix}-${date}-[0-9]+" "$file" 2>/dev/null \
    | grep -oE '[0-9]+$' | sort -n | tail -1)
  local n=$((${last_n:-0} + 1))
  printf "${prefix}-${date}-%03d\n" "$n"
}

# tipo_to_filename <tipo> → echo nombre archivo
tipo_to_filename() {
  case "$1" in
    correction) echo "corrections.md" ;;
    decision) echo "decisions.md" ;;
    error) echo "errors.md" ;;
    pattern) echo "patterns.md" ;;
    idea) echo "feature_requests.md" ;;
  esac
}

# slug <texto> → slug ascii lowercase con guiones, máx 40 chars
slug() {
  echo "$1" \
    | iconv -t ascii//TRANSLIT 2>/dev/null \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g' \
    | cut -c1-40
}

# hash_normalize <tipo> <descripcion> → echo sha1
hash_normalize() {
  local tipo="$1"
  local desc=$(echo "$2" | iconv -t ascii//TRANSLIT 2>/dev/null \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/ /g; s/^ +| +$//g')
  echo -n "${tipo}:${desc}" | shasum -a 1 | awk '{print $1}'
}

# is_duplicate <tipo> <descripcion> → exit 0 si existe entry abierta o aprobada
is_duplicate() {
  local hash=$(hash_normalize "$1" "$2")
  local file="$LEARNINGS_DIR/$(tipo_to_filename "$1")"
  grep -q "hash: $hash" "$file" 2>/dev/null
}

# append_entry <tipo> <descripcion> <trigger> <contexto> <captured_by> [tags_csv]
# Escribe entry al archivo correspondiente. Devuelve el id.
append_entry() {
  local tipo="$1"
  local desc="$2"
  local trigger="$3"
  local contexto="$4"
  local captured_by="$5"
  local tags="${6:-}"

  local id=$(generate_id "$tipo")
  local anchor=$(slug "$desc")
  local hash=$(hash_normalize "$tipo" "$desc")
  local date=$(date +%Y-%m-%d)
  local file="$LEARNINGS_DIR/$(tipo_to_filename "$tipo")"
  local session=$(basename "${CLAUDE_SESSION_ID:-unknown}" | cut -c1-8)

  # Ensure unique anchor
  local n=2
  local final_anchor="$anchor"
  while grep -q "^## ${final_anchor}$" "$file" 2>/dev/null; do
    final_anchor="${anchor}-${n}"
    n=$((n + 1))
  done

  # Append entry
  cat >> "$file" << ENTRY

## ${final_anchor}
<!--
id: ${id}
date: ${date}
captured_by: ${captured_by}
session: ${session}
pending: true
valid: null
hash: ${hash}
tags: [${tags}]
-->

**Trigger:** ${trigger}

**Contexto:** ${contexto}

**Regla:** ${desc}
ENTRY

  # Update hash list at end of file
  if grep -q "<!-- hashes: -->" "$file"; then
    sed -i '' "s|<!-- hashes: -->|<!-- hashes: -->\n<!-- $hash -->|" "$file"
  fi

  # Update index
  update_index "$id" "$tipo" "$tags" "$desc" "$(tipo_to_filename "$tipo")" "$final_anchor"

  echo "$id"
}

# update_index <id> <tipo> <tags> <desc> <filename> <anchor>
update_index() {
  local id="$1"
  local tipo="$2"
  local tags="$3"
  local desc="$4"
  local filename="$5"
  local anchor="$6"
  local date=$(date +%Y-%m-%d)
  local index="$LEARNINGS_DIR/index.md"

  # Truncate description to 80 chars
  local short_desc=$(echo "$desc" | cut -c1-80)
  local tags_display=""
  [[ -n "$tags" ]] && tags_display="[${tags}] "

  local line="- ${date} [${tipo}] ${tags_display}${short_desc} → ${filename}#${anchor} [pending] <!-- ${id} -->"

  # Append after "<!-- entries: -->" marker
  if grep -q "<!-- entries: -->" "$index"; then
    sed -i '' "s|<!-- entries: -->|<!-- entries: -->\n${line}|" "$index"
  else
    echo "$line" >> "$index"
  fi
}

# find_entry_in_index <id> → echo línea completa, exit 1 si no existe
find_entry_in_index() {
  grep "<!-- $1 -->" "$LEARNINGS_DIR/index.md"
}

# flip_pending <id> <valid_value>  (true=keep, false=drop)
flip_pending() {
  local id="$1"
  local valid="$2"
  local line
  line=$(find_entry_in_index "$id") || return 1

  # Extract filename from line: `→ filename.md#anchor [pending]`
  local filename=$(echo "$line" | grep -oE '→ [^#]+\.md' | sed 's|→ ||;s| ||g')
  local file="$LEARNINGS_DIR/$filename"
  local anchor=$(echo "$line" | grep -oE '#[^ ]+' | tr -d '#')

  # Update entry frontmatter: pending: true → false, valid: null → ${valid}
  awk -v anchor="$anchor" -v valid="$valid" '
    /^## /{ in_target = ($0 == "## " anchor) }
    in_target && /^pending: true$/ { print "pending: false"; next }
    in_target && /^valid: null$/ { print "valid: " valid; next }
    { print }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"

  # Remove [pending] from index line
  sed -i '' "s| \[pending\] \(<!-- $id -->\)| \1|" "$LEARNINGS_DIR/index.md"
}

# move_to_archive <id>
move_to_archive() {
  local id="$1"
  local line
  line=$(find_entry_in_index "$id") || return 1

  local filename=$(echo "$line" | grep -oE '→ [^#]+\.md' | sed 's|→ ||;s| ||g')
  local file="$LEARNINGS_DIR/$filename"
  local anchor=$(echo "$line" | grep -oE '#[^ ]+' | tr -d '#')
  local month=$(date +%Y-%m)
  local archive="$LEARNINGS_DIR/archive/${month}.md"

  # Init archive file if missing
  if [[ ! -f "$archive" ]]; then
    cat > "$archive" << ARC
# Rechazadas — ${month}

Entries que Cal descartó en review. NO se borran (pueden recuperarse o servir como señal anti-recapture).

---
ARC
  fi

  # Extract entry block from source file (## anchor + frontmatter + body until next ## or EOF)
  awk -v anchor="$anchor" '
    /^## / { in_target = ($0 == "## " anchor); if (in_target) { found = 1 } else if (found) { exit } }
    in_target { print }
  ' "$file" > /tmp/learning_block.md

  # Add rejected_at marker to the block, append to archive
  sed "s|^pending: true$|pending: false|; s|^valid: null$|valid: false\nrejected_at: $(date +%Y-%m-%d)|" /tmp/learning_block.md >> "$archive"

  # Remove entry from source file
  awk -v anchor="$anchor" '
    /^## / { in_target = ($0 == "## " anchor); if (in_target) { skip = 1; next } else if (skip) { skip = 0 } }
    !skip { print }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"

  # Remove from index
  sed -i '' "/<!-- $id -->/d" "$LEARNINGS_DIR/index.md"
}
EOF

chmod +x ~/.claude/hooks/learnings-lib.sh
```

- [ ] **Step 5: Smoke test de library**

```bash
source ~/.claude/hooks/learnings-lib.sh

# Test slug
test_slug=$(slug "CLAUDE.md debe quedarse lean")
echo "slug: $test_slug"
[[ "$test_slug" == "claude-md-debe-quedarse-lean" ]] && echo "✓ slug" || echo "✗ slug"

# Test generate_id
test_id=$(generate_id correction)
echo "id: $test_id"
[[ "$test_id" =~ ^corr-[0-9]{4}-[0-9]{2}-[0-9]{2}-001$ ]] && echo "✓ id" || echo "✗ id"

# Test hash_normalize (idempotente con mismas variantes)
h1=$(hash_normalize correction "CLAUDE.md debe quedarse lean")
h2=$(hash_normalize correction "claude.md  debe   quedarse LEAN")
[[ "$h1" == "$h2" ]] && echo "✓ hash idempotente" || echo "✗ hash"

# Test append + dedup
id1=$(append_entry correction "test desc unique 1" "trigger 1" "contexto 1" "test" "test,smoke")
echo "appended: $id1"
grep -q "$id1" ~/.claude/learnings/cos/index.md && echo "✓ index updated" || echo "✗ index"
grep -q "$id1" ~/.claude/learnings/cos/corrections.md && echo "✓ archivo updated" || echo "✗ archivo"

# Append duplicate → debe detectarlo
is_duplicate correction "test desc unique 1" && echo "✓ dedup detectado" || echo "✗ dedup falló"
```

Expected: todos los `✓`. Si algún `✗`, debug antes de continuar.

- [ ] **Step 6: Limpiar datos de smoke test**

```bash
# Reset archivos a estado inicial
rm -f ~/.claude/learnings/cos/{corrections,patterns,errors,decisions,feature_requests}.md
for file in corrections patterns errors decisions feature_requests; do
  cat > ~/.claude/learnings/cos/$file.md << EOF
# $(echo "$file" | tr '[:lower:]' '[:upper:]')

Entries del tipo \`$file\`. Ver \`index.md\` para mapa central.

---

<!-- hashes: -->
EOF
done

# Reset index
cat > ~/.claude/learnings/cos/index.md << 'EOF'
# Index — Learnings CoS

Mapa central de aprendizajes capturados del CoS. Una línea por entry.

Formato: `- YYYY-MM-DD [tipo] [tags] Descripción → archivo.md#anchor [pending]`

Tipos: `correction | pattern | error | decision | idea`

---

<!-- entries: -->
EOF
```

- [ ] **Step 7: Copiar al repo y commit**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
mkdir -p hooks
cp ~/.claude/hooks/learnings-lib.sh hooks/learnings-lib.sh

git add hooks/learnings-lib.sh
git commit -m "feat(learnings): library bash compartida + scaffolding"
```

---

### Task 2: Skill `/learn` (captura intencional)

**Files:**
- Create: `~/.claude/commands/learn.md` + copia en `commands/learn.md`

- [ ] **Step 1: Escribir el skill markdown**

```bash
mkdir -p ~/.claude/commands
cat > ~/.claude/commands/learn.md << 'EOF'
Captura un learning del CoS al filesystem indexado en `~/.claude/learnings/cos/`.

Sintaxis: `/learn <tipo> "<descripción>"`

Tipos válidos: `correction | decision | idea | error | pattern`

Procesamiento:

1. Parsea `tipo` y `descripción` del input. Si tipo inválido o descripción <5 chars → error claro y para.
2. Determina el `trigger` (qué dijo Cal o qué tool gatilló esto) y el `contexto` (qué se estaba haciendo) del histórico reciente de la conversación.
3. Infiere 1-3 tags relevantes del contexto (tools usados, dominios: telegram, notion, heartbeat, claude-md, spotify, health, etc.).
4. Source la library y usa `append_entry`:
   ```bash
   source ~/.claude/hooks/learnings-lib.sh

   # Verificar dedup primero
   if is_duplicate "<tipo>" "<descripción>"; then
     echo "ℹ️ entry similar ya existe, skip"
     exit 0
   fi

   id=$(append_entry "<tipo>" "<descripción>" "<trigger>" "<contexto>" "/learn" "<tags_csv>")
   echo "✓ captured $id"
   ```
5. Confirma al usuario con el ID generado y la línea agregada al index.

Reglas importantes:

- NO captures correcciones triviales (typos, formato visual, ortografía)
- NO captures decisiones obvias o defaults del sistema
- Si `tipo=error` y la descripción menciona un comando que falló, incluye el exit code y stderr en `trigger`
- Si `tipo=pattern` y se invoca explícitamente, esto es excepcional (el batch nocturno detecta patterns) — confirmar que vale la pena antes de proceder
EOF
```

- [ ] **Step 2: Smoke test manual**

Invocar el skill desde Claude Code:

```
/learn correction "test smoke skill"
```

Verificar:

```bash
grep "test smoke skill" ~/.claude/learnings/cos/corrections.md
grep "test smoke skill" ~/.claude/learnings/cos/index.md
```

Expected: ambas líneas devuelven match.

- [ ] **Step 3: Probar dedup**

Invocar 2x el mismo:

```
/learn correction "test smoke skill"
```

Expected: segundo intento devuelve "entry similar ya existe, skip" sin escribir.

- [ ] **Step 4: Probar tipo inválido**

```
/learn invalido "test"
```

Expected: error claro, no escribe nada.

- [ ] **Step 5: Limpiar test data**

```bash
source ~/.claude/hooks/learnings-lib.sh
# Buscar el id del test
TEST_ID=$(grep "test smoke skill" ~/.claude/learnings/cos/index.md | grep -oE 'corr-[0-9]+-[0-9]+-[0-9]+-[0-9]+')
move_to_archive "$TEST_ID"
# Verificar
grep -q "test smoke skill" ~/.claude/learnings/cos/corrections.md && echo "✗ no se removió" || echo "✓ removido"
# Limpiar archive del test
rm -f ~/.claude/learnings/cos/archive/$(date +%Y-%m).md
```

- [ ] **Step 6: Copiar al repo y commit**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
cp ~/.claude/commands/learn.md commands/learn.md

git add commands/learn.md
git commit -m "feat(learnings): skill /learn para captura intencional"
```

---

### Task 3: Hook `learn-error.sh` (PostToolUse)

**Files:**
- Create: `~/.claude/hooks/learn-error.sh` + copia en `hooks/learn-error.sh`
- Modify: `~/.claude/settings.json` (registrar hook)

- [ ] **Step 1: Escribir el hook**

```bash
cat > ~/.claude/hooks/learn-error.sh << 'EOF'
#!/usr/bin/env bash
# learn-error.sh — PostToolUse hook que captura errores como entries
# Recibe via stdin un JSON con {tool_name, tool_input, tool_response, exit_code}
set -euo pipefail

source "$HOME/.claude/hooks/learnings-lib.sh"

LOG="$HOME/.claude/logs/learnings.log"
RATE_LIMIT_FILE="$HOME/.claude/state/learn-error-rate.json"
mkdir -p "$(dirname "$LOG")" "$(dirname "$RATE_LIMIT_FILE")"

# Skip si el tool es del propio sistema de learnings (evita feedback loop)
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""')
case "$TOOL" in
  *learnings*|*learn-error*|*learn*) exit 0 ;;
esac

# Detectar si hubo error
EXIT_CODE=$(echo "$INPUT" | jq -r '.exit_code // 0')
RESPONSE=$(echo "$INPUT" | jq -r '.tool_response // ""')

# Patterns conocidos (regex → descripción canónica)
declare -A PATTERNS=(
  ["gtimeout: failed to run command"]="gtimeout no encuentra el binario (revisar PATH del launchd)"
  ["ETIMEDOUT"]="timeout de red en API call"
  ["ECONNRESET"]="conexión reseteada por el peer"
  ["401 Unauthorized"]="auth fallida (token expirado o inválido)"
  ["429 Too Many Requests"]="rate limit excedido"
  ["5[0-9][0-9] Internal Server Error"]="server error 5xx en upstream"
  ["No such file or directory"]="archivo o directorio inexistente"
)

# Skip si no hay error claro
if [[ "$EXIT_CODE" == "0" ]] && ! echo "$RESPONSE" | grep -qE "(error|Error|ERROR|fail|FAIL)"; then
  exit 0
fi

# Skip cancelaciones de usuario
if echo "$RESPONSE" | grep -qE "(user cancelled|permission denied by user|operation cancelled)"; then
  exit 0
fi

# Match contra patterns conocidos
DESC=""
for pat in "${!PATTERNS[@]}"; do
  if echo "$RESPONSE" | grep -qE "$pat"; then
    DESC="${PATTERNS[$pat]}"
    break
  fi
done

# Fallback si no match: error genérico con primeras 200 chars
if [[ -z "$DESC" ]]; then
  SHORT=$(echo "$RESPONSE" | head -c 200 | tr '\n' ' ')
  DESC="error en tool ${TOOL}: ${SHORT}"
fi

# Rate limit: máx 5 entries del mismo error_hash por día
HASH=$(hash_normalize error "$DESC")
TODAY=$(date +%Y-%m-%d)
COUNT=$(jq -r --arg h "$HASH" --arg d "$TODAY" '.[$d][$h] // 0' "$RATE_LIMIT_FILE" 2>/dev/null || echo 0)
if (( COUNT >= 5 )); then
  echo "[$(date)] rate limit hit for hash $HASH" >> "$LOG"
  exit 0
fi

# Increment counter
mkdir -p "$(dirname "$RATE_LIMIT_FILE")"
[[ ! -f "$RATE_LIMIT_FILE" ]] && echo '{}' > "$RATE_LIMIT_FILE"
TMP=$(mktemp)
jq --arg h "$HASH" --arg d "$TODAY" \
  '.[$d][$h] = ((.[$d][$h] // 0) + 1)' \
  "$RATE_LIMIT_FILE" > "$TMP" && mv "$TMP" "$RATE_LIMIT_FILE"

# Si ya existe entry abierta o aprobada con mismo hash → solo incrementar frecuencia
if is_duplicate error "$DESC"; then
  # Find entry, increment frecuencia field in errors.md
  awk -v hash="$HASH" -v today="$TODAY" '
    /^## / { in_section = 0 }
    /^hash: / && $2 == hash { in_section = 1 }
    in_section && /^frecuencia: / { sub(/[0-9]+/, $2 + 1); in_section_freq_done = 1 }
    in_section && /^last_seen: / { sub(/[0-9-]+/, today); in_section_seen_done = 1 }
    in_section && /^-->$/ {
      if (!in_section_freq_done) print "frecuencia: 2"
      if (!in_section_seen_done) print "last_seen: " today
      in_section = 0
    }
    { print }
  ' ~/.claude/learnings/cos/errors.md > /tmp/errors.md.tmp && mv /tmp/errors.md.tmp ~/.claude/learnings/cos/errors.md
  echo "[$(date)] incremented frecuencia for hash $HASH" >> "$LOG"
  exit 0
fi

# Crear nueva entry
TRIGGER="tool: $TOOL, exit: $EXIT_CODE"
CONTEXT="cwd: $(pwd), session: ${CLAUDE_SESSION_ID:-unknown}"
TAGS="$TOOL"

ID=$(append_entry error "$DESC" "$TRIGGER" "$CONTEXT" "hook:learn-error" "$TAGS")

# Agregar campos extra del tipo error
awk -v id="$ID" '
  /^id: / && $2 == id { in_section = 1 }
  in_section && /^-->$/ {
    print "frecuencia: 1"
    print "last_seen: '"$TODAY"'"
    print "fix_aplicado: null"
    in_section = 0
  }
  { print }
' ~/.claude/learnings/cos/errors.md > /tmp/errors.md.tmp && mv /tmp/errors.md.tmp ~/.claude/learnings/cos/errors.md

echo "[$(date)] new entry $ID for hash $HASH" >> "$LOG"
EOF

chmod +x ~/.claude/hooks/learn-error.sh
```

- [ ] **Step 2: Registrar hook en settings.json**

Leer el settings.json actual:

```bash
cat ~/.claude/settings.json
```

Agregar bajo `"hooks"` (si no existe la key, créarla):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/learn-error.sh"
          }
        ]
      }
    ]
  }
}
```

Si ya existe un PostToolUse para Bash con otros handlers, agregar este como hook adicional en el array.

- [ ] **Step 3: Smoke test forzando error**

```bash
# Forzar un error reconocible
gtimeout 1 sleep 5 || true  # exit code != 0 timeout
ls /nonexistent/path 2>&1 || true  # No such file
```

Verificar entry generada:

```bash
grep -A 5 "No such file" ~/.claude/learnings/cos/errors.md
grep "error.*\[hook" ~/.claude/learnings/cos/index.md
```

Expected: entry con `frecuencia: 1`, `captured_by: hook:learn-error`.

- [ ] **Step 4: Probar increment de frecuencia**

```bash
ls /nonexistent/path 2>&1 || true  # mismo error 2da vez
ls /nonexistent/path 2>&1 || true  # 3ra vez
```

Verificar:

```bash
grep -A 10 "No such file" ~/.claude/learnings/cos/errors.md | grep "frecuencia"
```

Expected: `frecuencia: 3`.

- [ ] **Step 5: Probar rate limit**

Ejecutar el mismo error 6 veces consecutivas. Verificar que la 6ta no incrementa más allá de 5:

```bash
for i in 1 2 3 4 5 6 7; do ls /nonexistent/path 2>&1 || true; done
grep "rate limit" ~/.claude/logs/learnings.log
```

Expected: aparece "rate limit hit" en el log.

- [ ] **Step 6: Limpiar test data**

```bash
source ~/.claude/hooks/learnings-lib.sh
# Buscar y archivar la entry de test
TEST_ID=$(grep "No such file" ~/.claude/learnings/cos/index.md | grep -oE 'err-[0-9]+-[0-9]+-[0-9]+-[0-9]+' | head -1)
[[ -n "$TEST_ID" ]] && move_to_archive "$TEST_ID"
rm -f ~/.claude/learnings/cos/archive/$(date +%Y-%m).md
echo '{}' > ~/.claude/state/learn-error-rate.json
```

- [ ] **Step 7: Copiar al repo y commit**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
cp ~/.claude/hooks/learn-error.sh hooks/learn-error.sh
# Settings.json se versiona aparte si Cal lo decide; por ahora skip

git add hooks/learn-error.sh
git commit -m "feat(learnings): PostToolUse hook learn-error.sh para errores C"
```

---

### Task 4: Prompt fijo del batch (`extract-learnings-prompt.md`)

**Files:**
- Create: `~/.claude/hooks/extract-learnings-prompt.md` + copia en `hooks/extract-learnings-prompt.md`

- [ ] **Step 1: Escribir el prompt**

```bash
cat > ~/.claude/hooks/extract-learnings-prompt.md << 'EOF'
Lee el siguiente transcript de una sesión de Claude Code (formato JSONL: cada línea es un mensaje con `role` y `content`).

Tu tarea: identificar **learnings reales** en esta conversación. Tipos:

- **correction**: Cal corrigió al agente ("no así", "stop", "prefiero X") O validó un approach NO obvio sin pushback ("sí, exacto", "perfecto"). Captura solo cuando la regla puede aplicar a futuras sesiones.
- **decision**: decisión técnica NO trivial que Cal aceptó. Ejemplo: elegir batch nocturno sobre SessionEnd hook, optar por filesystem-RAG en vez de embedding store. NO captures defaults o decisiones obvias.
- **idea**: Cal mencionó una idea en pasada que NO se implementó en esta sesión, pero podría ser interesante después. Ejemplos: "algún día estaría bueno X", "sería útil Y eventualmente".

NO captures:
- Correcciones triviales (typos, formato visual)
- Confirmaciones simples ("ok", "dale", "sigue") sin contexto sustantivo
- Defaults del sistema o decisiones obvias
- Tareas operativas que se completaron en la sesión (eso va a CHANGELOG/git log, no a learnings)

Formato de respuesta — JSON puro, sin markdown, sin texto extra:

```json
[
  {
    "tipo": "correction|decision|idea",
    "descripcion": "máx 80 chars, capturando la regla/decisión/idea en imperativo o declarativo",
    "trigger": "fragmento textual de Cal o del agente que originó esto (≤200 chars)",
    "contexto": "qué se estaba haciendo en ese momento (1-2 frases, ≤200 chars)",
    "tags": ["tag1", "tag2"]
  }
]
```

Tags válidos (elige hasta 3 por entry): telegram, notion, heartbeat, spotify, health, claude-md, scope, ux, oauth, launchd, hooks, skills, batch, extract, archive, callback, callbacks, learnings, plugin, server, worker, mcp, knowledge, docs, sync.

Si no hay nada extraíble en este transcript, responde `[]`.

NO incluyas markdown fences, NO incluyas explicaciones — solo el JSON puro.
EOF
```

- [ ] **Step 2: Validar formato del prompt**

```bash
# Verificar que es markdown válido (sin syntax errors visibles)
wc -l ~/.claude/hooks/extract-learnings-prompt.md
head -5 ~/.claude/hooks/extract-learnings-prompt.md
```

Expected: ~30-40 líneas, primera línea es "Lee el siguiente transcript...".

- [ ] **Step 3: Copiar al repo y commit**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
cp ~/.claude/hooks/extract-learnings-prompt.md hooks/extract-learnings-prompt.md

git add hooks/extract-learnings-prompt.md
git commit -m "feat(learnings): prompt para batch nocturno extract-learnings"
```

---

### Task 5: Batch `extract-learnings.sh`

**Files:**
- Create: `~/.claude/hooks/extract-learnings.sh` + copia en `hooks/extract-learnings.sh`

- [ ] **Step 1: Escribir el script**

```bash
cat > ~/.claude/hooks/extract-learnings.sh << 'EOF'
#!/usr/bin/env bash
# extract-learnings.sh — batch nocturno (21:55) que extrae learnings de transcripts del día
set -euo pipefail

source "$HOME/.claude/hooks/learnings-lib.sh"

CURSOR_FILE="$HOME/.claude/state/learnings-cursor"
LOG="$HOME/.claude/logs/learnings.log"
PROMPT_FILE="$HOME/.claude/hooks/extract-learnings-prompt.md"
mkdir -p "$(dirname "$LOG")"

DRY_RUN="${DRY_RUN:-0}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

# Cargar cursor (timestamp Unix)
CURSOR=$(cat "$CURSOR_FILE" 2>/dev/null || echo "0")
log "batch start, cursor=$CURSOR"

# Glob transcripts modificados después del cursor
# .jsonl files en cualquier subdirectorio de ~/.claude/projects
TRANSCRIPTS=$(find "$HOME/.claude/projects" -name '*.jsonl' -newermt "@$CURSOR" 2>/dev/null || true)

if [[ -z "$TRANSCRIPTS" ]]; then
  log "no transcripts to process"
  exit 0
fi

NEWEST_TS="$CURSOR"
TOTAL_ENTRIES=0

# Función auxiliar: process_entry desde JSON
process_entry() {
  local entry_json="$1"
  local tipo=$(echo "$entry_json" | jq -r '.tipo')
  local desc=$(echo "$entry_json" | jq -r '.descripcion')
  local trigger=$(echo "$entry_json" | jq -r '.trigger')
  local contexto=$(echo "$entry_json" | jq -r '.contexto')
  local tags=$(echo "$entry_json" | jq -r '.tags | join(",")')

  # Validate
  [[ -z "$tipo" || -z "$desc" || "${#desc}" -lt 5 ]] && return

  # Dedup
  if is_duplicate "$tipo" "$desc"; then
    log "skip duplicate: $desc"
    return
  fi

  if (( DRY_RUN )); then
    log "DRY_RUN would append: [$tipo] $desc"
    echo "[$tipo] $desc"
    return
  fi

  local id=$(append_entry "$tipo" "$desc" "$trigger" "$contexto" "batch" "$tags")
  log "appended $id: $desc"
  TOTAL_ENTRIES=$((TOTAL_ENTRIES + 1))
}

for f in $TRANSCRIPTS; do
  log "processing $f"

  # Extraer mensajes de Cal y respuestas relevantes después del cursor
  # Limitamos a últimas 100 interacciones para no abrumar el prompt
  CHUNK=$(jq -c --argjson cursor "$CURSOR" '
    select(.timestamp != null)
    | select(.timestamp > $cursor)
    | select(.message.role == "user" or .message.role == "assistant")
    | {
        role: .message.role,
        content: (.message.content | if type == "string" then . else (map(select(.type == "text") | .text) | join("\n")) end)
      }
    | select(.content != "" and .content != null)
  ' "$f" 2>/dev/null | tail -100 || true)

  if [[ -z "$CHUNK" ]]; then
    continue
  fi

  # Build prompt: PROMPT_FILE content + transcript chunk
  FULL_INPUT=$(printf '%s\n\n---\n\n%s' "$(cat "$PROMPT_FILE")" "$CHUNK")

  # Invocar claude -p con timeout 90s
  RAW_OUTPUT=$(echo "$FULL_INPUT" | gtimeout 90s claude -p 2>>"$LOG" || echo "")

  # Si vacío o falla, retry 1 vez
  if [[ -z "$RAW_OUTPUT" ]]; then
    log "retry for $f"
    sleep 5
    RAW_OUTPUT=$(echo "$FULL_INPUT" | gtimeout 90s claude -p 2>>"$LOG" || echo "")
    if [[ -z "$RAW_OUTPUT" ]]; then
      log "skip $f after retry"
      continue
    fi
  fi

  # Parsear JSON. Si no es JSON válido, skip.
  if ! ENTRIES=$(echo "$RAW_OUTPUT" | jq -c '.[]' 2>/dev/null); then
    log "invalid JSON from claude -p for $f"
    continue
  fi

  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    process_entry "$entry"
  done <<< "$ENTRIES"

  # Track newest timestamp procesado
  LAST_TS=$(jq -r 'select(.timestamp != null and .timestamp > '$CURSOR') | .timestamp' "$f" 2>/dev/null | sort -n | tail -1)
  [[ -n "$LAST_TS" && "$LAST_TS" > "$NEWEST_TS" ]] && NEWEST_TS="$LAST_TS"
done

# Update cursor (solo si no es dry-run)
if (( ! DRY_RUN )); then
  echo "$NEWEST_TS" > "$CURSOR_FILE"
  log "cursor advanced to $NEWEST_TS"
fi

log "batch complete: $TOTAL_ENTRIES new entries"
EOF

chmod +x ~/.claude/hooks/extract-learnings.sh
```

- [ ] **Step 2: Smoke test con `--dry-run`**

```bash
DRY_RUN=1 ~/.claude/hooks/extract-learnings.sh
```

Expected: log muestra `batch start`, lista transcripts encontrados, y `DRY_RUN would append: [tipo] desc` por cada entry candidata. NO escribe a archivos. Cursor NO avanza.

Verificar:

```bash
tail -20 ~/.claude/logs/learnings.log
cat ~/.claude/state/learnings-cursor  # debe seguir en 0 (o lo que estaba)
```

- [ ] **Step 3: Verificar quality del extract**

Inspeccionar visualmente las entries propuestas en el log. Criterios:

- ¿Capturó correcciones reales o ruido?
- ¿Las descripciones son ≤80 chars y capturan la regla?
- ¿Los tags son del set válido?

Si quality es mala (mucho ruido o señal escapada), iterar el `extract-learnings-prompt.md` ANTES de continuar.

- [ ] **Step 4: Run real (sin dry-run, una vez validado)**

```bash
~/.claude/hooks/extract-learnings.sh
```

Verificar:

```bash
cat ~/.claude/state/learnings-cursor  # debe haber avanzado
grep -c "appended" ~/.claude/logs/learnings.log
ls -la ~/.claude/learnings/cos/
```

- [ ] **Step 5: Re-run inmediato (idempotencia)**

```bash
~/.claude/hooks/extract-learnings.sh
```

Expected: log dice "no transcripts to process" o procesa solo lo que llegó después del cursor.

```bash
tail -5 ~/.claude/logs/learnings.log
```

- [ ] **Step 6: Copiar al repo y commit**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
cp ~/.claude/hooks/extract-learnings.sh hooks/extract-learnings.sh

git add hooks/extract-learnings.sh
git commit -m "feat(learnings): batch nocturno extract-learnings.sh"
```

---

### Task 6: launchd plist `com.claude.extract-learnings`

**Files:**
- Create: `~/Library/LaunchAgents/com.claude.extract-learnings.plist` + copia en `launchd/com.claude.extract-learnings.plist`

- [ ] **Step 1: Crear el plist**

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.claude.extract-learnings.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.extract-learnings</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>$HOME/.claude/hooks/extract-learnings.sh</string>
    </array>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>21</integer>
        <key>Minute</key>
        <integer>55</integer>
    </dict>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/calepes/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/calepes</string>
    </dict>

    <key>StandardErrorPath</key>
    <string>/tmp/com.claude.extract-learnings.err.log</string>

    <key>StandardOutPath</key>
    <string>/tmp/com.claude.extract-learnings.out.log</string>

    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
EOF
```

- [ ] **Step 2: Cargar el plist**

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.extract-learnings.plist
launchctl print gui/$(id -u)/com.claude.extract-learnings | head -20
```

Expected: `state = waiting`.

- [ ] **Step 3: Forzar run para validar**

```bash
launchctl kickstart -k gui/$(id -u)/com.claude.extract-learnings
sleep 60  # esperar a que termine
tail -20 ~/.claude/logs/learnings.log
cat /tmp/com.claude.extract-learnings.err.log  # debe estar vacío o sin errores
```

- [ ] **Step 4: Copiar al repo y commit**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
mkdir -p launchd
cp ~/Library/LaunchAgents/com.claude.extract-learnings.plist launchd/com.claude.extract-learnings.plist

git add launchd/com.claude.extract-learnings.plist
git commit -m "feat(learnings): launchd com.claude.extract-learnings (21:55 daily)"
```

---

### Task 7: Modificar `nightly-report.sh` con sección Learnings

**Files:**
- Modify: `~/.claude/hooks/nightly-report.sh` + copia en `hooks/nightly-report.sh`

- [ ] **Step 1: Leer el nightly-report.sh actual**

```bash
cat ~/.claude/hooks/nightly-report.sh | head -80
```

Identificar dónde se construye el mensaje final y dónde se hace el `curl` a Telegram.

- [ ] **Step 2: Implementar función `build_learnings_section`**

Agregar al final del script, ANTES de la función que envía el Telegram:

```bash
# Función nueva: construye sección Learnings con botones inline
build_learnings_section() {
  local index="$HOME/.claude/learnings/cos/index.md"
  [[ ! -f "$index" ]] && return

  # Extraer pendings agrupados por tipo
  local pending_lines
  pending_lines=$(grep "\[pending\]" "$index" || true)
  [[ -z "$pending_lines" ]] && return

  local total=$(echo "$pending_lines" | wc -l | tr -d ' ')

  echo ""
  echo "─────────────"
  echo "📚 Learnings hoy ($total pendientes)"

  for tipo in correction error decision pattern idea; do
    local label
    case "$tipo" in
      correction) label="A. Correcciones" ;;
      error) label="C. Errores" ;;
      decision) label="D. Decisiones" ;;
      pattern) label="B. Patterns" ;;
      idea) label="E. Ideas" ;;
    esac

    local entries=$(echo "$pending_lines" | grep "\[$tipo\]" || true)
    [[ -z "$entries" ]] && continue

    local count=$(echo "$entries" | wc -l | tr -d ' ')
    echo ""
    echo "$label ($count):"

    local i=1
    echo "$entries" | while IFS= read -r line; do
      # Extraer descripción (entre tags y →)
      local desc=$(echo "$line" | sed -E 's/^- [0-9-]+ \[[^]]+\] (\[[^]]+\] )?(.+) → .*$/\2/')
      local id=$(echo "$line" | grep -oE '<!-- [^ ]+ -->' | sed 's/<!-- //;s/ -->//')

      # Detectar frecuencia alta para errors
      local marker=""
      if [[ "$tipo" == "error" ]]; then
        local file=$(echo "$line" | grep -oE '→ [^#]+\.md' | sed 's|→ ||;s| ||g')
        local anchor=$(echo "$line" | grep -oE '#[^ ]+' | tr -d '#')
        local freq=$(awk -v anchor="$anchor" '/^## / { in_target = ($0 == "## " anchor) } in_target && /^frecuencia: / { print $2; exit }' "$HOME/.claude/learnings/cos/$file" 2>/dev/null)
        [[ -n "$freq" && "$freq" -ge 5 ]] && marker="⚠️ "
      fi

      echo "${i}. ${marker}${desc}  (${id})"
      i=$((i + 1))
    done
  done
}

# Función nueva: construye keyboard inline JSON para Telegram
build_learnings_keyboard() {
  local index="$HOME/.claude/learnings/cos/index.md"
  [[ ! -f "$index" ]] && echo "" && return

  local pending_lines
  pending_lines=$(grep "\[pending\]" "$index" || true)
  [[ -z "$pending_lines" ]] && echo "" && return

  local ids=()
  while IFS= read -r line; do
    local id=$(echo "$line" | grep -oE '<!-- [^ ]+ -->' | sed 's/<!-- //;s/ -->//')
    ids+=("$id")
  done <<< "$pending_lines"

  # Keyboard: filas de [N✅] [N❌] de a 2 entries por fila (4 botones por fila max)
  # MAX 4 filas → 4 entries por mensaje. Si hay más, chunkear (Task se simplifica: solo primer chunk acá)
  local rows=()
  local count=${#ids[@]}
  local max_inline=4  # MAX_KEYBOARD_ROWS (-1 para reservar fila de Todo)

  for ((i=0; i<count && i<max_inline*2; i+=2)); do
    local id1="${ids[$i]}"
    local row="[{\"text\":\"$((i+1))✅\",\"callback_data\":\"learn:keep:$id1\"},{\"text\":\"$((i+1))❌\",\"callback_data\":\"learn:drop:$id1\"}"
    if (( i+1 < count )); then
      local id2="${ids[$((i+1))]}"
      row="$row,{\"text\":\"$((i+2))✅\",\"callback_data\":\"learn:keep:$id2\"},{\"text\":\"$((i+2))❌\",\"callback_data\":\"learn:drop:$id2\"}"
    fi
    row="$row]"
    rows+=("$row")
  done

  # Fila final: bulk
  local batch_id=$(echo "${ids[@]}" | shasum -a 1 | cut -c1-8)
  rows+=("[{\"text\":\"✅ Todo\",\"callback_data\":\"learn:keepall:$batch_id\"},{\"text\":\"❌ Todo\",\"callback_data\":\"learn:dropall:$batch_id\"}]")

  # Save batch_id → ids mapping para callback handler
  mkdir -p "$HOME/.claude/state/learn-batches"
  printf "%s\n" "${ids[@]}" > "$HOME/.claude/state/learn-batches/$batch_id"

  # JSON inline_keyboard
  local joined=$(IFS=,; echo "${rows[*]}")
  echo "{\"inline_keyboard\":[$joined]}"
}
```

- [ ] **Step 3: Integrar en el flujo principal del script**

Buscar la línea donde se construye `MSG` (el mensaje del nightly-report) y agregar al final:

```bash
# Append sección Learnings si hay pendings
LEARNINGS_SECTION=$(build_learnings_section)
[[ -n "$LEARNINGS_SECTION" ]] && MSG="${MSG}${LEARNINGS_SECTION}"

LEARNINGS_KB=$(build_learnings_keyboard)
```

Y en el `curl` final que manda a Telegram, agregar `reply_markup` solo si hay keyboard:

```bash
if [[ -n "$LEARNINGS_KB" ]]; then
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${MSG}" \
    --data-urlencode "reply_markup=${LEARNINGS_KB}" > /dev/null
else
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${MSG}" > /dev/null
fi
```

- [ ] **Step 4: Smoke test con entries mock**

Crear 3 entries pending mock:

```bash
source ~/.claude/hooks/learnings-lib.sh
append_entry correction "Mock test correction 1" "trigger 1" "contexto" "test" "test,smoke"
append_entry decision "Mock test decision 1" "trigger 2" "contexto" "test" "test"
append_entry error "Mock test error 1" "trigger 3" "contexto" "test" "test"

# Forzar run del nightly-report
~/.claude/hooks/nightly-report.sh
```

Verificar Telegram: debe llegar el reporte normal + sección Learnings con 3 entries y botones.

- [ ] **Step 5: Limpiar mocks**

```bash
source ~/.claude/hooks/learnings-lib.sh
for id in $(grep "Mock test" ~/.claude/learnings/cos/index.md | grep -oE '<!-- [^ ]+ -->' | sed 's/<!-- //;s/ -->//'); do
  move_to_archive "$id"
done
rm -f ~/.claude/learnings/cos/archive/$(date +%Y-%m).md
rm -rf ~/.claude/state/learn-batches
```

- [ ] **Step 6: Copiar al repo y commit**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
cp ~/.claude/hooks/nightly-report.sh hooks/nightly-report.sh

git add hooks/nightly-report.sh
git commit -m "feat(learnings): nightly-report extendido con sección Learnings + botones"
```

---

### Task 8: Callback handlers `learn:*` en `callback-router.ts`

**Files:**
- Modify: `telegram-plugin/callback-router.ts`
- Deploy: `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/callback-router.ts`

- [ ] **Step 1: Leer callback-router.ts actual**

```bash
cat "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/telegram-plugin/callback-router.ts" | head -50
```

Identificar el patrón del `switch` de prefijos.

- [ ] **Step 2: Agregar case `learn` al switch**

Localizar el `switch (prefix)` y agregar:

```typescript
case 'learn': {
  return await handleLearnCallback(parts[1] as 'keep' | 'drop' | 'keepall' | 'dropall', parts[2])
}
```

- [ ] **Step 3: Implementar `handleLearnCallback`**

Agregar al final del archivo (antes de cualquier `export default`):

```typescript
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const LEARNINGS_DIR = path.join(process.env.HOME || '', '.claude/learnings/cos')
const LIB_PATH = path.join(process.env.HOME || '', '.claude/hooks/learnings-lib.sh')

async function handleLearnCallback(
  action: 'keep' | 'drop' | 'keepall' | 'dropall',
  id: string
): Promise<RouteResult> {
  try {
    if (action === 'keep' || action === 'drop') {
      // Llamar funciones de la library bash
      const cmd = action === 'keep'
        ? `source "${LIB_PATH}" && flip_pending "${id}" "true"`
        : `source "${LIB_PATH}" && move_to_archive "${id}"`

      execSync(cmd, { shell: '/bin/bash', stdio: 'pipe' })
      return { toast: action === 'keep' ? '✓ kept' : '✓ dropped' }
    }

    if (action === 'keepall' || action === 'dropall') {
      // Leer batch file
      const batchFile = path.join(process.env.HOME || '', '.claude/state/learn-batches', id)
      if (!fs.existsSync(batchFile)) {
        return { toast: '❌ batch no encontrado' }
      }
      const ids = fs.readFileSync(batchFile, 'utf8').trim().split('\n').filter(Boolean)
      const subAction = action === 'keepall' ? 'keep' : 'drop'

      for (const eid of ids) {
        const cmd = subAction === 'keep'
          ? `source "${LIB_PATH}" && flip_pending "${eid}" "true"`
          : `source "${LIB_PATH}" && move_to_archive "${eid}"`
        try {
          execSync(cmd, { shell: '/bin/bash', stdio: 'pipe' })
        } catch (e) {
          // Continue with rest
        }
      }

      // Cleanup batch file
      fs.unlinkSync(batchFile)
      return { toast: `✓ ${action} ${ids.length} entries` }
    }

    return { toast: '❌ acción inválida' }
  } catch (err: any) {
    return { toast: `❌ error: ${err.message?.substring(0, 50) || 'unknown'}` }
  }
}
```

- [ ] **Step 4: Deploy al plugin cache**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
cp telegram-plugin/callback-router.ts ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/callback-router.ts
```

- [ ] **Step 5: Restart Claude Code para recargar el plugin**

Cerrar la sesión actual y abrir nueva con `claude --channels plugin:telegram@claude-plugins-official`.

- [ ] **Step 6: Smoke test end-to-end**

Crear 1 entry mock:

```bash
source ~/.claude/hooks/learnings-lib.sh
append_entry correction "Mock callback test" "trigger" "contexto" "test" "test"
```

Forzar nightly-report → llegará Telegram con botones. Tap [✅] al lado del mock → debe responder toast "✓ kept" y la entry debe perder el flag `[pending]` en index.md:

```bash
grep "Mock callback test" ~/.claude/learnings/cos/index.md
# NO debe aparecer "[pending]"
```

Crear otro mock y tap [❌] → debe ir a archive:

```bash
ls ~/.claude/learnings/cos/archive/
```

- [ ] **Step 7: Limpiar mocks**

```bash
rm -f ~/.claude/learnings/cos/archive/$(date +%Y-%m).md
# Reset corrections.md (remover entries Mock)
sed -i '' '/^## mock-callback-test/,/^---$/d' ~/.claude/learnings/cos/corrections.md 2>/dev/null || true
sed -i '' '/Mock callback test/d' ~/.claude/learnings/cos/index.md
```

- [ ] **Step 8: Commit**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add telegram-plugin/callback-router.ts

git commit -m "feat(telegram-plugin): callback handlers learn:keep/drop/keepall/dropall"
```

---

### Task 9: Scripts de utilidad (`rebuild-learnings-index.sh`, `learnings-status.sh`)

**Files:**
- Create: `~/.claude/hooks/rebuild-learnings-index.sh` + copia en `hooks/`
- Create: `~/.claude/hooks/learnings-status.sh` + copia en `hooks/`

- [ ] **Step 1: Implementar `rebuild-learnings-index.sh`**

```bash
cat > ~/.claude/hooks/rebuild-learnings-index.sh << 'EOF'
#!/usr/bin/env bash
# rebuild-learnings-index.sh — regenera index.md scaneando archivos de detalle
set -euo pipefail

LEARNINGS_DIR="$HOME/.claude/learnings/cos"
INDEX="$LEARNINGS_DIR/index.md"
TMP=$(mktemp)

# Header
cat > "$TMP" << 'HEAD'
# Index — Learnings CoS

Mapa central de aprendizajes capturados del CoS. Una línea por entry.

Formato: `- YYYY-MM-DD [tipo] [tags] Descripción → archivo.md#anchor [pending]`

Tipos: `correction | pattern | error | decision | idea`

---

<!-- entries: -->
HEAD

# Scan archivos de detalle
declare -A FILE_TIPO=(
  [corrections.md]=correction
  [patterns.md]=pattern
  [errors.md]=error
  [decisions.md]=decision
  [feature_requests.md]=idea
)

for file in corrections.md patterns.md errors.md decisions.md feature_requests.md; do
  [[ ! -f "$LEARNINGS_DIR/$file" ]] && continue
  tipo="${FILE_TIPO[$file]}"

  # Parse cada section H2
  awk -v file="$file" -v tipo="$tipo" '
    /^## / { anchor = $0; sub(/^## /, "", anchor); in_fm = 0; in_section = 1; id = ""; date = ""; pending = ""; tags = "" }
    in_section && /^<!--$/ { in_fm = 1; next }
    in_section && /^-->$/ { in_fm = 0;
      if (id != "" && date != "") {
        pending_flag = (pending == "true") ? " [pending]" : ""
        tags_display = (tags != "") ? "[" tags "] " : ""
        # Read regla from a few lines later — simplified, just use anchor
        printf "- %s [%s] %s%s → %s#%s%s <!-- %s -->\n", date, tipo, tags_display, anchor, file, anchor, pending_flag, id
      }
      in_section = 0; next
    }
    in_fm && /^id: / { id = $2 }
    in_fm && /^date: / { date = $2 }
    in_fm && /^pending: / { pending = $2 }
    in_fm && /^tags: / { tags = $0; sub(/^tags: \[/, "", tags); sub(/\]$/, "", tags) }
  ' "$LEARNINGS_DIR/$file" >> "$TMP"
done

mv "$TMP" "$INDEX"
echo "✓ index rebuilt: $(grep -c '^- ' "$INDEX") entries"
EOF

chmod +x ~/.claude/hooks/rebuild-learnings-index.sh
```

- [ ] **Step 2: Implementar `learnings-status.sh`**

```bash
cat > ~/.claude/hooks/learnings-status.sh << 'EOF'
#!/usr/bin/env bash
# learnings-status.sh — observabilidad del sistema de learnings
set -euo pipefail

LEARNINGS_DIR="$HOME/.claude/learnings/cos"
CURSOR_FILE="$HOME/.claude/state/learnings-cursor"
LOG="$HOME/.claude/logs/learnings.log"

echo "=== Learnings Status ==="
echo ""

# Cursor
CURSOR=$(cat "$CURSOR_FILE" 2>/dev/null || echo "0")
if [[ "$CURSOR" == "0" ]]; then
  echo "Cursor: nunca corrió"
else
  CURSOR_HUMAN=$(date -r "$CURSOR" 2>/dev/null || echo "$CURSOR")
  echo "Cursor: $CURSOR ($CURSOR_HUMAN)"
fi

# Pending por tipo
echo ""
echo "Pending por tipo:"
for tipo in correction pattern error decision idea; do
  count=$(grep -c "\[$tipo\].*\[pending\]" "$LEARNINGS_DIR/index.md" 2>/dev/null || echo 0)
  printf "  %-12s %d\n" "$tipo" "$count"
done

# Total entries
TOTAL=$(grep -c '^- ' "$LEARNINGS_DIR/index.md" 2>/dev/null || echo 0)
echo ""
echo "Total entries: $TOTAL"

# Último batch run
echo ""
echo "Últimos 5 entries (cualquier tipo):"
grep '^- ' "$LEARNINGS_DIR/index.md" 2>/dev/null | tail -5 | sed 's/^/  /'

# Top errores por frecuencia
echo ""
echo "Top 3 errores por frecuencia:"
awk '
  /^## / { anchor = $0; sub(/^## /, "", anchor); freq = 0 }
  /^frecuencia: / { freq = $2 }
  /^-->$/ { if (freq > 0) print freq " " anchor; freq = 0 }
' "$LEARNINGS_DIR/errors.md" 2>/dev/null | sort -rn | head -3 | sed 's/^/  /'

# Último log
echo ""
echo "Último log entry:"
tail -3 "$LOG" 2>/dev/null | sed 's/^/  /'
EOF

chmod +x ~/.claude/hooks/learnings-status.sh
```

- [ ] **Step 3: Smoke test ambos**

```bash
~/.claude/hooks/learnings-status.sh

# Borrar index intencionalmente y rebuild
mv ~/.claude/learnings/cos/index.md ~/.claude/learnings/cos/index.md.bak
~/.claude/hooks/rebuild-learnings-index.sh
diff ~/.claude/learnings/cos/index.md ~/.claude/learnings/cos/index.md.bak
# Pueden no ser idénticos exactos (orden), pero conteos deben coincidir
rm ~/.claude/learnings/cos/index.md.bak
```

- [ ] **Step 4: Copiar al repo y commit**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
cp ~/.claude/hooks/rebuild-learnings-index.sh hooks/rebuild-learnings-index.sh
cp ~/.claude/hooks/learnings-status.sh hooks/learnings-status.sh

git add hooks/rebuild-learnings-index.sh hooks/learnings-status.sh
git commit -m "feat(learnings): scripts utilidad rebuild-index + status"
```

---

### Task 10: `sync-learnings.sh` + plist

**Files:**
- Create: `scripts/sync-learnings.sh` (en repo)
- Create: `~/Library/LaunchAgents/com.claude.sync-learnings.plist` + copia en `launchd/`

- [ ] **Step 1: Escribir `sync-learnings.sh`**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
mkdir -p scripts
cat > scripts/sync-learnings.sh << 'EOF'
#!/usr/bin/env bash
# sync-learnings.sh — copia ~/.claude/learnings/cos/ → repo docs/learnings/, commit, push
set -euo pipefail

REPO="$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
SOURCE="$HOME/.claude/learnings/cos"
DEST="$REPO/docs/learnings"
ENV_FILE="$HOME/.claude/channels/telegram/.env"

[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

cd "$REPO"

# Verificar working tree limpio en docs/learnings/ (si existe)
if [[ -d "docs/learnings" ]] && ! git diff --quiet docs/learnings/ 2>/dev/null; then
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID:-94137698}" \
    --data-urlencode "text=⚠️ sync-learnings: docs/learnings/ tiene cambios sin commit. Resolver manual." > /dev/null
  exit 1
fi

mkdir -p "$DEST"
rsync -a --delete "$SOURCE/" "$DEST/"

if git diff --quiet docs/learnings/ 2>/dev/null && git diff --cached --quiet docs/learnings/ 2>/dev/null; then
  echo "no changes to sync"
  exit 0
fi

WEEK=$(date +%Y-W%V)
git add docs/learnings/
git commit -m "chore(learnings): sync $WEEK"
git push

# Notify
COUNT=$(grep -c '^- ' "$DEST/index.md" 2>/dev/null || echo 0)
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID:-94137698}" \
  --data-urlencode "text=📚 Learnings sync $WEEK: $COUNT entries totales" > /dev/null
EOF

chmod +x scripts/sync-learnings.sh
```

- [ ] **Step 2: Crear plist `com.claude.sync-learnings`**

```bash
cat > ~/Library/LaunchAgents/com.claude.sync-learnings.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.sync-learnings</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>$HOME/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal/scripts/sync-learnings.sh</string>
    </array>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>0</integer>
        <key>Hour</key>
        <integer>21</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/calepes/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/calepes</string>
    </dict>

    <key>StandardErrorPath</key>
    <string>/tmp/com.claude.sync-learnings.err.log</string>

    <key>StandardOutPath</key>
    <string>/tmp/com.claude.sync-learnings.out.log</string>

    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
EOF
```

- [ ] **Step 3: Smoke test del script (sin cargar plist aún)**

```bash
~/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal/scripts/sync-learnings.sh
```

Expected: si no hay cambios reales, "no changes to sync". Si hay, commit + push exitoso.

Verificar:

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git log --oneline -3
ls docs/learnings/
```

- [ ] **Step 4: Cargar plist (Cal puede esperar 1 semana antes según rollout, pero lo cargamos)**

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.sync-learnings.plist
launchctl print gui/$(id -u)/com.claude.sync-learnings | head -10
```

- [ ] **Step 5: Copiar plist al repo y commit**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
cp ~/Library/LaunchAgents/com.claude.sync-learnings.plist launchd/com.claude.sync-learnings.plist

git add scripts/sync-learnings.sh launchd/com.claude.sync-learnings.plist
git commit -m "feat(learnings): sync semanal al repo (domingo 21:00)"
git push
```

---

### Task 11: Edit `CLAUDE.md` (CoS) + docs

**Files:**
- Modify: `CLAUDE.md` (CoS root)
- Modify: `BACKLOG.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Agregar bullet a CLAUDE.md**

Localizar la sección "## Hooks & Automatización" o crear sección nueva "## Learnings históricos" antes de "## Comandos operativos". Agregar:

```markdown
## Learnings históricos
- **Index:** `~/.claude/learnings/cos/index.md` — consultar antes de tomar decisiones técnicas, cambios estructurales, o cuando Cal mencione un tema con histórico (telegram, notion, heartbeat, claude-md, etc.). El index es chico (~1-2KB), abrir archivo de detalle solo si la línea relevante lo amerita
- **Captura:** skill `/learn <tipo> "<desc>"` (intencional) + hook `learn-error.sh` (errores automáticos) + batch nocturno 21:55 `extract-learnings.sh` (red de seguridad + patterns)
- **Review:** integrado en nightly-report 22:00 con botones inline `learn:keep|drop`
- **Sync:** domingo 21:00 a `docs/learnings/` del repo
- **Spec/plan:** `docs/superpowers/specs/2026-04-19-self-improving-learnings-design.md` + `docs/superpowers/plans/2026-04-19-self-improving-learnings.md`
```

- [ ] **Step 2: Marcar 5.1 como done en BACKLOG.md**

Localizar la línea:

```
- [ ] 5.1 Self-improving → Crear `.learnings/`...
```

Reemplazar por:

```
- [x] 5.1 Self-improving (2026-04-19) — sistema captura learnings en `~/.claude/learnings/cos/` (filesystem-RAG indexado), review diario en nightly-report con botones, sync semanal a repo. Tipos: correction/error/decision/idea/pattern. Componentes: skill `/learn`, hook PostToolUse `learn-error.sh`, batch nocturno `extract-learnings.sh`, callbacks `learn:*`. Spec/plan en `docs/superpowers/`
```

- [ ] **Step 3: Agregar entrada a CHANGELOG.md**

Insertar al inicio del archivo (después del título):

```markdown
## 2026-04-XX  (reemplazar con fecha real al ejecutar)

### Fase 5.1 — Self-improving Learnings
- **Feature**: Sistema de captura de aprendizajes con filesystem-RAG en `~/.claude/learnings/cos/`. CLAUDE.md queda lean — todo el conocimiento histórico vive en learnings/ + index.md
- **Feature**: Skill `/learn <tipo> "<desc>"` para captura intencional (correction, decision, idea, error, pattern)
- **Feature**: Hook PostToolUse `learn-error.sh` captura errores automáticamente con rate limit (5/día por hash) y dedup
- **Feature**: Batch nocturno `extract-learnings.sh` (21:55) lee transcripts del día como red de seguridad + detecta patterns repetitivos. Costo ~$1.5/mes
- **Feature**: nightly-report (22:00) extendido con sección Learnings y botones inline `learn:keep|drop|keepall|dropall`
- **Feature**: Callbacks `learn:*` mecánicos en `callback-router.ts` (no pasan por LLM, ~200ms)
- **Feature**: Sync semanal `sync-learnings.sh` (domingo 21:00) copia learnings a `docs/learnings/` del repo + commit
- **Library**: `~/.claude/hooks/learnings-lib.sh` con funciones compartidas (generate_id, slug, hash_normalize, append_entry, update_index, move_to_archive, flip_pending, find_entry_in_index)
- **Utilities**: `rebuild-learnings-index.sh` (recovery), `learnings-status.sh` (observabilidad)
- **Spec/Plan**: `docs/superpowers/specs/2026-04-19-self-improving-learnings-design.md` + `docs/superpowers/plans/2026-04-19-self-improving-learnings.md`
```

- [ ] **Step 4: Commit final**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add CLAUDE.md BACKLOG.md CHANGELOG.md

git commit -m "docs: Fase 5.1 Self-improving Learnings completa"
git push
```

---

## Verificación final post-implementación

- [ ] **Smoke test integrado:**

```bash
# Status
~/.claude/hooks/learnings-status.sh

# Captura intencional
# (en sesión Claude Code)
/learn correction "test final integrado"

# Verificar
grep "test final integrado" ~/.claude/learnings/cos/index.md

# Forzar nightly-report (no esperar 22:00)
~/.claude/hooks/nightly-report.sh

# Tap [✅] en Telegram → verificar
grep "test final integrado" ~/.claude/learnings/cos/index.md  # sin [pending]

# Cleanup
source ~/.claude/hooks/learnings-lib.sh
TEST_ID=$(grep "test final integrado" ~/.claude/learnings/cos/index.md | grep -oE 'corr-[0-9]+-[0-9]+-[0-9]+-[0-9]+')
move_to_archive "$TEST_ID"
rm -f ~/.claude/learnings/cos/archive/$(date +%Y-%m).md
```

- [ ] **Verificar plists cargados:**

```bash
launchctl print gui/$(id -u)/com.claude.extract-learnings | head -5
launchctl print gui/$(id -u)/com.claude.sync-learnings | head -5
```

- [ ] **Esperar 24h y revisar quality:**
  - Cuántas entries capturó el batch
  - Cuántas son señal vs ruido
  - Si quality < 70%, iterar el `extract-learnings-prompt.md`

---

## Resumen de commits esperados

1. `feat(learnings): library bash compartida + scaffolding`
2. `feat(learnings): skill /learn para captura intencional`
3. `feat(learnings): PostToolUse hook learn-error.sh para errores C`
4. `feat(learnings): prompt para batch nocturno extract-learnings`
5. `feat(learnings): batch nocturno extract-learnings.sh`
6. `feat(learnings): launchd com.claude.extract-learnings (21:55 daily)`
7. `feat(learnings): nightly-report extendido con sección Learnings + botones`
8. `feat(telegram-plugin): callback handlers learn:keep/drop/keepall/dropall`
9. `feat(learnings): scripts utilidad rebuild-index + status`
10. `feat(learnings): sync semanal al repo (domingo 21:00)`
11. `docs: Fase 5.1 Self-improving Learnings completa`

11 commits. Push solo en task 10 y 11 (resto local hasta validar).
