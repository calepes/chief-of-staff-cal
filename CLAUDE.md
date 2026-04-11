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
- **Progreso en tareas largas:** Enviar mensaje inicial, editar con cada paso, mensaje final nuevo (para push notification)

## Notion
- **Eisenhower (this week):** Matriz de priorización de tareas de Cal en Yape
- **Base de datos Tareas:** `collection://1f2c4876-09dd-80d2-8c0c-000b7f35059b`
- **Cal person ID:** `https://www.notion.so/2f2fc7e7523043b2b65c19d38f608de7`
- **Vista "Todas activas":** `view://33fc4876-09dd-819b-8397-000cbdf243dc` (creada para queries ad-hoc)

## Briefings
- **Skill:** /briefing-pais — genera HTML Liquid Glass, publica en GitHub Pages, notifica por Telegram
- **Output:** `https://apps.lepesqueur.net/dailynews/{Pais}/{Pais}-{YYYYMMDD}.html`
- **Repo:** calepes.github.io/dailynews/

## Audio
- whisper-cpp instalado con modelo base para transcribir notas de voz de Telegram
