---
name: incomplete-tasks
schedule: morning-only
priority: medium
---

# Check tareas incompletas (sin asignado o sin deadline)

Consulta la base de datos de Notion "Tareas" usando MCP.

Filtra tareas que cumplan TODAS estas condiciones:
- Estado distinto de "Hecho", "Cancelado", "Archivado"
- (Asignado está vacío) O (Deadline está vacío)

Si encuentras 0, responde EXACTAMENTE:
HEARTBEAT_OK

Si encuentras 1 o más, responde así:
ALERT
📝 N tareas incompletas:
- {nombre} (falta: {asignado y/o deadline})
- ...

Reglas:
- Máximo 5 items en el listado. Si hay más, agregar "y M más..." al final.
- No expliques.

<!-- Test scenario: crear tarea en Notion sin Asignado y sin Deadline, Estado="Backlog". Debe alertar (solo en runs antes de las 12pm). -->
