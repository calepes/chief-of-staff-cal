#!/usr/bin/env bash
# health-check.sh — verifica que el bot de CoS esté haciendo long-poll a Telegram.
# Si no, fuerza el relanzamiento del LaunchAgent com.cal.cos-agent.
#
# Detección end-to-end (no solo "¿existe el proceso?"):
#   Telegram Bot API permite UN solo cliente haciendo getUpdates a la vez.
#   - 409 Conflict = otro cliente está polling = nuestro bot está vivo
#   - 200 OK + result:[] = nadie está polling = bot caído/colgado
#
# Cubre el escenario crítico: plugin MCP colgado silenciosamente mientras
# el proceso claude padre sigue aparentemente vivo.

set -uo pipefail

ENV_FILE="$HOME/.claude/channels/telegram/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S'): .env no existe en $ENV_FILE"
  exit 0
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

TOKEN="${TELEGRAM_BOT_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S'): sin TELEGRAM_BOT_TOKEN en .env"
  exit 0
fi

# check() retorna:
#   0 -> healthy (alguien está polling, probablemente nosotros)
#   1 -> unhealthy (nadie está polling)
#   2 -> desconocido (error de red, Telegram down, etc.) -- no tomar acción
check() {
  local response http_code body
  response=$(curl -s -m 10 -w "\n%{http_code}" \
    "https://api.telegram.org/bot${TOKEN}/getUpdates?offset=-1&timeout=0&limit=1" 2>/dev/null)
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [[ "$http_code" == "409" ]] || echo "$body" | grep -q "Conflict"; then
    return 0
  fi

  if [[ "$http_code" == "200" ]] && echo "$body" | grep -q '"ok":true'; then
    return 1
  fi

  return 2
}

TS=$(date '+%Y-%m-%d %H:%M:%S')

check
result=$?

if [[ $result -eq 1 ]]; then
  sleep 5
  check
  result=$?
fi

case $result in
  0)
    echo "$TS: bot vivo (polling activo)"
    ;;
  1)
    echo "$TS: bot caido -- forzando kickstart del LaunchAgent"
    launchctl kickstart -k "gui/$(id -u)/com.cal.cos-agent"
    echo "$TS: kickstart ejecutado (exit=$?)"
    ;;
  2)
    echo "$TS: no pude verificar (red/Telegram) -- asumo OK"
    ;;
esac
