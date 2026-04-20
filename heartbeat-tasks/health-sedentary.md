---
name: health-sedentary
schedule: business-hours
priority: low
---

# Check sedentarismo (sin levantarse 2h)

State file: `~/.claude/state/health-alerts-$(date +%Y-%m-%d).json`

Si la key `sedentary` ya existe en el state file de hoy, responde EXACTAMENTE:
HEARTBEAT_OK

Si no existe, consulta:

GET https://health.carlos-cb4.workers.dev/summary?date=YYYY-MM-DD&key=$HEALTH_API_KEY

donde YYYY-MM-DD es HOY.

Busca la métrica `apple_stand_hour`. El `total` es el total de stand hours hoy.

Heurística (Apple registra stand_hour por hora del día como puntos):
- Worker caído / métrica ausente → HEARTBEAT_OK
- Si `apple_stand_hour.samples < 1` en las últimas 2h del día → alerta. (Aproximación: si estamos a las H actuales, comparar `apple_stand_hour.total` ahora vs lo esperable.)

Versión simple v1: Si `apple_stand_hour.samples` total del día < (hora_actual - 7) * 0.7 → alerta. (Esperamos al menos 70% de stand hours desde las 7am.)

Si la métrica no permite distinguir las últimas 2h, usar la heurística simplificada.

Update state:
```bash
STATE=~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
mkdir -p ~/.claude/state
if [[ -f "$STATE" ]]; then
  jq '.sedentary = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
else
  echo '{"sedentary": true}' > "$STATE"
fi
```

Formato:
ALERT
🪑 Llevas tiempo sin levantarte. Stand 1 min.

<!-- Test scenario: 10-19h Lun-Vie, si stand hours del día son bajos, alerta una vez. Worker caído, silencio. -->
