'use strict';

/**
 * PreToolUse hook for Bash — auto-approves safe actions using an LLM
 * classifier that mirrors Claude Code's auto-mode ruleset, routed through
 * the user's LiteLLM endpoint (gpt-5.4-mini).
 *
 * Fail-closed: any error, timeout, or non-"no" verdict produces empty
 * stdout, which falls through to Claude Code's normal permission flow.
 *
 * Output protocol: hookSpecificOutput.permissionDecision = "allow".
 * See https://code.claude.com/docs/en/hooks.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');

const LIB_DIR = path.join(__dirname, 'lib');
const BASE_TEMPLATE_PATH = path.join(LIB_DIR, 'auto-mode-template.txt');
const PERMS_TEMPLATE_PATH = path.join(LIB_DIR, 'auto-mode-perms-template.txt');
const CACHE_PATH = path.join(LIB_DIR, '.cache', 'auto-mode-defaults.json');

const CACHE_TTL_MS = 10 * 60 * 1000;
const LLM_TIMEOUT_MS = 2500;
const MAX_TRANSCRIPT_ENTRIES = 20;
const MODEL = 'gpt-5.4-mini';

// Only skip the classifier when Claude will never prompt anyway.
// `bypassPermissions` approves every tool call unconditionally; the LLM is
// pure waste there. `plan` and `acceptEdits` still prompt for Bash, so the
// classifier must run in those modes.
const SKIP_PERMISSION_MODES = new Set(['bypassPermissions']);

const SETTINGS_FILES = [
  path.join(os.homedir(), '.claude', 'settings.json'),
  path.join(os.homedir(), '.claude', 'settings.local.json')
];

// ------------------------------------------------------------------
// Allowlist pre-check — skip LLM when Claude Code wouldn't prompt anyway
// ------------------------------------------------------------------
let allowlistCache = { mtime: 0, patterns: null };

function loadBashAllowlist() {
  // Aggregate `Bash(...)` rules from ~/.claude/settings.json and
  // settings.local.json. Re-read when either file's mtime changes.
  let latestMtime = 0;
  const sources = [];
  for (const file of SETTINGS_FILES) {
    try {
      const stat = fs.statSync(file);
      latestMtime = Math.max(latestMtime, stat.mtimeMs);
      sources.push(file);
    } catch {
      // missing file is fine
    }
  }
  if (allowlistCache.patterns && latestMtime === allowlistCache.mtime) {
    return allowlistCache.patterns;
  }

  const patterns = [];
  for (const file of sources) {
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      const allow = obj && obj.permissions && Array.isArray(obj.permissions.allow)
        ? obj.permissions.allow
        : [];
      for (const rule of allow) {
        if (typeof rule !== 'string') continue;
        const m = rule.match(/^Bash\((.+)\)$/);
        if (!m) continue;
        patterns.push(m[1]);
      }
    } catch {
      // malformed settings file — ignore
    }
  }
  allowlistCache = { mtime: latestMtime, patterns };
  return patterns;
}

function bashPatternToRegex(pattern) {
  // Claude Code Bash rules are glob-ish. `*` matches any run of characters.
  // A pattern ending in `*` is treated as a prefix rule (common case:
  // `Bash(git status *)` should match `git status` and `git status --short`),
  // so we drop the trailing `*` along with any immediately preceding
  // whitespace and skip the end-anchor. Patterns without a trailing `*`
  // must match the whole command.
  let body = pattern;
  let anchorEnd = true;
  const trail = body.match(/\s*\*$/);
  if (trail) {
    body = body.slice(0, -trail[0].length);
    anchorEnd = false;
  }
  let re = '';
  for (const ch of body) {
    if (ch === '*') re += '.*';
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + (anchorEnd ? '$' : '(\\s.*|$)'));
}

// Shell metacharacters that split a command into multiple segments. If any
// are present, Claude Code's allowlist matcher will NOT auto-approve based
// on a single-command rule like `Bash(ls *)`, so we must not short-circuit
// and must let the LLM classify the full pipeline.
const COMPOUND_RE = /[|;&<>`\n]|\$\(/;

function commandMatchesAllowlist(cmd) {
  if (COMPOUND_RE.test(cmd)) return false;
  const patterns = loadBashAllowlist();
  for (const p of patterns) {
    try {
      if (bashPatternToRegex(p).test(cmd)) return true;
    } catch {
      // skip unparseable pattern
    }
  }
  return false;
}

// ------------------------------------------------------------------
// Output helpers
// ------------------------------------------------------------------
function allow(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason
    }
  });
}

function passthrough() {
  return '';
}

// ------------------------------------------------------------------
// Template load (synchronous, file-backed; process is fresh per call)
// ------------------------------------------------------------------
function loadTemplates() {
  const base = fs.readFileSync(BASE_TEMPLATE_PATH, 'utf8');
  const perms = fs.readFileSync(PERMS_TEMPLATE_PATH, 'utf8');
  return { base, perms };
}

// ------------------------------------------------------------------
// Auto-mode defaults (10-min filesystem cache)
// ------------------------------------------------------------------
function loadDefaults() {
  try {
    const stat = fs.statSync(CACHE_PATH);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    }
  } catch {
    // cache miss
  }

  const raw = execFileSync('claude', ['auto-mode', 'defaults'], {
    encoding: 'utf8',
    timeout: 5000
  });
  const parsed = JSON.parse(raw);

  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, raw);
  } catch {
    // cache write failure is non-fatal
  }

  return parsed;
}

// ------------------------------------------------------------------
// System prompt assembly
// ------------------------------------------------------------------
function bulletList(items) {
  return items.map(s => `- ${s}`).join('\n');
}

function buildPermissionsSection(defaults, perms) {
  return perms
    .replace(
      /<user_environment_to_replace>[\s\S]*?<\/user_environment_to_replace>/,
      bulletList(defaults.environment || [])
    )
    .replace(
      /<user_deny_rules_to_replace>[\s\S]*?<\/user_deny_rules_to_replace>/,
      bulletList(defaults.soft_deny || [])
    )
    .replace(
      /<user_allow_rules_to_replace>[\s\S]*?<\/user_allow_rules_to_replace>/,
      bulletList(defaults.allow || [])
    );
}

function applyXmlRewrite(prompt) {
  // Claude Code's tl1() swap: replace the tool-call closer with XML
  // output instructions so gpt-5.4-mini can respond with <block>yes|no</block>.
  const xmlInstructions = [
    'Respond with XML in this exact format — nothing else, no prose, no markdown:',
    '<reasoning>one short sentence</reasoning>',
    '<block>yes</block>',
    'or',
    '<block>no</block>',
    '',
    'Emit <block>no</block> when the action is ALLOWED (preliminary ALLOW with no user-boundary override, or preliminary BLOCK overridden by explicit user authorization).',
    'Emit <block>yes</block> when the action is BLOCKED.',
    'Stop immediately after </block>.'
  ].join('\n');

  return prompt.replace(
    'Use the classify_result tool to report your classification.',
    xmlInstructions
  );
}

function buildSystemPrompt(defaults, templates) {
  const permsSection = buildPermissionsSection(defaults, templates.perms);
  const combined = templates.base.replace('<permissions_template>', permsSection);
  return applyXmlRewrite(combined);
}

// ------------------------------------------------------------------
// Transcript digest — last N non-system entries
// ------------------------------------------------------------------
function summarizeToolUse(tu) {
  const name = tu.name || 'unknown';
  const inp = tu.input || {};
  if (name === 'Bash') {
    return `Bash: ${(inp.command || '').slice(0, 400)}`;
  }
  if (name === 'Edit' || name === 'Write') {
    return `${name}: ${inp.file_path || ''}`;
  }
  if (name === 'Read') {
    return `Read: ${inp.file_path || ''}`;
  }
  try {
    return `${name}: ${JSON.stringify(inp).slice(0, 400)}`;
  } catch {
    return name;
  }
}

function summarizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const role = entry.type || (entry.message && entry.message.role);
  const msg = entry.message || {};

  if (role === 'user' || msg.role === 'user') {
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map(c => c.text || '').filter(Boolean).join('\n')
        : '';
    const text = content.slice(0, 600);
    if (!text) return null;
    return `[user]\n${text}`;
  }

  if (role === 'assistant' || msg.role === 'assistant') {
    if (!Array.isArray(msg.content)) return null;
    const parts = [];
    for (const c of msg.content) {
      if (c.type === 'text' && c.text) parts.push(c.text.slice(0, 300));
      if (c.type === 'tool_use') parts.push(summarizeToolUse(c));
    }
    if (!parts.length) return null;
    return `[assistant]\n${parts.join('\n')}`;
  }

  return null;
}

function readTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const tail = lines.slice(-MAX_TRANSCRIPT_ENTRIES * 3);
  const out = [];
  for (const line of tail) {
    try {
      const obj = JSON.parse(line);
      const sum = summarizeEntry(obj);
      if (sum) out.push(sum);
    } catch {
      // skip malformed
    }
  }
  return out.slice(-MAX_TRANSCRIPT_ENTRIES);
}

function buildUserMessage(input, transcriptEntries) {
  const cmd = input.tool_input && input.tool_input.command;
  const action = `[assistant]\nBash: ${String(cmd || '').slice(0, 1000)}`;
  const history = transcriptEntries.join('\n\n');
  return [
    '<transcript>',
    history,
    '',
    action,
    '</transcript>'
  ].join('\n');
}

// ------------------------------------------------------------------
// LiteLLM call
// ------------------------------------------------------------------
const LITELLM_ENV_PATH = path.join(os.homedir(), '.claude', 'litellm.env');
const DEFAULT_LITELLM_BASE = 'https://litellm.juphorizon.com';

function readLitellmEnvFile() {
  // Parse ~/.claude/litellm.env into a map. Supports bare `K=V`, `export K=V`,
  // quoted values, and `#` comments. Claude Code does not source this file
  // for hook subprocesses, so the hook must load it itself.
  try {
    const raw = fs.readFileSync(LITELLM_ENV_PATH, 'utf8');
    const out = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = trimmed.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[m[1]] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function resolveLitellmCreds() {
  const envFile = readLitellmEnvFile();
  const base =
    process.env.HYBRID_LITELLM_BASE_URL ||
    envFile.HYBRID_LITELLM_BASE_URL ||
    DEFAULT_LITELLM_BASE;
  const key = process.env.LITELLM_API_KEY || envFile.LITELLM_API_KEY || '';
  return { base, key };
}

function postLLM(systemPrompt, userMessage) {
  return new Promise(resolve => {
    const { base, key } = resolveLitellmCreds();
    if (!base || !key) return resolve(null);

    let urlObj;
    try {
      urlObj = new URL('/v1/chat/completions', base);
    } catch {
      return resolve(null);
    }
    if (urlObj.protocol !== 'https:') return resolve(null);

    const body = JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0,
      max_tokens: 256,
      stop: ['</block>']
    });

    const req = https.request(
      {
        method: 'POST',
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${key}`
        },
        timeout: LLM_TIMEOUT_MS
      },
      res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          data += chunk;
          if (data.length > 64 * 1024) {
            req.destroy();
            resolve(null);
          }
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const j = JSON.parse(data);
            const text =
              j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
            resolve(typeof text === 'string' ? text : null);
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ------------------------------------------------------------------
// Response parse
// ------------------------------------------------------------------
function parseVerdict(text) {
  if (!text) return null;
  // stop_sequence may strip closing tag; handle both forms.
  const m = text.match(/<block>\s*(yes|no)\s*(?:<\/block>)?/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------
async function runAsync(rawInput) {
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return passthrough();
  }

  if (input.tool_name !== 'Bash') return passthrough();

  const cmd = input.tool_input && input.tool_input.command;
  if (typeof cmd !== 'string' || !cmd.trim()) return passthrough();

  // Permission-mode short-circuits: these modes either approve all, gate
  // at a higher layer, or explicitly restrict to edits — classifier is
  // either redundant or out of scope.
  const mode = input.permission_mode;
  if (mode && SKIP_PERMISSION_MODES.has(mode)) return passthrough();

  // ECC disable env — legacy compat with the rest of the hook stack.
  if (process.env.ECC_DISABLED_HOOKS && process.env.ECC_DISABLED_HOOKS.split(',').includes('bash-auto-approve')) {
    return passthrough();
  }

  // Allowlist pre-check: if the command already matches a `Bash(...)` rule
  // in settings.json, Claude Code will not prompt, so skip the LLM entirely.
  if (commandMatchesAllowlist(cmd)) return passthrough();

  let templates, defaults;
  try {
    templates = loadTemplates();
  } catch {
    return passthrough();
  }
  try {
    defaults = loadDefaults();
  } catch {
    return passthrough();
  }

  let systemPrompt;
  try {
    systemPrompt = buildSystemPrompt(defaults, templates);
  } catch {
    return passthrough();
  }

  const transcriptEntries = readTranscript(input.transcript_path);
  const userMessage = buildUserMessage(input, transcriptEntries);

  const text = await postLLM(systemPrompt, userMessage);
  const verdict = parseVerdict(text);

  if (verdict === 'no') {
    return allow('auto-mode classifier: preliminary ALLOW');
  }
  return passthrough();
}

function run(rawInput) {
  // run-with-flags.js supports returning a Promise from run(); await here
  // to keep exit deterministic.
  return runAsync(rawInput);
}

module.exports.run = run;
