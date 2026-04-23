#!/usr/bin/env python3
"""Ralph-controller Overseer — meta-reviewer subprocess entrypoint.

The ralph-controller stop-hook spawns this script in a detached child process
every N iterations. The overseer reads the project's state files, shells out
to `claude --bare -p` with a project-supplied role prompt, and writes:

  - OVERSEER_STATUS.md   (full replacement each cycle — "where are we now")
  - OVERSEER_LOG.md      (append-only narrative log)
  - OVERSEER_MESSAGE.md  (optional — injected by controller into next resume
                          prompt as an OVERSEER NOTE block)
  - EXECUTION_PLAN.md    (optional — verbatim single-match edits, guarded by
                          mtime + sha256 optimistic concurrency check)
  - OVERSEER_PROPOSED_RULES.md (optional — rule-change proposals queued for
                                user review, never auto-applied)

The overseer is **opt-in per project** via `overseer_enabled: true` in the
project-local ralph-controller marker file (`.claude/ralph-controller.local.md`
by default). Projects that lack the opt-in key never trigger this script.

All error paths are fail-open: any exception logs a skip entry to
OVERSEER_LOG.md and exits 0. The detached child must never take down the
stop-hook path that spawned it.

CLI:
    python3 overseer.py --marker-file <path> --iteration <n>

Environment: pure `python3` stdlib + the `claude` binary on PATH. No imports
from controller.py.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_INTERVAL = 15
DEFAULT_TIMEOUT_SECONDS = 180
DEFAULT_COMMIT_COUNT = 15
DEFAULT_MAX_FILE_BYTES = 40000
DEFAULT_LOG_TAIL_BYTES = 6000
DEFAULT_TRACE_TAIL_BYTES = 40000
DEFAULT_DIRECTIVE_HISTORY_COUNT = 15
MIN_INTERVAL = 1
MAX_INTERVAL = 1000
MIN_TIMEOUT_SECONDS = 10
MAX_TIMEOUT_SECONDS = 900
DISALLOWED_TOOLS = "Edit Write Bash Read Grep Glob Agent"
CLAUDE_PROJECTS_ROOT = Path.home() / ".claude" / "projects"
EDIT_PATTERN = re.compile(
    r'old_string:\s*"""(?P<old>.*?)"""\s*new_string:\s*"""(?P<new>.*?)"""',
    re.DOTALL,
)


def _stderr(message: str) -> None:
    print(f"overseer: {message}", file=sys.stderr)


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_scalar(raw_value: str) -> Any:
    value = raw_value.strip()
    if value == "null":
        return None
    if value == "true":
        return True
    if value == "false":
        return False
    if value.startswith('"') and value.endswith('"'):
        return json.loads(value)
    try:
        return int(value)
    except ValueError:
        return value


def _read_local_state(path: Path) -> dict[str, Any] | None:
    """Mini copy of controller.read_local_state to avoid module coupling.

    Returns None if the file is missing or malformed. Same YAML-ish flat
    frontmatter format as the ralph-controller marker file.
    """
    if not path.exists():
        return None
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return None
    if not content.startswith("---\n"):
        return None
    parts = content.split("---\n", 2)
    if len(parts) < 3:
        return None
    payload: dict[str, Any] = {}
    for line in parts[1].splitlines():
        if not line.strip():
            continue
        if ":" not in line:
            return None
        key, raw_value = line.split(":", 1)
        payload[key.strip()] = _parse_scalar(raw_value)
    return payload


def _resolve_path(project_root: Path, raw_path: str) -> Path:
    path = Path(raw_path)
    if path.is_absolute():
        return path
    return project_root / path


def _bounded_int(local_state: dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
    raw = local_state.get(key)
    try:
        value = int(raw) if raw is not None else default
    except (TypeError, ValueError):
        value = default
    return max(lo, min(hi, value))


def _resolve_config(local_state: dict[str, Any], project_root: Path) -> dict[str, Any] | None:
    """Build a fully-resolved config dict, or return None if not enabled / incomplete.

    Opt-in is strict: only literal boolean True enables the feature. Strings
    like ``"true"`` or integers fall through silently (fail-closed).
    """
    if local_state.get("overseer_enabled") is not True:
        return None

    def _required(key: str) -> Path | None:
        raw = local_state.get(key)
        if not isinstance(raw, str) or not raw.strip():
            return None
        return _resolve_path(project_root, raw.strip())

    prompt_file = _required("overseer_prompt_file")
    status_file = _required("overseer_status_file")
    log_file = _required("overseer_log_file")
    exec_plan_file = _required("overseer_exec_plan_file")
    eval_state_file = _required("overseer_eval_state_file")
    core_file = _required("overseer_core_file")
    if not all([prompt_file, status_file, log_file, exec_plan_file, eval_state_file, core_file]):
        return None

    def _optional(key: str, default_suffix: str) -> Path:
        raw = local_state.get(key)
        if isinstance(raw, str) and raw.strip():
            return _resolve_path(project_root, raw.strip())
        return status_file.parent / default_suffix

    message_file = _optional("overseer_message_file", "OVERSEER_MESSAGE.md")
    proposed_rules_file = _optional("overseer_proposed_rules_file", "OVERSEER_PROPOSED_RULES.md")

    directive_history_file = _optional(
        "overseer_directive_history_file", "OVERSEER_DIRECTIVE_HISTORY.jsonl"
    )
    session_id_raw = local_state.get("session_id")
    session_id = session_id_raw.strip() if isinstance(session_id_raw, str) else ""

    return {
        "interval": _bounded_int(local_state, "overseer_interval", DEFAULT_INTERVAL, MIN_INTERVAL, MAX_INTERVAL),
        "timeout_seconds": _bounded_int(
            local_state, "overseer_timeout_seconds", DEFAULT_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS
        ),
        "commit_count": _bounded_int(local_state, "overseer_commit_count", DEFAULT_COMMIT_COUNT, 1, 100),
        "max_file_bytes": _bounded_int(local_state, "overseer_max_file_bytes", DEFAULT_MAX_FILE_BYTES, 4000, 400000),
        "log_tail_bytes": _bounded_int(local_state, "overseer_log_tail_bytes", DEFAULT_LOG_TAIL_BYTES, 500, 80000),
        "trace_tail_bytes": _bounded_int(
            local_state, "overseer_trace_tail_bytes", DEFAULT_TRACE_TAIL_BYTES, 0, 200000
        ),
        "directive_history_count": _bounded_int(
            local_state, "overseer_directive_history_count", DEFAULT_DIRECTIVE_HISTORY_COUNT, 0, 200
        ),
        "prompt_file": prompt_file,
        "status_file": status_file,
        "log_file": log_file,
        "message_file": message_file,
        "proposed_rules_file": proposed_rules_file,
        "directive_history_file": directive_history_file,
        "exec_plan_file": exec_plan_file,
        "eval_state_file": eval_state_file,
        "core_file": core_file,
        "project_root": project_root,
        "session_id": session_id,
    }


def _read_text_capped(path: Path, cap: int) -> str:
    if not path.exists():
        return ""
    try:
        raw = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""
    if len(raw) <= cap:
        return raw
    return raw[:cap] + f"\n\n...[truncated {len(raw) - cap} bytes]...\n"


def _read_tail_text(path: Path, tail_bytes: int) -> str:
    if not path.exists():
        return ""
    try:
        raw = path.read_bytes()
    except OSError:
        return ""
    if len(raw) <= tail_bytes:
        return raw.decode("utf-8", errors="ignore")
    return "...[older entries truncated]...\n" + raw[-tail_bytes:].decode("utf-8", errors="ignore")


def _git_output(args: list[str], cwd: Path, timeout: int) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(cwd),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"[git {' '.join(args)} failed: {exc}]"
    if result.returncode != 0:
        return f"[git {' '.join(args)} exit {result.returncode}]"
    return result.stdout


def _head_sha(project_root: Path) -> str:
    out = _git_output(["rev-parse", "--short", "HEAD"], project_root, 5).strip()
    return out or "?"


def _find_session_jsonl(session_id: str, project_root: Path) -> Path | None:
    """Locate the live JSONL transcript for a given ralph-controller session.

    Claude Code writes to ``~/.claude/projects/<slug>/<session_id>.jsonl``
    where ``slug`` is derived from the project path (e.g.
    ``-home-opc-Truth-Engine``). Return the matching file, or None if no
    readable transcript exists.
    """
    if not session_id or not CLAUDE_PROJECTS_ROOT.exists():
        return None
    # Fast path: slug matches the project path with slashes -> dashes.
    try:
        slug = str(project_root).replace("/", "-")
        if slug.startswith("-"):
            candidate = CLAUDE_PROJECTS_ROOT / slug / f"{session_id}.jsonl"
            if candidate.is_file():
                return candidate
            candidate2 = CLAUDE_PROJECTS_ROOT / f"{slug}" / f"{session_id}.jsonl"
            if candidate2.is_file():
                return candidate2
        # Fallback: some Claude Code versions place the jsonl directly in the
        # project root, not inside the slug subdir. Scan one level deep.
        for entry in CLAUDE_PROJECTS_ROOT.iterdir():
            if not entry.is_dir():
                continue
            candidate = entry / f"{session_id}.jsonl"
            if candidate.is_file():
                return candidate
            # Also check for sibling jsonl next to a slug-named dir.
            sibling = entry.parent / f"{session_id}.jsonl"
            if sibling.is_file():
                return sibling
    except OSError:
        return None
    return None


def _render_transcript_entry(entry: dict[str, Any]) -> str | None:
    """Condense one transcript JSONL row to a short markdown fragment.

    Returns None when the row has nothing worth showing (malformed, empty
    system events, etc.). Keep each fragment small — dozens of these are
    joined and capped by bytes before being fed to the overseer LLM.
    """
    try:
        etype = entry.get("type")
        message = entry.get("message") or {}
        role = message.get("role") or etype
        timestamp = (entry.get("timestamp") or "")[:19]
        content = message.get("content")
        lines: list[str] = []
        if isinstance(content, str):
            snippet = content.strip().replace("\n", " ")
            if snippet:
                lines.append(f"[{timestamp}] **{role}**: {snippet[:400]}")
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    text = str(block.get("text") or "").strip().replace("\n", " ")
                    if text:
                        lines.append(f"[{timestamp}] **{role}**: {text[:400]}")
                elif btype == "tool_use":
                    name = block.get("name") or "?"
                    tool_input = block.get("input") or {}
                    if isinstance(tool_input, dict):
                        desc = (
                            tool_input.get("description")
                            or tool_input.get("subject")
                            or tool_input.get("pattern")
                            or tool_input.get("command")
                            or tool_input.get("file_path")
                            or ""
                        )
                    else:
                        desc = str(tool_input)
                    desc = str(desc).strip().replace("\n", " ")[:200]
                    subagent = (
                        tool_input.get("subagent_type") if isinstance(tool_input, dict) else None
                    )
                    suffix = f" [{subagent}]" if subagent else ""
                    lines.append(f"[{timestamp}] **{role}** -> tool:{name}{suffix}: {desc}")
                elif btype == "tool_result":
                    result = block.get("content") or ""
                    if isinstance(result, list):
                        parts = []
                        for chunk in result:
                            if isinstance(chunk, dict) and chunk.get("type") == "text":
                                parts.append(str(chunk.get("text") or ""))
                        result = " ".join(parts)
                    snippet = str(result).strip().replace("\n", " ")[:300]
                    if snippet:
                        lines.append(f"[{timestamp}] tool_result: {snippet}")
                elif btype == "thinking":
                    text = str(block.get("thinking") or "").strip().replace("\n", " ")
                    if text:
                        lines.append(f"[{timestamp}] _thinking_: {text[:300]}")
        return "\n".join(lines) if lines else None
    except Exception:
        return None


def _read_trace_tail(session_id: str, project_root: Path, tail_bytes: int) -> str:
    """Read last N bytes of assistant-facing transcript entries, rendered compactly.

    Fully fail-open: returns an empty string on any error or when the trace
    cannot be located. Reads the JSONL file from disk at cycle time, so it
    always sees up-to-date content (the file is appended to in real time by
    the running Claude Code session).
    """
    if tail_bytes <= 0 or not session_id:
        return ""
    try:
        path = _find_session_jsonl(session_id, project_root)
        if path is None:
            return ""
        # Read tail bytes; the first partial line is dropped because we cannot
        # be sure it's complete. Each JSONL row is fully self-contained.
        try:
            file_size = path.stat().st_size
        except OSError:
            return ""
        read_bytes = min(file_size, max(tail_bytes * 4, 200000))
        with path.open("rb") as handle:
            handle.seek(max(0, file_size - read_bytes))
            raw = handle.read()
        text = raw.decode("utf-8", errors="ignore")
        # Drop the first partial line.
        if file_size > read_bytes and "\n" in text:
            text = text.split("\n", 1)[1]
        rendered: list[str] = []
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(entry, dict):
                continue
            fragment = _render_transcript_entry(entry)
            if fragment:
                rendered.append(fragment)
        joined = "\n".join(rendered)
        if not joined:
            return ""
        # Final byte cap: keep only the tail of the rendered content.
        if len(joined) > tail_bytes:
            return "...[older transcript entries truncated]...\n" + joined[-tail_bytes:]
        return joined
    except Exception:
        return ""


def _read_directive_history_tail(path: Path, count: int) -> str:
    """Read the last ``count`` JSONL directive entries as a compact report."""
    if count <= 0 or not path.exists():
        return ""
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return ""
    tail = [ln for ln in lines if ln.strip()][-count:]
    rendered: list[str] = []
    for ln in tail:
        try:
            entry = json.loads(ln)
        except json.JSONDecodeError:
            continue
        directive = entry.get("directive") or {}
        it = entry.get("iteration", "?")
        state = (directive.get("STATE") if isinstance(directive, dict) else None) or entry.get(
            "controller_state", "?"
        )
        progress = (
            directive.get("PROGRESS") if isinstance(directive, dict) else None
        )
        next_action = (
            directive.get("NEXT_ACTION") if isinstance(directive, dict) else None
        ) or entry.get("note") or ""
        progress_str = "T" if progress is True else ("F" if progress is False else "-")
        rendered.append(
            f"- iter {it} | {state} | progress={progress_str} | {str(next_action)[:200]}"
        )
    return "\n".join(rendered)


def _build_user_prompt(config: dict[str, Any], iteration: int, loop_state_path: Path) -> str:
    head_sha = _head_sha(config["project_root"])
    cap = int(config["max_file_bytes"])
    commits = _git_output(
        ["log", f"-{int(config['commit_count'])}", "--oneline", "--stat"],
        config["project_root"],
        10,
    )
    directive_history = _read_directive_history_tail(
        config["directive_history_file"], int(config["directive_history_count"])
    )
    trace_tail = _read_trace_tail(
        config.get("session_id") or "",
        config["project_root"],
        int(config["trace_tail_bytes"]),
    )
    parts = [
        f"# Overseer Cycle — iteration {iteration} — {_iso_now()} — HEAD {head_sha}\n",
        "## Ralph-controller loop_state.json (current)\n```json\n"
        + _read_text_capped(loop_state_path, 4000)
        + "\n```\n",
        "## EXECUTION_PLAN.md\n" + _read_text_capped(config["exec_plan_file"], cap) + "\n",
        "## EVAL_STATE.md\n" + _read_text_capped(config["eval_state_file"], cap) + "\n",
        "## ORCHESTRATOR_CORE.md\n" + _read_text_capped(config["core_file"], cap) + "\n",
        f"## Recent git commits (last {int(config['commit_count'])})\n```\n" + commits + "\n```\n",
    ]
    if directive_history:
        parts.append(
            f"## Rolling directive history (last {int(config['directive_history_count'])} turns)\n"
            + directive_history
            + "\n"
        )
    if trace_tail:
        parts.append(
            "## Orchestrator transcript tail (recent assistant turns, tool calls, subagent dispatches)\n"
            + trace_tail
            + "\n"
        )
    parts += [
        "## Current OVERSEER_STATUS.md (for continuity — replace with fresh synthesis)\n"
        + _read_text_capped(config["status_file"], min(cap, 20000))
        + "\n",
        "## Tail of OVERSEER_LOG.md (for narrative continuity — do NOT repeat wholesale)\n"
        + _read_tail_text(config["log_file"], int(config["log_tail_bytes"]))
        + "\n",
        "\n---\nProduce your structured output per the overseer role spec. "
        "Emit only the declared <<<...>>> blocks. No preamble, no signoff.\n",
    ]
    return "\n".join(parts)


def _parse_block(text: str, name: str) -> str | None:
    start_tag = f"<<<{name}>>>"
    end_tag = f"<<<END_{name}>>>"
    start = text.find(start_tag)
    if start < 0:
        return None
    end = text.find(end_tag, start + len(start_tag))
    if end < 0:
        return None
    return text[start + len(start_tag) : end].strip("\n")


def _parse_plan_edits(block: str) -> list[tuple[str, str]]:
    edits: list[tuple[str, str]] = []
    for match in EDIT_PATTERN.finditer(block):
        old = match.group("old")
        new = match.group("new")
        if old:
            edits.append((old, new))
    return edits


def _apply_plan_edits(edits: list[tuple[str, str]], exec_plan_file: Path) -> tuple[int, int]:
    """Apply verbatim single-match edits with optimistic concurrency.

    The overseer runs detached and can overlap with orchestrator edits to the
    same file. Read once up front, apply in-memory, then re-read before write
    and abort the whole batch if mtime or content hash drifted.
    """
    if not exec_plan_file.exists():
        return (0, len(edits))
    try:
        original_bytes = exec_plan_file.read_bytes()
        original_mtime = exec_plan_file.stat().st_mtime_ns
    except OSError as exc:
        _stderr(f"cannot read exec plan: {exc}")
        return (0, len(edits))
    original_hash = hashlib.sha256(original_bytes).digest()
    try:
        text = original_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        _stderr(f"exec plan not valid utf-8: {exc}")
        return (0, len(edits))
    applied = 0
    skipped = 0
    for old, new in edits:
        occurrences = text.count(old)
        if occurrences != 1:
            skipped += 1
            continue
        text = text.replace(old, new, 1)
        applied += 1
    if not applied:
        return (applied, skipped)
    try:
        current_bytes = exec_plan_file.read_bytes()
        current_mtime = exec_plan_file.stat().st_mtime_ns
    except OSError as exc:
        _stderr(f"cannot re-read exec plan for concurrency check: {exc}")
        return (0, len(edits))
    current_hash = hashlib.sha256(current_bytes).digest()
    if current_hash != original_hash or current_mtime != original_mtime:
        _stderr("exec plan changed during edit batch (concurrency); aborting all edits")
        return (0, len(edits))
    try:
        exec_plan_file.write_text(text, encoding="utf-8")
    except OSError as exc:
        _stderr(f"cannot write exec plan: {exc}")
        return (0, len(edits))
    return (applied, skipped)


def _append_file(path: Path, entry: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    prefix = "" if not path.exists() else "\n\n"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(prefix + entry.rstrip() + "\n")


def _log_skip(log_file: Path, iteration: int, reason: str) -> None:
    try:
        entry = (
            f"## {_iso_now()} — iteration {iteration} — SKIPPED\n"
            f"- Reason: {reason}\n"
            f"- No status rewrite this cycle."
        )
        _append_file(log_file, entry)
    except OSError as exc:
        _stderr(f"cannot append skip log: {exc}")


def _invoke_llm(config: dict[str, Any], user_prompt: str) -> str:
    """Call claude in print mode with the project prompt + user prompt.

    Intentionally does NOT use ``--bare``. Bare mode refuses to read OAuth
    credentials and requires ``ANTHROPIC_API_KEY`` or ``apiKeyHelper`` via a
    settings file — users on the Claude subscription have neither, and every
    cycle would fail with "Not logged in".

    To isolate the overseer's own Claude process from the project's Stop hooks
    (which would otherwise recurse the ralph-controller into itself), point the
    child at an empty project-scoped settings file written to a temp directory,
    and use ``--add-dir`` to avoid inheriting CLAUDE.md from the project cwd.
    """
    system_prompt = _read_text_capped(config["prompt_file"], 50000)
    if not system_prompt:
        raise RuntimeError("overseer prompt file missing or empty")
    claude_bin = shutil.which("claude") or "claude"

    empty_settings = None
    try:
        import tempfile as _tempfile

        tmp_dir = Path(_tempfile.mkdtemp(prefix="overseer-"))
        empty_settings = tmp_dir / "settings.json"
        empty_settings.write_text("{}\n", encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(f"overseer cannot stage empty settings: {exc}")

    cmd = [
        claude_bin,
        "-p",
        "--settings",
        str(empty_settings),
        "--disable-slash-commands",
        "--append-system-prompt",
        system_prompt,
        "--disallowedTools",
        DISALLOWED_TOOLS,
    ]

    try:
        result = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=int(config["timeout_seconds"]),
            cwd=str(tmp_dir),
            input=user_prompt,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"claude -p timed out after {config['timeout_seconds']}s")
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError(f"claude -p spawn failed: {exc}")
    finally:
        try:
            if empty_settings is not None:
                shutil.rmtree(empty_settings.parent, ignore_errors=True)
        except Exception:
            pass

    if result.returncode != 0:
        stderr_tail = (result.stderr or "").strip()[-400:] or "(empty stderr)"
        stdout_tail = (result.stdout or "").strip()[-200:]
        raise RuntimeError(
            f"claude -p exit {result.returncode} | stderr: {stderr_tail} | stdout: {stdout_tail}"
        )
    return result.stdout or ""


def _run_cycle(config: dict[str, Any], iteration: int, loop_state_path: Path) -> None:
    user_prompt = _build_user_prompt(config, iteration, loop_state_path)
    raw_output = _invoke_llm(config, user_prompt)

    status_md = _parse_block(raw_output, "STATUS_MD")
    log_entry = _parse_block(raw_output, "LOG_ENTRY")
    orch_msg = _parse_block(raw_output, "ORCHESTRATOR_MESSAGE")
    plan_edit_block = _parse_block(raw_output, "EXECUTION_PLAN_EDIT")
    proposed_rule = _parse_block(raw_output, "PROPOSED_RULE_CHANGE")

    if not status_md or not log_entry:
        tail = raw_output[-600:] if raw_output else "(empty)"
        raise RuntimeError(f"required blocks missing. tail: {tail}")

    status_file = config["status_file"]
    status_file.parent.mkdir(parents=True, exist_ok=True)
    status_file.write_text(status_md.rstrip() + "\n", encoding="utf-8")

    _append_file(config["log_file"], log_entry)

    message_file = config["message_file"]
    if orch_msg:
        message_file.parent.mkdir(parents=True, exist_ok=True)
        message_file.write_text(orch_msg.rstrip() + "\n", encoding="utf-8")
    else:
        if message_file.exists():
            try:
                message_file.unlink()
            except OSError:
                pass

    if plan_edit_block:
        edits = _parse_plan_edits(plan_edit_block)
        if edits:
            applied, skipped = _apply_plan_edits(edits, config["exec_plan_file"])
            _stderr(f"exec plan edits applied={applied} skipped={skipped}")

    if proposed_rule:
        _append_file(config["proposed_rules_file"], proposed_rule)


def main(argv: list[str] | None = None) -> int:
    """Fully fail-open entrypoint. Any exception path logs and returns 0."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--marker-file", required=True)
    parser.add_argument("--iteration", default="0")
    args = parser.parse_args(argv)

    log_file: Path | None = None
    try:
        iteration = int(args.iteration)
    except (TypeError, ValueError):
        iteration = 0

    try:
        marker_path = Path(args.marker_file)
        local_state = _read_local_state(marker_path)
        if local_state is None:
            return 0
        project_root_raw = str(local_state.get("project_root") or "").strip()
        project_root = Path(project_root_raw) if project_root_raw else marker_path.resolve().parent.parent
        config = _resolve_config(local_state, project_root)
        if config is None:
            return 0
        log_file = config["log_file"]

        loop_state_raw = str(local_state.get("loop_state_file") or "").strip()
        if not loop_state_raw:
            _log_skip(log_file, iteration, "missing loop_state_file in local state")
            return 0
        loop_state_path = Path(loop_state_raw)
        if not loop_state_path.is_absolute():
            loop_state_path = project_root / loop_state_path

        _run_cycle(config, iteration, loop_state_path)
        return 0
    except Exception as exc:
        try:
            if log_file is not None:
                _log_skip(log_file, iteration, str(exc))
        except Exception:
            pass
        _stderr(f"cycle failed: {exc}")
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        _stderr(f"internal error: {exc}")
        raise SystemExit(0)
