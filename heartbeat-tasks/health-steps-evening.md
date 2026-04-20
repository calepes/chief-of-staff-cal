---
name: health-steps-evening
schedule: evening
priority: medium
---

# Check pasos atrasados al final del día

State file: `~/.claude/state/health-alerts-$(date +%Y-%m-%d).json`

Si la key `steps_evening` ya existe en el state file de hoy, responde EXACTAMENTE:
HEARTBEAT_OK

Si no existe, consulta los pasos de hoy:

GET https://health.carlos-cb4.workers.dev/summary?date=YYYY-MM-DD&key=$HEALTH_API_KEY

donde YYYY-MM-DD es HOY.

Reglas:
- Worker caído / métrica ausente → HEARTBEAT_OK
- `step_count.total >= 6000` → HEARTBEAT_OK
- `step_count.total < 6000` → actualiza state y alerta.

Update state:
```bash
STATE=~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
mkdir -p ~/.claude/state
if [[ -f "$STATE" ]]; then
  jq '.steps_evening = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
else
  echo '{"steps_evening": true}' > "$STATE"
fi
```

Formato:
ALERT
🚶 Vas en {N} pasos. Te faltan {M} para 8k. Tienes 2-3h.

<!-- Test scenario: a las 17-19h, si step_count<6000 alerta una vez. Worker caído o métrica ausente, silencio. -->
