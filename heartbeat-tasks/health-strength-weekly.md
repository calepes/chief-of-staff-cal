---
name: health-strength-weekly
schedule: weekly-monday-am
priority: medium
---

# Check sesiones de fuerza semanal

Meta: 3 sesiones de strength training por semana.

State file: `~/.claude/state/health-alerts-$(date +%Y-%m-%d).json`

Si la key `strength_weekly` ya existe en el state file de hoy, responde EXACTAMENTE:
HEARTBEAT_OK

Si no existe, consulta:

GET https://health.carlos-cb4.workers.dev/workouts/summary?days=7&type=strength&key=$HEALTH_API_KEY

Reglas:
- Worker caído (no responde 200) → HEARTBEAT_OK
- `count >= 3` → HEARTBEAT_OK (meta cumplida)
- `count < 3` → actualiza state y alerta.

Para "última sesión hace N días": del array `workouts` toma el `date` del primer elemento (ya viene ordenado DESC). Si está vacío, calcula desde la última sesión histórica con `?days=90&type=strength`. Si tampoco hay, di "no hay sesiones registradas".

Update state:
```bash
STATE=~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
mkdir -p ~/.claude/state
if [[ -f "$STATE" ]]; then
  jq '.strength_weekly = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
else
  echo '{"strength_weekly": true}' > "$STATE"
fi
```

Formato:
ALERT
💪 Llevas {N} sesiones de fuerza esta semana (meta: 3). Última: hace {D} días.

<!-- Test scenario: lunes 8-9am, si <3 sesiones strength en últimos 7 días, alerta una vez. Worker caído, silencio. -->
