---
description: Start a deterministic controller-driven autonomous loop using a strict directive block instead of blind prompt replay.
argument-hint: "[--max-iterations N] [--completion-promise TEXT]"
allowed-tools: ["Bash(python3 ~/.claude/skills/ralph-controller-runtime/invoke_setup.py:*)", "Read(.claude/ralph-controller.local.md)", "Read(.claude/eval/ORCHESTRATOR_PROMPT.md)", "Read(.claude/eval/ORCHESTRATOR_CORE.md)", "Read(.claude/eval/PRODUCT_QUALITY.md)", "Read(.claude/eval/EXECUTION_PLAN.md)", "Read(.claude/eval/STAGE_MAP.json)", "Read(.claude/eval/EVAL_STATE.md)", "Read(.claude/eval/EVAL_CRITERIA.md)", "Read(.claude/eval/TEST_FIXTURES.md)", "Read(.claude/eval/loop_state.json)", "Edit(.claude/eval/EVAL_STATE.md)", "Edit(.claude/eval/EXECUTION_PLAN.md)", "Write"]
hide-from-slash-command-tool: "true"
---

# Ralph Controller Command

Start a deterministic controller setup for the current project's standard `.claude/eval/*` files.

Before running setup:
- if the user did not supply `--prompt-file`, `--state-file`, and `--loop-state-file`, assume the standard project-local defaults and pass them explicitly:
  - `--prompt-file .claude/eval/ORCHESTRATOR_PROMPT.md`
  - `--state-file .claude/eval/EVAL_STATE.md`
  - `--loop-state-file .claude/eval/loop_state.json`
- if that standard layout does not exist or the user wants a different layout, ask the user for the missing paths and recommend those three defaults first

Run setup once with the Bash tool using the resolved arguments.

After setup completes, continue in the same assistant turn and execute the first controller turn:
- load the orchestrator prompt for the run
- read the project state files in loader order
- perform one controlled turn
- update `EVAL_STATE.md` and `EXECUTION_PLAN.md` if the turn changes truth or route
- end with a valid directive block in the response
- let controller state drive `WORK`, `WAIT`, `STALL`, `DONE`, or `HALT`

The Stop hook drives the loop. Every turn must end with a valid directive block - that's the only transport.

This command is intentionally scoped to the standard project-local eval layout:
- `.claude/eval/ORCHESTRATOR_PROMPT.md`
- `.claude/eval/EVAL_STATE.md`
- `.claude/eval/loop_state.json`

Optional flags:
- `--max-iterations`
- `--completion-promise`

Critical rule: never replace a real `WAIT` state with prose like "still waiting". The controller relies on the directive block, not narration.

Use `/ralph-controller-help` for the conceptual overview.
Use `/cancel-ralph-controller` to stop the active session.

## Truth Engine Example

```text
/ralph-controller --max-iterations 20 --completion-promise "ALL EVALUATION CRITERIA IN EVAL_STATE.md ARE PASS"
```

The setup script creates `.claude/ralph-controller.local.md` in the current project and initializes the machine-readable loop state file only if it does not exist.

This command is the supported user-facing replacement for `ralph-loop` when you want explicit controller state, real wait semantics, stagnation tracking, and reusable command ergonomics for projects that use the standard `.claude/eval/*` layout.
