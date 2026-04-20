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

# Patterns conocidos (regex|descripción canónica — bash 3.2 compat, sin associative arrays)
PATTERNS=(
  "gtimeout: failed to run command|gtimeout no encuentra el binario (revisar PATH del launchd)"
  "ETIMEDOUT|timeout de red en API call"
  "ECONNRESET|conexión reseteada por el peer"
  "401 Unauthorized|auth fallida (token expirado o inválido)"
  "429 Too Many Requests|rate limit excedido"
  "5[0-9][0-9] Internal Server Error|server error 5xx en upstream"
  "No such file or directory|archivo o directorio inexistente"
)

# Skip si exit code == 0 (solo capturamos errores reales por exit code)
# El feedback loop con "error"/"errors.md" en output es demasiado ruidoso
if [[ "$EXIT_CODE" == "0" ]]; then
  exit 0
fi

# Skip cancelaciones de usuario
if echo "$RESPONSE" | grep -qE "(user cancelled|permission denied by user|operation cancelled)"; then
  exit 0
fi

# Match contra patterns conocidos
DESC=""
for entry in "${PATTERNS[@]}"; do
  pat="${entry%%|*}"
  desc="${entry#*|}"
  if echo "$RESPONSE" | grep -qE "$pat"; then
    DESC="$desc"
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
[[ ! -f "$RATE_LIMIT_FILE" ]] && echo '{}' > "$RATE_LIMIT_FILE"
COUNT=$(jq -r --arg h "$HASH" --arg d "$TODAY" '.[$d][$h] // 0' "$RATE_LIMIT_FILE" 2>/dev/null || echo 0)
if (( COUNT >= 5 )); then
  echo "[$(date)] rate limit hit for hash $HASH" >> "$LOG"
  exit 0
fi

# Increment counter
TMP=$(mktemp)
jq --arg h "$HASH" --arg d "$TODAY" \
  '.[$d][$h] = ((.[$d][$h] // 0) + 1)' \
  "$RATE_LIMIT_FILE" > "$TMP" && mv "$TMP" "$RATE_LIMIT_FILE"

# Si ya existe entry con mismo hash → incrementar frecuencia y last_seen
if is_duplicate error "$DESC"; then
  awk -v hash="$HASH" -v today="$TODAY" '
    /^## / { in_section = 0 }
    /^hash: / && $2 == hash { in_section = 1; freq_done = 0; seen_done = 0 }
    in_section && /^frecuencia: / {
      n = $2 + 1
      print "frecuencia: " n
      freq_done = 1
      next
    }
    in_section && /^last_seen: / {
      print "last_seen: " today
      seen_done = 1
      next
    }
    in_section && /^-->$/ {
      if (!freq_done) print "frecuencia: 2"
      if (!seen_done) print "last_seen: " today
      in_section = 0
    }
    { print }
  ' "$HOME/.claude/learnings/cos/errors.md" > /tmp/errors.md.tmp \
    && mv /tmp/errors.md.tmp "$HOME/.claude/learnings/cos/errors.md"
  echo "[$(date)] incremented frecuencia for hash $HASH" >> "$LOG"
  exit 0
fi

# Crear nueva entry
TRIGGER="tool: $TOOL, exit: $EXIT_CODE"
CONTEXT="cwd: $(pwd), session: ${CLAUDE_SESSION_ID:-unknown}"
TAGS="$TOOL"

ID=$(append_entry error "$DESC" "$TRIGGER" "$CONTEXT" "hook:learn-error" "$TAGS")

# Agregar campos extra del tipo error al frontmatter
awk -v id="$ID" -v today="$TODAY" '
  /^id: / && $2 == id { in_section = 1 }
  in_section && /^-->$/ {
    print "frecuencia: 1"
    print "last_seen: " today
    print "fix_aplicado: null"
    in_section = 0
  }
  { print }
' "$HOME/.claude/learnings/cos/errors.md" > /tmp/errors.md.tmp \
  && mv /tmp/errors.md.tmp "$HOME/.claude/learnings/cos/errors.md"

echo "[$(date)] new entry $ID for hash $HASH" >> "$LOG"
