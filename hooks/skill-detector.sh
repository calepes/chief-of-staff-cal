#!/usr/bin/env bash
# skill-detector.sh — cron domingo 21:30. Escanea transcripts de la semana buscando
# patrones repetitivos y propone un skill. Envía a Telegram con botones aprobación.
set -u

source "$HOME/.claude/channels/telegram/.env"

REPO="$HOME/AI Projects/Personal/Agents/Jano"
PROPOSALS_DIR="$HOME/.claude/skill-proposals"
TRANSCRIPTS_DIR="$HOME/.claude/projects/-Users-calepes-Claude-Projects-Personal-Agents-Chief-of-Staff-Cal"
LOG="$HOME/.claude/logs/skill-detector.log"
PROMPT_FILE="$HOME/.claude/hooks/skill-detector-prompt.md"
CLAUDE="/Users/calepes/.local/bin/claude"
GTIMEOUT="/opt/homebrew/bin/timeout"

mkdir -p "$PROPOSALS_DIR" "$(dirname "$LOG")"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

log "skill-detector start"

# Listar transcripts modificados en los últimos 7 días
# macOS find no acepta -newermt "@epoch", usar -mtime
TRANSCRIPTS=$(find "$TRANSCRIPTS_DIR" -name '*.jsonl' -mtime -7 2>/dev/null)

if [[ -z "$TRANSCRIPTS" ]]; then
  log "no transcripts in last 7 days"
  exit 0
fi

# Extraer user+assistant text messages como resumen para el prompt
# Limit: ultimas 500 interacciones totales para no saturar el contexto
DIGEST=$(for f in $TRANSCRIPTS; do
  jq -c '
    select(.timestamp != null)
    | select(.message.role == "user" or .message.role == "assistant")
    | {
        ts: .timestamp,
        role: .message.role,
        content: (.message.content | if type == "string" then . else (map(select(.type == "text") | .text) | join("\n")) end)
      }
    | select(.content != "" and .content != null and (.content | length) > 10 and (.content | length) < 2000)
  ' "$f" 2>/dev/null
done | tail -500)

if [[ -z "$DIGEST" ]]; then
  log "empty digest, skip"
  exit 0
fi

# Lista de skills existentes para avoid duplicates
EXISTING_SKILLS=$(ls ~/.claude/commands/ 2>/dev/null | grep '\.md$' | sed 's/\.md$//' | tr '\n' ',' | sed 's/,$//')

INPUT=$(cat "$PROMPT_FILE")
INPUT="$INPUT

---

## Skills existentes (no duplicar)

$EXISTING_SKILLS

## Transcripts últimos 7 días

$DIGEST
"

log "invoking claude -p (input size: $(echo -n "$INPUT" | wc -c) bytes)"

RAW_OUTPUT=$($GTIMEOUT 180s $CLAUDE -p \
  --dangerously-skip-permissions \
  --allowedTools "Read,Glob,Grep" \
  -d "$REPO" \
  "$INPUT" 2>>"$LOG") || {
  log "claude -p failed"
  exit 1
}

# Strip code fences
RAW_OUTPUT=$(echo "$RAW_OUTPUT" | sed -E 's/^```(json)?[[:space:]]*//; s/^```$//' | sed '/^[[:space:]]*$/d')

if [[ "$RAW_OUTPUT" == "null" ]]; then
  log "no skill proposal this week"
  exit 0
fi

# Validar JSON
if ! echo "$RAW_OUTPUT" | jq -e . >/dev/null 2>&1; then
  log "invalid JSON"
  log "output: $RAW_OUTPUT"
  exit 1
fi

# Generar ID
WEEK=$(date +%Y-W%V)
NAME=$(echo "$RAW_OUTPUT" | jq -r '.name')
ID="skill-$WEEK-$NAME"

# Validar que name es kebab-case simple
if ! echo "$NAME" | grep -qE '^[a-z][a-z0-9-]+$'; then
  log "invalid name: $NAME"
  exit 1
fi

# Check si el skill ya existe
if [[ -f "$HOME/.claude/commands/$NAME.md" ]]; then
  log "skill $NAME ya existe, skip"
  exit 0
fi

# Guardar propuesta
PROPOSAL_FILE="$PROPOSALS_DIR/$ID.json"
echo "$RAW_OUTPUT" | jq --arg id "$ID" --arg week "$WEEK" \
  '. + {id: $id, week: $week, status: "pending"}' > "$PROPOSAL_FILE"
log "saved $PROPOSAL_FILE"

# Construir mensaje Telegram
TITULO=$(echo "$RAW_OUTPUT" | jq -r '.titulo')
FREQ=$(echo "$RAW_OUTPUT" | jq -r '.frecuencia_semana')
TRIGGERS=$(echo "$RAW_OUTPUT" | jq -r '.ejemplos_triggers[]' | head -3 | sed 's/^/• /')
BODY_PREVIEW=$(echo "$RAW_OUTPUT" | jq -r '.skill_body' | head -c 300)
[[ ${#BODY_PREVIEW} -ge 300 ]] && BODY_PREVIEW="${BODY_PREVIEW}..."

MSG="🧠 Skill Detector — propuesta

📌 /$NAME — $TITULO

📊 Frecuencia: $FREQ veces esta semana

💬 Ejemplos que dijiste:
$TRIGGERS

📄 Preview del skill:
$BODY_PREVIEW"

KEYBOARD='{"inline_keyboard":[[{"text":"✅ Instalar","callback_data":"skill:approve:'$ID'"},{"text":"❌ Descartar","callback_data":"skill:reject:'$ID'"}]]}'

TOKEN="${TELEGRAM_BOT_TOKEN}"
CHAT_ID="${TELEGRAM_CHAT_ID:-94137698}"
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  --data-urlencode "text=${MSG}" \
  --data-urlencode "reply_markup=${KEYBOARD}" > /dev/null

log "sent proposal $ID to telegram"
log "skill-detector end"
