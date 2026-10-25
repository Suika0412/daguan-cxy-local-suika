import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// 旧版同步能力（app-legacy.js 是 IIFE）：按既有做法切出代次相关代码，在 VM 中驱动真实实现。
const source = await fs.readFile(new URL('../web/app-legacy.js', import.meta.url), 'utf8');
const START = '  let serverStateHydrated = false;';
const END = '  function openIdb() {';
const start = source.indexOf(START);
const end = source.indexOf(END, start);
assert.ok(start > 0 && end > start, 'app-legacy.js 清除代次代码切片锚点缺失');
const block = source.slice(start, end);
// VM 里创建的对象原型与测试 realm 不同，比较前先 JSON 归一。
const plain = value => JSON.parse(JSON.stringify(value));

function progressResetStub(initial = 0) {
  let confirmed = null;
  let stamp = initial;
  return {
    calls: { adopt: [] },
    generationOf: state => (state && Object.prototype.hasOwnProperty.call(state, 'reset_generation') ? Number(state.reset_generation) : 0),
    current: () => confirmed,
    stored: () => stamp,
    capture() {
      if (confirmed === null) throw Object.assign(new Error('尚未确认清除代次'), { code: 'PROGRESS_GENERATION_UNKNOWN' });
      return confirmed;
    },
    isCurrent(generation) { return confirmed !== null && generation === confirmed && stamp === confirmed; },
    adopt(state) {
      const generation = this.generationOf(state);
      const baseline = confirmed === null ? 0 : confirmed;
      const changed = generation !== baseline;
      const storageChanged = generation !== stamp;
      this.calls.adopt.push(generation);
      confirmed = generation;
      stamp = generation;
      return { generation, changed, storageChanged };
    },
  };
}

function setup({ helper, responses = [], state: initialState, pauseImpl } = {}) {
  const swipes = [];
  const persisted = [];
  const toasts = [];
  const errors = [];
  const replayCalls = [];
  let pending = false;
  const calls = { pause: 0, resume: 0, fetch: [] };
  let cursor = 0;
  const state = initialState || {
    progress: { 1: { mastery: 'mastered', favorite: true }, 2: { mastery: 'learning' } },
    favorites: new Set(['1']),
    annotations: { 1: { markdown: 'keep' } },
    last_study: { category_id: '331', question_id: '1' },
    remote_activity: { marker: 'r' },
  };
  const sandbox = {
    console: { error: (...args) => errors.push(args.map(String).join(' ')) },
    AbortSignal,
    setTimeout, clearTimeout,
    POSITION_KEY: 'daguan_learning_position_v2',
    sessionStorage: { removed: swipes, removeItem(key) { swipes.push(key); } },
    state,
    flushPersist: () => persisted.push(JSON.parse(JSON.stringify(state.progress))),
    toast: message => toasts.push(message),
    hydrateServerState: async () => {},
    pendingHasAny: () => pending,
    replayPendingSync: () => replayCalls.push(pending),
    fetch: (url, options = {}) => {
      calls.fetch.push([String(url), options]);
      if (responses.length === 0) throw new Error(`unexpected fetch ${url}`);
      const next = typeof responses[0] === 'function' ? responses.shift()(url, options) : responses[cursor++];
      return Promise.resolve(next);
    },
    window: {
      DaguanVersions: helper === null ? {} : { progressReset: helper || progressResetStub(0) },
      DaguanStudyActivity: {
        async pauseForReset() { calls.pause += 1; return pauseImpl ? pauseImpl() : true; },
        async resumeAfterReset() { calls.resume += 1; return true; },
      },
    },
  };
  const code = `${block}\n;globalThis.__legacy = {
    clearProgress, captureResetGeneration, adoptServerGeneration, adoptResetResponse, applyProgressReset, resetApi,
    generation: () => serverResetGeneration,
    paused: () => learningWritesPaused,
    revision: () => serverRevision,
    queue: serverQuestionQueue,
    setGeneration: value => { serverResetGeneration = value; },
    setLastStudy: value => { lastStudyInFlight = value; },
  };`;
  vm.runInNewContext(code, sandbox);
  // 待同步标记由测试宿主持有，必须与 pendingHasAny 读同一份值。
  const api = { ...sandbox.__legacy, setPending: value => { pending = value; } };
  return { api, sandbox, state, calls, swipes, persisted, toasts, errors, replayCalls };
}

const okResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('缺少共享清除代次模块时显式失败，不静默兜底', () => {
  const { api } = setup({ helper: null });
  assert.throws(() => api.captureResetGeneration(), error => error.code === 'PROGRESS_RESET_UNAVAILABLE');
  assert.throws(() => api.resetApi(), /缺少共享清除代次模块/);
});

test('本页代次与共享 helper 不一致时不得发出学习写入', () => {
  const helper = progressResetStub(0);
  const { api } = setup({ helper });
  assert.throws(() => api.captureResetGeneration(), error => error.code === 'PROGRESS_GENERATION_UNKNOWN');
  api.setGeneration(0);
  helper.adopt({ reset_generation: 1, revision: 4 });
  assert.throws(() => api.captureResetGeneration(), error => error.code === 'PROGRESS_RESET_MEMORY_STALE');
  assert.equal(api.generation(), 0, '不擅自把旧内存标成新代次');
});

test('代次前进时用服务端进度替换旧内存，保留收藏批注并丢弃旧练习队列与位置', () => {
  const helper = progressResetStub(0);
  const { api, sandbox, state, swipes, toasts } = setup({ helper });
  api.setGeneration(0);
  api.queue.set('9', { mastery: 'learning' });
  const result = api.adoptServerGeneration({ reset_generation: 1, revision: 7, progress: {}, last_study: null, remote_activity: null });
  assert.deepEqual(plain(result), { generation: 1, changed: true });
  assert.deepEqual(plain(state.progress), {}, '旧练习进度不得保留');
  assert.equal(state.last_study, null);
  assert.deepEqual([...state.favorites], ['1'], '收藏保留');
  assert.deepEqual(plain(state.annotations), { 1: { markdown: 'keep' } }, '批注保留');
  assert.equal(api.queue.size, 0, '旧练习队列作废');
  assert.equal(api.revision(), 7);
  assert.equal(api.generation(), 1);
  assert.deepEqual(swipes, ['daguan_learning_position_v2'], '位置双存储的会话副本清除');
  assert.equal(toasts.length, 1);
  assert.ok(sandbox, 'sandbox 可用');
});

test('同代次仍保留离线合并语义，不触发失效', () => {
  const helper = progressResetStub(0);
  const { api, state, swipes } = setup({ helper });
  api.setGeneration(0);
  const result = api.adoptServerGeneration({ reset_generation: 0, revision: 3, progress: { 2: { mastery: 'mastered' } } });
  assert.deepEqual(plain(result), { generation: 0, changed: false });
  assert.deepEqual(Object.keys(state.progress).sort(), ['1', '2'], '未清除时不整份替换');
  assert.equal(swipes.length, 0);
});

test('clearProgress 成功：先暂停、带 If-Match 与发起时代次提交，并重置本页内存与位置', async () => {
  const helper = progressResetStub(0);
  helper.adopt({ reset_generation: 0, revision: 5 });
  const { api, state, calls, swipes, replayCalls } = setup({
    helper,
    responses: [
      () => okResponse({ revision: 5, reset_generation: 0, progress: { 1: { mastery: 'mastered' } }, favorites: ['1'] }),
      () => okResponse({ ok: true, revision: 6, reset_generation: 1, state: { revision: 6, reset_generation: 1, progress: {}, favorites: ['1'], last_study: null } }),
    ],
  });
  api.setGeneration(0);
  api.setPending(true);
  const result = await api.clearProgress();
  assert.deepEqual(plain(result), { cleared: true, generation: 1, revision: 6 });
  assert.equal(calls.pause, 1, '清除前必须暂停学习记录写入');
  assert.equal(calls.resume, 1, '清除后必须恢复写入');
  const [, body] = calls.fetch.at(-1);
  assert.equal(calls.fetch.at(-1)[0], './api/state/clear-progress');
  assert.equal(body.headers['If-Match'], '5', '使用握手得到的 revision');
  assert.deepEqual(JSON.parse(body.body), { revision: 5, reset_generation: 0 }, '携带发起时捕获的代次');
  assert.deepEqual(plain(state.progress), {}, '本页旧练习归零');
  assert.equal(state.last_study, null);
  assert.deepEqual([...state.favorites], ['1'], '收藏保留');
  assert.equal(api.generation(), 1);
  assert.ok(swipes.includes('daguan_learning_position_v2'));
  assert.equal(api.paused(), false);
  assert.deepEqual(replayCalls, [true], '待同步收藏/批注在恢复写入后重放一次');
});

test('clearProgress 遇到 409 不自动重发，也不预删本地记录', async () => {
  const helper = progressResetStub(0);
  helper.adopt({ reset_generation: 0, revision: 5 });
  const { api, state, calls } = setup({
    helper,
    responses: [
      () => okResponse({ revision: 5, reset_generation: 0, progress: {} }),
      () => okResponse({ ok: false, code: 'STATE_CONFLICT', current: { revision: 6 } }, 409),
    ],
  });
  api.setGeneration(0);
  await assert.rejects(api.clearProgress(), error => error.code === 'PROGRESS_RESET_CONFLICT');
  assert.equal(calls.fetch.filter(([url]) => url.includes('clear-progress')).length, 1, '不得自动重发清除');
  assert.deepEqual(Object.keys(state.progress).sort(), ['1', '2'], '服务端未提交时本地记录不得删除');
  assert.equal(api.generation(), 0);
});

test('clearProgress 遇到 428 采纳服务端代次并显式上报，不换代次重发', async () => {
  const helper = progressResetStub(0);
  helper.adopt({ reset_generation: 0, revision: 5 });
  const { api, state, calls } = setup({
    helper,
    responses: [
      () => okResponse({ revision: 5, reset_generation: 0, progress: {} }),
      () => okResponse({ ok: false, code: 'PROGRESS_RESET_REQUIRED', current: { revision: 9, reset_generation: 2, progress: {}, last_study: null } }, 428),
    ],
  });
  api.setGeneration(0);
  await assert.rejects(api.clearProgress(), error => error.code === 'PROGRESS_RESET_REQUIRED');
  assert.equal(calls.fetch.filter(([url]) => url.includes('clear-progress')).length, 1);
  assert.equal(api.generation(), 2);
  assert.deepEqual(plain(state.progress), {}, '旧练习失效');
  assert.equal(state.last_study, null);
});

test('clearProgress 部分完成（state 已升代次）显式报 PARTIAL，不假成功也不重建旧记录', async () => {
  const helper = progressResetStub(0);
  helper.adopt({ reset_generation: 0, revision: 5 });
  const { api, state, calls } = setup({
    helper,
    responses: [
      () => okResponse({ revision: 5, reset_generation: 0, progress: {} }),
      () => okResponse({ ok: false, code: 'ACTIVITY_RESET_FAILED', error: '学习手账与战报清理未完成', current: { revision: 6, reset_generation: 1 } }, 500),
      () => okResponse({ revision: 6, reset_generation: 1, progress: {}, last_study: null }),
    ],
  });
  api.setGeneration(0);
  await assert.rejects(api.clearProgress(), error => error.code === 'PROGRESS_RESET_PARTIAL' && /学习手账与战报清理未完成/.test(error.message));
  assert.equal(calls.resume, 1);
  assert.equal(api.generation(), 1, '采纳服务端已提交的代次');
  assert.deepEqual(plain(state.progress), {});
});

test('clearProgress 响应丢失且服务端未提交时保留本地记录并报结果未知', async () => {
  const helper = progressResetStub(0);
  helper.adopt({ reset_generation: 0, revision: 5 });
  const { api, state, calls } = setup({
    helper,
    responses: [
      () => okResponse({ revision: 5, reset_generation: 0, progress: {} }),
      () => { throw new Error('network down'); },
      () => okResponse({ revision: 5, reset_generation: 0, progress: { 1: { mastery: 'mastered' } } }),
    ],
  });
  api.setGeneration(0);
  await assert.rejects(api.clearProgress(), error => error.code === 'PROGRESS_RESET_UNKNOWN');
  assert.deepEqual(Object.keys(state.progress).sort(), ['1', '2'], '本地记录保留');
  assert.equal(api.generation(), 0);
  assert.equal(calls.resume, 1);
});

test('并发清除被显式拒绝：第二次返回 BUSY 且不发出第二个清除请求', async () => {
  const helper = progressResetStub(0);
  helper.adopt({ reset_generation: 0, revision: 5 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { api, calls } = setup({
    helper,
    pauseImpl: () => gate,
    responses: [
      () => okResponse({ revision: 5, reset_generation: 0, progress: {} }),
      () => okResponse({ ok: true, revision: 6, reset_generation: 1, state: { revision: 6, reset_generation: 1, progress: {}, last_study: null } }),
    ],
  });
  api.setGeneration(0);
  const first = api.clearProgress();
  await assert.rejects(api.clearProgress(), error => error.code === 'PROGRESS_RESET_BUSY');
  release();
  await first;
  assert.equal(calls.fetch.filter(([url]) => url.includes('clear-progress')).length, 1, '只允许一次清除请求');
});

test('在飞的最近学习位置写入失败不阻塞清除，并显式上报', async () => {
  const helper = progressResetStub(0);
  helper.adopt({ reset_generation: 0, revision: 5 });
  const { api, errors } = setup({
    helper,
    responses: [
      () => okResponse({ revision: 5, reset_generation: 0, progress: {} }),
      () => okResponse({ ok: true, revision: 6, reset_generation: 1, state: { revision: 6, reset_generation: 1, progress: {}, last_study: null } }),
    ],
  });
  api.setGeneration(0);
  let rejectNow;
  const inflight = new Promise((_, reject) => { rejectNow = reject; }).finally(() => api.setLastStudy(null));
  api.setLastStudy(inflight);
  const running = api.clearProgress();
  rejectNow(new Error('位置写入失败'));
  const result = await running;
  assert.equal(result.cleared, true);
  assert.ok(errors.some(text => text.includes('等待在飞的最近学习位置写入失败')), '失败必须显式上报');
});

test('在飞 promise 永不结算时按剩余时间超时报 BUSY，不无限等待', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const helper = progressResetStub(0);
  helper.adopt({ reset_generation: 0, revision: 5 });
  const { api, calls } = setup({ helper });
  api.setGeneration(0);
  api.setLastStudy(new Promise(() => {}));
  const running = api.clearProgress();
  t.mock.timers.tick(10001);
  await assert.rejects(running, error => error.code === 'PROGRESS_RESET_BUSY' && /超时/.test(error.message));
  assert.equal(calls.fetch.length, 0, '超时后不得发出清除请求');
  assert.equal(calls.resume, 1, '超时也要恢复写入');
});

test('未暂停时代次前进立即重放待同步收藏，没有待同步项时不重放', () => {
  const helper = progressResetStub(0);
  const { api, replayCalls } = setup({ helper });
  api.setGeneration(0);
  api.setPending(true);
  api.adoptServerGeneration({ reset_generation: 1, revision: 3, progress: {} });
  assert.deepEqual(replayCalls, [true]);
  api.setPending(false);
  api.adoptServerGeneration({ reset_generation: 2, revision: 4, progress: {} });
  assert.deepEqual(replayCalls, [true], '无待同步项时不安排重放');
});

test('旧版本机备份区提供清除入口，且只在输入“清除”后调用清除能力', async () => {
  const html = await fs.readFile(new URL('../web/legacy.html', import.meta.url), 'utf8');
  const status = html.indexOf('id="clear-progress-status"');
  const block = html.slice(html.indexOf('id="btn-clear-progress"') - 700, status);
  assert.ok(status > 0 && block.length > 0, '本机备份区缺少清除入口或状态位');
  for (const text of ['不可撤销', '收藏', '批注', '选题', '备忘', '浏览历史', 'AI', '官网', '下载备份', '手账']) {
    assert.match(block, new RegExp(text), `危险操作区缺少说明：${text}`);
  }
  const handler = source.slice(source.indexOf('$("#btn-clear-progress").addEventListener'));
  assert.ok(handler.length > 0, '缺少清除按钮绑定');
  assert.match(handler, /prompt\(/);
  assert.match(handler, /confirmed !== "清除"/);
  assert.match(handler, /button\.disabled = true/);
  assert.match(handler, /await clearProgress\(\)/);
  assert.match(handler, /refreshSyncStats\(\)/);
  assert.match(handler, /清除未完成：/, '失败必须按具体原因提示，不能显示成功');
  assert.ok(handler.indexOf('confirmed !== "清除"') < handler.indexOf('await clearProgress()'), '取消或输入不匹配时不得调用写接口');
});

// ---------------------------------------------------------------------------
// 旧版 IndexedDB 进度缓存必须与清除代次绑定：清除后首次启动旧版不得复活旧练习。
// ---------------------------------------------------------------------------
function legacySlice(startAnchor, endAnchor) {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start);
  assert.ok(start > 0 && end > start, `${startAnchor} 切片锚点缺失`);
  return source.slice(start, end);
}
const mergeBlock = legacySlice('  function mergeProgress(a, b) {', '  function practiceTimestamp(progress) {');
const cacheGenerationBlock = legacySlice('  function cacheResetGeneration() {', '  function applyProgressReset(remote) {');
const persistBlock = legacySlice('  function flushPersist() {', '  function schedulePersist() {');
const atomicCacheBlock = legacySlice('  function idbSetPracticeCache(progress, generation) {', '  function idbDelete(key) {');
const hydrateStoresBlock = legacySlice('  async function hydrateStores() {', '  async function hydrateServerState() {');

function hydrateStoresFixture({ stored, idbProgress, idbGeneration, failOn } = {}) {
  const idbStore = new Map();
  if (idbProgress !== undefined) idbStore.set('progress', idbProgress);
  if (idbGeneration !== undefined) idbStore.set('reset_generation', idbGeneration);
  const errors = [];
  const state = { progress: {}, picked: new Set(), favorites: new Set(), annotations: {}, savedAt: 0 };
  // 假事务：某个键写入抛错即整体中止，绝不提交其它键（与真实 IDB 事务语义一致）。
  const openIdb = async () => ({
    transaction: () => {
      const pending = [];
      const hooks = { oncomplete: null, onerror: null, onabort: null };
      let aborted = false;
      const transaction = {
        objectStore: () => ({
          put: (value, key) => {
            if (failOn === key) {
              aborted = true;
              throw new Error(`写入 ${key} 失败`);
            }
            pending.push([key, value]);
          },
        }),
      };
      for (const name of Object.keys(hooks)) Object.defineProperty(transaction, name, { set: fn => { hooks[name] = fn; }, get: () => hooks[name] });
      Promise.resolve().then(() => {
        if (aborted) {
          if (hooks.onabort) hooks.onabort();
          return;
        }
        for (const [key, value] of pending) idbStore.set(key, value);
        if (hooks.oncomplete) hooks.oncomplete();
      });
      return transaction;
    },
  });
  const sandbox = {
    PROGRESS_KEY: 'daguan_local_progress_v1',
    PICK_KEY: 'daguan_local_picked_v1',
    FAVORITE_KEY: 'daguan_local_favorites_v1',
    ANNOTATION_KEY: 'daguan_question_annotations_v1',
    state,
    persistTimer: 0,
    serverStateAvailable: false,
    serverResetGeneration: null,
    localStorage: { setItem: () => {} },
    console: { error: (...args) => errors.push(args.map(String).join(' ')) },
    openIdb,
    resetFailure: (code, message) => Object.assign(new Error(message), { code }),
    idbGet: async key => idbStore.get(key),
    idbSet: async (key, value) => { idbStore.set(key, value); },
    idbDelete: async key => { idbStore.delete(key); },
    resetApi: () => ({ stored: () => stored }),
    previewPrivateAllowed: () => true,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(mergeBlock + cacheGenerationBlock + atomicCacheBlock + persistBlock + hydrateStoresBlock, sandbox);
  return { sandbox, idbStore, state, errors };
}

// flushPersist 的原子写是 fire-and-forget，断言前先让它落地一个微任务。
const settleIdb = () => new Promise(resolve => setTimeout(resolve, 0));

test('旧版 IDB 缓存代次不符时不并入进度，并显式改写缓存代次', async () => {
  // 无代次键的旧缓存按 0 处理；本页已确认代次 1（清除后），不得复活旧练习
  const stale = hydrateStoresFixture({ stored: 1, idbProgress: { 1: { mastery: 'mastered' } } });
  await stale.sandbox.hydrateStores();
  await settleIdb();
  assert.deepEqual(plain(stale.state.progress), {}, '旧代次 IDB 进度不得并回本页');
  assert.equal(stale.idbStore.get('reset_generation'), 1, `缓存代次键必须更新为当前代次（错误：${stale.errors.join(' | ')}）`);
  assert.deepEqual(plain(stale.idbStore.get('progress')), {}, '旧 IDB 进度必须被当前代次内容替换');

  const older = hydrateStoresFixture({ stored: 2, idbProgress: { 1: { mastery: 'learning' } }, idbGeneration: 0 });
  await older.sandbox.hydrateStores();
  await settleIdb();
  assert.deepEqual(plain(older.state.progress), {}, '缓存代次 0 与页面代次 2 不符时同样不得合并');
  assert.equal(older.idbStore.get('reset_generation'), 2, `缓存代次应更新为 2（错误：${older.errors.join(' | ')}）`);
});

test('旧版同代次 IDB 缓存仍可作为离线记录并入', async () => {
  const current = hydrateStoresFixture({ stored: 1, idbProgress: { 2: { mastery: 'learning', updated_at: '2026-10-01T00:00:00.000Z' } }, idbGeneration: 1 });
  await current.sandbox.hydrateStores();
  assert.deepEqual(Object.keys(plain(current.state.progress)), ['2'], '同代次离线记录必须保留');
  assert.equal(current.idbStore.get('reset_generation'), 1);
});

test('旧版缓存原子写失败时不得出现新代次戳配旧 progress', async () => {
  // 事务在写代次戳时失败：进度与代次都不提交，且必须显式报告
  const failing = hydrateStoresFixture({ stored: 1, idbProgress: { 1: { mastery: 'mastered' } }, failOn: 'reset_generation' });
  await failing.sandbox.hydrateStores();
  await settleIdb();
  assert.equal(failing.idbStore.has('reset_generation'), false, '失败时不得写入新代次戳');
  assert.deepEqual(plain(failing.idbStore.get('progress')), { 1: { mastery: 'mastered' } }, '事务中止后旧 progress 保持不变，不会被冒充成新代次');
  assert.equal(Object.keys(plain(failing.state.progress)).length, 0, '本页仍不复活旧练习');
  assert.ok(failing.errors.some(line => line.includes('未更新缓存代次')), `读取/对齐失败必须显式记录，不能静默成功（实际：${failing.errors.join(' | ')}）`);
});
