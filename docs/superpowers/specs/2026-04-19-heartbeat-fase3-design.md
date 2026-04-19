# Heartbeat Fase 3 — Design

**Fecha:** 2026-04-19
**Status:** aprobado por Cal en brainstorming
**Backlog refs:** Fase 3.1 (Heartbeat 30min), 3.2 (Heartbeat tasks .md), 3.3 (Proactive Ideas)

## Objetivo

Hacer al CoS proactivo: que detecte cosas que merecen tu atención y te las traiga sin que las tengas que pedir. Tres componentes independientes que comparten la misma filosofía: razonar antes de notificar.

## Decisiones del brainstorming

| Pregunta | Respuesta |
|---|---|
| Ventana horaria del heartbeat | 7am–10pm cada 30min (B) |
| Checks V1 | Tareas vencidas, vuelo <24h sin check-in, tareas sin asignado/deadline, health <3000 pasos al mediodía |
| Anti-spam | Cada heartbeat alerta si el item sigue abierto (C). Consolidado en 1 mensaje por heartbeat. |
| Tipo de proactive ideas | Basadas en posts propios de X (Free API) + Threads (Meta API) (A) |
| Schedule proactive ideas | 9am foco / 14:00 tactical / 19:00 lookahead |
| Notion DB para ideas | Crear DB nueva "Ideas" |
| Arquitectura | Distribuida en .md por check (A) |

## Arquitectura

Tres componentes independientes:

```
~/.claude/
├── hooks/
│   ├── heartbeat.sh              # engine 3.1
│   ├── proactive-ideas.sh        # engine 3.3
│   └── heartbeat-status.sh       # observabilidad
├── heartbeat-tasks/              # 3.2
│   ├── overdue-tasks.md
│   ├── flight-checkin.md
│   ├── incomplete-tasks.md
│   └── midday-steps.md
└── logs/
    └── heartbeat.log
```

LaunchAgents nuevos:
- `com.claude.heartbeat` — cada 30min entre 7am–10pm
- `com.claude.proactive-ideas` — 09:00, 14:00, 19:00

## 3.1 — Heartbeat engine

**Trigger:** launchd `com.claude.heartbeat`, cada 30min en ventana 7am–10pm.

**Loop por heartbeat:**
1. Itera cada `.md` en `~/.claude/heartbeat-tasks/`.
2. Lee el frontmatter del .md (`name`, `schedule`, `priority`).
3. Filtra por `schedule`:
   - `every` → corre siempre
   - `morning-only` → solo en heartbeats antes de las 12pm
   - `midday-only` → solo en el heartbeat de las 12:00 (uno al día)
   - `afternoon-only` → solo después de las 12pm
4. Para los que pasan el filtro: ejecuta `claude -p < $check.md` con `gtimeout 60s`.
5. Lee el output:
   - Si empieza con `ALERT` → agrega el resto al buffer junto con su `priority`.
   - Si empieza con `HEARTBEAT_OK` → ignora.
   - Cualquier otro output → loguea como warning, ignora.
6. Si un check falla (timeout, exit ≠ 0) → loguea, sigue con los demás.
7. Al terminar todos: si el buffer tiene algo, envía 1 sólo mensaje a Telegram ordenado por priority (high → medium → low). Si está vacío, silencio.

**Fallback de salud del propio engine:** si 3 heartbeats consecutivos terminan con todos los checks fallando → `curl` a Telegram (sin Claude) con `⚠️ heartbeat caído`. Estado se guarda en `~/.claude/state/heartbeat-failures` (contador reset cuando 1 check vuelve a OK).

## 3.2 — Heartbeat tasks (.md)

**Shape de cada archivo:**

```markdown
---
name: overdue-tasks
schedule: every
priority: high
---

# Check tareas vencidas

Consulta Notion DB "Tareas" vía MCP. Filtra: Estado != "Hecho" AND Deadline < hoy.

Si hay alguna, responde EXACTAMENTE así:
ALERT
🚨 N tareas vencidas:
- [nombre] (vencida hace X días)
...

Si no hay nada, responde solo: HEARTBEAT_OK
```

El cuerpo es un prompt natural que `claude -p` ejecuta. Cada .md es self-contained: tiene su propia lógica de query, su propio criterio de "merece alerta", su propio formato de output. El engine no sabe qué hace cada uno; solo lee el output.

**V1 — 4 archivos:**

1. **overdue-tasks.md** (every, high)
   - Notion DB Tareas, filtro Estado != Hecho AND Deadline < hoy
2. **flight-checkin.md** (every, high)
   - Google Calendar `c_4c2ogsnda3b61k1sd9eta6vc2k@group.calendar.google.com`, próximas 24h, evento con booking code, sin tag "Check-in hecho" (heurística simple por ahora)
3. **incomplete-tasks.md** (morning-only, medium)
   - Notion DB Tareas, filtro: sin Asignado OR sin Deadline (excluye archivadas)
4. **midday-steps.md** (midday-only, medium)
   - GET `https://health.carlos-cb4.workers.dev/summary?date=hoy`. Si steps < 3000, alerta.

Cada .md termina con un comentario `<!-- Test scenario: ... -->` describiendo cómo verificarlo manualmente.

## 3.3 — Proactive Ideas

**Setup auth (precondición manual):**
- X (Free): crear app en developer.twitter.com → `X_BEARER_TOKEN`, `X_USER_ID`. Free tier: 100 reads de tu cuenta/mes (suficiente para 3x/día = 90/mes).
- Threads (Meta): crear app en developers.facebook.com → long-lived `THREADS_TOKEN`, `THREADS_USER_ID`.
- Tokens en `~/.claude/channels/telegram/.env` (mismo lugar que el resto).

**Flujo (`proactive-ideas.sh`):**
1. Bash mecánico hace los queries:
   - GET últimos posts propios de X (últimas 24h)
   - GET últimos posts propios de Threads (últimas 24h)
   - GET tareas activas de Notion
   - GET eventos de Google Calendar + Outlook cache
2. Construye un prompt con todo el contexto + el slot del día (foco/tactical/lookahead).
3. 1 invocación a `claude -p` con prompt diseñado para ese slot.
4. Output esperado: JSON con `{title, body, source}`.
5. Bash lee el JSON y:
   - Crea página en Notion DB "Ideas" con `Título`, `Cuerpo`, `Fecha`, `Source`, `Estado=pending`.
   - Envía mensaje a Telegram con la idea.

**Schedule:**
- 09:00 — "foco del día": dado lo que publicaste y tienes en agenda, ¿qué es la 1 cosa más importante hoy?
- 14:00 — "tactical alert": vs el plan de la mañana, ¿qué se está atrasando? 1 ajuste sugerido.
- 19:00 — "lookahead mañana": síntesis del día + 1-2 preparativos para mañana.

**Notion DB "Ideas Proactivas (CoS)" (creada 2026-04-19, ID `59e0439d7fe0483ab735575b9e0c1007`, anidada bajo página "💡 Ideas" en Areas/Cal):**
- Título (title)
- Cuerpo (rich_text)
- Fecha (date)
- Source (select: X, Threads, Calendar, Health, Mixto)
- Slot (select: foco, tactical, lookahead)
- Estado (status default Notion: "Sin empezar", "En curso", "Listo")

## Testing

- `heartbeat.sh --dry-run` — corre todos los checks pero no envía a Telegram. Imprime el mensaje que hubiera enviado.
- `heartbeat.sh --only overdue-tasks` — corre solo 1 check. Útil para iterar.
- `proactive-ideas.sh --dry-run --slot foco` — fuerza el slot, imprime sin enviar.
- Cada `.md` documenta su escenario de éxito en el comentario final.

## Errores y observabilidad

**Logs:** `~/.claude/logs/heartbeat.log` con rotación a 5MB (mismo patrón que `notion-audit.log`). Cada línea: timestamp, check name, status (ok/alert/timeout/error), duración.

**Timeouts:** `gtimeout 60s` por check. Si se mata, se loguea como `timeout`.

**Aislamiento de fallos:** un check que falla NO bloquea los demás. El engine loguea y sigue.

**Salud del engine:** `state/heartbeat-failures` cuenta heartbeats consecutivos donde TODOS los checks fallaron. A los 3 → curl directo a Telegram con `⚠️ heartbeat caído` (sin Claude, para evitar dependencia circular). Reset cuando 1 check vuelve a OK.

**Comando de status:** `heartbeat-status.sh` muestra:
- Último run (fecha/hora)
- Próximo run programado
- Checks activos (lista de .md)
- Últimos 5 alerts enviados
- Failure count actual

## Bloqueadores / precondiciones

1. Crear apps de X (developer.twitter.com) y Threads (developers.facebook.com), generar tokens.
2. Compartir DB "Ideas" nueva con la integración "Claude CoS" en Notion.
3. Verificar que el plugin telegram tiene reachability para `curl` directo (fallback de salud).

## Out of scope (futuro)

- Alertas escaladas (ya volveremos cuando V1 demuestre que C es viable).
- Webhooks event-driven (Fase 4 separada).
- Integración con feed completo de X (requiere $200/mes de API).
- Aprender qué tipo de ideas Cal acepta vs descarta para mejorar prompts (Fase 5 self-improving).
