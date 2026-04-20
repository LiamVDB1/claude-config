#!/usr/bin/env bash
# View recent bash-auto-approve decisions.
# Usage:
#   view-auto-approve-log.sh              # last 20 entries
#   view-auto-approve-log.sh 50           # last 50 entries
#   view-auto-approve-log.sh blocks       # only blocked commands
#   view-auto-approve-log.sh follow       # live tail
set -euo pipefail

LOG="$HOME/.claude/hooks/lib/.cache/bash-auto-approve.log"
[ -f "$LOG" ] || { echo "no log yet at $LOG"; exit 0; }

if [ -t 1 ]; then
  COLS=$(tput cols 2>/dev/null || echo 100)
  USE_COLOR=1
else
  COLS=100
  USE_COLOR=0
fi
WRAP=$((COLS - 4))
[ "$WRAP" -lt 40 ] && WRAP=40

PRETTY='
import json, sys, textwrap

wrap = int(sys.argv[1])
use_color = sys.argv[2] == "1"

R = "\033[0m" if use_color else ""
BOLD = "\033[1m" if use_color else ""
DIM = "\033[2m" if use_color else ""
GREEN = "\033[32m" if use_color else ""
RED = "\033[31m" if use_color else ""
YELLOW = "\033[33m" if use_color else ""
CYAN = "\033[36m" if use_color else ""
GRAY = "\033[90m" if use_color else ""

SEP = GRAY + ("-" * min(wrap + 4, 100)) + R

def label(dec):
    if dec == "allow": return GREEN + "OK  ALLOW" + R
    if dec == "block": return RED + "NO  BLOCK" + R
    if dec == "fallthrough": return YELLOW + "??  PROMPT" + R
    return DIM + "--  " + dec.upper() + R

def wrap_indent(text, indent="    "):
    if not text: return ""
    out = []
    for line in text.split("\n"):
        if not line:
            out.append("")
            continue
        ws = textwrap.wrap(line, width=wrap,
            initial_indent=indent, subsequent_indent=indent,
            break_long_words=False, break_on_hyphens=False) or [indent]
        out.extend(ws)
    return "\n".join(out)

first = True
for raw in sys.stdin:
    raw = raw.strip()
    if not raw: continue
    try:
        r = json.loads(raw)
    except json.JSONDecodeError:
        continue

    ts = (r.get("t") or "")[11:19]
    ms = r.get("ms")
    decision = r.get("decision") or r.get("stage") or "unknown"
    cmd = (r.get("cmd") or "-").replace("\\n", "\n")
    reasoning = r.get("reasoning")
    mode = r.get("mode")

    if not first: print(SEP)
    first = False

    bits = [DIM + ts + R, label(decision)]
    if ms is not None: bits.append(DIM + str(ms) + "ms" + R)
    if mode: bits.append(CYAN + "mode=" + mode + R)
    attempts = r.get("attempts")
    timeouts = r.get("timeouts")
    if attempts and attempts > 1:
        bits.append(YELLOW + "attempts=" + str(attempts) + R)
    if timeouts:
        bits.append(YELLOW + "timeouts=" + str(timeouts) + R)
    print("  " + "  ".join(bits))

    print(BOLD + "  cmd:" + R)
    print(wrap_indent(cmd))
    if reasoning:
        print(BOLD + "  why:" + R)
        print(wrap_indent(reasoning))
'

pretty() { python3 -c "$PRETTY" "$WRAP" "$USE_COLOR"; }

case "${1:-}" in
  follow)
    tail -n 0 -f "$LOG" | pretty
    ;;
  blocks)
    grep '"decision":"block"' "$LOG" | tail -n 50 | pretty
    ;;
  ''|[0-9]*)
    tail -n "${1:-20}" "$LOG" | pretty
    ;;
  *)
    echo "usage: $0 [N | blocks | follow]"
    exit 1
    ;;
esac
