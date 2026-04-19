---
name: flight-checkin
schedule: every
priority: high
---

# Check vuelos próximos sin check-in

Consulta el Google Calendar "AntoCataNoeCal" (id `c_4c2ogsnda3b61k1sd9eta6vc2k@group.calendar.google.com`) usando la herramienta MCP gcal_list_events.

Rango: ahora hasta ahora + 24 horas.

Filtra eventos que cumplan TODAS estas condiciones:
- Tienen un booking code en el título o descripción (formato típico: 6 caracteres alfanuméricos en mayúsculas, ej XYZ123)
- NO mencionan "check-in hecho" ni "✅" ni "boarding pass" en título o descripción

Si encuentras 0 vuelos pendientes de check-in, responde EXACTAMENTE:
HEARTBEAT_OK

Si encuentras 1 o más, responde así:
ALERT
✈️ Check-in pendiente:
- {ruta} {hora} (booking: {código}, sale en {horas}h)
- ...

Reglas:
- No expliques, no preguntes
- Hora en formato HH:mm zona local
- Si "horas" calculadas son <2, agrega "⚠️ urgente" al final de la línea

<!-- Test scenario: crear evento de prueba en el calendario "AntoCataNoeCal" con título "LPB-LIM XYZ123" y fecha 12h en el futuro. Debe alertar. -->
