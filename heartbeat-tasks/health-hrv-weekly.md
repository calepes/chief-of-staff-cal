---
name: health-hrv-weekly
schedule: weekly-monday-am
priority: medium
---

# Check HRV degradada vs baseline 4 semanas

State file: `~/.claude/state/health-alerts-$(date +%Y-%m-%d).json`

Si la key `hrv_degraded` ya existe en el state file de hoy, responde EXACTAMENTE:
HEARTBEAT_OK

Si no existe, consulta el trend de HRV últimos 35 días:

GET https://health.carlos-cb4.workers.dev/trend?metric=heart_rate_variability&days=35&key=$HEALTH_API_KEY

Reglas:
- Worker caído → HEARTBEAT_OK
- Menos de 4 semanas de baseline (data total < 21 días) → HEARTBEAT_OK (no se puede comparar)
- Calcular promedio de la semana actual (últimos 7 días) vs promedio de las 4 semanas previas (días -8 a -35).
- Si promedio_semana_actual >= promedio_baseline * 0.80 → HEARTBEAT_OK
- Si < 0.80 → actualiza state y alerta con el % de drop.

Update state:
```bash
STATE=~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
mkdir -p ~/.claude/state
if [[ -f "$STATE" ]]; then
  jq '.hrv_degraded = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
else
  echo '{"hrv_degraded": true}' > "$STATE"
fi
```

Formato:
ALERT
❤️ HRV bajó {N}% esta semana vs baseline. Considera bajar intensidad o dormir más.

<!-- Test scenario: lunes 8-9am, si HRV semana < 80% del promedio últimas 4 semanas, alerta una vez. Worker caído o baseline insuficiente, silencio. -->
