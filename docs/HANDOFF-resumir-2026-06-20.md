# Handoff — Resumidor universal + auto-resumidor de playlist (2026-06-20)

Sesión larga. Se construyó un **resumidor universal** (skill interactivo + integración en Jano) con checkpoint, tags/highlights en Readwise, y un **auto-resumidor de playlist de YouTube** por cron. Este doc permite retomar exactamente donde quedó.

---

## 1. Qué se construyó

### A) Skill interactivo `resumir` (`~/.claude/skills/resumir/`)
Resumidor universal: autodetecta tipo de fuente → obtiene contenido → resume en el **idioma del contenido** → entrega a chat + Telegram + Readwise (con checkpoint).
- **Artículos** (incl. paywall/Cloudflare como Stratechery): vía cookies de Safari.
- **Libros**: desde knowledge; si no lo conoce, pide PDF/EPUB.
- **Video YouTube**: captions (yt-dlp) → resumen.
- **Podcast/audio** (Apple/Overcast/Spotify/mp3/RSS): yt-dlp + whisper. Spotify = DRM (busca fuente alterna).
- Docs del skill: `SKILL.md`, `DESIGN.md`, `PLAN.md`.

### B) Scripts compartidos (`~/.claude/scripts/`)
- `safari-fetch.mjs` — lee cookies de Safari (`Cookies.binarycookies`) + fetch con sesión real (pasa Cloudflare). Extrae `<title>` real. Corre con **`~/.claude/bin/node-fda`** (binario node dedicado con Full Disk Access).
- `audio-transcribe.sh` — YouTube: **captions primero** (rápido), fallback whisper. Apple/directo/RSS: yt-dlp+whisper. Overcast: extrae mp3. Spotify: `spotify-drm`. Devuelve `{status, transcript, title?}`.
- `readwise-save.sh` — guarda doc en Reader (con tags) + crea highlights clásicos (v2) con tag (`note:".tag"`), ligados por `source_url`. Args: `<title> <author> <source_url> <category> <html_file> [tags_csv] [highlights_json_file]`.
- `article-reader.mjs` — Playwright perfil propio (`playwright-core@1.61.0`, Chromium 1228). Para artículos sin paywall; `--login` para loguear (NO sirve con Cloudflare Turnstile → usar safari-fetch).
- `node-fda` (`~/.claude/bin/`) — copia de node con FDA para leer cookies.

### C) Integración en Jano (`Personal/Agents/Jano/daemon-v2/src/tools/resumir.ts`)
Tools (todos reusan los scripts vía `spawn`, **sin Bash**):
- `resumirContenido({source, instruction?})` — autodetecta, resume, **propone** tags+highlights (NO guarda; checkpoint).
- `guardarResumenReadwise({tags?, removeHighlights?, retag?})` — guarda la propuesta pendiente tras confirmación/ediciones.
- `saltarResumen()` — descarta la propuesta pendiente sin guardar.
- `estadoResumidor()` — reporta propuesta en curso + cola de la playlist.
- `revisarPlaylistResumir()` — revisa la playlist a demanda.
- `checkPlaylistsResumir()` — handler del cron diario.
- Registrados en `agent-tools.ts`, allowlist en `agent-options.ts` (`mcp__cos-tools__*`), documentados en `system-prompt.ts`.

### D) Checkpoint (flujo de 2 pasos)
1. `resumirContenido` propone tags (reutilizando la taxonomía de Reader, ~393 tags) + 5-8 highlights con su tag, y **espera**.
2. Cal responde **"guardar"** (→ `guardarResumenReadwise`) o **"salta"** (→ `saltarResumen`) o edita ("quita el 3", "al 2 ponle tag X"). Recién ahí escribe a Readwise.
- Estado en `~/.cos-agent/pending-resumir-<chatId>.json`. Al resolver cualquier pendiente, si hay cola, **continúa solo** (`maybeAdvancePlaylist`).

### E) Auto-resumidor de playlist de YouTube
- **Cron diario 08:00** (node-cron en `index.ts`, `scheduleResumirPlaylist`): revisa la playlist, encola videos nuevos, propone de a uno (checkpoint), auto-avanza.
- Config: `~/.cos-agent/resumir-playlists.json` → playlist "Para resumir" (`PL7Rp_Q5B_NwNrpG_1WIjGwhKPyxdXD3pm`, no listada).
- Estado: `~/.cos-agent/resumir-playlist-seen.json` + `resumir-playlist-queue.json`.
- Lock anti-carrera (`placeholder` en el pending) + drena cola aunque no haya nuevos.

---

## 2. Estado actual (al cierre)

- **Jano daemon corriendo** (último pid 77113; cambia en cada restart). Cron `resumir_playlist_scheduled · daily 08:00` ACTIVO.
- **Playlist "Para resumir": 8 videos en cola, SIN arrancar.** No hay propuesta pendiente (el video de quantum se saltó).
- Build limpio, todos los fixes desplegados.

### ▶️ SIGUIENTE PASO INMEDIATO
Decirle a Jano **"revisa la playlist"** → arranca con los 8 (propone el primero). Luego cada "guardar"/"salta" avanza al siguiente hasta vaciar la cola. (Si no, el cron de mañana 08:00 los drena solo.)

---

## 3. Pendientes abiertos

Resueltos 2026-06-21:
- ✅ **Docs de Jano** — `Jano/CLAUDE.md` al día (suite resumir completa) + página de Jano re-sincronizada a Notion (DB Agentes AI: 64 custom tools, 146 MCP tools).
- ✅ **Título de Readwise para podcasts no-YouTube** — el LLM propone el título en el meta JSON (commit 84cd365); ya no cae a hostname.

---

## 4. Decisiones de diseño (no recontestar)
- Highlights = **clásicos (v2) ligados por URL** con tag individual (la API de Reader NO permite highlights inline en el doc — confirmado por test).
- Tags del doc = **solo temáticos**, reutilizando la taxonomía existente de Reader.
- Resumen **en el idioma del contenido** (no traducir salvo pedido explícito).
- Checkpoint: **nada se guarda sin OK de Cal**.
- Playlist: dedicada propia (no Watch Later — Google la restringió) · 1×/día · propone y espera.
- YouTube va por `resumirContenido` (captions), **NO** por el skill `resumir-youtube` (su entrega usa MCP notifications, no disponible en Jano).

## 5. Gotchas
- `safari-fetch`/`node-fda` necesitan FDA para leer cookies de Safari (bajo launchd, el daemon lo logró; si da `needs-fda`, otorgar FDA a `~/.claude/bin/node-fda` en Ajustes).
- El CLAUDE.md global "responder siempre en español" se filtra a subprocess `claude -p` → la tool lo anula explícitamente con el idioma detectado.
- **REGLA DURA (nueva):** nunca borrar nada sin explicar y pedir autorización (ver `~/.claude/CLAUDE.md` § Acciones destructivas + memoria `feedback_confirmar_antes_de_borrar`). Origen: borré ~100 highlights de Readwise por un filtro mal asumido (`?source_url=` no filtra en la API v2).
- Readwise API v2 `/highlights/` NO filtra por `source_url`; usar `book_id`.
- Tras editar código del daemon: rebuild (`npm -w @cos/daemon run build`) + restart (bootout/bootstrap del plist) + correr subagent `daemon-health-reviewer`.

## 6. Memorias guardadas esta sesión
`reference_skill_resumir`, `project_jano_paywall_roto_fda`, `feedback_claudemd_global_spanish_subprocess`, `feedback_confirmar_antes_de_borrar`.

## 7. Comandos útiles
```bash
# Build + restart Jano
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/daemon run build
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
# Logs
tail -f ~/Library/Logs/cos-agent-v2.out.log
# Estado playlist
cat ~/.cos-agent/resumir-playlist-queue.json
cat ~/.cos-agent/resumir-playlists.json
```
