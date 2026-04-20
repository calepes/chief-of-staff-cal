Lee el siguiente transcript de una sesión de Claude Code (formato JSONL: cada línea es un mensaje con `role` y `content`).

Tu tarea: identificar **learnings reales** en esta conversación. Tipos:

- **correction**: Cal corrigió al agente ("no así", "stop", "prefiero X") O validó un approach NO obvio sin pushback ("sí, exacto", "perfecto"). Captura solo cuando la regla puede aplicar a futuras sesiones.
- **decision**: decisión técnica NO trivial que Cal aceptó. Ejemplo: elegir batch nocturno sobre SessionEnd hook, optar por filesystem-RAG en vez de embedding store. NO captures defaults o decisiones obvias.
- **idea**: Cal mencionó una idea en pasada que NO se implementó en esta sesión, pero podría ser interesante después. Ejemplos: "algún día estaría bueno X", "sería útil Y eventualmente".

NO captures:
- Correcciones triviales (typos, formato visual)
- Confirmaciones simples ("ok", "dale", "sigue") sin contexto sustantivo
- Defaults del sistema o decisiones obvias
- Tareas operativas que se completaron en la sesión (eso va a CHANGELOG/git log, no a learnings)

Formato de respuesta — JSON puro, sin markdown, sin texto extra:

```json
[
  {
    "tipo": "correction|decision|idea",
    "descripcion": "máx 80 chars, capturando la regla/decisión/idea en imperativo o declarativo",
    "trigger": "fragmento textual de Cal o del agente que originó esto (≤200 chars)",
    "contexto": "qué se estaba haciendo en ese momento (1-2 frases, ≤200 chars)",
    "tags": ["tag1", "tag2"]
  }
]
```

Tags válidos (elige hasta 3 por entry): telegram, notion, heartbeat, spotify, health, claude-md, scope, ux, oauth, launchd, hooks, skills, batch, extract, archive, callback, callbacks, learnings, plugin, server, worker, mcp, knowledge, docs, sync.

Si no hay nada extraíble en este transcript, responde `[]`.

NO incluyas markdown fences, NO incluyas explicaciones — solo el JSON puro.
