---
name: health-daylight
schedule: late-afternoon
priority: low
---

# Check daylight bajo

State file: `~/.claude/state/health-alerts-$(date +%Y-%m-%d).json`

Si la key `daylight_low` ya existe en el state file de hoy, responde EXACTAMENTE:
HEARTBEAT_OK

Si no existe, consulta:

GET https://health.carlos-cb4.workers.dev/summary?date=YYYY-MM-DD&key=$HEALTH_API_KEY

donde YYYY-MM-DD es HOY.

Busca la métrica `time_in_daylight`. El `total` está en minutos (unidad `min`).

Reglas:
- Worker caído / métrica ausente → HEARTBEAT_OK
- `time_in_daylight.total >= 15` → HEARTBEAT_OK
- `time_in_daylight.total < 15` → actualiza state y alerta.

Update state:
```bash
STATE=~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
mkdir -p ~/.claude/state
if [[ -f "$STATE" ]]; then
  jq '.daylight_low = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
else
  echo '{"daylight_low": true}' > "$STATE"
fi
```

Formato:
ALERT
☀️ Solo {N}min de daylight hoy. Hay 1-2h de sol — sal a caminar.

<!-- Test scenario: 17-18h, si time_in_daylight<15min alerta una vez. Worker caído o métrica ausente, silencio. -->
