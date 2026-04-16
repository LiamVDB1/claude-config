---
description: Start a deterministic controller-driven autonomous loop using a strict directive block instead of blind prompt replay.
argument-hint: "--prompt-file PATH --state-file PATH --loop-state-file PATH [--max-iterations N] [--completion-promise TEXT]"
allowed-tools: ["Bash(~/.claude/skills/ralph-controller/setup-ralph-controller.sh:*)"]
hide-from-slash-command-tool: "true"
---

# Ralph Controller Command

Start the deterministic controller setup flow:

```!
~/.claude/skills/ralph-controller/setup-ralph-controller.sh $ARGUMENTS
```

After setup, operate the target loop through the global `ralph-controller` skill semantics:
- load the orchestrator prompt for the run
- read the project state files
- perform one controlled turn
- end with a valid directive block
- let controller state drive `WORK`, `WAIT`, `STALL`, `DONE`, or `HALT`

For Truth Engine, the usual inputs are:
- `--prompt-file /home/opc/Truth-Engine/.claude/eval/ORCHESTRATOR_PROMPT.md`
- `--state-file /home/opc/Truth-Engine/.claude/eval/EVAL_STATE.md`
- `--loop-state-file /home/opc/Truth-Engine/.claude/eval/loop_state.json`

Optional flags:
- `--max-iterations`
- `--completion-promise`

Critical rule: never replace a real `WAIT` state with prose like "still waiting". The controller relies on the directive block, not narration.

Use `/ralph-controller-help` for the conceptual overview.
Use `/cancel-ralph-controller` to stop the active session.

## Truth Engine Example

```text
/ralph-controller --prompt-file /home/opc/Truth-Engine/.claude/eval/ORCHESTRATOR_PROMPT.md --state-file /home/opc/Truth-Engine/.claude/eval/EVAL_STATE.md --loop-state-file /home/opc/Truth-Engine/.claude/eval/loop_state.json --max-iterations 20 --completion-promise "ALL EVALUATION CRITERIA IN EVAL_STATE.md ARE PASS"
```

The setup script creates `.claude/ralph-controller.local.md` in the current project as the session-local bootstrap file and initializes the machine-readable loop state file if it does not exist.

This command is the supported user-facing replacement for `ralph-loop` when you want explicit controller state, real wait semantics, stagnation tracking, and reusable command ergonomics across projects.