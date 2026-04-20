---
name: overdue-tasks
schedule: every
priority: high
type: bash
---

#!/usr/bin/env bash
# pipefail NO — echo | python con sys.exit(0) puede matar echo con SIGPIPE → 141
set -u

NOTION_TOKEN=$(grep NOTION_TOKEN ~/.claude/channels/telegram/.env 2>/dev/null | cut -d= -f2)
[[ -z "$NOTION_TOKEN" ]] && { echo "HEARTBEAT_OK"; exit 0; }

DB_ID="1f2c487609dd802985dcd7ad59110ddd"
TODAY=$(date +%Y-%m-%d)

# Nota: Notion API no soporta múltiples `does_not_equal` sobre la misma property en `and`.
# Filtramos Estado en Python abajo en vez de server-side.
RESPONSE=$(curl -s --max-time 15 \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -X POST "https://api.notion.com/v1/databases/$DB_ID/query" \
  -d '{
    "filter": {
      "property": "Deadline", "date": { "before": "'"$TODAY"'" }
    },
    "sorts": [{ "property": "Deadline", "direction": "ascending" }],
    "page_size": 100
  }' 2>/dev/null)

[[ -z "$RESPONSE" ]] && { echo "HEARTBEAT_OK"; exit 0; }

# Filtrar solo tareas asignadas a Cal (Notion person ID: 2f2fc7e7523043b2b65c19d38f608de7)
echo "$RESPONSE" | python3 <<'PY'
import json, sys
from datetime import date

CAL_ID = "2f2fc7e7-5230-43b2-b65c-19d38f608de7"
CAL_ID_NODASH = CAL_ID.replace("-", "")
today = date.today()

try:
    data = json.loads(sys.stdin.read())
except Exception:
    print("HEARTBEAT_OK")
    sys.exit(0)

if "error" in data:
    print("HEARTBEAT_OK")
    sys.exit(0)

results = data.get("results", [])
CLOSED = {"Listo", "Hecho", "Done", "Completada", "Completado", "Cancelada", "Cancelado", "Archivado"}
overdue = []
for r in results:
    props = r.get("properties", {})
    # Filtrar estados cerrados
    estado = (props.get("Estado", {}).get("status") or {}).get("name", "")
    if estado in CLOSED:
        continue
    # Asignado: only Cal. Schema actual es `relation`, no `people`.
    asig_prop = props.get("Asignado a", {})
    asig = asig_prop.get("relation", []) or asig_prop.get("people", [])
    asig_ids = [p.get("id", "").replace("-", "") for p in asig]
    if CAL_ID_NODASH not in asig_ids:
        continue
    # Nombre
    title_arr = props.get("Nombre de tarea", {}).get("title", [])
    name = title_arr[0]["plain_text"] if title_arr else "?"
    # Deadline
    dl = props.get("Deadline", {}).get("date", {}) or {}
    dl_str = dl.get("start", "")
    if not dl_str:
        continue
    try:
        y, m, d = [int(x) for x in dl_str.split("-")[:3]]
        dl_date = date(y, m, d)
    except Exception:
        continue
    if dl_date >= today:
        continue
    days = (today - dl_date).days
    overdue.append((days, name))

if not overdue:
    print("HEARTBEAT_OK")
    sys.exit(0)

overdue.sort(key=lambda x: -x[0])
top = overdue[:8]
n = len(overdue)
word = "tarea vencida" if n == 1 else "tareas vencidas"
print("ALERT")
print(f"🚨 {n} {word}:")
for days, name in top:
    suffix = "hace 1 día" if days == 1 else f"hace {days} días"
    print(f"- {name} ({suffix})")
if n > len(top):
    print(f"... y {n - len(top)} más")
PY
