---
name: health-sleep
schedule: morning-wake
priority: high
---

# Check sueño bajo

State file: `~/.claude/state/health-alerts-$(date +%Y-%m-%d).json`

Si la key `sleep_low` ya existe en el state file de hoy, responde EXACTAMENTE:
HEARTBEAT_OK

Si no existe, consulta el sueño de anoche:

GET https://health.carlos-cb4.workers.dev/summary?date=YYYY-MM-DD&key=$HEALTH_API_KEY

donde YYYY-MM-DD es HOY (la métrica `sleep_totalSleep` se asocia al día en que despiertas).

Reglas:
- Worker caído / métrica ausente → HEARTBEAT_OK
- `sleep_totalSleep.total >= 6` (horas) → HEARTBEAT_OK
- `sleep_totalSleep.total < 6` → actualiza state y alerta.

Update state:
```bash
STATE=~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
mkdir -p ~/.claude/state
if [[ -f "$STATE" ]]; then
  jq '.sleep_low = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
else
  echo '{"sleep_low": true}' > "$STATE"
fi
```

Formato:
ALERT
😴 Anoche dormiste {N}h {M}min. Considera siesta o cama temprano hoy.

<!-- Test scenario: a las 7-9am, si sleep_totalSleep<6h alerta una vez. Worker caído o métrica ausente, silencio. -->
