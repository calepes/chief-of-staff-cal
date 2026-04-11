# Diseño — Agente Telegram "Chief of Staff Cal"

> Documento de diseño. Solo ideas y estructura. Implementación posterior.

## Visión

Un agente accesible via Telegram que actúa como Chief of Staff digital de Cal. Centraliza información de múltiples fuentes, proactivamente prepara y recuerda, y reduce fricción operativa diaria.

## Principios

- **Proactivo, no reactivo** — el agente inicia conversaciones cuando hay algo relevante
- **Contexto acumulativo** — cada interacción alimenta su comprensión del trabajo de Cal
- **Mínima fricción** — voice-first, respuestas concisas, acción > conversación
- **Event-driven** — triggers basados en calendario, hora del día, cambios en Notion
- **Goal-aligned** — cada recomendación referencia objetivos definidos (patrón de mimurchison/claude-chief-of-staff)
- **Triage en niveles** — clasificar acciones en: ejecutar autónomo / requiere aprobación / escalar a Cal

---

## Capacidades

### Tier 1 — Core (implementar primero)

#### Morning Briefing Integrado
- **Trigger:** automático, 7:00 AM BOT
- **Contenido:**
  - Agenda del día (Outlook + Google Calendar)
  - Tareas pendientes urgentes (Notion)
  - Briefing de noticias Bolivia (/briefing-pais)
  - Recordatorios importantes
- **Output:** un solo mensaje estructurado en Telegram

#### Tareas Notion
- Ver tareas pendientes, filtradas por estado/prioridad
- Marcar tareas como completadas
- Crear tareas nuevas desde Telegram (voz o texto)
- Resumen de tareas vencidas o próximas a vencer

#### Reuniones Notion + Calendario
- Ver agenda del día/semana
- Outlook: solo lectura (bloqueado por BCP para escritura)
- Google Calendar: lectura y escritura

#### Prep de Reuniones
- **Trigger:** 30 min antes de reunión importante (Steerco, 1:1, Sync Líderes)
- **Contenido:**
  - Contexto de la reunión
  - Puntos pendientes de la última vez
  - KPIs relevantes
  - Temas sugeridos
- **Output:** mensaje en Telegram con prep

### Tier 2 — Seguimiento

#### Debrief Post-Reunión
- Después de reunión importante, el agente pregunta: "¿Cómo fue [reunión]?"
- Cal responde por voz o texto
- El agente captura: decisiones, action items, observaciones
- Registra en Notion (Meetings + Tareas)

#### Weekly Review (Viernes)
- Resumen de la semana:
  - Tareas completadas vs pendientes
  - Reuniones clave y decisiones
  - KPIs (si hay cambios significativos)
  - Agenda de la próxima semana
- Pregunta: "¿Algo que quieras ajustar para la próxima semana?"

#### Stakeholder Tracker
- Seguimiento de última interacción con stakeholders clave:
  - Rufino Arribas (CBO Yape, jefe directo)
  - Christian Hausher (jefe local BCP)
  - Mateo Musso (COO Yape)
  - Raimundo Morales (Líder Neobanca)
- Alerta si pasa mucho tiempo sin contacto con alguno

#### Readwise Highlights
- Resumen semanal de artículos guardados y highlights
- Curación: qué vale la pena leer en profundidad

### Tier 3 — Backlog (futuro)

#### LinkedIn
- Revisar feed: contenido relevante de la industria fintech
- Notificaciones pendientes
- Mensajes sin responder

#### RSS/News Feed Curado
- Revisar feeds RSS configurados
- Filtrar y presentar solo noticias que valga la pena revisar
- Resumen ejecutivo de cada noticia relevante

#### Google Maps — Alertas de Salida
- Conectar con calendario
- Calcular distancia y tiempo al siguiente evento presencial
- Avisar con tiempo cuándo salir: "Tienes [reunión] en [lugar] a las [hora]. Sal a las [hora] (tráfico actual: [X] min)"

#### Apple Health
- Resumen de métricas: pasos, sueño, actividad
- Contexto para el coaching: "Dormiste 5h, considera no agendar nada pesado hoy"

---

## Infraestructura Requerida

### MCPs necesarios

| MCP | Estado | Uso |
|-----|--------|-----|
| Notion | Conectado | Tareas, reuniones, KPIs, feedback |
| Telegram (plugin nativo) | Conectado | Canal bidireccional |
| Readwise | Conectado | Highlights y artículos |
| Outlook Calendar (ICS) | Configurado | Agenda laboral (solo lectura) |
| Google Calendar | Por configurar | Agenda personal (lectura/escritura) |
| Google Maps API | Por configurar | Distancias y tiempos |
| Whisper (local) | Instalado | Transcripción de audios |

### Herramientas locales

| Herramienta | Estado | Uso |
|-------------|--------|-----|
| whisper-cli | Instalado | Transcribir voice messages |
| ffmpeg | Instalado | Convertir audio OGG -> WAV |
| poppler | Instalado | Leer PDFs |

### Automatización

- **Cron/scheduled triggers** para morning briefing y alertas
- **Event-driven** para prep de reuniones (basado en calendario)
- **On-demand** para consultas ad-hoc via Telegram

---

## Interacción — Ejemplos

```
Cal: "¿Qué tengo hoy?"
→ Agenda del día + tareas urgentes + reuniones

Cal: "Prepárame para el Steerco"
→ Prep con contexto, KPIs, puntos pendientes, temas sugeridos

Cal: (audio después de reunión) "El Steerco fue bien, Rufino aprobó el budget de Q3..."
→ Captura decisiones, crea action items en Notion

Cal: "¿Cuándo fue la última vez que hablé con Mateo?"
→ Busca en Notion meetings/journal, reporta fecha y contexto

Cal: "Recordame mañana llamar a Christian"
→ Crea tarea en Notion + reminder en Google Calendar
```

---

## Arquitectura — Inspirada en Casos Reales

### Fuentes de referencia

| Proyecto | Autor | Qué resuelve | Repo/Link |
|----------|-------|--------------|-----------|
| claude-chief-of-staff | Mike Murchison (CEO Ada) | OS ejecutivo completo: triage, CRM, goals | github.com/mimurchison/claude-chief-of-staff |
| AI Chief of Staff | Alex Honchar | 3 capas: conectores + MCPs + Chrome ext | Medium (Data Science Collective) |
| OpenClaude + Hindsight | Vectorize.io | Memoria estructurada de largo plazo | hindsight.vectorize.io |
| claude-telegram-bot | linuz90 | Bot Telegram completo (voz, fotos, PDFs) | github.com/linuz90/claude-telegram-bot |
| Executive briefing | TechySurgeon | Pipeline de meeting transcripts a inteligencia | techysurgeon.substack.com |
| Server-based agent | Daniil Okhlopkov | Claude Code en servidor 24/7 + Obsidian | okhlopkov.com |
| Scheduled agents | The AI Corner | 6 subagentes paralelos + Google Maps tráfico | the-ai-corner.com |

### Patrones adoptables

#### 1. goals.yaml como fuente de verdad (de mimurchison)
Archivo YAML con objetivos trimestrales. Cada recomendación del agente referencia estos objetivos. Evita drift y mantiene foco.

```yaml
# goals.yaml (ejemplo)
q2_2026:
  - goal: "Crecer DAU a 500K"
    weight: high
    context: "Depende de onboarding y retención"
  - goal: "Lanzar créditos P2P"
    weight: high
    context: "Aprobación regulatoria pendiente"
  - goal: "Consolidar equipo Bolivia"
    weight: medium
    context: "3 posiciones abiertas"
```

#### 2. Triage en niveles (de Honchar + The AI Corner)
Clasificar cada acción en categorías de autonomía:

| Nivel | Descripción | Ejemplo |
|-------|-------------|---------|
| **Dispatch** | Ejecutar autónomo, notificar después | Marcar tarea completada, enviar recordatorio |
| **Prep** | Preparar borrador, Cal aprueba | Draft de email, prep de reunión |
| **Yours** | Solo informar, Cal ejecuta | Decisión estratégica, feedback sensible |
| **Skip** | Ignorar, no vale la atención | Spam, notificaciones irrelevantes |

#### 3. Memoria estructurada (de OpenClaude/Hindsight)
No guardar transcripts completos. Extraer hechos discretos:
- Decisiones tomadas (quién, qué, cuándo)
- Preferencias observadas
- Relaciones entre personas
- Compromisos asumidos

Recuperar por relevancia semántica, no por fecha.

#### 4. Scheduled tasks pre-despertar (de The AI Corner)

```
5:30 AM — Triage de notificaciones overnight
5:45 AM — Parse calendario del día
6:00 AM — Generar briefing de noticias Bolivia
6:30 AM — Compilar morning briefing integrado
7:00 AM — Enviar a Telegram
```

6 subagentes corriendo en paralelo para que el briefing esté listo al despertar.

#### 5. Chrome extension como fallback (de Honchar)
Para plataformas sin MCP dedicado (LinkedIn, WhatsApp web, X), una Chrome extension puede:
- Leer feeds y notificaciones
- Extraer mensajes pendientes
- Publicar contenido

#### 6. Obsidian/vault como segundo cerebro (de Okhlopkov)
Un directorio compartido donde tanto Cal como el agente operan:
- Cal escribe notas, ideas, reflexiones
- El agente indexa, conecta, y surfea información relevante
- Persistencia entre sesiones sin depender de context window

#### 7. contacts/ como CRM ligero (de mimurchison)
Directorio con un archivo por persona clave:

```
contacts/
├── rufino-arribas.md    # CBO Yape, jefe directo
├── christian-hausher.md # Jefe local BCP
├── mateo-musso.md       # COO Yape
└── raimundo-morales.md  # Líder Neobanca
```

Cada archivo: última interacción, temas recurrentes, estilo de comunicación, compromisos pendientes. Se enriquece automáticamente después de cada meeting/debrief.

---

## Siguiente Paso

1. Configurar Google Calendar MCP
2. Crear `goals.yaml` con OKRs de Cal para Q2 2026
3. Implementar morning briefing como primer skill del agente
4. Probar scheduled task para briefing automático a las 7 AM
5. Iterar basado en uso real
