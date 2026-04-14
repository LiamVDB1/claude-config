#!/bin/bash

set -euo pipefail

PROMPT_FILE=""
STATE_FILE=""
LOOP_STATE_FILE=""
MAX_ITERATIONS=0
COMPLETION_PROMISE="null"

usage() {
  cat <<'EOF'
Ralph Controller - Deterministic controller-driven autonomous loop

USAGE:
  /ralph-controller --prompt-file <path> --state-file <path> --loop-state-file <path> [OPTIONS]

OPTIONS:
  --prompt-file <path>         Orchestrator prompt file
  --state-file <path>          Human-readable project state file
  --loop-state-file <path>     Machine-readable controller state file
  --max-iterations <n>         Maximum controller turns before auto-stop (default: unlimited)
  --completion-promise <text>  Completion phrase (quoted if multi-word)
  -h, --help                   Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt-file)
      PROMPT_FILE="$2"
      shift 2
      ;;
    --state-file)
      STATE_FILE="$2"
      shift 2
      ;;
    --loop-state-file)
      LOOP_STATE_FILE="$2"
      shift 2
      ;;
    --max-iterations)
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    --completion-promise)
      COMPLETION_PROMISE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PROMPT_FILE" || -z "$STATE_FILE" || -z "$LOOP_STATE_FILE" ]]; then
  echo "Missing required arguments." >&2
  usage >&2
  exit 1
fi

mkdir -p .claude

PROMPT_FILE="$PROMPT_FILE" \
STATE_FILE="$STATE_FILE" \
LOOP_STATE_FILE="$LOOP_STATE_FILE" \
MAX_ITERATIONS="$MAX_ITERATIONS" \
COMPLETION_PROMISE="$COMPLETION_PROMISE" \
python3 - <<'PY'
from __future__ import annotations

import json
import os
from pathlib import Path
from datetime import datetime, timezone

prompt_file = os.environ["PROMPT_FILE"]
state_file = os.environ["STATE_FILE"]
loop_state_file = os.environ["LOOP_STATE_FILE"]
max_iterations = int(os.environ["MAX_ITERATIONS"])
completion_promise = os.environ["COMPLETION_PROMISE"]

started_at_value = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

frontmatter = {
    "active": True,
    "controller": "ralph-controller",
    "iteration": 0,
    "max_iterations": max_iterations,
    "completion_promise": None if completion_promise == "null" else completion_promise,
    "prompt_file": prompt_file,
    "state_file": state_file,
    "loop_state_file": loop_state_file,
    "cancelled": False,
    "started_at": started_at_value,
}

frontmatter_lines = ["---"]
for key, value in frontmatter.items():
    rendered = json.dumps(value, ensure_ascii=False)
    frontmatter_lines.append(f"{key}: {rendered}")
frontmatter_lines.append("---")
frontmatter_lines.append("")
frontmatter_lines.append("Use the global ralph-controller skill with these files:")
frontmatter_lines.append(f"- prompt file: {prompt_file}")
frontmatter_lines.append(f"- state file: {state_file}")
frontmatter_lines.append(f"- loop state file: {loop_state_file}")
frontmatter_lines.append("")
frontmatter_lines.append(
    "Read the prompt file once for the run, operate one controlled turn, and end with a valid ralph-controller directive block."
)
Path(".claude/ralph-controller.local.md").write_text(
    "\n".join(frontmatter_lines) + "\n",
    encoding="utf-8",
)

# Always reset loop state on setup — stale state from previous runs
# or test suites can leave the controller in WAIT/terminal states.
path = Path(loop_state_file)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps({
    "version": 1,
    "controller_state": "BOOT",
    "iteration": 0,
    "stagnation_count": 0,
    "last_directive": None,
    "wake_after_seconds": 0,
    "wake_at": None,
    "terminal_reason": None,
    "cancelled": False,
}, indent=2) + "\n", encoding="utf-8")
PY

cat <<EOF
🔄 Ralph Controller activated in this session!

Prompt file: $PROMPT_FILE
State file: $STATE_FILE
Loop state file: $LOOP_STATE_FILE
Max iterations: $(if [[ $MAX_ITERATIONS -gt 0 ]]; then echo $MAX_ITERATIONS; else echo "unlimited"; fi)
Completion promise: $(if [[ "$COMPLETION_PROMISE" != "null" ]]; then echo "$COMPLETION_PROMISE"; else echo "none"; fi)

The controller state file is now ready. Use the global ralph-controller skill semantics for each controlled turn.
EOF
