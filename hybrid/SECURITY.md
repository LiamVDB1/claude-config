# Hybrid Router — Security Considerations

The Unix socket approach puts a locally-controlled process in the path of ALL Claude
Code API traffic, including the live OAuth bearer token for your subscription login.
This section documents the minimum security bar for the implementation.

---

## 1. Socket File Permissions

The socket file must not be world-readable. Create it in a private directory and set
strict permissions:

```bash
# Socket path should be session-scoped and in a private location
SOCKET_PATH="/tmp/claude-hybrid-$(id -u)-$$.sock"

# Or under ~/.claude/hybrid/run/ with 700 permissions on the directory
mkdir -p ~/.claude/hybrid/run
chmod 700 ~/.claude/hybrid/run
SOCKET_PATH="$HOME/.claude/hybrid/run/claude-$$.sock"
```

Any process that can connect to the socket receives a valid channel to intercept API
traffic. The socket must be owned by the current user and mode `600` or in a `700`
directory.

---

## 2. Never Log Authorization Headers

The socket server MUST NOT log the `Authorization` header or any part of it.

```js
// WRONG — logs the bearer token
log(`headers=${JSON.stringify(req.headers)}`);

// RIGHT — log only routing decision
log(`NATIVE | model=${model} | path=${req.url}`);
log(`REROUTE | model=${model} -> ${upstreamModel}`);
```

The bearer token grants full access to the Anthropic account associated with the
subscription. It must never appear in log files.

---

## 3. Never Forward Claude Auth Headers to LiteLLM

When rerouting a `litellm/*` request, strip all Anthropic credentials before
forwarding to LiteLLM:

```js
// Headers to strip before sending to LiteLLM:
delete headers['authorization'];
delete headers['x-api-key'];
delete headers['anthropic-api-key'];
delete headers['anthropic-version'];  // optional but clean

// Add LiteLLM auth:
headers['authorization'] = `Bearer ${litellmToken}`;
headers['x-api-key'] = litellmToken;
```

Sending an Anthropic OAuth token to a third-party endpoint (even localhost LiteLLM)
is a credential leak risk in case LiteLLM logs requests or forwards headers upstream.

---

## 4. Socket Cleanup on Exit

The socket file must be deleted when the session ends. A lingering socket from a
crashed session can be reconnected to by a new process (which would fail, but could
also be maliciously created to impersonate the server).

```bash
# In the launcher:
trap "kill $SOCKET_PID 2>/dev/null; rm -f $SOCKET_PATH" EXIT INT TERM
```

The socket server should also delete the socket on SIGTERM/SIGINT:

```js
process.on('SIGTERM', () => { server.close(); fs.unlinkSync(SOCKET_PATH); process.exit(0); });
process.on('SIGINT',  () => { server.close(); fs.unlinkSync(SOCKET_PATH); process.exit(0); });
```

---

## 5. LiteLLM Token Storage

The LiteLLM bearer token is read by `~/.claude/scripts/get-litellm-key.sh`. That
script must be:

```bash
chmod 700 ~/.claude/scripts/get-litellm-key.sh
```

Do not hardcode the token in the script if avoidable — prefer reading from a secrets
manager, keychain, or environment file with restricted permissions:

```bash
#!/bin/bash
# Option A: read from a 600-permission env file
source ~/.claude/litellm.env
echo -n "$LITELLM_API_KEY"

# Option B: macOS keychain
security find-generic-password -a litellm -s litellm-api-key -w 2>/dev/null
```

---

## 6. Version Pinning and Re-probing

`ANTHROPIC_UNIX_SOCKET` is an internal seam, not a public API contract. On every
Claude Code version bump:

1. **Check the binary still contains the env var:**
   ```bash
   strings $(which claude | xargs readlink -f) | grep ANTHROPIC_UNIX_SOCKET
   ```

2. **Re-run the probe** to confirm `globalThis.fetch` is still patched (or not — this
   confirms the Bun architecture hasn't changed to something else):
   ```bash
   rm -f ~/.claude/hybrid/probe.log
   ~/.claude/hybrid/claude-probe
   # send one message, then:
   cat ~/.claude/hybrid/probe.log
   ```

3. **Check for any new relevant env vars:**
   ```bash
   strings $(which claude | xargs readlink -f) 2>/dev/null | grep "^ANTHROPIC_[A-Z_]*$" | sort
   ```

4. **Test the acceptance matrix** after any upgrade before relying on hybrid routing:
   - Native Claude model request succeeds
   - `litellm/*` model request routes to LiteLLM
   - LiteLLM-down does not break native Claude in the same session
   - No Anthropic auth header reaches LiteLLM (check LiteLLM request logs)
   - `/status` shows subscription usage, not API key billing

---

## 7. Isolation Scope

The hybrid launcher sets:
- `ANTHROPIC_UNIX_SOCKET` — scoped to the launched process only
- `ANTHROPIC_CUSTOM_MODEL_OPTION*` — scoped to the launched process only

It does NOT modify:
- `~/.claude/settings.json`
- Any global env vars in the parent shell
- Any other Claude Code session

Isolation holds as long as the launcher uses `exec claude` (or a subshell that inherits
only the launcher's env) and does not write to global config files.

---

## 8. Threat Model Summary

| Threat | Mitigation |
|---|---|
| Other local processes intercept socket | 700 directory + session-scoped path |
| Bearer token appears in logs | Never log `Authorization` header |
| Claude token forwarded to LiteLLM | Explicit header stripping before reroute |
| Stale socket from crashed session | trap + cleanup on exit |
| API breaks on Claude Code upgrade | Re-probe on every version bump |
| LiteLLM key exposure | 700 script, keychain storage preferred |
