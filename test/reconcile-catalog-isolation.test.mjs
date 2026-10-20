import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { listenHttp } from './http-fixture.mjs';
import { serviceFixture } from './runtime-fixture.mjs';

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value)}\n`);
}

// 本地题序故意不按题号升序，作为“已做好的题库内容”保留对象。
const LOCAL_ORDER = ['3', '1'];
const UNKNOWN_ID = '99999';

async function buildWebData(rootDir) {
  const dataDir = path.join(rootDir, 'web', 'data');
  const questions = [
    { id: '3', type: 'subjective', stem: '题3', source: 'fixture' },
    { id: '1', type: 'subjective', stem: '题1', source: 'fixture' },
  ];
  await writeJson(path.join(dataDir, 'manifest.json'), {
    version: 7,
    total: questions.length,
    types: { subjective: questions.length },
    shards: { 高等数学: { file: 'shards/高等数学.json', count: questions.length } },
    asset_count: 0,
    asset_base: './data/assets/',
    synced_at: '2026-10-01T00:00:00.000Z',
    source: 'fixture',
    source_total: questions.length,
  });
  await writeJson(path.join(dataDir, 'shards/高等数学.json'), questions);
  await writeJson(path.join(dataDir, 'id_index.json'), { 3: '高等数学', 1: '高等数学' });
  await writeJson(path.join(dataDir, 'categories.json'), [{ id: 1, name: '数学', children: [] }]);
  await writeJson(path.join(dataDir, 'category_questions.json'), { 1: LOCAL_ORDER.slice() });
  await writeJson(path.join(dataDir, 'search_index.json'), questions.map(question => ({
    id: question.id, source: question.source, type: question.type, path: '', serial: null, stem: question.stem,
  })));
  return dataDir;
}

async function hashTree(dataDir) {
  const entries = [];
  const walk = async dir => {
    const dirents = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) { await walk(full); continue; }
      entries.push({ path: path.relative(dataDir, full).replaceAll('\\', '/'), sha256: sha256(await fs.readFile(full)) });
    }
  };
  await walk(dataDir);
  return entries;
}

// preview/apply 期间的远端调用全部是只读 GET；远端写请求（需要 CSRF）在本用例不应出现。
const EXPECTED_PATHS = new Set([
  '/api/questions/mastery-map',
  '/api/user/activity_calendar',
  '/api/questions/user/last_study',
]);

async function startRemoteStub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const unexpected = !EXPECTED_PATHS.has(url.pathname);
    calls.push({ method: req.method, path: url.pathname, search: url.search, unexpected });
    if (unexpected) {
      // 未预期路径必须显式失败，避免测试悄悄依赖新的远端契约。
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `unexpected remote path: ${url.pathname}` }));
      return;
    }
    let body;
    if (url.pathname === '/api/questions/mastery-map') {
      body = { data: { states: [
        { question_id: '1', mastery: 'mastered', favorited_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-05T00:00:00Z' },
        { question_id: UNKNOWN_ID, mastery: 'mastered', updated_at: '2026-10-05T00:00:00Z' },
      ] } };
    } else if (url.pathname === '/api/user/activity_calendar') body = { data: {} };
    else body = { data: null };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await listenHttp(server);
  return { server, calls, base: `http://127.0.0.1:${server.address().port}` };
}

test('进度同步 preview/apply 不修改题库，未知题号仍报告', { timeout: 30000 }, async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daguan-reconcile-root-'));
  t.after(async () => { await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const dataDir = await buildWebData(rootDir);

  const stub = await startRemoteStub();
  t.after(async () => { await new Promise(resolve => stub.server.close(resolve)); });

  const fixture = await serviceFixture(t, { rootDir, baseUrl: stub.base });
  await fs.writeFile(path.join(fixture.dir, 'cxyonly-integration.json'), `${JSON.stringify({
    format: 'daguan-cxyonly-integration', version: 1, base_url: stub.base, token: 'test-token',
  })}\n`);

  const before = await hashTree(dataDir);
  const post = (route, body) => fetch(fixture.base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  // --- preview：只读，不得触碰题库 ---
  const previewResponse = await post('/api/integrations/cxyonly/reconcile/preview', {});
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.catalog.total, 2, 'catalog.total 应来自本地 manifest');
  assert.equal(preview.catalog.version, 7, 'catalog.version 应来自本地 manifest');
  assert.equal(Object.hasOwn(preview.catalog, 'refreshed'), false, '预览不应再带 refreshed');
  assert.deepEqual(preview.unknownIds, [UNKNOWN_ID], '预览应报告未知题号');
  assert.deepEqual(await hashTree(dataDir), before, 'preview 不得修改题库');

  // --- apply：合并进度，仍不得触碰题库 ---
  const applyResponse = await post('/api/integrations/cxyonly/reconcile/apply', {
    previewId: preview.previewId, winner: preview.winner,
  });
  assert.equal(applyResponse.status, 200);
  const applied = await applyResponse.json();
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.unknownIds, [UNKNOWN_ID], 'apply 应继续报告未知题号');

  const state = await (await fetch(fixture.base + '/api/state')).json();
  assert.equal(state.progress['1'].mastery, 'mastered', '已知题进度应落到隔离 state');
  assert.deepEqual(state.favorites, ['1'], '已知题收藏应落到隔离 state');
  assert.ok(state.pending_unknown_states[UNKNOWN_ID], '未知题号应进入 pending_unknown_states');
  assert.deepEqual(await hashTree(dataDir), before, 'apply 不得修改题库');

  // --- 远端契约：全部走 stub，无未预期路径 ---
  t.diagnostic(`远端调用序列：${stub.calls.map(call => `${call.method} ${call.path}${call.search}`).join(' | ')}`);
  assert.deepEqual(stub.calls.filter(call => call.unexpected), [], '所有远端请求都必须命中预期路径');
  for (const expectedPath of EXPECTED_PATHS) {
    assert.ok(stub.calls.some(call => call.path === expectedPath), `缺少预期远端请求 ${expectedPath}`);
  }
  assert.deepEqual(stub.calls.filter(call => call.method !== 'GET'), [], '本用例不应产生远端写请求');
});
