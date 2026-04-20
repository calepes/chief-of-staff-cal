#!/usr/bin/env bash
# morning-build.sh — cron 22:30. Genera UNA propuesta de mejora al CoS basada
# en el contexto del día y la envía a Telegram con botones de aprobación.
set -u
# pipefail NO — claude -p | jq con exits tempranos puede matar claude con SIGPIPE

source "$HOME/.claude/channels/telegram/.env"

REPO="$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
PROPOSALS_DIR="$HOME/.claude/morning-builds/proposals"
LOG="$HOME/.claude/logs/morning-build.log"
PROMPT_FILE="$HOME/.claude/hooks/morning-build-prompt.md"
CLAUDE="/Users/calepes/.local/bin/claude"
GTIMEOUT="/opt/homebrew/bin/gtimeout"

mkdir -p "$PROPOSALS_DIR" "$(dirname "$LOG")"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

log "morning-build start"

# Gather context
TODAY=$(date +%Y-%m-%d)
TOMORROW=$(date -v +1d +%Y-%m-%d 2>/dev/null || date -d "tomorrow" +%Y-%m-%d)

# Git log del día
GIT_LOG=$(cd "$REPO" && git log --since="00:00" --pretty=format:"%h %s" 2>/dev/null | head -15)

# Learnings pending
LEARNINGS_PENDING=""
if [[ -f "$HOME/.claude/learnings/cos/index.md" ]]; then
  LEARNINGS_PENDING=$(grep "\[pending\]" "$HOME/.claude/learnings/cos/index.md" | head -20)
fi

# Heartbeat log — últimas 30 líneas relevantes (errors + alerts)
HEARTBEAT_RECENT=$(grep "^\[2026-04-20\|error\|ALERT" "$HOME/.claude/logs/heartbeat.log" 2>/dev/null | tail -30)

# Notion tasks mañana (via API directa)
NOTION_TOKEN_VAL="${NOTION_TOKEN:-}"
TASKS_TOMORROW=""
if [[ -n "$NOTION_TOKEN_VAL" ]]; then
  DB_ID="1f2c487609dd802985dcd7ad59110ddd"
  TASKS_TOMORROW=$(curl -s --max-time 10 \
    -H "Authorization: Bearer $NOTION_TOKEN_VAL" \
    -H "Notion-Version: 2022-06-28" \
    -H "Content-Type: application/json" \
    -X POST "https://api.notion.com/v1/databases/$DB_ID/query" \
    -d '{
      "filter": {"property": "Deadline", "date": {"equals": "'"$TOMORROW"'"}},
      "page_size": 10
    }' 2>/dev/null | python3 -c "
import json, sys
try:
  data = json.load(sys.stdin)
  lines = []
  for r in data.get('results', []):
    props = r.get('properties', {})
    t = props.get('Nombre de tarea', {}).get('title', [])
    name = t[0]['plain_text'] if t else '?'
    estado = (props.get('Estado', {}).get('status') or {}).get('name', '?')
    lines.append(f'- {name} [{estado}]')
  print(chr(10).join(lines) if lines else '(sin tareas)')
except Exception:
  print('(query falló)')
" 2>/dev/null)
fi

# Compose input para claude -p
INPUT=$(cat "$PROMPT_FILE")
INPUT="$INPUT

---

## Contexto de hoy ($TODAY) → mañana ($TOMORROW)

### Git log del día (repo CoS)
${GIT_LOG:-(sin commits)}

### Learnings pending hoy
${LEARNINGS_PENDING:-(ninguno)}

### Heartbeat log reciente (errores + alertas)
${HEARTBEAT_RECENT:-(limpio)}

### Tareas mañana ($TOMORROW)
${TASKS_TOMORROW:-(sin tareas)}
"

log "invoking claude -p"
# Allow tools mínimos — solo read para que el LLM pueda explorar sin escribir
RAW_OUTPUT=$($GTIMEOUT 120s $CLAUDE -p \
  --dangerously-skip-permissions \
  --allowedTools "Read,Glob,Grep" \
  -d "$REPO" \
  "$INPUT" 2>>"$LOG") || {
  log "claude -p failed"
  exit 1
}

# Strip code fences si el LLM los agregó
RAW_OUTPUT=$(echo "$RAW_OUTPUT" | sed -E 's/^```(json)?[[:space:]]*//; s/^```$//' | sed '/^[[:space:]]*$/d')

# null → no propuesta
if [[ "$RAW_OUTPUT" == "null" ]]; then
  log "no proposal today"
  exit 0
fi

# Validar JSON
if ! echo "$RAW_OUTPUT" | jq -e . >/dev/null 2>&1; then
  log "invalid JSON: $RAW_OUTPUT"
  exit 1
fi

# Generar ID (sha1 corto del titulo + date)
TITULO=$(echo "$RAW_OUTPUT" | jq -r '.titulo')
ID="build-$TODAY-$(echo -n "$TITULO" | shasum -a 1 | cut -c1-8)"

# Guardar a disco
PROPOSAL_FILE="$PROPOSALS_DIR/$ID.json"
echo "$RAW_OUTPUT" | jq --arg id "$ID" --arg date "$TODAY" \
  '. + {id: $id, created: $date, status: "pending"}' > "$PROPOSAL_FILE"
log "saved $PROPOSAL_FILE"

# Construir mensaje Telegram
SCOPE=$(echo "$RAW_OUTPUT" | jq -r '.scope')
MOTIVO=$(echo "$RAW_OUTPUT" | jq -r '.motivo')
ACCION=$(echo "$RAW_OUTPUT" | jq -r '.accion')
IMPACTO=$(echo "$RAW_OUTPUT" | jq -r '.impacto')
ESFUERZO=$(echo "$RAW_OUTPUT" | jq -r '.esfuerzo_min')

MSG="🌙 Morning Build — propuesta

📌 $TITULO

💡 Motivo: $MOTIVO

🔨 Acción: $ACCION

📈 Impacto: $IMPACTO
⏱ Esfuerzo: ~${ESFUERZO} min
🎯 Scope: $SCOPE"

if [[ "$SCOPE" == "out-of-bounds" ]]; then
  SCOPE_DETAIL=$(echo "$RAW_OUTPUT" | jq -r '.scope_detail // ""')
  MSG="$MSG

⚠️ Fuera del scope automático. Requiere decisión manual:
$SCOPE_DETAIL"
  KEYBOARD=""
else
  KEYBOARD='{"inline_keyboard":[[{"text":"✅ Ejecutar","callback_data":"build:approve:'$ID'"},{"text":"❌ Descartar","callback_data":"build:reject:'$ID'"}]]}'
fi

# Enviar a Telegram
CHAT_ID="${TELEGRAM_CHAT_ID:-94137698}"
TOKEN="${TELEGRAM_BOT_TOKEN}"
if [[ -n "$KEYBOARD" ]]; then
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${MSG}" \
    --data-urlencode "reply_markup=${KEYBOARD}" > /dev/null
else
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${MSG}" > /dev/null
fi

log "sent proposal $ID to telegram"
log "morning-build end"
