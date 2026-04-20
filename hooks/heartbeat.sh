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

DRY_RUN=0
ONLY_CHECK=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --only) ONLY_CHECK="$2"; shift 2 ;;
    *) echo "Uso: heartbeat.sh [--dry-run] [--only <name>]"; exit 1 ;;
  esac
done

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
  local hour dow
  hour=$(date +%H)
  dow=$(date +%u)
  case "$schedule" in
    every) return 0 ;;
    morning-only) (( 10#$hour < 12 )) && return 0 || return 1 ;;
    afternoon-only) (( 10#$hour >= 12 )) && return 0 || return 1 ;;
    midday-only) [[ "$hour" == "12" ]] && return 0 || return 1 ;;
    morning-wake) (( 10#$hour >= 7 && 10#$hour < 9 )) && return 0 || return 1 ;;
    evening) (( 10#$hour >= 17 && 10#$hour < 19 )) && return 0 || return 1 ;;
    business-hours) (( 10#$hour >= 10 && 10#$hour < 19 && 10#$dow >= 1 && 10#$dow <= 5 )) && return 0 || return 1 ;;
    weekly-monday-am) [[ "$dow" == "1" ]] && (( 10#$hour >= 8 && 10#$hour < 9 )) && return 0 || return 1 ;;
    late-afternoon) (( 10#$hour >= 17 && 10#$hour < 18 )) && return 0 || return 1 ;;
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
  if (( DRY_RUN )); then
    echo "=== DRY RUN — would send ==="
    echo "$text"
    echo "=== /DRY RUN ==="
    return 0
  fi
  local chat_id="${TELEGRAM_CHAT_ID:-94137698}"
  local token="${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN no definido}"
  curl -s -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" > /dev/null
}

main() {
  # Rotación: si log > 5MB, mover a .1 y empezar limpio
  if [[ -f "$LOG_FILE" ]]; then
    local size
    size=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    if (( size > 5 * 1024 * 1024 )); then
      mv "$LOG_FILE" "${LOG_FILE}.1"
    fi
  fi

  # Cleanup state files >7 días (idempotente)
  find "$STATE_DIR" -name 'health-alerts-*.json' -mtime +7 -delete 2>/dev/null || true

  log "heartbeat start"
  local -a high_buf=() medium_buf=() low_buf=()
  local checks_total=0 checks_failed=0
  for f in "$TASKS_DIR"/*.md; do
    [[ -f "$f" ]] || continue
    local name schedule priority
    name=$(parse_frontmatter "$f" name)
    schedule=$(parse_frontmatter "$f" schedule)
    priority=$(parse_frontmatter "$f" priority)
    if [[ -n "$ONLY_CHECK" && "$name" != "$ONLY_CHECK" ]]; then
      continue
    fi
    # Cuando se usa --only, bypassear el filtro de schedule
    if [[ -z "$ONLY_CHECK" ]] && ! should_run "$schedule"; then
      log "skip $name (schedule=$schedule)"
      continue
    fi
    checks_total=$((checks_total + 1))
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
      checks_failed=$((checks_failed + 1))
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

  # Failure counter: si todos los checks fallaron, incrementar; si no, reset
  local fail_state="$STATE_DIR/heartbeat-failures"
  if (( checks_total > 0 && checks_failed == checks_total )); then
    local count
    count=$(cat "$fail_state" 2>/dev/null || echo 0)
    count=$((count + 1))
    echo "$count" > "$fail_state"
    log "all checks failed (count=$count)"
    if (( count >= 3 )); then
      curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID:-94137698}" \
        --data-urlencode "text=⚠️ heartbeat caído (3+ runs con todos los checks fallando)" \
        > /dev/null
    fi
  else
    echo 0 > "$fail_state"
  fi

  log "heartbeat end"
}

main "$@"
