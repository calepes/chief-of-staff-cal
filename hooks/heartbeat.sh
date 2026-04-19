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

main() {
  log "heartbeat start"
  for f in "$TASKS_DIR"/*.md; do
    [[ -f "$f" ]] || continue
    local name schedule priority
    name=$(parse_frontmatter "$f" name)
    schedule=$(parse_frontmatter "$f" schedule)
    priority=$(parse_frontmatter "$f" priority)
    log "found check: $name (schedule=$schedule priority=$priority)"
  done
  log "heartbeat end"
}

main "$@"
