---
name: incomplete-tasks
schedule: morning-only
priority: medium
type: bash
---

#!/usr/bin/env bash
set -uo pipefail

REMINDERS_BIN="/opt/homebrew/bin/reminders"
STATE_FILE="$HOME/.claude/state/incomplete-tasks-seen.json"
TODAY=$(date +%Y-%m-%d)

if ! "$REMINDERS_BIN" show-lists &>/dev/null; then
  echo "HEARTBEAT_OK"
  exit 0
fi

seen_today() {
  local key="$1"
  [[ ! -f "$STATE_FILE" ]] && return 1
  python3 -c "
import json, sys
data = json.load(open('$STATE_FILE'))
sys.exit(0 if data.get('$key') == '$TODAY' else 1)
" 2>/dev/null
}

mark_seen() {
  local key="$1"
  python3 -c "
import json, os
path = '$STATE_FILE'
data = json.load(open(path)) if os.path.exists(path) else {}
data = {k: v for k, v in data.items() if v == '$TODAY'}
data['$key'] = '$TODAY'
json.dump(data, open(path, 'w'))
" 2>/dev/null
}

NO_DATE=$(python3 << 'PYEOF' 2>/dev/null
import subprocess, json, sys

REMINDERS = '/opt/homebrew/bin/reminders'

try:
    r = subprocess.run([REMINDERS, 'show-lists', '-f', 'json'],
                       capture_output=True, text=True, timeout=5)
    raw = json.loads(r.stdout.strip())
    lists = [(x if isinstance(x, str) else (x.get('title') or x.get('name') or ''))
             for x in raw]
    lists = [l for l in lists if l and 'Mercado' not in l]
except Exception:
    sys.exit(0)

for lst in lists:
    try:
        r2 = subprocess.run([REMINDERS, 'show', lst, '-f', 'json'],
                            capture_output=True, text=True, timeout=5)
        items = json.loads(r2.stdout.strip())
        for item in items:
            if item.get('isCompleted', False):
                continue
            if not item.get('dueDate'):
                title = item.get('title', '(sin título)')
                print(f'{title}|{lst}')
    except Exception:
        continue
PYEOF
) || { echo "HEARTBEAT_OK"; exit 0; }

[[ -z "$NO_DATE" ]] && { echo "HEARTBEAT_OK"; exit 0; }

# Filtrar items ya alertados hoy (dedup — evita repetir cada 30 min)
NEW_LINES=""
COUNT=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  title="${line%%|*}"
  lst="${line#*|}"
  key="${title}|${lst}"
  if ! seen_today "$key"; then
    mark_seen "$key"
    NEW_LINES="${NEW_LINES}- ${title} [${lst}]\n"
    COUNT=$((COUNT + 1))
  fi
done <<< "$NO_DATE"

if [[ -z "$NEW_LINES" ]]; then
  echo "HEARTBEAT_OK"
else
  echo "ALERT"
  word="recordatorio sin fecha"
  [[ $COUNT -gt 1 ]] && word="recordatorios sin fecha"
  echo "📝 $COUNT $word:"
  printf '%b' "$NEW_LINES"
fi
