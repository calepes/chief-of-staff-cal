Captura un learning del CoS al filesystem indexado en `~/.claude/learnings/cos/`.

Sintaxis: `/learn <tipo> "<descripción>"`

Tipos válidos: `correction | decision | idea | error | pattern`

Procesamiento:

1. Parsea `tipo` y `descripción` del input. Si tipo inválido o descripción <5 chars → error claro y para.
2. Determina el `trigger` (qué dijo Cal o qué tool gatilló esto) y el `contexto` (qué se estaba haciendo) del histórico reciente de la conversación.
3. Infiere 1-3 tags relevantes del contexto (tools usados, dominios: telegram, notion, heartbeat, claude-md, spotify, health, etc.).
4. Source la library y usa `append_entry`:
   ```bash
   source ~/.claude/hooks/learnings-lib.sh

   # Verificar dedup primero
   if is_duplicate "<tipo>" "<descripción>"; then
     echo "ℹ️ entry similar ya existe, skip"
     exit 0
   fi

   id=$(append_entry "<tipo>" "<descripción>" "<trigger>" "<contexto>" "/learn" "<tags_csv>")
   echo "✓ captured $id"
   ```
5. Confirma al usuario con el ID generado y la línea agregada al index.

Reglas importantes:

- NO captures correcciones triviales (typos, formato visual, ortografía)
- NO captures decisiones obvias o defaults del sistema
- Si `tipo=error` y la descripción menciona un comando que falló, incluye el exit code y stderr en `trigger`
- Si `tipo=pattern` y se invoca explícitamente, esto es excepcional (el batch nocturno detecta patterns) — confirmar que vale la pena antes de proceder
