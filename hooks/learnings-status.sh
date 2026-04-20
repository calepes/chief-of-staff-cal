#!/usr/bin/env bash
# learnings-status.sh — observabilidad del sistema de learnings
set -uo pipefail

LEARNINGS_DIR="$HOME/.claude/learnings/cos"
CURSOR_FILE="$HOME/.claude/state/learnings-cursor"
LOG="$HOME/.claude/logs/learnings.log"

echo "=== Learnings Status ==="
echo ""

CURSOR=$(cat "$CURSOR_FILE" 2>/dev/null || echo "0")
if [[ "$CURSOR" == "0" ]]; then
  echo "Cursor: nunca corrió"
else
  CURSOR_HUMAN=$(date -r "$CURSOR" 2>/dev/null || echo "$CURSOR")
  echo "Cursor: $CURSOR ($CURSOR_HUMAN)"
fi

echo ""
echo "Pending por tipo:"
for tipo in correction pattern error decision idea; do
  count=$(grep -c "\[$tipo\].*\[pending\]" "$LEARNINGS_DIR/index.md" 2>/dev/null | head -1)
  [[ -z "$count" ]] && count=0
  printf "  %-12s %d\n" "$tipo" "$count"
done

TOTAL=$(grep -c '^- ' "$LEARNINGS_DIR/index.md" 2>/dev/null | head -1)
[[ -z "$TOTAL" ]] && TOTAL=0
echo ""
echo "Total entries: $TOTAL"

echo ""
echo "Últimos 5 entries (cualquier tipo):"
grep '^- ' "$LEARNINGS_DIR/index.md" 2>/dev/null | tail -5 | sed 's/^/  /'

echo ""
echo "Top 3 errores por frecuencia:"
awk '
  /^## / { anchor = $0; sub(/^## /, "", anchor); freq = 0 }
  /^frecuencia: / { freq = $2 }
  /^-->$/ { if (freq > 0) print freq " " anchor; freq = 0 }
' "$LEARNINGS_DIR/errors.md" 2>/dev/null | sort -rn | head -3 | sed 's/^/  /'

echo ""
echo "Último log entry:"
tail -3 "$LOG" 2>/dev/null | sed 's/^/  /'
