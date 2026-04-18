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
- `.claude/eval/ORCHESTRATOR_PROMPT.md`
- `.claude/eval/EVAL_STATE.md`
- `.claude/eval/loop_state.json`

### `/cancel-ralph-controller`

Cancel the active controller run by marking `.claude/ralph-controller.local.md` and the loop state as cancelled.
Once cancelled, future stop-hook checks should leave the run stopped.

The Stop hook blocks session exit and feeds a resume prompt back to the orchestrator, just like the old `ralph-loop` plugin. The difference: every turn must end with a directive block that drives `WORK` / `WAIT` / `STALL` / `DONE` / `HALT`.

## Runtime

The controller runtime lives at:
- `~/.claude/skills/ralph-controller-runtime/controller.py`

It parses the directive block and updates machine state deterministically.
