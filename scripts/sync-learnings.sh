#!/usr/bin/env bash
# sync-learnings.sh — copia ~/.claude/learnings/cos/ → repo docs/learnings/, commit, push
set -euo pipefail

REPO="$HOME/AI Projects/Personal/Agents/Jano"
SOURCE="$HOME/.claude/learnings/cos"
DEST="$REPO/docs/learnings"
ENV_FILE="$HOME/.claude/channels/telegram/.env"

[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

cd "$REPO"

# Verificar working tree limpio en docs/learnings/ (si existe)
if [[ -d "docs/learnings" ]] && ! git diff --quiet docs/learnings/ 2>/dev/null; then
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID:-94137698}" \
    --data-urlencode "text=⚠️ sync-learnings: docs/learnings/ tiene cambios sin commit. Resolver manual." > /dev/null
  exit 1
fi

mkdir -p "$DEST"
rsync -a --delete "$SOURCE/" "$DEST/"

if git diff --quiet docs/learnings/ 2>/dev/null && git diff --cached --quiet docs/learnings/ 2>/dev/null; then
  echo "no changes to sync"
  exit 0
fi

WEEK=$(date +%Y-W%V)
git add docs/learnings/
git commit -m "chore(learnings): sync $WEEK"
git push

# Notify
COUNT=$(grep -c '^- ' "$DEST/index.md" 2>/dev/null || echo 0)
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID:-94137698}" \
  --data-urlencode "text=📚 Learnings sync $WEEK: $COUNT entries totales" > /dev/null
