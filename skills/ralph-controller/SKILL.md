---
name: ralph-controller
description: Replace blind prompt replay loops with a deterministic controller that runs one orchestrator turn at a time, parses a strict directive block, owns WAIT/SLEEP semantics, and tracks stagnation. Use when you want a reusable autonomous controller instead of `ralph-loop`.
---

# Ralph Controller

A reusable controller-oriented successor to `ralph-loop`.

Use this skill when the old Ralph pattern is too dumb for the job: the orchestrator needs real wait/sleep behavior, explicit machine state, and protection against wasting turns on repeated "still waiting" narration.

## What This Skill Does

`ralph-controller` keeps the good parts of Ralph:
- persistent iterative work
- file-based state
- clear completion conditions
- easy startup ergonomics

But it changes the control plane:
- the controller owns turn pacing
- the orchestrator emits a strict directive block every turn
- `WAIT` is a real machine state, not prose
- stagnation is counted explicitly
- malformed or missing directives are treated as non-productive turns

## Controller States

The first-pass state machine is:
- `BOOT`
- `WORK`
- `WAIT`
- `STALL`
- `DONE`
- `HALT`

## Required Artifacts

This skill expects project-specific files to exist:
- orchestrator prompt file
- persistent state file
- controller loop state file

For Truth Engine, the canonical paths are:
- `/home/opc/Truth-Engine/.claude/eval/ORCHESTRATOR_PROMPT.md`
- `/home/opc/Truth-Engine/.claude/eval/EVAL_STATE.md`
- `/home/opc/Truth-Engine/.claude/eval/loop_state.json`

## Directive Contract

Every controlled turn must end with this exact minimal block:

```text
<<<RALPH_CONTROLLER_DIRECTIVE>>>
STATE: WORK
PROGRESS: true
WAKE_AFTER_SECONDS: 0
NEXT_ACTION: dispatch te-evaluator on the completed dossier
<<<END_RALPH_CONTROLLER_DIRECTIVE>>>
```

Field rules:
- `STATE` must be one of the six controller states
- `PROGRESS` must be `true` or `false`
- `WAKE_AFTER_SECONDS` must be `0` unless `STATE=WAIT`
- `NEXT_ACTION` must be one concrete next step, or `none` for terminal states

## Workflow

### 1. Load controller state

Read the machine state file first.

If it does not exist, initialize:
- `controller_state = BOOT`
- `iteration = 0`
- `stagnation_count = 0`

### 2. Load the project prompt and human-readable state

Read the project's orchestrator prompt and state files.

Important:
- load the orchestrator prompt for the run
- do **not** re-read it ceremonially on every turn unless it changed or the controller requires it

### 3. Run exactly one orchestrator turn

The turn should:
- read relevant state
- decide the next move
- dispatch work if needed
- update human-readable state if appropriate
- end with the directive block

### 4. Parse the directive deterministically

Interpret only these fields:
- `STATE`
- `PROGRESS`
- `WAKE_AFTER_SECONDS`
- `NEXT_ACTION`

If the block is missing or malformed:
- count the turn as non-productive
- increment stagnation
- transition toward `STALL`

### 5. Apply controller behavior

- `WORK` → continue immediately
- `WAIT` → sleep for `WAKE_AFTER_SECONDS`, then resume
- `STALL` → record the stall and require a concrete next action
- `DONE` → stop successfully
- `HALT` → stop without claiming success

### 6. Keep the output operational

Do not waste turns with ceremonial restatements like:
- "still waiting"
- "monitor still active"
- "no duplicate work warranted"

If you must wait, say so through the directive block only.

## Truth Engine Example

For Truth Engine, the controller should treat these files as the primary contract:
- `/home/opc/Truth-Engine/.claude/eval/ORCHESTRATOR_PROMPT.md`
- `/home/opc/Truth-Engine/.claude/eval/EVAL_STATE.md`
- `/home/opc/Truth-Engine/.claude/eval/loop_state.json`

The controller runtime may live globally, but machine state belongs in the project.

## Relationship to Ralph Loop

Use the old `ralph-loop` plugin as inspiration for:
- command ergonomics
- help/setup messaging
- file-based state
- stop/halt concepts

Do **not** copy its core defect:
- replaying the same prompt on every stop without understanding whether the orchestrator is in `WORK` or `WAIT`

## Success Criteria

A good `ralph-controller` run should:
- avoid repeated waiting-only turns
- avoid forced full prompt rereads every cycle
- survive long-running async work with explicit `WAIT`
- stop cleanly on `DONE` or `HALT`
- leave behind machine-readable controller state for the next turn
