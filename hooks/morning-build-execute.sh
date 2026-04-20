#!/usr/bin/env bash
# morning-build-execute.sh <proposal_id>
# Ejecuta una propuesta aprobada. Invocado por el callback build:approve en el plugin
# (async, en background via setsid/nohup), o manualmente para debug.
set -u

PROPOSAL_ID="${1:?Uso: morning-build-execute.sh <proposal_id>}"

source "$HOME/.claude/channels/telegram/.env"

REPO="$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
PROPOSALS_DIR="$HOME/.claude/morning-builds/proposals"
APPROVED_DIR="$HOME/.claude/morning-builds/approved"
IMPLEMENTED_DIR="$HOME/.claude/morning-builds/implemented"
FAILED_DIR="$HOME/.claude/morning-builds/failed"
LOG="$HOME/.claude/logs/morning-build.log"
EXEC_PROMPT="$HOME/.claude/hooks/morning-build-exec-prompt.md"
CLAUDE="/Users/calepes/.local/bin/claude"
GTIMEOUT="/opt/homebrew/bin/gtimeout"

mkdir -p "$APPROVED_DIR" "$IMPLEMENTED_DIR" "$FAILED_DIR" "$(dirname "$LOG")"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [exec $PROPOSAL_ID] $*" >> "$LOG"; }

notify() {
  local text="$1"
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID:-94137698}" \
    --data-urlencode "text=${text}" > /dev/null
}

PROPOSAL_FILE="$PROPOSALS_DIR/$PROPOSAL_ID.json"
if [[ ! -f "$PROPOSAL_FILE" ]]; then
  log "proposal not found"
  notify "❌ Morning-build exec: propuesta $PROPOSAL_ID no encontrada"
  exit 1
fi

# Mover a approved
mv "$PROPOSAL_FILE" "$APPROVED_DIR/$PROPOSAL_ID.json"
PROPOSAL_FILE="$APPROVED_DIR/$PROPOSAL_ID.json"

PROPOSAL_JSON=$(cat "$PROPOSAL_FILE")
TITULO=$(echo "$PROPOSAL_JSON" | jq -r '.titulo')

log "exec start: $TITULO"
notify "🔨 Morning-build ejecutando: $TITULO..."

# Compose input
INPUT=$(cat "$EXEC_PROMPT")
INPUT="$INPUT

---

## Propuesta a ejecutar

$PROPOSAL_JSON
"

# Ejecutar con scope de tools restringido
OUTPUT=$($GTIMEOUT 1800s $CLAUDE -p \
  --dangerously-skip-permissions \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash" \
  -d "$REPO" \
  "$INPUT" 2>>"$LOG") || {
  log "claude -p failed"
  mv "$PROPOSAL_FILE" "$FAILED_DIR/$PROPOSAL_ID.json"
  notify "❌ Morning-build falló: $TITULO — claude -p timeout o error"
  exit 1
}

# Clasificar resultado
if echo "$OUTPUT" | grep -qE "^DONE"; then
  log "exec done"
  # Guardar output como log del build
  echo "$OUTPUT" >> "$PROPOSAL_FILE.output"
  mv "$PROPOSAL_FILE" "$IMPLEMENTED_DIR/$PROPOSAL_ID.json"
  SUMMARY=$(echo "$OUTPUT" | sed -n '/^DONE/,/^$/p' | head -10)
  notify "✅ Morning-build completado: $TITULO

$SUMMARY"
elif echo "$OUTPUT" | grep -qE "^ABORT"; then
  log "exec aborted"
  echo "$OUTPUT" >> "$PROPOSAL_FILE.output"
  mv "$PROPOSAL_FILE" "$FAILED_DIR/$PROPOSAL_ID.json"
  REASON=$(echo "$OUTPUT" | sed -n '/^ABORT/,/^$/p' | head -5)
  notify "🛑 Morning-build abortado: $TITULO

$REASON"
elif echo "$OUTPUT" | grep -qE "^FAIL"; then
  log "exec failed"
  echo "$OUTPUT" >> "$PROPOSAL_FILE.output"
  mv "$PROPOSAL_FILE" "$FAILED_DIR/$PROPOSAL_ID.json"
  REASON=$(echo "$OUTPUT" | sed -n '/^FAIL/,/^$/p' | head -5)
  notify "❌ Morning-build falló: $TITULO

$REASON"
else
  log "exec unknown result"
  echo "$OUTPUT" >> "$PROPOSAL_FILE.output"
  mv "$PROPOSAL_FILE" "$FAILED_DIR/$PROPOSAL_ID.json"
  notify "⚠️ Morning-build resultado ambiguo: $TITULO

$(echo "$OUTPUT" | tail -5)"
fi
