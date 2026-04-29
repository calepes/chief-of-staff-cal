#!/usr/bin/env bash
# health-check.sh — verifica que el bot de CoS esté haciendo long-poll a Telegram.
# Si no, fuerza el relanzamiento del LaunchAgent com.cal.cos-agent.
#
# Detección end-to-end (no solo "¿existe el proceso?"):
#   Telegram Bot API permite UN solo cliente haciendo getUpdates a la vez.
#   - 409 Conflict = otro cliente está polling = bot vivo
#   - 200 OK + result:[] = nadie está polling = bot caído/colgado
#
# v2 (2026-04-28): Threshold 3 fallos consecutivos + recovery limpio
# (`unload → pkill bun zombies → sleep 60 → load`) en vez de `kickstart -k`,
# que dejaba zombies de bun y corrompía el plugin.

set -uo pipefail

ENV_FILE="$HOME/.claude/channels/telegram/.env"
STATE_FILE="$HOME/.claude/state/cos-health-failures"
LABEL="com.cal.cos-agent"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
THRESHOLD=3
RECOVERY_SLEEP=60

mkdir -p "$(dirname "$STATE_FILE")"

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

# Si hay una sesión interactiva del usuario con el channel CoS activo, NO actuar:
# es esperado que el daemon esté descargado (hooks SessionStart hicieron bootout).
# Detección: proceso `claude --channels` SIN COS_AGENT_BG=1 (daemon) y SIN
# TELEGRAM_STATE_DIR (Family/otro). ps eww muestra env vars en macOS.
for pid in $(pgrep -f "claude.*--channels plugin:telegram" 2>/dev/null); do
  full_env=$(ps eww -o command= -p "$pid" 2>/dev/null)
  # Wrappers `/usr/bin/script -q /dev/null ...` no exponen env vars en ps eww;
  # solo aparecen sus argumentos. Skip si no hay env legible (el child sí estará).
  [[ "$full_env" != *"="* ]] && continue
  envs=$(echo "$full_env" | tr ' ' '\n' | grep -E "^(COS_AGENT_BG|FAMILY_AGENT_BG|TELEGRAM_STATE_DIR)=")
  [[ "$envs" == *"COS_AGENT_BG=1"* ]] && continue
  [[ "$envs" == *"FAMILY_AGENT_BG=1"* ]] && continue
  [[ "$envs" == *"TELEGRAM_STATE_DIR="* ]] && continue
  echo "$(date '+%Y-%m-%d %H:%M:%S'): sesión interactiva CoS activa (PID $pid) — skip health-check"
  : > "$STATE_FILE"
  exit 0
done

# check() retorna:
#   0 -> healthy (alguien está polling, probablemente nosotros)
#   1 -> unhealthy (nadie está polling)
#   2 -> desconocido (error de red, Telegram down, etc.)
check() {
  local response http_code body
  response=$(curl -s -m 10 -w "\n%{http_code}" \
    "https://api.telegram.org/bot${TOKEN}/getUpdates?offset=-1&timeout=3&limit=1" 2>/dev/null)
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

read_count() {
  [[ -f "$STATE_FILE" ]] && cat "$STATE_FILE" 2>/dev/null || echo 0
}

write_count() {
  echo "$1" > "$STATE_FILE"
}

clean_recovery() {
  # Recovery limpio sin kickstart -k (deja zombies). Patrón: unload → kill bun
  # huérfanos → sleep 60s para que Telegram libere el slot del long-poll
  # zombie → load.
  echo "$(date '+%Y-%m-%d %H:%M:%S'): RECOVERY: unload + cleanup bun zombies + sleep ${RECOVERY_SLEEP}s + load"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  # Matar bun zombies del CoS (sin TELEGRAM_STATE_DIR custom)
  for pid in $(pgrep -f "bun server.ts" 2>/dev/null); do
    parent_cmd=$(ps -o command= -p "$(ps -o ppid= -p "$pid" | tr -d ' ')" 2>/dev/null || true)
    [[ "$parent_cmd" == *"TELEGRAM_STATE_DIR="* ]] && continue  # skip Family
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep "$RECOVERY_SLEEP"
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  echo "$(date '+%Y-%m-%d %H:%M:%S'): RECOVERY done (exit=$?)"
}

TS=$(date '+%Y-%m-%d %H:%M:%S')

check
result=$?

case $result in
  0)
    echo "$TS: bot vivo (polling activo)"
    : > "$STATE_FILE"  # reset
    ;;
  1)
    fails=$(($(read_count) + 1))
    write_count "$fails"
    echo "$TS: bot sin polling activo — fail $fails/$THRESHOLD"
    if [[ "$fails" -ge "$THRESHOLD" ]]; then
      clean_recovery
      : > "$STATE_FILE"  # reset post-recovery
    fi
    ;;
  2)
    echo "$TS: no pude verificar (red/Telegram) — no actúo, no incremento"
    ;;
esac

exit 0
