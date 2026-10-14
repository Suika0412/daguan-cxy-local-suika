import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// 本仓库当前没有可用的 Playwright/Chromium 环境（npm test 会因缺少浏览器失败），
// 因此这里用最小 DOM 桩对 web/ai-settings.js 做合同级验证：远程只读禁用、
// clearKey 提交、Key 状态提示与流式开关行为。真实浏览器交互未在此环境执行。
const source = fs.readFileSync(new URL("../web/ai-settings.js", import.meta.url), "utf8");

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function createHarness({ runtime, profiles = [], savedProfile }) {
  const calls = [];
  const listeners = {};
  const fields = {};
  for (const name of ["name", "baseUrl", "model", "key", "streaming", "clearKey"]) {
    fields[name] = { name, type: name === "streaming" || name === "clearKey" ? "checkbox" : "text", value: "", checked: name === "streaming", disabled: false, hidden: false, dataset: {}, focus() {} };
  }
  const button = (name, dataset, type = "button") => ({ name, type, dataset, disabled: false, textContent: name });
  const buttons = {
    new: button("new", { action: "new", config: "1" }),
    submit: button("submit", { config: "1" }, "submit"),
    models: button("models", { action: "models", config: "1" }),
    text: button("text", { action: "text", config: "1" }),
    vision: button("vision", { action: "vision", config: "1" }),
    cancel: button("cancel", { action: "cancel" }),
    edit: button("edit", { edit: "p1", config: "1" }),
    use: button("use", { use: "p1" }),
    delete: button("delete", { delete: "p1", config: "1" }),
  };
  const elements = {
    form: { hidden: true, elements: { namedItem: (name) => fields[name] || null }, addEventListener: (type, fn) => { listeners[`form:${type}`] = fn; } },
    "[data-status]": { textContent: "", dataset: {} },
    "[data-list]": { innerHTML: "" },
    "[data-key-status]": { textContent: "", dataset: {} },
    "[data-endpoint]": { textContent: "" },
    "[data-title]": { textContent: "" },
    datalist: { innerHTML: "" },
    "[data-storage]": { textContent: "" },
    "[data-clear-key]": { hidden: true },
  };
  const host = {
    classList: { add() {}, remove() {}, toggle() {} },
    innerHTML: "",
    dataset: {},
    querySelector: (selector) => elements[selector] || null,
    querySelectorAll: () => [...Object.values(buttons), ...Object.values(fields)],
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const fetchStub = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
    if (url.includes("/api/runtime")) return { ok: true, json: async () => ({ ok: true, aiConfig: runtime }) };
    if (url.includes("/api/ai/profiles")) {
      if (method === "GET") return { ok: true, json: async () => ({ ok: true, profiles }) };
      return { ok: true, json: async () => ({ ok: true, profile: savedProfile }) };
    }
    return { ok: true, json: async () => ({ ok: true, models: ["math-model"] }) };
  };
  const sandbox = { window: {}, fetch: fetchStub, confirm: () => true, console, setTimeout, clearTimeout };
  vm.runInContext(source, vm.createContext(sandbox));
  const hooks = { selectedId: () => "p1", busy: () => false, allowed: () => true, select() {}, changed() {} };
  return {
    api: sandbox.window.DaguanAISettings,
    host, hooks, buttons, fields, elements, calls,
    click: (name) => listeners.click({ target: { closest: () => buttons[name] } }),
    submitForm: () => listeners["form:submit"]({ preventDefault() {} }),
    inputForm: () => listeners["form:input"](),
  };
}

const savedProfile = { id: "p1", name: "我的服务", baseUrl: "http://127.0.0.1:9/v1", model: "math-model", streaming: true, hasKey: true, keyStatus: "ok", capabilities: {} };

test("远程只读标志真正禁用 AI 配置操作并保留服务选择", async () => {
  const harness = createHarness({
    runtime: { writable: false, backend: "dpapi", encrypted: true, persistent: true, available: true },
    profiles: [{ id: "p1", name: "已保存服务", baseUrl: "http://127.0.0.1:9/v1", model: "math-model", streaming: true, hasKey: true, keyStatus: "ok", capabilities: {} }],
  });
  harness.api.mount(harness.host, harness.hooks);
  await flush();
  for (const name of ["new", "edit", "delete", "submit", "models", "text", "vision"]) {
    assert.equal(harness.buttons[name].disabled, true, `${name} 应在远程只读时禁用`);
  }
  assert.equal(harness.buttons.use.disabled, false, "选择服务按钮必须保留");
  assert.match(harness.elements["[data-storage]"].textContent, /DPAPI/);
  assert.match(harness.elements["[data-storage]"].textContent, /远程只读/);
  harness.click("new");
  assert.equal(harness.elements.form.hidden, true, "远程只读不得打开编辑表单");
  assert.match(harness.elements["[data-status]"].textContent, /只读/);
  harness.click("edit");
  assert.equal(harness.elements.form.hidden, true);
  harness.click("delete");
  assert.match(harness.elements["[data-status]"].textContent, /只读/);
  assert.ok(!harness.calls.some((call) => ["POST", "PATCH", "DELETE"].includes(call.method)), "远程只读不得发起配置写请求");
  assert.ok(harness.calls.some((call) => call.url === "./api/runtime" && call.method === "GET"));
  assert.ok(harness.calls.some((call) => call.url === "./api/ai/profiles" && call.method === "GET"));
});

test("本机会话可打开表单、提交 clearKey 并提示基地址更改后重新提供 Key", async () => {
  const harness = createHarness({ runtime: { writable: true, backend: "memory", encrypted: false, persistent: false, available: true }, profiles: [], savedProfile });
  harness.api.mount(harness.host, harness.hooks);
  await flush();
  assert.equal(harness.buttons.new.disabled, false);
  harness.click("new");
  assert.equal(harness.elements.form.hidden, false);
  assert.equal(harness.elements["[data-title]"].textContent, "新增服务");
  harness.fields.name.value = "我的服务";
  harness.fields.baseUrl.value = "http://127.0.0.1:9/v1";
  harness.fields.key.value = "sk-fake-ui-key";
  harness.submitForm();
  await flush();
  const created = harness.calls.find((call) => call.url === "./api/ai/profiles" && call.method === "POST");
  assert.ok(created, "保存应 POST /api/ai/profiles");
  assert.equal(created.body.key, "sk-fake-ui-key");
  assert.equal(created.body.clearKey, false);
  assert.match(harness.elements["[data-status]"].textContent, /服务已保存/);
  assert.match(harness.elements["[data-storage]"].textContent, /未加密/);

  // 重新挂载到带已保存 Key 的档案：基地址改动后要求重新提供 Key，clearKey 可见。
  const editing = createHarness({
    runtime: { writable: true, backend: "dpapi", encrypted: true, persistent: true, available: true },
    profiles: [{ id: "p1", name: "已保存服务", baseUrl: "http://127.0.0.1:9/v1", model: "math-model", streaming: true, hasKey: true, keyStatus: "ok", capabilities: {} }],
    savedProfile,
  });
  editing.api.mount(editing.host, editing.hooks);
  await flush();
  editing.click("edit");
  assert.equal(editing.elements.form.hidden, false);
  assert.match(editing.elements["[data-key-status]"].textContent, /已保存；留空沿用/);
  assert.equal(editing.elements["[data-clear-key]"].hidden, false);
  editing.fields.baseUrl.value = "http://127.0.0.1:10/v1";
  editing.inputForm();
  assert.match(editing.elements["[data-key-status]"].textContent, /基地址已更改：请重新填写 API Key/);
  editing.fields.clearKey.checked = true;
  editing.submitForm();
  await flush();
  const patched = editing.calls.find((call) => call.url === "./api/ai/profiles/p1" && call.method === "PATCH");
  assert.ok(patched);
  assert.equal(patched.body.clearKey, true);
});

test("Key 解密失败状态在列表与编辑提示中可见", async () => {
  const harness = createHarness({
    runtime: { writable: true, backend: "dpapi", encrypted: true, persistent: true, available: true },
    profiles: [{ id: "p1", name: "损坏服务", baseUrl: "http://127.0.0.1:9/v1", model: "math-model", streaming: true, hasKey: false, keyStatus: "unreadable", capabilities: {} }],
    savedProfile,
  });
  harness.api.mount(harness.host, harness.hooks);
  await flush();
  assert.match(harness.elements["[data-list]"].innerHTML, /需重新填写/);
  harness.click("edit");
  assert.match(harness.elements["[data-key-status]"].textContent, /解密失败/);
  assert.equal(harness.elements["[data-clear-key]"].hidden, true);
});

test("保存后回显旧 Key 已清除且需重新填写", async () => {
  const cleared = { ...savedProfile, keyCleared: true, warning: "接口地址已变更，旧 Key 已丢弃", hasKey: false, keyStatus: "none" };
  const harness = createHarness({
    runtime: { writable: true, backend: "dpapi", encrypted: true, persistent: true, available: true },
    profiles: [{ id: "p1", name: "已保存服务", baseUrl: "http://127.0.0.1:9/v1", model: "math-model", streaming: true, hasKey: true, keyStatus: "ok", capabilities: {} }],
    savedProfile: cleared,
  });
  harness.api.mount(harness.host, harness.hooks);
  await flush();
  harness.click("edit");
  harness.fields.baseUrl.value = "http://127.0.0.1:11/v1";
  harness.submitForm();
  await flush();
  const status = harness.elements["[data-status]"].textContent;
  assert.match(status, /旧 Key 已清除/);
  assert.match(status, /请重新填写 API Key/);
  assert.match(status, /接口地址已变更/);
});

test("只有 warning 未清除 Key 时不得谎称 Key 已清除", async () => {
  // warning 也可能表示旧版加密已无法解密、但密文被保留：此时 Key 未被清除，
  // 文案不得引导用户“重新填写并再次保存”而覆盖掉可恢复的密文。
  const harness = createHarness({
    runtime: { writable: true, backend: "dpapi", encrypted: true, persistent: true, available: true },
    profiles: [],
    savedProfile: { ...savedProfile, keyCleared: false, warning: "旧版加密已无法解密，密文已保留", hasKey: true, keyStatus: "unreadable" },
  });
  harness.api.mount(harness.host, harness.hooks);
  await flush();
  harness.click("new");
  harness.submitForm();
  await flush();
  const status = harness.elements["[data-status]"].textContent;
  assert.doesNotMatch(status, /旧 Key 已清除/);
  assert.doesNotMatch(status, /请重新填写 API Key/);
  assert.match(status, /服务已保存/);
  assert.match(status, /旧版加密已无法解密，密文已保留/);
});

test("流式开关遵循只读标志", async () => {
  const readOnly = createHarness({ runtime: { writable: false, backend: "dpapi", encrypted: true, persistent: true, available: true }, profiles: [] });
  const input = { checked: true, disabled: false, dataset: {}, addEventListener: (type, fn) => { readOnly.listeners = readOnly.listeners || {}; readOnly.listeners[type] = fn; } };
  const errors = [];
  readOnly.api.bindStreaming(input, { profile: () => ({ id: "p1", streaming: true }), busy: () => false, allowed: () => true, error: (message) => errors.push(message), changed() {} });
  await flush();
  assert.equal(input.disabled, true, "远程只读应禁用流式开关");
  readOnly.listeners.change();
  assert.equal(input.checked, true, "远程只读不得改动流式设置");
  assert.match(errors[0], /只读/);

  const writable = createHarness({ runtime: { writable: true, backend: "dpapi", encrypted: true, persistent: true, available: true }, profiles: [], savedProfile });
  const toggle = { checked: true, disabled: false, dataset: {}, addEventListener: (type, fn) => { writable.listeners = writable.listeners || {}; writable.listeners[type] = fn; } };
  writable.api.bindStreaming(toggle, { profile: () => ({ id: "p1", streaming: true }), busy: () => false, allowed: () => true, error() {}, changed() {} });
  await flush();
  assert.equal(toggle.disabled, false);
  toggle.checked = false;
  writable.listeners.change();
  await flush();
  const patch = writable.calls.find((call) => call.url === "./api/ai/profiles/p1" && call.method === "PATCH");
  assert.ok(patch);
  assert.equal(patch.body.streaming, false);
});

test("页面与 Service Worker 引用同步到新版本", () => {
  const indexHtml = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const legacyHtml = fs.readFileSync(new URL("../web/legacy.html", import.meta.url), "utf8");
  const sw = fs.readFileSync(new URL("../web/service-worker.js", import.meta.url), "utf8");
  for (const html of [indexHtml, legacyHtml]) {
    assert.ok(html.includes("./ai-settings.js?v=2"), html.includes("ai-settings") ? "ai-settings 版本" : "");
    assert.ok(html.includes("./ai-services.css?v=2"));
  }
  assert.ok(sw.includes('"./ai-settings.js?v=2"'));
  assert.ok(sw.includes('"./ai-services.css?v=2"'));
  assert.match(sw, /daguan-shell-v167/);
  // 旧版入口保持既有 165 注册；新版入口跟随本次 167。
  for (const [app, version] of [["app-new.js", "167"], ["app-legacy.js", "165"], ["app2.js", "165"]]) {
    const text = fs.readFileSync(new URL(`../web/${app}`, import.meta.url), "utf8");
    assert.ok(text.includes(`service-worker.js?v=${version}`), app);
  }
});
