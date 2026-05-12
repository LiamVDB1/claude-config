#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { URL } = require('node:url');

const HYBRID_PROXY_PORT = Number.parseInt(process.env.HYBRID_PROXY_PORT || '', 10);
const SOCKET_PATH = process.env.ANTHROPIC_UNIX_SOCKET;
const LITELLM_BASE_URL = process.env.HYBRID_LITELLM_BASE_URL || 'https://litellm.juphorizon.com';
const LITELLM_ENV_PATH = process.env.HYBRID_LITELLM_ENV_PATH || path.join(process.env.HOME || '', '.claude', 'litellm.env');
const ROUTER_LOG_PATH = path.join(process.env.HOME || '', '.claude', 'hybrid', 'router.log');

const NATIVE_MODEL_PATTERNS = [/^claude-/i, /^anthropic\.claude-/i, /^claude$/i];
const NATIVE_MODEL_ALIASES = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};
const MODEL_MARKER_PATTERN = /\$%\$model:\s*([^\n$%]+?)\s*\$%\$/i;
const MODEL_TARGET_PREFIXES = ['litellm/', 'native/'];
const MARKER_REMOVAL_PATTERN = /\s*\$%\$model:\s*[^\n$%]+?\s*\$%\$/gi;

const SAFE_FORWARD_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'user-agent',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
]);

const state = {
  server: null,
  listenerReady: null,
  litellmToken: null,
};

function log(message) {
  const line = `${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(ROUTER_LOG_PATH, line);
  } catch {
    // Best-effort file logging; stderr remains primary signal.
  }
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : 'Unexpected error';
}

function getErrorDetail(error) {
  if (!(error instanceof Error)) return 'Unexpected error';
  const parts = [error.message];
  if ('code' in error && error.code) parts.push(`code=${error.code}`);
  if ('address' in error && error.address) parts.push(`address=${error.address}`);
  if ('port' in error && error.port) parts.push(`port=${error.port}`);
  return parts.join(' | ');
}

function logUpstreamError(scope, error) {
  log(`ERROR    | upstream ${scope}: ${getErrorDetail(error)}`);
}

function readEnvVar(filePath, key) {
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const rawKey = trimmed.slice(0, index).trim();
    if (rawKey !== key) continue;
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return '';
}

function loadLiteLLMToken() {
  return readEnvVar(LITELLM_ENV_PATH, 'LITELLM_API_KEY').trim();
}

function isNativeModel(model) {
  return model === '' || NATIVE_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

function readJsonBody(buffer) {
  if (!buffer.length) return { body: null, error: null };
  try {
    return { body: JSON.parse(buffer.toString('utf8')), error: null };
  } catch (error) {
    return { body: null, error };
  }
}

function createHeaders(originalHeaders, overrides = {}, removals = []) {
  const headers = { ...originalHeaders };
  for (const name of removals) {
    delete headers[name];
  }
  return { ...headers, ...overrides };
}

function pickForwardHeaders(originalHeaders) {
  return Object.fromEntries(
    Object.entries(originalHeaders).filter(([name]) => SAFE_FORWARD_HEADERS.has(name.toLowerCase())),
  );
}

function sanitizeAnthropicMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) {
      return message;
    }
    return {
      ...message,
      content: message.content.filter((block) => {
        if (!block || typeof block !== 'object') return true;
        if (block.type !== 'thinking') return true;
        return typeof block.thinking === 'string' && block.thinking.length > 0;
      }),
    };
  });
}

function extractModelTarget(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(MODEL_MARKER_PATTERN);
  if (!match) return null;
  const target = match[1].trim();
  const lowerTarget = target.toLowerCase();
  if (!MODEL_TARGET_PREFIXES.some((prefix) => lowerTarget.startsWith(prefix))) return null;
  return target;
}

function stripModelMarker(text) {
  if (typeof text !== 'string') return text;
  return text.replace(MARKER_REMOVAL_PATTERN, '').trim();
}

function stripContextWindowSuffix(model) {
  return model.replace(/^gpt-5\.5\[1m\]$/i, 'gpt-5.5');
}

function getSystemText(body) {
  if (!body || typeof body !== 'object') return '';
  if (typeof body.system === 'string') return body.system;
  if (Array.isArray(body.system)) {
    const parts = [];
    for (const block of body.system) {
      if (!block || typeof block !== 'object') continue;
      if (typeof block.text === 'string') parts.push(block.text);
      if (typeof block.content === 'string') parts.push(block.content);
    }
    return parts.join('\n');
  }
  return '';
}

function stripMarkerFromSystem(body) {
  if (!body || typeof body !== 'object') return body;
  if (typeof body.system === 'string') {
    return { ...body, system: stripModelMarker(body.system) };
  }
  if (Array.isArray(body.system)) {
    return {
      ...body,
      system: body.system.map((block) => {
        if (!block || typeof block !== 'object') return block;
        if (typeof block.text === 'string') return { ...block, text: stripModelMarker(block.text) };
        return block;
      }),
    };
  }
  return body;
}

function applyModelMarker(body) {
  const systemText = getSystemText(body);
  const target = extractModelTarget(systemText);
  if (!target) return { body, target: null };
  const sanitizedBody = stripMarkerFromSystem(body);
  return { body: sanitizedBody, target };
}

function performRequest(targetUrl, options, body) {
  const client = targetUrl.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: options.method,
      headers: options.headers,
    }, (res) => resolve(res));

    req.on('socket', () => {
      log(`UPSOCK   | ${options.method} ${targetUrl.origin}${targetUrl.pathname}`);
    });
    req.on('error', reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

function describeRequest(req) {
  return `${req.method} ${req.url}`;
}

function logRequestArrival(req) {
  log(`ARRIVED  | ${describeRequest(req)}`);
}

function logRoutingDecision(decision, details) {
  log(`${decision} | ${details}`);
}

function pipeResponse(source, destination) {
  destination.writeHead(source.statusCode || 502, source.headers);
  source.pipe(destination);
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': body.length,
  });
  res.end(body);
}

function trySanitizeNativeBody(body) {
  const parsed = readJsonBody(body);
  if (parsed.error || !parsed.body || typeof parsed.body !== 'object') return body;
  return Buffer.from(JSON.stringify({
    ...parsed.body,
    messages: sanitizeAnthropicMessages(parsed.body.messages),
  }));
}

async function forwardNative(req, res, body, options = {}) {
  try {
    const requestBody = options.sanitizeThinking ? trySanitizeNativeBody(body) : body;
    const targetUrl = new URL(req.url, 'https://api.anthropic.com');
    const upstreamHeaders = {
      ...req.headers,
      host: 'api.anthropic.com',
    };

    if (requestBody && requestBody.length) {
      upstreamHeaders['content-length'] = Buffer.byteLength(requestBody);
      delete upstreamHeaders['transfer-encoding'];
    }

    const upstream = await performRequest(targetUrl, { method: req.method, headers: upstreamHeaders }, requestBody);
    pipeResponse(upstream, res);
    upstream.on('error', (error) => {
      logUpstreamError('api.anthropic.com (response stream)', error);
    });
  } catch (error) {
    logUpstreamError('api.anthropic.com (connect/request)', error);
    sendJson(res, 502, { error: 'Failed to reach Anthropic upstream' });
  }
}

async function forwardLiteLLM(req, res, body, model) {
  const token = state.litellmToken || loadLiteLLMToken();
  if (!token) {
    logRoutingDecision('REJECT   ', `model=${model} | reason=LiteLLM token not configured`);
    sendJson(res, 503, { error: 'LiteLLM token not configured' });
    return;
  }

  const upstreamUrl = new URL('/v1/messages', LITELLM_BASE_URL);
  const upstreamModel = stripContextWindowSuffix(model.replace(/^litellm\//i, ''));
  const payload = JSON.stringify({ ...JSON.parse(body.toString('utf8')), model: upstreamModel });
  const headers = createHeaders(pickForwardHeaders(req.headers), {
    host: upstreamUrl.host,
    authorization: `Bearer ${token}`,
    'content-length': Buffer.byteLength(payload),
  }, ['authorization', 'x-api-key', 'anthropic-api-key', 'anthropic-version', 'transfer-encoding']);

  try {
    const upstream = await performRequest(upstreamUrl, { method: req.method, headers }, Buffer.from(payload));
    if (upstream.statusCode === 401) {
      state.litellmToken = loadLiteLLMToken();
    }
    pipeResponse(upstream, res);
  } catch (error) {
    logUpstreamError(`LiteLLM ${upstreamUrl.origin} (connect/request)`, error);
    sendJson(res, 503, { error: `LiteLLM upstream unavailable: ${getErrorMessage(error)}` });
  }
}

async function handleMessages(req, res, body) {
  const parsed = readJsonBody(body);
  if (parsed.error || !parsed.body || typeof parsed.body !== 'object') {
    logRoutingDecision('NATIVE   ', `model=(unparsed) | path=${req.url}`);
    return forwardNative(req, res, body, { sanitizeThinking: true });
  }

  const markerResult = applyModelMarker(parsed.body);
  const activeBody = markerResult.body;
  const model = typeof activeBody.model === 'string' ? activeBody.model : '';
  const markerTarget = markerResult.target;
  const targetModel = markerTarget ? markerResult.target.replace(/^(?:litellm|native)\//i, '') : null;

  if (markerTarget) {
    if (markerTarget.toLowerCase().startsWith('native/')) {
      const resolvedModel = targetModel ? (NATIVE_MODEL_ALIASES[targetModel.toLowerCase()] || targetModel) : null;
      const nativeBody = resolvedModel ? { ...activeBody, model: resolvedModel } : activeBody;
      logRoutingDecision('NATIVE   ', `model=${model || '(empty)'} marker=${markerTarget} -> ${resolvedModel || '(empty)'} -> https://api.anthropic.com/v1/messages`);
      return forwardNative(req, res, Buffer.from(JSON.stringify(nativeBody)), { sanitizeThinking: true });
    }
    const routedModel = `litellm/${targetModel}`;
    logRoutingDecision('REROUTE  ', `model=${model || '(empty)'} marker=${markerTarget} -> ${targetModel || '(empty)'} -> ${LITELLM_BASE_URL}/v1/messages`);
    return forwardLiteLLM(req, res, Buffer.from(JSON.stringify(activeBody)), routedModel);
  }

  if (isNativeModel(model)) {
    logRoutingDecision('NATIVE   ', `model=${model || '(empty)'} | path=${req.url}`);
    return forwardNative(req, res, body, { sanitizeThinking: true });
  }

  if (model.toLowerCase().startsWith('litellm/')) {
    const targetModel = stripContextWindowSuffix(model.replace(/^litellm\//i, ''));
    logRoutingDecision('REROUTE  ', `model=${model} -> ${targetModel} -> ${LITELLM_BASE_URL}/v1/messages`);
    return forwardLiteLLM(req, res, body, model);
  }

  if (/^(gpt-|o[1-9]|o[1-9]-|gemini-|deepseek-|llama-|mistral-|mixtral-)/i.test(model)) {
    const litellmModel = `litellm/${model}`;
    const targetModel = stripContextWindowSuffix(litellmModel.replace(/^litellm\//i, ''));
    logRoutingDecision('REROUTE  ', `model=${model} -> ${targetModel} -> ${LITELLM_BASE_URL}/v1/messages`);
    return forwardLiteLLM(req, res, body, litellmModel);
  }

  logRoutingDecision('REJECT   ', `model=${model} | reason=no LiteLLM routing match`);
  sendJson(res, 400, { error: `Unknown non-native model '${model}'. Use a supported model name or a litellm/ prefix.` });
}

async function handleRequest(req, res) {
  logRequestArrival(req);

  const requestUrl = new URL(req.url, 'https://api.anthropic.com');
  if (req.method === 'POST' && requestUrl.pathname === '/v1/messages') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      await handleMessages(req, res, body);
    });
    return;
  }

  logRoutingDecision('NATIVE   ', `path=${req.url}`);
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    await forwardNative(req, res, body, { sanitizeThinking: false });
  });
}

function resolveListenTarget() {
  if (Number.isInteger(HYBRID_PROXY_PORT) && HYBRID_PROXY_PORT > 0 && HYBRID_PROXY_PORT <= 65535) {
    return { mode: 'tcp', host: '127.0.0.1', port: HYBRID_PROXY_PORT };
  }
  if (SOCKET_PATH) {
    return { mode: 'unix', socketPath: SOCKET_PATH };
  }
  throw new Error('HYBRID_PROXY_PORT or ANTHROPIC_UNIX_SOCKET is required');
}

function setupServer() {
  if (state.server) return state.server;

  const listenTarget = resolveListenTarget();
  if (listenTarget.mode === 'unix') {
    fs.mkdirSync(path.dirname(listenTarget.socketPath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(listenTarget.socketPath), 0o700); } catch {}
    try { fs.unlinkSync(listenTarget.socketPath); } catch {}
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  state.server = server;
  state.listenerReady = new Promise((resolve, reject) => {
    server.once('error', (error) => {
      log(`ERROR    | proxy server error: ${getErrorDetail(error)}`);
      reject(error);
    });

    const onListening = () => {
      if (listenTarget.mode === 'unix') {
        try { fs.chmodSync(listenTarget.socketPath, 0o600); } catch {}
      }
      const token = loadLiteLLMToken();
      state.litellmToken = token || null;
      if (!token) log(`WARN     | LiteLLM token missing at ${LITELLM_ENV_PATH}`);
      if (listenTarget.mode === 'tcp') {
        log(`STARTED  | pid=${process.pid} host=${listenTarget.host} port=${listenTarget.port} litellm=${LITELLM_BASE_URL}`);
      } else {
        log(`STARTED  | pid=${process.pid} socket=${listenTarget.socketPath} litellm=${LITELLM_BASE_URL}`);
      }
      process.stdout.write('READY\n');
      resolve(server);
    };

    if (listenTarget.mode === 'tcp') {
      server.listen(listenTarget.port, listenTarget.host, onListening);
    } else {
      server.listen(listenTarget.socketPath, onListening);
    }
  });

  return server;
}

async function shutdown() {
  if (!state.server) return;
  const server = state.server;
  state.server = null;
  state.litellmToken = null;
  await new Promise((resolve) => server.close(resolve));
  if (SOCKET_PATH) {
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
  }
}

process.on('uncaughtException', (error) => {
  log(`ERROR    | uncaughtException: ${getErrorDetail(error)}`);
});
process.on('unhandledRejection', (reason) => {
  log(`ERROR    | unhandledRejection: ${getErrorDetail(reason)}`);
});
process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
process.on('SIGINT', () => { void shutdown().then(() => process.exit(0)); });

if (require.main === module) {
  setupServer();
}

module.exports = {
  get ready() {
    return state.listenerReady;
  },
  setupServer,
  shutdown,
  __test__: {
    loadLiteLLMToken,
    isNativeModel,
    readEnvVar,
    pickForwardHeaders,
    sanitizeAnthropicMessages,
  },
};
