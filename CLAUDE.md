# Global Operating Policy

At conversation start, read `~/.claude/ORCHESTRATOR.md` for the full orchestration policy (delegation, routing, agents, skills, context management). That file is lead-agent-only — subagents should not read it.

---

## Core Principles

1. **Delegate by default.** Bounded implementation work goes to workers, not the lead thread.
2. **Context is precious.** Keep the main thread clean. Delegate noisy exploration to workers.
3. **Clarify material ambiguity early.** Ask when it changes the outcome. Use `AskFollowupQuestion` — never inline. Don't ask when inference suffices.
4. **Separate exploration from execution.** Explore first, synthesize, then act on a condensed plan.

## Read Tool — Mandatory (CRITICAL)

When calling `Read`, you MUST always provide a syntactically valid, non-empty `pages` value. **Never** omit `pages`, and **never** send `pages: ""`, `pages: null`, or any blank/placeholder value; this runtime can serialize missing `pages` as an empty string, and `Read` fails validation before hooks can intervene. For non-PDF files, set `pages: "1"`; it is valid syntax and ignored by text reads. For PDF files, set `pages` to the actual page or range you intend to read, such as `"1"` or `"1-5"`. For large text files, use concrete `offset` and `limit` values to scope reads.

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

## Local environment

**Docker runs on a remote server, not locally.** Liam uses a Docker context pointed at `oserver` to keep RAM/CPU off the laptop. Containers and their published ports live on the remote host. Host-side TCP (e.g. `localhost:7234`) is only reachable after opening an SSH tunnel.

- Before any local connection to a containerised service (`psql`, `pytest` against a DB, `truth-engine run-live`, Temporal client), open the tunnel: `tunnel <port>` (shell function over `ssh oserver` with ControlMaster reuse). E.g. `tunnel 7234` for the Truth Engine Postgres, `tunnel 7233` for Temporal.
- `tunnel` is a Bash function — from a non-interactive shell, invoke as `bash -lc 'tunnel <port>'`.
- If `psql -h localhost -p <port>` is refused but `docker exec ... psql` works, the container is fine — just open the tunnel.
- Don't `docker compose up` services that already exist on the remote — they collide with the tunnelled port and fail with "Bind for 0.0.0.0:<port> failed: port is already allocated".

---

## Active Hooks

Three lean hooks on mutation events only:

1. **`suggest-compact`** — Counts Edit/Write calls, suggests `/compact` at intervals
2. **`continuous-learning-v2 observer`** — Captures Edit/Write patterns (async, 10s timeout)
3. **`pre-compact` state save** — Saves session state before compaction

---

Coding standards, security, testing, git workflow, and development process are defined in `~/.claude/rules/common/`. Language-specific rules are in `~/.claude/rules/typescript/` and `~/.claude/rules/python/`.
