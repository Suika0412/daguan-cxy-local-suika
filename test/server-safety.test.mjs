import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { serviceFixture } from './runtime-fixture.mjs';
import { createStudyActivity } from '../local-server/study-activity.mjs';

const client = base => {
  const send = (route, method, value, headers = {}) => fetch(base + route, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value),
  });
  return {
    send,
    get: async route => (await fetch(base + route)).json(),
    state: async () => (await fetch(base + '/api/state')).json(),
    clear: (value, headers) => send('/api/state/clear-progress', 'POST', value, headers),
  };
};

test('invalid mastery returns one 400, server and subsequent writes survive', { timeout: 15000 }, async t => {
  const { base, output } = await serviceFixture(t);
  const patch = mastery => fetch(base + '/api/state/questions/1', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 0, mastery }),
  });
  const invalid = await patch('invalid');
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /掌握状态无效/);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await patch('learning')).status, 200);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.revision, 1);
  assert.equal(state.progress[1].mastery, 'learning');
  assert.doesNotMatch(output(), /ERR_HTTP_HEADERS_SENT/);
});

test('corrupt state stops startup, preserves original and releases its own lease', { timeout: 15000 }, async t => {
  const { dir, closed, output } = await serviceFixture(t, { corrupt: true });
  const [code] = await closed;
  assert.notEqual(code, 0);
  assert.match(output(), /DATA_CORRUPT/);
  assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), '{broken');
  await assert.rejects(fs.stat(path.join(dir, '.service-instance.json')), { code: 'ENOENT' });
});

test('legacy migration preserves annotations, study position and local sync metadata', { timeout: 15000 }, async t => {
  const { base } = await serviceFixture(t);
  const request = (route, method, value) => fetch(base + route, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  const initial = {
    revision: 0,
    progress: { 1: { mastery: 'mastered', updated_at: '2026-10-03T00:00:00Z' } },
    annotations: { 1: { markdown: 'Keep this note', updated_at: '2026-10-03T00:00:00Z' } },
    favorites: ['1'], picked: ['1'],
    last_study: { category_id: 331, question_id: 1, updated_at: '2026-10-03T00:00:00Z' },
    remote_seeded_at: '2026-10-02T00:00:00Z',
    pending_remote_operations: [{ questionId: '1', payload: { mastery: 'mastered' } }],
    pending_unknown_states: { 99999: { source: 'reconcile' } },
    local_activity: { marker: 'local' }, remote_activity: { marker: 'remote' },
    remote_last_study: { question_id: 2 },
  };
  assert.equal((await request('/api/state', 'PUT', initial)).status, 200);
  const before = await (await fetch(base + '/api/state')).json();
  for (const incoming of [
    { progress: { 1: { mastery: 'learning', updated_at: '2026-10-01T00:00:00Z' }, 2: { mastery: 'learning' } }, favorites: ['2'], picked: ['2'], settings: {} },
    { progress: {}, annotations: {}, last_study: null, remote_seeded_at: null, pending_remote_operations: [] },
  ]) {
    const response = await request('/api/state/migrate', 'POST', incoming);
    assert.equal(response.status, 200);
    const { state } = await response.json();
    for (const key of ['annotations', 'last_study', 'remote_seeded_at', 'pending_remote_operations', 'pending_unknown_states', 'local_activity', 'remote_activity', 'remote_last_study']) {
      assert.deepEqual(state[key], before[key], key);
    }
    assert.equal(state.progress[1].mastery, 'mastered');
    assert.equal(state.progress[2].mastery, 'learning');
    assert.deepEqual(state.favorites, ['1', '2']);
    assert.deepEqual(state.picked, ['1', '2']);
  }
});

test('legacy migration merges notes and position without replacing newer local records', { timeout: 15000 }, async t => {
  const { base } = await serviceFixture(t);
  const put = value => fetch(base + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await put({ revision: 0,
    annotations: { 1: { markdown: 'New local note', updated_at: '2026-10-03T00:00:00Z' } },
    last_study: { question_id: 1, updated_at: '2026-10-03T00:00:00Z' },
  })).status, 200);
  const migrate = async value => {
    const response = await fetch(base + '/api/state/migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 200);
    return (await response.json()).state;
  };
  let state = await migrate({ annotations: { 1: { markdown: 'Old note', updated_at: '2026-10-01T00:00:00Z' }, 2: { markdown: 'Imported note' } }, last_study: { question_id: 2, updated_at: '2026-10-01T00:00:00Z' } });
  assert.equal(state.annotations[1].markdown, 'New local note');
  assert.equal(state.annotations[2].markdown, 'Imported note');
  assert.equal(state.last_study.question_id, 1);
  state = await migrate({ annotations: { 1: { markdown: 'Newest note', updated_at: '2026-10-04T00:00:00Z' } }, last_study: { question_id: 3, updated_at: '2026-10-04T00:00:00Z' } });
  assert.equal(state.annotations[1].markdown, 'Newest note');
  assert.equal(state.annotations[2].markdown, 'Imported note');
  assert.equal(state.last_study.question_id, 3);
});

test('学习写入口按清除代次守卫：旧代次 428、匹配代次可写且不误删收藏', { timeout: 20000 }, async t => {
  const { base } = await serviceFixture(t);
  const { send, state, clear } = client(base);

  // 旧安装代次 0：缺代次仍兼容；题 1 既是收藏题也有练习记录
  assert.equal((await send('/api/state', 'PUT', {
    revision: 0,
    progress: { 1: { mastery: 'learning', updated_at: '2026-10-01T00:00:00Z' } },
    favorites: ['1', '2'],
  })).status, 200);

  // 用正式清除端点推进代次（不手改存活服务的 state 文件）
  const cleared = await clear({ revision: 1, reset_generation: 0 });
  assert.equal(cleared.status, 200);
  const afterClear = await cleared.json();
  assert.equal(afterClear.revision, 2);
  assert.equal(afterClear.reset_generation, 1);
  assert.deepEqual(afterClear.state.favorites, ['1', '2'], '清除保留收藏');

  // 旧页面：缺代次、旧代次、非数字代次一律 428 且不落盘
  for (const body of [
    { revision: 2, mastery: 'learning' },
    { revision: 2, mastery: 'learning', reset_generation: 0 },
    { revision: 2, mastery: 'learning', reset_generation: '1' },
  ]) {
    const blocked = await send('/api/state/questions/1', 'PATCH', body);
    assert.equal(blocked.status, 428, JSON.stringify(body));
    const payload = await blocked.json();
    assert.equal(payload.code, 'PROGRESS_RESET_REQUIRED');
    assert.match(payload.error, /刷新/);
    assert.equal(payload.current.reset_generation, 1);
  }
  assert.equal((await state()).revision, 2, '被拒写入不得改动状态');

  // 匹配代次可写；该题原为收藏题，只写练习字段不得删收藏
  assert.equal((await send('/api/state/questions/1', 'PATCH', { revision: 2, reset_generation: 1, mastery: 'mastered' })).status, 200);
  const practiced = await state();
  assert.deepEqual(practiced.favorites, ['1', '2'], '逐题写练习字段不得删掉原收藏');
  assert.equal(practiced.progress['1'].mastery, 'mastered');
  assert.equal(practiced.revision, 3);

  // 显式 favorite:false 仍能取消收藏
  assert.equal((await send('/api/state/questions/1', 'PATCH', { revision: 3, reset_generation: 1, favorite: false })).status, 200);
  assert.deepEqual((await state()).favorites, ['2']);

  // 其余学习写入口同样受守卫
  for (const [route, method, payload] of [
    ['/api/state', 'PUT', { revision: 4, progress: {} }],
    ['/api/state/last-study', 'PATCH', { revision: 4, category_id: 331, question_id: 1 }],
    ['/api/state/migrate', 'POST', { progress: { 2: { mastery: 'mastered' } } }],
    ['/api/study-activity/events', 'POST', { events: [] }],
    ['/api/study-activity/merge', 'POST', { version: 1, started_at: '2026-01-01T00:00:00Z', baseline: {}, events: {} }],
  ]) {
    const blocked = await send(route, method, payload);
    assert.equal(blocked.status, 428, `${route} 缺代次必须 428`);
    assert.equal((await blocked.json()).code, 'PROGRESS_RESET_REQUIRED');
  }
  assert.equal((await state()).revision, 4, '被拒写入不得改动状态');

  // 带上当前代次后恢复可用
  assert.equal((await send('/api/state', 'PUT', { revision: 4, reset_generation: 1, progress: {} })).status, 200);
  assert.equal((await send('/api/study-activity/events', 'POST', { reset_generation: 1, events: [
    { event_id: 'event-00000001', question_id: '3', type: 'study', at: new Date().toISOString(), chapter_id: 'chapter', chapter_name: '极限' },
  ] })).status, 200);
  assert.equal((await state()).revision, 5);
});

test('清除做题记录端点：revision/代次校验、落盘清空、保留项与伪造代次', { timeout: 20000 }, async t => {
  const { base, dir } = await serviceFixture(t);
  const { send, state, clear, get } = client(base);
  const initial = {
    revision: 0,
    progress: { 1: { mastery: 'learning', updated_at: '2026-10-01T00:00:00Z' } },
    annotations: { 1: { markdown: 'Keep note', updated_at: '2026-10-01T00:00:00Z' } },
    favorites: ['1', '2'], picked: ['1'],
    last_study: { category_id: 331, question_id: 1, updated_at: '2026-10-01T00:00:00Z' },
    remote_seeded_at: '2026-09-30T00:00:00Z',
    pending_remote_operations: [{ questionId: '1', payload: { mastery: 'mastered' } }],
    pending_unknown_states: { 99999: { source: 'reconcile' } },
    local_activity: { marker: 'local' }, remote_activity: { marker: 'remote' }, remote_last_study: { question_id: 2 },
  };
  assert.equal((await send('/api/state', 'PUT', initial)).status, 200);
  // 浏览历史与 AI 档案属于当前安装：用正式接口预填
  assert.equal((await send('/api/visit-history', 'POST', { question_id: '31001', category_id: '331', chapter_id: '9', visited_at: '2026-10-01T00:00:00Z' })).status, 200);
  assert.equal((await send('/api/ai/profiles', 'POST', { name: '本机测试服务', baseUrl: 'http://127.0.0.1:8080/v1', model: 'demo-model' })).status, 200);
  const aiRaw = await fs.readFile(path.join(dir, 'ai-profiles.json'), 'utf8');
  const historyBefore = await get('/api/visit-history');

  // revision 原始值缺失/null/空串 → 409，不能被 Number() 折成 0 后误清
  for (const body of [{ reset_generation: 0 }, { revision: null, reset_generation: 0 }, { revision: '', reset_generation: 0 }]) {
    const blocked = await clear(body);
    assert.equal(blocked.status, 409, JSON.stringify(body));
    assert.equal((await blocked.json()).code, 'REVISION_REQUIRED');
  }
  assert.equal((await send('/api/state', 'PUT', { revision: null, progress: {} })).status, 409, '整份 PUT 同样不接受 null revision');
  // revision 冲突 → 409
  assert.equal((await clear({ revision: 0, reset_generation: 0 })).status, 409);
  // 代次缺失/不符/非数字 → 428
  for (const body of [{ revision: 1 }, { revision: 1, reset_generation: 1 }, { revision: 1, reset_generation: '0' }]) {
    assert.equal((await clear(body)).status, 428, JSON.stringify(body));
  }
  const untouched = await state();
  assert.equal(untouched.revision, 1);
  assert.equal(untouched.reset_generation, 0);
  assert.equal(untouched.progress['1'].mastery, 'learning');

  // If-Match 入口清除成功，revision 与代次各 +1
  const cleared = await clear({ reset_generation: 0 }, { 'If-Match': '1' });
  assert.equal(cleared.status, 200);
  const payload = await cleared.json();
  assert.equal(payload.revision, 2);
  assert.equal(payload.reset_generation, 1);
  assert.deepEqual(payload.state.progress, {});
  assert.equal(payload.state.last_study, null);
  for (const key of ['favorites', 'picked', 'annotations', 'remote_seeded_at', 'pending_remote_operations', 'pending_unknown_states', 'local_activity', 'remote_activity', 'remote_last_study']) {
    assert.deepEqual(payload.state[key], initial[key], key);
  }

  // 落盘：state 与学习战报真正清空；AI 档案与浏览历史保持原样
  const onDiskState = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(onDiskState.progress, {});
  assert.equal(onDiskState.last_study, null);
  assert.equal(onDiskState.reset_generation, 1);
  assert.deepEqual(onDiskState.favorites, ['1', '2']);
  assert.equal(onDiskState.annotations['1'].markdown, 'Keep note');
  const onDiskActivity = JSON.parse(await fs.readFile(path.join(dir, 'study-activity.json'), 'utf8'));
  assert.deepEqual(onDiskActivity.events, {});
  assert.deepEqual(onDiskActivity.baseline, {});
  assert.equal(onDiskActivity.reset_generation, 1);
  assert.equal(await fs.readFile(path.join(dir, 'ai-profiles.json'), 'utf8'), aiRaw);
  assert.deepEqual(await get('/api/visit-history'), historyBefore);

  // 重复旧 revision：冲突且不再增加代次
  assert.equal((await clear({ revision: 1, reset_generation: 0 })).status, 409);
  assert.equal((await state()).reset_generation, 1);

  // 整份 PUT / 备份导入伪造更高代次被守卫拒绝，服务端代次不变
  assert.equal((await send('/api/state', 'PUT', { revision: 2, reset_generation: 99, progress: { 1: { mastery: 'mastered' } } })).status, 428);
  assert.equal((await send('/api/state/migrate', 'POST', { reset_generation: 99, progress: { 2: { mastery: 'learning' } } })).status, 428);
  assert.equal((await state()).reset_generation, 1);
  // 带当前代次的整份 PUT / 迁移照常写入，但代次仍保持服务端值
  assert.equal((await send('/api/state', 'PUT', { revision: 2, reset_generation: 1, progress: { 1: { mastery: 'mastered' } } })).status, 200);
  assert.equal((await state()).reset_generation, 1);
  assert.equal((await send('/api/state/migrate', 'POST', { reset_generation: 1, progress: { 2: { mastery: 'learning' } } })).status, 200);
  assert.equal((await state()).reset_generation, 1);

  // 清除后正常逐题写保留代次
  assert.equal((await send('/api/state/questions/3', 'PATCH', { revision: 4, reset_generation: 1, mastery: 'learning' })).status, 200);
  const final = await state();
  assert.equal(final.reset_generation, 1);
  assert.equal(final.progress['3'].mastery, 'learning');
});

test('并发相同 revision 的清除只成功一次，旧 revision 重放不升代次', { timeout: 20000 }, async t => {
  const { base } = await serviceFixture(t);
  const { send, state, clear } = client(base);
  assert.equal((await send('/api/state', 'PUT', { revision: 0, progress: { 1: { mastery: 'learning' } }, favorites: ['1'] })).status, 200);
  const statuses = (await Promise.all([
    clear({ revision: 1, reset_generation: 0 }),
    clear({ revision: 1, reset_generation: 0 }),
  ])).map(response => response.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  const after = await state();
  assert.equal(after.revision, 2);
  assert.equal(after.reset_generation, 1);
  assert.equal((await clear({ revision: 1, reset_generation: 0 })).status, 409, '旧 revision 重放仍是冲突');
  assert.equal((await state()).reset_generation, 1, '重放不得再升代次');
});

test('活动清理失败返回 ACTIVITY_RESET_FAILED：state 已升代次，解除阻塞后自动清理且不返回旧事件', { timeout: 25000 }, async t => {
  const { base, dir, child } = await serviceFixture(t);
  const { send, state, clear, get } = client(base);
  assert.equal((await send('/api/state', 'PUT', { revision: 0, progress: { 1: { mastery: 'learning', updated_at: '2026-10-01T00:00:00Z' } }, favorites: ['1'] })).status, 200);
  // 先成功清除一次，让战报与 state 同代次（下一次预检不写盘），随后新练习仍可记录
  assert.equal((await clear({ revision: 1, reset_generation: 0 })).status, 200);
  const event = { event_id: 'event-00000001', question_id: '5', type: 'study', at: new Date().toISOString(), chapter_id: 'chapter', chapter_name: '极限' };
  assert.equal((await send('/api/study-activity/events', 'POST', { reset_generation: 1, events: [event] })).status, 200);
  assert.equal(Object.keys((await get('/api/study-activity/export')).events).length, 1);

  // 只在隔离 fixture 目录内制造服务写盘失败：同名临时目录占位（不手改业务文件、不动实例锁）
  const blocker = path.join(dir, `study-activity.json.tmp-${child.pid}`);
  await fs.mkdir(blocker);
  const failed = await clear({ revision: 2, reset_generation: 1 });
  assert.equal(failed.status, 500);
  const failure = await failed.json();
  assert.equal(failure.code, 'ACTIVITY_RESET_FAILED');
  assert.match(failure.error, /学习手账与战报清理未完成/);
  assert.equal(failure.current.revision, 3);
  assert.equal(failure.current.reset_generation, 2);
  const partialState = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(partialState.progress, {}, '进度已清除');
  assert.equal(partialState.reset_generation, 2, '代次已推进，不做假回滚');
  const staleActivity = JSON.parse(await fs.readFile(path.join(dir, 'study-activity.json'), 'utf8'));
  assert.equal(staleActivity.reset_generation, 1);
  assert.equal(Object.keys(staleActivity.events).length, 1, '磁盘旧事件尚未清理');

  // 解除阻塞后读取即按同一代次自动清理，不再返回旧事件
  await fs.rm(blocker, { recursive: true, force: true });
  const healed = await get('/api/study-activity/export');
  assert.deepEqual(healed.events, {});
  assert.equal(healed.reset_generation, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'study-activity.json'), 'utf8')).events, {});

  // 新实例（模拟重启）读同一目录也只看到已清理的活动
  const reopened = createStudyActivity(dir, async () => JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')));
  const exported = await reopened.export();
  assert.deepEqual(exported.events, {});
  assert.deepEqual(exported.baseline, {});
  assert.equal(exported.reset_generation, 2);
});
