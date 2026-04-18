#!/bin/bash

set -euo pipefail

LOG="/tmp/ralph-controller-stop-hook.log"
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') HOOK FIRED cwd=$(pwd)" >> "$LOG"

MARKER_FILE=".claude/ralph-controller.local.md"

if [[ ! -f "$MARKER_FILE" ]]; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') NO MARKER at $MARKER_FILE" >> "$LOG"
  exit 0
fi

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') MARKER FOUND" >> "$LOG"

HOOK_INPUT_FILE=$(mktemp)
cat >"$HOOK_INPUT_FILE"

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') HOOK INPUT: $(cat "$HOOK_INPUT_FILE")" >> "$LOG"

CONTROLLER_STDERR_FILE=$(mktemp)
trap 'rm -f "$HOOK_INPUT_FILE" "$CONTROLLER_STDERR_FILE"' EXIT

set +e
python3 "$HOME/.claude/skills/ralph-controller-runtime/controller.py" \
  --stop-hook \
  --marker-file "$MARKER_FILE" \
  --hook-input-file "$HOOK_INPUT_FILE" \
  2>"$CONTROLLER_STDERR_FILE"
status=$?
set -e

cat "$CONTROLLER_STDERR_FILE" >> "$LOG"
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') CONTROLLER EXIT=$status" >> "$LOG"
if [[ $status -ne 0 ]]; then
  cat "$CONTROLLER_STDERR_FILE" >&2
  echo "ralph-controller stop-hook: controller runtime failed with status $status" >&2
elif grep -q "malformed stop-hook payload" "$CONTROLLER_STDERR_FILE"; then
  cat "$CONTROLLER_STDERR_FILE" >&2
fi
# Allow-stop decisions stay quiet in the UI; block JSON still returns on stdout and
# stderr remains available in the debug log for diagnosis.
exit $status
