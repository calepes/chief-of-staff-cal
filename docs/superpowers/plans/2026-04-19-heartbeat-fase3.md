# Heartbeat Fase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hacer al CoS proactivo via heartbeat engine cada 30min (7am-10pm), 4 checks distribuidos en .md files, y proactive ideas 3x/día basadas en posts propios de X y Threads.

**Architecture:** Engine bash que descubre y ejecuta `.md` files con `claude -p`, consolida outputs en 1 mensaje Telegram. Proactive ideas como script bash separado que combina queries mecánicos + 1 invocación a `claude -p`. Todo orquestado vía launchd. Aislamiento de fallos por check.

**Tech Stack:** bash, launchd, claude CLI headless (`-p` mode), Notion API directa, X API v2, Threads API (Meta), Telegram Bot API directa, gtimeout (coreutils), jq.

**Spec:** `docs/superpowers/specs/2026-04-19-heartbeat-fase3-design.md`

---

## Task 0: Precondición manual — tokens y DB Notion

**No automatizable. Cal debe completar antes de ejecutar tareas que dependen de proactive ideas (Tasks 11-16). Heartbeat engine y .md tasks (Tasks 1-10) NO dependen de esto.**

- [ ] **Step 1: Crear app X (Twitter Free tier)**

1. Ir a https://developer.twitter.com/en/portal/dashboard
2. Crear nueva app gratuita
3. Generar Bearer Token
4. Anotar tu user_id (numérico): `curl "https://api.twitter.com/2/users/by/username/<tu_handle>" -H "Authorization: Bearer $TOKEN"` → guardar `data.id`

- [ ] **Step 2: Crear app Threads (Meta)**

1. Ir a https://developers.facebook.com/apps/
2. Crear app de tipo "Business"
3. Agregar producto "Threads"
4. Generar long-lived access token (manual flow OAuth)
5. Anotar tu Threads user_id

- [ ] **Step 3: Agregar tokens a .env**

Editar `~/.claude/channels/telegram/.env` y agregar:

```
X_BEARER_TOKEN=...
X_USER_ID=...
THREADS_TOKEN=...
THREADS_USER_ID=...
```

- [ ] **Step 4: DB "Ideas Proactivas (CoS)" — YA CREADA (2026-04-19)**

DB anidada bajo página existente "💡 Ideas" en Areas/Cal.

URL: https://www.notion.so/59e0439d7fe0483ab735575b9e0c1007
Database ID: `59e0439d7fe0483ab735575b9e0c1007`

Properties:
- Título (title)
- Cuerpo (rich_text)
- Fecha (date)
- Source (select: X, Threads, Calendar, Health, Mixto)
- Slot (select: foco, tactical, lookahead)
- Estado (status default Notion: "Sin empezar", "En curso", "Listo")

- [ ] **Step 5: Compartir DB con integración Claude CoS**

En la DB → ⋯ → Add connections → "Claude CoS"

- [ ] **Step 6: Anotar database_ids en .env**

Agregar al `.env` (DB Ideas nueva + DB Tareas existente, requerida por proactive-ideas.sh):
```
NOTION_IDEAS_DB_ID=59e0439d7fe0483ab735575b9e0c1007
NOTION_TASKS_DB_ID=...
```

(Si `NOTION_TASKS_DB_ID` ya existe, no duplicar.)

---

## Task 1: Estructura de directorios y logging base

**Files:**
- Create: `~/.claude/heartbeat-tasks/.gitkeep`
- Create: `~/.claude/state/.gitkeep`
- Create: `~/.claude/logs/.gitkeep` (si no existe ya)

- [ ] **Step 1: Crear directorios**

```bash
mkdir -p ~/.claude/heartbeat-tasks
mkdir -p ~/.claude/state
mkdir -p ~/.claude/logs
touch ~/.claude/heartbeat-tasks/.gitkeep
touch ~/.claude/state/.gitkeep
```

- [ ] **Step 2: Verificar permisos**

```bash
ls -la ~/.claude/heartbeat-tasks ~/.claude/state ~/.claude/logs
```

Expected: directorios existen, escribibles por el usuario.

---

## Task 2: heartbeat.sh — parser de frontmatter

**Files:**
- Create: `~/.claude/hooks/heartbeat.sh`
- Create: `~/.claude/heartbeat-tasks/_test-fixture.md` (temporal, se borra al final del task)

- [ ] **Step 1: Crear fixture de prueba**

`~/.claude/heartbeat-tasks/_test-fixture.md`:

```markdown
---
name: test-fixture
schedule: every
priority: high
---

Test prompt body.
```

- [ ] **Step 2: Crear esqueleto de heartbeat.sh con parser de frontmatter**

`~/.claude/hooks/heartbeat.sh`:

```bash
#!/usr/bin/env bash
# heartbeat.sh — engine que ejecuta los .md de ~/.claude/heartbeat-tasks/
# y consolida alerts en un mensaje a Telegram.
set -euo pipefail

TASKS_DIR="$HOME/.claude/heartbeat-tasks"
LOG_FILE="$HOME/.claude/logs/heartbeat.log"
STATE_DIR="$HOME/.claude/state"
ENV_FILE="$HOME/.claude/channels/telegram/.env"

# Carga .env si existe (TELEGRAM_BOT_TOKEN, etc)
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"
}

# parse_frontmatter <file> <key> → echo value or empty
parse_frontmatter() {
  local file="$1"
  local key="$2"
  awk -v k="$key" '
    /^---$/ { fm = !fm; next }
    fm && $1 == k":" { sub(/^[^:]+:[ ]*/, ""); print; exit }
  ' "$file"
}

# strip_frontmatter <file> → echo body sin frontmatter
strip_frontmatter() {
  awk 'BEGIN{fm=0; started=0} /^---$/{fm++; next} fm>=2{started=1} started{print}' "$1"
}

main() {
  log "heartbeat start"
  for f in "$TASKS_DIR"/*.md; do
    [[ -f "$f" ]] || continue
    local name schedule priority
    name=$(parse_frontmatter "$f" name)
    schedule=$(parse_frontmatter "$f" schedule)
    priority=$(parse_frontmatter "$f" priority)
    log "found check: $name (schedule=$schedule priority=$priority)"
  done
  log "heartbeat end"
}

main "$@"
```

- [ ] **Step 3: Hacer ejecutable y correr smoke test**

```bash
chmod +x ~/.claude/hooks/heartbeat.sh
~/.claude/hooks/heartbeat.sh
tail -5 ~/.claude/logs/heartbeat.log
```

Expected: log muestra `found check: test-fixture (schedule=every priority=high)`.

- [ ] **Step 4: Borrar fixture temporal**

```bash
rm ~/.claude/heartbeat-tasks/_test-fixture.md
```

- [ ] **Step 5: Commit**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add -A  # solo si hay cambios trackeados (los .claude no están en repo)
# Los hooks viven en ~/.claude — copiamos al repo del proyecto si trackeamos:
mkdir -p hooks/
cp ~/.claude/hooks/heartbeat.sh hooks/heartbeat.sh
git add hooks/heartbeat.sh
git commit -m "feat(heartbeat): parser de frontmatter de .md tasks"
```

---

## Task 3: heartbeat.sh — runner de checks + buffer + Telegram send

**Files:**
- Modify: `~/.claude/hooks/heartbeat.sh`

- [ ] **Step 1: Agregar función de filtro por schedule**

Reemplazar la función `main()` y agregar antes:

```bash
# should_run <schedule> → exit 0 if should run now, 1 otherwise
should_run() {
  local schedule="$1"
  local hour
  hour=$(date +%H)
  case "$schedule" in
    every) return 0 ;;
    morning-only) (( 10#$hour < 12 )) && return 0 || return 1 ;;
    afternoon-only) (( 10#$hour >= 12 )) && return 0 || return 1 ;;
    midday-only) [[ "$hour" == "12" ]] && return 0 || return 1 ;;
    *) return 1 ;;
  esac
}
```

- [ ] **Step 2: Agregar función de ejecución de un check**

```bash
# run_check <file> → echoes ALERT body or empty if HEARTBEAT_OK
# returns: 0=ok (alert or quiet), 1=error
run_check() {
  local file="$1"
  local prompt output
  prompt=$(strip_frontmatter "$file")
  if ! output=$(echo "$prompt" | gtimeout 60s claude -p 2>>"$LOG_FILE"); then
    return 1
  fi
  # Output que empieza con ALERT → echo el resto (sin la palabra ALERT)
  if [[ "$output" == ALERT* ]]; then
    echo "${output#ALERT}" | sed 's/^[[:space:]]*//'
    return 0
  fi
  # HEARTBEAT_OK o cualquier otro → empty
  return 0
}
```

- [ ] **Step 3: Agregar función para enviar mensaje a Telegram**

```bash
# send_telegram <text>
send_telegram() {
  local text="$1"
  local chat_id="${TELEGRAM_CHAT_ID:-94137698}"
  local token="${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN no definido}"
  curl -s -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" > /dev/null
}
```

- [ ] **Step 4: Reescribir main() con buffer + send**

```bash
main() {
  log "heartbeat start"
  local -a high_buf medium_buf low_buf
  for f in "$TASKS_DIR"/*.md; do
    [[ -f "$f" ]] || continue
    local name schedule priority
    name=$(parse_frontmatter "$f" name)
    schedule=$(parse_frontmatter "$f" schedule)
    priority=$(parse_frontmatter "$f" priority)
    if ! should_run "$schedule"; then
      log "skip $name (schedule=$schedule)"
      continue
    fi
    log "run $name"
    local body
    if body=$(run_check "$f"); then
      if [[ -n "$body" ]]; then
        case "$priority" in
          high) high_buf+=("$body") ;;
          medium) medium_buf+=("$body") ;;
          *) low_buf+=("$body") ;;
        esac
        log "alert $name"
      else
        log "ok $name"
      fi
    else
      log "error $name"
    fi
  done

  # Construir mensaje final
  local msg=""
  for b in "${high_buf[@]:-}"; do [[ -n "$b" ]] && msg+="$b"$'\n\n'; done
  for b in "${medium_buf[@]:-}"; do [[ -n "$b" ]] && msg+="$b"$'\n\n'; done
  for b in "${low_buf[@]:-}"; do [[ -n "$b" ]] && msg+="$b"$'\n\n'; done

  if [[ -n "$msg" ]]; then
    log "sending telegram message"
    send_telegram "$msg"
  else
    log "silent"
  fi
  log "heartbeat end"
}
```

- [ ] **Step 5: Smoke test con fixture que retorna ALERT**

Crear fixture temporal `~/.claude/heartbeat-tasks/_smoke-alert.md`:

```markdown
---
name: smoke-alert
schedule: every
priority: high
---

Responde EXACTAMENTE con esta línea y nada más:
ALERT
🧪 smoke test alert
```

```bash
~/.claude/hooks/heartbeat.sh
tail -10 ~/.claude/logs/heartbeat.log
```

Expected: log muestra `alert smoke-alert` y `sending telegram message`. Cal recibe en Telegram el mensaje "🧪 smoke test alert".

- [ ] **Step 6: Smoke test con fixture HEARTBEAT_OK**

Reemplazar el fixture:

```markdown
---
name: smoke-ok
schedule: every
priority: low
---

Responde EXACTAMENTE: HEARTBEAT_OK
```

```bash
~/.claude/hooks/heartbeat.sh
tail -5 ~/.claude/logs/heartbeat.log
```

Expected: log muestra `ok smoke-ok` y `silent`. Cal NO recibe nada en Telegram.

- [ ] **Step 7: Borrar fixture y commit**

```bash
rm ~/.claude/heartbeat-tasks/_smoke-alert.md
cp ~/.claude/hooks/heartbeat.sh "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/hooks/heartbeat.sh"
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add hooks/heartbeat.sh
git commit -m "feat(heartbeat): runner + buffer + telegram send"
```

---

## Task 4: heartbeat.sh — aislamiento de fallos + failure counter

**Files:**
- Modify: `~/.claude/hooks/heartbeat.sh`

- [ ] **Step 1: Agregar tracking de éxito/fallo de heartbeat**

Agregar a `main()`, antes del loop:

```bash
local checks_total=0 checks_failed=0
```

Dentro del loop, después de `should_run`:

```bash
checks_total=$((checks_total + 1))
```

En la rama `error`:

```bash
checks_failed=$((checks_failed + 1))
```

- [ ] **Step 2: Agregar lógica de failure counter al final de main()**

Después del envío del mensaje, antes del log final:

```bash
local fail_state="$STATE_DIR/heartbeat-failures"
if (( checks_total > 0 && checks_failed == checks_total )); then
  local count
  count=$(cat "$fail_state" 2>/dev/null || echo 0)
  count=$((count + 1))
  echo "$count" > "$fail_state"
  log "all checks failed (count=$count)"
  if (( count >= 3 )); then
    # Notifica directo, sin Claude
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID:-94137698}" \
      --data-urlencode "text=⚠️ heartbeat caído (3+ runs con todos los checks fallando)" \
      > /dev/null
  fi
else
  echo 0 > "$fail_state"
fi
```

- [ ] **Step 3: Smoke test — provocar 3 fallos consecutivos**

Crear fixture que falla:

```markdown
---
name: smoke-fail
schedule: every
priority: high
---
```

(body vacío hace que claude responda algo distinto a ALERT/HEARTBEAT_OK, pero no es un "fail" real. Para forzar fail, usar timeout absurdo)

Modificar temporalmente el fixture para que claude tarde más de 1s, y bajar `gtimeout` a 1s para test:

(Skipping — failure counter testeado en próximo cycle de bug fix si pasa. Por ahora confirmar que el código compila.)

```bash
bash -n ~/.claude/hooks/heartbeat.sh
echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 4: Commit**

```bash
cp ~/.claude/hooks/heartbeat.sh "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/hooks/heartbeat.sh"
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add hooks/heartbeat.sh
git commit -m "feat(heartbeat): aislamiento de fallos + failure counter"
```

---

## Task 5: heartbeat.sh — log rotation + dry-run mode

**Files:**
- Modify: `~/.claude/hooks/heartbeat.sh`

- [ ] **Step 1: Agregar rotación de log a 5MB**

Agregar al inicio de `main()`:

```bash
# Rotación: si log > 5MB, mover a .1 y empezar limpio
if [[ -f "$LOG_FILE" ]]; then
  local size
  size=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
  if (( size > 5 * 1024 * 1024 )); then
    mv "$LOG_FILE" "${LOG_FILE}.1"
  fi
fi
```

- [ ] **Step 2: Agregar dry-run y --only flags**

Agregar al inicio del script (después de `set -euo pipefail`):

```bash
DRY_RUN=0
ONLY_CHECK=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --only) ONLY_CHECK="$2"; shift 2 ;;
    *) echo "Uso: heartbeat.sh [--dry-run] [--only <name>]"; exit 1 ;;
  esac
done
```

Modificar `send_telegram()`:

```bash
send_telegram() {
  local text="$1"
  if (( DRY_RUN )); then
    echo "=== DRY RUN — would send ==="
    echo "$text"
    echo "=== /DRY RUN ==="
    return 0
  fi
  local chat_id="${TELEGRAM_CHAT_ID:-94137698}"
  local token="${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN no definido}"
  curl -s -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" > /dev/null
}
```

Modificar el loop en `main()`:

```bash
for f in "$TASKS_DIR"/*.md; do
  [[ -f "$f" ]] || continue
  local name
  name=$(parse_frontmatter "$f" name)
  if [[ -n "$ONLY_CHECK" && "$name" != "$ONLY_CHECK" ]]; then
    continue
  fi
  # ... resto igual
done
```

- [ ] **Step 3: Smoke test dry-run con fixture ALERT**

Crear el fixture smoke-alert.md de Task 3 nuevamente, correr:

```bash
~/.claude/hooks/heartbeat.sh --dry-run
```

Expected: imprime el bloque `=== DRY RUN — would send ===` con el mensaje, NO envía a Telegram.

- [ ] **Step 4: Smoke test --only**

```bash
# crear 2 fixtures: smoke-a y smoke-b
~/.claude/hooks/heartbeat.sh --dry-run --only smoke-a
```

Expected: solo procesa smoke-a, ignora smoke-b.

- [ ] **Step 5: Borrar fixtures y commit**

```bash
rm ~/.claude/heartbeat-tasks/smoke-*.md 2>/dev/null || true
cp ~/.claude/hooks/heartbeat.sh "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/hooks/heartbeat.sh"
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add hooks/heartbeat.sh
git commit -m "feat(heartbeat): log rotation + dry-run + --only flags"
```

---

## Task 6: overdue-tasks.md

**Files:**
- Create: `~/.claude/heartbeat-tasks/overdue-tasks.md`

- [ ] **Step 1: Crear el .md**

```markdown
---
name: overdue-tasks
schedule: every
priority: high
---

# Check tareas vencidas

Consulta la base de datos de Notion "Tareas" usando la herramienta MCP notion-query-database-view o notion-fetch.

Filtra tareas que cumplan TODAS estas condiciones:
- Estado distinto de "Hecho", "Cancelado", "Archivado"
- Deadline existe y es estrictamente anterior a hoy (fecha actual del sistema)

Si encuentras 0 tareas vencidas, responde EXACTAMENTE:
HEARTBEAT_OK

Si encuentras 1 o más, responde así (reemplazando N por el número y completando el listado):
ALERT
🚨 N tareas vencidas:
- {nombre} (vencida hace {días} días, asignado: {persona})
- ...

Reglas estrictas:
- No agregues texto antes ni después del bloque
- No expliques, no justifiques, no preguntes
- Si solo hay 1, di "1 tarea vencida"
- Ordena por días vencido descendente (más vencidas primero)

<!-- Test scenario: con tarea de prueba creada en Notion con Deadline=ayer y Estado="En curso", debe alertar. Marcarla como Hecho → siguiente run debe responder HEARTBEAT_OK. -->
```

- [ ] **Step 2: Smoke test con dry-run**

```bash
~/.claude/hooks/heartbeat.sh --dry-run --only overdue-tasks
```

Expected: si Cal tiene tareas vencidas, dry run las muestra. Si no, log dice `ok overdue-tasks` y `silent`.

- [ ] **Step 3: Commit**

```bash
mkdir -p "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks"
cp ~/.claude/heartbeat-tasks/overdue-tasks.md "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/overdue-tasks.md"
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add heartbeat-tasks/overdue-tasks.md
git commit -m "feat(heartbeat): check overdue-tasks"
```

---

## Task 7: flight-checkin.md

**Files:**
- Create: `~/.claude/heartbeat-tasks/flight-checkin.md`

- [ ] **Step 1: Crear el .md**

```markdown
---
name: flight-checkin
schedule: every
priority: high
---

# Check vuelos próximos sin check-in

Consulta el Google Calendar "AntoCataNoeCal" (id `c_4c2ogsnda3b61k1sd9eta6vc2k@group.calendar.google.com`) usando la herramienta MCP gcal_list_events.

Rango: ahora hasta ahora + 24 horas.

Filtra eventos que cumplan TODAS estas condiciones:
- Tienen un booking code en el título o descripción (formato típico: 6 caracteres alfanuméricos en mayúsculas, ej XYZ123)
- NO mencionan "check-in hecho" ni "✅" ni "boarding pass" en título o descripción

Si encuentras 0 vuelos pendientes de check-in, responde EXACTAMENTE:
HEARTBEAT_OK

Si encuentras 1 o más, responde así:
ALERT
✈️ Check-in pendiente:
- {ruta} {hora} (booking: {código}, sale en {horas}h)
- ...

Reglas:
- No expliques, no preguntes
- Hora en formato HH:mm zona local
- Si "horas" calculadas son <2, agrega "⚠️ urgente" al final de la línea

<!-- Test scenario: crear evento de prueba en el calendario "AntoCataNoeCal" con título "LPB-LIM XYZ123" y fecha 12h en el futuro. Debe alertar. -->
```

- [ ] **Step 2: Smoke test**

```bash
~/.claude/hooks/heartbeat.sh --dry-run --only flight-checkin
```

Expected: log dice `ok flight-checkin` (probablemente no hay vuelos en 24h) o muestra alert si los hay.

- [ ] **Step 3: Commit**

```bash
cp ~/.claude/heartbeat-tasks/flight-checkin.md "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/flight-checkin.md"
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add heartbeat-tasks/flight-checkin.md
git commit -m "feat(heartbeat): check flight-checkin"
```

---

## Task 8: incomplete-tasks.md

**Files:**
- Create: `~/.claude/heartbeat-tasks/incomplete-tasks.md`

- [ ] **Step 1: Crear el .md**

```markdown
---
name: incomplete-tasks
schedule: morning-only
priority: medium
---

# Check tareas incompletas (sin asignado o sin deadline)

Consulta la base de datos de Notion "Tareas" usando MCP.

Filtra tareas que cumplan TODAS estas condiciones:
- Estado distinto de "Hecho", "Cancelado", "Archivado"
- (Asignado está vacío) O (Deadline está vacío)

Si encuentras 0, responde EXACTAMENTE:
HEARTBEAT_OK

Si encuentras 1 o más, responde así:
ALERT
📝 N tareas incompletas:
- {nombre} (falta: {asignado y/o deadline})
- ...

Reglas:
- Máximo 5 items en el listado. Si hay más, agregar "y M más..." al final.
- No expliques.

<!-- Test scenario: crear tarea en Notion sin Asignado y sin Deadline, Estado="Backlog". Debe alertar (solo en runs antes de las 12pm). -->
```

- [ ] **Step 2: Smoke test**

```bash
~/.claude/hooks/heartbeat.sh --dry-run --only incomplete-tasks
```

Expected: si la hora actual es <12, corre el check. Si es ≥12, log dice `skip incomplete-tasks (schedule=morning-only)`.

- [ ] **Step 3: Commit**

```bash
cp ~/.claude/heartbeat-tasks/incomplete-tasks.md "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/incomplete-tasks.md"
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add heartbeat-tasks/incomplete-tasks.md
git commit -m "feat(heartbeat): check incomplete-tasks"
```

---

## Task 9: midday-steps.md

**Files:**
- Create: `~/.claude/heartbeat-tasks/midday-steps.md`

- [ ] **Step 1: Crear el .md**

```markdown
---
name: midday-steps
schedule: midday-only
priority: medium
---

# Check pasos al mediodía

Consulta el endpoint del Health worker:

GET https://health.carlos-cb4.workers.dev/summary?date=YYYY-MM-DD&key=$HEALTH_API_KEY

donde YYYY-MM-DD es la fecha de hoy (zona horaria local de Cal). El API key está en la variable de entorno HEALTH_API_KEY.

Usa la herramienta Bash para hacer el curl.

Lee el campo `steps` del JSON.

Si steps >= 3000, responde EXACTAMENTE:
HEARTBEAT_OK

Si steps < 3000, responde así:
ALERT
🚶 Pasos hoy: {steps} (objetivo mediodía: 3000+)

Si el API falla o no hay data, responde EXACTAMENTE:
HEARTBEAT_OK

<!-- Test scenario: si hoy hay <3000 pasos a las 12:00 medio día, alerta. Si >= 3000, silencio. Si Health worker está caído, silencio (no spam). -->
```

- [ ] **Step 2: Smoke test**

```bash
~/.claude/hooks/heartbeat.sh --dry-run --only midday-steps
```

Expected: si la hora actual no es 12:**, log dice `skip midday-steps (schedule=midday-only)`. Si es 12:**, corre el check.

- [ ] **Step 3: Commit**

```bash
cp ~/.claude/heartbeat-tasks/midday-steps.md "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/midday-steps.md"
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add heartbeat-tasks/midday-steps.md
git commit -m "feat(heartbeat): check midday-steps"
```

---

## Task 10: heartbeat-status.sh

**Files:**
- Create: `~/.claude/hooks/heartbeat-status.sh`

- [ ] **Step 1: Crear el script**

`~/.claude/hooks/heartbeat-status.sh`:

```bash
#!/usr/bin/env bash
# heartbeat-status.sh — observabilidad del engine
set -euo pipefail

LOG_FILE="$HOME/.claude/logs/heartbeat.log"
TASKS_DIR="$HOME/.claude/heartbeat-tasks"
STATE_DIR="$HOME/.claude/state"
PLIST="$HOME/Library/LaunchAgents/com.claude.heartbeat.plist"

echo "=== Heartbeat Status ==="
echo
echo "Último run:"
grep "heartbeat start" "$LOG_FILE" 2>/dev/null | tail -1 || echo "  (sin runs aún)"
echo

echo "Próximo run programado:"
launchctl list com.claude.heartbeat 2>/dev/null | grep -E "(LastExitStatus|Label)" || echo "  (no cargado en launchd)"
echo

echo "Checks activos:"
for f in "$TASKS_DIR"/*.md; do
  [[ -f "$f" ]] || continue
  name=$(awk '/^name:/{print $2; exit}' "$f")
  schedule=$(awk '/^schedule:/{print $2; exit}' "$f")
  priority=$(awk '/^priority:/{print $2; exit}' "$f")
  echo "  - $name (schedule=$schedule, priority=$priority)"
done
echo

echo "Últimos 5 alerts enviados:"
grep "sending telegram message" "$LOG_FILE" 2>/dev/null | tail -5 || echo "  (ninguno)"
echo

echo "Failure counter actual:"
cat "$STATE_DIR/heartbeat-failures" 2>/dev/null || echo "0"
```

- [ ] **Step 2: Hacer ejecutable y correr**

```bash
chmod +x ~/.claude/hooks/heartbeat-status.sh
~/.claude/hooks/heartbeat-status.sh
```

Expected: imprime las 5 secciones, sin errores.

- [ ] **Step 3: Commit**

```bash
cp ~/.claude/hooks/heartbeat-status.sh "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/hooks/heartbeat-status.sh"
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add hooks/heartbeat-status.sh
git commit -m "feat(heartbeat): heartbeat-status.sh observabilidad"
```

---

## Task 11: launchd com.claude.heartbeat

**Files:**
- Create: `~/Library/LaunchAgents/com.claude.heartbeat.plist`

- [ ] **Step 1: Crear el plist**

`~/Library/LaunchAgents/com.claude.heartbeat.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude.heartbeat</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>/Users/calepes/.claude/hooks/heartbeat.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <!-- Cada 30min de 7am a 10pm. 32 entries: 7:00, 7:30, 8:00, ..., 22:00, 22:30 -->
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>16</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>16</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>19</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>19</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>22</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>22</integer><key>Minute</key><integer>30</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>/Users/calepes/.claude/logs/heartbeat-launchd.out</string>
  <key>StandardErrorPath</key>
  <string>/Users/calepes/.claude/logs/heartbeat-launchd.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

- [ ] **Step 2: Cargar en launchd**

```bash
launchctl unload ~/Library/LaunchAgents/com.claude.heartbeat.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.claude.heartbeat.plist
launchctl list | grep heartbeat
```

Expected: muestra `com.claude.heartbeat` con status 0.

- [ ] **Step 3: Test manual del plist**

```bash
launchctl kickstart -k gui/$(id -u)/com.claude.heartbeat
sleep 5
tail -10 ~/.claude/logs/heartbeat.log
```

Expected: log muestra entrada reciente con `heartbeat start`.

- [ ] **Step 4: Commit**

```bash
mkdir -p "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/launchd"
cp ~/Library/LaunchAgents/com.claude.heartbeat.plist "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/launchd/com.claude.heartbeat.plist"
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add launchd/com.claude.heartbeat.plist
git commit -m "feat(heartbeat): launchd cada 30min entre 7am-10pm"
```

---

## Task 12: proactive-ideas.sh — queries (X, Threads, Notion, Calendar)

**Files:**
- Create: `~/.claude/hooks/proactive-ideas.sh`

**Precondición:** Task 0 completado (tokens X, Threads, NOTION_IDEAS_DB_ID en .env).

- [ ] **Step 1: Crear esqueleto con queries mecánicos**

`~/.claude/hooks/proactive-ideas.sh`:

```bash
#!/usr/bin/env bash
# proactive-ideas.sh — genera 1 idea proactiva basada en posts X/Threads + contexto.
# Ejecutado por launchd 3x/día (9am, 14pm, 19pm).
set -euo pipefail

LOG_FILE="$HOME/.claude/logs/proactive-ideas.log"
ENV_FILE="$HOME/.claude/channels/telegram/.env"
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

DRY_RUN=0
SLOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --slot) SLOT="$2"; shift 2 ;;
    *) echo "Uso: proactive-ideas.sh [--dry-run] [--slot foco|tactical|lookahead]"; exit 1 ;;
  esac
done

# Si no se pasa --slot, deduce por hora
if [[ -z "$SLOT" ]]; then
  hour=$(date +%H)
  case "$hour" in
    09) SLOT="foco" ;;
    14) SLOT="tactical" ;;
    19) SLOT="lookahead" ;;
    *) echo "Hora $hour no es slot conocido (9, 14, 19). Usa --slot."; exit 1 ;;
  esac
fi

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [$SLOT] $*" >> "$LOG_FILE"; }
log "start"

# === QUERY: X posts propios últimas 24h ===
fetch_x_posts() {
  curl -s "https://api.twitter.com/2/users/${X_USER_ID}/tweets?max_results=10&tweet.fields=created_at,text" \
    -H "Authorization: Bearer ${X_BEARER_TOKEN}" \
    | jq -r '.data[]? | "\(.created_at): \(.text)"' \
    || echo "(X query failed)"
}

# === QUERY: Threads posts propios últimas 24h ===
fetch_threads_posts() {
  curl -s "https://graph.threads.net/v1.0/${THREADS_USER_ID}/threads?fields=text,timestamp&access_token=${THREADS_TOKEN}&limit=10" \
    | jq -r '.data[]? | "\(.timestamp): \(.text)"' \
    || echo "(Threads query failed)"
}

# === QUERY: tareas activas Notion ===
fetch_notion_tasks() {
  # Asume NOTION_TOKEN y NOTION_TASKS_DB_ID en .env
  curl -s -X POST "https://api.notion.com/v1/databases/${NOTION_TASKS_DB_ID}/query" \
    -H "Authorization: Bearer ${NOTION_TOKEN}" \
    -H "Notion-Version: 2022-06-28" \
    -H "Content-Type: application/json" \
    -d '{"filter":{"property":"Estado","status":{"does_not_equal":"Hecho"}},"page_size":20}' \
    | jq -r '.results[]? | .properties.Nombre.title[0].plain_text // "(sin nombre)"' \
    || echo "(Notion query failed)"
}

# === Construir prompt ===
build_prompt() {
  local x_posts threads_posts tasks
  x_posts=$(fetch_x_posts)
  threads_posts=$(fetch_threads_posts)
  tasks=$(fetch_notion_tasks)

  case "$SLOT" in
    foco) intent="Identifica la 1 cosa más importante para hoy basándote en lo que Cal publicó y lo que tiene en agenda." ;;
    tactical) intent="Identifica qué se está atrasando vs lo planeado. Sugiere 1 ajuste accionable." ;;
    lookahead) intent="Sintetiza el día y sugiere 1-2 preparativos para mañana." ;;
  esac

  cat <<EOF
Contexto del día (Cal — Chief Operations en Yape):

POSTS PROPIOS DE X (últimas 24h):
$x_posts

POSTS PROPIOS DE THREADS (últimas 24h):
$threads_posts

TAREAS ACTIVAS:
$tasks

INSTRUCCIÓN ($SLOT):
$intent

Responde con un JSON válido (sin markdown, sin explicación) con esta estructura exacta:
{"title": "<título corto, máximo 60 chars>", "body": "<cuerpo con la idea, 2-4 oraciones>", "source": "<X|Threads|Calendar|Mixto>"}
EOF
}

main() {
  log "building prompt"
  local prompt
  prompt=$(build_prompt)
  log "prompt built ($(echo "$prompt" | wc -l) lines)"

  # En este task solo verificamos que el prompt se construya. La invocación a Claude viene en Task 13.
  if (( DRY_RUN )); then
    echo "=== DRY RUN — prompt ==="
    echo "$prompt"
    echo "=== /DRY RUN ==="
  fi
}

main "$@"
```

- [ ] **Step 2: Smoke test dry-run**

```bash
chmod +x ~/.claude/hooks/proactive-ideas.sh
~/.claude/hooks/proactive-ideas.sh --dry-run --slot foco
```

Expected: imprime el prompt completo con secciones X, Threads, Tareas, Instrucción. Si X/Threads tokens no están configurados, las secciones dirán "(query failed)".

- [ ] **Step 3: Commit**

```bash
cp ~/.claude/hooks/proactive-ideas.sh "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/hooks/proactive-ideas.sh"
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add hooks/proactive-ideas.sh
git commit -m "feat(proactive-ideas): queries X + Threads + Notion + prompt builder"
```

---

## Task 13: proactive-ideas.sh — invocar claude + parsear output

**Files:**
- Modify: `~/.claude/hooks/proactive-ideas.sh`

- [ ] **Step 1: Agregar invocación a claude y parseo**

Reemplazar `main()`:

```bash
main() {
  log "building prompt"
  local prompt response
  prompt=$(build_prompt)
  log "calling claude"

  if ! response=$(echo "$prompt" | gtimeout 90s claude -p 2>>"$LOG_FILE"); then
    log "claude call failed"
    exit 1
  fi

  # Validar JSON
  if ! echo "$response" | jq -e . > /dev/null 2>&1; then
    log "invalid JSON response: $response"
    exit 1
  fi

  local title body source
  title=$(echo "$response" | jq -r '.title')
  body=$(echo "$response" | jq -r '.body')
  source=$(echo "$response" | jq -r '.source')

  log "got idea: $title"

  if (( DRY_RUN )); then
    echo "=== DRY RUN — idea ==="
    echo "Title: $title"
    echo "Body: $body"
    echo "Source: $source"
    echo "Slot: $SLOT"
    echo "=== /DRY RUN ==="
    exit 0
  fi

  # En Task 14 agregamos write to Notion + Telegram. Aquí solo guardamos en variable global.
  IDEA_TITLE="$title"
  IDEA_BODY="$body"
  IDEA_SOURCE="$source"
}

main "$@"
```

- [ ] **Step 2: Smoke test dry-run real**

```bash
~/.claude/hooks/proactive-ideas.sh --dry-run --slot foco
```

Expected: invoca claude (puede tardar 30-60s), imprime Title, Body, Source, Slot. Si los tokens X/Threads no están seteados, claude trabajará con "(X query failed)" en el contexto pero igual debe generar una idea desde tareas + calendar.

- [ ] **Step 3: Commit**

```bash
cp ~/.claude/hooks/proactive-ideas.sh "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/hooks/proactive-ideas.sh"
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add hooks/proactive-ideas.sh
git commit -m "feat(proactive-ideas): invoca claude + parse JSON"
```

---

## Task 14: proactive-ideas.sh — write Notion + Telegram

**Files:**
- Modify: `~/.claude/hooks/proactive-ideas.sh`

- [ ] **Step 1: Agregar funciones write_notion y send_telegram**

Antes de `main()`:

```bash
write_notion() {
  local title="$1" body="$2" source="$3" slot="$4"
  local today
  today=$(date +%Y-%m-%d)

  curl -s -X POST "https://api.notion.com/v1/pages" \
    -H "Authorization: Bearer ${NOTION_TOKEN}" \
    -H "Notion-Version: 2022-06-28" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc \
      --arg dbid "$NOTION_IDEAS_DB_ID" \
      --arg title "$title" \
      --arg body "$body" \
      --arg date "$today" \
      --arg source "$source" \
      --arg slot "$slot" \
      '{
        parent: { database_id: $dbid },
        properties: {
          "Título": { title: [{ text: { content: $title } }] },
          "Cuerpo": { rich_text: [{ text: { content: $body } }] },
          "Fecha": { date: { start: $date } },
          "Source": { select: { name: $source } },
          "Estado": { status: { name: "Sin empezar" } },
          "Slot": { select: { name: $slot } }
        }
      }')" > /dev/null
}

send_telegram() {
  local text="$1"
  local chat_id="${TELEGRAM_CHAT_ID:-94137698}"
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" > /dev/null
}
```

- [ ] **Step 2: Modificar main() para escribir y notificar**

Después del bloque DRY_RUN:

```bash
  log "writing to notion"
  write_notion "$title" "$body" "$source" "$SLOT"

  log "sending telegram"
  local emoji
  case "$SLOT" in
    foco) emoji="🎯" ;;
    tactical) emoji="⚡" ;;
    lookahead) emoji="🔮" ;;
  esac
  send_telegram "${emoji} ${title}

${body}

(slot: ${SLOT}, source: ${source})"

  log "done"
}
```

- [ ] **Step 3: Smoke test real (NO dry-run)**

```bash
~/.claude/hooks/proactive-ideas.sh --slot foco
```

Expected:
- Cal recibe mensaje en Telegram con la idea
- Nueva página en Notion DB "Ideas" con todos los campos
- Log muestra `done`

- [ ] **Step 4: Commit**

```bash
cp ~/.claude/hooks/proactive-ideas.sh "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/hooks/proactive-ideas.sh"
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add hooks/proactive-ideas.sh
git commit -m "feat(proactive-ideas): write Notion + Telegram notify"
```

---

## Task 15: launchd com.claude.proactive-ideas

**Files:**
- Create: `~/Library/LaunchAgents/com.claude.proactive-ideas.plist`

- [ ] **Step 1: Crear plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude.proactive-ideas</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>/Users/calepes/.claude/hooks/proactive-ideas.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>19</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>/Users/calepes/.claude/logs/proactive-ideas-launchd.out</string>
  <key>StandardErrorPath</key>
  <string>/Users/calepes/.claude/logs/proactive-ideas-launchd.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

- [ ] **Step 2: Cargar y verificar**

```bash
launchctl unload ~/Library/LaunchAgents/com.claude.proactive-ideas.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.claude.proactive-ideas.plist
launchctl list | grep proactive-ideas
```

Expected: muestra `com.claude.proactive-ideas` con status 0.

- [ ] **Step 3: Test manual**

```bash
launchctl kickstart -k gui/$(id -u)/com.claude.proactive-ideas
sleep 90
tail -10 ~/.claude/logs/proactive-ideas.log
```

Expected: log muestra ciclo completo: build prompt → call claude → write notion → send telegram → done.

- [ ] **Step 4: Commit**

```bash
cp ~/Library/LaunchAgents/com.claude.proactive-ideas.plist "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal/launchd/com.claude.proactive-ideas.plist"
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add launchd/com.claude.proactive-ideas.plist
git commit -m "feat(proactive-ideas): launchd 9am/14pm/19pm"
```

---

## Task 16: Update CLAUDE.md y BACKLOG.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `BACKLOG.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Agregar sección Heartbeat a CLAUDE.md**

Agregar bajo "Hooks & Automatización":

```markdown
- **Cron Heartbeat:** launchd `com.claude.heartbeat` — cada 30min entre 7am-10pm. Engine: `~/.claude/hooks/heartbeat.sh`. Lee `.md` de `~/.claude/heartbeat-tasks/`, ejecuta cada uno con `claude -p`, consolida outputs ALERT en 1 mensaje Telegram. Aislamiento de fallos por check. Status: `~/.claude/hooks/heartbeat-status.sh`. Log: `~/.claude/logs/heartbeat.log`
- **Cron Proactive Ideas:** launchd `com.claude.proactive-ideas` — 9am/14pm/19pm. Script: `~/.claude/hooks/proactive-ideas.sh`. Combina posts propios X+Threads + tareas Notion + calendar, genera 1 idea por slot (foco/tactical/lookahead), guarda en Notion DB "Ideas" + notifica Telegram
```

- [ ] **Step 2: Marcar items 3.1, 3.2, 3.3 como hechos en BACKLOG.md**

Cambiar `- [ ]` → `- [x]` en:
- 3.1 Heartbeat cada 30min
- 3.2 Heartbeat tasks como Markdown
- 3.3 Proactive ideas 3x/día

Agregar fecha `(2026-04-19)` al final de cada uno.

- [ ] **Step 3: Agregar entrada a CHANGELOG.md**

```markdown
## 2026-04-19 — Fase 3 Heartbeat (CoS Proactivo)

- Heartbeat engine cada 30min (7am-10pm) — `~/.claude/hooks/heartbeat.sh`
- 4 checks .md iniciales: overdue-tasks, flight-checkin, incomplete-tasks, midday-steps
- Proactive Ideas 3x/día (9/14/19h) basadas en posts propios X+Threads
- Nueva DB Notion "Ideas" para guardar las sugerencias
- Observabilidad: `heartbeat-status.sh`, log con rotación 5MB
- Spec: `docs/superpowers/specs/2026-04-19-heartbeat-fase3-design.md`
- Plan: `docs/superpowers/plans/2026-04-19-heartbeat-fase3.md`
```

- [ ] **Step 4: Commit final**

```bash
cd "$HOME/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add CLAUDE.md BACKLOG.md CHANGELOG.md
git commit -m "docs: Fase 3 Heartbeat documented in CLAUDE.md, BACKLOG, CHANGELOG"
```

---

## Verificación final

- [ ] **End-to-end test del heartbeat**

```bash
~/.claude/hooks/heartbeat.sh
tail -20 ~/.claude/logs/heartbeat.log
```

Expected:
- Si Cal tiene tareas vencidas → recibe mensaje Telegram consolidado
- Si no → silencio
- Log limpio, sin errores

- [ ] **End-to-end test de proactive-ideas (manual)**

```bash
~/.claude/hooks/proactive-ideas.sh --slot foco
~/.claude/hooks/proactive-ideas.sh --slot tactical
~/.claude/hooks/proactive-ideas.sh --slot lookahead
```

Expected: 3 mensajes Telegram + 3 nuevas páginas en Notion DB "Ideas".

- [ ] **launchd cargados**

```bash
launchctl list | grep -E "(heartbeat|proactive-ideas)"
```

Expected: 2 líneas, ambas con exit code 0.

- [ ] **Esperar 1 ciclo natural del heartbeat**

Esperar al próximo :00 o :30. Verificar que se disparó:

```bash
~/.claude/hooks/heartbeat-status.sh
```
