#!/usr/bin/env python3
"""Deterministic controller runtime for directive-based autonomous loops."""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

VALID_STATES = {"BOOT", "WORK", "WAIT", "STALL", "DONE", "HALT"}
ALTERNATE_DIRECTIVE_START = "<<>>"
ALTERNATE_DIRECTIVE_END = "<<>>"
TERMINAL_STATES = {"DONE", "HALT", "CANCELLED"}
START = "<<<RALPH_CONTROLLER_DIRECTIVE>>>"
END = "<<<END_RALPH_CONTROLLER_DIRECTIVE>>>"
MARKER_PATH = ".claude/ralph-controller.local.md"


@dataclass(frozen=True)
class Directive:
    state: str
    progress: bool
    wake_after_seconds: int
    next_action: str


@dataclass(frozen=True)
class ResumeDecision:
    should_resume: bool
    reason: str
    system_message: str | None = None
    next_iteration: int | None = None
    prompt: str | None = None


def _stderr(message: str) -> None:
    print(message, file=sys.stderr)


def _debug_reason(message: str) -> None:
    _stderr(f"ralph-controller: {message}")


def default_loop_state() -> dict[str, Any]:
    return {
        "version": 1,
        "controller_state": "BOOT",
        "iteration": 0,
        "stagnation_count": 0,
        "last_directive": None,
        "wake_after_seconds": 0,
        "wake_at": None,
        "terminal_reason": None,
        "cancelled": False,
    }


def load_loop_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return default_loop_state()
    return {**default_loop_state(), **json.loads(path.read_text(encoding="utf-8"))}


def save_loop_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


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


def read_local_state(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    content = path.read_text(encoding="utf-8")
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


def write_local_state(path: Path, state: dict[str, Any]) -> None:
    lines = ["---"]
    for key, value in state.items():
        lines.append(f"{key}: {json.dumps(value, ensure_ascii=False)}")
    lines.extend(
        [
            "---",
            "",
            "Use the global ralph-controller skill with the configured files.",
            "Read the prompt file once for the run, operate one controlled turn, and end with a valid ralph-controller directive block.",
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    raise ValueError(f"invalid PROGRESS value: {value!r}")


def _extract_directive_block(text: str) -> str:
    start = text.find(START)
    end = text.find(END)
    if start != -1 and end != -1 and end > start:
        return text[start : end + len(END)]

    lines = text.splitlines()
    alt_start = None
    alt_end = None
    for index, line in enumerate(lines):
        if line.strip() == ALTERNATE_DIRECTIVE_START:
            if alt_start is None:
                alt_start = index
            else:
                alt_end = index
                break
    if alt_start is None or alt_end is None or alt_end <= alt_start:
        raise ValueError("directive block not found")
    payload = "\n".join(lines[alt_start + 1 : alt_end]).strip()
    return "\n".join([START, payload, END])


def parse_directive(text: str) -> Directive:
    normalized_text = _extract_directive_block(text)
    start = normalized_text.find(START)
    end = normalized_text.find(END)
    if start == -1 or end == -1 or end <= start:
        raise ValueError("directive block not found")

    payload = normalized_text[start + len(START) : end].strip().splitlines()
    fields: dict[str, str] = {}
    for line in payload:
        if ":" not in line:
            raise ValueError(f"malformed directive line: {line!r}")
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip()

    required = {"STATE", "PROGRESS", "WAKE_AFTER_SECONDS", "NEXT_ACTION"}
    missing = required - fields.keys()
    if missing:
        raise ValueError(f"missing directive fields: {sorted(missing)}")

    state = fields["STATE"]
    if state not in VALID_STATES:
        raise ValueError(f"invalid STATE: {state!r}")

    progress = parse_bool(fields["PROGRESS"])
    wake_after_seconds = int(fields["WAKE_AFTER_SECONDS"])
    if state == "WAIT" and wake_after_seconds <= 0:
        raise ValueError("WAIT requires WAKE_AFTER_SECONDS > 0")
    if state != "WAIT" and wake_after_seconds != 0:
        raise ValueError("non-WAIT states must use WAKE_AFTER_SECONDS = 0")

    next_action = fields["NEXT_ACTION"].strip()
    if not next_action:
        raise ValueError("NEXT_ACTION must be non-empty")

    return Directive(
        state=state,
        progress=progress,
        wake_after_seconds=wake_after_seconds,
        next_action=next_action,
    )


def apply_directive(loop_state: dict[str, Any], directive: Directive) -> dict[str, Any]:
    iteration = int(loop_state.get("iteration", 0)) + 1
    stagnation = int(loop_state.get("stagnation_count", 0))
    if directive.progress:
        stagnation = 0
    else:
        stagnation += 1

    wake_at = None
    if directive.state == "WAIT":
        wake_at = int(time.time()) + directive.wake_after_seconds

    terminal_reason = None
    if directive.state in {"DONE", "HALT"}:
        terminal_reason = directive.next_action

    return {
        **loop_state,
        "iteration": iteration,
        "controller_state": directive.state,
        "stagnation_count": stagnation,
        "last_directive": {
            "STATE": directive.state,
            "PROGRESS": directive.progress,
            "WAKE_AFTER_SECONDS": directive.wake_after_seconds,
            "NEXT_ACTION": directive.next_action,
        },
        "wake_after_seconds": directive.wake_after_seconds,
        "wake_at": wake_at,
        "terminal_reason": terminal_reason,
        "cancelled": False,
    }


def mark_cancelled(loop_state: dict[str, Any], reason: str = "controller cancelled") -> dict[str, Any]:
    return {
        **loop_state,
        "controller_state": "CANCELLED",
        "wake_after_seconds": 0,
        "wake_at": None,
        "terminal_reason": reason,
        "cancelled": True,
    }


def build_resume_prompt(local_state: dict[str, Any]) -> str:
    prompt_file = local_state["prompt_file"]
    state_file = local_state["state_file"]
    loop_state_file = local_state["loop_state_file"]
    return "\n".join(
        [
            "Ralph-controller auto-resume is active. Execute the next controller turn now.",
            "This is not status text. Treat this as the active user instruction for the resumed turn.",
            f"1. Read this file first: {prompt_file}",
            f"2. Read this state file: {state_file}",
            f"3. Read this loop state file: {loop_state_file}",
            "4. Perform exactly one controlled orchestration turn.",
            "5. End your response with a valid ralph-controller directive block.",
            "Do not stop at hook feedback. Do not just restate these instructions. Continue the run.",
        ]
    )


# Hook debug output should stay concise and grep-friendly because the user may
# inspect stderr/logs during live controller verification.


def _extract_session_ids(hook_input: dict[str, Any]) -> list[str]:
    candidates = [hook_input.get("session_id"), hook_input.get("sessionId")]

    session = hook_input.get("session")
    if isinstance(session, dict):
        candidates.extend([session.get("id"), session.get("session_id"), session.get("sessionId")])

    hook_specific_output = hook_input.get("hookSpecificOutput")
    if isinstance(hook_specific_output, dict):
        candidates.extend([hook_specific_output.get("session_id"), hook_specific_output.get("sessionId")])

    normalized: list[str] = []
    for candidate in candidates:
        if candidate is None:
            continue
        text = str(candidate).strip()
        if text and text not in normalized:
            normalized.append(text)
    return normalized


def _read_hook_input(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("stop-hook payload must be a JSON object")
    return parsed


def _extract_completion_promise(text: str) -> str | None:
    start_tag = "<promise>"
    end_tag = "</promise>"
    start = text.find(start_tag)
    end = text.find(end_tag)
    if start == -1 or end == -1 or end <= start:
        return None
    return text[start + len(start_tag) : end].strip()


def _extract_latest_assistant_text_from_transcript(transcript_path: Path) -> str:
    if not transcript_path.exists():
        raise ValueError(f"transcript file not found: {transcript_path}")

    latest_text = ""
    for raw_line in transcript_path.read_text(encoding="utf-8").splitlines():
        if not raw_line.strip():
            continue
        try:
            payload = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        if payload.get("role") != "assistant":
            continue
        message = payload.get("message")
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                latest_text = str(block.get("text") or "")
    return latest_text


def _directive_present(text: str) -> bool:
    try:
        _extract_directive_block(text)
    except ValueError:
        return False
    return True


def evaluate_stop_hook(marker_path: Path, *, hook_input: dict[str, Any]) -> ResumeDecision:
    local_state = read_local_state(marker_path)
    if local_state is None:
        return ResumeDecision(False, "No active ralph-controller session.")

    hook_session_ids = _extract_session_ids(hook_input)
    state_session = str(local_state.get("session_id") or "")
    if state_session and hook_session_ids and state_session not in hook_session_ids:
        return ResumeDecision(False, "Active controller belongs to another session.")

    if not bool(local_state.get("active", False)):
        return ResumeDecision(False, "Controller marker is inactive.")

    if bool(local_state.get("cancelled", False)):
        return ResumeDecision(False, "Controller session has been cancelled.")

    completion_promise = str(local_state.get("completion_promise") or "").strip()
    transcript_path_raw = hook_input.get("transcript_path")
    if completion_promise and transcript_path_raw:
        transcript_path = Path(str(transcript_path_raw))
        if transcript_path.exists():
            latest_text = _extract_latest_assistant_text_from_transcript(transcript_path)
            promise_text = _extract_completion_promise(latest_text)
            if promise_text == completion_promise:
                return ResumeDecision(False, "Completion promise satisfied.")

    loop_state_path = Path(str(local_state["loop_state_file"]))
    loop_state = load_loop_state(loop_state_path)
    if bool(loop_state.get("cancelled", False)) or loop_state.get("controller_state") in TERMINAL_STATES:
        return ResumeDecision(False, "Controller state is terminal.")

    max_iterations = int(local_state.get("max_iterations", 0) or 0)
    iteration = int(local_state.get("iteration", 0) or 0)
    if max_iterations > 0 and iteration >= max_iterations:
        return ResumeDecision(False, f"Max iterations reached ({max_iterations}).")

    next_iteration = iteration + 1
    local_state_updated = {**local_state, "iteration": next_iteration}
    write_local_state(marker_path, local_state_updated)

    system_message = f"🔄 Ralph-controller iteration {next_iteration}"
    return ResumeDecision(
        True,
        "Resume active ralph-controller session.",
        system_message=system_message,
        next_iteration=next_iteration,
        prompt=build_resume_prompt(local_state_updated),
    )


def _handle_stop_hook(marker_path: Path, hook_input_file: Path) -> int:
    try:
        hook_input = _read_hook_input(hook_input_file)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        _debug_reason(f"malformed stop-hook payload: {exc}")
        return 0

    decision = evaluate_stop_hook(marker_path, hook_input=hook_input)
    _debug_reason(f"decision={'resume' if decision.should_resume else 'allow-stop'} reason={decision.reason}")

    transcript_path_raw = hook_input.get("transcript_path")
    if transcript_path_raw:
        transcript_path = Path(str(transcript_path_raw))
        if transcript_path.exists():
            latest_text = _extract_latest_assistant_text_from_transcript(transcript_path)
            if latest_text:
                _debug_reason(
                    "assistant output contains directive block"
                    if _directive_present(latest_text)
                    else "assistant output missing directive block"
                )

    if decision.should_resume:
        print(
            json.dumps(
                {
                    "decision": "block",
                    "reason": decision.prompt,
                    "systemMessage": decision.system_message,
                }
            )
        )
    return 0


def _handle_directive_run(loop_state_path: Path, directive_text: str, sleep_enabled: bool) -> int:
    loop_state = load_loop_state(loop_state_path)
    try:
        directive = parse_directive(directive_text)
        updated = apply_directive(loop_state, directive)
    except Exception as exc:  # pragma: no cover - defensive controller path
        updated = {
            **loop_state,
            "iteration": int(loop_state.get("iteration", 0)) + 1,
            "controller_state": "STALL",
            "stagnation_count": int(loop_state.get("stagnation_count", 0)) + 1,
            "last_directive": None,
            "wake_after_seconds": 0,
            "wake_at": None,
            "terminal_reason": f"directive parse failure: {exc}",
            "cancelled": False,
        }
        save_loop_state(loop_state_path, updated)
        print(json.dumps(updated, indent=2))
        return 1

    save_loop_state(loop_state_path, updated)

    if sleep_enabled and directive.state == "WAIT":
        time.sleep(directive.wake_after_seconds)

    print(json.dumps(updated, indent=2))
    return 0


def _handle_mark_cancelled(loop_state_path: Path, reason: str) -> int:
    loop_state = load_loop_state(loop_state_path)
    updated = mark_cancelled(loop_state, reason)
    save_loop_state(loop_state_path, updated)
    print(json.dumps(updated, indent=2))
    return 0


def _require_loop_state_path(loop_state_file: str | None) -> Path:
    if not loop_state_file:
        raise SystemExit("--loop-state-file is required")
    return Path(loop_state_file)


def _require_hook_input_file(hook_input_file: str | None) -> Path:
    if not hook_input_file:
        raise SystemExit("--hook-input-file is required with --stop-hook")
    return Path(hook_input_file)


def _require_directive_file(directive_file: str | None) -> Path:
    if not directive_file:
        raise SystemExit("--directive-file is required unless using --mark-cancelled or --stop-hook")
    return Path(directive_file)


def _handle_main(args: argparse.Namespace) -> int:
    if args.stop_hook:
        return _handle_stop_hook(Path(args.marker_file), _require_hook_input_file(args.hook_input_file))

    loop_state_path = _require_loop_state_path(args.loop_state_file)

    if args.mark_cancelled:
        return _handle_mark_cancelled(loop_state_path, args.reason)

    directive_path = _require_directive_file(args.directive_file)
    directive_text = directive_path.read_text(encoding="utf-8")
    return _handle_directive_run(loop_state_path, directive_text, args.sleep)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directive-file")
    parser.add_argument("--loop-state-file")
    parser.add_argument("--sleep", action="store_true")
    parser.add_argument("--mark-cancelled", action="store_true")
    parser.add_argument("--reason", default="controller cancelled")
    parser.add_argument("--stop-hook", action="store_true")
    parser.add_argument("--marker-file", default=MARKER_PATH)
    parser.add_argument("--hook-input-file")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return _handle_main(args)


if __name__ == "__main__":
    raise SystemExit(main())
