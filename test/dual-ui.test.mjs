import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/ui-version.js", import.meta.url), "utf8");
function fixture(initial = {}, pathname = "/index.html", search = "?entry=resume") {
  const data = new Map(Object.entries(initial));
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const redirects = [];
  const window = { localStorage: storage, document: { documentElement: { dataset: {} } }, location: { pathname, href: `http://localhost${pathname}${search}`, replace: url => redirects.push(url) } };
  vm.runInNewContext(source, { window, URL });
  return { api: window.DaguanVersions, data, storage, redirects };
}
test("first visit defaults to new; saved old preference redirects once and retains entry", () => {
  assert.equal(fixture().redirects.length, 0);
  const old = fixture({ daguan_ui_version_v1: "old" });
  assert.equal(old.redirects[0], "http://localhost/legacy.html?entry=resume");
  assert.equal(fixture({ daguan_ui_version_v1: "old" }, "/legacy.html").redirects.length, 0);
  assert.equal(fixture({ daguan_ui_version_v1: "corrupt" }).redirects.length, 0);
});
test("explicit old entry is allowed and remembered", () => {
  const f = fixture({ daguan_ui_version_v1: "new" }, "/legacy.html");
  assert.equal(f.redirects.length, 0);
  assert.equal(f.api.selected(f.storage), "old");
});
test("explicit ?ui=new overrides a saved old preference and stays on the new entry", () => {
  const f = fixture({ daguan_ui_version_v1: "old" }, "/index.html", "?ui=new");
  assert.equal(f.redirects.length, 0);
  assert.equal(f.storage.getItem(f.api.selectionKey), "new");
});
test("no ui param keeps redirecting a saved old preference to the legacy entry", () => {
  const f = fixture({ daguan_ui_version_v1: "old" }, "/index.html", "?entry=resume");
  assert.equal(f.redirects[0], "http://localhost/legacy.html?entry=resume");
});
test("appearance migration preserves existing data and is idempotent", () => {
  const prefs = JSON.stringify({ theme: "custom", backgroundColor: "#123456" });
  const f = fixture({ daguan_ui_preferences_v1: prefs, daguan_local_progress_v1: "KEEP" });
  assert.equal(f.data.get(f.api.appearanceKeys.old), prefs);
  assert.equal(JSON.parse(f.data.get(f.api.appearanceKeys.new)).theme, "orange-white");
  f.storage.setItem(f.api.appearanceKeys.new, '{"theme":"eye-care"}');
  f.api.migrate(f.storage);
  assert.equal(JSON.parse(f.data.get(f.api.appearanceKeys.new)).theme, 'eye-care');
  assert.equal(f.data.get("daguan_local_progress_v1"), "KEEP");
});
test("switch URL preserves path prefix, query and hash; marks restoration", () => {
  const { api } = fixture();
  assert.equal(api.targetUrl("https://example.test/math/legacy.html?entry=resume&x=2#q", "new", true), "https://example.test/math/index.html?entry=resume&x=2&uiSwitch=1#q");
  assert.notEqual(api.draftKey("1"), api.draftKey("2"));
});
for (const name of ["app2.js", "app-legacy.js"]) {
  const app = fs.readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8");
  test(`${name}: switch no-op, save failure, and AI cancellation prevent navigation`, async () => {
    const start = app.indexOf("  async function setUiVersion(");
    const end = app.indexOf("\n  function saveUiPrefs", start);
    const run = async ({ current = "new", busy = false, confirm = true, fail = false } = {}) => {
      const calls = [];
      const context = vm.createContext({
        switchingVersion: false, window: { DaguanVersions: { current }, location: { assign: () => calls.push("navigate") } },
        aiStreamStates: new Set(busy ? [1] : []), state: { aiRuns: new Map() },
        confirm: () => confirm, document: { querySelectorAll: () => [] },
        saveAiDraft: () => { calls.push("save"); if (fail) throw new Error("disk full"); },
        toast: message => calls.push(message),
      });
      vm.runInContext(app.slice(start, end) + '\nthis.switchVersion = setUiVersion;', context);
      await context.switchVersion("new");
      return calls;
    };
    assert.deepEqual(await run(), []);
    assert.deepEqual(await run({ current: "old", busy: true, confirm: false }), []);
    const failure = await run({ current: "old", fail: true });
    assert.equal(failure[0], "save");
    assert.match(failure[1], /disk full/);
    assert.ok(!failure.includes("navigate"));
  });
  test(`${name}: preserves multi-teacher filters and shared learning keys`, () => {
    for (const teacher of ["帕拉迪宇讲过", "李艳芳讲过", "没咋了讲过"]) assert.ok(app.includes(teacher));
    for (const key of ["daguan_local_progress_v1", "daguan_local_favorites_v1", "daguan_question_annotations_v1"]) assert.ok(app.includes(key));
  });
}

// ---- 共享清除代次契约（DaguanVersions.progressReset） ----
// 只验证本条需求声明的行为：握手前拒绝、代次不倒退、旧代次清场与保留边界、失败不提前提交。
const RESET_KEY = "daguan_progress_reset_generation_v1";
const PROGRESS_KEY = "daguan_local_progress_v1";
const FAVORITES_KEY = "daguan_local_favorites_v1";
function resetFixture(initial = {}, sessionInitial = {}) {
  const makeStorage = source => {
    const data = new Map(Object.entries(source));
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
  const local = makeStorage(initial);
  const session = makeStorage(sessionInitial);
  const events = [];
  const window = {
    localStorage: local.storage,
    sessionStorage: session.storage,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options && options.detail; } },
    dispatchEvent: event => { events.push(event); return true; },
  };
  vm.runInNewContext(source, { window, URL });
  return { api: window.DaguanVersions.progressReset, window, local, session, events };
}
// VM 内创建的对象属于另一个 realm，原型不同会让 deepStrictEqual 直接失败；克隆回宿主 realm 再比较。
const plain = value => structuredClone(value);
test("progressReset: 代次解析、握手前拒绝捕获、初始 0 兼容旧记录且不清存储", () => {
  const f = resetFixture({ [PROGRESS_KEY]: "KEEP" });
  assert.equal(f.api.generationOf(undefined), 0);
  assert.equal(f.api.generationOf({}), 0);
  assert.equal(f.api.generationOf({ reset_generation: 3 }), 3);
  assert.equal(f.api.generationOf({ reset_generation: "2" }), 2);
  for (const invalid of [-1, 1.5, "abc", null, true]) {
    assert.throws(() => f.api.generationOf({ reset_generation: invalid }), error => error.code === "PROGRESS_GENERATION_INVALID", `非法代次 ${String(invalid)} 必须显式报错`);
  }
  assert.equal(f.api.current(), null);
  assert.equal(f.api.stored(), 0);
  assert.throws(() => f.api.capture(), error => error.code === "PROGRESS_GENERATION_UNKNOWN");
  assert.equal(f.api.isCurrent(0), false);
  assert.deepEqual(plain(f.api.adopt({ revision: 1, reset_generation: 0, progress: {} })), { generation: 0, changed: false, storageChanged: false });
  assert.equal(f.local.data.get(PROGRESS_KEY), "KEEP");
  assert.equal(f.local.data.has(RESET_KEY), false);
  assert.equal(f.api.current(), 0);
  assert.equal(f.api.capture(), 0);
  assert.equal(f.api.isCurrent(0), true);
  assert.equal(f.api.isCurrent(1), false);
  assert.equal(f.events.length, 0);
});
test("progressReset: 新代次只清旧练习并按字段剥离待同步队列，收藏批注选题备忘不动", () => {
  const seeded = {
    [PROGRESS_KEY]: JSON.stringify({ "1": { mastery: "mastered", favorite: true }, "2": { mastery: "learning" } }),
    [FAVORITES_KEY]: JSON.stringify(["1"]),
    daguan_question_annotations_v1: JSON.stringify({ "1": { markdown: "保留批注", updated_at: "2026-10-01T00:00:00.000Z" } }),
    daguan_local_picked_v1: JSON.stringify(["1"]),
    daguan_local_notes_v1: JSON.stringify({ "1": "学习备忘" }),
    daguan_ai_preferences_v1: JSON.stringify({ provider: "keep" }),
    daguan_pending_visits_v1: JSON.stringify([{ id: "v1" }]),
    daguan_remote_seeded_at: "2026-09-01T00:00:00.000Z",
    daguan_learning_position_v2: JSON.stringify({ questionId: "1" }),
    "daguan_study_event_v1:evt-1": "{}",
    "daguan_study_restore_v1:evt-1": "{}",
    daguan_study_backup_cache_v1: "{}",
    daguan_restore_pending_v1: "1",
    daguan_restore_rollback_v1: "{}",
    daguan_pending_sync_v1: JSON.stringify({
      version: 1,
      annotations: { "1": { markdown: "待同步批注", updated_at: "2026-10-02T00:00:00.000Z", queued_at: 1 } },
      questions: {
        "1": { patch: { mastery: "mastered", seen: true, favorite: true, favorite_updated_at: "2026-10-02T00:00:00.000Z" }, updated_at: "2026-10-02T00:00:00.000Z", queued_at: 1 },
        "2": { patch: { answered: true, is_favorite: false, is_favorite_updated_at: "2026-10-03T00:00:00.000Z" }, updated_at: "2026-10-03T00:00:00.000Z", queued_at: 2 },
      },
    }),
  };
  const f = resetFixture(seeded, { daguan_learning_position_v2: "{}", daguan_study_sessions_v1: "{}" });
  const result = f.api.adopt({ revision: 4, reset_generation: 2, progress: {} });
  assert.deepEqual(plain(result), { generation: 2, changed: true, storageChanged: true });
  assert.equal(f.local.data.get(PROGRESS_KEY), "{}");
  for (const key of [FAVORITES_KEY, "daguan_question_annotations_v1", "daguan_local_picked_v1", "daguan_local_notes_v1", "daguan_ai_preferences_v1", "daguan_pending_visits_v1", "daguan_remote_seeded_at"]) {
    assert.equal(f.local.data.get(key), seeded[key], `${key} 必须原样保留`);
  }
  for (const key of ["daguan_learning_position_v2", "daguan_study_event_v1:evt-1", "daguan_study_restore_v1:evt-1", "daguan_study_backup_cache_v1", "daguan_restore_pending_v1", "daguan_restore_rollback_v1"]) {
    assert.equal(f.local.data.has(key), false, `${key} 属于旧练习，必须清掉`);
  }
  assert.equal(f.session.data.has("daguan_learning_position_v2"), false);
  assert.equal(f.session.data.has("daguan_study_sessions_v1"), false);
  const journal = JSON.parse(f.local.data.get("daguan_pending_sync_v1"));
  assert.deepEqual(journal.questions, {
    "1": { patch: { favorite: true, favorite_updated_at: "2026-10-02T00:00:00.000Z" }, updated_at: "2026-10-02T00:00:00.000Z", queued_at: 1 },
    "2": { patch: { is_favorite: false, is_favorite_updated_at: "2026-10-03T00:00:00.000Z" }, updated_at: "2026-10-03T00:00:00.000Z", queued_at: 2 },
  });
  assert.deepEqual(journal.annotations, { "1": { markdown: "待同步批注", updated_at: "2026-10-02T00:00:00.000Z", queued_at: 1 } });
  assert.equal(f.local.data.get(RESET_KEY), "2");
  assert.equal(f.api.stored(), 2);
  assert.equal(f.api.isCurrent(2), true);
  assert.equal(f.events.length, 1);
  assert.deepEqual(plain(f.events[0].detail), { generation: 2, changed: true });
  // 同代次重复 adopt：不再删任何东西，也不再发事件
  const again = f.api.adopt({ revision: 5, reset_generation: 2, progress: {} });
  assert.deepEqual(plain(again), { generation: 2, changed: false, storageChanged: false });
  assert.equal(f.local.data.get(PROGRESS_KEY), "{}");
  assert.equal(f.api.isCurrent(2), true);
  assert.equal(f.events.length, 1);
});
test("progressReset: 页面旧但持久戳已是新代次只清本页 session；存储失败与损坏不提前提交代次", () => {
  const f = resetFixture({
    [RESET_KEY]: "3",
    [PROGRESS_KEY]: JSON.stringify({ "1": { mastery: "mastered" } }),
    [FAVORITES_KEY]: JSON.stringify(["1"]),
  }, { daguan_learning_position_v2: "{}", daguan_study_sessions_v1: "{}" });
  const pageStale = f.api.adopt({ revision: 9, reset_generation: 3, progress: {} });
  assert.deepEqual(plain(pageStale), { generation: 3, changed: true, storageChanged: false });
  assert.equal(f.local.data.get(PROGRESS_KEY), JSON.stringify({ "1": { mastery: "mastered" } }), "已属新代次的 storage 不能再清");
  assert.equal(f.local.data.get(RESET_KEY), "3");
  assert.equal(f.session.data.has("daguan_learning_position_v2"), false, "本页旧学习位置必须清");
  assert.equal(f.session.data.has("daguan_study_sessions_v1"), false, "本页旧学习会话必须清");
  assert.deepEqual(plain(f.events[0].detail), { generation: 3, changed: true });

  const failing = resetFixture({ [PROGRESS_KEY]: JSON.stringify({ "1": { mastery: "mastered" } }) });
  failing.api.adopt({ reset_generation: 0, progress: {} });
  const original = failing.local.storage.setItem;
  failing.local.storage.setItem = (key, value) => {
    if (key === PROGRESS_KEY) throw new Error("disk full");
    original(key, value);
  };
  assert.throws(() => failing.api.adopt({ reset_generation: 4, progress: {} }), /disk full/);
  assert.equal(failing.local.data.has(RESET_KEY), false, "清理失败绝不能先写代次戳");
  assert.equal(failing.api.current(), 0, "失败时代次不得前进");
  assert.equal(failing.api.isCurrent(0), true);

  const corrupt = resetFixture({ [PROGRESS_KEY]: "{not-json" });
  assert.throws(() => corrupt.api.adopt({ reset_generation: 1, progress: {} }), error => error.code === "PROGRESS_RESET_STORAGE_CORRUPT");
  assert.equal(corrupt.local.data.has(RESET_KEY), false);

  const badStamp = resetFixture({ [RESET_KEY]: "1.5", [PROGRESS_KEY]: "{}" });
  assert.throws(() => badStamp.api.stored(), error => error.code === "PROGRESS_RESET_STORAGE_CORRUPT");
  assert.throws(() => badStamp.api.adopt({ reset_generation: 2, progress: {} }), error => error.code === "PROGRESS_RESET_STORAGE_CORRUPT");

  const silent = resetFixture({ [PROGRESS_KEY]: JSON.stringify({ "1": { mastery: "mastered" } }) });
  delete silent.window.dispatchEvent;
  assert.throws(() => silent.api.adopt({ reset_generation: 1, progress: {} }), error => error.code === "PROGRESS_RESET_EVENT_UNAVAILABLE");
  assert.equal(silent.local.data.has(RESET_KEY), false, "无法通知时不得提交代次戳");
  assert.equal(silent.local.data.get(PROGRESS_KEY), JSON.stringify({ "1": { mastery: "mastered" } }), "不得先清后失败");

  const backwards = resetFixture({ [RESET_KEY]: "5" });
  assert.throws(() => backwards.api.adopt({ reset_generation: 4, progress: {} }), error => error.code === "STALE_PROGRESS_SNAPSHOT");
  backwards.api.adopt({ reset_generation: 6, progress: {} });
  assert.throws(() => backwards.api.adopt({ reset_generation: 5, progress: {} }), error => error.code === "STALE_PROGRESS_SNAPSHOT");

  const wrapped = resetFixture({ [PROGRESS_KEY]: JSON.stringify({ progress: { "9": { mastery: "mastered" } }, favorites: ["9"] }) });
  wrapped.api.adopt({ reset_generation: 1, progress: {} });
  assert.equal(wrapped.local.data.get(FAVORITES_KEY), JSON.stringify(["9"]), "旧包裹形态里的收藏必须先提取保留");
  assert.equal(wrapped.local.data.get(PROGRESS_KEY), "{}");
});

test("Windows bundle retains both frontends and new logo in its offline shell", () => {
  const build = fs.readFileSync(new URL("../scripts/build-windows-exe.mjs", import.meta.url), "utf8");
  const start = build.indexOf("const WINDOWS_EXCLUDED_WEB_FILES");
  const end = build.indexOf("function writeField", start);
  const ctx = vm.createContext({ Buffer });
  vm.runInContext(build.slice(start, end) + '\nthis.bundle = shouldBundle; this.transform = packageServiceWorker;', ctx);
  const sw = fs.readFileSync(new URL("../web/service-worker.js", import.meta.url));
  const packaged = ctx.transform("web/service-worker.js", sw).toString();
  for (const asset of ["index.html", "legacy.html", "app2.js", "app-legacy.js", "ui-version.js", "design-tokens.css", "assets/landing/local-mark.svg", "assets/landing/local-mark.png"]) {
    assert.equal(ctx.bundle(`web/${asset}`), true, asset);
    assert.ok(packaged.includes(`./${asset}`), asset);
  }
  assert.equal(ctx.bundle("web/landing.html"), false);
  assert.ok(!packaged.includes('"./landing.html"'));
});
