# Inline Buttons & Menu — Design Spec

## Objetivo
Menú principal interactivo, flujo de revisión de tareas con botones, y aprobaciones rápidas via Telegram.

## Decisiones
- **Menú configurable:** Definido en `~/.claude/channels/telegram/menu.json`, editable sin tocar código.
- **Revisión de tareas:** Dos modos — botones (pocas tareas) o lotes de 5 + texto libre (bulk).
- **Todo vive en el LLM:** Este spec no tiene acciones mecánicas en el plugin. Los botones generan callbacks que Claude procesa.

## Componentes

### 1. Menú Principal

**Trigger:** `/menu` o `menu` en Telegram.

**Archivo de config:** `~/.claude/channels/telegram/menu.json`

```json
{
  "rows": [
    [
      {"text": "Briefing Bolivia", "callback_data": "menu:briefing:bolivia"},
      {"text": "Briefing Peru", "callback_data": "menu:briefing:peru"}
    ],
    [
      {"text": "Briefing del dia", "callback_data": "menu:today"}
    ],
    [
      {"text": "Tareas pendientes", "callback_data": "menu:tareas"},
      {"text": "Status", "callback_data": "menu:status"}
    ],
    [
      {"text": "Spotify", "callback_data": "menu:spotify"}
    ]
  ]
}
```

Claude lee este archivo cuando recibe `/menu` y envía el mensaje con el inline keyboard.

### 2. Flujo Revisión de Tareas

**Modo botones (pocas tareas, <10):**
```
📋 5/34 — 🔄 EN CURSO
Reporte Principalidad | 👤 Lorena Velasco
📅 — | ⏰ 20 mar ⚠️

[⏭ Igual] [✅ Lista] [❌ Cancel] [📅 Fecha]
```

Callbacks: `task:skip:{id}`, `task:done:{id}`, `task:cancel:{id}`, `task:date:{id}`

Sub-flujo fecha:
```
[Fecha] [Deadline] [Ambas] [Volver]
```
Luego botones de fechas rápidas + opción texto libre.

**Modo lotes (bulk, >10):**
Lotes de 5 tareas con número, estado, asignado, deadline.
Cal responde en texto libre: "21 deadline fin de mes, 22 cancel, 23 lista"
Claude procesa todas en paralelo.

Claude decide el modo según cantidad de tareas.

### 3. Aprobaciones Rápidas

Cuando Claude necesita confirmación para una acción:
```
¿Confirmas enviar el briefing a todo el equipo?

[Sí] [No]
```

Callback: `approve:yes:{context}` o `approve:no:{context}`

### 4. Info en mensajes de tareas

Siempre incluir:
- Estado con emoji (🔄 en curso, ⏸ sin empezar, 🎯 focus, ⏳ waiting)
- 👤 Asignado
- 📅 Fecha y ⏰ Deadline
- ⚠️ si deadline vencido

## Mapeo de personas

Claude mantiene en contexto el mapeo de Notion person page IDs → nombres. Se resuelve al inicio del flujo de tareas consultando las páginas de People en Notion.

## Testing
1. Enviar `/menu` → verificar que aparecen botones del menu.json
2. Tocar "Tareas pendientes" → Claude muestra flujo de tareas
3. Probar modo botones con <10 tareas
4. Probar modo lotes con >10 tareas
5. Probar aprobación rápida
