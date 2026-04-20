#!/bin/bash
# cos-channel-bootstrap.sh
# SessionEnd hook (CoS): si esta sesión usaba `--channels plugin:telegram` y
# no queda ninguna otra sesión interactiva del CoS viva, recarga el launchd
# agent `com.cal.cos-agent` para que retome la escucha en background.

set -uo pipefail

# Si corre dentro del propio cos-agent, no tocar launchd.
[[ "${COS_AGENT_BG:-}" == "1" ]] && exit 0

MY_PID=$PPID
my_cmd=$(ps -o command= -p "$MY_PID" 2>/dev/null || true)

# Solo aplicar si esta sesión tenía el channel activo
[[ "$my_cmd" != *"--channels plugin:telegram"* ]] && exit 0
[[ "$my_cmd" == *"TELEGRAM_STATE_DIR="* ]] && exit 0

# Contar otras sesiones vivas con el mismo bot (default, sin state dir custom)
remaining=0
for pid in $(pgrep -f "claude.*--channels plugin:telegram" 2>/dev/null); do
    [[ "$pid" == "$MY_PID" ]] && continue
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [[ -z "$cmd" ]] && continue
    [[ "$cmd" == *"TELEGRAM_STATE_DIR="* ]] && continue
    remaining=$((remaining + 1))
done

if [ "$remaining" -eq 0 ]; then
    if ! launchctl list 2>/dev/null | grep -q "com.cal.cos-agent"; then
        launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.cal.cos-agent.plist" 2>/dev/null || true
        echo "[cos-channel-bootstrap] cos-agent recargado (no quedan sesiones interactivas)" >&2
    fi
else
    echo "[cos-channel-bootstrap] quedan $remaining sesiones interactivas — no recargo" >&2
fi

exit 0
