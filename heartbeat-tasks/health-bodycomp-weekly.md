---
name: health-bodycomp-weekly
schedule: weekly-monday-am
priority: low
---

# Check body composition semanal

State file: `~/.claude/state/health-alerts-$(date +%Y-%m-%d).json`

Si la key `bodycomp_weekly` ya existe en el state file de hoy, responde EXACTAMENTE:
HEARTBEAT_OK

Si no existe, consulta ambas métricas:

GET https://health.carlos-cb4.workers.dev/trend?metric=body_fat_percentage&days=30&key=$HEALTH_API_KEY
GET https://health.carlos-cb4.workers.dev/trend?metric=lean_body_mass&days=30&key=$HEALTH_API_KEY

Reglas:
- Worker caído (cualquiera de las 2 falla) → HEARTBEAT_OK
- Ambas series sin data → alerta tipo "sin medición"
- Última fecha de cualquiera de las 2 series > 7 días desde hoy → alerta tipo "sin medición"
- Última fecha <= 7 días → alerta tipo "trend":
  - body_fat: último valor vs promedio de los anteriores (excluyendo el último). Delta = último - promedio_previos.
  - lean_body_mass: igual.
  - Si solo hay 1 punto, omite delta (di "primera medición").

Update state SIEMPRE que alertes:
```bash
STATE=~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
mkdir -p ~/.claude/state
if [[ -f "$STATE" ]]; then
  jq '.bodycomp_weekly = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
else
  echo '{"bodycomp_weekly": true}' > "$STATE"
fi
```

Formato sin data:
ALERT
⚖️ Sin medición de body comp en {N} días. Pésate hoy.

Formato con data:
ALERT
⚖️ Body fat: {X}% ({±Y}% vs prom). Lean: {Z}kg ({±W}kg).

<!-- Test scenario: lunes 8-9am. Sin data >7 días, alerta "pésate". Con data fresca, alerta trend. Worker caído, silencio. -->
