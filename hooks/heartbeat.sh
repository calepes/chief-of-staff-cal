#!/usr/bin/env bash
# heartbeat.sh — engine que ejecuta los .md de ~/.claude/heartbeat-tasks/
# y consolida alerts en un mensaje a Telegram.
set -euo pipefail

TASKS_DIR="$HOME/.claude/heartbeat-tasks"
LOG_FILE="$HOME/.claude/logs/heartbeat.log"
STATE_DIR="$HOME/.claude/state"
ENV_FILE="$HOME/.claude/channels/telegram/.env"

# Carga .env si existe (TELEGRAM_BOT_TOKEN, etc)
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"
}

# parse_frontmatter <file> <key> → echo value or empty
parse_frontmatter() {
  local file="$1"
  local key="$2"
  awk -v k="$key" '
    /^---$/ { fm = !fm; next }
    fm && $1 == k":" { sub(/^[^:]+:[ ]*/, ""); print; exit }
  ' "$file"
}

# strip_frontmatter <file> → echo body sin frontmatter
strip_frontmatter() {
  awk 'BEGIN{fm=0; started=0} /^---$/{fm++; next} fm>=2{started=1} started{print}' "$1"
}

# should_run <schedule> → exit 0 if should run now, 1 otherwise
should_run() {
  local schedule="$1"
  local hour
  hour=$(date +%H)
  case "$schedule" in
    every) return 0 ;;
    morning-only) (( 10#$hour < 12 )) && return 0 || return 1 ;;
    afternoon-only) (( 10#$hour >= 12 )) && return 0 || return 1 ;;
    midday-only) [[ "$hour" == "12" ]] && return 0 || return 1 ;;
    *) return 1 ;;
  esac
}

# run_check <file> → echoes ALERT body (sin la palabra ALERT) or empty
# returns: 0=ok (alert or quiet), 1=error
run_check() {
  local file="$1"
  local prompt output
  prompt=$(strip_frontmatter "$file")
  if ! output=$(echo "$prompt" | gtimeout 60s claude -p 2>>"$LOG_FILE"); then
    return 1
  fi
  if [[ "$output" == ALERT* ]]; then
    echo "${output#ALERT}" | sed 's/^[[:space:]]*//'
    return 0
  fi
  return 0
}

# send_telegram <text>
send_telegram() {
  local text="$1"
  local chat_id="${TELEGRAM_CHAT_ID:-94137698}"
  local token="${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN no definido}"
  curl -s -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" > /dev/null
}

main() {
  log "heartbeat start"
  local -a high_buf=() medium_buf=() low_buf=()
  for f in "$TASKS_DIR"/*.md; do
    [[ -f "$f" ]] || continue
    local name schedule priority
    name=$(parse_frontmatter "$f" name)
    schedule=$(parse_frontmatter "$f" schedule)
    priority=$(parse_frontmatter "$f" priority)
    if ! should_run "$schedule"; then
      log "skip $name (schedule=$schedule)"
      continue
    fi
    log "run $name"
    local body
    if body=$(run_check "$f"); then
      if [[ -n "$body" ]]; then
        case "$priority" in
          high) high_buf+=("$body") ;;
          medium) medium_buf+=("$body") ;;
          *) low_buf+=("$body") ;;
        esac
        log "alert $name"
      else
        log "ok $name"
      fi
    else
      log "error $name"
    fi
  done

  # Construir mensaje final ordenado por priority
  local msg=""
  for b in "${high_buf[@]:-}"; do [[ -n "$b" ]] && msg+="$b"$'\n\n'; done
  for b in "${medium_buf[@]:-}"; do [[ -n "$b" ]] && msg+="$b"$'\n\n'; done
  for b in "${low_buf[@]:-}"; do [[ -n "$b" ]] && msg+="$b"$'\n\n'; done

  if [[ -n "$msg" ]]; then
    log "sending telegram message"
    send_telegram "$msg"
  else
    log "silent"
  fi
  log "heartbeat end"
}

main "$@"
