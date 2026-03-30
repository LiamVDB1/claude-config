# Hybrid Router — Implementation Plan

Architecture: `ANTHROPIC_UNIX_SOCKET` + Node.js socket server + `ANTHROPIC_CUSTOM_MODEL_OPTION`

---

## Files to create

```
~/.claude/hybrid/
├── socket-server.js      NEW — the routing server (plain HTTP over Unix socket)
└── claude-hybrid         NEW — launcher that wires everything together
```

`~/.claude/litellm.env` is read directly by the socket server — no separate key helper
script needed.

---

## Phase 1 — `socket-server.js`

Single Node.js file. No dependencies beyond stdlib (`http`, `https`, `fs`, `net`).
Reads config from env vars set by the launcher.

### Env vars consumed

```
ANTHROPIC_UNIX_SOCKET          path to listen on  (set by launcher)
HYBRID_LITELLM_BASE_URL        e.g. http://localhost:4000
```

Token is read directly from `~/.claude/litellm.env` (sourced inline, not via a helper
script). Expected key name: `LITELLM_API_KEY`.

### Routing logic

```
POST /v1/messages
  parse body → read model field
  model == "" or matches NATIVE_PATTERNS → forward to api.anthropic.com (all headers unchanged)
  model starts with "litellm/"           → strip prefix, swap auth, forward to LiteLLM
  anything else                          → 400 with clear error message

all other paths (GET /v1/models, etc.)
  → forward to api.anthropic.com unchanged
```

### NATIVE_PATTERNS (matches what Claude Code sends for built-in models)

```
/^claude-/i
/^anthropic\.claude-/i
/^claude$/i         (model field may be empty or "claude" in some internal calls)
```

### Native forwarding

- Destination: `https://api.anthropic.com` + original path
- Headers: all original headers forwarded as-is, only `host` rewritten to `api.anthropic.com`
- Body: forwarded as raw bytes (no parsing, no modification)
- Response: piped directly back (handles SSE streaming correctly)
- `content-length` recalculated only if body was modified (native path: unchanged)

### LiteLLM forwarding

- Destination: `HYBRID_LITELLM_BASE_URL` + `/v1/messages`
- Body: JSON re-serialised with model prefix stripped (`litellm/gpt-4o` → `gpt-4o`)
- Headers stripped: `authorization`, `x-api-key`, `anthropic-api-key`
- Headers added: `authorization: Bearer <token>`, `x-api-key: <token>`
- `host` rewritten to LiteLLM hostname
- `content-length` recalculated (body changed)
- Response: piped directly back

### Token loading

On startup, socket server reads `~/.claude/litellm.env`, parses `LITELLM_API_KEY`,
and holds it in memory. If the file is missing or the key is empty, the server starts
but logs a warning — native Claude still works; only LiteLLM routes fail.

Token is re-read from the file if a LiteLLM request returns 401, allowing key rotation
without restarting the server.

### Logging (to stderr + log file)

```
STARTED  | socket=... litellm=...
NATIVE   | model=claude-sonnet-4-6 | path=/v1/messages
REROUTE  | model=litellm/gpt-4o -> gpt-4o -> http://localhost:4000/v1/messages
PASSTHRU | path=/v1/models
REJECT   | model=unknown-thing | reason=no litellm/ prefix
ERROR    | upstream api.anthropic.com: <message>
```

Authorization header is NEVER logged.

### Error handling

- Upstream connection error: return 502 with JSON error body
- Body parse failure on /v1/messages: forward to Anthropic as-is (safe fallback)
- LiteLLM down: return 503 with JSON error body; native models unaffected
- Unknown model: return 400 immediately

### Shutdown

On SIGTERM/SIGINT: close server, delete socket file, exit 0.

---

## Phase 2 — `claude-hybrid` launcher

```bash
#!/bin/bash
set -euo pipefail

# Session-scoped socket path — unique per PID, cleaned up on exit
SOCKET_PATH="${TMPDIR:-/tmp}/claude-hybrid-$$.sock"

export ANTHROPIC_UNIX_SOCKET="$SOCKET_PATH"
export HYBRID_LITELLM_BASE_URL="${HYBRID_LITELLM_BASE_URL:-http://localhost:4000}"
# token is read by socket-server.js directly from ~/.claude/litellm.env

# /model picker entry
export ANTHROPIC_CUSTOM_MODEL_OPTION="litellm/gpt-4o"
export ANTHROPIC_CUSTOM_MODEL_OPTION_NAME="GPT-4o via LiteLLM"
export ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION="Routed through local hybrid router"

cleanup() {
  kill "$SOCKET_PID" 2>/dev/null || true
  rm -f "$SOCKET_PATH"
}
trap cleanup EXIT INT TERM

# Start socket server
node "$HOME/.claude/hybrid/socket-server.js" &
SOCKET_PID=$!

# Wait until socket file appears (server is ready)
for i in $(seq 1 20); do
  [[ -S "$SOCKET_PATH" ]] && break
  sleep 0.1
done
if [[ ! -S "$SOCKET_PATH" ]]; then
  echo "ERROR: socket server did not start" >&2
  exit 1
fi

claude "$@"
```

Note: no `exec` before `claude` — the shell must stay alive to run the trap on exit.

---

## Phase 3 — Acceptance test matrix

After implementation, manually verify before daily use:

| Test | Expected | How to check |
|---|---|---|
| Default model → send message | Succeeds, logs `NATIVE` | `tail -f hybrid/router.log` |
| `/model` Opus → send message | Succeeds, logs `NATIVE` | same |
| `/model` Sonnet → send message | Succeeds, logs `NATIVE` | same |
| `/model` GPT-4o via LiteLLM → send message | Succeeds, logs `REROUTE` | same |
| Stop LiteLLM, send native Claude message | Succeeds (unaffected) | LiteLLM process killed |
| Stop LiteLLM, send LiteLLM model message | Fails with clear error | should not hang |
| Check LiteLLM request logs | No `Authorization: Bearer` from Anthropic | LiteLLM logs |
| Claude Code status | Shows subscription usage | `/status` in Claude Code |

---

## What is NOT in scope

- Multiple LiteLLM model options (one custom entry only; more can be added later)
- ANTHROPIC_BASE_URL fallback (unix socket is the chosen path)
- MCP or plugin routing (only /v1/messages is intercepted)
- Automatic re-probe on upgrade (manual step per SECURITY.md)
