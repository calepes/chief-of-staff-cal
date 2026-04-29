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

# Glob transcripts modificados después del cursor.
# macOS find no acepta -newermt "@epoch" → usar archivo de referencia con mtime=cursor
REF_FILE=$(mktemp)
if [[ "$CURSOR" != "0" ]]; then
  touch -t "$(date -r "$CURSOR" +%Y%m%d%H%M.%S 2>/dev/null)" "$REF_FILE" 2>/dev/null || true
  TRANSCRIPTS=$(find "$HOME/.claude/projects" -name '*.jsonl' -newer "$REF_FILE" 2>/dev/null || true)
else
  # cursor=0 → primer run, procesar todo (últimos 30 días para limitar)
  TRANSCRIPTS=$(find "$HOME/.claude/projects" -name '*.jsonl' -mtime -30 2>/dev/null || true)
fi
rm -f "$REF_FILE"

if [[ -z "$TRANSCRIPTS" ]]; then
  log "no transcripts to process"
  exit 0
fi

NEWEST_TS="$CURSOR"
TOTAL_ENTRIES=0

process_entry() {
  local entry_json="$1"
  local tipo desc trigger contexto tags
  tipo=$(echo "$entry_json" | jq -r '.tipo')
  desc=$(echo "$entry_json" | jq -r '.descripcion')
  trigger=$(echo "$entry_json" | jq -r '.trigger')
  contexto=$(echo "$entry_json" | jq -r '.contexto')
  tags=$(echo "$entry_json" | jq -r '.tags | join(",")')

  [[ -z "$tipo" || -z "$desc" || "${#desc}" -lt 5 ]] && return

  if is_duplicate "$tipo" "$desc"; then
    log "skip duplicate: $desc"
    return
  fi

  if (( DRY_RUN )); then
    log "DRY_RUN would append: [$tipo] $desc"
    echo "[$tipo] $desc"
    return
  fi

  local id
  id=$(append_entry "$tipo" "$desc" "$trigger" "$contexto" "batch" "$tags")
  log "appended $id: $desc"
  TOTAL_ENTRIES=$((TOTAL_ENTRIES + 1))
}

for f in $TRANSCRIPTS; do
  log "processing $f"

  # Extraer user/assistant messages del transcript como JSONL, limitar a últimas 100 líneas
  CHUNK=$(jq -c --argjson cursor "$CURSOR" '
    select(.timestamp != null)
    | select((.timestamp | fromdateiso8601? // 0) > $cursor)
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

  FULL_INPUT=$(printf '%s\n\n---\n\n%s' "$(cat "$PROMPT_FILE")" "$CHUNK")

  RAW_OUTPUT=$(echo "$FULL_INPUT" | timeout 90s claude -p 2>>"$LOG" || echo "")

  if [[ -z "$RAW_OUTPUT" ]]; then
    log "retry for $f"
    sleep 5
    RAW_OUTPUT=$(echo "$FULL_INPUT" | timeout 90s claude -p 2>>"$LOG" || echo "")
    if [[ -z "$RAW_OUTPUT" ]]; then
      log "skip $f after retry"
      continue
    fi
  fi

  # Remove code fences if present
  RAW_OUTPUT=$(echo "$RAW_OUTPUT" | sed -E 's/^```(json)?//; s/```$//' | sed '/^$/d')

  if ! ENTRIES=$(echo "$RAW_OUTPUT" | jq -c '.[]' 2>/dev/null); then
    log "invalid JSON from claude -p for $f"
    continue
  fi

  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    process_entry "$entry"
  done <<< "$ENTRIES"

  LAST_TS=$(jq -r --argjson cursor "$CURSOR" '
    select(.timestamp != null)
    | (.timestamp | fromdateiso8601? // 0)
    | select(. > $cursor)
  ' "$f" 2>/dev/null | sort -n | tail -1)
  if [[ -n "$LAST_TS" ]] && (( LAST_TS > NEWEST_TS )); then
    NEWEST_TS="$LAST_TS"
  fi
done

if (( ! DRY_RUN )); then
  echo "$NEWEST_TS" > "$CURSOR_FILE"
  log "cursor advanced to $NEWEST_TS"
fi

log "batch complete: $TOTAL_ENTRIES new entries"
