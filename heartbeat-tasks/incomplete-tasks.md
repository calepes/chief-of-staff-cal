---
name: incomplete-tasks
schedule: morning-only
priority: medium
type: bash
---

#!/usr/bin/env bash
# pipefail NO — echo | python con sys.exit(0) puede matar echo con SIGPIPE → 141
set -u

NOTION_TOKEN=$(grep NOTION_TOKEN ~/.claude/channels/telegram/.env 2>/dev/null | cut -d= -f2)
[[ -z "$NOTION_TOKEN" ]] && { echo "HEARTBEAT_OK"; exit 0; }

DB_ID="1f2c487609dd802985dcd7ad59110ddd"

# Notion API no permite múltiples does_not_equal sobre la misma property en `and`.
# Usamos un único does_not_equal "Listo" a nivel server, el resto filtramos en Python.
RESPONSE=$(curl -s --max-time 15 \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -X POST "https://api.notion.com/v1/databases/$DB_ID/query" \
  -d '{
    "filter": {
      "property": "Estado", "status": { "does_not_equal": "Listo" }
    },
    "page_size": 200
  }' 2>/dev/null)

[[ -z "$RESPONSE" ]] && { echo "HEARTBEAT_OK"; exit 0; }

echo "$RESPONSE" | python3 <<'PY'
import json, sys

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
incomplete = []
for r in results:
    props = r.get("properties", {})
    estado = (props.get("Estado", {}).get("status") or {}).get("name", "")
    if estado in CLOSED:
        continue
    title_arr = props.get("Nombre de tarea", {}).get("title", [])
    name = title_arr[0]["plain_text"] if title_arr else "?"
    asig_prop = props.get("Asignado a", {})
    asig = asig_prop.get("relation", []) or asig_prop.get("people", [])
    dl = props.get("Deadline", {}).get("date", {}) or {}
    dl_str = dl.get("start", "")
    missing = []
    if not asig:
        missing.append("asignado")
    if not dl_str:
        missing.append("deadline")
    if missing:
        incomplete.append((name, missing))

if not incomplete:
    print("HEARTBEAT_OK")
    sys.exit(0)

n = len(incomplete)
top = incomplete[:5]
word = "tarea incompleta" if n == 1 else "tareas incompletas"
print("ALERT")
print(f"📝 {n} {word}:")
for name, missing in top:
    miss_str = " + ".join(missing)
    print(f"- {name} (falta: {miss_str})")
if n > len(top):
    print(f"y {n - len(top)} más...")
PY
