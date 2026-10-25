import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

// 学习活动客户端的代次适配（T6b）：真实 web/ui-version.js + web/study-activity-client.js 在 VM 中运行，
// 只验证本条需求声明的行为：握手、代次随请求、428 废弃、暂停/恢复、缓存代次、restore 与清除事件。
const clientSource = await fs.readFile(new URL("../web/study-activity-client.js", import.meta.url), "utf8");
const uiVersionSource = await fs.readFile(new URL("../web/ui-version.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const jsonResponse = (payload, status = 200) => ({ ok: status < 400, status, async json() { return payload; } });
const eventKey = id => `daguan_study_event_v1:${id}`;
const studyEvent = id => JSON.stringify({ event_id: id, question_id: "5", type: "study", at: new Date().toISOString() });

function clientFixture({ state = { revision: 1, reset_generation: 0, progress: {} }, exportDoc, respond } = {}) {
  const makeStorage = () => {
    const data = new Map();
    return {
      data,
      storage: {
        getItem: key => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => { data.set(key, String(value)); },
        removeItem: key => { data.delete(key); },
        key: index => [...data.keys()][index] ?? null,
        get length() { return data.size; },
      },
    };
  };
  const local = makeStorage();
  const session = makeStorage();
  const calls = [];
  const listeners = new Map();
  let uuid = 0;
  // 浏览器里 window === globalThis，CustomEvent 同时挂在 window 与全局；测试桩必须一致。
  class CustomEventStub { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
  const root = {
    localStorage: local.storage,
    sessionStorage: session.storage,
    crypto: { randomUUID: () => `uuid-${++uuid}` },
    CustomEvent: CustomEventStub,
    addEventListener: (type, handler) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(handler); },
    dispatchEvent: event => { for (const handler of listeners.get(event.type) || []) handler(event); return true; },
  };
  const fetchStub = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const call = { url, method: options.method || "GET", body };
    calls.push(call);
    if (respond) {
      const custom = await respond(call);
      if (custom !== undefined) return custom;
    }
    if (url === "./api/state") return jsonResponse(state);
    if (url.endsWith("/export")) return jsonResponse(exportDoc || { version: 1, started_at: "2026-10-01T00:00:00.000Z", baseline: {}, events: {}, revision: 5, reset_generation: state.reset_generation });
    if (url.endsWith("/events")) return jsonResponse({ ok: true, accepted: (body?.events || []).map(item => item.event_id) });
    if (url.endsWith("/merge")) return jsonResponse({ ok: true });
    throw new Error(`未预期的请求：${url}`);
  };
  const context = vm.createContext({
    window: root,
    localStorage: local.storage,
    sessionStorage: session.storage,
    document: { visibilityState: "visible", addEventListener: () => {} },
    fetch: fetchStub,
    CustomEvent: CustomEventStub,
    AbortSignal,
    crypto: root.crypto,
    console,
    // 后台定时器不参与本测试，避免测试进程被 interval 挂住。
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
    clearInterval: () => {},
  });
  vm.runInContext(uiVersionSource, context);
  vm.runInContext(clientSource, context);
  return {
    api: root.DaguanStudyActivity,
    reset: root.DaguanVersions.progressReset,
    root, local, session, calls,
    // 首屏预热（握手 + export）是异步的，等它落定再开始断言。
    settle: async () => { for (let index = 0; index < 5; index += 1) await tick(); },
    context,
  };
}

test("学习活动客户端：首次 flush 前握手 adopt，events 体携带捕获代次并清空队列与写入带代次缓存", async () => {
  const f = clientFixture({ state: { revision: 4, reset_generation: 3, progress: {} } });
  await f.settle();
  f.local.storage.setItem(eventKey("evt-aaaaaaaa"), studyEvent("evt-aaaaaaaa"));
  f.calls.length = 0;
  const flushed = await f.api.flush();
  assert.equal(flushed, true);
  assert.equal(f.calls[0].url, "./api/state", "推送队列前必须先握手");
  const posted = f.calls.find(call => call.url === "./api/study-activity/events");
  assert.equal(posted.body.reset_generation, 3);
  assert.equal(posted.body.events.length, 1);
  assert.equal(f.local.data.has(eventKey("evt-aaaaaaaa")), false);
  assert.equal(JSON.parse(f.local.data.get("daguan_study_backup_cache_v1")).reset_generation, 3);
  assert.equal(f.reset.current(), 3);
  assert.equal(f.reset.stored(), 3);
});

test("学习活动客户端：428 采纳服务端代次并废弃旧批，不重新标记重试", async () => {
  const current = { revision: 9, reset_generation: 2, progress: {} };
  const f = clientFixture({
    state: { revision: 4, reset_generation: 1, progress: {} },
    respond: call => (call.url.endsWith("/events") ? jsonResponse({ ok: false, code: "PROGRESS_RESET_REQUIRED", error: "做题记录已清除，请刷新页面", current }, 428) : undefined),
  });
  await f.settle();
  f.local.storage.setItem(eventKey("evt-bbbbbbbb"), studyEvent("evt-bbbbbbbb"));
  f.calls.length = 0;
  const flushed = await f.api.flush();
  assert.equal(flushed, false);
  assert.equal(f.api.lastFailure().code, "PROGRESS_RESET_REQUIRED");
  assert.equal(f.reset.current(), 2, "必须采纳 428 响应里的 current 代次");
  assert.equal(f.reset.stored(), 2);
  assert.equal(f.calls.filter(call => call.url.endsWith("/events")).length, 1, "旧 payload 不得重新标记后再发一次");
  assert.equal(f.local.data.has(eventKey("evt-bbbbbbbb")), false, "旧批由代次清场移除");
});

test("学习活动客户端：pauseForReset 等待在飞写入，暂停期间拒绝新 flush，resume 保留队列继续", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = clientFixture({
    state: { revision: 2, reset_generation: 0, progress: {} },
    respond: async call => { if (call.url.endsWith("/events")) await gate; return undefined; },
  });
  await f.settle();
  f.local.storage.setItem(eventKey("evt-cccccccc"), studyEvent("evt-cccccccc"));
  const running = f.api.flush();
  const pausing = f.api.pauseForReset();
  await tick();
  assert.equal(await f.api.flush(), false, "暂停期间不得开始新的推送");
  assert.equal(f.api.lastFailure().code, "PROGRESS_RESET_PAUSED");
  release();
  assert.equal(await running, true);
  assert.equal(await pausing, true);
  f.local.storage.setItem(eventKey("evt-dddddddd"), studyEvent("evt-dddddddd"));
  assert.equal(await f.api.resumeAfterReset(), true);
  assert.equal(f.local.data.has(eventKey("evt-dddddddd")), false, "恢复后原队列正常重放");
});

test("学习活动客户端：restore 先握手再按当前代次入队；progress-reset 重置本页会话", async () => {
  const f = clientFixture({ state: { revision: 3, reset_generation: 1, progress: {} } });
  await f.settle();
  f.api.beginSingle("7");
  assert.ok(f.session.data.has("daguan_study_sessions_v1"));
  f.calls.length = 0;
  await f.api.restore({ version: 1, started_at: "2026-10-01T00:00:00.000Z", baseline: {}, events: {} });
  assert.equal(f.calls[0].url, "./api/state", "显式导入必须先握手");
  const merge = f.calls.find(call => call.url === "./api/study-activity/merge");
  assert.equal(merge.body.reset_generation, 1, "备份按当前代次入队，不因备份原代次被拒");
  f.root.dispatchEvent({ type: "daguan:progress-reset" });
  assert.equal(f.session.data.has("daguan_study_sessions_v1"), false, "清除事件必须重置本页会话存储");
  f.calls.length = 0;
  f.api.beginSingle("8");
  f.api.study("8", { chapter_id: "1" });
  const saved = JSON.parse(f.session.data.get("daguan_study_sessions_v1"));
  assert.deepEqual(Object.keys(saved.sessions), ["8"], "内存 sessions 已重置，旧题不再出现");
});

test("学习活动客户端：export 离线只接受当前代次缓存，过期缓存显式报错", async () => {
  const f = clientFixture({
    state: { revision: 2, reset_generation: 2, progress: {} },
    respond: call => (call.url.endsWith("/export") ? Promise.reject(new Error("offline")) : undefined),
  });
  await f.settle();
  const base = { version: 1, started_at: "2026-10-01T00:00:00.000Z", baseline: {}, events: {}, revision: 1 };
  f.local.storage.setItem("daguan_study_backup_cache_v1", JSON.stringify({ ...base, reset_generation: 1 }));
  await assert.rejects(f.api.export(), error => error.code === "PROGRESS_RESET_STALE_EXPORT");
  f.local.storage.setItem("daguan_study_backup_cache_v1", JSON.stringify({ ...base, reset_generation: 2 }));
  const data = await f.api.export();
  assert.deepEqual(structuredClone(data.events), {}, "当前代次缓存可离线回放");
  assert.equal(data.reset_generation, 2);
});

test("学习活动客户端：老安装文档缺扩展代次字段时按 0 兼容，当前代次更高必须拒绝", async () => {
  // 老安装升级：服务端文档没有 reset_generation，当前代次仍为 0 → 正常导出并缓存
  const legacyDoc = { version: 1, started_at: "2026-10-01T00:00:00.000Z", baseline: {}, events: {}, revision: 3 };
  const oldInstall = clientFixture({ state: { revision: 3, reset_generation: 0, progress: {} }, exportDoc: legacyDoc });
  await oldInstall.settle();
  oldInstall.local.data.delete("daguan_study_backup_cache_v1");
  const exported = await oldInstall.api.export();
  assert.deepEqual(structuredClone(exported.events), {}, "老文档导出必须成功");
  assert.equal(JSON.parse(oldInstall.local.data.get("daguan_study_backup_cache_v1")).reset_generation, 0, "缓存按代次 0 写入");

  // 当前代次已推进（2）而文档缺字段：不能当成新代次，必须显式拒绝且不写缓存
  const cleared = clientFixture({ state: { revision: 3, reset_generation: 2, progress: {} }, exportDoc: legacyDoc });
  await cleared.settle();
  cleared.local.data.delete("daguan_study_backup_cache_v1");
  await assert.rejects(cleared.api.export(), error => error.code === "PROGRESS_RESET_STALE_EXPORT");
  assert.equal(cleared.local.data.has("daguan_study_backup_cache_v1"), false, "缺字段的旧文档不得写进新代次缓存");
});

test("学习活动客户端：在飞 export 遇代次变化、或服务端快照代次不同，都拒绝且不写缓存", async () => {
  let releaseExport;
  const gate = new Promise(resolve => { releaseExport = resolve; });
  const state = { revision: 1, reset_generation: 1, progress: {} };
  const inFlightCase = clientFixture({
    state,
    respond: async call => (call.url.endsWith("/export")
      ? gate.then(() => jsonResponse({ version: 1, started_at: "2026-10-01T00:00:00.000Z", baseline: {}, events: {}, revision: 6, reset_generation: 1 }))
      : undefined),
  });
  await inFlightCase.settle();
  inFlightCase.local.data.delete("daguan_study_backup_cache_v1");
  const pending = inFlightCase.api.export();
  await tick();
  state.reset_generation = 2;
  await inFlightCase.api.handshake();
  releaseExport();
  await assert.rejects(pending, error => error.code === "PROGRESS_RESET_STALE_EXPORT");
  assert.equal(inFlightCase.local.data.has("daguan_study_backup_cache_v1"), false, "在飞旧快照不得写回缓存");

  const mismatched = clientFixture({
    state: { revision: 1, reset_generation: 3, progress: {} },
    exportDoc: { version: 1, started_at: "2026-10-01T00:00:00.000Z", baseline: {}, events: {}, revision: 7, reset_generation: 5 },
  });
  await mismatched.settle();
  mismatched.local.data.delete("daguan_study_backup_cache_v1");
  await assert.rejects(mismatched.api.export(), error => error.code === "PROGRESS_RESET_STALE_EXPORT");
  assert.equal(mismatched.local.data.has("daguan_study_backup_cache_v1"), false, "代次不同的服务端快照不得强行贴捕获代次写入");
});

test("学习活动客户端：同一毫秒内的 answer 与 reveal 也按发出顺序严格递增 at", async () => {
  const f = clientFixture();
  await f.settle();
  // 冻结时钟：两次事件在同一毫秒产生，靠客户端单调时间戳保证顺序。
  let frozen = 1_700_000_000_000;
  f.context.__now = () => frozen;
  vm.runInContext("Date = class extends Date { constructor(...args) { super(...(args.length ? args : [globalThis.__now()])); } static now() { return globalThis.__now(); } };", f.context);
  f.local.data.clear();
  f.api.answer("5", true, true, { chapter_name: "极限" });
  f.api.reveal("5");
  const events = [...f.local.data.entries()]
    .filter(([key]) => key.startsWith("daguan_study_event_v1:"))
    .map(([, value]) => JSON.parse(value))
    .sort((a, b) => a.at.localeCompare(b.at));
  assert.deepEqual(events.map(event => event.type), ["answer", "reveal"], "作答在前、揭示在后");
  assert.ok(events[0].at < events[1].at, `同一毫秒内 at 必须严格递增：${events.map(event => event.at).join(" / ")}`);
  assert.equal(Date.parse(events[0].at), frozen);
  assert.equal(Date.parse(events[1].at), frozen + 1);
  frozen += 5000;
  f.api.answer("5", false, true, {});
  const third = [...f.local.data.entries()]
    .filter(([key]) => key.startsWith("daguan_study_event_v1:"))
    .map(([, value]) => JSON.parse(value))
    .find(event => Date.parse(event.at) === frozen);
  assert.ok(third, "时钟前进后直接使用当前时间，不继续人为 +1");
});
