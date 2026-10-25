import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

// 新版状态同步的代次适配（T7）：真实 web/ui-version.js + web/new-state.js 工厂在 VM 中运行。
// 只覆盖本条需求声明的行为：代次吸收、内存清场、请求绑定代次、428/409、清除动作与依赖缺失。
const newStateSource = await fs.readFile(new URL("../web/new-state.js", import.meta.url), "utf8");
const uiVersionSource = await fs.readFile(new URL("../web/ui-version.js", import.meta.url), "utf8");
const json = (payload, status = 200) => ({ ok: status < 400, status, async json() { return payload; } });
const clone = value => structuredClone(value);
const OLD = "2026-10-01T00:00:00.000Z";
const NEW = "2026-10-02T00:00:00.000Z";

function fixture({ initial, respond } = {}) {
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
  const toasts = [];
  const listeners = new Map();
  let state = initial;
  class CustomEventStub { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
  const study = { pauses: 0, resumes: 0, async pauseForReset() { this.pauses += 1; return true; }, async resumeAfterReset() { this.resumes += 1; return true; } };
  const root = {
    localStorage: local.storage,
    sessionStorage: session.storage,
    Crypto: undefined,
    crypto: { randomUUID: () => "uuid-1" },
    CustomEvent: CustomEventStub,
    DaguanStudyActivity: study,
    addEventListener: (type, handler) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(handler); },
    dispatchEvent: event => { for (const handler of listeners.get(event.type) || []) handler(event); return true; },
    location: { pathname: "/index.html", href: "http://localhost/index.html", replace: () => {} },
  };
  const fetchStub = async (url, options = {}) => {
    const method = options.method || "GET";
    const call = { url, method, body: options.body ? JSON.parse(options.body) : null, ifMatch: options.headers ? options.headers["If-Match"] ?? null : null, calls };
    calls.push(call);
    if (respond) {
      const custom = await respond(call);
      if (custom !== undefined) return custom;
    }
    if (url === "./api/state" && method === "GET") return json(clone(state));
    throw new Error(`未预期的请求：${method} ${url}`);
  };
  const documentStub = { visibilityState: "visible", getElementById: () => null, addEventListener: () => {} };
  const context = vm.createContext({
    window: root,
    localStorage: local.storage,
    sessionStorage: session.storage,
    document: documentStub,
    fetch: fetchStub,
    CustomEvent: CustomEventStub,
    AbortSignal,
    crypto: root.crypto,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
  });
  vm.runInContext(uiVersionSource, context);
  vm.runInContext(newStateSource, context);
  const api = root.DaguanNewState.create({
    window: root,
    document: documentStub,
    localStorage: local.storage,
    sessionStorage: session.storage,
    fetch: fetchStub,
    AppState: { currentView: "home" },
    normalizeFontScale: value => value,
    resolveChapterForQuestion: () => null,
    toast: message => toasts.push(message),
    getAccess: () => ({ privateAllowed: () => true }),
    getRenderer: () => ({}),
    getApp: () => ({}),
  });
  return { ...api, root, local, session, calls, toasts, study, currentState: () => state, setState: next => { state = next; }, reset: root.DaguanVersions.progressReset };
}

const pendingJournal = () => JSON.stringify({
  version: 1,
  annotations: { "1": { markdown: "待同步批注", updated_at: NEW, queued_at: 1 } },
  questions: { "1": { patch: { mastery: "mastered", seen: true, favorite: true, favorite_updated_at: NEW }, updated_at: NEW, queued_at: 1 } },
});
const patchResponder = ({ status = 200, payload } = {}) => call => {
  if (call.url.startsWith("./api/state/questions/")) return json(payload || { ok: true, revision: 6, state: {} }, status);
  if (call.url === "./api/state/last-study") return json({ ok: true, revision: 6, state: {} });
  return undefined;
};

test("新版同步：hydrate 发现新代次时用远端 progress 替换本地旧练习，清内存队列，收藏与待同步编辑保留", async () => {
  const f = fixture({
    initial: { revision: 1, reset_generation: 1, progress: { "1": { mastery: "learning", updated_at: OLD } }, favorites: ["1"], annotations: { "1": { markdown: "服务端旧批注", updated_at: OLD } } },
    respond: patchResponder(),
  });
  f.local.storage.setItem("daguan_progress_reset_generation_v1", "1");
  await f.StateSync.hydrate();
  assert.equal(f.StateSync.resetGeneration, 1);
  // 本机新增旧练习与待同步编辑，然后服务端被清除（代次 1→2）
  f.local.storage.setItem("daguan_local_progress_v1", JSON.stringify({ "1": { mastery: "mastered", updated_at: NEW }, "2": { mastery: "learning", updated_at: NEW } }));
  f.local.storage.setItem("daguan_pending_sync_v1", pendingJournal());
  f.local.storage.setItem("daguan_question_annotations_v1", JSON.stringify({ "1": { markdown: "待同步批注", updated_at: NEW } }));
  f.StateSync.queueQuestion("2", { mastery: "learning", seen: true });
  assert.equal(f.StateSync.queue.size, 1);
  f.setState({ revision: 5, reset_generation: 2, progress: {}, favorites: ["1"], annotations: {} });
  await f.StateSync.hydrate();
  assert.equal(f.StateSync.resetGeneration, 2);
  const afterProgress = JSON.parse(f.local.storage.getItem("daguan_local_progress_v1"));
  assert.equal("2" in afterProgress, false, "旧练习条目必须消失，不做并集");
  assert.equal(afterProgress["1"].mastery, "not_started", "旧掌握状态不得复活");
  assert.equal("seen" in afterProgress["1"], false, "旧练习字段不得带回");
  assert.equal(afterProgress["1"].favorite, true, "待同步的收藏意图按字段保留");
  assert.deepEqual(JSON.parse(f.local.storage.getItem("daguan_local_favorites_v1")), ["1"], "收藏保留");
  assert.equal(f.StateSync.queue.size, 0, "内存队列已清");
  assert.equal(f.StateSync.lastStudyPending, null);
  const patch = f.calls.find(call => call.url === "./api/state/questions/1");
  assert.deepEqual(Object.keys(patch.body).filter(key => !["revision", "updated_at", "reset_generation"].includes(key)), ["favorite", "favorite_updated_at"], "待同步练习只保留收藏意图");
  assert.equal(patch.body.reset_generation, 2);
  const annotation = f.calls.find(call => call.url.endsWith("/annotation"));
  assert.equal(annotation.body.markdown, "待同步批注", "待同步批注不受清除影响");
});

test("新版同步：逐题写入携带发起代次，428 采纳服务端 current 并废弃旧批（不 requeue）", async () => {
  const current = { revision: 9, reset_generation: 2, progress: {} };
  const f = fixture({
    initial: { revision: 1, reset_generation: 1, progress: {}, favorites: [], annotations: {} },
    respond: call => (call.url.startsWith("./api/state/questions/") ? json({ ok: false, code: "PROGRESS_RESET_REQUIRED", error: "做题记录已清除", current }, 428) : undefined),
  });
  f.local.storage.setItem("daguan_progress_reset_generation_v1", "1");
  await f.StateSync.hydrate();
  f.StateSync.queueQuestion("1", { mastery: "mastered", seen: true });
  const flushed = await f.StateSync.flush();
  assert.equal(flushed, false);
  const patch = f.calls.filter(call => call.url === "./api/state/questions/1");
  assert.equal(patch.length, 1, "旧 payload 不得重发");
  assert.equal(patch[0].body.reset_generation, 1);
  assert.equal(patch[0].ifMatch, "1");
  assert.equal(f.StateSync.resetGeneration, 2, "必须采纳 428 的 current 代次");
  assert.equal(f.StateSync.revision, 9);
  assert.equal(f.StateSync.queue.size, 0, "旧代次 payload 不得 requeue");
});

test("新版同步：clearProgress 暂停写入、等结果、服务端确认后 adopt 并恢复写入", async () => {
  const cleared = { revision: 7, reset_generation: 2, progress: {}, favorites: ["1"], annotations: {} };
  const f = fixture({
    initial: { revision: 1, reset_generation: 1, progress: { "1": { mastery: "mastered", updated_at: NEW } }, favorites: ["1"], annotations: {} },
    respond: call => (call.url === "./api/state/clear-progress" ? json({ ok: true, state: cleared, revision: 7 }, 200) : undefined),
  });
  f.local.storage.setItem("daguan_progress_reset_generation_v1", "1");
  await f.StateSync.hydrate();
  f.StateSync.queueQuestion("1", { mastery: "mastered" });
  const state = await f.StateSync.clearProgress();
  assert.deepEqual(clone(state), cleared);
  const post = f.calls.find(call => call.url === "./api/state/clear-progress");
  assert.equal(post.method, "POST");
  assert.equal(post.ifMatch, "1");
  assert.equal(post.body.reset_generation, 1);
  assert.equal(f.study.pauses, 1, "清除前必须暂停学习活动写入");
  assert.equal(f.study.resumes, 1, "结束后必须恢复写入");
  assert.equal(f.StateSync.resetGeneration, 2);
  assert.equal(f.StateSync.revision, 7);
  assert.equal(f.StateSync.queue.size, 0);
  assert.deepEqual(JSON.parse(f.local.storage.getItem("daguan_local_progress_v1")), {});
  assert.equal(f.local.storage.getItem("daguan_progress_reset_generation_v1"), "2");
});

test("新版同步：清除遇 409 不自动重发；ACTIVITY_RESET_FAILED 显式报部分完成且已采纳代次", async () => {
  const conflict = fixture({
    initial: { revision: 3, reset_generation: 1, progress: {}, favorites: [], annotations: {} },
    respond: call => (call.url === "./api/state/clear-progress" ? json({ ok: false, code: "STATE_CONFLICT", error: "本地状态版本已变化" }, 409) : undefined),
  });
  conflict.local.storage.setItem("daguan_progress_reset_generation_v1", "1");
  await conflict.StateSync.hydrate();
  await assert.rejects(conflict.StateSync.clearProgress(), error => error.code === "STATE_CONFLICT");
  assert.equal(conflict.calls.filter(call => call.url === "./api/state/clear-progress").length, 1, "冲突后不得自动重发破坏性请求");
  assert.equal(conflict.StateSync.resetGeneration, 1, "冲突时代次不前进");

  const partial = fixture({
    initial: { revision: 4, reset_generation: 1, progress: {}, favorites: [], annotations: {} },
    respond: call => (call.url === "./api/state/clear-progress"
      ? json({ ok: false, code: "ACTIVITY_RESET_FAILED", error: "进度已清除，学习记录清理未完成", current: { revision: 8, reset_generation: 2, progress: {} } }, 500)
      : undefined),
  });
  partial.local.storage.setItem("daguan_progress_reset_generation_v1", "1");
  await partial.StateSync.hydrate();
  partial.StateSync.queueQuestion("1", { mastery: "mastered" });
  await assert.rejects(partial.StateSync.clearProgress(), error => error.code === "ACTIVITY_RESET_FAILED" && error.partial === true);
  assert.equal(partial.StateSync.resetGeneration, 2, "部分完成也要采纳服务端已推进的代次");
  assert.equal(partial.StateSync.revision, 8);
  assert.equal(partial.StateSync.queue.size, 0);
  assert.equal(partial.study.resumes, 1, "失败也要恢复写入");
});

test("新版同步：清除期间保留用户意图但不发起新的练习写入；别页已清除时只采纳不重复清除", async () => {
  let releaseClear;
  const gate = new Promise(resolve => { releaseClear = resolve; });
  const cleared = { revision: 7, reset_generation: 2, progress: {}, favorites: [], annotations: {} };
  const f = fixture({
    initial: { revision: 1, reset_generation: 1, progress: {}, favorites: [], annotations: {} },
    respond: async call => {
      if (call.url === "./api/state/clear-progress") { await gate; return json({ ok: true, state: cleared }, 200); }
      return patchResponder()(call);
    },
  });
  f.local.storage.setItem("daguan_progress_reset_generation_v1", "1");
  await f.StateSync.hydrate();
  const clearing = f.StateSync.clearProgress();
  await new Promise(resolve => setTimeout(resolve, 20));
  f.StateSync.queueQuestion("5", { mastery: "learning" });
  assert.equal(await f.StateSync.flush(), false, "暂停期间 flush 不得开始新写入");
  assert.equal(await f.StateSync.pushLastStudy("3", "5"), false, "暂停期间不得写最近学习位置");
  assert.equal(f.calls.some(call => call.url.includes("/questions/5")), false, "暂停期间不产生逐题写入");
  assert.equal(f.calls.some(call => call.url.endsWith("/last-study")), false, "暂停期间不产生位置写入");
  assert.equal(f.StateSync.queue.size, 1, "用户意图保留在内存队列");
  releaseClear();
  await clearing;
  assert.equal(f.StateSync.queue.size, 0, "清除完成后旧练习队列被清");
  assert.equal(f.calls.some(call => call.url.includes("/questions/5")), false, "清除后不再补写旧练习");
});

test("新版同步：清除不覆盖未同步收藏，恢复后按待同步意图补写", async () => {
  const cleared = { revision: 7, reset_generation: 2, progress: {}, favorites: [], annotations: {} };
  const f = fixture({
    initial: { revision: 1, reset_generation: 1, progress: {}, favorites: [], annotations: {} },
    respond: call => (call.url === "./api/state/clear-progress" ? json({ ok: true, state: cleared }, 200) : patchResponder()(call)),
  });
  f.local.storage.setItem("daguan_progress_reset_generation_v1", "1");
  await f.StateSync.hydrate();
  // 离线收藏意图：本机收藏数组 + 待同步日志，服务端仍为空
  f.local.storage.setItem("daguan_local_favorites_v1", JSON.stringify(["9"]));
  f.local.storage.setItem("daguan_pending_sync_v1", JSON.stringify({
    version: 1,
    annotations: {},
    questions: { "9": { patch: { favorite: true, favorite_updated_at: NEW }, updated_at: NEW, queued_at: 1 } },
  }));
  await f.StateSync.clearProgress();
  assert.deepEqual(JSON.parse(f.local.storage.getItem("daguan_local_favorites_v1")), ["9"], "未同步收藏不得被清除响应覆盖");
  const pushed = f.calls.filter(call => call.url === "./api/state/questions/9");
  assert.equal(pushed.length, 1, "恢复写入后应补写保留下来的收藏意图");
  assert.deepEqual(Object.keys(pushed[0].body).filter(key => !["revision", "updated_at", "reset_generation"].includes(key)), ["favorite", "favorite_updated_at"]);
});

test("新版同步：响应丢失时若学习战报未确认清空，必须显式报部分完成而不是成功", async () => {
  const before = { revision: 1, reset_generation: 1, progress: {}, favorites: [], annotations: {} };
  const after = { revision: 6, reset_generation: 2, progress: {}, favorites: [], annotations: {} };
  let stateReads = 0;
  const f = fixture({
    initial: before,
    respond: call => {
      // hydrate、清除前的两次读取都还是旧代次；POST 丢失后核对时才读到新代次。
      if (call.url === "./api/state" && call.method === "GET") {
        stateReads += 1;
        return json(stateReads <= 3 ? before : after);
      }
      if (call.url === "./api/state/clear-progress") throw new Error("response lost");
      if (call.url === "./api/study-activity/export") return json({ version: 1, started_at: OLD, baseline: {}, events: { "evt-aaaaaaaa": { event_id: "evt-aaaaaaaa" } }, reset_generation: 2 });
      return undefined;
    },
  });
  f.local.storage.setItem("daguan_progress_reset_generation_v1", "1");
  await f.StateSync.hydrate();
  await assert.rejects(f.StateSync.clearProgress(), error => error.code === "PROGRESS_CLEAR_PARTIAL" && error.partial === true);
  assert.equal(f.StateSync.resetGeneration, 2, "进度部分已确认，代次仍需采纳");
});

test("新版同步：缺少共享代次 helper 或学习活动客户端时显式失败，不用假实现兜底", async () => {
  const missingReset = fixture({ initial: { revision: 1, reset_generation: 0, progress: {} } });
  delete missingReset.root.DaguanVersions;
  await assert.rejects(missingReset.StateSync.hydrate(), error => error.code === "PROGRESS_RESET_UNAVAILABLE");

  const missingStudy = fixture({ initial: { revision: 1, reset_generation: 0, progress: {} } });
  delete missingStudy.root.DaguanStudyActivity;
  await assert.rejects(missingStudy.StateSync.clearProgress(), error => error.code === "STUDY_ACTIVITY_UNAVAILABLE");
  assert.equal(missingStudy.calls.some(call => call.url === "./api/state/clear-progress"), false, "依赖缺失时不得发出清除请求");
});
