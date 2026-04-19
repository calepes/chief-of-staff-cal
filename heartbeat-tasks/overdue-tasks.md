---
name: overdue-tasks
schedule: every
priority: high
---

# Check tareas vencidas

Consulta la base de datos de Notion "Tareas" usando la herramienta MCP notion-query-database-view o notion-fetch.

Filtra tareas que cumplan TODAS estas condiciones:
- Estado distinto de "Hecho", "Cancelado", "Archivado"
- Deadline existe y es estrictamente anterior a hoy (fecha actual del sistema)

Si encuentras 0 tareas vencidas, responde EXACTAMENTE:
HEARTBEAT_OK

Si encuentras 1 o más, responde así (reemplazando N por el número y completando el listado):
ALERT
🚨 N tareas vencidas:
- {nombre} (vencida hace {días} días, asignado: {persona})
- ...

Reglas estrictas:
- No agregues texto antes ni después del bloque
- No expliques, no justifiques, no preguntes
- Si solo hay 1, di "1 tarea vencida"
- Ordena por días vencido descendente (más vencidas primero)

<!-- Test scenario: con tarea de prueba creada en Notion con Deadline=ayer y Estado="En curso", debe alertar. Marcarla como Hecho → siguiente run debe responder HEARTBEAT_OK. -->
