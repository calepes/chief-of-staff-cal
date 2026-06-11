---
name: overdue-escalation
schedule: morning-wake
priority: high
type: bash
---

#!/usr/bin/env bash
set -uo pipefail

REMINDERS_BIN="/opt/homebrew/bin/reminders"
STATE_FILE="$HOME/.claude/state/overdue-escalation-seen.json"
TODAY=$(date +%Y-%m-%d)
MIN_DAYS=3

# Verificar acceso TCC
if ! timeout 10s "$REMINDERS_BIN" show-lists &>/dev/null; then
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

# Obtener recordatorios vencidos >= MIN_DAYS días (todas las listas excepto Mercado)
ESCALATED=$(python3 << PYEOF 2>/dev/null
import subprocess, json
from datetime import datetime

REMINDERS = '/opt/homebrew/bin/reminders'
today = datetime.now().date()
min_days = $MIN_DAYS

try:
    r = subprocess.run([REMINDERS, 'show-lists', '-f', 'json'],
                       capture_output=True, text=True, timeout=10)
    raw = json.loads(r.stdout.strip())
    lists = [(x if isinstance(x, str) else (x.get('title') or x.get('name') or ''))
             for x in raw]
    lists = [l for l in lists if l and 'Mercado' not in l]
except Exception:
    import sys; sys.exit(0)

results = []
for lst in lists:
    try:
        r2 = subprocess.run([REMINDERS, 'show', lst, '-f', 'json'],
                            capture_output=True, text=True, timeout=10)
        items = json.loads(r2.stdout.strip())
        for item in items:
            if item.get('isCompleted', False):
                continue
            d = item.get('dueDate', '')
            if not d:
                continue
            try:
                due = datetime.fromisoformat(d[:10]).date()
            except Exception:
                continue
            days = (today - due).days
            if days >= min_days:
                title = item.get('title', '(sin titulo)')
                results.append(f'{title}|{lst}|{days}|{d[:10]}')
    except Exception:
        continue

for r in sorted(results, key=lambda x: -int(x.split('|')[2])):
    print(r)
PYEOF
) || { echo "HEARTBEAT_OK"; exit 0; }

[[ -z "$ESCALATED" ]] && { echo "HEARTBEAT_OK"; exit 0; }

# Filtrar ya alertados hoy
NEW_LINES=""
COUNT=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  title="${line%%|*}"
  rest="${line#*|}"
  lst="${rest%%|*}"
  rest2="${rest#*|}"
  days="${rest2%%|*}"
  key="esc|${title}|${lst}"
  if ! seen_today "$key"; then
    mark_seen "$key"
    NEW_LINES="${NEW_LINES}- ${title} [${lst}] — ${days}d sin atención\n"
    COUNT=$((COUNT + 1))
  fi
done <<< "$ESCALATED"

if [[ -z "$NEW_LINES" ]]; then
  echo "HEARTBEAT_OK"
else
  echo "ALERT"
  word="recordatorio lleva"
  [[ $COUNT -gt 1 ]] && word="recordatorios llevan"
  echo "🔴 $COUNT $word +${MIN_DAYS}d vencido sin resolver:"
  printf '%b' "$NEW_LINES"
fi
