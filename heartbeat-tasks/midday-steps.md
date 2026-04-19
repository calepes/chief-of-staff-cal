---
name: midday-steps
schedule: midday-only
priority: medium
---

# Check pasos al mediodía

Consulta el endpoint del Health worker:

GET https://health.carlos-cb4.workers.dev/summary?date=YYYY-MM-DD&key=$HEALTH_API_KEY

donde YYYY-MM-DD es la fecha de hoy (zona horaria local de Cal). El API key está en la variable de entorno HEALTH_API_KEY.

Usa la herramienta Bash para hacer el curl.

Lee el campo `steps` del JSON.

Si steps >= 3000, responde EXACTAMENTE:
HEARTBEAT_OK

Si steps < 3000, responde así:
ALERT
🚶 Pasos hoy: {steps} (objetivo mediodía: 3000+)

Si el API falla o no hay data, responde EXACTAMENTE:
HEARTBEAT_OK

<!-- Test scenario: si hoy hay <3000 pasos a las 12:00 medio día, alerta. Si >= 3000, silencio. Si Health worker está caído, silencio (no spam). -->
