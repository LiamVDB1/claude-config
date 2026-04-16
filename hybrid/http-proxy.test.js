const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { test, beforeEach, afterEach } = require('node:test');

const proxyModulePath = path.join(__dirname, 'http-proxy.js');
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
  const previousLiteLLMUrl = process.env.HYBRID_LITELLM_BASE_URL;
  const previousEnvPath = process.env.HYBRID_LITELLM_ENV_PATH;
  const previousPort = process.env.HYBRID_PROXY_PORT;

  // Find a free port by binding then closing
  const tmpServer = http.createServer();
  tmpServer.listen(0, '127.0.0.1');
  await once(tmpServer, 'listening');
  const port = tmpServer.address().port;
  await new Promise((resolve) => tmpServer.close(resolve));

  process.env.HYBRID_PROXY_PORT = String(port);
  process.env.HYBRID_LITELLM_BASE_URL = env.HYBRID_LITELLM_BASE_URL || 'http://127.0.0.1:9';
  if (env.LITELLM_ENV_PATH) process.env.HYBRID_LITELLM_ENV_PATH = env.LITELLM_ENV_PATH;
  else delete process.env.HYBRID_LITELLM_ENV_PATH;

  delete require.cache[require.resolve(proxyModulePath)];
  const mod = require(proxyModulePath);
  mod.setupServer();
  await mod.ready;
  return {
    port,
    close: async () => {
      await mod.shutdown();
      delete process.env.HYBRID_PROXY_PORT;
      if (previousLiteLLMUrl === undefined) delete process.env.HYBRID_LITELLM_BASE_URL;
      else process.env.HYBRID_LITELLM_BASE_URL = previousLiteLLMUrl;
      if (previousEnvPath === undefined) delete process.env.HYBRID_LITELLM_ENV_PATH;
      else process.env.HYBRID_LITELLM_ENV_PATH = previousEnvPath;
      if (previousPort === undefined) delete process.env.HYBRID_PROXY_PORT;
      else process.env.HYBRID_PROXY_PORT = previousPort;
    },
  };
}

function request(port, { method = 'POST', path: requestPath, headers = {}, body }) {
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
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
  delete process.env.HYBRID_PROXY_PORT;
  delete process.env.HYBRID_LITELLM_BASE_URL;
  delete process.env.HYBRID_LITELLM_ENV_PATH;
  delete require.cache[require.resolve(proxyModulePath)];
});

test('forward native messages with all headers preserved', async () => {
  router = await startRouter();

  const response = await request(router.port, {
    path: '/v1/messages',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer secret-token',
      'x-api-key': 'another-secret',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
  });

  // Will get 401 from real Anthropic (no valid token), which proves it forwarded
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

  const envFile = path.join(os.tmpdir(), `litellm-${process.pid}-${Date.now()}.env`);
  try {
    fs.writeFileSync(envFile, 'LITELLM_API_KEY = "litellm-test-key"\n', 'utf8');
    router = await startRouter({
      HYBRID_LITELLM_BASE_URL: upstream.baseUrl,
      LITELLM_ENV_PATH: envFile,
    });

    const response = await request(router.port, {
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer anthropic-token',
        'x-api-key': 'anthropic-key',
        'anthropic-api-key': 'anthropic-secret',
      },
      body: JSON.stringify({ model: 'litellm/gpt-4o', messages: [] }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/v1/messages');
    assert.equal(seen[0].headers.authorization, 'Bearer litellm-test-key');
    assert.equal(seen[0].headers['x-api-key'], undefined);
    assert.equal(seen[0].headers['anthropic-api-key'], undefined);
    assert.deepEqual(JSON.parse(seen[0].body), { model: 'gpt-4o', messages: [] });
    const log = fs.readFileSync(routerLogPath, 'utf8');
    assert.match(log, /REROUTE\s+\| model=litellm\/gpt-4o -> gpt-4o -> .*\/v1\/messages/);
  } finally {
    try { fs.unlinkSync(envFile); } catch {}
  }
});

test('routes system markers and strips them before forwarding', async () => {
  const seen = [];
  upstream = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const envFile = path.join(os.tmpdir(), `litellm-${process.pid}-${Date.now()}-marker.env`);
  fs.writeFileSync(envFile, 'LITELLM_API_KEY=marker-test-key\n', 'utf8');
  router = await startRouter({
    HYBRID_LITELLM_BASE_URL: upstream.baseUrl,
    LITELLM_ENV_PATH: envFile,
  });

  const response = await request(router.port, {
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      system: 'route $%$model: litellm/gpt-4o$%$',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, 'Bearer marker-test-key');
  assert.deepEqual(JSON.parse(seen[0].body), {
    model: 'gpt-4o',
    system: 'route',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  });
  const log = fs.readFileSync(routerLogPath, 'utf8');
  assert.match(log, /REROUTE\s+\| model=gpt-4o marker=litellm\/gpt-4o -> gpt-4o -> .*\/v1\/messages/);
  fs.unlinkSync(envFile);
});

test('ignores malformed model markers in user message text', async () => {
  router = await startRouter();

  const response = await request(router.port, {
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello $%$model: experimental$%$' }] },
      ],
    }),
  });

  // Should route native (model field wins), which hits real Anthropic -> 401
  assert.equal(response.statusCode, 401);
  const log = fs.readFileSync(routerLogPath, 'utf8');
  assert.match(log, /NATIVE\s+\| model=claude-sonnet-4-6 \| path=\/v1\/messages/);
});

test('sanitizes invalid thinking blocks before forwarding native requests', async () => {
  const seen = [];
  // Mock the upstream by temporarily patching https.request for api.anthropic.com
  const https = require('node:https');
  const originalRequest = https.request;

  https.request = function patchedRequest(options, callback) {
    if (typeof options === 'object' && options.hostname === 'api.anthropic.com') {
      const chunks = [];
      const req = new (require('node:stream').PassThrough)();
      const origWrite = req.write.bind(req);
      req.write = (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return true;
      };
      req.end = (chunk) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const res = new (require('node:stream').PassThrough)();
        res.statusCode = 200;
        res.headers = { 'content-type': 'application/json' };
        process.nextTick(() => {
          seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          callback(res);
          res.end(JSON.stringify({ ok: true }));
        });
      };
      req.on = (event, handler) => { if (event === 'socket') process.nextTick(handler); return req; };
      return req;
    }
    return originalRequest.call(this, options, callback);
  };

  try {
    router = await startRouter();
    const response = await request(router.port, {
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
    // Empty thinking block (no .thinking string) should be stripped
    assert.deepEqual(seen[0].messages[1].content, [{ type: 'text', text: 'hello' }]);
  } finally {
    https.request = originalRequest;
  }
});

test('forwards non-message paths transparently (no 404)', async () => {
  router = await startRouter();

  // count_tokens — should forward to Anthropic (will get auth error), NOT 404
  const response = await request(router.port, {
    method: 'POST',
    path: '/v1/messages/count_tokens',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
  });

  // Should NOT be 404 (old proxy would 404 here)
  assert.notEqual(response.statusCode, 404);
  const log = fs.readFileSync(routerLogPath, 'utf8');
  assert.match(log, /NATIVE\s+\| path=\/v1\/messages\/count_tokens/);
});

test('auto-reroutes known model families to LiteLLM', async () => {
  const seen = [];
  upstream = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const envFile = path.join(os.tmpdir(), `litellm-${process.pid}-${Date.now()}-auto.env`);
  fs.writeFileSync(envFile, 'LITELLM_API_KEY=auto-test-key\n', 'utf8');
  router = await startRouter({
    HYBRID_LITELLM_BASE_URL: upstream.baseUrl,
    LITELLM_ENV_PATH: envFile,
  });

  const response = await request(router.port, {
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4', messages: [] }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0].body).model, 'gpt-5.4');
  const log = fs.readFileSync(routerLogPath, 'utf8');
  assert.match(log, /REROUTE\s+\| model=gpt-5\.4 -> gpt-5\.4 ->/);
  fs.unlinkSync(envFile);
});

test('rejects unknown non-native models with 400', async () => {
  router = await startRouter();

  const response = await request(router.port, {
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'unknown-model-xyz', messages: [] }),
  });

  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.match(parsed.error, /unknown-model-xyz/i);
});

test('server starts and stops cleanly', async () => {
  router = await startRouter();
  const log = fs.readFileSync(routerLogPath, 'utf8');
  assert.match(log, /STARTED\s+\| pid=\d+ host=127\.0\.0\.1 port=\d+ litellm=/);
  await router.close();
  router = null; // prevent double-close in afterEach
});
