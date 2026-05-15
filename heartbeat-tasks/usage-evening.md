---
name: usage-evening
schedule: every
priority: low
type: bash
---

#!/usr/bin/env bash
# Cierre del día — corre entre 22:00 y 23:00, una vez por día
set -uo pipefail

HOUR_UTC=$(date -u +%H)
HOUR_LOCAL=$(( (10#$HOUR_UTC - 4 + 24) % 24 ))
(( HOUR_LOCAL < 22 || HOUR_LOCAL >= 23 )) && exit 0

STATE_FILE="$HOME/.claude/state/usage-evening-last.txt"
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
burn     = data.get('local_burn_per_h', 0)
by_day   = data['by_day']

tokens_rem = limit_w - tokens_w
eta_h = tokens_rem / burn if burn > 0 else None

CYCLE_DAYS = 7
budget_day = limit_w / CYCLE_DAYS

def fmt(n):
    if n>=1e9: return f'{n/1e9:.2f}B'
    if n>=1e6: return f'{n/1e6:.0f}M'
    return f'{n/1e3:.0f}K'

def fmt_h(h):
    h=max(0,h); d=int(h//24); hr=int(h%24)
    return f'{d}d{hr}h' if d>0 else f'{hr}h'

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

today_w = by_day.get(today_local, 0)
yest_w  = by_day.get(past_days[-1], 0) if past_days else 0
prev_w  = by_day.get(past_days[-2], 0) if len(past_days) >= 2 else 0

tend_hoy  = ('↓ mejor que ayer ✅' if today_w < yest_w*0.85
             else ('↑ más que ayer ⚠️' if today_w > yest_w*1.15 else '→ similar a ayer'))
tend_hist = ('↓ bajando ✅' if yest_w < prev_w*0.85
             else ('↑ subiendo ⚠️' if yest_w > prev_w*1.15 else '→ estable')) if prev_w else '—'

days_rem       = max(1, h_rem / 24)
budget_mañana  = (limit_w - tokens_w) / days_rem
ratio_hoy      = today_w / budget_day

ciclo_ico = '🟢' if pct<50 else ('🟡' if pct<70 else ('🟠' if pct<85 else '🔴'))

rows = []
for d in sorted_days:
    dt  = datetime.strptime(d, '%Y-%m-%d')
    dow = dias.get(dt.strftime('%A'), '??')
    w   = by_day[d]; p = w / limit_w * 100
    marker = ' <b>←hoy</b>' if d == today_local else ''
    rows.append(f"{semaforo(w)} <code>{dow}{dt.strftime('%d')}  {p:4.1f}%  {fmt(w).rjust(5)}</code>{marker}")

graph = '\n'.join(rows)

eta_line = (f'\n🚨 <b>ETA al 100%: en {fmt_h(eta_h)}</b> — llega antes del reset'
            if eta_h and eta_h < h_rem else
            '\n✅ Sin riesgo de llegar al 100% antes del reset')

msg = (
    f'🌙 <b>Cierre del día · {today_local}</b>\n\n'
    f'📊 Ciclo completo:\n{graph}\n\n'
    f'Hoy ({fmt(today_w)}): {semaforo(today_w)} {ratio_hoy:.1f}x presupuesto → {tend_hoy}\n'
    f'Tendencia general: {tend_hist}'
    + eta_line +
    f'\n\n{ciclo_ico} Ciclo: <b>{pct:.1f}%</b> · reset en {fmt_h(h_rem)}\n'
    f'☀️ Mañana: presupuesto <b>{fmt(budget_mañana)} tokens</b>'
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
