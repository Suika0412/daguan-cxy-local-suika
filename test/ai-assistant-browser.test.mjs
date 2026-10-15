// 思考档位（reasoningPresets）与一次性聊天（清空不落盘）的真实端到端探针。
// 只覆盖本需求契约：设置页档位 CRUD、新版/旧版 chat 档位映射到上游 body、
// 页面内存 history 最近 24 条、clear 后无旧上下文、无 ai-history 磁盘读写、
// 草稿不持久、双窗口 history 独立、生成中 clear 竞态。
// 所有数据目录与浏览器 profile 均隔离在临时目录；上游仅为 loopback mock，记录真实 POST 体。
import { listenHttp } from './http-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let playwright;
try { playwright = createRequire(import.meta.url)(process.env.DAGUAN_PLAYWRIGHT_MODULE || 'playwright'); } catch {}
const skip = !playwright && 'Install Playwright or set DAGUAN_PLAYWRIGHT_MODULE';
const CHROMIUM = process.env.DAGUAN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.DAGUAN_CHROMIUM_EXECUTABLE } : {};
const TEMP_BASE = process.env.DAGUAN_TEST_TEMP || process.env.TEMP || process.env.TMP || os.tmpdir();
const FAKE_KEY = 'fake-key-do-not-leak';
const DEEP_PARAMS = { reasoning_effort: 'high' };
const BUDGET_PARAMS = { thinking: { type: 'enabled', budget_tokens: 4096 } };

async function tempDir(prefix) {
  await fs.mkdir(TEMP_BASE, { recursive: true });
  return fs.mkdtemp(path.join(TEMP_BASE, prefix));
}
async function port() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const n = s.address().port;
  await new Promise(r => s.close(r));
  return n >= 12000 ? n : port();
}
// node 侧可控等待：按条件轮询，超时明确抛错，不用固定 sleep 冒充同步。
async function waitUntil(pred, timeout = 8000, step = 25) {
  const started = Date.now();
  let last = null;
  for (;;) {
    try { const value = await pred(); if (value) return value; } catch (error) { last = error; }
    if (Date.now() - started > timeout) throw new Error(`waitUntil 超时（${timeout}ms）：${last ? last.message : '条件未满足'}`);
    await new Promise(r => setTimeout(r, step));
  }
}
async function fixture(t) {
  const temp = await tempDir('daguan-ai-preset-');
  const n = await port();
  const service = spawn(process.execPath, [path.join(ROOT, 'local-server/server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(n), DAGUAN_DATA_DIR: path.join(temp, 'data'), DAGUAN_OPEN_BROWSER: '0' },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(async () => {
    if (service.exitCode == null) {
      service.send({ type: 'shutdown' });
      await Promise.race([once(service, 'close'), new Promise(r => setTimeout(r, 3000))]);
      if (service.exitCode == null) service.kill();
    }
    await fs.rm(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${n}`;
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) { healthy = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(healthy, 'temporary service starts');
  return { base, temp };
}
// loopback 假上游：记录真实 POST 体；gated 模式下每次请求等待手动释放才返回。
function createUpstream(t, { gated = false } = {}) {
  const calls = [];
  const gates = [];
  const writeErrors = [];
  let settled = 0;
  let aborted = 0;
  const server = http.createServer(async (req, res) => {
    if (String(req.url).endsWith('/models')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'math-model' }] }));
      return;
    }
    // 响应连接在写完前被断开（客户端/上游 abort）才计数，用于验证“停止”真实中断了请求。
    res.on('close', () => { if (!res.writableEnded) aborted += 1; });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { body = { __unparseable: raw }; }
    calls.push(body);
    const respond = () => {
      settled += 1;
      if (res.destroyed || res.writableEnded) return;
      // 客户端已中止时写入会失败：记录到 writeErrors 供诊断，不静默吞掉。
      res.on('error', error => writeErrors.push(error));
      try {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `模拟回答：${promptOf(body)}` } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (error) { writeErrors.push(error); }
    };
    if (gated) await new Promise(resolve => { gates.push({ resolve }); req.on('close', () => resolve()); });
    respond();
  });
  const promptOf = body => {
    const users = (Array.isArray(body.messages) ? body.messages : []).filter(m => m && m.role === 'user');
    const text = String(users.at(-1)?.content ?? '');
    const match = /本次请求：([\s\S]*)$/.exec(text);
    return (match ? match[1] : text).trim().slice(0, 40) || '空';
  };
  return {
    calls,
    server,
    writeErrors,
    get settled() { return settled; },
    get aborted() { return aborted; },
    address: () => server.address(),
    release: index => { const gate = gates[index]; if (gate) gate.resolve(); },
    releaseAll: () => { gates.forEach(gate => gate.resolve()); },
    close: callback => { server.closeAllConnections(); server.close(callback); },
    listen: async () => { await listenHttp(server); return server.address().port; },
  };
}
async function browserOf(t) {
  const browser = await playwright.chromium.launch({ headless: true, ...CHROMIUM });
  t.after(() => browser.close());
  return browser;
}
async function pageOf(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.accept().catch(() => {}));
  await page.route('**/api/state/events', route => route.abort());
  return { page, errors };
}
async function createProfile(base, upstreamPort, extra = {}) {
  const res = await fetch(base + '/api/ai/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '思考档位测试',
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      key: FAKE_KEY,
      model: 'math-model',
      streaming: true,
      reasoningPresets: [
        { id: 'deep', name: '深度思考', params: DEEP_PARAMS },
        { id: 'budget', name: '预算思考', params: BUDGET_PARAMS },
      ],
      ...extra,
    }),
  });
  assert.equal(res.status, 200, '档位档案创建成功');
  const profile = (await res.json()).profile;
  const profiles = (await (await fetch(base + '/api/ai/profiles')).json()).profiles;
  const saved = profiles.find(item => item.id === profile.id) || profile;
  assert.equal(saved.reasoningPresets.length, 2, 'API 保留两个自定义档位');
  return saved;
}
const enterQuestion = page => page.evaluate(async () => {
  AppState.currentCategory = AppState.categories.categories.find(n => UIRenderer.findNodeById(n, 331));
  await App.enterChapterQuestions(UIRenderer.findNodeById(AppState.currentCategory, 331));
  App.toggleAI();
});
// 新版档位框在设置浮层里，默认隐藏：先点“设置”展开（浮层会因重渲染关闭，每次选择前都展开）。
const openPanelSettings = async page => {
  if (!await page.locator('#ai-reasoning-preset-new').isVisible()) await page.locator('#ai-settings-btn').click();
  await page.locator('#ai-reasoning-preset-new').waitFor({ state: 'visible' });
};
const presetValue = (page, id, name) => page.evaluate(({ id, name }) => {
  const select = document.getElementById(id);
  const option = [...select.options].find(item => item.textContent.includes(name));
  return option ? option.value : null;
}, { id, name });
const selectPreset = async (page, id, name) => {
  if (id === 'ai-reasoning-preset-new') await openPanelSettings(page);
  await page.waitForFunction(({ id, name }) => {
    const select = document.getElementById(id);
    return !!select && [...select.options].some(item => item.textContent.includes(name));
  }, { id, name });
  const value = await presetValue(page, id, name);
  assert.notEqual(value, null, `档位选项存在：${name}`);
  await page.locator(`#${id}`).selectOption(value);
  assert.equal(await page.locator(`#${id}`).inputValue(), value, `档位已切换：${name}`);
};
// 档位行的名称在 input 值里而非文本节点，hasText 匹配不到，按名称取行索引。
const presetRowIndex = (page, name) => page.evaluate(want => {
  const rows = [...document.querySelectorAll('#ai-services-settings [data-reasoning-preset]')];
  return rows.findIndex(row => row.querySelector('[data-preset-name]')?.value === want);
}, name);
const listAiHistoryFiles = async dir => {
  const out = [];
  const walk = async current => {
    let entries = [];
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (full.includes(`${path.sep}ai-history${path.sep}`)) out.push(full);
    }
  };
  await walk(dir);
  return out;
};

test('思考档位设置：UI 新增/编辑/校验/删除档位与默认档位，API 保留且不泄露 Key', { skip, timeout: 90000 }, async t => {
  const { base } = await fixture(t);
  const upstream = createUpstream(t);
  const upstreamPort = await upstream.listen();
  t.after(() => new Promise(r => { upstream.releaseAll(); upstream.close(r); }));
  const browser = await browserOf(t);
  const { page, errors } = await pageOf(browser);
  await page.goto(base + '/index.html?ui=new');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction('AppState.categories');
  await page.evaluate(() => App.showSettings());
  const host = page.locator('#ai-services-settings');
  await host.getByRole('button', { name: '新增服务', exact: true }).click();
  const form = host.locator('form');
  await form.locator('[name=name]').fill('档位测试服务');
  await form.locator('[name=baseUrl]').fill(`http://127.0.0.1:${upstreamPort}/v1`);
  await form.locator('[name=key]').fill(FAKE_KEY);
  await form.locator('[name=model]').fill('math-model');
  await form.getByRole('button', { name: '保存服务', exact: true }).click();
  await host.locator('[data-status]').filter({ hasText: '服务已保存' }).waitFor();

  const rows = host.locator('[data-reasoning-preset]');
  // 保存后以 API 事实为准（成功与成功两次的状态文本相同，不能靠文本变化判断）。
  const saveService = async expect => {
    await form.getByRole('button', { name: '保存服务', exact: true }).click();
    try {
      await waitUntil(async () => {
        const profiles = (await (await fetch(base + '/api/ai/profiles')).json()).profiles;
        const target = profiles.find(item => item.name === '档位测试服务');
        if (expect(target)) return true;
        throw new Error(`状态：${await host.locator('[data-status]').innerText()}｜档位：${JSON.stringify(target?.reasoningPresets)}｜默认：${target?.defaultReasoningPresetId}`);
      }, 8000);
    } catch (error) { throw new Error(`保存未按预期生效：${error.message}`); }
    return host.locator('[data-status]').innerText();
  };
  const addPreset = async (name, paramsJson) => {
    const before = await rows.count();
    await host.locator('[data-action=add-reasoning-preset]').click();
    await page.waitForFunction(({ n, host: hostId }) => {
      const list = [...document.querySelectorAll(`#${hostId} [data-reasoning-preset]`)];
      if (list.length > n) return true;
      const last = list.at(-1);
      return !!last && !last.querySelector('[data-preset-name]').value && !last.querySelector('[data-preset-params]').value;
    }, { n: before, host: 'ai-services-settings' });
    const row = rows.nth(await rows.count() - 1);
    await row.locator('[data-preset-name]').fill(name);
    await row.locator('[data-preset-params]').fill(paramsJson);
  };
  // 1) 两个中文自定义档位：扁平字段与 provider 嵌套字段各一。
  await addPreset('深度思考', JSON.stringify(DEEP_PARAMS));
  await addPreset('预算思考', JSON.stringify(BUDGET_PARAMS));
  assert.equal(await rows.count(), 2, '两个档位行');
  // 2) 选择默认档位后保存。
  const defaultSelect = host.locator('[name=defaultReasoningPresetId]');
  const deepValue = await page.evaluate(() => {
    const select = document.querySelector('#ai-services-settings [name=defaultReasoningPresetId]');
    const option = [...select.options].find(item => item.textContent.includes('深度思考'));
    return option ? option.value : null;
  });
  assert.notEqual(deepValue, null, '默认档位下拉包含“深度思考”');
  await defaultSelect.selectOption(deepValue);
  const savedStatus = await saveService(target => target?.reasoningPresets?.length === 2 && target.defaultReasoningPresetId === deepValue);
  assert.match(savedStatus, /服务已保存/, '档位保存成功');

  // 3) API 返回保留档位与默认值，且不泄露 Key。
  const profilesAfterSave = (await (await fetch(base + '/api/ai/profiles')).json()).profiles;
  const savedProfile = profilesAfterSave.find(item => item.name === '档位测试服务');
  assert.ok(savedProfile, 'API 返回已保存服务');
  assert.equal(savedProfile.reasoningPresets.length, 2);
  assert.deepEqual(savedProfile.reasoningPresets.find(item => item.name === '深度思考').params, DEEP_PARAMS);
  assert.deepEqual(savedProfile.reasoningPresets.find(item => item.name === '预算思考').params, BUDGET_PARAMS);
  assert.equal(savedProfile.defaultReasoningPresetId, deepValue, '默认档位 ID 已保存');
  assert.equal(JSON.stringify(profilesAfterSave).includes(FAKE_KEY), false, 'API 不返回 Key 明文');
  assert.equal((await host.innerText()).includes(FAKE_KEY), false, '设置页不显示 Key 明文');

  // 4) 编辑恢复：行、参数（按 JSON 语义比较，不依赖格式）与默认档位回填。
  await host.locator('.ai-service-item').filter({ hasText: '档位测试服务' }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#ai-services-settings [data-reasoning-preset]').length === 2);
  const restored = await page.evaluate(() => [...document.querySelectorAll('#ai-services-settings [data-reasoning-preset]')].map(row => ({
    name: row.querySelector('[data-preset-name]').value,
    params: row.querySelector('[data-preset-params]').value,
  })));
  assert.equal(restored.length, 2, '编辑回填两个档位行');
  assert.equal(restored.find(item => item.name === '深度思考').name, '深度思考');
  assert.deepEqual(JSON.parse(restored.find(item => item.name === '深度思考').params), DEEP_PARAMS);
  assert.deepEqual(JSON.parse(restored.find(item => item.name === '预算思考').params), BUDGET_PARAMS);
  assert.equal(await defaultSelect.inputValue(), deepValue, '编辑回填默认档位');

  // 5) 非法 JSON：保存时显式报错且不提交（行数与 API 均不变）。
  const statusBefore = await host.locator('[data-status]').innerText();
  await rows.nth(0).locator('[data-preset-params]').fill('{不是合法 JSON');
  await form.getByRole('button', { name: '保存服务', exact: true }).click();
  await waitUntil(async () => (await host.locator('[data-status]').innerText()) !== statusBefore, 5000);
  const invalidStatus = await host.locator('[data-status]').innerText();
  assert.match(invalidStatus, /JSON|参数|档位|思考/, '非法 JSON 有明确错误提示');
  assert.doesNotMatch(invalidStatus, /服务已保存/, '非法 JSON 不得按保存成功提示');
  const profilesAfterInvalid = (await (await fetch(base + '/api/ai/profiles')).json()).profiles;
  const afterInvalid = profilesAfterInvalid.find(item => item.name === '档位测试服务');
  assert.equal(afterInvalid.reasoningPresets.length, 2, '非法 JSON 不写入 API');
  assert.deepEqual(afterInvalid.reasoningPresets.find(item => item.name === '深度思考').params, DEEP_PARAMS, '非法 JSON 不破坏已保存档位');
  assert.equal(afterInvalid.defaultReasoningPresetId, deepValue, '非法 JSON 不改变默认档位');

  // 6) 默认档位更新为“预算思考”后保存生效（重新编辑回填也证明上次非法保存未污染数据）。
  await host.locator('.ai-service-item').filter({ hasText: '档位测试服务' }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#ai-services-settings [data-reasoning-preset]').length === 2);
  const restoredParams = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#ai-services-settings [data-reasoning-preset]')].find(item => item.querySelector('[data-preset-name]').value === '深度思考');
    return row.querySelector('[data-preset-params]').value;
  });
  assert.deepEqual(JSON.parse(restoredParams), DEEP_PARAMS, '非法保存被拒后重新编辑仍回填正确参数');
  const budgetValue = await page.evaluate(() => {
    const select = document.querySelector('#ai-services-settings [name=defaultReasoningPresetId]');
    const option = [...select.options].find(item => item.textContent.includes('预算思考'));
    return option ? option.value : null;
  });
  assert.notEqual(budgetValue, null, '默认档位下拉包含“预算思考”');
  await defaultSelect.selectOption(budgetValue);
  const budgetStatus = await saveService(target => target?.defaultReasoningPresetId === budgetValue && target?.reasoningPresets?.length === 2);
  assert.match(budgetStatus, /服务已保存/, '默认档位更新保存成功');
  let current = (await (await fetch(base + '/api/ai/profiles')).json()).profiles.find(item => item.name === '档位测试服务');
  assert.equal(current.defaultReasoningPresetId, budgetValue, '默认档位已更新');

  // 7) 删除被设为默认的档位行：不残留悬空默认引用。
  await host.locator('.ai-service-item').filter({ hasText: '档位测试服务' }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#ai-services-settings [data-reasoning-preset]').length === 2);
  const budgetRowIndex = await presetRowIndex(page, '预算思考');
  assert.ok(budgetRowIndex >= 0, '定位“预算思考”行');
  await rows.nth(budgetRowIndex).locator('[data-remove-preset]').click();
  await page.waitForFunction(() => document.querySelectorAll('#ai-services-settings [data-reasoning-preset]').length === 1);
  const deleteStatus = await saveService(target => target?.reasoningPresets?.length === 1);
  assert.match(deleteStatus, /服务已保存/, '删除档位后保存成功');
  current = (await (await fetch(base + '/api/ai/profiles')).json()).profiles.find(item => item.name === '档位测试服务');
  assert.equal(current.reasoningPresets.length, 1, '删除后只剩一个档位');
  assert.equal(current.reasoningPresets[0].name, '深度思考');
  assert.deepEqual(current.reasoningPresets[0].params, DEEP_PARAMS);
  assert.ok(current.defaultReasoningPresetId === '' || current.defaultReasoningPresetId === current.reasoningPresets[0].id,
    `默认档位不残留已删除引用：${current.defaultReasoningPresetId}`);
  assert.equal(errors.length, 0, errors.join('\n'));
});

test('新版聊天：档位映射上游 body、页面内存 history、clear 后无旧上下文、无 ai-history 落盘、草稿不持久、双窗口独立', { skip, timeout: 90000 }, async t => {
  const { base, temp } = await fixture(t);
  const upstream = createUpstream(t);
  const upstreamPort = await upstream.listen();
  t.after(() => new Promise(r => { upstream.releaseAll(); upstream.close(r); }));
  const profile = await createProfile(base, upstreamPort);
  const browser = await browserOf(t);
  const { page, errors } = await pageOf(browser);
  const chatPosts = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/ai/chat')) {
      try { chatPosts.push(JSON.parse(request.postData() || '{}')); } catch {}
    }
  });
  await page.goto(base + '/index.html?ui=new');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction('AppState.categories');
  await enterQuestion(page);
  await page.waitForSelector('#ai-input');
  await openPanelSettings(page);
  // 初始即模型默认：档位框为空，且 chatBody 发送 reasoningPresetId=""。
  assert.equal(await page.locator('#ai-reasoning-preset-new').inputValue(), '', '初始档位为模型默认');
  const questionId = await page.evaluate(() => String(AppState.questions[AppState.currentQuestionIndex].id));

  const send = async text => {
    await page.locator('#ai-input').fill(text);
    await page.locator('#ai-send-btn').click();
    await page.waitForFunction('!AppState.aiBusy');
  };
  // 1) 模型默认：上游 body 不含任何思考参数字段，messages/model/stream 保持原契约。
  await send('默认档位的提问');
  assert.equal(upstream.calls.length, 1);
  const first = upstream.calls.at(-1);
  assert.equal(first.model, 'math-model');
  assert.equal(first.stream, true);
  assert.ok(Array.isArray(first.messages) && first.messages[0].role === 'system');
  assert.equal(first.reasoning_effort, undefined, '模型默认不带 reasoning_effort');
  assert.equal(first.thinking, undefined, '模型默认不带 thinking');
  assert.equal(first.messages.length, 2, '首轮只有 system + user');
  assert.equal(chatPosts.at(-1).reasoningPresetId, '', 'chatBody 始终发送 reasoningPresetId（模型默认为空串）');

  // 2) 选择“深度思考”：上游 body 精确包含映射字段。
  await selectPreset(page, 'ai-reasoning-preset-new', '深度思考');
  await send('第一问');
  const deep = upstream.calls.at(-1);
  assert.equal(deep.reasoning_effort, 'high', '档位参数映射到上游 body');
  assert.equal(chatPosts.at(-1).reasoningPresetId, profile.reasoningPresets.find(item => item.name === '深度思考').id);

  // 3) 切到嵌套档位再问：第二次请求含上轮 user/assistant（页面内存 history）。
  await selectPreset(page, 'ai-reasoning-preset-new', '预算思考');
  await send('第二问');
  const budget = upstream.calls.at(-1);
  assert.deepEqual(budget.thinking, BUDGET_PARAMS.thinking, 'provider 嵌套档位参数映射到上游 body');
  assert.equal(chatPosts.at(-1).reasoningPresetId, profile.reasoningPresets.find(item => item.name === '预算思考').id);
  const roles = budget.messages.map(item => item.role);
  assert.equal(roles[0], 'system');
  assert.ok(budget.messages.some(item => item.role === 'user' && String(item.content).includes('第一问')), 'history 含上轮 user');
  assert.ok(budget.messages.some(item => item.role === 'assistant' && String(item.content).includes('模拟回答：第一问')), 'history 含上轮 assistant');

  // 4) clear：DOM 清空，下一请求不含旧上下文，档位选择保留。
  await page.locator('#ai-clear-btn').click();
  await page.waitForFunction(() => !/第一问|第二问|模拟回答/.test(document.getElementById('ai-messages').textContent || ''));
  await send('第三问');
  const third = upstream.calls.at(-1);
  assert.equal(third.messages.length, 2, 'clear 后请求只含 system + user');
  assert.equal(third.messages.some(item => String(item.content).includes('第一问')), false, 'clear 后不含上轮 user');
  assert.equal(third.messages.some(item => String(item.content).includes('模拟回答：第一问')), false, 'clear 后不含上轮 assistant');
  assert.deepEqual(third.thinking, BUDGET_PARAMS.thinking, 'clear 不重置档位选择');

  // 5) 后端不落 ai-history：GET conversations 为空，隔离数据目录无新增历史文件。
  const conversation = await (await fetch(`${base}/api/ai/conversations/${encodeURIComponent(profile.id)}/${encodeURIComponent(questionId)}`)).json();
  assert.equal((conversation.messages || []).length, 0, 'GET conversations 为空');
  assert.equal((await listAiHistoryFiles(path.join(temp, 'data'))).length, 0, '数据目录无 ai-history 文件');

  // 6) 草稿不持久：填草稿后 reload 重进同题，messages/input 空，localStorage 无 AI 草稿值。
  await page.locator('#ai-input').fill('临时草稿不要持久化');
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForFunction('AppState.categories');
  await enterQuestion(page);
  await page.waitForSelector('#ai-input');
  assert.equal(await page.locator('#ai-input').inputValue(), '', 'reload 后输入框为空');
  assert.equal(/模拟回答|第一问|第二问|第三问/.test(await page.locator('#ai-messages').innerText()), false, 'reload 后消息为空');
  const drafts = await page.evaluate(() => Object.keys(localStorage)
    .filter(key => /^daguan_ai_draft/.test(key))
    .map(key => [key, localStorage.getItem(key)])
    .filter(([, value]) => value));
  assert.deepEqual(drafts, [], 'localStorage 无 AI 草稿值（不影响 profile/layout 偏好键）');

  // 7) 同 origin 新窗口同题：history 互相独立。
  const second = await pageOf(browser);
  await second.page.goto(base + '/index.html?ui=new');
  await second.page.waitForLoadState('networkidle');
  await second.page.waitForFunction('AppState.categories');
  await enterQuestion(second.page);
  await second.page.waitForSelector('#ai-input');
  assert.equal(/模拟回答/.test(await second.page.locator('#ai-messages').innerText()), false, '新窗口不继承旧窗口 history');
  await second.page.locator('#ai-input').fill('第二窗口的提问');
  await second.page.locator('#ai-send-btn').click();
  await second.page.waitForFunction('!AppState.aiBusy');
  assert.match(await second.page.locator('#ai-messages').innerText(), /第二窗口的提问/);
  assert.equal(/第二窗口的提问|模拟回答：第二窗口的提问/.test(await page.locator('#ai-messages').innerText()), false, '旧窗口不出现新窗口 history');
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(second.errors.length, 0, second.errors.join('\n'));
  assert.equal(upstream.writeErrors.length, 0, `假上游写入不应失败：${upstream.writeErrors.map(e => e.message).join(';')}`);
});

test('新版聊天：生成中 clear 的竞态——旧请求迟到不回填、旧 finally 不破坏新 busy', { skip, timeout: 90000 }, async t => {
  const { base } = await fixture(t);
  const upstream = createUpstream(t, { gated: true });
  const upstreamPort = await upstream.listen();
  t.after(() => new Promise(r => { upstream.releaseAll(); upstream.close(r); }));
  await createProfile(base, upstreamPort);
  const browser = await browserOf(t);
  const { page, errors } = await pageOf(browser);
  await page.goto(base + '/index.html?ui=new');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction('AppState.categories');
  await enterQuestion(page);
  await page.waitForSelector('#ai-input');
  await openPanelSettings(page);
  await selectPreset(page, 'ai-reasoning-preset-new', '深度思考');

  // 1) 发送后上游已收到请求（gate 未释放），页面处于 busy。
  await page.locator('#ai-input').fill('生成中的旧问题');
  await page.locator('#ai-send-btn').click();
  await waitUntil(() => upstream.calls.length >= 1);
  assert.equal(await page.evaluate('AppState.aiBusy'), true, '发送后进入 busy');

  // 2) 生成中 clear：busy 复位，可立即再发；旧 run 被中止。
  await page.locator('#ai-clear-btn').click();
  await page.waitForFunction('!AppState.aiBusy');
  await page.locator('#ai-input').fill('紧随其后的新问题');
  await page.locator('#ai-send-btn').click();
  await waitUntil(() => upstream.calls.length >= 2);
  assert.equal(await page.evaluate('AppState.aiBusy'), true, '新发送重新进入 busy');

  // 3) 释放旧请求：迟到响应与旧 finally 都不得回填旧答案或破坏新 busy。
  upstream.release(0);
  await waitUntil(() => upstream.settled >= 1);
  await page.waitForFunction(() => !/生成中的旧问题|模拟回答：生成中的旧问题/.test(document.getElementById('ai-messages').textContent || ''));
  assert.equal(await page.evaluate('AppState.aiBusy'), true, '旧请求结束后新运行仍 busy');
  assert.equal(/生成中的旧问题/.test(await page.locator('#ai-messages').innerText()), false, 'DOM 无旧用户消息');

  // 4) 释放新请求：新答案落 DOM，上游新请求无旧 history。
  upstream.release(1);
  await page.waitForFunction('!AppState.aiBusy');
  await page.waitForFunction(() => /模拟回答：紧随其后的新问题/.test(document.getElementById('ai-messages').textContent || ''));
  assert.equal(/生成中的旧问题|模拟回答：生成中的旧问题/.test(await page.locator('#ai-messages').innerText()), false, 'DOM 无旧答案');
  const last = upstream.calls.at(-1);
  assert.equal(last.messages.length, 2, '新请求只含 system + user');
  assert.equal(last.messages.some(item => String(item.content).includes('生成中的旧问题')), false, '新请求不含旧 history');
  assert.equal(last.reasoning_effort, 'high', '新请求仍带档位参数');
  assert.equal(errors.length, 0, errors.join('\n'));
});

test('旧版聊天：真实选择自定义档位与 clear，clear 后新请求空 history', { skip, timeout: 90000 }, async t => {
  const { base } = await fixture(t);
  const upstream = createUpstream(t);
  const upstreamPort = await upstream.listen();
  t.after(() => new Promise(r => { upstream.releaseAll(); upstream.close(r); }));
  const profile = await createProfile(base, upstreamPort);
  const browser = await browserOf(t);
  const { page, errors } = await pageOf(browser);
  await page.goto(base + '/legacy.html?ui=old&entry=chapters');
  await page.waitForLoadState('networkidle');
  // 单档案时没有“未配置 AI”占位项：按目标档案实际存在且被选中断言。
  await page.waitForFunction(() => {
    const select = document.getElementById('ai-profile-select');
    return !!select && [...select.options].some(option => option.value && option.textContent.includes('思考档位测试'));
  });
  assert.equal(await page.locator('#ai-profile-select').inputValue(), profile.id, '旧版默认选中目标档案');
  await page.locator('[data-chapter-id="223"]').click();
  await page.locator('[data-chapter-id="321"]').click();
  await page.locator('[data-chapter-id="327"]').click();
  await page.locator('[data-chapter-id="331"]').click();
  await page.locator('#chapter-menu').waitFor({ state: 'hidden' });
  if (!await page.locator('#btn-single-ai').isVisible()) await page.locator('#mode-single').click();
  await page.locator('#btn-single-ai').click();
  await page.waitForSelector('#ai-prompt');
  await page.waitForSelector('#ai-reasoning-preset');

  // 1) 真实点击选择框选择自定义档位并发送。
  await selectPreset(page, 'ai-reasoning-preset', '深度思考');
  await page.locator('#ai-prompt').fill('旧版第一问');
  await page.locator('#btn-ai-send').click();
  await page.waitForFunction(() => /模拟回答：旧版第一问/.test(document.getElementById('ai-messages').textContent || ''));
  const legacyFirst = upstream.calls.at(-1);
  assert.equal(legacyFirst.reasoning_effort, 'high', '旧版档位参数映射到上游 body');
  assert.equal(legacyFirst.model, 'math-model');
  assert.equal(legacyFirst.stream, true);

  // 2) clear 后新请求空 history。
  await page.locator('#ai-clear-btn').click();
  await page.waitForFunction(() => !/旧版第一问|模拟回答/.test(document.getElementById('ai-messages').textContent || ''));
  await page.locator('#ai-prompt').fill('旧版第二问');
  await page.locator('#btn-ai-send').click();
  await page.waitForFunction(() => /模拟回答：旧版第二问/.test(document.getElementById('ai-messages').textContent || ''));
  const legacySecond = upstream.calls.at(-1);
  assert.equal(legacySecond.messages.length, 2, '旧版 clear 后请求只含 system + user');
  assert.equal(legacySecond.messages.some(item => String(item.content).includes('旧版第一问')), false, '旧版 clear 后不含旧 history');
  assert.equal(legacySecond.reasoning_effort, 'high', '旧版 clear 不重置档位选择');
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(upstream.writeErrors.length, 0, `假上游写入不应失败：${upstream.writeErrors.map(e => e.message).join(';')}`);
});

test('旧版聊天：生成中 clear 的竞态——旧 run 迟到不回填、不破坏新发送', { skip, timeout: 90000 }, async t => {
  const { base } = await fixture(t);
  const upstream = createUpstream(t, { gated: true });
  const upstreamPort = await upstream.listen();
  t.after(() => new Promise(r => { upstream.releaseAll(); upstream.close(r); }));
  await createProfile(base, upstreamPort);
  const browser = await browserOf(t);
  const { page, errors } = await pageOf(browser);
  await page.goto(base + '/legacy.html?ui=old&entry=chapters');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => {
    const select = document.getElementById('ai-profile-select');
    return !!select && [...select.options].some(option => option.value && option.textContent.includes('思考档位测试'));
  });
  await page.locator('[data-chapter-id="223"]').click();
  await page.locator('[data-chapter-id="321"]').click();
  await page.locator('[data-chapter-id="327"]').click();
  await page.locator('[data-chapter-id="331"]').click();
  await page.locator('#chapter-menu').waitFor({ state: 'hidden' });
  if (!await page.locator('#btn-single-ai').isVisible()) await page.locator('#mode-single').click();
  await page.locator('#btn-single-ai').click();
  await page.waitForSelector('#ai-prompt');
  await page.waitForSelector('#ai-reasoning-preset');
  await selectPreset(page, 'ai-reasoning-preset', '深度思考');
  const sendBusy = () => page.waitForFunction(() => document.getElementById('btn-ai-send').disabled);
  const sendIdle = () => page.waitForFunction(() => !document.getElementById('btn-ai-send').disabled);
  // legacy.css 的 .btn{display:inline-flex} 覆盖了 UA 的 [hidden]，停止按钮只能按 hidden 属性判断状态。
  const stopShown = () => page.waitForFunction(() => { const b = document.getElementById('btn-ai-stop'); return !!b && !b.hasAttribute('hidden'); });
  const stopHidden = () => page.waitForFunction(() => { const b = document.getElementById('btn-ai-stop'); return !!b && b.hasAttribute('hidden'); });

  // 实例级包装：只包第一个 /api/ai/chat 的真实 Response.body.getReader()。
  // 原 read 因 abort 拒绝时暂挂该错误（不伪造任何网络/模型响应），由 releaseOldAbort 显式释放，
  // 从而把“旧流 catch/finally 落地”这一刻 deterministic 地压到新 run 拿到 runId 之后。
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let wrapped = false, heldReject = null;
    window.__oldAbortHeld = false;
    window.__heldAbortError = null;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (!wrapped && String(url).endsWith('/api/ai/chat')) {
        wrapped = true;
        const realBody = response.body;
        const realGetReader = realBody.getReader.bind(realBody);
        Object.defineProperty(response, 'body', {
          configurable: true,
          value: {
            getReader() {
              const reader = realGetReader();
              const realRead = reader.read.bind(reader);
              reader.read = () => realRead().then(value => value, error => {
                const aborted = !!error && (error.name === 'AbortError' || /abort/i.test(String(error.message || '')));
                if (!aborted) throw error;
                window.__oldAbortHeld = true;
                window.__heldAbortError = error;
                return new Promise((resolve, reject) => { heldReject = reject; });
              });
              return reader;
            },
          },
        });
        window.releaseOldAbort = () => {
          const reject = heldReject;
          heldReject = null;
          window.__oldAbortHeld = false;
          window.__heldAbortError = null;
          if (reject) reject(new DOMException('已停止', 'AbortError'));
        };
      }
      return response;
    };
  });

  // 1) 发送后上游已收到请求（gate 未释放），旧版进入生成中（发送禁用）。
  await page.locator('#ai-prompt').fill('旧版生成中的旧问题');
  await page.locator('#btn-ai-send').click();
  await waitUntil(() => upstream.calls.length >= 1);
  await sendBusy();

  // 2) 生成中 clear：旧流 abort 被暂挂（held），busy 已复位，立即再发新 run。
  await page.locator('#ai-clear-btn').click();
  await page.waitForFunction('window.__oldAbortHeld === true');
  await sendIdle();
  await page.locator('#ai-prompt').fill('旧版紧随其后的新问题');
  await page.locator('#btn-ai-send').click();
  await waitUntil(() => upstream.calls.length >= 2);
  await sendBusy();
  // 新 run 已拿到 runId 并显示停止按钮，而旧流的 catch/finally 尚未落地。
  await stopShown();

  // 3) 此刻才释放旧 abort：旧流 catch/finally 落地，不得清掉新 run 的 activeAiRunId、不得隐藏其停止按钮。
  await page.evaluate(() => window.releaseOldAbort());
  await page.waitForFunction(() => !/旧版生成中的旧问题|模拟回答：旧版生成中的旧问题/.test(document.getElementById('ai-messages').textContent || ''));
  await stopShown();
  await sendBusy();
  assert.equal(/旧版生成中的旧问题/.test(await page.locator('#ai-messages').innerText()), false, 'DOM 无旧用户消息');

  // 4) 停止按钮对新 run 真实有效：点击后新运行被中止、busy 复位、上游新请求被断开。
  const abortedBefore = upstream.aborted;
  await page.locator('#btn-ai-stop').click();
  await sendIdle();
  await stopHidden();
  assert.ok(upstream.aborted > abortedBefore, `点击停止真实中断新 run 上游请求（${abortedBefore} → ${upstream.aborted}）`);
  assert.match(await page.locator('#ai-messages').innerText(), /旧版紧随其后的新问题/, '新 run 的用户消息仍在');
  assert.equal(/旧版生成中的旧问题|模拟回答：旧版生成中的旧问题/.test(await page.locator('#ai-messages').innerText()), false, 'DOM 无旧答案');

  // 5) 上游最后一次请求（新 run）无旧 history 且带档位参数。
  const last = upstream.calls.at(-1);
  assert.equal(last.messages.length, 2, '旧版新请求只含 system + user');
  assert.equal(last.messages.some(item => String(item.content).includes('旧版生成中的旧问题')), false, '旧版新请求不含旧 history');
  assert.equal(last.reasoning_effort, 'high', '旧版新请求仍带档位参数');
  assert.equal(errors.length, 0, errors.join('\n'));
});
