const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { test, beforeEach, afterEach } = require('node:test');

const serverModulePath = path.join(__dirname, 'socket-server.js');
const routerLogPath = path.join(os.homedir(), '.claude', 'hybrid', 'router.log');

async function startUpstream(responder) {
  const server = http.createServer(responder);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startRouter(env = {}) {
  const socketPath = path.join(os.tmpdir(), `cc-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`);
  const previousBaseUrl = process.env.HYBRID_LITELLM_BASE_URL;
  const previousEnvPath = process.env.HYBRID_LITELLM_ENV_PATH;

  process.env.ANTHROPIC_UNIX_SOCKET = socketPath;
  process.env.HYBRID_LITELLM_BASE_URL = env.HYBRID_LITELLM_BASE_URL || 'http://127.0.0.1:9';
  if (env.LITELLM_ENV_PATH) process.env.HYBRID_LITELLM_ENV_PATH = env.LITELLM_ENV_PATH;
  else delete process.env.HYBRID_LITELLM_ENV_PATH;

  delete require.cache[require.resolve(serverModulePath)];
  const mod = require(serverModulePath);
  mod.setupServer();
  await mod.ready;
  return {
    socketPath,
    close: async () => {
      await mod.shutdown();
      delete process.env.ANTHROPIC_UNIX_SOCKET;
      if (previousBaseUrl === undefined) delete process.env.HYBRID_LITELLM_BASE_URL;
      else process.env.HYBRID_LITELLM_BASE_URL = previousBaseUrl;
      if (previousEnvPath === undefined) delete process.env.HYBRID_LITELLM_ENV_PATH;
      else process.env.HYBRID_LITELLM_ENV_PATH = previousEnvPath;
    },
  };
}

async function request(socketPath, { method = 'POST', path: requestPath, headers = {}, body }) {
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
  return await new Promise((resolve, reject) => {
    const req = https.request({
      socketPath,
      host: 'api.anthropic.com',
      servername: 'api.anthropic.com',
      path: requestPath,
      method,
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let router;
let upstream;

beforeEach(async () => {
  upstream = null;
  router = null;
  try { fs.unlinkSync(routerLogPath); } catch {}
});

afterEach(async () => {
  if (router) await router.close();
  if (upstream) await upstream.close();
  delete process.env.ANTHROPIC_UNIX_SOCKET;
  delete process.env.HYBRID_LITELLM_BASE_URL;
  delete process.env.HYBRID_LITELLM_ENV_PATH;
  delete require.cache[require.resolve(serverModulePath)];
});

test('forward native messages without modifying headers or body', async () => {
  router = await startRouter();

  const response = await request(router.socketPath, {
    path: '/v1/messages',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer secret-token',
      'x-api-key': 'another-secret',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
  });

  assert.equal(response.statusCode, 401);
  const log = fs.readFileSync(routerLogPath, 'utf8');
  assert.match(log, /ARRIVED\s+\| POST \/v1\/messages/);
  assert.match(log, /NATIVE\s+\| model=claude-sonnet-4-6 \| path=\/v1\/messages/);
});

test('reroutes litellm models with stripped auth and rewritten model', async () => {
  const seen = [];
  upstream = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        url: req.url,
        method: req.method,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ routed: true }));
    });
  });

  try {
    const envFile = path.join(os.tmpdir(), `litellm-${process.pid}-${Date.now()}.env`);
    fs.writeFileSync(envFile, 'LITELLM_API_KEY = "litellm-test-key"\n', 'utf8');
    router = await startRouter({
      HYBRID_LITELLM_BASE_URL: upstream.baseUrl,
      LITELLM_ENV_PATH: envFile,
    });

    const response = await request(router.socketPath, {
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer anthropic-token',
        'x-api-key': 'anthropic-key',
        'anthropic-api-key': 'anthropic-secret',
      },
      body: JSON.stringify({ model: 'litellm/gpt-4o', messages: [] }),
    });

    if (response.statusCode !== 200) {
      throw new Error(`expected 200, got ${response.statusCode}: ${response.body}; seen=${JSON.stringify(seen)}`);
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/v1/messages');
    assert.equal(seen[0].headers.authorization, 'Bearer litellm-test-key');
    assert.equal(seen[0].headers['x-api-key'], undefined);
    assert.equal(seen[0].headers['anthropic-api-key'], undefined);
    assert.deepEqual(JSON.parse(seen[0].body), { model: 'gpt-4o', messages: [] });
    const log = fs.readFileSync(routerLogPath, 'utf8');
    assert.match(log, /REROUTE\s+\| model=litellm\/gpt-4o -> gpt-4o -> .*\/v1\/messages/);
  } finally {
    try { fs.unlinkSync(path.join(os.tmpdir(), `litellm-${process.pid}-*.env`)); } catch {}
  }
});

test('reroutes direct provider model names through LiteLLM', async () => {
  const seen = [];
  upstream = await startUpstream((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const envFile = path.join(os.tmpdir(), `litellm-${process.pid}-${Date.now()}-direct.env`);
  fs.writeFileSync(envFile, 'LITELLM_API_KEY=direct-test-key\n', 'utf8');
  router = await startRouter({
    HYBRID_LITELLM_BASE_URL: upstream.baseUrl,
    LITELLM_ENV_PATH: envFile,
  });

  const response = await request(router.socketPath, {
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0].body), { model: 'gpt-4o', messages: [] });
  const log = fs.readFileSync(routerLogPath, 'utf8');
  assert.match(log, /REROUTE\s+\| model=gpt-4o -> gpt-4o -> .*\/v1\/messages/);
  fs.unlinkSync(envFile);
});

test('reads liteLLM token from env file', async () => {
  const envFile = path.join(os.tmpdir(), `litellm-${process.pid}-${Date.now()}-load.env`);
  fs.writeFileSync(envFile, 'LITELLM_API_KEY=from-file\n', 'utf8');
  process.env.HYBRID_LITELLM_ENV_PATH = envFile;

  process.env.ANTHROPIC_UNIX_SOCKET = path.join(os.tmpdir(), `cc-token-${process.pid}-${Date.now()}.sock`);
  delete require.cache[require.resolve(serverModulePath)];
  const mod = require(serverModulePath);
  const token = mod.__test__.loadLiteLLMToken();

  assert.equal(token, 'from-file');
  await mod.shutdown();
  fs.unlinkSync(envFile);
});

test('sanitizes invalid thinking blocks before forwarding native requests', async () => {
  const originalRequest = https.request;
  const seen = [];

  https.request = function patchedRequest(options, callback) {
    const isRouterSocketRequest = typeof options === 'object' && options && 'socketPath' in options;
    if (isRouterSocketRequest) {
      return originalRequest.call(this, options, callback);
    }

    const req = new (require('node:stream').PassThrough)();
    const chunks = [];
    req.write = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };
    req.end = (chunk) => {
      if (chunk) req.write(chunk);
      const res = new (require('node:stream').PassThrough)();
      res.statusCode = 200;
      res.headers = { 'content-type': 'application/json' };
      process.nextTick(() => {
        seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        callback(res);
        res.end(JSON.stringify({ ok: true }));
      });
    };
    req.on = () => req;
    return req;
  };

  try {
    router = await startRouter();
    const response = await request(router.socketPath, {
      path: '/v1/messages?beta=true',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'thinking', signature: 'abc' }, { type: 'text', text: 'hello' }] },
        ],
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].messages[1].content, [{ type: 'text', text: 'hello' }]);
  } finally {
    https.request = originalRequest;
  }
});

test('ready becomes a promise after setupServer', async () => {
  process.env.ANTHROPIC_UNIX_SOCKET = path.join(os.tmpdir(), `cc-ready-${process.pid}-${Date.now()}.sock`);
  delete require.cache[require.resolve(serverModulePath)];
  const mod = require(serverModulePath);

  assert.equal(mod.ready, null);
  mod.setupServer();
  assert.ok(mod.ready instanceof Promise);
  await mod.ready;
  const log = fs.readFileSync(routerLogPath, 'utf8');
  assert.match(log, /STARTED\s+\| pid=\d+ socket=.* litellm=https:\/\/litellm\.juphorizon\.com/);
  await mod.shutdown();
});
