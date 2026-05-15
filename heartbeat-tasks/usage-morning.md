---
name: usage-morning
schedule: morning-wake
priority: low
type: bash
---

#!/usr/bin/env bash
# Presupuesto del día — corre 7-9am, una vez por día
set -uo pipefail

STATE_FILE="$HOME/.claude/state/usage-morning-last.txt"
ENV_FILE="$HOME/.cos-agent/.env"
USAGE_PY="$HOME/.claude/scripts/claude-usage.py"
CHAT_ID="94137698"

[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"
BOT_TOKEN="${COS_TELEGRAM_BOT_TOKEN:-}"
[[ -z "$BOT_TOKEN" ]] && exit 0

TODAY=$(date +%Y-%m-%d)
[[ -f "$STATE_FILE" ]] && [[ "$(cat $STATE_FILE 2>/dev/null)" == "$TODAY" ]] && exit 0

json=$(timeout 25s python3 "$USAGE_PY" json 2>/dev/null) || exit 0
[[ -z "$json" ]] && exit 0

python3 << PYEOF
import json, urllib.request, urllib.parse, sys
from datetime import datetime, timezone, timedelta

data = json.loads('''$json''')

pct      = data['total_pct']
tokens_w = data['local_tokens_w']
limit_w  = tokens_w / (pct / 100) if pct > 0 else tokens_w * 2
h_rem    = data['hours_remaining']
by_day   = data['by_day']

CYCLE_DAYS = 7
budget_day = limit_w / CYCLE_DAYS

def fmt(n):
    if n>=1e9: return f'{n/1e9:.2f}B'
    if n>=1e6: return f'{n/1e6:.0f}M'
    return f'{n/1e3:.0f}K'

def semaforo(w):
    r = w / budget_day
    if r <= 1.0:   return '🟢'
    elif r <= 1.5: return '🟡'
    elif r <= 2.5: return '🟠'
    else:          return '🔴'

dias = {'Monday':'Lu','Tuesday':'Ma','Wednesday':'Mi',
        'Thursday':'Ju','Friday':'Vi','Saturday':'Sa','Sunday':'Do'}

today_local = (datetime.now(timezone.utc) - timedelta(hours=4)).strftime('%Y-%m-%d')
sorted_days = sorted(by_day.keys())
past_days   = [d for d in sorted_days if d < today_local]

days_rem     = max(1, h_rem / 24)
budget_today = (limit_w - tokens_w) / days_rem

# Tendencia ayer vs anteayer
tendencia = '—'
if len(past_days) >= 2:
    yest_w = by_day[past_days[-1]]
    prev_w = by_day[past_days[-2]]
    if yest_w < prev_w * 0.9:   tendencia = '↓ bajando ✅'
    elif yest_w > prev_w * 1.1: tendencia = '↑ subiendo ⚠️'
    else:                        tendencia = '→ estable'

rows = []
for d in sorted_days[-5:]:
    dt  = datetime.strptime(d, '%Y-%m-%d')
    dow = dias.get(dt.strftime('%A'), '??')
    w   = by_day[d]; p = w / limit_w * 100
    marker = ' <b>←hoy</b>'  if d == today_local else ''
    rows.append(f"{semaforo(w)} <code>{dow}{dt.strftime('%d')}  {p:4.1f}%  {fmt(w).rjust(5)}</code>{marker}")

graph = '\n'.join(rows)

msg = (
    f'☀️ <b>Presupuesto · {today_local}</b>\n\n'
    f'Ciclo: <b>{pct:.1f}%</b> usado · reset en {int(h_rem//24)}d{int(h_rem%24)}h\n\n'
    f'📦 <b>Hoy puedes usar: {fmt(budget_today)} tokens</b>\n'
    f'<i>({fmt(limit_w-tokens_w)} restantes ÷ {days_rem:.1f} días)</i>\n\n'
    f'📊 Días del ciclo:\n{graph}\n\n'
    f'Tendencia: {tendencia}'
)

url = 'https://api.telegram.org/bot$BOT_TOKEN/sendMessage'
payload = urllib.parse.urlencode({
    'chat_id': '$CHAT_ID', 'text': msg,
    'parse_mode': 'HTML', 'disable_web_page_preview': 'true',
}).encode()
req = urllib.request.Request(url, data=payload, method='POST')
req.add_header('Content-Type', 'application/x-www-form-urlencoded')
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        resp = json.loads(r.read())
    if not resp.get('ok'):
        sys.stderr.write(f"telegram error: {resp}\n"); sys.exit(1)
except Exception as e:
    sys.stderr.write(f"telegram error: {e}\n"); sys.exit(1)
PYEOF

python_exit=$?
(( python_exit == 0 )) && echo "$TODAY" > "$STATE_FILE"
exit 0
