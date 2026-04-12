# Research: OpenClaw — Implementaciones reales para el CoS

**Fecha:** 2026-04-12
**Fuentes:** MacStories (Viticci), Claire Vo, OpenClaw docs, ClawHub, GitHub, blogs

## Fuentes consultadas

- [MacStories - Advanced Tips for OpenClaw](https://www.macstories.net/) — Viticci
- [MacStories - OpenClaw: What the Future Looks Like](https://www.macstories.net/) — Viticci
- [OpenClaw Docs - Heartbeat](https://docs.openclaw.ai/gateway/heartbeat)
- [OpenClaw Docs - Scheduled Tasks/Cron](https://docs.openclaw.ai/automation/cron-jobs)
- [OpenClaw Docs - Sub-Agents](https://docs.openclaw.ai/tools/subagents)
- [clawhip - event router](https://github.com/Yeachan-Heo/clawhip)
- [openclaw-agents - 9 specialized agents](https://github.com/shenhao-stu/openclaw-agents)
- [ClawHub - self-improving skill](https://clawhub.ai/pskoett/self-improving-agent)
- [awesome-openclaw-usecases - family calendar](https://github.com/hesamsheikh/awesome-openclaw-usecases)
- [LumaDock - GitHub automation](https://lumadock.com/tutorials/openclaw-github-automation-pr-reviews-ci-monitoring)
- [agentmail - Gmail integration](https://www.agentmail.to/blog/connect-openclaw-to-gmail)
- [Claire Vo - Why OpenClaw feels alive](https://twitter.com/clairevo)
- [OpenClaw complete guide](https://read.readwise.io/read/01kn6y3p7d99bd8re182487t8w)
- [You Don't Need Claude Cowork (lessons.md)](https://read.readwise.io/read/01kf941574d2mxs9mn590pngs9)
- [Stack Junkie - Cron jobs guide](https://www.stack-junkie.com/blog/openclaw-cron-jobs-automation-guide)
- [Blink Blog - Heartbeat config](https://blink.new/blog/openclaw-heartbeat-soul-memory-configuration-guide-2026)

## Key patterns

### Heartbeat vs Cron
- **Heartbeat:** razona sobre contexto antes de actuar, responde HEARTBEAT_OK si no hay nada
- **Cron:** ejecuta ciegamente a la hora programada
- Usar heartbeat para monitoreo continuo, cron para rutinas fijas

### Heartbeat tasks como Markdown
Viticci usa `heartbeat-tasks/` con un .md por tarea. El agente lee la carpeta y decide cuáles ejecutar según la hora y contexto. Para tareas complejas invoca subagentes en paralelo.

### Self-improving con .learnings/
ClawHub skill crea: LEARNINGS.md, ERRORS.md, FEATURE_REQUESTS.md. Triggers: fallo, corrección del usuario, API que falla. Entradas con ID, timestamp, prioridad, área. Se promueven periódicamente a CLAUDE.md.

### Morning builds
Cron a hora de dormir: "construye algo útil para mañana". Resultados de Viticci: CLI App Store API, Markdown linter, estimador de costos.

### Multi-agent performance
4 subagentes paralelos = 5min vs 20min secuencial. Subagentes NO reciben session tools por defecto (seguridad).

### Family calendar
Setup concreto: Google Calendar trabajo + familiar + pareja. Parsea PDFs de calendarios escolares via OCR. Detecta conflictos con lookahead 3 días. Briefing diario color-coded.
