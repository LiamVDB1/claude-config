---
description: Explain ralph-controller and available commands
---

# Ralph Controller Help

`ralph-controller` is a deterministic alternative to `ralph-loop`.

## What it changes

Instead of replaying the same prompt every time Claude tries to stop, it expects each controlled turn to end with a strict directive block:
- `STATE`
- `PROGRESS`
- `WAKE_AFTER_SECONDS`
- `NEXT_ACTION`

This enables:
- real `WAIT` / sleep semantics
- explicit `STALL`
- tracked stagnation
- no repeated "still waiting" narration loops

## Commands

### `/ralph-controller`

Use the global command to start a controller-driven loop for a project.

For Truth Engine, the main files are:
- `/.claude/eval/ORCHESTRATOR_PROMPT.md`
- `/.claude/eval/EVAL_STATE.md`
- `/.claude/eval/loop_state.json`

### `/cancel-ralph-controller`

Cancel the active controller run by marking `.claude/ralph-controller.local.md` and the loop state as cancelled.
Once cancelled, the Stop hook will allow the session to exit instead of resuming the controller.

## Stop Hook Lifecycle

When `.claude/ralph-controller.local.md` is active for the current session and the loop state is not terminal or cancelled, the global Stop hook blocks exit and re-enters Claude with a controller bootstrap prompt.
That preserves the old Ralph UX while still driving the improved deterministic controller state machine.

## Runtime

The controller runtime lives at:
- `~/.claude/skills/ralph-controller/controller.py`

It parses the directive block and updates machine state deterministically.
