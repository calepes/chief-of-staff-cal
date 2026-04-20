#!/usr/bin/env bash
# learnings-lib.sh — funciones compartidas para captura/manipulación de entries

LEARNINGS_DIR="${LEARNINGS_DIR:-$HOME/.claude/learnings/cos}"

# tipo_to_filename <tipo> → echo nombre archivo
tipo_to_filename() {
  case "$1" in
    correction) echo "corrections.md" ;;
    decision) echo "decisions.md" ;;
    error) echo "errors.md" ;;
    pattern) echo "patterns.md" ;;
    idea) echo "feature_requests.md" ;;
  esac
}

# generate_id <tipo> → echo "<prefix>-YYYY-MM-DD-NNN"
generate_id() {
  local tipo="$1"
  local prefix
  case "$tipo" in
    correction) prefix="corr" ;;
    decision) prefix="dec" ;;
    error) prefix="err" ;;
    pattern) prefix="pat" ;;
    idea) prefix="idea" ;;
    *) echo "ERROR: tipo invalido: $tipo" >&2; return 1 ;;
  esac
  local date
  date=$(date +%Y-%m-%d)
  local file="$LEARNINGS_DIR/$(tipo_to_filename "$tipo")"
  local last_n
  last_n=$(grep -oE "id: ${prefix}-${date}-[0-9]+" "$file" 2>/dev/null \
    | grep -oE '[0-9]+$' | sort -n | tail -1)
  local n=$((${last_n:-0} + 1))
  printf "${prefix}-${date}-%03d\n" "$n"
}

# slug <texto> → slug ascii lowercase con guiones, máx 40 chars
slug() {
  echo "$1" \
    | iconv -t ascii//TRANSLIT 2>/dev/null \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g' \
    | cut -c1-40
}

# hash_normalize <tipo> <descripcion> → echo sha1
hash_normalize() {
  local tipo="$1"
  local desc
  desc=$(echo "$2" | iconv -t ascii//TRANSLIT 2>/dev/null \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/ /g; s/^ +| +$//g')
  echo -n "${tipo}:${desc}" | shasum -a 1 | awk '{print $1}'
}

# is_duplicate <tipo> <descripcion> → exit 0 si existe entry abierta o aprobada
is_duplicate() {
  local hash
  hash=$(hash_normalize "$1" "$2")
  local file="$LEARNINGS_DIR/$(tipo_to_filename "$1")"
  grep -q "hash: $hash" "$file" 2>/dev/null
}

# append_entry <tipo> <descripcion> <trigger> <contexto> <captured_by> [tags_csv]
# Escribe entry al archivo correspondiente. Devuelve el id.
append_entry() {
  local tipo="$1"
  local desc="$2"
  local trigger="$3"
  local contexto="$4"
  local captured_by="$5"
  local tags="${6:-}"

  local id
  id=$(generate_id "$tipo")
  local anchor
  anchor=$(slug "$desc")
  local hash
  hash=$(hash_normalize "$tipo" "$desc")
  local date
  date=$(date +%Y-%m-%d)
  local file="$LEARNINGS_DIR/$(tipo_to_filename "$tipo")"
  local session
  session=$(basename "${CLAUDE_SESSION_ID:-unknown}" | cut -c1-8)

  # Ensure unique anchor
  local n=2
  local final_anchor="$anchor"
  while grep -q "^## ${final_anchor}$" "$file" 2>/dev/null; do
    final_anchor="${anchor}-${n}"
    n=$((n + 1))
  done

  # Append entry
  cat >> "$file" << ENTRY

## ${final_anchor}
<!--
id: ${id}
date: ${date}
captured_by: ${captured_by}
session: ${session}
pending: true
valid: null
hash: ${hash}
tags: [${tags}]
-->

**Trigger:** ${trigger}

**Contexto:** ${contexto}

**Regla:** ${desc}
ENTRY

  # Update hash list at end of file
  if grep -q "<!-- hashes: -->" "$file"; then
    sed -i '' "s|<!-- hashes: -->|<!-- hashes: -->\\
<!-- $hash -->|" "$file"
  fi

  # Update index
  update_index "$id" "$tipo" "$tags" "$desc" "$(tipo_to_filename "$tipo")" "$final_anchor"

  echo "$id"
}

# update_index <id> <tipo> <tags> <desc> <filename> <anchor>
update_index() {
  local id="$1"
  local tipo="$2"
  local tags="$3"
  local desc="$4"
  local filename="$5"
  local anchor="$6"
  local date
  date=$(date +%Y-%m-%d)
  local index="$LEARNINGS_DIR/index.md"

  # Truncate description to 80 chars
  local short_desc
  short_desc=$(echo "$desc" | cut -c1-80)
  local tags_display=""
  [[ -n "$tags" ]] && tags_display="[${tags}] "

  local line="- ${date} [${tipo}] ${tags_display}${short_desc} → ${filename}#${anchor} [pending] <!-- ${id} -->"

  # Append after "<!-- entries: -->" marker
  if grep -q "<!-- entries: -->" "$index"; then
    sed -i '' "s|<!-- entries: -->|<!-- entries: -->\\
${line}|" "$index"
  else
    echo "$line" >> "$index"
  fi
}

# find_entry_in_index <id> → echo línea completa, exit 1 si no existe
find_entry_in_index() {
  grep "<!-- $1 -->" "$LEARNINGS_DIR/index.md"
}

# flip_pending <id> <valid_value>  (true=keep, false=drop)
flip_pending() {
  local id="$1"
  local valid="$2"
  local line
  line=$(find_entry_in_index "$id") || return 1

  # Extract filename from line: `→ filename.md#anchor [pending]`
  local filename
  filename=$(echo "$line" | grep -oE '→ [^#]+\.md' | sed 's|→ ||;s| ||g')
  local file="$LEARNINGS_DIR/$filename"
  local anchor
  anchor=$(echo "$line" | grep -oE '#[^ ]+' | tr -d '#')

  # Update entry frontmatter: pending: true → false, valid: null → ${valid}
  awk -v anchor="$anchor" -v valid="$valid" '
    /^## /{ in_target = ($0 == "## " anchor) }
    in_target && /^pending: true$/ { print "pending: false"; next }
    in_target && /^valid: null$/ { print "valid: " valid; next }
    { print }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"

  # Remove [pending] from index line
  sed -i '' "s| \[pending\] \(<!-- $id -->\)| \1|" "$LEARNINGS_DIR/index.md"
}

# move_to_archive <id>
move_to_archive() {
  local id="$1"
  local line
  line=$(find_entry_in_index "$id") || return 1

  local filename
  filename=$(echo "$line" | grep -oE '→ [^#]+\.md' | sed 's|→ ||;s| ||g')
  local file="$LEARNINGS_DIR/$filename"
  local anchor
  anchor=$(echo "$line" | grep -oE '#[^ ]+' | tr -d '#')
  local month
  month=$(date +%Y-%m)
  local archive="$LEARNINGS_DIR/archive/${month}.md"

  # Init archive file if missing
  if [[ ! -f "$archive" ]]; then
    cat > "$archive" << ARC
# Rechazadas — ${month}

Entries que Cal descartó en review. NO se borran (pueden recuperarse o servir como señal anti-recapture).

---
ARC
  fi

  # Extract entry block from source file (## anchor + frontmatter + body until next ## or EOF)
  awk -v anchor="$anchor" '
    /^## / { in_target = ($0 == "## " anchor); if (in_target) { found = 1 } else if (found) { exit } }
    in_target { print }
  ' "$file" > /tmp/learning_block.md

  # Add rejected_at marker to the block, append to archive
  local today
  today=$(date +%Y-%m-%d)
  sed "s|^pending: true\$|pending: false|; s|^valid: null\$|valid: false\\
rejected_at: ${today}|" /tmp/learning_block.md >> "$archive"

  # Remove entry from source file
  awk -v anchor="$anchor" '
    /^## / { in_target = ($0 == "## " anchor); if (in_target) { skip = 1; next } else if (skip) { skip = 0 } }
    !skip { print }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"

  # Remove from index
  sed -i '' "/<!-- $id -->/d" "$LEARNINGS_DIR/index.md"
}
