# HANDOFF — Mejoras al resumidor (YouTube + Feedbin starred)

**Fecha:** 2026-08-17
**Método:** 2 agentes de solo lectura (Opus 5 sobre el código real + research web sobre patrones de la comunidad) — ningún cambio aplicado, esto es un plan de trabajo pendiente esperando decisión de Cal.
**Alcance:** `daemon-v2/src/tools/resumir.ts` (YouTube + Feedbin starred), `~/.claude/scripts/audio-transcribe.sh`, MCP `youtube-transcribe`, `system-prompt.ts` (secciones del resumidor).

## Estado

Cal pidió "ajustes al flujo de resumen de videos YouTube y star de Feedbin" sin especificar qué —
se lanzaron 2 agentes en paralelo (uno a analizar código+logs reales, otro a buscar patrones de la
comunidad dev) para armar una base de decisión antes de tocar nada. Los dos reportes completos están
abajo. **Nada se implementó todavía — falta que Cal responda las preguntas abiertas y dé luz verde.**

## Hallazgo #1 — YouTube: timeout determinístico, pasó HOY mismo

Hay **dos implementaciones paralelas** del mismo flujo. Solo una corre de verdad:
- **La real** (botón 🎬, cron diario): `daemon-v2/src/tools/resumir.ts` (1618 líneas) + `~/.claude/scripts/audio-transcribe.sh` (captions vía `yt-dlp --cookies-from-browser safari`, fallback Whisper modelo `base`, **sin caché**).
- **La casi-muerta**: skills `resumir-youtube`/`resumir` + MCP local `youtube-transcribe` (Whisper `small`, **con caché** en `/tmp/yt-transcribe-cache/` — carpeta que ni existe en la máquina, o sea nunca se usa).

**Falla real, reproducible, pasó hoy (2026-08-16) a las 22:16:** un video timeouteó a los 360s
(`CdMtxDHT0DI`) porque `buildPrompt()` (`resumir.ts:302-307`) manda la transcripción **completa sin
truncar** — a diferencia del camino de PDF, que sí tiene tope (`MAX_PDF_CHARS = 50_000`,
`resumir.ts:56`). Ya había pasado el 2026-07-03 (documentado en `Jano/CLAUDE.md:62`); el fix de
entonces fue subir el timeout de 180s→360s, que solo corrió el problema hacia adelante. El video
volvió a la cabeza de la cola (14 en cola hoy) y **va a fallar de nuevo tal cual está el código**.

Otras dos fallas activas, menores:
- Sin caché de transcripción → cada reintento re-descarga y re-transcribe todo desde cero.
- Cuando falla la transcripción (no el resumen), `run()` hace `return` en vez de `throw`
  (`resumir.ts:621-624`) → sin `console.error`, y el mensaje específico se pisa al instante con el
  genérico "⚠️ No pude resumir..." (ya documentado en `Jano/CLAUDE.md:218`, sigue sin resolver).

**El cron diario 08:00 está apagado desde 2026-07-14** (`scheduleResumirPlaylist()` comentado en
`index.ts:2010`) — quedaron 14 videos sin drenar en la cola.

## Hallazgo #2 — Feedbin starred: ya existe, completo, pero dormido

**No es una idea nueva — está construido y es espejo exacto del flujo de YouTube**
(`resumir.ts:1016-1228`). Pega directo a la REST API de Feedbin (no al MCP), con fallback al Cookie
Broker si el contenido viene recortado por paywall (<1500 chars), y des-estrella al procesar.

**Dormido desde 2026-06-20** (mismo apagón del cron del 2026-07-14 lo dejó sin trigger). Las
estrellas siguen entrando (`savePage`+`starEntries` desde Jano) y nada las saca hace 2 meses —
`~/.cos-agent/resumir-starred-queue.json` en 0 ítems desde el 2026-08-09.

**Bug de coherencia:** `system-prompt.ts:326` y `:328` le siguen diciendo a Cal que "un cron diario"
revisa playlist y starred — ya no es cierto, desinforma activamente.

## Hallazgo #3 — Lo que la comunidad confirma que YA está bien hecho

No tocar estas partes, están alineadas con el patrón estándar de la industria:
- **Captions primero, Whisper de fallback** — patrón dominante, ya implementado.
- **"Estrella = traer el artículo completo aunque haya paywall"** (patrón `freshrss-bpc` de la
  comunidad) — exactamente lo que ya hace el flujo de Feedbin con el Cookie Broker. Diseño correcto,
  solo está apagado.
- **Playlist custom como proxy de trigger** en vez de pelear con el "Watch Later" nativo de YouTube
  (que ni Zapier ni n8n pueden triggerear, confirmado por la comunidad) — decisión ya tomada bien.

## Propuestas priorizadas (actualizadas con el research de comunidad)

1. **Chunking jerárquico para transcripciones largas — MEDIANO.** *Reemplaza* la idea original de
   truncar a 50k chars: la comunidad usa casi unánimemente partir en bloques con overlap, resumir
   cada uno, concatenar — evita perder el final del video (que sí perdería un truncado simple) y es
   el fix real para el timeout. Cambio acotado a `buildPrompt()`/`summarize()`. **Prioridad #1.**
2. **Corregir el system-prompt del resumidor — CHICO.** Sacar "un cron diario" de
   `system-prompt.ts:326` y `:328`. Cero riesgo.
3. **Propagar el motivo real de la falla a Telegram — CHICO.** Que `run()` devuelva la razón en vez
   de pisarla con el genérico. Ya reportado en `Jano/CLAUDE.md:218`.
4. **Cachear la transcripción en `audio-transcribe.sh` — CHICO.** ~4 líneas, mismo patrón que ya usa
   el MCP `youtube-transcribe`. Baja de prioridad si se hace #1 (los fallos determinísticos
   desaparecen y bajan los reintentos).
5. **Decidir destino del cron/flujo de starred — CHICO o cero código.** Es decisión de Cal, no de
   ingeniería: reactivar `scheduleResumirPlaylist()`, dejarlo on-demand, o mostrar el conteo de
   starred en algún mensaje que Cal ya lea.
6. **Dedupe por timestamp de última corrida exitosa — CHICO, baja prioridad.** Idea nueva del
   research de comunidad (patrón `Readwise-reader-AI-synthesis`): más resiliente que vaciar
   cola/marcar visto si un batch falla a mitad de camino. Solo vale la pena si se toca ese código de
   todos modos.
7. **Unificar las dos implementaciones de transcripción YouTube — MEDIANO, deuda técnica.** El skill
   `resumir` dice que YouTube pasa por el MCP `youtube-transcribe`, pero lo que corre a diario es
   `audio-transcribe.sh`. Última prioridad — no es una falla activa.

## Preguntas abiertas para Cal (bloquean #1 y #5)

1. **Videos largos:** ¿chunking jerárquico (el fix recomendado, MEDIANO) o preferís algo más simple
   como fallar explícito con "video demasiado largo" si supera cierto umbral?
2. **Starred de Feedbin:** ¿reactivar con disparo automático, o seguir on-demand y aceptar que las
   estrellas se acumulan como archivo?
3. **Cron 08:00:** ¿el apagón del 2026-07-14 fue una decisión de horario, o fue por el ruido de las
   fallas (timeouts, "no pude resumir" sin motivo)? Si es lo segundo, arreglar #1 y #3 cambia la
   ecuación y valdría reconsiderar reactivarlo.
4. **Los 14 videos en cola hoy:** ¿drenarlos tal cual, o purgar la cola y arrancar limpio? El primero
   de la fila es el que timeouteó anoche y va a volver a fallar tal cual está el código.

## Siguiente paso

Ejecutar de a uno con plan/diff aprobado por Cal antes de aplicar cada cambio (regla del proyecto:
nunca modificar código de daemon sin confirmación explícita, y deploy/restart requieren confirmación
separada del fix de código) — mismo protocolo que `HANDOFF.md` (auditoría de seguridad). Empezar por
#1 (chunking) en cuanto Cal responda la pregunta 1, es la de mayor impacto y menor ambigüedad.

## Referencia

Transcripts completos de los 2 agentes: no persistidos fuera de esta conversación — si se pierden,
re-lanzar con los mismos prompts (agente de código: analizar `resumir.ts` + `audio-transcribe.sh` +
`system-prompt.ts` + logs de `~/Library/Logs/cos-agent-v2.{out,err}.log`; agente de research: patrones
de comunidad para pipelines "YouTube→resumen" y "star/save→resumen" — fuentes citadas en el reporte
completo dentro del historial de la sesión 2026-08-16/17).
