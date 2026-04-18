#!/usr/bin/env python3
from __future__ import annotations

import os
import shlex
import subprocess
import sys
from pathlib import Path


def _load_raw_args(argv: list[str]) -> str:
    if len(argv) == 2:
        return argv[1]
    if len(argv) > 2:
        return " ".join(shlex.quote(arg) for arg in argv[1:])
    return os.environ.get("ARGUMENTS", "")


def _strip_unquoted_newlines(raw_args: str) -> str:
    pieces: list[str] = []
    quote: str | None = None
    escape_next = False

    for char in raw_args.replace("\x00", " "):
        if escape_next:
            pieces.append(char)
            escape_next = False
            continue
        if char == "\\":
            pieces.append(char)
            escape_next = True
            continue
        if char in {"\"", "'"}:
            if quote is None:
                quote = char
            elif quote == char:
                quote = None
            pieces.append(char)
            continue
        if char in {"\n", "\r", "\t"} and quote is None:
            pieces.append(" ")
            continue
        pieces.append(char)

    return "".join(pieces)


def _normalize_raw_args(raw_args: str) -> list[str]:
    sanitized = _strip_unquoted_newlines(raw_args)
    if not sanitized.strip():
        raise SystemExit("No /ralph-controller arguments provided.")
    return shlex.split(sanitized)


def _resolve_session_id() -> str:
    return (
        os.environ.get("CLAUDE_SESSION_ID", "").strip()
        or os.environ.get("CLAUDE_CODE_SESSION_ID", "").strip()
    )


def main(argv: list[str]) -> int:
    if len(argv) > 2:
        parsed_args = argv[1:]
    else:
        raw_args = _load_raw_args(argv)
        parsed_args = _normalize_raw_args(raw_args)
    setup_script = Path(__file__).with_name("setup-ralph-controller.sh")
    session_id = _resolve_session_id()
    command = [str(setup_script), *parsed_args]
    if session_id:
        command.extend(["--session-id", session_id])
    completed = subprocess.run(command, check=False)
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
