#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${HOME}/.claude/litellm.env"

print_first_nonempty() {
  for value in "$@"; do
    if [[ -n "$value" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  done
  return 1
}

read_env_var() {
  local key="$1"

  if [[ ! -f "$ENV_FILE" ]]; then
    return 1
  fi

  awk -F= -v key="$key" '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    {
      raw_key = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", raw_key)
      if (raw_key != key) {
        next
      }

      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"/, "", value)
      gsub(/"$/, "", value)
      gsub(/^'\''/, "", value)
      gsub(/'\''$/, "", value)
      print value
      exit
    }
  ' "$ENV_FILE"
}

if print_first_nonempty \
  "${ANTHROPIC_AUTH_TOKEN:-}" \
  "${LITELLM_API_KEY:-}" \
  "${LITELLM_MASTER_KEY:-}"; then
  exit 0
fi

if print_first_nonempty \
  "$(read_env_var ANTHROPIC_AUTH_TOKEN || true)" \
  "$(read_env_var LITELLM_API_KEY || true)" \
  "$(read_env_var LITELLM_MASTER_KEY || true)"; then
  exit 0
fi

cat >&2 <<'EOF'
LiteLLM auth token not found.
Set one of ANTHROPIC_AUTH_TOKEN, LITELLM_API_KEY, or LITELLM_MASTER_KEY
in ~/.claude/litellm.env or your shell environment.
EOF
exit 1
