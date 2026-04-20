#!/bin/bash
# Cron local: reporte nocturno 22:00 — resumen del día + pendientes para mañana
# Ejecutado por launchd diariamente a las 22:00
# Timeout 10 minutos

LOGDIR="$HOME/.claude/hooks/cache"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/nightly-$(date +%Y%m%d).log"

CLAUDE="/Users/calepes/.local/bin/claude"
PROJECT_DIR="/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
TIMEOUT=600
GTIMEOUT="/opt/homebrew/bin/gtimeout"
TELEGRAM_BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN "$HOME/.claude/channels/telegram/.env" | cut -d= -f2)
TELEGRAM_CHAT_ID="94137698"

notify_error() {
  local reason="$1"
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="$TELEGRAM_CHAT_ID" \
    -d text="⚠️ Reporte nocturno falló: ${reason}" \
    > /dev/null 2>&1 || true
}

echo "[$(date)] Iniciando reporte nocturno" >> "$LOG"

$GTIMEOUT $TIMEOUT $CLAUDE -p \
  --dangerously-skip-permissions \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,Skill,mcp__notion__notion-query-database-view,mcp__notion__notion-fetch,mcp__notion__notion-search,mcp__plugin_telegram_telegram__reply" \
  -d "$PROJECT_DIR" \
  "Genera el reporte nocturno para Cal (hora actual ~22:00 America/La_Paz). Formato Telegram (usa emojis, bullets, markdown simple):

1. 📊 **Hoy ($(date '+%a %d %b'))**:
   - Tareas completadas (consulta Notion vista 'Todas activas', filtra por Estado=Listo y Modified=hoy)
   - Eventos realizados (Outlook cache en ~/.claude/hooks/cache/outlook-events.txt + Google Calendar si aplica)

2. 📋 **Pendientes hoy no cerrados**: tareas activas con deadline o fecha = hoy que no quedaron en Listo/Cancelada

3. 🌅 **Mañana**:
   - Tareas con deadline o fecha = mañana
   - Eventos agendados (Outlook + Google)

4. 💡 **Sugerencia**: una recomendación accionable para Cal basada en los pendientes (ej: 'prioriza X mañana temprano porque...')

5. 📚 **Learnings pendientes** (solo si hay):
   - Lee \`~/.claude/learnings/cos/index.md\` y busca líneas con \`[pending]\`
   - Si hay ≥1, agrega una sección que liste hasta las 8 más recientes agrupadas por tipo:
     - A. Correcciones (correction)
     - B. Patterns (pattern)
     - C. Errores (error) — marca con ⚠️ si \`frecuencia: N\` es ≥5 (revisa el archivo .md correspondiente)
     - D. Decisiones (decision)
     - E. Ideas (idea)
   - Formato por entry: \`N. descripción  (id)\`
   - Para cada entry listada, agrega UN par de botones al final del \`buttons\` de \`mcp__plugin_telegram_telegram__reply\`:
     - \`{\"text\":\"N✅\",\"callback_data\":\"learn:keep:<id>\"}\` y \`{\"text\":\"N❌\",\"callback_data\":\"learn:drop:<id>\"}\`
   - Agrega una fila final con \`{\"text\":\"✅ Todo\",\"callback_data\":\"learn:keepall:<batch_id>\"}\` y \`{\"text\":\"❌ Todo\",\"callback_data\":\"learn:dropall:<batch_id>\"}\` donde batch_id es el sha1 de los IDs concatenados cortado a 8 chars
   - Antes de enviar, escribe los IDs del batch a \`~/.claude/state/learn-batches/<batch_id>\` (uno por línea)
   - MAX 4 filas de entries en el keyboard (8 entries total). Si hay más pending, menciona el count total.

Manda el reporte completo a Telegram chat_id 94137698 via mcp__plugin_telegram_telegram__reply. Si no hay nada relevante en alguna sección, dilo honestamente en lugar de llenar con ruido." \
  >> "$LOG" 2>&1

EXIT_CODE=$?

if [ $EXIT_CODE -eq 124 ]; then
  echo "[$(date)] TIMEOUT en reporte nocturno (${TIMEOUT}s)" >> "$LOG"
  notify_error "timeout (${TIMEOUT}s)"
elif [ $EXIT_CODE -ne 0 ]; then
  echo "[$(date)] ERROR en reporte nocturno (exit $EXIT_CODE)" >> "$LOG"
  notify_error "exit code $EXIT_CODE"
fi

echo "[$(date)] Reporte nocturno finalizado (exit $EXIT_CODE)" >> "$LOG"

# Limpiar logs viejos (>7 días)
find "$LOGDIR" -name "nightly-*.log" -mtime +7 -delete 2>/dev/null || true
