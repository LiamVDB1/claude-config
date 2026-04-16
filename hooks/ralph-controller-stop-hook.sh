#!/bin/bash

set -euo pipefail

LOG="/tmp/ralph-controller-stop-hook.log"
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') HOOK FIRED cwd=$(pwd)" >> "$LOG"

MARKER_FILE=".claude/ralph-controller.local.md"

if [[ ! -f "$MARKER_FILE" ]]; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') NO MARKER at $MARKER_FILE" >> "$LOG"
  echo "ralph-controller stop-hook: no marker" >&2
  exit 0
fi

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') MARKER FOUND" >> "$LOG"

HOOK_INPUT_FILE=$(mktemp)
cat >"$HOOK_INPUT_FILE"

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') HOOK INPUT: $(cat "$HOOK_INPUT_FILE")" >> "$LOG"

CONTROLLER_STDERR_FILE=$(mktemp)
trap 'rm -f "$HOOK_INPUT_FILE" "$CONTROLLER_STDERR_FILE"' EXIT

set +e
python3 "$HOME/.claude/skills/ralph-controller/controller.py" \
  --stop-hook \
  --marker-file "$MARKER_FILE" \
  --hook-input-file "$HOOK_INPUT_FILE" \
  2>"$CONTROLLER_STDERR_FILE"
status=$?
set -e

cat "$CONTROLLER_STDERR_FILE" >&2
cat "$CONTROLLER_STDERR_FILE" >> "$LOG"
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') CONTROLLER EXIT=$status" >> "$LOG"
if [[ $status -ne 0 ]]; then
  echo "ralph-controller stop-hook: controller runtime failed with status $status" >&2
fi
# Keep explicit status handling outside `set -e` so hook tests can observe
# controller stderr and zero/non-zero results deterministically.
exit $status
