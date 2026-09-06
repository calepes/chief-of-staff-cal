#!/bin/bash
# scripts/research-competencia-run-detached.sh — wrapper para corridas ON DEMAND del research de
# competencia desde una sesión interactiva de Claude Code.
#
# Encontrado en vivo el 2026-09-06: lanzar la corrida vía el Bash tool en background
# (`run_in_background`) la deja atada al ciclo de vida de la sesión/terminal — 3 corridas seguidas
# murieron con "[killed]" (una de ellas con `caffeinate -i` ya corriendo, que no alcanzó), mientras
# que la MISMA corrida lanzada con `nohup ... & disown` (reparentada a `init`, PPID=1, confirmado
# con `ps`) completó los 58 minutos sin problema. Causa exacta no confirmada al 100% (candidatos:
# App Nap de macOS sobre la terminal en segundo plano, o el manejo de tareas de background del
# propio harness) — el fix real es desacoplar el proceso de la sesión, no `caffeinate` (que solo
# cubre sleep por inactividad, no el mecanismo que efectivamente lo estaba matando).
#
# Uso (nunca lo corras en foreground desde el Bash tool — perdés el mismo problema):
#   nohup scripts/research-competencia-run-detached.sh [--timeframe=N] [--entidades=a,b,c] \
#     > /dev/null 2>&1 &
#   disown
#
# Avisa por Telegram (@ClaudeCalbot) al terminar, éxito o error — el aviso lo manda ESTE script,
# no la sesión de Claude que lo lanzó, para que llegue aunque esa sesión se corte mientras tanto.
#
# El cron semanal (launchd, com.cal.jano-research-competencia.plist) NO usa este wrapper — launchd
# ya corre el proceso desacoplado de cualquier terminal, el problema de arriba es específico de
# lanzarlo desde una sesión interactiva.
set -uo pipefail
cd "$(dirname "$0")/.."

LOG="/tmp/research-competencia-run.log"
: > "$LOG"

caffeinate -i env -u NODE_OPTIONS npm run research:now -- "$@" >> "$LOG" 2>&1
CODE=$?

source "$HOME/.claude/notifications/.env"

if [ "$CODE" -eq 0 ]; then
  RESUMEN=$(grep -A 30 "Research de competencia" "$LOG" | tail -30)
  TEXT="✅ Research de competencia terminó OK.

$RESUMEN"
else
  TEXT="⚠️ Research de competencia terminó con error (exit $CODE).

$(tail -15 "$LOG")"
fi

curl -s -X POST "https://api.telegram.org/bot${NOTIF_BOT_TOKEN}/sendMessage" \
  --data-urlencode "text=$TEXT" -d chat_id=94137698 >/dev/null 2>&1
