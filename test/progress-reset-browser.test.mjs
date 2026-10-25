import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { serviceFixture } from './runtime-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.DAGUAN_PLAYWRIGHT_MODULE || 'playwright');

const launchOptions = process.env.DAGUAN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.DAGUAN_CHROMIUM_EXECUTABLE } : {};
const LEAF = '331';
// 用题库真实题号：旧版“继续学习”按题号定位到该小节，才能进入单题页。
const leafIds = JSON.parse(await fs.readFile(new URL('../web/data/category_questions.json', import.meta.url), 'utf8'))[LEAF];
assert.ok(Array.isArray(leafIds) && leafIds.length, '题库缺少分类 331 的题号，无法定位单题页');
const QUESTION = String(leafIds[0]);

async function openBrowser(t) {
  const { base, dir } = await serviceFixture(t);
  const browser = await chromium.launch(launchOptions);
  t.after(() => browser.close());
  const openContext = () => browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Hong_Kong', serviceWorkers: 'block' });
  return { base, dir, browser, openContext };
}

const api = base => ({
  async state() { return (await (await fetch(base + '/api/state')).json()); },
  async activity() { return (await (await fetch(base + '/api/study-activity/export')).json()); },
  async history() { return (await (await fetch(base + '/api/visit-history')).json()); },
  async send(route, method, value) {
    return fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  },
  async waitState(predicate, label, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const state = await this.state();
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const state = await this.state();
    throw new Error(`等待服务端状态超时：${label}（当前 progress=${JSON.stringify(state.progress)}）`);
  },
});

// 种子数据全部通过正式 HTTP 接口写入，不手改存活服务的文件。
async function seedProgress(base) {
  const state = await (await fetch(base + '/api/state')).json();
  const response = await fetch(base + '/api/state', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      revision: state.revision,
      progress: { [QUESTION]: { mastery: 'learning', seen: true, last_practiced_at: Date.now(), updated_at: new Date().toISOString() } },
      favorites: [QUESTION], picked: [QUESTION],
      annotations: { [QUESTION]: { markdown: '保留批注', updated_at: '2026-10-01T00:00:00Z' } },
      last_study: { category_id: LEAF, question_id: QUESTION, mode: 'list', updated_at: new Date().toISOString() },
    }),
  });
  assert.equal(response.status, 200);
  const events = await fetch(base + '/api/study-activity/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [{ event_id: 'event-seed-0001', question_id: QUESTION, type: 'answer', at: new Date(Date.now() - 60000).toISOString(), correct: false, reliable: true, chapter_name: '极限' }] }),
  });
  assert.equal(events.status, 200);
  const visit = await fetch(base + '/api/visit-history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question_id: QUESTION, category_id: LEAF, visited_at: new Date().toISOString() }),
  });
  assert.equal(visit.status, 200);
}

// 用正式接口写最近学习位置：必须带当时的 revision 与清除代次（服务端学习写入守卫）。
async function setLastStudy(base, mode) {
  const state = await (await fetch(base + '/api/state')).json();
  const response = await fetch(base + '/api/state/last-study', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: state.revision, reset_generation: state.reset_generation, category_id: LEAF, question_id: QUESTION, mode }),
  });
  assert.equal(response.status, 200, '最近学习位置写入应成功');
}

async function openLegacy(context, base, entry = null) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // ?entry=backup 是旧版自己的落地入口路由，会打开“进度”对话框（本机备份页）。
  await page.goto(base + '/legacy.html' + (entry ? `?entry=${entry}` : ''));
  await page.waitForFunction(() => window.DaguanBrowserMigration && document.querySelector('#btn-sync'));
  return { page, errors };
}

async function openLegacyDialog(page) {
  // ?entry=backup 会由旧版自己的入口路由打开对话框；否则退回侧栏“进度备份”按钮。
  const autoOpened = await page.waitForSelector('#btn-clear-progress', { state: 'visible', timeout: 10000 }).then(() => true, () => false);
  if (autoOpened) return;
  await page.evaluate(() => document.querySelector('#btn-sync').click());
  await page.waitForSelector('#btn-clear-progress', { state: 'visible' });
}

async function clearViaLegacy(page, answer) {
  page.once('dialog', dialog => (answer === null ? dialog.dismiss() : dialog.accept(answer)));
  await page.locator('#btn-clear-progress').click();
}

async function openNewTools(context, base) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/index.html?ui=new');
  await page.waitForFunction(() => window.StateSync?.hydrated && document.querySelector('[data-view="tools"]'));
  await page.locator('[data-view="tools"]').click();
  await page.waitForSelector('#btn-clear-progress', { state: 'visible' });
  return { page, errors };
}

async function clearViaNew(page, answer = '清除') {
  page.once('dialog', dialog => (answer === null ? dialog.dismiss() : dialog.accept(answer)));
  await page.locator('#btn-clear-progress').click();
}

test('旧版清除入口：取消与错词不发请求，精确“清除”后服务端清零且保留项不变', { timeout: 90000 }, async t => {
  const { base, openContext } = await openBrowser(t);
  const call = api(base);
  await seedProgress(base);
  const context = await openContext();
  const { page, errors } = await openLegacy(context, base, 'backup');
  const clears = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/state/clear-progress')) clears.push(request.postData());
  });
  await openLegacyDialog(page);

  await clearViaLegacy(page, null);
  await page.waitForTimeout(800);
  assert.equal(clears.length, 0, '取消不得发出清除请求');
  await clearViaLegacy(page, '清除吧');
  await page.waitForFunction(() => document.querySelector('#clear-progress-status')?.textContent.includes('输入不匹配'));
  assert.equal(clears.length, 0, '错词不得发出清除请求');
  assert.deepEqual(Object.keys((await call.state()).progress), [QUESTION], '未确认前不得清除');

  await clearViaLegacy(page, '清除');
  await page.waitForFunction(() => document.querySelector('#clear-progress-status')?.textContent.includes('已清除做题记录与进度'));
  assert.equal(clears.length, 1, '确认后只发一次清除请求');
  const cleared = await call.waitState(state => state.reset_generation === 1, '代次推进');
  assert.deepEqual(cleared.progress, {});
  assert.equal(cleared.last_study, null);
  const activity = await call.activity();
  assert.deepEqual(activity.events, {});
  assert.deepEqual(activity.baseline, {});
  assert.deepEqual(cleared.favorites, [QUESTION], '收藏保留');
  assert.equal(cleared.annotations[QUESTION].markdown, '保留批注', '批注保留');
  assert.deepEqual(cleared.picked, [QUESTION], '选题保留');
  assert.equal((await call.history()).entries.length, 1, '浏览历史保留');

  await page.reload();
  await page.waitForFunction(() => window.DaguanBrowserMigration && document.querySelector('#btn-sync'));
  await page.waitForTimeout(1200);
  assert.deepEqual((await call.state()).progress, {}, '刷新后不复活旧记录');
  await page.goto(base + '/index.html?ui=new');
  await page.waitForFunction(() => window.StateSync?.hydrated);
  await page.waitForTimeout(600);
  assert.deepEqual((await call.state()).progress, {}, '切到新版不复活旧记录');
  assert.deepEqual(errors, []);
});

test('旧版清除后重绘不自动新建练习记录：跨窗口刷新保持清零并退出旧题', { timeout: 120000 }, async t => {
  const { base, openContext } = await openBrowser(t);
  const call = api(base);
  await seedProgress(base);
  // 用服务端 learn-position 让旧版按既有“继续学习”逻辑落到单题页（真实前端路径）。
  await setLastStudy(base, 'single');
  // 窗口 B：普通打开，随后收到清除事件会重绘单题页。
  const readerContext = await openContext();
  const { page: reader } = await openLegacy(readerContext, base);
  await reader.waitForSelector('#single-mastery .chip[data-mastery]', { timeout: 25000 });
  // 窗口 A：经旧版自己的入口打开“进度→本机备份”，发起清除。
  const actorContext = await openContext();
  const { page: actor } = await openLegacy(actorContext, base, 'backup');
  await openLegacyDialog(actor);
  await clearViaLegacy(actor, '清除');
  await actor.waitForFunction(() => document.querySelector('#clear-progress-status')?.textContent.includes('已清除'));
  await call.waitState(state => state.reset_generation === 1, '代次推进');
  await new Promise(resolve => setTimeout(resolve, 4000));
  const state = await call.state();
  assert.equal(state.reset_generation, 1);
  assert.deepEqual(state.progress, {}, `清除后重绘不得新建练习记录（实际 ${JSON.stringify(state.progress)}）`);
  assert.equal(state.last_study, null, '继续学习指针不得被重绘重新写回');
  const readerView = await reader.evaluate(() => document.body.dataset.view);
  assert.equal(readerView, 'home', '收到清除的旧窗口应退出旧题回到首页');
  assert.equal(await reader.locator('#single-mastery').isVisible(), false, '旧题视图不得继续渲染');
});

test('旧版在自身题页发起清除：清除后保持清零并回首页', { timeout: 120000 }, async t => {
  const { base, openContext } = await openBrowser(t);
  const call = api(base);
  await seedProgress(base);
  await setLastStudy(base, 'single');
  const context = await openContext();
  const { page } = await openLegacy(context, base);
  await page.waitForSelector('#single-mastery .chip[data-mastery]', { timeout: 25000 });
  // 桌面布局下侧栏“进度备份”被 CSS 隐藏，这里触发同一个 click 监听器打开既有弹层。
  await page.evaluate(() => document.querySelector('#btn-sync').click());
  await page.waitForSelector('#btn-clear-progress', { state: 'visible' });
  await clearViaLegacy(page, '清除');
  await page.waitForFunction(() => document.querySelector('#clear-progress-status')?.textContent.includes('已清除'));
  await call.waitState(state => state.reset_generation === 1, '代次推进');
  await page.waitForTimeout(3000);
  const state = await call.state();
  assert.deepEqual(state.progress, {}, `自身题页清除成功后不得新建练习记录（实际 ${JSON.stringify(state.progress)}）`);
  assert.equal(state.last_study, null);
  assert.equal(await page.evaluate(() => document.body.dataset.view), 'home', '清除成功后旧题页应回首页');
});

test('先旧版建 IndexedDB 缓存、再由新版清除后重开旧版：不复活旧进度', { timeout: 120000 }, async t => {
  const { base, openContext } = await openBrowser(t);
  const call = api(base);
  await seedProgress(base);
  const context = await openContext();
  const { page: legacy } = await openLegacy(context, base);
  // 等旧版把服务端进度写进 IndexedDB 缓存（同一 profile 后续还要复用）。
  await legacy.waitForFunction(() => window.DaguanBrowserMigration);
  const readCache = () => legacy.evaluate(() => new Promise(resolve => {
    const open = indexedDB.open('daguan-math', 1);
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('kv')) { resolve(null); db.close(); return; }
      const store = db.transaction('kv', 'readonly').objectStore('kv');
      const progress = store.get('progress'), generation = store.get('reset_generation');
      progress.onsuccess = () => {
        const value = progress.result || null;
        generation.onsuccess = () => { resolve({ progress: value, generation: generation.result }); db.close(); };
        generation.onerror = () => { resolve({ progress: value, generation: null }); db.close(); };
      };
      progress.onerror = () => { resolve(null); db.close(); };
    };
  }));
  let cached = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    cached = await readCache();
    if (cached && cached.progress && Object.keys(cached.progress).includes(QUESTION)) break;
    await legacy.waitForTimeout(100);
  }
  assert.ok(cached && cached.progress && Object.keys(cached.progress).includes(QUESTION), '旧版应先建立包含旧练习的 IndexedDB 缓存');

  // 关闭旧页再清除：避免存活页面的 SSE/refresh 先把 IDB 缓存改掉，才能证明“关闭后重开”不复活。
  await legacy.close();
  const { page: fresh } = await openNewTools(context, base);
  await clearViaNew(fresh);
  await fresh.waitForFunction(() => document.querySelector('#clear-progress-result')?.textContent.includes('已清除'), null, { timeout: 20000 });
  await call.waitState(state => state.reset_generation === 1, '代次推进');

  const reopened = await context.newPage();
  await reopened.goto(base + '/legacy.html');
  await reopened.waitForFunction(() => window.DaguanBrowserMigration && document.querySelector('#btn-sync'));
  await reopened.waitForTimeout(3000);
  const after = await call.state();
  assert.equal(after.reset_generation, 1);
  assert.deepEqual(after.progress, {}, `重开旧版不得用 IndexedDB 旧缓存复活进度（实际 ${JSON.stringify(after.progress)}）`);
  const localRaw = await reopened.evaluate(() => JSON.parse(localStorage.getItem('daguan_local_progress_v1') || '{}'));
  assert.deepEqual(Object.keys(localRaw).filter(id => !id.startsWith('__')), [], `本地缓存不得保留旧练习（实际 ${JSON.stringify(localRaw)}）`);
});

test('离线旧窗口：未同步进度与学习事件在别处清除后重连不复活，收藏批注保留', { timeout: 120000 }, async t => {
  const { base, openContext } = await openBrowser(t);
  const call = api(base);
  await seedProgress(base);
  await setLastStudy(base, 'single');
  const offlineContext = await openContext();
  const { page: offline } = await openLegacy(offlineContext, base);
  await offline.waitForSelector('#single-mastery .chip[data-mastery]', { timeout: 25000 });

  // 真实断网：逐题 PATCH 与学习事件都写不出去，只留在本机待同步。
  await offlineContext.setOffline(true);
  await offline.locator('#single-mastery [data-mastery="mastered"]').click();
  await offline.waitForFunction(() => DaguanStudyActivity.pendingCount() > 0, null, { timeout: 20000 });
  const pendingWhileOffline = await offline.evaluate(() => DaguanStudyActivity.pendingCount());
  assert.ok(pendingWhileOffline > 0, '离线期间应留下待同步学习事件');

  // 另一个在线窗口从新版 UI 清除。
  const onlineContext = await openContext();
  const { page: fresh } = await openNewTools(onlineContext, base);
  await clearViaNew(fresh);
  await fresh.waitForFunction(() => document.querySelector('#clear-progress-result')?.textContent.includes('已清除'), null, { timeout: 20000 });
  await call.waitState(state => state.reset_generation === 1, '代次推进');

  // 旧窗口恢复在线，走真实的 online → hydrate/replay/flush。
  await offlineContext.setOffline(false);
  await offline.evaluate(() => window.dispatchEvent(new Event('online')));
  await offline.waitForTimeout(4000);
  await offline.evaluate(() => DaguanStudyActivity.flush()).catch(() => {});
  await offline.waitForTimeout(1500);

  const state = await call.state();
  assert.equal(state.reset_generation, 1, '重连不得推进或回退代次');
  assert.deepEqual(state.progress, {}, `离线旧窗口重连不得复活进度（实际 ${JSON.stringify(state.progress)}）`);
  assert.equal(state.last_study, null, '继续学习指针不得被旧窗口写回');
  assert.deepEqual(state.favorites, [QUESTION], '收藏保留');
  assert.equal(state.annotations[QUESTION].markdown, '保留批注', '批注保留');
  const activity = await call.activity();
  assert.deepEqual(Object.values(activity.events).filter(event => event.question_id === QUESTION), [], '离线期间的旧学习事件不得落库');
  const pendingAfter = await offline.evaluate(() => DaguanStudyActivity.pendingCount());
  assert.equal(pendingAfter, 0, '重连后旧批次应作废而不是继续挂起');
});

test('双窗口：清除时在飞的旧 PATCH 收到 428 后不重标签重发，收藏批注仍在', { timeout: 120000 }, async t => {
  const { base, openContext } = await openBrowser(t);
  const call = api(base);
  await seedProgress(base);
  await setLastStudy(base, 'single');
  const staleContext = await openContext();
  const { page: legacy } = await openLegacy(staleContext, base);
  await legacy.waitForSelector('#single-mastery .chip[data-mastery]', { timeout: 20000 });
  const freshContext = await openContext();
  const { page: fresh } = await openNewTools(freshContext, base);

  // 旧窗口的逐题 PATCH 延后 2 秒返回，保证它在清除提交之后才拿到 428。
  const patches = [];
  await staleContext.route('**/api/state/questions/*', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patches.push(route.request().postData());
    await new Promise(resolve => setTimeout(resolve, 2000));
    return route.continue();
  });
  await legacy.locator('#single-mastery [data-mastery="mastered"]').click();
  await new Promise(resolve => setTimeout(resolve, 200));
  await clearViaNew(fresh);
  await fresh.waitForFunction(() => document.querySelector('#clear-progress-result')?.textContent.includes('已清除'), null, { timeout: 20000 });
  await staleContext.unroute('**/api/state/questions/*');
  await new Promise(resolve => setTimeout(resolve, 3500));

  const state = await call.state();
  assert.equal(state.reset_generation, 1, '清除只推进一次代次');
  assert.deepEqual(state.favorites, [QUESTION], '旧窗口的收藏意图仍在');
  assert.equal(state.annotations[QUESTION].markdown, '保留批注');
  const retagged = patches.filter(body => body && body.includes('"reset_generation":1'));
  assert.deepEqual(retagged, [], `旧 PATCH 不得换新代次重发（记录：${JSON.stringify(patches)}）`);
  for (const id of Object.keys(state.progress)) {
    assert.notEqual(state.progress[id].mastery, 'mastered', '在飞旧 PATCH 不得复活练习记录');
  }
});

test('清除请求失败且服务端未提交：UI 明确失败、数据保留，重复点击不发第二次请求', { timeout: 90000 }, async t => {
  const { base, openContext } = await openBrowser(t);
  const call = api(base);
  await seedProgress(base);
  const context = await openContext();
  const { page, errors } = await openNewTools(context, base);
  const localBefore = await page.evaluate(() => localStorage.getItem('daguan_local_progress_v1'));
  const posts = [];
  await context.route('**/api/state/clear-progress', async route => {
    posts.push(route.request().postData());
    await new Promise(resolve => setTimeout(resolve, 900));
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '模拟清除失败' }) });
  });
  page.once('dialog', dialog => dialog.accept('清除'));
  await page.locator('#btn-clear-progress').click();
  await page.waitForFunction(() => document.querySelector('#btn-clear-progress')?.disabled === true);
  await page.locator('#btn-clear-progress').click({ force: true });
  await page.waitForFunction(() => /清除失败/.test(document.querySelector('#clear-progress-result')?.textContent || ''), null, { timeout: 20000 });
  assert.equal(posts.length, 1, '操作中重复点击不得发出第二次清除请求');
  await context.unroute('**/api/state/clear-progress');
  const state = await call.state();
  assert.deepEqual(Object.keys(state.progress), [QUESTION], '服务端未提交时进度保留');
  assert.equal(state.reset_generation, 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('daguan_local_progress_v1')), localBefore, '本地缓存原文不变');
  assert.deepEqual(errors, []);
});

test('清除后新练习正常记录，刷新与切版仍可用', { timeout: 90000 }, async t => {
  const { base, openContext } = await openBrowser(t);
  const call = api(base);
  await seedProgress(base);
  const context = await openContext();
  const { page } = await openLegacy(context, base, 'backup');
  await openLegacyDialog(page);
  await clearViaLegacy(page, '清除');
  await page.waitForFunction(() => document.querySelector('#clear-progress-status')?.textContent.includes('已清除'));
  await call.waitState(state => state.reset_generation === 1, '代次推进');

  // 清除后新练习：新开一个旧版标签页，按“继续学习”进入单题页，点真实掌握按钮。
  await setLastStudy(base, 'single');
  const practice = await context.newPage();
  await practice.goto(base + '/legacy.html');
  const singleReady = await practice.waitForSelector('#single-mastery .chip[data-mastery]', { state: 'visible', timeout: 15000 }).then(() => true, () => false);
  if (!singleReady) {
    const diag = await practice.evaluate(() => ({
      app: document.querySelector('#app')?.className,
      views: [...document.querySelectorAll('#view-home, #view-browse, #single, #browse')].map(el => [el.id, el.className, getComputedStyle(el).display]),
      lastStudy: window.DaguanBrowserMigration ? 'ready' : 'missing',
    }));
    assert.fail(`清除后未能进入旧版单题页：${JSON.stringify(diag)}`);
  }
  await practice.locator('#single-mastery [data-mastery="mastered"]').click();
  const recorded = await call.waitState(state => Object.values(state.progress).some(entry => entry.mastery === 'mastered'), '新练习写入');
  assert.equal(recorded.reset_generation, 1, '新练习沿用当前代次，不重置');

  // 重新打开（等价刷新）后记录仍在，本地缓存与代次都保持。
  const reopened = await context.newPage();
  await reopened.goto(base + '/legacy.html');
  await reopened.waitForFunction(() => window.DaguanBrowserMigration && document.querySelector('#btn-sync'));
  await reopened.waitForTimeout(1200);
  const reopenedState = await call.state();
  assert.equal(reopenedState.reset_generation, 1);
  assert.ok(Object.values(reopenedState.progress).some(entry => entry.mastery === 'mastered'), '刷新后服务端记录仍在');
  const localCache = await reopened.evaluate(() => JSON.parse(localStorage.getItem('daguan_local_progress_v1') || '{}'));
  assert.ok(Object.values(localCache).some(entry => entry && entry.mastery === 'mastered'), '刷新后本地缓存仍反映新练习');
  await reopened.goto(base + '/index.html?ui=new');
  await reopened.waitForFunction(() => window.StateSync?.hydrated);
  await reopened.waitForTimeout(600);
  const afterSwitch = await call.state();
  assert.equal(afterSwitch.reset_generation, 1);
  assert.ok(Object.values(afterSwitch.progress).some(entry => entry.mastery === 'mastered'), '切版后记录仍在');
});
