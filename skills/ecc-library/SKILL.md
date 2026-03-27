---
name: ecc-library
description: Search the cached ECC skill archive for domain-specific skills that are not installed locally, then inspect a matching skill on demand without re-enabling the ECC plugin.
---

# ECC Library

Use this skill as a lightweight bridge to the ECC plugin cache after the plugin itself has been disabled. It lets you discover niche or rarely used ECC skills only when they are needed, instead of keeping the full ECC catalog installed in `~/.claude/skills` all the time.

## Purpose

The goal is to keep the active Claude setup lean while still preserving access to ECC's long tail of specialized skills.

This skill is useful when:
- a user asks for a narrow domain workflow that is not covered by the locally installed skills
- you suspect ECC already has a relevant skill, but you do not want to re-enable the plugin
- you want to inspect the cached archive before deciding whether a skill is worth extracting into the local skill set
- you want near-zero token overhead until a specialized capability is actually requested

## What This Skill Does

When invoked, this skill should:
1. Search the ECC cache under `~/.claude/plugins/cache/everything-claude-code/everything-claude-code/1.9.0/skills/`
2. Find candidate `SKILL.md` files whose folder names or descriptions match the requested domain
3. Read the frontmatter and short description of the best matches
4. Return a concise shortlist with enough detail for the user or agent to choose one
5. If needed, read the full `SKILL.md` for the selected candidate and summarize how it should be used

This skill does not install anything by default. It is a discovery and inspection layer over the cached ECC archive.

## When to Use

Use `ecc-library` when:
- the required capability is uncommon or highly domain-specific
- the local curated skill set does not appear to cover the task
- you want to browse ECC's archive without increasing default context load

Do not use it when:
- an equivalent local skill already exists and clearly fits the task
- the user only needs a direct code or file search
- the user has already asked to permanently extract a specific skill, in which case copy that skill instead of just searching for it

## Search Workflow

1. Form a natural-language query for the domain or workflow needed
2. Use `mgrep` against the ECC cache to identify likely matches
3. Read the top candidate `SKILL.md` files directly
4. Return only the most relevant matches, not a raw dump of every result
5. If the user picks one, summarize the skill or extract it in a separate step if requested

## Search Commands

Use `mgrep` for discovery and `Read` for follow-up inspection.

Examples:

```bash
mgrep "django patterns in ECC skills" ~/.claude/plugins/cache/everything-claude-code/everything-claude-code/1.9.0/skills
mgrep "video editing workflow in ECC skills" ~/.claude/plugins/cache/everything-claude-code/everything-claude-code/1.9.0/skills
mgrep "skills related to logistics or supply chain workflows" ~/.claude/plugins/cache/everything-claude-code/everything-claude-code/1.9.0/skills
```

## Expected Output

Return a compact shortlist with:
- skill name
- path to its `SKILL.md`
- one-line description
- why it looks relevant to the query
- whether it is worth reading in full or extracting locally

## Example Response Shape

```text
Found 3 likely ECC skills:
1. `django-patterns` — `~/.claude/plugins/cache/.../skills/django-patterns/SKILL.md`
   Covers Django architecture and implementation patterns; likely the best match.
2. `django-security` — `~/.claude/plugins/cache/.../skills/django-security/SKILL.md`
   Focused on secure Django practices; useful if the task is auth or input handling.
3. `django-tdd` — `~/.claude/plugins/cache/.../skills/django-tdd/SKILL.md`
   Useful when the request is specifically about test-first Django work.
```

## Constraints

- Treat the ECC cache as an archive, not an always-loaded dependency
- Prefer concise discovery summaries over copying large skill contents into the conversation
- Only read the full skill text when a candidate looks genuinely relevant
- Keep the user-facing output focused on decision-making: what exists, what matches, and what to do next
