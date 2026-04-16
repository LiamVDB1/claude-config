---
description: Cancel active ralph-controller session
allowed-tools: ["Bash(test -f .claude/ralph-controller.local.md:*)", "Bash(~/.claude/skills/ralph-controller/cancel-ralph-controller.sh)", "Read(.claude/ralph-controller.local.md)"]
hide-from-slash-command-tool: "true"
---

# Cancel Ralph Controller

Cancel the active ralph-controller run by invoking the global cancel script.

1. Check whether `.claude/ralph-controller.local.md` exists.
2. If it does not, say there is no active ralph-controller session.
3. If it does, read the file for the current iteration and then run:

```!
~/.claude/skills/ralph-controller/cancel-ralph-controller.sh
```

This marks the local controller session and loop state as cancelled so the Stop hook will not resume the run on the next stop.
