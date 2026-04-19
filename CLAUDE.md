# Global Operating Policy

At conversation start, read `~/.claude/ORCHESTRATOR.md` for the full orchestration policy (delegation, routing, agents, skills, context management). That file is lead-agent-only — subagents should not read it.

---

## Core Principles

1. **Delegate by default.** Bounded implementation work goes to workers, not the lead thread.
2. **Context is precious.** Keep the main thread clean. Delegate noisy exploration to workers.
3. **Clarify material ambiguity early.** Ask when it changes the outcome. Use `AskFollowupQuestion` — never inline. Don't ask when inference suffices.
4. **Separate exploration from execution.** Explore first, synthesize, then act on a condensed plan.

---

## SecondBrain — personal knowledge vault

`~/SecondBrain/` is Liam's personal LLM Wiki (Karpathy-pattern: `raw/` sources → `wiki/` entities/concepts/topics/syntheses → `CLAUDE.md` co-evolving policy). Use it as a first-class knowledge source, not an afterthought.

**On every conversation:**
- When a question is about Liam, his work, projects, preferences, history, tools, or courses — **query SecondBrain first** before answering from memory alone. Read `~/SecondBrain/index.md` to locate candidate pages, follow `[[wikilinks]]`. Cite with `[[Page]]` inline.
- When new durable knowledge surfaces in chat (a decision, a source, a fact about a project, a new tool) — **offer to file it** ("File as `wiki/<type>/<Title>.md`?"). Don't silently let good thinking dissolve.
- When working inside `~/SecondBrain/`, the vault's own `CLAUDE.md` is authoritative for ingest/query/lint mechanics, frontmatter, logging, and commit discipline. Read it at session start if the task touches the vault.

**Hard invariants (from vault CLAUDE.md — apply whenever you touch the vault):**
- `raw/` is read-only, always. `raw/notes/` is human-authored; never edit.
- Every claim cites a source (`[^src1]` → `## Sources` block). `(inference)` inline for non-sourced reasoning.
- Backlinks live in prose, not footers.
- Append one `log.md` entry per operation; commit after each.
- Never delete a wiki page without explicit approval — propose in a lint report.

**Memory vs SecondBrain:** auto-memory (`~/.claude/projects/.../memory/`) is for session-continuity scraps (workflow preferences, model routing, in-flight project state). SecondBrain is for durable, cite-able knowledge about Liam's world. When in doubt about where a fact belongs: if it would make sense to someone reading the wiki cold in six months, it goes in SecondBrain; if it only makes sense mid-workflow, it goes in memory.

---

## Active Hooks

Three lean hooks on mutation events only:

1. **`suggest-compact`** — Counts Edit/Write calls, suggests `/compact` at intervals
2. **`continuous-learning-v2 observer`** — Captures Edit/Write patterns (async, 10s timeout)
3. **`pre-compact` state save** — Saves session state before compaction

---

Coding standards, security, testing, git workflow, and development process are defined in `~/.claude/rules/common/`. Language-specific rules are in `~/.claude/rules/typescript/` and `~/.claude/rules/python/`.
