#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const tls = require('node:tls');
const { URL } = require('node:url');
const { execFileSync } = require('node:child_process');

const SOCKET_PATH = process.env.ANTHROPIC_UNIX_SOCKET;
const LITELLM_BASE_URL = process.env.HYBRID_LITELLM_BASE_URL || 'https://litellm.juphorizon.com';
const LITELLM_ENV_PATH = process.env.HYBRID_LITELLM_ENV_PATH || path.join(process.env.HOME || '', '.claude', 'litellm.env');
const ROUTER_LOG_PATH = path.join(process.env.HOME || '', '.claude', 'hybrid', 'router.log');
const NATIVE_MODEL_PATTERNS = [/^claude-/i, /^anthropic\.claude-/i, /^claude$/i];

const state = {
  server: null,
  listenerReady: null,
  litellmToken: null,
  tlsDir: null,
};

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

const ALLOWED_PROXY_PATHS = new Set(['/v1/messages', '/v1/models']);

function log(message) {
  const line = `${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(ROUTER_LOG_PATH, line);
  } catch {
    // Best-effort file logging; stderr remains the primary signal.
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

function ensureTlsMaterial() {
  if (state.tlsDir) return state.tlsDir;

  const tlsDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'claude-hybrid-tls-'));
  const keyPath = path.join(tlsDir, 'localhost.key');
  const certPath = path.join(tlsDir, 'localhost.crt');
  const configPath = path.join(tlsDir, 'openssl.cnf');

  fs.writeFileSync(configPath, `
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = api.anthropic.com

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = api.anthropic.com
DNS.2 = localhost
`, 'utf8');

  execFileSync('openssl', [
    'req',
    '-x509',
    '-nodes',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-config',
    configPath,
    '-extensions',
    'v3_req',
  ], { stdio: 'ignore' });

  state.tlsDir = tlsDir;
  return tlsDir;
}

function loadTlsOptions() {
  const tlsDir = ensureTlsMaterial();
  return {
    key: fs.readFileSync(path.join(tlsDir, 'localhost.key')),
    cert: fs.readFileSync(path.join(tlsDir, 'localhost.crt')),
  };
}

function cleanupTlsMaterial() {
  if (!state.tlsDir) return;
  try {
    fs.rmSync(state.tlsDir, { recursive: true, force: true });
  } catch {}
  state.tlsDir = null;
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

async function forwardNative(req, res, body) {
  try {
    const parsed = readJsonBody(body);
    const sanitizedBody = parsed.error || !parsed.body || typeof parsed.body !== 'object'
      ? body
      : Buffer.from(JSON.stringify({
        ...parsed.body,
        messages: sanitizeAnthropicMessages(parsed.body.messages),
      }));
    const targetUrl = new URL(req.url, 'https://api.anthropic.com');
    const headers = createHeaders(req.headers, {
      host: 'api.anthropic.com',
      'content-length': Buffer.byteLength(sanitizedBody),
    }, ['transfer-encoding']);
    const upstream = await performRequest(targetUrl, { method: req.method, headers }, sanitizedBody);
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
  const payload = JSON.stringify({ ...JSON.parse(body.toString('utf8')), model: model.replace(/^litellm\//i, '') });
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
    return forwardNative(req, res, body);
  }

  const model = typeof parsed.body.model === 'string' ? parsed.body.model : '';
  if (isNativeModel(model)) {
    logRoutingDecision('NATIVE   ', `model=${model || '(empty)'} | path=${req.url}`);
    return forwardNative(req, res, body);
  }

  if (model.toLowerCase().startsWith('litellm/')) {
    logRoutingDecision('REROUTE  ', `model=${model} -> ${model.replace(/^litellm\//i, '')} -> ${LITELLM_BASE_URL}/v1/messages`);
    return forwardLiteLLM(req, res, body, model);
  }

  if (/^(gpt-|o[1-9]|o[1-9]-|gemini-|deepseek-|llama-|mistral-|mixtral-)/i.test(model)) {
    const litellmModel = `litellm/${model}`;
    logRoutingDecision('REROUTE  ', `model=${model} -> ${litellmModel.replace(/^litellm\//i, '')} -> ${LITELLM_BASE_URL}/v1/messages`);
    return forwardLiteLLM(req, res, body, litellmModel);
  }

  logRoutingDecision('REJECT   ', `model=${model} | reason=no LiteLLM routing match`);
  sendJson(res, 400, { error: `Unknown non-native model '${model}'. Use a supported model name or a litellm/ prefix.` });
}

async function handleRequest(req, res) {
  logRequestArrival(req);
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    try {
      const requestUrl = new URL(req.url, 'https://api.anthropic.com');
      if (req.method === 'POST' && requestUrl.pathname === '/v1/messages') {
        await handleMessages(req, res, body);
        return;
      }

      if (!ALLOWED_PROXY_PATHS.has(requestUrl.pathname)) {
        logRoutingDecision('REJECT   ', `path=${req.url} | reason=unsupported path`);
        sendJson(res, 404, { error: `Unsupported path '${req.url}'` });
        return;
      }

      logRoutingDecision('NATIVE   ', `path=${req.url}`);
      const targetUrl = requestUrl;
      const headers = createHeaders(req.headers, { host: 'api.anthropic.com' }, ['transfer-encoding']);
      const upstream = await performRequest(targetUrl, { method: req.method, headers }, body);
      pipeResponse(upstream, res);
    } catch (error) {
      logUpstreamError('api.anthropic.com (connect/request)', error);
      sendJson(res, 502, { error: getErrorMessage(error) });
    }
  });
}

function setupServer() {
  if (!SOCKET_PATH) {
    throw new Error('ANTHROPIC_UNIX_SOCKET is required');
  }
  if (state.server) return state.server;
  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(SOCKET_PATH), 0o700); } catch {}
  try { fs.unlinkSync(SOCKET_PATH); } catch {}

  const server = https.createServer(loadTlsOptions(), (req, res) => {
    void handleRequest(req, res);
  });

  server.on('connection', () => {
    log('CONNECT  | raw socket accepted');
  });

  server.on('secureConnection', () => {
    log('SECURE   | tls handshake completed');
  });

  server.on('tlsClientError', (error) => {
    log(`ERROR    | tls client error: ${getErrorDetail(error)}`);
  });

  state.server = server;
  state.listenerReady = new Promise((resolve, reject) => {
    server.once('error', (error) => {
      log(`ERROR    | socket server error: ${getErrorDetail(error)}`);
      reject(error);
    });
    server.listen(SOCKET_PATH, () => {
      try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}
      const token = loadLiteLLMToken();
      state.litellmToken = token || null;
      if (!token) log(`WARN     | LiteLLM token missing at ${LITELLM_ENV_PATH}`);
      log(`STARTED  | pid=${process.pid} socket=${SOCKET_PATH} litellm=${LITELLM_BASE_URL}`);
      resolve(server);
    });
  });

  return server;
}

async function shutdown() {
  if (!state.server) {
    cleanupTlsMaterial();
    return;
  }
  const server = state.server;
  state.server = null;
  state.litellmToken = null;
  await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  cleanupTlsMaterial();
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
  },
};
