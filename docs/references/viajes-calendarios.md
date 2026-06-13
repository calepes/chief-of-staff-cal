# Viajes, Calendarios y Briefings (Jano)

## Calendarios consultables

- **Personal** (`carlos@lepesqueur.net`): agenda personal de Cal. Default GCal sin `calendarId`.
- **AntoCataNoeCal** (`c_4c2ogsnda3b61k1sd9eta6vc2k@group.calendar.google.com`): viajes (Flighty) + eventos familiares.
- **Outlook BCP**: NO consultar el calendar importado en GCal (`655cenb4ro558qcnuucafn0kitdqtmia@import...`) — bug de timezone (TZID UTC se desplaza -4h). Usar siempre `getOutlookEvents` (cache local del cron `com.claude.outlook-cache` — ⚠️ cron dormido desde 2026-06-13, el tool sigue funcionando pero sirve cache **congelado**).
- **Cumpleaños:** `list_events` con `eventTypeFilter: ["birthday"]` en calendar Personal. Incluir sección 🎂 en briefings/today si hay cumple del rango.

## Gestión de Viajes

- **Fuente:** Flighty (iOS) → sincronizado a Google Calendar "AntoCataNoeCal" (`c_4c2ogsnda3b61k1sd9eta6vc2k@group.calendar.google.com`).
- **Cada evento incluye:** booking code, horarios, ruta.
- **Preferencia asiento:** el más adelante en pasillo; si no hay, el más adelante en fila del medio.
- **Triggers naturales:** "check-in vuelo", "próximo vuelo", "viajes esta semana".

### Check-in BoA (Safari real via AppleScript)
Playwright bloqueado por WAF Incapsula/Amadeus.
- `osascript -e 'tell application "Safari" to do JavaScript "..." in current tab of front window'`
- Prerrequisito: Safari > Settings > Developer > "Allow JavaScript from Apple Events".
- Iframe Amadeus cross-origin → usar System Events clicks `{x, y}` (requiere Accessibility).
- Flujo: boa.bo → cookies → Start Check-in → form (apellido + locator) → submit → iframe Amadeus.
- Boarding pass se envía a Cal via Telegram (screenshot fullPage).

## Briefings

- **Skill:** `/briefing-pais` — genera HTML Liquid Glass, publica en GitHub Pages, notifica por Telegram.
- **Output:** `https://apps.lepesqueur.net/dailynews/{Pais}/{Pais}-{YYYYMMDD}.html`
- **Repo:** calepes.github.io/dailynews/
- **Instrucciones:** `docs/briefing-pais-instructions.md` (copia del skill para agentes remotos).
- **Cron local:** 5:00am diario (launchd) — Bolivia, Perú, Colombia secuencialmente via claude CLI.
- En el daemon, briefings on-demand usan el tool `runBriefing` (el daemon no puede ejecutar el skill — necesita Bash/Write).

## Apple Health (consumo)

Worker e infra viven en el agente Health: `~/Claude Projects/Personal/Agents/Health/health-worker/`. Ver `Health/CLAUDE.md`.

- **Metas Salud:** Notion DB `f929198356f14b148d205e4e6723646f` — leer antes de coaching personalizado via `mcp__claude_ai_Notion__notion-query-database-view`.
- **Composición corporal en D1:** `body_fat_percentage`, `lean_body_mass`, `body_mass_index`. `weight`/`body_mass` NO está en D1.
- **Endpoints:**
  - `GET https://health.carlos-cb4.workers.dev/summary?date=YYYY-MM-DD&key=$HEALTH_API_KEY`
  - `GET https://health.carlos-cb4.workers.dev/trend?metric=X&days=N&key=$HEALTH_API_KEY`
  - API Key: `~/.cos-agent/.env` como `HEALTH_API_KEY`.
- **Triggers:** "cómo dormí", "pasos hoy", "salud semana", "peso".

## Audio

- **STT (voz→texto):** ElevenLabs `scribe_v1` cuando `ELEVENLABS_API_KEY` set; whisper-cli fallback. Log `voice_transcribed` con `"stt":"elevenlabs"|"whisper"`.
- **TTS (texto→voz):** ElevenLabs `eleven_multilingual_v2` + FFMPEG MP3→OGG. `tools/tts.ts::textToVoiceOggChunks()` — chunks de 4800 chars, un `sendVoice` por chunk. **NO automático** — requiere trigger explícito: "en audio", "como audio", "en voz", "léemelo", "cuéntamelo", o prefijo 🎤.
- whisper-cli: `/opt/homebrew/bin/whisper-cli` · modelo `ggml-small.bin` (preferred) o `ggml-base.bin`.

## Skill /today

- **Ubicación:** `~/.claude/commands/today.md`.
- **Secciones:** scope (proyecto vs panorama), calendario (Outlook + Google), salud (health worker), tareas Notion (semana actual agrupadas por asignado).
