# CHANGELOG — Chief of Staff Cal

## 2026-04-30

### Migración de bot + PDF/DOCX

- **Bot migrado a @cal_jano_bot**: token actualizado en `~/.cos-agent/.env` y `~/.claude/channels/telegram/.env`. Bot viejo silenciado.
- **PDF/DOCX en Telegram**: `processDocument()` en `daemon-v2/src/index.ts` — extrae texto de PDFs y Word, pasa al agent como contexto. Fix: pdf-parse v2 API (`new PDFParse({ data }).getText()`) + `createRequire` CJS/ESM interop + dependencias instaladas en workspace root.

## 2026-04-29

### Migración mayor: daemon CoS v2 (Node + Agent SDK librería + webhook + CF Queue)

**Razón**: el daemon viejo `claude --channels` sufría TCC reset en cada update del binario `claude` y conflict 409 con sesiones interactivas. Mismo patrón que ya migró Vesta v2 / Pecunia v2.

**Arquitectura nueva**:
- Telegram → CF Worker `cos-agent-worker.carlos-cb4.workers.dev` (Hono webhook + callback router edge)
- Light callbacks (menu/t:d/t:c/t:s/t:sd/nav) resueltos en edge (~300ms, sin LLM)
- Heavy → CF Queue `cos-events` → daemon Node `com.cal.cos-agent-v2` (Node 22 + `@anthropic-ai/claude-agent-sdk` lib + OAuth Max)

**Phases ejecutadas**:
- **Phase 1 — Scaffolding**: npm workspaces (`shared-v2`, `daemon-v2`, `worker-v2`), tsconfig.base, types y telegram helpers compartidos.
- **Phase 2 — Worker CF**: queue `cos-events` (HTTP pull mode), KV `cos-state` (id `8e5840cda34546949ff780be61c2579e`), secrets (`COS_WEBHOOK_SECRET`, `COS_TELEGRAM_BOT_TOKEN`, `NOTION_TOKEN`), callback router edge con status valor real `Listo` (no `Done`).
- **Phase 3 — Daemon Node**: 9 tools custom (notion-tasks con property names reales `Nombre de tarea`/`Asignado a` relation/`Fecha`/`Deadline`/`Prioridad CAL`, personas con cache 1h + fallback hardcoded de 7 personas Yape, outlook cache reader, health worker tools, multimodal voice/photo). Fresh `startup()` per turn (warm pool stale gotcha). Watchdog webhook cada 1 min. Circuit breaker con alerta a Cal tras 3 errores consecutivos.
- **Phase 4 — Standby test**: plist `com.cal.cos-agent-v2` con `/usr/local/bin/node`, `.env` con 12 vars, daemon corriendo en background con webhook deshabilitado para no chocar con daemon viejo.
- **Phase 5 — Hooks adaptados**: `cos-channel-bootout.sh` y `cos-channel-bootstrap.sh` reescritos. Bootout deja que grammY `bot.start()` borre webhook (esperado). Bootstrap restaura webhook al worker v2 inmediatamente al cerrar la última sesión interactiva.
- **Phase 6 — Cutover**: `setWebhook` al worker v2, daemon viejo `com.cal.cos-agent` movido a `disabled-2026-04-29/`, smoke test pendiente con Cal.

**Tools custom** (MCP `cos-tools`, 9 total):
1. `listTasks({status?, assigneePageId?, fromDate?, toDate?, limit?})` — query DB Tareas
2. `createTask({title, status?, assigneePageId?, fechaIso?, deadlineIso?, prioridad?})`
3. `setTaskStatus({pageId, status})` — usar `Listo` para "done"
4. `setTaskFecha({pageId, fechaIso})`
5. `setTaskDeadline({pageId, deadlineIso})`
6. `getPersonas()` — mapping cache
7. `getOutlookEvents({when?})` — cache pre-procesado
8. `getHealthSummary({date?})`
9. `getHealthTrend({metric, days})`

**Worker callback router edge** (`worker-v2/src/callback-router.ts`):
- `menu:<section>` y `nav:<section>` — render estático (solo `root` por ahora)
- `t:d:<pageId32>` — mark done (status="Listo")
- `t:c:<pageId32>` — complete (alias)
- `t:s:<pageId32>` — skip
- `t:sd:<pageId32>` — set fecha=hoy
- `spotify:*` — descartados (out of scope v2)

**Estado post-cutover**:
- ✅ Bot @calclaudecode_bot responde via webhook
- ✅ Sin TCC reset (Node + SDK lib, sin binario `claude`)
- ✅ Sin conflict 409 (webhook reemplaza polling)
- ✅ Watchdog auto-recupera webhook si algún proceso lo borra
- ✅ Sesiones interactivas coordinadas via hooks (deleteWebhook gracioso)
- ⏸️ Spotify control con lenguaje natural — pendiente post-cutover (Cal pidió agregarlo después)

**Spec/plan**: `docs/superpowers/specs/2026-04-28-cos-agent-v2-design.md` + `docs/superpowers/plans/2026-04-28-cos-agent-v2-implementation.md`.

### Telegram UX — Migración MarkdownV2 → HTML

**Bug detectado**: el bot respondía con "⚠️ No pude procesar tu mensaje. Hubo un error interno" cada vez que el LLM generaba un reply con caracteres MarkdownV2 reservados sin escapar (`+`, `~~`, `=`, etc.). Telegram rechazaba el parse, y el "fallback" en `daemon-v2/src/index.ts:294` reintentaba sin pasar `parseMode` — pero el default en `shared-v2/src/telegram.ts:35` también era `MarkdownV2`, así que el fallback fallaba igual y caía al placeholder genérico.

**Fix**:
- `shared-v2/src/telegram.ts`: default `editMessage` ahora es `HTML`. Tipo `parseMode` extendido a `"HTML" | "MarkdownV2" | null`. Si `null`, no se incluye `parse_mode` en el body (texto plano). Agregado export `escapeHtml(s)` que escapa solo `< > &`.
- `daemon-v2/src/index.ts`: helper local `escapeHtml`, todos los `editMessage` con `"HTML"`. Fallback ahora usa `parseMode=null` → garantiza entrega aunque se pierda formato. Templates de error en HTML.
- `daemon-v2/src/system-prompt.ts`: instrucciones reescritas — el LLM ahora genera `<b>`, `<i>`, `<code>`, `<a href>` en vez de `*x*`, `_x_`. Plantillas de output (tarea, lista, briefing) en HTML.

**Resultado**: bot responde sin "No pude procesar" — verificado con mensaje real (replyLen 274 chars con bold + bullets, sendMs 457ms, sin `html_parse_failed` en log).

**Impacto en otros bots**: Family/Vesta tiene el mismo bug (su `shared-v2/telegram.ts` default = `HTML` ya, pero el prompt instruye MarkdownV2 — los users ven `\*texto\*` literal). Migración análoga queda en BACKLOG. Pecunia usa HTML hardcoded — no afectado.

### Briefings on-demand — tool `runBriefing`

**Problema**: el bot CoS no podía generar briefings on-demand porque `Bash`, `Write`, `Read`, `Edit` están en `DISALLOWED_BUILTINS` (allowlist estricta). Cuando Cal pedía "genera el briefing Bolivia", el LLM intentaba `Skill briefing-pais` y se frustraba porque el skill necesita Bash/curl/git/Write y no los tiene. Solo el cron `com.claude.daily-briefings` (sesión claude regular con tools completos) podía generar briefings — pero el cron quedó deshabilitado en `disabled-2026-04-29/` y los briefings llevaban 11 días sin generarse cuando llegó el pedido de Cal.

**Solución — patrón "tool wrapper"**: tool custom `mcp__cos-tools__runBriefing({pais, fecha?})` en `daemon-v2/src/tools/briefing.ts`:
- Async: spawn detached de `claude -p` con el mismo comando que usaba el cron (`gtimeout 900 claude -p --dangerously-skip-permissions --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Skill" -d <PROJECT_DIR> "<prompt>"`). Tool retorna inmediatamente con `status: "started"`.
- Lock: `~/.cos-agent/briefing-locks/<pais>.lock` con PID + chatId + timestamp. Bloquea ejecución concurrente del mismo país (diferentes países pueden correr en paralelo). Detecta locks stale (PID muerto).
- Notificación: el child process mismo manda al chat de Cal (chat_id pasado en el prompt) con top 3 titulares + URL cuando termina. Si el child falla (timeout 15min o exit≠0), el daemon manda aviso de error al chat.
- ChatId del turno actual: `daemon-v2/src/index.ts` mantiene `currentChatId` global mutable, seteado al inicio de cada `processMessage`. `agent-tools.ts` usa `getCurrentChatId()` callback. Safe porque el daemon procesa serialmente (1 worker en queue).

**system-prompt actualizado**: removida mención del Skill `briefing-pais` (no funciona desde el daemon), agregada sección "Briefings de país (on-demand)" con la nueva tool.

**Flujo nuevo**: Cal pide *"genera el briefing Bolivia de hoy"* → LLM invoca `runBriefing({pais: "Bolivia"})` → bot responde "Briefing arrancado para Bolivia 2026-04-29. Te aviso cuando termine" → en background el subprocess corre 5-15 min → manda mensaje nuevo a Cal con top 3 + URL.

### YouTube transcripts — MCP custom + integración CoS

**Motivación**: el MCP global `youtube-transcript` (3rd party) solo lee captions cuando existen — falla con videos sin captions. Cal mandaba videos al bot CoS para resumir y el bot decía "no tengo permiso" o "el video no tiene captions".

**MCP nuevo**: `youtube-transcribe` (Node 22 + TS + `@modelcontextprotocol/sdk` stdio) en `~/Claude Projects/Personal/MCP Servers/mcp-servers/servers/youtube-transcribe/`. Tool único `transcribeYoutube({url, lang?, paragraphs?, model?, forceWhisper?})` con estrategia 2 fases:
1. **Caption fast-path** (~5-30s): `yt-dlp --skip-download --write-subs --write-auto-subs --sub-langs <lang>,*  --convert-subs srt`. Parsea SRT, devuelve texto. `source: "caption"`, `captionLang` indica el idioma real usado.
2. **Whisper fallback** (1-5 min según duración): `yt-dlp -x --audio-format wav --postprocessor-args "ffmpeg:-ar 16000 -ac 1"` + `whisper-cli -m ggml-small.bin -l <lang> -nt`. `source: "whisper"`.
- Cache por `videoId+lang+model` en `/tmp/yt-transcribe-cache/<id>-<lang>-<model>.txt`. Subsecuentes hits → `source: "cache"`.
- `paragraphs: true` (default) parte el texto en chunks ~80 palabras separados por `\n\n`.
- `forceWhisper: true` salta el caption fast-path (útil si auto-captions son malos).

**Registro global**: `~/.claude/.mcp.json` agregado server `youtube-transcribe` (stdio, command=node, args=[dist path]). Disponible en TODAS las sesiones interactivas + daemons que hereden MCPs.

**CoS allowlist**: `mcp__youtube-transcribe__transcribeYoutube` agregado a `CLAUDE_AI_COS_TOOLS` en `agent-options.ts`. Removido el viejo `mcp__youtube-transcript__get_transcripts` para que el LLM use solo el nuevo. system-prompt actualizado con nueva sección "YouTube" describiendo las 2 fases y opciones.

### MCP wiring fix — SDK librería no lee `.mcp.json`

**Bug detectado** durante prueba inicial de youtube-transcribe en CoS y Vesta: el LLM intentaba llamar al tool nuevo pero fallaba con `"Claude requested permissions to use mcp__youtube-transcribe__*, but you haven't granted it yet"`. Investigación: el archivo `~/.claude/.mcp.json` solo lo lee el binario Claude Code CLI. Los daemons que usan `@anthropic-ai/claude-agent-sdk` como librería Node NO leen ese archivo — hay que registrar custom MCPs en `Options.mcpServers` al hacer `startup()`.

**Fix**:
- `daemon-v2/src/index.ts`: `BASE_OPTIONS.mcpServers` ahora incluye objetos stdio para todos los MCPs externos (youtube-transcribe, exchange-rate-bolivia, naabol-flights). Formato: `{ type: "stdio", command: "node", args: ["/abs/path/dist/index.js"] }`.
- `agent-options.ts`: agregado `mcp__youtube-transcript__get_transcripts` (3rd party legacy heredado de OAuth Max claude.ai) a `DISALLOWED_BUILTINS` para que el LLM no caiga en él por accidente.

Mismo fix aplicado a Family/Vesta y Pecunia.

### Exchange-rate-bolivia MCP (BCB oficial + Binance P2P paralelo)

**Motivación**: en Bolivia hay brecha grande entre el dólar oficial (BCB ~9.79 venta) y el paralelo (Binance P2P ~13+). Tener ambas fuentes accesibles desde el bot facilita decisiones de gasto en USD.

**Server nuevo**: `mcp-servers/servers/exchange-rate-bolivia/` (Node + TS + stdio + sdk MCP). Dos tools read-only:
- `getBcbRate()` — scrape de bcb.gob.bo (regex sobre el bloque "Valor referencial del dólar estadounidense"). Cache 60s. Replica la lógica del Scriptable widget en repo `tipo-de-cambio-Bolivia`.
- `getBinanceP2PRate()` — POST al endpoint público C2C de Binance para USDT/BOB. Top 5 BUY + top 5 SELL merchants, mediana, filtro outliers >3%, promedio. Cache 60s.

Registrado global + wired en CoS, Vesta y Pecunia. system-prompt de CoS actualizado con triggers naturales ("¿a cuánto está el dólar?" → llamar las 2 y mostrar oficial vs paralelo).

**Repo `tipo-de-cambio-Bolivia` actualizado**: default branch arreglado a `main` (estaba en `claude/create-exchange-folders-0JRtW`). Agregado widget Scriptable Binance P2P (`tipo cambio Binance/binanceP2P.js` + `loader.js`).

### Naabol-flights MCP (promovido de tool local a global)

**Motivación**: las tools de vuelos NAABOL existían solo como tools custom dentro de Vesta (`Family/daemon-v2/src/tools/flights.ts`). CoS y Pecunia no podían consultar vuelos sin pasar por el skill global `vuelos-bolivia` que requiere Bash (bloqueado en daemons). Promovido a MCP global single-source-of-truth.

**Server nuevo**: `mcp-servers/servers/naabol-flights/`. Wraps el CLI `~/Claude Projects/Personal/Apps/Aeropuertos Bolivia/cli/consultar-vuelo.mjs`. Tres tools:
- `getFlight({vuelo, aeropuerto?, tipo?})` — un solo vuelo. Acepta variantes: "OB659", "BOA 659", "el 659".
- `getFlights({queries: [...]})` — múltiples vuelos en una llamada (eficiente cuando comparten aeropuerto+tipo).
- `getAirportFlights({aeropuerto, tipo?, horaDesde?, horaHasta?, aerolinea?})` — consulta abierta cuando NO se conoce el código. 12 aeropuertos NAABOL.

Wired en los 3 daemons. Vesta perdió `tools/flights.ts` (delete de 113 líneas) y las 3 entradas en `agent-tools.ts` — el namespace cambia de `mcp__vesta-tools__getFlight` → `mcp__naabol-flights__getFlight`. system-prompt de Vesta + CoS actualizados con prefijos nuevos. Skill global `vuelos-bolivia` se mantiene para sesiones interactivas/CLI (no se deprecó).

**Bug del CLI corregido en mismo día**: `categorizeStatus()` no reconocía estado "CONFIRMADO"/"CONFIRMED" del endpoint NAABOL → todos los vuelos volvían como `estadoCategoria: "other"` (Cal vio todos los emojis como ⚪ blanco). Fix aplicado: agregado caso CONFIRMED en el clasificador + nueva función `adjustForDelay()` que recategoriza a `delayed` cuando `horaReal - horaProgramada > 15 min`. CLI vive en repo Aeropuertos-Bolivia local sin commitear (carpeta `cli/` untracked).

### Pecunia system-prompt fix

**Bug**: Pecunia tenía `exchange-rate-bolivia` y `naabol-flights` correctamente wired (BASE_OPTIONS + allowlist), pero el `system-prompt.ts` no mencionaba ninguno de los tools nuevos. Cal preguntó "Dame el tipo de cambio del BCP y de Binance" y el LLM respondió sin invocar tools (`turn_summary toolCalls: []` confirmado en `daemon.out.log`).

**Fix**: agregadas 2 secciones nuevas en `pecunia-agent/daemon/src/system-prompt.ts` después del bloque de Airtable: "Tipo de cambio Bolivia" con triggers naturales y "Vuelos NAABOL" como referencia para queries laterales en planning de gastos por viajes.

## 2026-04-24

### Reactivación parcial — daemon CoS vivo 24/7
- **Fix**: `com.cal.cos-agent` cargado en launchd. Plist intacto en `~/Library/LaunchAgents/` (nunca se movió a `disabled-2026-04-21/`). Bot `@calclaudecode_bot` polleando; verificado con `409 Conflict` via getUpdates
- **Cleanup**: zombie `bun server.ts` (PID 56593) huérfano de sesión previa killeado antes del bootstrap para evitar conflict
- **Family agent**: sin cambios — ya estaba vivo, plist también intacto. El entry del 2026-04-21 afirmaba "18 plists movidos a disabled" — en realidad son 16; los 2 daemons principales nunca fueron movidos

### Docs
- **CLAUDE.md**: sección "Estado" reescrita (2026-04-21 → 2026-04-24). "DORMANT" → "PARCIALMENTE ACTIVO". Lista explícita de 16 crons pausados vs 2 daemons activos. Aclaración de conflict 409 al abrir sesión interactiva (hooks bootout/bootstrap siguen vaciados)
- **Global `~/.claude/CLAUDE.md`**: path "Agentes AI personales" corregido a `~/Claude Projects/Personal/Agents/` (estaba apuntando a `~/Documents/...` desactualizado — los agentes 24/7 están fuera de `~/Documents/` por TCC de launchd)

## 2026-04-21

### Pausa operativa — desactivación total pendiente de rediseño
- **Decisión**: Cal desmonta toda la automatización del CoS + Family tras problemas recurrentes. Ambos agentes quedan DORMANT hasta rediseño del ecosistema
- **Launchd**: 18 plists movidos a `~/Library/LaunchAgents/disabled-2026-04-21/` (10 `com.claude.*` de CoS/sistema + 6 `com.cal.family-*` + 2 `com.cal.cos-*`). Ningún plist cargado, ningún job disparándose
- **Hooks `settings.json`** (3 archivos con backup `.bak-2026-04-21`):
  - `~/.claude/settings.json` (global): quitado bloque `hooks` completo (SessionStart context, Stop telegram-notify, PreCompact snapshot, PostToolUse notion-audit + learn-error). Preservado: permissions, statusline, enabledPlugins
  - `Chief of Staff Cal/.claude/settings.json`: vaciado a `{}`
  - `Family/.claude/settings.json`: quitado bloque `hooks` (UserPromptSubmit datetime, SessionStart family-context, SessionEnd bootstrap, Stop notify). Preservado: model, permissions
- **Procesos**: cero `bun server.ts`, cero `claude --channels`, cero `claude -p` headless
- **Recovery**: reversible. Mover plist de `disabled-2026-04-21/` a `~/Library/LaunchAgents/` + `launchctl bootstrap gui/$(id -u) <plist>`. Restaurar `.bak-2026-04-21` para recuperar hooks

### Diagnóstico — Telegram CoS mudo
- **Root cause**: red bloquea `api.telegram.org` via SNI filtering (`curl (35) Recv failure: Connection reset by peer` durante TLS handshake; `google.com` funciona). Gotcha ya documentado en CLAUDE.md
- **Problema secundario**: dos sesiones interactivas con `--channels` del mismo bot → conflict 409. El channel conflict guard actual solo cubre launchd↔interactiva, no interactiva↔interactiva
- **Fix aplicado**: ninguno — el diagnóstico motivó la decisión de desactivar todo

### Docs
- `CLAUDE.md` CoS: nueva sección "Estado (2026-04-21): DORMANT" con recovery instructions
- `Family/CLAUDE.md`: sección "Estado" reescrita (era "v1 operativo 24/7"). Limpieza de afirmaciones stale "corre 24/7" en "Qué es" y warning DORMANT en "Comando de arranque"

## 2026-04-20

### Telegram — Channel conflict guard (cos-agent + family-agent)
- **Feature**: Hooks `cos-channel-bootout.sh` (SessionStart) + `cos-channel-bootstrap.sh` (SessionEnd) en `~/.claude/hooks/`. Registrados en `.claude/settings.json` del proyecto. Al abrir sesión interactiva `claude --channels`, descargan el launchd agent `com.cal.cos-agent` para evitar conflict 409 (solo UN poller por bot token). Al cerrar la última sesión interactiva, recargan el daemon automáticamente
- **Feature**: Misma lógica replicada para Family (`family-channel-bootout.sh` + `family-channel-bootstrap.sh`). Filtran por `TELEGRAM_STATE_DIR=/Users/calepes/.claude/channels/telegram-family`. Registrados en `Family/.claude/settings.json`. Copias en `Family/hooks/`
- **Fix crítico**: Añadido `/Users/calepes/.bun/bin` al PATH de los dos plists (`com.cal.cos-agent.plist` y `com.cal.family-agent.plist`). Sin esto, `bun` no estaba disponible para launchd → plugin MCP de Telegram fallaba ("1 MCP server failed") → daemon arrancaba pero sin polling → bot mudo aunque el proceso estuviera vivo
- **Fix self-sabotage**: env var `COS_AGENT_BG=1` / `FAMILY_AGENT_BG=1` en los plists. Los hooks lo chequean y exit 0 si corren dentro del propio daemon. Sin este flag: el SessionStart hook también dispara al arrancar el launchd → el daemon se descargaba a sí mismo → KeepAlive respawn → loop spawneando bun zombies
- **Docs**: CLAUDE.md del CoS con sección "Channel conflict guard" extendida + gotchas nuevos (SNI filtering en WiFis específicas, bun PATH, zombies bun, debug con `launchctl print gui/$(id -u)/<agent>`). CLAUDE.md del Family con sección "Channel conflict guard" + mismos gotchas

### Cleanup — Remover integración Spotify completa
- **Removido del plugin:** `telegram-plugin/spotify-client.ts` eliminado, handlers `spotify:play|pause|skip|back|volup|voldown` y función `spotifyNoDeviceResult` / `isNoDeviceError` quitados de `callback-router.ts`. Imports de `spotify-client` removidos. Redesplegado a plugin cache 0.0.5 + 0.0.6
- **Removido del repo:** carpetas `spotify-miniapp-worker/` y `spotify-auth-worker/` borradas completas
- **Removido del .env:** `SPOTIFY_AUTH_WORKER_URL` (los CLIENT_ID/SECRET ya vivían como secrets del worker, no en .env local). Backup creado en `.env.backup-before-spotify-cleanup`
- **Desprovisionado Cloudflare:** `spotify-auth.carlos-cb4.workers.dev` + `spotify-miniapp.carlos-cb4.workers.dev` deleted via `wrangler delete`. KV namespace `spotify-auth-SPOTIFY_TOKENS` (id 48ced040...) deleted
- **Docs:** secciones "Spotify" y "Spotify Mini App (TWA)" removidas de CLAUDE.md. Comando deploy actualizado (sin spotify-client, wildcard `telegram/*/` cubre 0.0.5+0.0.6)
- **Conservado:** Spotify Developer App en console.spotify.com (eliminar es irreversible, Cal puede reactivar en el futuro). CHANGELOG + specs históricos quedan intactos por trazabilidad
- **Pendiente manual:** reset `setChatMenuButton` del bot a `type: commands` — Telegram API daba connection reset desde esta sesión. Comando en BACKLOG

### Fase 5.3 — Skill Detector (auto-instalación de skills)
- **Feature**: `skill-detector.sh` (cron domingo 21:30) escanea transcripts del CoS últimos 7 días, extrae digest de user+assistant messages con jq (max 500 líneas), pasa a `claude -p` con `skill-detector-prompt.md`. Detecta patrones conductuales con frecuencia ≥3/sem que ameriten skill dedicado. Evita duplicar skills existentes (lista enviada al prompt)
- **Feature**: `skill-install.sh <id>` — disparado por callback `skill:approve:<id>` async. Mecánico (NO pasa por LLM): lee propuesta JSON (ya incluye skill_body completo), valida name en kebab-case, escribe `commands/<name>.md` + copia a `~/.claude/commands/`, git commit + push, notifica Telegram con commit hash. Con rollback si commit falla
- **Feature**: Callbacks `skill:approve:<id>` / `skill:reject:<id>` mecánicos en `callback-router.ts`. Approve lanza installer via `spawn` detached
- **Prompt**: `skill-detector-prompt.md` con criterios explícitos (qué sí, qué no proponer), lista de skills existentes para anti-duplicate, formato JSON estricto con `frecuencia_semana` mínima 3
- **Plist**: `com.claude.skill-detector` (creado, NO cargado)
- **Fix colateral**: `extract-learnings.sh` — bug de macOS `find -newermt "@epoch"` no soportado. Cambiado a `touch -t <cursor>` + `-newer <ref>` (cursor exacto) o `-mtime -30` (primer run). Sin este fix, el batch nocturno de learnings tampoco habría encontrado transcripts

### Fase 5.2 — Morning Builds (scope B: propuesta + ejecución auto-restringida)
- **Feature**: `morning-build.sh` (cron 22:30) analiza contexto del día (git log, learnings pending, heartbeat log, tareas mañana) e invoca `claude -p` para generar UNA propuesta JSON concreta de mejora. Guarda a `~/.claude/morning-builds/proposals/<id>.json` y envía a Telegram con botones ✅/❌
- **Feature**: `morning-build-execute.sh <id>` ejecuta propuesta aprobada. Invoca `claude -p` con scope restringido a `commands/*`, `heartbeat-tasks/*`, `hooks/*.sh`, docs (`CLAUDE.md`, `BACKLOG.md`, `CHANGELOG.md`, `docs/**`). Bloquea plugin TS, workers, plists, settings.json. Clasifica output `DONE|ABORT|FAIL`, archiva JSON a implemented/failed/, notifica Telegram con commit hash
- **Feature**: Callbacks `build:approve:<id>` y `build:reject:<id>` mecánicos en `callback-router.ts`. Approve lanza executor async via `spawn` detached (no bloquea el callback). Reject mueve JSON a `rejected/`
- **Prompts**: `morning-build-prompt.md` (criterios de qué proponer + formato JSON) y `morning-build-exec-prompt.md` (scope explícito + respuestas `DONE|ABORT|FAIL`)
- **Plist**: `com.claude.morning-build` (creado, NO cargado — requiere aprobación Cal antes de activar)
- **Fix colateral**: `heartbeat.sh` — `--only <check>` ya NO incrementa failure counter (evita falso "heartbeat caído" durante debug con `--only`)

### Fase 5.1 — Self-improving Learnings
- **Feature**: Sistema de captura de aprendizajes con filesystem-RAG en `~/.claude/learnings/cos/`. CLAUDE.md queda lean — todo el conocimiento histórico vive en learnings/ + index.md como mapa central
- **Feature**: Skill `/learn <tipo> "<desc>"` para captura intencional (correction, decision, idea, error, pattern)
- **Feature**: Hook PostToolUse `learn-error.sh` captura errores automáticamente. Fix: solo dispara cuando `exit_code != 0` (el match de "error" en output texto era demasiado ruidoso y generaba feedback loop)
- **Feature**: Batch nocturno `extract-learnings.sh` lee transcripts del día via `claude -p` (prompt en `extract-learnings-prompt.md`). Plist `com.claude.extract-learnings` 21:55 daily (creado, NO cargado)
- **Feature**: `nightly-report.sh` extendido — LLM genera sección Learnings desde index.md + arma keyboard con callbacks `learn:keep|drop|keepall|dropall`, escribe batch IDs a `~/.claude/state/learn-batches/<id>`
- **Feature**: Callbacks `learn:*` mecánicos en `callback-router.ts` (ejecutan `flip_pending` / `move_to_archive` via bash, ~200ms, no pasan por LLM)
- **Feature**: Sync semanal `sync-learnings.sh` (domingo 21:00, plist NO cargado) — rsync `~/.claude/learnings/cos/` → `docs/learnings/` + commit + push
- **Library**: `~/.claude/hooks/learnings-lib.sh` — bash 3.2 compat (sin associative arrays). Funciones: `generate_id`, `slug`, `hash_normalize`, `is_duplicate`, `append_entry`, `update_index`, `find_entry_in_index`, `flip_pending`, `move_to_archive`, `tipo_to_filename`
- **Utilities**: `rebuild-learnings-index.sh` (recovery desde archivos de detalle), `learnings-status.sh` (cursor, pendings, top errores)
- **Spec/Plan**: `docs/superpowers/specs/2026-04-19-self-improving-learnings-design.md` + `docs/superpowers/plans/2026-04-19-self-improving-learnings.md`

### Fase 5.1 — Activación + verificación end-to-end
- **Activación**: cargados `com.claude.extract-learnings` (21:55 daily) y `com.claude.sync-learnings` (dom 21:00) con `launchctl bootstrap`
- **Smoke test**: pipeline completa verificada — `append_entry` → entry en index + detalle, `flip_pending` (keep) → `pending:false, valid:true`, `move_to_archive` (drop) → entry a `archive/YYYY-MM.md` con `rejected_at`, sistema limpio post-test
- **Canal Telegram reiniciado** por Cal para que el plugin fork recargue callbacks `learn:*`

### Docs — gotchas del entorno agregados a CLAUDE.md
- **Gotcha**: Bash 3.2 macOS default — sin `declare -A`, usar parallel arrays `("key|val")` + `${entry%%|*}` / `${entry#*|}`
- **Gotcha**: `set -euo pipefail` + `grep -c` sin match — grep devuelve exit 1, `-e` mata el script silencioso. Usar `set -uo pipefail` en scripts de status/conteo
- **Gotcha**: Plugin Telegram cache tiene versiones 0.0.5 y 0.0.6 coexistentes — deploy con wildcard `telegram/*/` las cubre
- **Gotcha**: PostToolUse hook `tool_response` no tiene `exit_code` top-level para Bash

### Backlog — decisiones de Cal
- **Expandir alcance "Deshacer Spotify"**: Cal confirmó remover TODA la integración Spotify del agente (Mini App + callbacks mecánicos + spotify-client + ambos workers + secrets). Mantener solo el Spotify Developer App en console.spotify.com (eliminar es irreversible). CLAUDE.md marcado con "⚠️ PENDIENTE DE REMOVER"
- **Convención de sesión**: sesión principal de Cal (Telegram) = temas operativos; sesión terminal = solo setup del agente

## 2026-04-19 (noche)

### Telegram plugin — robustez polling + Spotify UX
- **Fix**: Polling loop reintenta en cualquier error (antes solo 409). ETIMEDOUT/ECONNRESET/DNS rechazaban `bot.start()` y el polling moría silenciosamente mientras el proceso seguía vivo (MCP stdin). Ahora reset del attempt counter en `onStart` para que reconexiones sucesivas no acumulen backoff
- **Feature**: `editMessageText` desde `RouteResult` soporta inline keyboards (vía `RouteButton[][]`)
- **Feature**: Detección de "no active device" en respuestas de Spotify → UX con deep link "🎵 Abrir Spotify" en vez de error genérico

### Scripts operativos
- **Feature**: `scripts/health-check.sh` — detección end-to-end de long-poll a Telegram (409 Conflict = bot vivo; 200+empty = colgado). Fuerza relanzamiento del LaunchAgent si detecta caída
- **Feature**: `scripts/setup-menu-button.sh` — configura `setChatMenuButton` del bot para abrir la Mini App de Spotify como default

### Docs
- **CLAUDE.md**: agregado bloque "Test heartbeat puntual" + pattern para "Agregar nuevo check" (frontmatter mínimo + output esperado, sin reload)

## 2026-04-19 (tarde 2)

### Fase 4.3 CoS Proactivo — Health alertas reactivas
- **Feature**: 7 nuevos heartbeat checks de salud, cada uno como `~/.claude/heartbeat-tasks/health-*.md` con frontmatter (`schedule`, `priority`):
  - `health-sleep.md` (morning-wake/high) — anoche `sleep_totalSleep < 6h`
  - `health-steps-evening.md` (evening/medium) — `step_count < 6000` a las 17-19h
  - `health-sedentary.md` (business-hours/low) — `apple_stand_hour` bajo en horario laboral
  - `health-hrv-weekly.md` (weekly-monday-am/medium) — HRV semana actual <80% baseline 4 sem
  - `health-daylight.md` (late-afternoon/low) — `time_in_daylight < 15min` hoy
  - `health-strength-weekly.md` (weekly-monday-am/medium) — <3 sesiones strength en 7 días (meta 3x/sem)
  - `health-bodycomp-weekly.md` (weekly-monday-am/low) — recordatorio medir si data >7 días, o trend body fat + lean mass
- **Feature**: 5 schedule values nuevos en `should_run()` de heartbeat.sh — `morning-wake` (7-9am), `evening` (17-19h), `business-hours` (10-19h L-V), `weekly-monday-am` (Lun 8-9am), `late-afternoon` (17-18h)
- **Feature**: Bypass de `should_run()` cuando se usa `--only` (permite testear cualquier check fuera de ventana)
- **Feature**: Cleanup automático state files >7 días al inicio de cada heartbeat run (`find ~/.claude/state -name 'health-alerts-*.json' -mtime +7 -delete`)
- **Feature**: Anti-spam — state file diario `~/.claude/state/health-alerts-YYYY-MM-DD.json`. Cada check verifica su key antes de evaluar threshold; tras alertar, agrega su key con `jq` (1 alerta/día por tipo)
- **Worker**: Health worker extendido — endpoint `/workouts/summary?days=N&type=strength|cardio|...` ya existía (Fase 3), reusable por `health-strength-weekly`
- **Spec/Plan**: `docs/superpowers/specs/2026-04-19-health-alerts-design.md`, `docs/superpowers/plans/2026-04-19-health-alerts.md` (11 tareas)
- **Fix**: launchd plist heartbeat + proactive-ideas — agregado `~/.local/bin` al PATH para que encuentre el CLI de claude (causaba "heartbeat caído" tras 3 runs fallando con `gtimeout: failed to run command 'claude'`)

## 2026-04-19 (tarde)

### Fase 3 CoS Proactivo — Heartbeat + Proactive Ideas
- **Feature**: Heartbeat engine `~/.claude/hooks/heartbeat.sh` + launchd `com.claude.heartbeat` cargado (7am-22:30 cada 30min). Lee checks de `~/.claude/heartbeat-tasks/*.md` con frontmatter (`schedule`, `priority`), invoca `claude -p` por cada uno con timeout 60s, agrupa ALERTs por prioridad en un único mensaje a Telegram. Contador de fallos consecutivos en `~/.claude/state/heartbeat-failures` → alerta si ≥3 consecutivos. Log rotation automática a 5MB. Flags: `--dry-run`, `--only <name>`
- **Feature**: 4 checks iniciales — `overdue-tasks.md` (Notion vencidas, every/high), `flight-checkin.md` (Google Calendar AntoCataNoeCal, every/high), `incomplete-tasks.md` (sin asignado/deadline, morning-only/medium), `midday-steps.md` (Health worker, midday-only/medium, alerta si <3000)
- **Feature**: `~/.claude/hooks/heartbeat-status.sh` — observabilidad: último run, status launchctl, checks activos, últimos 5 alerts, failure counter
- **Feature**: Proactive ideas `~/.claude/hooks/proactive-ideas.sh` + plist `com.claude.proactive-ideas` (creado, NO cargado hasta que Cal complete tokens X/Threads + DB). Slots 9am=foco 🎯, 14:00=tactical ⚡, 19:00=lookahead 🔮. Lee posts propios X+Threads últimas 24h + tareas activas Notion → JSON `{title, body, source}` → escribe a Notion DB "Ideas Proactivas (CoS)" (`59e0439d7fe0483ab735575b9e0c1007`, anidada bajo "💡 Ideas") + Telegram. Graceful degradation si falta cualquier API
- **Spec/Plan**: `docs/superpowers/specs/2026-04-19-heartbeat-fase3-design.md`, `docs/superpowers/plans/2026-04-19-heartbeat-fase3.md`
- **Pendiente Cal**: crear app X (token + user_id), app Threads (token + user_id), compartir DB Ideas con integración "Claude CoS", agregar `NOTION_TASKS_DB_ID`, `NOTION_IDEAS_DB_ID`, `X_BEARER_TOKEN`, `X_USER_ID`, `THREADS_TOKEN`, `THREADS_USER_ID` a `~/.claude/channels/telegram/.env`. Después: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.proactive-ideas.plist`

## 2026-04-19

### Quick wins — hooks + Spotify UX + aprobaciones
- **Feature**: Hook `PreCompact` → `~/.claude/hooks/pre-compact-snapshot.sh` guarda snapshot del transcript antes de compactar. Últimos 20 snapshots en `~/.claude/compact-snapshots/`. Notifica Telegram si el trigger es manual
- **Feature**: Deep link Spotify cuando no hay device activo — callbacks `spotify:*` detectan "No active device" y responden con botón URL "🎵 Abrir Spotify" (https://open.spotify.com). Mensaje guía al usuario: abre Spotify, reproduce algo, reintenta
- **Feature**: Aprobaciones rápidas — callbacks `approve:yes[:context]` y `approve:no[:context]` procesados mecánicamente en el plugin (~200ms, sin LLM)
- **Feature**: `RouteResult` del callback-router ahora soporta `buttons?: RouteButton[][]` — los callbacks mecánicos pueden devolver inline keyboards (útil para el deep link Spotify y futuros flujos)

### Plugin Telegram — upgrade 0.0.5 → 0.0.6
- **Update**: Fork re-aplicado a versión 0.0.6 del plugin (0.0.5 quedó orphaned Apr 16). Upstream fix mergeado: retry polling con backoff en cualquier error (antes solo 409 se reintentaba — un ETIMEDOUT/ECONNRESET mataba el polling silenciosamente)
- **Update**: `~/.claude/CLAUDE.md` y `CLAUDE.md` de CoS actualizados con ruta 0.0.6
- **Backup**: `server.ts.original` de 0.0.6 guardado para comparar futuras actualizaciones upstream

### Cron jobs — rutinas diarias/semanales
- **Feature**: Reporte nocturno 22:00 → `~/.claude/hooks/nightly-report.sh` + `com.claude.nightly-report.plist`. Resumen del día (completadas, eventos), pendientes, plan mañana, sugerencia accionable. Notifica via Telegram
- **Feature**: Eisenhower semanal domingo 21:00 → `~/.claude/hooks/eisenhower-weekly.sh` + `com.claude.eisenhower-weekly.plist`. Clasifica tareas activas en matriz Urgente/Importante (Q1-Q4), top 3 Q1+Q2, recomendación '3 tareas para el lunes'. Solo reporta por Telegram, no actualiza Notion en primera iteración

### Audit + Mini App menu
- **Feature**: Hook `PostToolUse` filtrado a `mcp__notion__.*` → `~/.claude/hooks/notion-audit.sh` loguea escrituras a `~/.claude/logs/notion-audit.log`. Rotación automática al pasar 5MB
- **Feature**: `scripts/setup-menu-button.sh` — configura el botón de menú del bot (reemplaza lista `/commands` con Mini App). Ejecutado apuntando a Spotify Mini App (`https://spotify-miniapp.carlos-cb4.workers.dev`, label "🎵 Abrir")

## 2026-04-17

### Refactor estructural
- **Move**: `health-worker/` movido de `Chief of Staff Cal/` a `Health/` — vive con su agente
- **Update**: `CoS/CLAUDE.md` reducido a consumer con quick-ref de endpoints + pointer a `Health/CLAUDE.md`
- **Update**: `Health/CLAUDE.md` enriquecido con especificación completa del worker (endpoints, ingesta, métricas, dedup, deploy, ejemplos curl)

### Notion (cross-project)
- **Feature**: Creado `~/Claude Projects/notion-reference.md` — referencia global cargada bajo demanda: mapeo personas (pageId ↔ nombre) para 7 miembros del equipo Yape, schema DB Tareas (32 props), patterns jq para outputs grandes (70KB+), gotchas (users vs pages en API)
- **Update**: `Claude Projects/CLAUDE.md` referencia `notion-reference.md` junto a telegram-reference.md
- **Update**: `CoS/CLAUDE.md` sección Notion reducida a pointer al archivo cross-project

### Handoff Health
- **Feature**: Creado `Health/SESSION-HANDOFF.md` con contexto heredado de la sesión CoS para arrancar trabajo en el agente Health (Fase 1: metas + baseline + BD Notion + bot propio)

### Docs
- **Update**: Sección Audio de `CoS/CLAUDE.md` ahora incluye path completo del modelo whisper (`ggml-base.bin`) y comando completo de transcripción OGA → WAV → texto
- **Update**: `Health/CLAUDE.md` añade ejemplo POST /ingest para debugging

## 2026-04-12 (noche) — 2026-04-13

### Telegram UX
- **Fix**: Contenido de callbacks del menú ahora se envía como reply nuevo (no edit_message) — evita que el plugin destruya el contenido al navegar de vuelta
- **Fix**: Eliminados botones callback en mensajes de contenido — el plugin hacía edit mecánico al presionarlos

### Cron Briefings
- **Fix**: `timeout` → `gtimeout` (coreutils) — `timeout` no existe en macOS
- **Feature**: Notificación a Telegram via curl cuando un briefing falla (timeout o error)
- **Feature**: Rutas de GitHub Pages explícitas en el prompt para evitar búsquedas con find
- **Feature**: `Skill` agregado a --allowedTools del cron
- **Fix**: Removido `set -euo pipefail` para que no aborte si un país falla

### Briefings
- **Feature**: Briefing Peru 12 abril 2026 — cobertura elecciones generales (Keiko 16.6%, empate técnico segundo lugar, escándalo ONPE 63K votantes)

### Skill /today
- **Feature**: Sección de tareas Notion agregada — semana actual, agrupadas por asignado, ordenadas por deadline

### Backlog
- **Feature**: Agregado item Google Maps API (distancias/tiempos) al backlog CoS
- **Feature**: Agregado item Tipo de Gasto (Factura) al backlog Presupuesto

## 2026-04-12

### Deploy & Configuración
- **Deploy**: Spotify OAuth Worker desplegado — KV namespace, secrets, wrangler v4, auth completado
- **Deploy**: Health Worker desplegado — D1 database creada, migración aplicada
- **Config**: Notion token configurado en .env, integración "Claude CoS" conectada
- **Config**: Spotify auth worker URL agregada a .env
- **Config**: Health API key generada y configurada en .env
- **Config**: Health Auto Export conectado en iPhone (auth via query param)

### Health Worker
- **Fix**: Adaptado parser de ingesta al formato real de Health Auto Export (estructura anidada data.metrics[].data[])
- **Feature**: Sleep analysis expandido a sub-métricas (sleep_totalSleep, sleep_deep, sleep_rem, sleep_core, sleep_awake)
- **Feature**: Batch de D1 con límite de 500 statements

### Telegram Plugin
- **Feature**: Soporte para botones URL en reply y edit_message — deep links (spotify://, https://) además de callbacks
- **Feature**: Toast de confirmación ("✓ {label}") en callbacks no mecánicos via answerCallbackQuery

### Spotify Mini App (TWA)
- **Feature**: Worker `spotify-miniapp.carlos-cb4.workers.dev` — API proxy (10 endpoints) + UI inline
- **Feature**: Player Glass Immersive con SVG icons, búsqueda, cola, controles completos
- **Feature**: Service Binding para Worker-to-Worker auth (fix error 1101)
- **Feature**: TWA best practices — `ready()`, `disableVerticalSwipes()`
- **Feature**: Toast "No active device" para feedback al usuario
- **Fix**: Escape de comillas en onclick — `&apos;` en vez de `\'` en template literals HTML
- **Fix**: Skip buttons con re-poll automático para actualizar UI
- **Design**: 3 propuestas visuales (Minimal Noir, Vinyl Warmth, Glass Immersive) — Cal eligió C
- **Config**: Mini app registrada en BotFather, menú actualizado con acceso directo
- **Feature**: TWA audit MEDIUM+LOW — themeParams, safeAreaInset, HapticFeedback, viewport vars

### Claude Code Setup
- **Feature**: Hook SessionStart — inyecta fecha/hora actual al iniciar sesión
- **Feature**: Status line con fecha/hora + refreshInterval 60s
- **Feature**: Skill `telegram-miniapp` — guía global para construir TWAs
- **Research**: Auditoría Superpowers best practices — recomendaciones aplicadas
- **Research**: OpenClaw articles — plan "CoS Proactivo" con 6 fases y 19 items
- **Backlog**: Plan CoS Proactivo + Agente Familiar (Cal+Noe)

### Spotify Client
- **Fix**: JSON parse error en respuestas vacías de Spotify API (nowPlaying después de skip)

### Quick Wins (sesión nocturna)
- **Feature**: /today integra sección 🏥 Salud (consulta health worker) y 📅 Calendario (Outlook cache + Google Calendar MCP)
- **Feature**: Navegación de menú con edit_message in-place (no mensaje nuevo) + botón "⬅️ Menu"
- **Feature**: MAX_KEYBOARD_ROWS=4 en reply y edit_message (fix stutter iOS)

### Telegram UX & Documentación (sesión nocturna 2)
- **Feature**: Loading transitions mecánicas en plugin para callbacks `menu:*` — edit instantáneo (~150ms) con "⏳ Cargando..." antes de pasar al LLM
- **Docs**: `telegram-reference.md` — referencia cross-project consolidada (bot, plugin fork, callbacks, UX, integraciones, workers, gotchas)
- **Docs**: Referencia agregada en `Claude Projects/CLAUDE.md` y CoS `CLAUDE.md`

### Hooks & Crons (sesión nocturna)
- **Feature**: Hook SessionStart mejorado — tareas vencidas de Notion (API directa) + eventos Outlook (ICS cache) + Google Calendar (MCP)
- **Feature**: Hook Stop — push notification Telegram cuando Claude termina (solo end_turn)
- **Feature**: Outlook ICS cache — `refresh-outlook-cache.sh` + launchd cada 4h (`com.claude.outlook-cache`)
- **Feature**: Cron briefings diarios 5am — launchd `com.claude.daily-briefings`, Bolivia+Perú+Colombia via claude CLI
- **Fix**: Health Worker dedup — `INSERT OR IGNORE` + unique index + migration 0002 (eliminó ~24K filas duplicadas)

### Spotify Mini App (sesión nocturna)
- **Feature**: Backoff exponencial en 429 rate limit (1s→30s, resetea en success, toast "esperando...")

### Organización (sesión nocturna)
- **Feature**: Carpetas Yape unificadas (removido espacio trailing + merge Océano Azul)
- **Feature**: Gestión de Viajes integrado al CoS (Flighty, check-in BoA, preferencias)
- **Feature**: Gestión Presupuesto Familiar movido de Apps/ a Agents/Presupuesto/
- **Feature**: Estructura de agentes — Family, Learning, Health, School con CLAUDE.md + BACKLOG.md
- **Feature**: Tabla de agentes en BACKLOG.md con rutas, estados, y bots Telegram
- **Docs**: CLAUDE.md global y proyecto actualizados con ruta Agents/
- **Docs**: Briefing instructions commiteados para agentes remotos
- **Docs**: Notion DB Tareas — esquema completo (32 props), ID corregido para API directa

## 2026-04-11

### Telegram Bot
- **Feature**: Menú de comandos configurado (/briefing_bolivia, /briefing_peru, /today, /status, /tareas)
- **Feature**: Fork del plugin de Telegram con soporte para botones inline interactivos
- **Feature**: Reply keyboard (implementado y luego removido a favor de botones inline)
- **Feature**: Parámetro `buttons` en tool `reply` — envío de inline keyboards con callbacks custom
- **Feature**: Transcripción de notas de voz con whisper-cpp

### Briefings
- **Feature**: Briefing Bolivia 10 abril — generado, publicado en GitHub Pages, notificado por Telegram
- **Feature**: Briefing Colombia 10 abril — generado, publicado en GitHub Pages, notificado por Telegram

### Notion
- **Feature**: Consulta de tareas Eisenhower desde Telegram
- **Feature**: Actualización de deadlines y asignaciones desde Telegram
- **Feature**: Vista "Todas activas" creada para queries ad-hoc

### Calendario
- **Feature**: Escaneo de calendario semanal (Yape + personal + familia) desde Telegram

### Callback Optimization
- **Feature**: Notion client module — updates directos a Notion sin pasar por LLM
- **Feature**: Callback router — prefijos mecánicos (t:d, t:c, t:s, t:sd) procesados en ~200ms
- **Feature**: Router integrado en server.ts del fork del plugin

### Menu & Botones
- **Feature**: Menu configurable via `~/.claude/channels/telegram/menu.json`
- **Feature**: Skill `/menu` para mostrar inline keyboard interactivo
- **Feature**: Flujos de revisión de tareas documentados (botones <10, lotes >10)

### Spotify
- **Feature**: Cloudflare Worker OAuth (`spotify-auth.carlos-cb4.workers.dev`) — login, callback, token refresh
- **Feature**: Spotify client module — play, pause, skip, nowPlaying, setVolume
- **Feature**: Callbacks mecánicos en router (spotify:play, spotify:pause, spotify:skip, etc.)

### Apple Health
- **Feature**: Cloudflare Worker + D1 (`health.carlos-cb4.workers.dev`) — ingesta y consulta de datos
- **Feature**: Endpoints: POST /ingest, GET /summary, GET /trend
- **Feature**: Integración documentada para /today y triggers naturales

### Specs & Planes
- **Docs**: 4 specs de diseño aprobados en `docs/superpowers/specs/`
- **Docs**: 4 planes de implementación en `docs/superpowers/plans/`

### Backlogs actualizados
- Gestión Presupuesto Familiar: merchant adjustment UX con botones
- Claude Code Setup: guardrails de seguridad
- Chief of Staff: Spotify control, Apple Health integration
