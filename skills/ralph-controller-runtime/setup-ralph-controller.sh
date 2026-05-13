#!/bin/bash

set -euo pipefail

PROMPT_FILE=""
STATE_FILE=""
LOOP_STATE_FILE=""
MAX_ITERATIONS=0
COMPLETION_PROMISE="null"
SESSION_ID=""

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
  --session-id <id>            Bind the marker to an explicit session id
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
    --session-id)
      SESSION_ID="$2"
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
SESSION_ID="$SESSION_ID" \
python3 - <<'PY'
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

prompt_file = os.environ["PROMPT_FILE"]
state_file = os.environ["STATE_FILE"]
loop_state_file = os.environ["LOOP_STATE_FILE"]
max_iterations = int(os.environ["MAX_ITERATIONS"])
completion_promise = os.environ["COMPLETION_PROMISE"]
explicit_session_id = os.environ.get("SESSION_ID", "").strip()
session_id = explicit_session_id or os.environ.get("CLAUDE_SESSION_ID", "").strip() or os.environ.get("CLAUDE_CODE_SESSION_ID", "").strip()
project_root = str(Path.cwd())

started_at_value = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
existing_loop_state_path = Path(loop_state_file)
if existing_loop_state_path.exists():
    existing_loop_state = json.loads(existing_loop_state_path.read_text(encoding="utf-8"))
else:
    existing_loop_state = {}
loop_iteration = int(existing_loop_state.get("iteration", 0) or 0)

# Preserve any existing marker's opt-in extension keys (overseer_*) so that
# project-level configuration (overseer_enabled, paths, byte caps, etc.) is
# not silently dropped on every /ralph-controller restart. Only extension
# keys are carried over — core marker fields (iteration, session_id,
# max_iterations, ...) are always regenerated from this invocation's flags.
preserved_extensions = {}
existing_marker_path = Path(".claude/ralph-controller.local.md")
if existing_marker_path.exists():
    marker_text = existing_marker_path.read_text(encoding="utf-8")
    if marker_text.startswith("---\n"):
        _, _, rest = marker_text.partition("---\n")
        fm_block, _, _ = rest.partition("\n---")
        for raw_line in fm_block.splitlines():
            if ":" not in raw_line:
                continue
            key, _, raw_value = raw_line.partition(":")
            key = key.strip()
            if not key.startswith("overseer_"):
                continue
            value_str = raw_value.strip()
            if not value_str:
                continue
            try:
                preserved_extensions[key] = json.loads(value_str)
            except json.JSONDecodeError:
                preserved_extensions[key] = value_str

frontmatter = {
    "active": True,
    "controller": "ralph-controller",
    "iteration": 0,
    "session_id": session_id,
    "loop_iteration_base": loop_iteration,
    "max_iterations": max_iterations,
    "completion_promise": None if completion_promise == "null" else completion_promise,
    "prompt_file": prompt_file,
    "state_file": state_file,
    "loop_state_file": loop_state_file,
    "project_root": project_root,
    "cancelled": False,
    "started_at": started_at_value,
    **preserved_extensions,
}

frontmatter_lines = ["---"]
for key, value in frontmatter.items():
    rendered = json.dumps(value, ensure_ascii=False)
    frontmatter_lines.append(f"{key}: {rendered}")
frontmatter_lines.append("---")
frontmatter_lines.append("")
frontmatter_lines.append("Use the global /ralph-controller command with these files:")
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

path = Path(loop_state_file)
path.parent.mkdir(parents=True, exist_ok=True)
if not path.exists():
    path.write_text(json.dumps({
        "version": 1,
        "controller_state": "BOOT",
        "iteration": loop_iteration,
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
Project root: $(pwd)

The controller state file is now ready. Use the global /ralph-controller command semantics for each controlled turn.
EOF
