Resumen del BACKLOG.md del proyecto agrupado para decisión rápida.

## Instrucciones

1. Lee `BACKLOG.md` de la raíz del proyecto actual (working directory).
2. Ignora items marcados `[x]` (completados) — solo resume pendientes.
3. Agrupa pendientes por:
   - **Fase / sección** (si el backlog ya tiene secciones tipo `## Fase 3`, `## UX Telegram`, etc. — respetar esa estructura)
   - Dentro de cada sección, ordena por tamaño estimado: 🟢 chicos (<1h), 🟡 medianos (1-4h), 🔴 grandes (>4h). Si el BACKLOG no tiene estimados, inferir del scope de la descripción.
4. Output para Telegram (si la sesión tiene channel activo) o inline si es sesión terminal. Formato:

```
📋 Backlog — <proyecto>

<sección 1>
🟢 <item corto>
🟡 <item mediano>
🔴 <item grande>

<sección 2>
...

💡 Sugerencia: <1-2 items prioritarios basado en dependencias, bloqueos, o low-hanging fruit>
```

5. **Si Cal pasa argumento** (`{{args}}`), filtrar:
   - `{{args}}` = nombre de fase/sección → mostrar solo esa
   - `{{args}}` = `chicos` / `grandes` / `medianos` → filtrar por tamaño
   - `{{args}}` = palabra clave → grep case-insensitive en descripciones

6. Al final, pregunta abierta: "¿Arrancamos con alguno?" — no asumas qué quiere hacer.

## Reglas

- Máximo ~15 items en total. Si hay más, resumir los restantes como "+N items adicionales en backlog".
- No leer specs/plans completos — solo lo que está en BACKLOG.md.
- Si el archivo no existe o está vacío, avisar y sugerir crear uno.
- Nunca modificar el BACKLOG en este skill — solo lectura.

## Ejemplos de invocación

- `/backlog` — resumen completo
- `/backlog fase 5` — solo Fase 5
- `/backlog chicos` — solo items rápidos
- `/backlog telegram` — items que mencionen telegram
