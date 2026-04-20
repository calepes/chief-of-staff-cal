#!/usr/bin/env bash
# rebuild-learnings-index.sh — regenera index.md scaneando archivos de detalle
set -euo pipefail

LEARNINGS_DIR="$HOME/.claude/learnings/cos"
INDEX="$LEARNINGS_DIR/index.md"
TMP=$(mktemp)

cat > "$TMP" << 'HEAD'
# Index — Learnings CoS

Mapa central de aprendizajes capturados del CoS. Una línea por entry.

Formato: `- YYYY-MM-DD [tipo] [tags] Descripción → archivo.md#anchor [pending]`

Tipos: `correction | pattern | error | decision | idea`

---

<!-- entries: -->
HEAD

# bash 3.2 compat — no associative arrays
file_to_tipo() {
  case "$1" in
    corrections.md) echo "correction" ;;
    patterns.md) echo "pattern" ;;
    errors.md) echo "error" ;;
    decisions.md) echo "decision" ;;
    feature_requests.md) echo "idea" ;;
  esac
}

for file in corrections.md patterns.md errors.md decisions.md feature_requests.md; do
  [[ ! -f "$LEARNINGS_DIR/$file" ]] && continue
  tipo=$(file_to_tipo "$file")

  awk -v file="$file" -v tipo="$tipo" '
    /^## / { anchor = $0; sub(/^## /, "", anchor); in_fm = 0; in_section = 1; id = ""; date = ""; pending = ""; tags = "" }
    in_section && /^<!--$/ { in_fm = 1; next }
    in_section && /^-->$/ {
      in_fm = 0
      if (id != "" && date != "") {
        pending_flag = (pending == "true") ? " [pending]" : ""
        tags_display = (tags != "") ? "[" tags "] " : ""
        printf "- %s [%s] %s%s → %s#%s%s <!-- %s -->\n", date, tipo, tags_display, anchor, file, anchor, pending_flag, id
      }
      in_section = 0
      next
    }
    in_fm && /^id: / { id = $2 }
    in_fm && /^date: / { date = $2 }
    in_fm && /^pending: / { pending = $2 }
    in_fm && /^tags: / { tags = $0; sub(/^tags: \[/, "", tags); sub(/\]$/, "", tags) }
  ' "$LEARNINGS_DIR/$file" >> "$TMP"
done

mv "$TMP" "$INDEX"
echo "✓ index rebuilt: $(grep -c '^- ' "$INDEX") entries"
