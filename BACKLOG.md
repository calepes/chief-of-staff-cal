# Backlog — Chief of Staff Cal

## Pendientes

### Referencia: AI Copilot framework (Tal Raviv)
- **Fuente:** Artículo #45 — "Build your personal AI copilot" (Tal Raviv via Lenny's Newsletter)
- **Resumen:** Framework de 4 pasos para construir un AI copilot como thinking partner a largo plazo
  1. **Hire:** Definir rol, personalidad, comportamientos via instructions
  2. **Onboard:** Llenar project knowledge con docs de empresa, equipo, estrategia, customer research
  3. **Kick off:** Un chat thread por iniciativa, context acumulativo
  4. **Work:** Prompts conversacionales ("What's the most important thing I should do next?")
- **Patterns clave:**
  - "Gossiping" al copilot: actualizar contexto informalmente, stream of consciousness, voz
  - Event-driven automations > batch tasks
  - Lessons learned document al final de cada iniciativa → compound interest
  - Context window limit workaround: prompt para resumir y migrar thread preservando 90% del valor
- **Prompts reutilizables:** hiring prompt, onboarding prompt, initiative kickoff, automation brainstorm (todos en el artículo)
- **Aplicar a:** Diseñar el CoS como copilot con context de Yape (equipo, estrategia, OKRs, stakeholders)
- **Doc completo:** `/Users/calepes/Documents/Claude Projects/Claude Code Setup/docs/articulos/01kcy4pypx-tal-raviv-personal-ai-copilot.md`

### Botones inline interactivos — En progreso
- [x] Fork del plugin de Telegram con handler de callback_query
- [x] Callback format: `[callback] prefix:action[:context]`
- [x] Desplegado al cache del plugin
- [x] CLAUDE.md global actualizado con mantenimiento del fork
- [ ] Probar en nueva sesión de Claude Code (reiniciar channel)
- [ ] Menú principal con botones (briefings, tareas, status, Spotify)
- [ ] Flujo de revisión de tareas con botones (completar/cancelar/reprogramar)
- [ ] Aprobaciones rápidas (sí/no)
- [ ] Spec: `docs/superpowers/specs/2026-04-11-telegram-interactive-buttons-design.md`

### Spotify — Control y reproducción desde Telegram
- [ ] Integrar Spotify API (OAuth2, playback control) para manejar música desde el bot de Telegram
- [ ] Comandos: play/pause, skip, volumen, buscar canción/artista/playlist, qué suena ahora
- [ ] Evaluar opciones: Spotify Web API directo, MCP server custom, o Zapier action
- [ ] Requisito: Spotify Premium (necesario para playback control via API)
- [ ] Botones inline para control de reproducción (requiere botones interactivos funcionando)

### Apple Health — Datos de salud desde Telegram
- [ ] Instalar Health Auto Export (iOS, ~$5) para exportar data automáticamente
- [ ] Configurar export a REST API (endpoint en Cloudflare Worker)
- [ ] Definir métricas a trackear: pasos, sueño, peso, ejercicio, frecuencia cardíaca
- [ ] Worker que recibe y almacena data (D1 o KV)
- [ ] Comandos en bot: resumen del día, tendencia semanal, comparación vs objetivos
- [ ] Integrar en briefing /today si aplica

### Futuro
- [ ] Webhook Cloudflare Worker para procesar callback_query server-side (alternativa si el fork del plugin da problemas de mantenimiento)
