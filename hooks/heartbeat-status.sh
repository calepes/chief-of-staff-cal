#!/usr/bin/env bash
# heartbeat-status.sh — observabilidad del engine
set -euo pipefail

LOG_FILE="$HOME/.claude/logs/heartbeat.log"
TASKS_DIR="$HOME/.claude/heartbeat-tasks"
STATE_DIR="$HOME/.claude/state"

echo "=== Heartbeat Status ==="
echo
echo "Último run:"
grep "heartbeat start" "$LOG_FILE" 2>/dev/null | tail -1 || echo "  (sin runs aún)"
echo

echo "Próximo run programado:"
launchctl list com.claude.heartbeat 2>/dev/null | grep -E "(LastExitStatus|Label)" || echo "  (no cargado en launchd)"
echo

echo "Checks activos:"
for f in "$TASKS_DIR"/*.md; do
  [[ -f "$f" ]] || continue
  name=$(awk '/^name:/{print $2; exit}' "$f")
  schedule=$(awk '/^schedule:/{print $2; exit}' "$f")
  priority=$(awk '/^priority:/{print $2; exit}' "$f")
  echo "  - $name (schedule=$schedule, priority=$priority)"
done
echo

echo "Últimos 5 alerts enviados:"
grep "sending telegram message" "$LOG_FILE" 2>/dev/null | tail -5 || echo "  (ninguno)"
echo

echo "Failure counter actual:"
cat "$STATE_DIR/heartbeat-failures" 2>/dev/null || echo "0"
