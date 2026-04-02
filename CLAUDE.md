# Global Operating Policy

At conversation start, read `~/.claude/ORCHESTRATOR.md` for the full orchestration policy (delegation, routing, agents, skills, context management). That file is lead-agent-only — subagents should not read it.

---

## Core Principles

1. **Delegate by default.** Bounded implementation work goes to workers, not the lead thread.
2. **Context is precious.** Keep the main thread clean. Delegate noisy exploration to workers.
3. **Clarify material ambiguity early.** Ask when it changes the outcome. Use `AskFollowupQuestion` — never inline. Don't ask when inference suffices.
4. **Separate exploration from execution.** Explore first, synthesize, then act on a condensed plan.

---

## Active Hooks

Three lean hooks on mutation events only:

1. **`suggest-compact`** — Counts Edit/Write calls, suggests `/compact` at intervals
2. **`continuous-learning-v2 observer`** — Captures Edit/Write patterns (async, 10s timeout)
3. **`pre-compact` state save** — Saves session state before compaction

---

Coding standards, security, testing, git workflow, and development process are defined in `~/.claude/rules/common/`. Language-specific rules are in `~/.claude/rules/typescript/` and `~/.claude/rules/python/`.
