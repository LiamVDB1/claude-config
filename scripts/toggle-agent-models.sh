#!/usr/bin/env bash
# Toggle subagent models between native Claude and LiteLLM/GPT backends.
#
# Scans ALL .md files in each agents/ dir and swaps any whose frontmatter
# `model:` line matches one of the toggled values. No hardcoded agent list.
#
# Usage:
#   toggle-agent-models.sh                        # toggles ~/.claude/agents only
#   toggle-agent-models.sh /path/to/proj/.claude  # also toggles that dir's agents
#   toggle-agent-models.sh /a/.claude /b/.claude  # multiple extra targets
#
# Sonnet-tier:  native/sonnet  <-->  litellm/gpt-5.5
# Haiku-tier:   native/haiku   <-->  litellm/gpt-5.4-mini
# (All other model values are left untouched.)

set -euo pipefail

GLOBAL_CLAUDE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# --- Detect current mode from global config ---
# Find the first agent in ~/.claude/agents that uses one of the toggled models
PROBE=""
while IFS= read -r -d '' f; do
  model=$(grep -m1 '^model: ' "$f" 2>/dev/null | sed 's/^model: //' || true)
  case "$model" in
    native/sonnet|native/haiku|litellm/gpt-5.5|litellm/gpt-5.4-mini)
      PROBE="$f"
      PROBE_MODEL="$model"
      break
      ;;
  esac
done < <(find "$GLOBAL_CLAUDE_DIR/agents" -maxdepth 1 -name '*.md' -print0 2>/dev/null | sort -z)

if [[ -z "$PROBE" ]]; then
  echo "ERROR: no togglable agent found in $GLOBAL_CLAUDE_DIR/agents" >&2
  exit 1
fi

if [[ "$PROBE_MODEL" == native/* ]]; then
  CURRENT="native"
else
  CURRENT="litellm"
fi

if [[ "$CURRENT" == "native" ]]; then
  TARGET="litellm"
  SONNET_FROM="native/sonnet";      SONNET_TO="litellm/gpt-5.5"
  HAIKU_FROM="native/haiku";        HAIKU_TO="litellm/gpt-5.4-mini"
else
  TARGET="native"
  SONNET_FROM="litellm/gpt-5.5";       SONNET_TO="native/sonnet"
  HAIKU_FROM="litellm/gpt-5.4-mini";   HAIKU_TO="native/haiku"
fi

echo "Switching from [$CURRENT] → [$TARGET]"
echo "  sonnet-tier: $SONNET_FROM  →  $SONNET_TO"
echo "  haiku-tier:  $HAIKU_FROM  →  $HAIKU_TO"
echo ""

# Swap model in a single file (frontmatter + $%$model: body tag).
# The body tag may use either the full "litellm/gpt-5.5" or bare "gpt-5.5" form.
swap_file() {
  local file="$1"
  local from="$2"
  local to="$3"

  # Frontmatter model: line
  sed -i "s|^model: ${from}$|model: ${to}|" "$file"

  # Body tag — full form
  sed -i "s|\\\$%\\\$model: ${from}\\\$%\\\$|\$%\$model: ${to}\$%\$|g" "$file"

  # Body tag — bare form (strip litellm/ prefix), only when it differs
  local bare_from="${from#litellm/}"
  local bare_to="${to#litellm/}"
  if [[ "$bare_from" != "$from" ]]; then
    sed -i "s|\\\$%\\\$model: ${bare_from}\\\$%\\\$|\$%\$model: ${bare_to}\$%\$|g" "$file"
  fi

  echo "  updated: $(basename "$file")"
}

# Process all agents in a given agents/ dir — swap any that match the from-models
process_agents_dir() {
  local agents_dir="$1"
  local label="$2"

  if [[ ! -d "$agents_dir" ]]; then
    echo "[$label] SKIP — agents/ dir not found"
    return
  fi

  echo "[$label]"
  local changed=0
  while IFS= read -r -d '' file; do
    local model
    model=$(grep -m1 '^model: ' "$file" 2>/dev/null | sed 's/^model: //' || true)
    case "$model" in
      "$SONNET_FROM")
        swap_file "$file" "$SONNET_FROM" "$SONNET_TO"
        (( changed++ )) || true
        ;;
      "$HAIKU_FROM")
        swap_file "$file" "$HAIKU_FROM" "$HAIKU_TO"
        (( changed++ )) || true
        ;;
    esac
  done < <(find "$agents_dir" -maxdepth 1 -name '*.md' -print0 | sort -z)

  (( changed == 0 )) && echo "  (no matching agents)" || true
}

# --- Collect .claude dirs: global first, then any extra args (deduped) ---
declare -A SEEN
DIRS=("$GLOBAL_CLAUDE_DIR")
SEEN["$(realpath "$GLOBAL_CLAUDE_DIR")"]=1

for arg in "$@"; do
  if [[ ! -d "$arg" ]]; then
    echo "WARNING: skipping '$arg' — not a directory" >&2
    continue
  fi
  canonical="$(realpath "$arg" 2>/dev/null || echo "$arg")"
  if [[ -n "${SEEN[$canonical]+_}" ]]; then
    continue
  fi
  SEEN["$canonical"]=1
  DIRS+=("$arg")
done

# --- Process ---
for dir in "${DIRS[@]}"; do
  label="$(basename "$(dirname "$dir")")/$(basename "$dir")"
  process_agents_dir "$dir/agents" "$label"
done

echo ""
echo "Done. Active backend: $TARGET"
