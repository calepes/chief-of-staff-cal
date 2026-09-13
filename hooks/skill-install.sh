#!/usr/bin/env bash
# skill-install.sh <proposal_id>
# Instala mecánicamente un skill aprobado: escribe commands/<name>.md,
# copia a ~/.claude/commands/, commit + push, notifica Telegram.
set -u

PROPOSAL_ID="${1:?Uso: skill-install.sh <proposal_id>}"

source "$HOME/.claude/channels/telegram/.env"

REPO="$HOME/AI Projects/Personal/Agents/Jano"
PROPOSALS_DIR="$HOME/.claude/skill-proposals"
INSTALLED_DIR="$HOME/.claude/skill-proposals/installed"
FAILED_DIR="$HOME/.claude/skill-proposals/failed"
LOG="$HOME/.claude/logs/skill-detector.log"

mkdir -p "$INSTALLED_DIR" "$FAILED_DIR"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [install $PROPOSAL_ID] $*" >> "$LOG"; }

notify() {
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID:-94137698}" \
    --data-urlencode "text=$1" > /dev/null
}

PROPOSAL_FILE="$PROPOSALS_DIR/$PROPOSAL_ID.json"
if [[ ! -f "$PROPOSAL_FILE" ]]; then
  log "proposal not found"
  notify "❌ Skill install: propuesta $PROPOSAL_ID no encontrada"
  exit 1
fi

NAME=$(jq -r '.name' "$PROPOSAL_FILE")
TITULO=$(jq -r '.titulo' "$PROPOSAL_FILE")
BODY=$(jq -r '.skill_body' "$PROPOSAL_FILE")

# Validación
if ! echo "$NAME" | grep -qE '^[a-z][a-z0-9-]+$'; then
  log "invalid name: $NAME"
  mv "$PROPOSAL_FILE" "$FAILED_DIR/$PROPOSAL_ID.json"
  notify "❌ Skill install falló: nombre inválido '$NAME'"
  exit 1
fi

TARGET_HOME="$HOME/.claude/commands/$NAME.md"
TARGET_REPO="$REPO/commands/$NAME.md"

if [[ -f "$TARGET_HOME" ]]; then
  log "$NAME ya existe en ~/.claude/commands/"
  mv "$PROPOSAL_FILE" "$FAILED_DIR/$PROPOSAL_ID.json"
  notify "⚠️ Skill /$NAME ya existe. No se sobreescribió."
  exit 1
fi

log "installing $NAME"

# Escribir archivos
printf '%s\n' "$BODY" > "$TARGET_HOME"
printf '%s\n' "$BODY" > "$TARGET_REPO"
chmod 644 "$TARGET_HOME" "$TARGET_REPO"

# Git commit + push
cd "$REPO"
git add "commands/$NAME.md"
if ! git commit -m "feat(skills): auto-install /$NAME desde skill-detector

$TITULO

Auto-generado por skill-detector (propuesta $PROPOSAL_ID).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"; then
  log "git commit failed"
  # Rollback: remove file
  rm -f "$TARGET_HOME" "$TARGET_REPO"
  mv "$PROPOSAL_FILE" "$FAILED_DIR/$PROPOSAL_ID.json"
  notify "❌ Skill /$NAME: git commit falló, archivos revertidos"
  exit 1
fi

COMMIT=$(git rev-parse --short HEAD)

if ! git push 2>>"$LOG"; then
  log "git push failed"
  notify "⚠️ Skill /$NAME instalado + commit ($COMMIT), pero push falló. Pushear manual."
  mv "$PROPOSAL_FILE" "$INSTALLED_DIR/$PROPOSAL_ID.json"
  exit 0
fi

# Archive proposal
mv "$PROPOSAL_FILE" "$INSTALLED_DIR/$PROPOSAL_ID.json"

log "installed /$NAME, commit $COMMIT"
notify "✅ Skill /$NAME instalado

📌 $TITULO
📝 Commit: $COMMIT
🚀 Ya disponible en próxima sesión de Claude Code"
