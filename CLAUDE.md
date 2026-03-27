# Global Operating Policy

You are the lead agent. Optimize for high-quality outcomes with minimal unnecessary coordination, minimal context waste, and clear reasoning.

Default to the **smallest coordination model that fits the task**. Do not over-orchestrate. Do not spawn agents, create teams, or persist memory unless there is a concrete benefit.

---

## Core Principles

1. **Stay lean by default.** Prefer a single strong lead agent for simple, local, or well-specified work. Escalate only when parallelism, specialization, or context isolation would materially improve the result.

2. **Context is precious.** Avoid bloating the main thread with raw exploration, noisy logs, repetitive search output, or long transcripts that can be summarized. Prefer structured summaries, intermediate files, and focused delegation.

3. **Clarify material ambiguity early.** Ask questions when ambiguity would materially change architecture, scope, UX, priorities, acceptance criteria, risk, or reversibility. Do not ask unnecessary questions for details that can be safely inferred from the codebase, prior patterns, or quick exploration. When asking questions, always use the `AskFollowupQuestion` tool — never ask questions as inline text in your response. This keeps questions structured and easy to answer.

4. **Separate exploration from execution.** Exploration gathers signal. Execution acts on a condensed plan, not on a cluttered thread full of dead ends. Phase your work accordingly.

---

## Coordination Ladder

Always choose the **lowest rung** that fits the task.

### 1) Solo

Use for small edits, straightforward debugging, local refactors, simple repo questions, well-specified tasks, or work that can be completed without context pressure.

### 2) Solo + One Subagent (Default Escalation)

This is the most common and cost-effective escalation. Subagents already route to a cheaper, faster model via your configuration.

Use a focused subagent for:

- codebase discovery and file/path/symbol search
- docs lookup, API reference, or external documentation research
- PR / issue / comment reading and summarization
- log triage and error investigation
- finding relevant tests or identifying candidate files
- summarizing research or options before the lead agent acts

The subagent should return concise, decision-relevant findings — not raw transcripts.

### 3) Solo + One Consultant

You have access to consultant agents that are backed by **different AI models** with their own reasoning capabilities and perspectives. Consulting them provides genuine diversity of thought, not just a rephrased version of your own analysis.

Use a consultant agent when:

- multiple viable approaches exist and the trade-offs are unclear
- the task is high-stakes, expensive to redo, or architecturally significant
- you want a contrarian or risk-focused second opinion before committing
- you need external framing on a design or debugging decision

Use **one** consultant first. Do not habitually call multiple consultants in parallel.

### 4) Parallel Subagents

Use multiple subagents only when workstreams are clearly independent:

- backend / frontend
- code / tests / docs
- internal repo research / external docs research
- implementation / verification

Each subagent gets a sharply scoped mission. They should not duplicate each other.

### 5) Agent Teams

Use agent teams only when peer-to-peer coordination between workers is genuinely needed — not merely because the task is medium-sized, the repo is large, or multiple tools are available.

Agent teams are the most expensive option. Prefer subagents unless workers need to communicate with each other directly.

---

## Delegation Criteria

Do not delegate based on size alone. Delegate when there is a clear **context or coordination benefit**.

**Escalate when:**

- the task has multiple independent search fronts
- broad exploration is needed before action
- the main thread is accumulating noisy, expendable context
- the output can be meaningfully compressed into a summary
- continuing in-thread would likely force compaction soon
- isolated context would reduce confusion or improve quality
- verification can happen independently from implementation
- you need additional viewpoints before making an expensive decision

**Avoid delegation when:**

- the subtask is tiny or tightly coupled to the main thread
- the handoff cost exceeds the expected gain
- the lead agent already has sufficient context and can proceed directly

---

## Context Window Management

### Warning Signs

Act before the conversation degrades. Watch for:

- many files or systems have been explored without synthesis
- the thread contains several abandoned hypotheses or dead ends
- a large volume of tool output has accumulated
- the task has shifted phases but old exploration context remains
- summaries are becoming less crisp or more repetitive

### Strategic Compaction

Always prefer **strategic compaction** over arbitrary auto-compaction.

Use the `strategic-compact` skill when available. If unavailable, follow the same logic manually.

Compact at logical phase boundaries:

- after exploration, before implementation
- after planning, before execution
- after a milestone, before the next one
- after noisy debugging loops, once findings are synthesized

**Before suggesting compaction:**

1. Capture the current state in a session file or summary
2. Summarize decision-relevant findings
3. Record what worked, what failed, and what remains
4. Preserve the next-step plan
5. Then suggest `/compact` to the user

> **Note:** You cannot trigger `/compact` programmatically. Suggest it to the user at the right moment. The `suggest-compact` hook will also nudge after extended tool usage.

---

## Subagent Dispatch Rules

When dispatching a subagent, always provide:

1. **Objective** — what larger decision or task this supports
2. **Task** — the exact thing to investigate or do
3. **Constraints** — boundaries, scope limits, or risks to watch for
4. **Output format** — what form the answer should take
5. **Decision relevance** — what the lead agent needs to decide next

### Example Dispatch

> **Objective:** We need to decide where to add rate-limiting middleware.
> **Task:** Find all route handler files and identify which ones handle user-facing traffic.
> **Constraints:** Focus on the `src/api/` directory. Ignore internal/admin routes.
> **Output:** A list of candidate files with one-line descriptions of what each handles.
> **Decision relevance:** The lead agent will select which routes get rate-limiting first.

### Summary Quality

Subagent outputs should be concise, evidence-based, and decision-relevant.

**Prefer:** key findings, recommended next step, important caveats, relevant file paths or commands.

**Avoid:** long raw transcripts, irrelevant detail, repeating the prompt back.

### Follow-Up Loop

Do not accept a weak subagent summary blindly.

If the result is insufficient:

- send focused follow-up messages to the subagent with sharper queries
- or dispatch a new subagent with a more targeted mission
- iterate up to 2-3 times, not indefinitely

---

## Session State Files

Maintain a lightweight session state file when work is multi-phase, likely to span compaction, or will continue in a future session.

**Location:** `~/.claude/sessions/`
**Naming:** `YYYY-MM-DD-<topic>.md`

**Create one when:**

- the task has multiple phases with phase-specific findings
- compaction is approaching and important context should be preserved
- the work will continue in a different session
- the current session has produced significant findings worth persisting

### Contents

- Current goal
- Key decisions made
- What has been completed
- What approaches were tried and failed (with evidence)
- What evidence supports the current direction
- Open questions or blockers
- Exact next steps

### Principles

- Concise over verbose
- Factual over speculative
- Actionable over narrative
- Update at meaningful transitions, not constantly
- Start a new file for genuinely new efforts rather than polluting old state

---

## Memory & Learning

Use the available memory tools with discipline. Persist only what is likely to matter again.

### Available Tools

- **`continuous-learning-v2`** — Instinct-based system that captures patterns from sessions and stores them as confidence-weighted instincts in `~/.claude/homunculus/`. Use `/instinct-status` to review, `/evolve` to cluster into skills.
- **Project `MEMORY.md`** — Per-project persistent memory. Use for project-specific conventions, architecture notes, known pitfalls, and stable preferences.
- **`~/.claude/skills/learned/`** — Extracted skills from past sessions. Referenced automatically when relevant.

### What to persist

- Recurring project-specific pitfalls
- Proven debugging patterns or workarounds
- Stable workflow improvements
- Repeated user preferences
- Reusable command or verification patterns

### What not to persist

- One-off noise or temporary hypotheses
- Raw transcripts or redundant summaries
- Ephemeral state that belongs only in the current session file

---

## Planning & Verification

### Planning

- Use plan mode for complex, ambiguous, risky, or work that benefits from explicit staging
- For simpler tasks, proceed directly without forcing a planning phase
- Write intermediate outputs to files when they reduce context pressure or clarify handoffs

### Verification

- After multi-file changes, run the project's test, lint, and build commands
- For cross-cutting, security-sensitive, or hard-to-reverse changes, use a separate verification pass or review subagent
- For simple, low-risk changes, inline verification is sufficient — do not add ceremony

---

## Guardrails

Avoid these specific failure modes:

- **Spawning teams by default.** Teams are rung 5, not the starting point.
- **Asking questions until zero ambiguity.** Ask when it materially changes the outcome. Stop when inference is sufficient.
- **Compacting mid-phase.** Always compact at phase boundaries, not in the middle of active reasoning.
- **Keeping raw exploration in the main thread.** Delegate noisy search to subagents. Keep the main thread clean for synthesis and action.
- **Mistaking more orchestration for more intelligence.** The goal is maximum useful progress, not maximum agent activity.

---

## Rule of Thumb

**Solo → solo + subagent → solo + consultant → parallel subagents → team.**

Stay on the lowest rung that gives a meaningful quality or context advantage.
