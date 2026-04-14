#!/bin/bash

set -euo pipefail

STATE_FILE=".claude/ralph-controller.local.md"
RUNTIME="$HOME/.claude/skills/ralph-controller/controller.py"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "No active ralph-controller session found."
  exit 0
fi

readarray -t STATE_INFO < <(python3 - <<'PY'
from pathlib import Path
import json

state_path = Path('.claude/ralph-controller.local.md')
content = state_path.read_text(encoding='utf-8')
parts = content.split('---\n', 2)
if len(parts) < 3:
    raise SystemExit('Malformed ralph-controller state file')

payload = {}
for line in parts[1].splitlines():
    if not line.strip():
        continue
    if ':' not in line:
        raise SystemExit('Malformed ralph-controller state file')
    key, raw_value = line.split(':', 1)
    raw_value = raw_value.strip()
    if raw_value == 'null':
        value = None
    elif raw_value == 'true':
        value = True
    elif raw_value == 'false':
        value = False
    elif raw_value.startswith('"') and raw_value.endswith('"'):
        value = json.loads(raw_value)
    else:
        try:
            value = int(raw_value)
        except ValueError:
            value = raw_value
    payload[key.strip()] = value

print(payload.get('iteration', 'unknown'))
print(payload.get('loop_state_file', ''))
payload['active'] = False
payload['cancelled'] = True
lines = ['---']
for key, value in payload.items():
    lines.append(f"{key}: {json.dumps(value, ensure_ascii=False)}")
lines.extend([
    '---',
    '',
    'This ralph-controller session has been cancelled.',
])
state_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
PY
)

ITERATION="${STATE_INFO[0]:-unknown}"
LOOP_STATE_FILE="${STATE_INFO[1]:-}"
if [[ -n "$LOOP_STATE_FILE" ]]; then
  python3 "$RUNTIME" --loop-state-file "$LOOP_STATE_FILE" --mark-cancelled --reason "controller cancelled by /cancel-ralph-controller" >/dev/null
fi

cat <<EOF
Cancelled ralph-controller (was at iteration ${ITERATION:-unknown}).
Marked the local controller session and loop state as cancelled so the Stop hook will not resume this run.
EOF
