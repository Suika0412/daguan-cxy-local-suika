import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRemoteGateway, SESSION_AGE, policyPath, forwardPath } = require('../desktop/remote-gateway.cjs');

test('remote gateway authenticates, proxies learning APIs, blocks management and revokes sessions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daguan-remote-gateway-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/api/ai/chat') { res.setHeader('Content-Type', 'text/event-stream'); res.write('data: {"type":"delta","content":"hello"}\n\n'); setTimeout(() => res.end('data: {"type":"done"}\n\n'), 10); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: req.url, method: req.method, cookie: req.headers.cookie || '' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const gateway = createRemoteGateway({ authFile: path.join(dir, 'auth.json'), upstream: () => `http://127.0.0.1:${upstream.address().port}`, getMode: () => 'quick' });
  await gateway.init();
  await gateway.setPassword('a strong testing password');
  gateway.setPublicHost('study.example.com');
  const port = await gateway.start();
  t.after(() => gateway.stop());
  const base = `http://127.0.0.1:${port}`;
  const request = (route, options = {}) => new Promise((resolve, reject) => {
    const outgoing = http.request(base + route, { method: options.method || 'GET', headers: { Host: 'study.example.com', ...options.headers } }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('end', () => { const body = Buffer.concat(chunks).toString(); resolve({ status: incoming.statusCode, headers: { get: name => { const value = incoming.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; } }, json: async () => JSON.parse(body), text: async () => body }); });
    });
    outgoing.on('error', reject); outgoing.end(options.body);
  });
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/index.html')).status, 302);
  assert.equal((await request('/__remote/login')).status, 200);
  assert.equal((await request('/__remote/login', { method: 'POST', headers: { Origin: 'https://attacker.example' }, body: JSON.stringify({ password: 'a strong testing password' }) })).status, 403);
  const loggedIn = await request('/__remote/login', { method: 'POST', headers: { Origin: 'https://study.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a strong testing password' }) });
  assert.equal(loggedIn.status, 200);
  const cookie = loggedIn.headers.get('set-cookie').split(';')[0];
  const expiration = Number(cookie.split('=')[1].split('.')[0]);
  assert.ok(Math.abs(expiration - Date.now() - SESSION_AGE) < 10000);
  assert.match(loggedIn.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const headers = { Cookie: cookie };
  assert.deepEqual(await (await request('/api/state', { headers })).json(), { path: '/api/state', method: 'GET', cookie: '' });
  assert.equal((await request('/api/state/questions/1', { method: 'PATCH', headers: { ...headers, Origin: 'https://study.example.com' }, body: '{}' })).status, 200);
  assert.equal((await request('/api/state/questions/1', { method: 'PATCH', headers, body: '{}' })).status, 403);
  const ai = await request('/api/ai/chat', { method: 'POST', headers: { ...headers, Origin: 'https://study.example.com' }, body: '{}' });
  assert.equal(ai.status, 200);
  assert.equal(ai.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(await ai.text(), /"type":"delta"/);
  for (const route of ['/api/runtime/stop', '/api/runtime/stop%2f', '/api/catalog/refresh', '/api/tunnel/start', '/__remote/admin', '/service-worker.js', '/api/state/events']) {
    assert.notEqual((await request(route, { headers })).status, 200, route);
  }
  assert.equal((await request('/__remote/status', { headers })).status, 200);
  await gateway.revokeSessions();
  assert.equal((await request('/api/state', { headers })).status, 401);
  assert.equal((await request('/api/state', { headers: { Host: 'evil.example' } })).status, 421);
});

test('remote gateway keeps AI configuration read-only and forwards normalized paths without external Origin', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daguan-remote-ai-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, origin: req.headers.origin || null, remote: req.headers['x-daguan-remote'] || null, host: req.headers.host });
    if (req.url === '/api/ai/chat') { res.setHeader('Content-Type', 'text/event-stream'); res.write('data: {"type":"delta","content":"hello"}\n\n'); setTimeout(() => res.end('data: {"type":"done"}\n\n'), 10); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const gateway = createRemoteGateway({ authFile: path.join(dir, 'auth.json'), upstream: () => `http://127.0.0.1:${upstream.address().port}`, getMode: () => 'quick' });
  await gateway.init();
  await gateway.setPassword('a strong testing password');
  gateway.setPublicHost('study.example.com');
  const port = await gateway.start();
  t.after(() => gateway.stop());
  const base = `http://127.0.0.1:${port}`;
  const request = (route, options = {}) => new Promise((resolve, reject) => {
    const outgoing = http.request(base + route, { method: options.method || 'GET', headers: { Host: 'study.example.com', ...options.headers } }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('end', () => { const body = Buffer.concat(chunks).toString(); resolve({ status: incoming.statusCode, headers: { get: name => { const value = incoming.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; } }, json: async () => JSON.parse(body), text: async () => body }); });
    });
    outgoing.on('error', reject); outgoing.end(options.body);
  });
  const loggedIn = await request('/__remote/login', { method: 'POST', headers: { Origin: 'https://study.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a strong testing password' }) });
  assert.equal(loggedIn.status, 200);
  const headers = { Cookie: loggedIn.headers.get('set-cookie').split(';')[0] };
  const blocked = [
    ['POST', '/api/ai/profiles'], ['PUT', '/api/ai/profiles'], ['PATCH', '/api/ai/profiles'], ['DELETE', '/api/ai/profiles'], ['OPTIONS', '/api/ai/profiles'],
    ['POST', '/api/ai/profiles/'], ['PATCH', '/api/ai/profiles/abc'], ['DELETE', '/api/ai/profiles/abc'], ['PUT', '/api/ai/profiles/abc'],
    ['GET', '/api/ai/profiles/abc/models'], ['HEAD', '/api/ai/profiles/abc/models'], ['POST', '/api/ai/profiles/abc/models'], ['GET', '/api/ai/profiles/abc/models/'],
    ['POST', '/api/ai/profiles/abc/test'], ['GET', '/api/ai/profiles/abc/test'], ['OPTIONS', '/api/ai/profiles/abc/test'], ['POST', '/api/ai/profiles/abc/test?kind=vision'],
    ['GET', '/api/ai/profiles/abc%2fmodels'], ['GET', '/API/AI/PROFILES/ABC/MODELS'], ['PATCH', '/api/ai/profiles%2Fabc'],
    ['POST', '//api/ai/profiles'], ['POST', '/api/ai/../ai/profiles'], ['POST', '/api/ai/profiles/..%2fmodels'],
  ];
  for (const [method, route] of blocked) {
    const response = await request(route, { method, headers });
    assert.notEqual(response.status, 200, `${method} ${route} must not reach the local service`);
  }
  assert.equal((await request('/api/ai/profiles', { headers })).status, 200);
  assert.equal((await request('/api/ai/profiles/', { headers })).status, 200);
  const chat = await request('/api/ai/chat', { method: 'POST', headers: { ...headers, Origin: 'https://study.example.com', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(chat.status, 200);
  assert.match(await chat.text(), /"type":"delta"/);
  assert.equal((await request('/api/ai/runs/run-1', { method: 'DELETE', headers: { ...headers, Origin: 'https://study.example.com' } })).status, 200);
  assert.equal((await request('/api/ai/conversations/p1/q1', { headers })).status, 200);
  assert.equal((await request('/api/ai/diagram', { method: 'POST', headers: { ...headers, Origin: 'https://study.example.com', 'Content-Type': 'application/json' }, body: '{"kind":"polyline","points":[[0,0],[1,2]]}' })).status, 200);
  // 代理转发与准入判定使用同一套规范化路径：上游只收到归一化后的路径，且看不到外部 Origin。
  for (const item of seen) {
    assert.equal(item.origin, null, `upstream must not see Origin for ${item.method} ${item.url}`);
    assert.equal(item.remote, '1', `upstream must see the remote marker for ${item.method} ${item.url}`);
    assert.equal(item.host, `127.0.0.1:${upstream.address().port}`);
  }
  const forwarded = seen.map(item => item.url);
  assert.ok(forwarded.includes('/api/ai/profiles'));
  assert.ok(forwarded.includes('/api/ai/chat'));
  assert.ok(forwarded.includes('/api/ai/runs/run-1'));
  assert.ok(forwarded.includes('/api/ai/conversations/p1/q1'));
  assert.ok(!forwarded.some(url => /\/api\/ai\/profiles\/|\/models|\/test/.test(url)), 'no AI configuration path may be forwarded');
  const trailing = await request('/api/study-activity?days=3', { headers });
  assert.equal(trailing.status, 200);
  assert.equal((await trailing.json()).path, '/api/study-activity?days=3');
  assert.equal((await (await request('/api/state/', { headers })).json()).path, '/api/state');
  assert.equal((await (await request('/API/STATE', { headers })).json()).path, '/API/STATE');
  assert.equal((await (await request('/api/state%2Fquestions/1', { method: 'PATCH', headers: { ...headers, Origin: 'https://study.example.com' }, body: '{}' })).json()).path, '/api/state/questions/1');
  await gateway.revokeSessions();
  assert.equal((await request('/api/ai/profiles', { headers })).status, 401);
});

test('remote gateway applies the upstream /daguan-math prefix convention to policy and forwarding', async t => {
  // 规范化单元断言：判定复现上游“前缀最多剥离一次”，转发保留原始前缀。
  assert.equal(policyPath('/daguan-math/api/catalog/refresh'), '/api/catalog/refresh');
  assert.equal(policyPath('/daguan-math'), '/');
  assert.equal(policyPath('/daguan-math/'), '/');
  assert.equal(policyPath('/daguan-math/daguan-math/api/x'), '/daguan-math/api/x');
  assert.equal(policyPath('/%64aguan-math/api/ai/profiles'), '/api/ai/profiles');
  assert.equal(policyPath('/api/ai/profiles'), '/api/ai/profiles');
  assert.equal(forwardPath('/daguan-math/api/state'), '/daguan-math/api/state');
  assert.equal(forwardPath('/%64aguan-math/api/state'), '/daguan-math/api/state');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daguan-remote-prefix-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const gateway = createRemoteGateway({ authFile: path.join(dir, 'auth.json'), upstream: () => `http://127.0.0.1:${upstream.address().port}`, getMode: () => 'quick' });
  await gateway.init();
  await gateway.setPassword('a strong testing password');
  gateway.setPublicHost('study.example.com');
  const port = await gateway.start();
  t.after(() => gateway.stop());
  const base = `http://127.0.0.1:${port}`;
  const request = (route, options = {}) => new Promise((resolve, reject) => {
    const outgoing = http.request(base + route, { method: options.method || 'GET', headers: { Host: 'study.example.com', ...options.headers } }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('end', () => { const body = Buffer.concat(chunks).toString(); resolve({ status: incoming.statusCode, headers: { get: name => { const value = incoming.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; } }, text: () => body, json: async () => JSON.parse(body) }); });
    });
    outgoing.on('error', reject); outgoing.end(options.body);
  });
  const loggedIn = await request('/__remote/login', { method: 'POST', headers: { Origin: 'https://study.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a strong testing password' }) });
  assert.equal(loggedIn.status, 200);
  const headers = { Cookie: loggedIn.headers.get('set-cookie').split(';')[0] };

  // 带 /daguan-math 前缀（含编码变体）的管理面与 AI 配置路径，在网关层即被拦截。
  const blocked = [
    ['POST', '/daguan-math/api/catalog/refresh'],
    ['POST', '/daguan-math/api/runtime/stop'],
    ['GET', '/daguan-math/api/catalog/refresh/task-1'],
    ['POST', '/daguan-math/api/ai/profiles'],
    ['PATCH', '/daguan-math/api/ai/profiles/abc'],
    ['DELETE', '/daguan-math/api/ai/profiles/abc'],
    ['GET', '/daguan-math/api/ai/profiles/abc/models'],
    ['POST', '/daguan-math/api/ai/profiles/abc/test'],
    ['POST', '/daguan-math/api/tunnel/connect'],
    ['POST', '/daguan-math/api/admin/users'],
    ['GET', '/daguan-math/service-worker.js'],
    ['GET', '/daguan-math/api/state/events'],
    ['GET', '/%64aguan-math/api/catalog/refresh/task-1'],
    ['POST', '/%64aguan-math/api/ai/profiles'],
  ];
  for (const [method, route] of blocked) {
    const response = await request(route, { method, headers });
    assert.notEqual(response.status, 200, `${method} ${route} must not reach the local service`);
  }

  // 合法的带前缀学习请求照常转发，且保留原始前缀，由上游自行剥离一次。
  for (const route of ['/daguan-math/api/state', '/daguan-math/api/ai/profiles', '/%64aguan-math/api/state']) {
    const response = await request(route, { headers });
    assert.equal(response.status, 200, `${route}`);
  }
  assert.ok(seen.includes('/daguan-math/api/state'), 'prefixed path is forwarded with its prefix');
  assert.ok(seen.includes('/daguan-math/api/ai/profiles'));
  // 双重前缀不二次剥离：上游收到的仍是双前缀路径（真实服务据此 404）。
  const doubled = await request('/daguan-math/daguan-math/api/state', { headers });
  assert.equal(doubled.status, 200);
  assert.ok(seen.includes('/daguan-math/daguan-math/api/state'), 'double prefix is forwarded unchanged');
  for (const item of seen) assert.equal(item.includes('//'), false, `no empty segment may be forwarded: ${item}`);
});

test('remote gateway limits repeated password guesses and can change password', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daguan-remote-limit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const gateway = createRemoteGateway({ authFile: path.join(dir, 'auth.json'), upstream: () => 'http://127.0.0.1:1' });
  await gateway.init(); await gateway.setPassword('another strong password');
  gateway.setPublicHost('study.example.com');
  const port = await gateway.start(); t.after(() => gateway.stop());
  for (let i = 0; i < 5; i++) {
    const response = await new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port, path: '/__remote/login', method: 'POST', headers: { Host: 'study.example.com', Origin: 'https://study.example.com' } }, res => { res.resume(); res.on('end', () => resolve(res)); }); req.on('error', reject); req.end(JSON.stringify({ password: 'wrong' })); });
    assert.equal(response.statusCode, i === 4 ? 429 : 401);
  }
  await assert.rejects(gateway.setPassword('new strong password', 'wrong'));
  await gateway.setPassword('new strong password', 'another strong password');
  assert.equal(gateway.hasPassword(), true);
});
