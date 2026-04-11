# Chief of Staff Cal

## Qué es
Chief of Staff digital para Cal — claridad y foco operativo. AI copilot que conoce el contexto de Yape, el equipo, los stakeholders, y las iniciativas en curso para ayudar con decisiones, priorización, preparación de reuniones, y seguimiento.

## Referencia clave
El diseño de este CoS se basa en el framework de Tal Raviv ("Build your personal AI copilot"):
- **Guía de implementación:** `guia-implementacion-copilot.md` — checklist detallado paso a paso
- **Backlog:** `BACKLOG.md`
- **Artículo procesado:** `/Users/calepes/Documents/Claude Projects/Claude Code Setup/docs/articulos/01kcy4phpx-tal-raviv-personal-ai-copilot.md`

## Context de Yape
Ver: `/Users/calepes/Documents/Claude Projects/Yape/CLAUDE.md`

## Telegram Bot (@calclaudecode_bot)
- **Menú de comandos:** /briefing_bolivia, /briefing_peru, /today, /status, /tareas
- **Botones inline interactivos:** Fork del plugin con soporte para callbacks (ver sección fork en ~/.claude/CLAUDE.md)
- **Botones inline en reply:** El tool `reply` del fork soporta parámetro `buttons` — array de filas, cada fila array de `{text, callback_data}`. El keyboard se adjunta al último chunk.
- **Callback format:** `[callback] prefix:action[:context]` — prefixes: menu, task, approve, spotify, nav
- **Callback optimization:** Prefijos mecánicos (t:d, t:c, t:s, t:sd) se procesan directo en el plugin via Notion API (~200ms). El resto pasa al LLM. Módulos: `callback-router.ts`, `notion-client.ts`
- **Notion token:** en `~/.claude/channels/telegram/.env` como `NOTION_TOKEN`
- **Progreso en tareas largas:** Enviar mensajes nuevos (no editar) para que cada update genere push notification

### Flujos de revisión de tareas
- **<10 tareas:** Botones inline uno por uno con estado, asignado, deadline, emojis
- **>10 tareas:** Lotes de 5 + texto libre. Incluir: nombre, estado emoji, 👤 asignado, ⏰ deadline, ⚠️ si vencido
- **Callbacks mecánicos:** Usar pageId completo (32 hex) en callback_data (t:d:{id32}, t:c:{id32}, t:s:{id32})
- **Callbacks que requieren input:** Pasar al LLM (task:date, task:change, etc.)
- **Mapeo personas:** Al inicio del flujo, resolver Notion person page IDs → nombres

## Notion
- **Eisenhower (this week):** Matriz de priorización de tareas de Cal en Yape
- **Base de datos Tareas:** `collection://1f2c4876-09dd-80d2-8c0c-000b7f35059b`
- **Cal person ID:** `https://www.notion.so/2f2fc7e7523043b2b65c19d38f608de7`
- **Vista "Todas activas":** `view://33fc4876-09dd-819b-8397-000cbdf243dc` (creada para queries ad-hoc)

## Briefings
- **Skill:** /briefing-pais — genera HTML Liquid Glass, publica en GitHub Pages, notifica por Telegram
- **Output:** `https://apps.lepesqueur.net/dailynews/{Pais}/{Pais}-{YYYYMMDD}.html`
- **Repo:** calepes.github.io/dailynews/

## Apple Health
- **Worker:** `https://health.carlos-cb4.workers.dev`
- **API Key:** en `~/.claude/channels/telegram/.env` como `HEALTH_API_KEY`
- **Endpoints:**
  - `POST /ingest` — recibe data de Health Auto Export (header X-Health-Key)
  - `GET /summary?date=YYYY-MM-DD` — resumen del día
  - `GET /trend?metric=X&days=N` — tendencia
- **Métricas:** steps, sleep, weight, heart_rate, calories, distance
- **Uso en /today:** incluir sección 🏥 Salud si hay data disponible
- **Triggers naturales:** "cómo dormí", "pasos hoy", "salud semana", "peso"

## Audio
- whisper-cpp instalado con modelo base para transcribir notas de voz de Telegram
