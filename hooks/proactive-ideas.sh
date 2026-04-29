#!/usr/bin/env bash
# proactive-ideas.sh — genera 1 idea proactiva basada en posts X/Threads + contexto.
# Ejecutado por launchd 3x/día (9am, 14pm, 19pm).
set -euo pipefail

LOG_FILE="$HOME/.claude/logs/proactive-ideas.log"
ENV_FILE="$HOME/.claude/channels/telegram/.env"
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

DRY_RUN=0
SLOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --slot) SLOT="$2"; shift 2 ;;
    *) echo "Uso: proactive-ideas.sh [--dry-run] [--slot foco|tactical|lookahead]"; exit 1 ;;
  esac
done

# Si no se pasa --slot, deduce por hora
if [[ -z "$SLOT" ]]; then
  hour=$(date +%H)
  case "$hour" in
    09) SLOT="foco" ;;
    14) SLOT="tactical" ;;
    19) SLOT="lookahead" ;;
    *) echo "Hora $hour no es slot conocido (9, 14, 19). Usa --slot."; exit 1 ;;
  esac
fi

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [$SLOT] $*" >> "$LOG_FILE"; }
log "start"

# === QUERY: X posts propios últimas 24h ===
fetch_x_posts() {
  if [[ -z "${X_BEARER_TOKEN:-}" || -z "${X_USER_ID:-}" ]]; then
    echo "(X tokens no configurados)"
    return
  fi
  curl -s "https://api.twitter.com/2/users/${X_USER_ID}/tweets?max_results=10&tweet.fields=created_at,text" \
    -H "Authorization: Bearer ${X_BEARER_TOKEN}" \
    | jq -r '.data[]? | "\(.created_at): \(.text)"' 2>/dev/null \
    || echo "(X query failed)"
}

# === QUERY: Threads posts propios últimas 24h ===
fetch_threads_posts() {
  if [[ -z "${THREADS_TOKEN:-}" || -z "${THREADS_USER_ID:-}" ]]; then
    echo "(Threads tokens no configurados)"
    return
  fi
  curl -s "https://graph.threads.net/v1.0/${THREADS_USER_ID}/threads?fields=text,timestamp&access_token=${THREADS_TOKEN}&limit=10" \
    | jq -r '.data[]? | "\(.timestamp): \(.text)"' 2>/dev/null \
    || echo "(Threads query failed)"
}

# === QUERY: tareas activas Notion ===
fetch_notion_tasks() {
  if [[ -z "${NOTION_TOKEN:-}" || -z "${NOTION_TASKS_DB_ID:-}" ]]; then
    echo "(Notion config faltante)"
    return
  fi
  curl -s -X POST "https://api.notion.com/v1/databases/${NOTION_TASKS_DB_ID}/query" \
    -H "Authorization: Bearer ${NOTION_TOKEN}" \
    -H "Notion-Version: 2022-06-28" \
    -H "Content-Type: application/json" \
    -d '{"page_size":20}' \
    | jq -r '.results[]? | (.properties | to_entries[] | select(.value.type=="title") | .value.title[0].plain_text // "(sin nombre)")' 2>/dev/null \
    || echo "(Notion query failed)"
}

write_notion() {
  local title="$1" body="$2" source="$3" slot="$4"
  local today
  today=$(date +%Y-%m-%d)

  if [[ -z "${NOTION_TOKEN:-}" || -z "${NOTION_IDEAS_DB_ID:-}" ]]; then
    log "skip write_notion: NOTION config faltante"
    return
  fi

  curl -s -X POST "https://api.notion.com/v1/pages" \
    -H "Authorization: Bearer ${NOTION_TOKEN}" \
    -H "Notion-Version: 2022-06-28" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc \
      --arg dbid "$NOTION_IDEAS_DB_ID" \
      --arg title "$title" \
      --arg body "$body" \
      --arg date "$today" \
      --arg source "$source" \
      --arg slot "$slot" \
      '{
        parent: { database_id: $dbid },
        properties: {
          "Título": { title: [{ text: { content: $title } }] },
          "Cuerpo": { rich_text: [{ text: { content: $body } }] },
          "Fecha": { date: { start: $date } },
          "Source": { select: { name: $source } },
          "Estado": { status: { name: "Sin empezar" } },
          "Slot": { select: { name: $slot } }
        }
      }')" > /dev/null
}

send_telegram() {
  local text="$1"
  local chat_id="${TELEGRAM_CHAT_ID:-94137698}"
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" > /dev/null
}

# === Construir prompt ===
build_prompt() {
  local x_posts threads_posts tasks intent
  x_posts=$(fetch_x_posts)
  threads_posts=$(fetch_threads_posts)
  tasks=$(fetch_notion_tasks)

  case "$SLOT" in
    foco) intent="Identifica la 1 cosa más importante para hoy basándote en lo que Cal publicó y lo que tiene en agenda." ;;
    tactical) intent="Identifica qué se está atrasando vs lo planeado. Sugiere 1 ajuste accionable." ;;
    lookahead) intent="Sintetiza el día y sugiere 1-2 preparativos para mañana." ;;
  esac

  cat <<EOF
Contexto del día (Cal — Chief Operations en Yape):

POSTS PROPIOS DE X (últimas 24h):
$x_posts

POSTS PROPIOS DE THREADS (últimas 24h):
$threads_posts

TAREAS ACTIVAS:
$tasks

INSTRUCCIÓN ($SLOT):
$intent

Responde con un JSON válido (sin markdown, sin explicación) con esta estructura exacta:
{"title": "<título corto, máximo 60 chars>", "body": "<cuerpo con la idea, 2-4 oraciones>", "source": "<X|Threads|Calendar|Mixto>"}
EOF
}

main() {
  log "building prompt"
  local prompt response
  prompt=$(build_prompt)
  log "prompt built ($(echo "$prompt" | wc -l) lines)"

  if (( DRY_RUN )); then
    echo "=== DRY RUN — prompt ==="
    echo "$prompt"
    echo "=== /DRY RUN ==="
    echo
    echo "(skip claude call en dry-run)"
    exit 0
  fi

  log "calling claude"
  if ! response=$(echo "$prompt" | timeout 90s claude -p 2>>"$LOG_FILE"); then
    log "claude call failed"
    exit 1
  fi

  if ! echo "$response" | jq -e . > /dev/null 2>&1; then
    log "invalid JSON response: $response"
    exit 1
  fi

  local title body source emoji
  title=$(echo "$response" | jq -r '.title')
  body=$(echo "$response" | jq -r '.body')
  source=$(echo "$response" | jq -r '.source')

  log "got idea: $title"

  log "writing to notion"
  write_notion "$title" "$body" "$source" "$SLOT"

  log "sending telegram"
  case "$SLOT" in
    foco) emoji="🎯" ;;
    tactical) emoji="⚡" ;;
    lookahead) emoji="🔮" ;;
  esac
  send_telegram "${emoji} ${title}

${body}

(slot: ${SLOT}, source: ${source})"

  log "done"
}

main "$@"
