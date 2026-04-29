---
name: council
description: Force 5 thinking-style advisors (Contrarian, First Principles, Expansionist, Outsider, Executor) onto a decision, run an anonymous peer-review round across them, then have a chairman synthesize a verdict with one concrete next step. Use when the user says "council this", "council it", or asks for a council on a decision where being wrong is expensive. Roles map to dedicated council agents across five provider families (Zhipu, Moonshot, MiniMax, Anthropic, OpenAI) with Gemini as primary Outsider. Not for validation-seeking — the council will surface things the user may not want to hear.
---

# Council

## Overview

Ask Claude a decision question directly and it tends to mirror the framing back at you. The council breaks this by running five dedicated decision-council agents with distinct thinking styles and underlying models, having them anonymously peer-review each other, and then a chairman synthesizing a committed verdict.

This runs in one session. The lead agent orchestrates framing, dispatch, and report. Role agents do the thinking.

## When to run

Run when the user says **"council this ..."**, **"council it"**, asks for a council, or the decision obviously fits: high cost of being wrong, circling for days, stuck between options.

Skip if the user just wants validation or the stakes are low. In that case, say so before spawning anything.

## Role → agent mapping (fixed)

| Role | Agent | Model | Family |
|---|---|---|---|
| Contrarian | `council-contrarian` | `litellm/glm-5` | Zhipu |
| First Principles | `council-first-principles` | `litellm/kimi-k2.5` | Moonshot |
| Expansionist | `council-expansionist` | `litellm/minimax-m2` | MiniMax |
| Outsider | Gemini CLI, fallback `council-outsider` | `gemini-3.1-pro-preview`, else native Sonnet | Google / Anthropic |
| Executor | `council-executor` | `litellm/gpt-5.4` | OpenAI |
| Chairman | `council-chairman` | `opus` (native) | Anthropic |

Each council agent's system prompt is purpose-built for decision-council work. Do not use generic `*-consult` or `*-worker` agents — they were written for code review and will drift off-task.

Every role agent enforces the same output contract:

```
## Verdict
<one sentence>

## Confidence
<low|medium|high> — <reason>
```

plus role-specific sections above it. The chairman and peer reviewers depend on this structure.

## Protocol

### Phase 0 — Frame the question (lead agent, in-thread, no subagent cost)

This phase runs inside the lead agent's own thread — it is **not** a subagent call. It adds no meaningful latency.

1. Extract the user's question from the skill argument.
2. Restate the question in 1–3 sentences that make the decision explicit: what is being chosen between, what the consequences are, and any constraints the user mentioned. If the user passed files, prior decisions, or context, include them verbatim as a `Context:` block.
3. If the question is genuinely ambiguous in a way that will produce five off-target advisor responses (e.g. "is X good?" with no stakes context), ask **one** `AskUserQuestion` clarifier about what's at stake or what "success" means. Do not interrogate — one question max, then proceed.
4. Generate timestamp: `date +%Y%m%d-%H%M%S`. Build transcript path `~/.claude/council-runs/<timestamp>-<slug>.md` where `<slug>` is 3–5 word kebab-case summary.
5. Create the transcript using the template at `references/transcript-template.md` and write the framed question + context at the top.

The framed question and context are what get passed to every advisor in Phase 1. This is where sloppy input becomes tight input; do not skip it.

### Phase 1 — Advisors (parallel, single message)

Dispatch all five advisors in **one message** with five parallel `Agent` tool calls. No advisor sees any other's work.

For four of them, use the dedicated council agents directly:

- `subagent_type: council-contrarian`
- `subagent_type: council-first-principles`
- `subagent_type: council-expansionist`
- `subagent_type: council-executor`

The prompt to each is simply the framed question + context from Phase 0. Their system prompt already carries the role. Do not re-inject role instructions.

For the **Outsider**, try Gemini first. In the same parallel dispatch, run a `Bash` call:

```bash
python3 ~/.claude/skills/gemini-delegate/scripts/gemini_consult.py \
  --cwd "$HOME" \
  --prompt-file /tmp/council-outsider-<timestamp>.txt \
  --stance balanced \
  --timeout 120
```

Write the prompt to the prompt-file first. The prompt-file contents must be the Outsider role prompt from `references/outsider-gemini-prompt.md` with the framed question substituted. Using the prompt-file bypasses `gemini_consult.py`'s hardcoded stance text and lets the Outsider role contract dominate.

If the Gemini call fails (non-zero exit, empty output, JSON error payload, timeout), fall back to the `council-outsider` subagent with the same framed question. Record `outsider_path: gemini` or `outsider_path: sonnet-fallback` in the transcript.

After all five responses return, append each to the transcript under `## Round 1 — Advisors`, labeled by role.

### Phase 2 — Anonymous peer review (parallel, single message)

1. Assign letters A–E to the five responses. Shuffle deterministically: sort by `sha1(response.first_64_chars)` and assign A to lowest hash, E to highest. This hides role→letter mapping from reviewers while keeping the assignment reconstructible.
2. Write the `role → letter` map to the transcript inside a `<details>` block labeled "Review key (do not read during review)".
3. Dispatch five peer reviews in **one message** with five parallel calls. Each reviewer is the same role agent as in Round 1 (reusing `council-contrarian`, etc.). Each reviewer sees **all five** lettered responses — their own included but anonymized. Anonymity via the shuffle is sufficient; do not drop their own entry.
4. The review prompt is in `references/peer-review-prompt.md`. Substitute `{{QUESTION}}`, `{{CONTEXT}}`, and `{{LETTERED_RESPONSES}}` before sending. Each reviewer answers exactly three questions:
   1. Which response is strongest and why?
   2. Which has the biggest blind spot, and what is it?
   3. What did all five miss?

Append all five reviews to the transcript under `## Round 2 — Peer review`, labeled by reviewing role (Review by Contrarian, Review by First Principles, etc.).

### Phase 3 — Chairman synthesis

Call `council-chairman` with:
- The framed question and context
- All five raw advisor responses (role-labeled — the chairman is allowed to know who said what)
- All five peer reviews (letter-labeled)
- The role → letter map, so the chairman can connect review criticism to specific roles

The chairman's system prompt already enforces the output contract (Verdict / Strongest counter-argument / Concrete next step). Do not re-inject instructions.

Append the chairman's output to the transcript under `## Chairman verdict`.

### Phase 4 — Report

Print **inline** to the user, in this order, verbatim from the chairman:

1. The `## Verdict` paragraph.
2. The `## Strongest counter-argument` paragraph.
3. The `## Concrete next step` line.
4. One final line: `Full transcript: <absolute path>`.

Do not re-summarize advisors inline. Do not editorialize. The chairman's output is the output.

## Guardrails

- **All Phase 1 calls go out in one parallel dispatch.** No advisor may see any other's response.
- **All Phase 2 calls go out in one parallel dispatch.** Same reason.
- **Gemini never blocks the council.** If it's slow or broken, fall back immediately to `council-outsider`.
- **No role labels in Phase 2.** Reviewers see letters only; the role → letter map stays in the transcript.
- **Chairman output prints verbatim.** The lead agent does not paraphrase or summarize.
- **11 subagent calls per run, maximum.** Five advisors + five reviews + one chairman. Do not loop, do not add rounds.
- **Skip trivial inputs.** If the user invokes the council on something low-stakes, say so and ask whether they really want the full council before spawning anything.

## Files

- `references/roles.md` — reference only: role descriptions (the actual role prompts live in each agent's system prompt).
- `references/outsider-gemini-prompt.md` — prompt template sent to Gemini CLI for the Outsider role.
- `references/peer-review-prompt.md` — template for the anonymous peer-review round.
- `references/transcript-template.md` — transcript skeleton.

## Example invocation

User: `council this: should I launch my Claude Code product as a self-paced course or a live workshop?`

Lead agent:
1. **Phase 0 (in-thread):** Restates the question with stakes, writes framed question + empty context to `~/.claude/council-runs/20260420-153012-course-vs-workshop.md`.
2. **Phase 1 (parallel, one message):** Dispatches `council-contrarian`, `council-first-principles`, `council-expansionist`, `council-executor`, and Gemini via Bash.
3. **Phase 2 (parallel, one message):** Shuffles A–E, dispatches 5 peer reviews reusing the same role agents.
4. **Phase 3:** `council-chairman` synthesizes.
5. **Phase 4:** Prints Verdict + Counter-argument + Next step + transcript path.
