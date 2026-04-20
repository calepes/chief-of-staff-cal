#!/usr/bin/env bash
# setup-menu-button.sh — configura el botón de menú del bot de Telegram
# para abrir la Mini App como default (reemplaza la lista de comandos `/`).
#
# Referencia: https://core.telegram.org/bots/api#setchatmenubutton
#
# Menú button types:
#   - commands: muestra lista de comandos registrados (default)
#   - web_app:  abre una Mini App con un tap
#   - default:  commands
#
# Nota: usa el deep link canónico del bot (t.me/<bot>/<short_name>) porque
# el Worker URL directo requiere dominio publicado a BotFather.

set -euo pipefail

ENV_FILE="$HOME/.claude/channels/telegram/.env"
source "$ENV_FILE"

TOKEN="${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN no definido}"
MINIAPP_URL="${1:-https://spotify-miniapp.carlos-cb4.workers.dev}"
BUTTON_TEXT="${2:-🎵 Abrir}"

echo "Configurando botón de menú:"
echo "  Texto: $BUTTON_TEXT"
echo "  URL:   $MINIAPP_URL"

RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${TOKEN}/setChatMenuButton" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg text "$BUTTON_TEXT" --arg url "$MINIAPP_URL" '{
    menu_button: {
      type: "web_app",
      text: $text,
      web_app: { url: $url }
    }
  }')")

echo "$RESPONSE" | jq .

if echo "$RESPONSE" | jq -e '.ok == true' > /dev/null; then
  echo "✅ Menú configurado"
else
  echo "❌ Falló la configuración"
  exit 1
fi
