# Claude Code Hybrid Routing — Reverse Engineering Findings

Claude Code version at time of research: **2.1.87**
Binary path: `/Users/liamvdb/.local/share/claude/versions/2.1.87`
Research date: 2026-03-30

---

## 1. Binary Architecture

```
/Users/liamvdb/.local/bin/claude
  → symlink → /Users/liamvdb/.local/share/claude/versions/2.1.87
               Mach-O 64-bit executable arm64  (Bun-compiled)
```

Claude Code is compiled with **Bun**, not Node.js. The entire TypeScript source is
bundled by Bun's bundler and embedded into a native ARM64 executable. Bun ships its
own JS runtime, its own HTTP/TLS stack (BoringSSL), and its own `fetch`
implementation — all self-contained inside the binary.

---

## 2. Why Every Preload/Patch Approach Fails

| Approach | Outcome | Root cause |
|---|---|---|
| `NODE_OPTIONS --require probe.js` | Loaded in two Node.js child processes, but NOT in the main Bun process | NODE_OPTIONS only affects `/usr/bin/node` children |
| Patch `globalThis.fetch` | Log file never written for API calls | Bun's fetch holds a closed-over internal reference; patching `globalThis` is invisible to it |
| Patch `require('undici')` | Irrelevant | Bun does not use undici |
| Patch `require('tls').connect` | Same as above | Only affects spawned Node.js children |
| `DYLD_INSERT_LIBRARIES` dylib | Would reach TLS socket level but requires intercepting BoringSSL internals | Impractical |

### The two Node.js PIDs observed

When running `claude-probe`, the probe log showed two `PROBE LOADED` entries within
~1 second of each other. These are **spawned child processes** (likely MCP servers,
plugins, or shell integration tools). They are NOT the processes making Anthropic API
calls. The main Bun process makes all API calls and is unreachable by Node.js tooling.

### Probe diagnostic artifact

`hybrid/probe.js` — contains an unconditional startup marker and a `globalThis.fetch`
patch. Useful for re-validating on future Claude Code upgrades.

---

## 3. Full Env Var Surface Area

Extracted directly from the binary via `strings`. All of these are read by the Bun
runtime from `process.env` at startup or on first use.

### Routing / endpoint

```
ANTHROPIC_BASE_URL                  redirect all API calls to a custom HTTP/HTTPS base URL
ANTHROPIC_UNIX_SOCKET               redirect all API calls through a Unix domain socket
ANTHROPIC_BEDROCK_BASE_URL          AWS Bedrock endpoint
ANTHROPIC_VERTEX_BASE_URL           Google Vertex endpoint
ANTHROPIC_FOUNDRY_BASE_URL          Foundry endpoint
HTTPS_PROXY / https_proxy           HTTP CONNECT proxy (requires MITM cert for TLS)
HTTP_PROXY  / http_proxy            same for HTTP traffic
```

### Auth

```
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
CLAUDE_CODE_OAUTH_TOKEN             pass OAuth token directly via env (skips keychain read)
CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
ANTHROPIC_FOUNDRY_API_KEY
```

### Model overrides (IDs only — do NOT change endpoint)

```
ANTHROPIC_DEFAULT_HAIKU_MODEL[_NAME|_DESCRIPTION|_SUPPORTED_CAPABILITIES]
ANTHROPIC_DEFAULT_SONNET_MODEL[_NAME|_DESCRIPTION|_SUPPORTED_CAPABILITIES]
ANTHROPIC_DEFAULT_OPUS_MODEL[_NAME|_DESCRIPTION|_SUPPORTED_CAPABILITIES]
ANTHROPIC_SMALL_FAST_MODEL
ANTHROPIC_MODEL
```

### Custom model picker entry

```
ANTHROPIC_CUSTOM_MODEL_OPTION             model ID string injected into /model picker
ANTHROPIC_CUSTOM_MODEL_OPTION_NAME        display label
ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION description shown in picker
```

### Other

```
ANTHROPIC_BETAS
ANTHROPIC_CUSTOM_HEADERS
```

---

## 4. Key Mechanism Details

### 4.1 `ANTHROPIC_CUSTOM_MODEL_OPTION` — adds to picker, does NOT route

Extracted source:
```js
function TwH(H=!1){
  let _=Ol1(H);
  let q=process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
  if(q && !_.some((T)=>T.value===q))
    _.push({
      value: q,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? q,
      description: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ?? `Custom model (${q})`
    });
```

When selected in `/model`, this sends the raw `value` string verbatim as `model` in
the API request body. Model validation is explicitly bypassed:
```js
if(_===process.env.ANTHROPIC_CUSTOM_MODEL_OPTION) return {valid:!0};
```

**Critical:** this only changes the `model` field. The request still goes to whatever
endpoint is configured (`ANTHROPIC_BASE_URL` or `api.anthropic.com`). Setting
`ANTHROPIC_CUSTOM_MODEL_OPTION=litellm/gpt-4o` alone sends `model: "litellm/gpt-4o"`
to Anthropic's API, which returns a 400.

### 4.2 `ANTHROPIC_DEFAULT_*_MODEL` — same limitation

Changes the model ID string for each built-in tier. Does not change the destination
server. Useful only for Bedrock/Vertex model ID aliasing.

### 4.3 `ANTHROPIC_BASE_URL` — TCP redirect

Redirects all API traffic to a custom base URL. For `http://localhost:PORT`, Claude
Code speaks plain HTTP. For `https://`, it handles TLS on the outgoing connection.

Limitation: one base URL for all models. Cannot route different models to different
endpoints without a server listening at that URL that does the per-model routing.

### 4.4 `ANTHROPIC_UNIX_SOCKET` — the purpose-built integration point

This is the key finding. Extracted source:

**Fetch option builder** — routes ALL Anthropic API fetches to the socket:
```js
function s1H(H){
  let _=zF8?{keepalive:!1}:{};
  if(H?.forAnthropicAPI){
    let $=process.env.ANTHROPIC_UNIX_SOCKET;
    if($&&typeof Bun<"u") return {..._, unix: $}  // Bun native unix: fetch option
  }
  let q=kS();
  if(q){ if(typeof Bun<"u") return {..._, proxy: q, ...  // fallback: HTTPS_PROXY
```

**Login/auth validation bypass** — no login prompt, no keychain required:
```js
async function rl(){
  if(process.env.ANTHROPIC_UNIX_SOCKET) return {valid:!0};
```

**Subscription auth check:**
```js
function RD(){
  if(process.env.ANTHROPIC_UNIX_SOCKET) return !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
```

**Child process env sanitization** — strips all sensitive vars before passing env to
child processes:
```js
function B2K(H){
  if(!H||!process.env.ANTHROPIC_UNIX_SOCKET) return H||{};
  let{ANTHROPIC_UNIX_SOCKET:_,ANTHROPIC_BASE_URL:q,ANTHROPIC_API_KEY:$,
      ANTHROPIC_AUTH_TOKEN:K,CLAUDE_CODE_OAUTH_TOKEN:O,...T}=H;
  return T
}
```

**What the socket server receives (plain HTTP, no TLS):**

When Bun uses `fetch(url, {unix: '/path/to.sock'})`, it sends a plain HTTP request
over the socket — no TLS, even though the SDK URL is `https://api.anthropic.com`.
The socket server receives the full, unmodified request:

```
POST /v1/messages HTTP/1.1
Host: api.anthropic.com
Authorization: Bearer <oauth_token>
anthropic-version: 2023-06-01
content-type: application/json
...
{"model":"claude-sonnet-4-6","messages":[...]}
```

The `Authorization` header contains the live OAuth bearer token from the credential
resolution chain (keychain or `CLAUDE_CODE_OAUTH_TOKEN`). The socket server can:
- For `claude-*` models: forward to `https://api.anthropic.com` with all headers
  unchanged — native request is byte-for-byte identical to what Anthropic expects
- For `litellm/*` models: strip Anthropic auth, add LiteLLM key, forward to LiteLLM

**Design intent:** This is the enterprise managed deployment path. The `{unix: path}`
branch in `s1H`, the `rl()` bypass, and the `B2K` child sanitizer are clearly
purpose-built for this pattern. Note: it is not publicly documented as a stable API.

---

## 5. Hardcoded Model Registry (extracted from binary)

```js
haiku35:  { firstParty: "claude-3-5-haiku-20241022",          bedrock: "us.anthropic.claude-3-5-haiku-20241022-v1:0",          vertex: "claude-3-5-haiku@20241022" }
haiku45:  { firstParty: "claude-haiku-4-5-20251001",          bedrock: "us.anthropic.claude-haiku-4-5-20251001-v1:0",          vertex: "claude-haiku-4-5@20251001" }
sonnet35: { firstParty: "claude-3-5-sonnet-20241022",         bedrock: "anthropic.claude-3-5-sonnet-20241022-v2:0",            vertex: "claude-3-5-sonnet-v2@20241022" }
sonnet37: { firstParty: "claude-3-7-sonnet-20250219",         bedrock: "us.anthropic.claude-3-7-sonnet-20250219-v1:0",         vertex: "claude-3-7-sonnet@20250219" }
sonnet40: { firstParty: "claude-sonnet-4-20250514",           bedrock: "us.anthropic.claude-sonnet-4-20250514-v1:0",           vertex: "claude-sonnet-4@20250514" }
sonnet45: { firstParty: "claude-sonnet-4-5-20250929",         bedrock: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",         vertex: "claude-sonnet-4-5@20250929" }
sonnet46: { firstParty: "claude-sonnet-4-6",                  bedrock: "us.anthropic.claude-sonnet-4-6",                       vertex: "claude-sonnet-4-6" }
opus40:   { firstParty: "claude-opus-4-20250514",             bedrock: "us.anthropic.claude-opus-4-20250514-v1:0",             vertex: "claude-opus-4@20250514" }
opus41:   { firstParty: "claude-opus-4-1-20250805",           bedrock: "us.anthropic.claude-opus-4-1-20250805-v1:0",           vertex: "claude-opus-4-1@20250805" }
opus45:   { firstParty: "claude-opus-4-5-20251101",           bedrock: "us.anthropic.claude-opus-4-5-20251101-v1:0",           vertex: "claude-opus-4-5@20251101" }
opus46:   { firstParty: "claude-opus-4-6",                    bedrock: "us.anthropic.claude-opus-4-6-v1",                      vertex: "claude-opus-4-6" }
```

---

## 6. Stability Assessment

`ANTHROPIC_UNIX_SOCKET` is a purpose-built internal seam — not a publicly documented
stable contract. It functions as an enterprise integration point and has been in the
binary across tested versions. However:

- It could be removed or behavior-changed in any Claude Code update without notice
- The `rl()` bypass and `B2K` sanitization patterns depend on this feature being
  intentional (they appear to be, but are not officially guaranteed)
- **Must be re-probed on every Claude Code version bump** (see SECURITY.md)

The approach is technically sound and uses the right abstraction layer.
Treat it as "excellent engineering path, not an officially promised API."
