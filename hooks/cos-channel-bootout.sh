#!/bin/bash
# cos-channel-bootout.sh
# SessionStart hook (CoS): si esta sesión usa `--channels plugin:telegram` con
# el bot default (CoS), descarga el launchd agent `com.cal.cos-agent` para
# evitar conflicto de long-polling. Idempotente.

set -uo pipefail

# Si esto corre dentro del propio cos-agent (lanzado por launchd), no hacer
# bootout — se mataría a sí mismo y KeepAlive lo respawnea en loop.
[[ "${COS_AGENT_BG:-}" == "1" ]] && exit 0

MY_PID=$PPID
my_cmd=$(ps -o command= -p "$MY_PID" 2>/dev/null || true)

# Solo aplicar si la sesión tiene el channel Telegram activo
[[ "$my_cmd" != *"--channels plugin:telegram"* ]] && exit 0

# Si usa un TELEGRAM_STATE_DIR distinto al default, no toca el cos-agent
[[ "$my_cmd" == *"TELEGRAM_STATE_DIR="* ]] && exit 0

# Si cos-agent está cargado, descargar
if launchctl list 2>/dev/null | grep -q "com.cal.cos-agent"; then
    launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.cal.cos-agent.plist" 2>/dev/null || true
    echo "[cos-channel-bootout] cos-agent descargado (sesión interactiva PID $MY_PID activa)" >&2
fi

exit 0
