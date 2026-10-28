import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// 本仓库当前没有可用的 Playwright/Chromium 环境（npm test 会因缺少浏览器失败），
// 因此这里用最小 DOM 桩对 web/ai-settings.js 做合同级验证：远程只读禁用（含新增的
// 档位 textarea/select）、clearKey 提交、Key 状态提示、流式开关，以及自定义推理档位的
// JSON CRUD / 默认档位 / dirty 指纹 / 非法 JSON 不 POST。真实浏览器交互未在此环境执行。
const source = fs.readFileSync(new URL("../web/ai-settings.js", import.meta.url), "utf8");

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
const VOID_TAGS = new Set(["input", "img", "br", "hr", "meta", "link", "source", "area", "base", "col", "embed", "param", "track", "wbr"]);

function camel(name) {
  return String(name).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function applyAttrs(node, attrs) {
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
  let match;
  while ((match = re.exec(attrs))) {
    const name = match[1].toLowerCase();
    const value = match[2] === undefined ? "" : match[2];
    node.attributes[name] = value;
    if (name === "id") node.ownerDocument.byId.set(value, node);
    if (name === "class") node.className = value;
    if (name === "name") node.name = value;
    if (name === "type") node.type = value;
    if (name === "value") node.value = value;
    if (name === "checked") node.checked = true;
    if (name === "hidden") node.hidden = true;
    if (name === "disabled") node.disabled = true;
    if (name.startsWith("data-")) node.dataset[camel(name.slice(5))] = value;
  }
}

function decodeEntities(text) {
  return String(text).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e]));
}

// 嵌套感知的极简 HTML 解析：保留标签/属性/层级与文本（textarea 初值、option 文案）。
function parseInto(root, markup, doc) {
  const stack = [root];
  const tokenRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g;
  let lastEnd = 0;
  let match;
  while ((match = tokenRe.exec(markup))) {
    const text = markup.slice(lastEnd, match.index);
    if (text) {
      const top = stack[stack.length - 1];
      if (top && top !== root) {
        const decoded = decodeEntities(text);
        if (top.tagName === "TEXTAREA") top.value = decoded;
        else top.textContent += decoded;
      }
    }
    lastEnd = tokenRe.lastIndex;
    const closing = match[1];
    const name = match[2].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        if (stack[i].tagName === name.toUpperCase()) { stack.length = i; break; }
      }
      continue;
    }
    const node = new FakeElement(name, doc);
    applyAttrs(node, match[3] || "");
    const top = stack[stack.length - 1];
    node.parentNode = top;
    top.children.push(node);
    if (match[4] !== "/" && !VOID_TAGS.has(name)) stack.push(node);
  }
}

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.parentNode = null;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.classes = new Set();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.textContent = "";
    this.markup = "";
    this.name = "";
    this.type = "";
  }

  get classList() {
    const classes = this.classes;
    return {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => { const next = force === undefined ? !classes.has(name) : force; if (next) classes.add(name); else classes.delete(name); return next; },
    };
  }

  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); this.attributes.class = String(value); }
  get className() { return [...this.classes].join(" "); }

  set innerHTML(markup) { this.markup = String(markup); this.children = []; parseInto(this, this.markup, this.ownerDocument); }
  get innerHTML() { return this.markup; }

  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  replaceChildren(...nodes) { this.children = []; nodes.forEach((node) => this.appendChild(node)); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
    for (const [id, node] of this.ownerDocument.byId) if (node === this) this.ownerDocument.byId.delete(id);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "id") this.ownerDocument.byId.set(String(value), this);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; if (name === "id") for (const [id, node] of this.ownerDocument.byId) if (node === this) this.ownerDocument.byId.delete(id); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  removeEventListener(type, listener) { const list = this.listeners.get(type) || []; this.listeners.set(type, list.filter((item) => item !== listener)); }
  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  matches(selector) {
    const sel = String(selector).trim();
    if (!sel) return false;
    if (sel.startsWith("#")) return this.attributes.id === sel.slice(1);
    if (sel.startsWith(".")) return this.classes.has(sel.slice(1));
    if (sel.startsWith("[") && sel.endsWith("]")) {
      const body = sel.slice(1, -1);
      const eq = body.indexOf("=");
      if (eq < 0) return Object.prototype.hasOwnProperty.call(this.attributes, body);
      const name = body.slice(0, eq);
      let value = body.slice(eq + 1);
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      return this.attributes[name] === value;
    }
    return this.tagName === sel.toUpperCase();
  }
  querySelectorAll(selector) {
    const selectors = String(selector).split(",").map((part) => part.trim()).filter(Boolean);
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (selectors.some((sel) => child.matches(sel)) && !found.includes(child)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  focus() {}
  get elements() { return { namedItem: (name) => this.querySelectorAll(`[name="${name}"]`)[0] || null }; }
}

function createFakeEvent(type, patch = {}) {
  return Object.assign({
    type, bubbles: true, cancelable: true, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
  }, patch);
}

function createHarness({ runtime, profiles = [], savedProfile }) {
  const calls = [];
  const document = {
    byId: new Map(),
    createElement: (tag) => new FakeElement(tag, document),
    createTextNode: (text) => { const node = new FakeElement("#text", document); node.textContent = String(text); return node; },
    getElementById: (id) => document.byId.get(id) || null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const fetchStub = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
    if (url.includes("/api/runtime")) return { ok: true, json: async () => ({ ok: true, aiConfig: runtime }) };
    if (url.includes("/api/ai/profiles")) {
      if (method === "GET") return { ok: true, json: async () => ({ ok: true, profiles }) };
      if (method === "DELETE") return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({ ok: true, profile: savedProfile }) };
    }
    return { ok: true, json: async () => ({ ok: true, models: ["math-model"] }) };
  };
  let uuidSeq = 0;
  const sandbox = {
    window: { crypto: { randomUUID: () => `uuid-${++uuidSeq}` } },
    fetch: fetchStub, confirm: () => true, console, setTimeout, clearTimeout, TextEncoder,
  };
  vm.runInContext(source, vm.createContext(sandbox));
  const host = document.createElement("div");
  const hooks = { selectedId: () => "p1", busy: () => false, allowed: () => true, select() {}, changed() {} };
  const api = sandbox.window.DaguanAISettings;
  api.mount(host, hooks);
  const form = () => host.querySelector("form");
  const field = (name) => form().elements.namedItem(name);
  const rows = () => host.querySelectorAll("[data-reasoning-preset]");
  return {
    api, host, hooks, calls, document,
    form, field, rows,
    submit: () => form().dispatchEvent(createFakeEvent("submit")),
    input: () => form().dispatchEvent(createFakeEvent("input")),
    click: (selector) => host.querySelector(selector).dispatchEvent(createFakeEvent("click")),
    status: () => host.querySelector("[data-status]").textContent,
  };
}

const savedProfile = { id: "p1", name: "我的服务", baseUrl: "http://127.0.0.1:9/v1", model: "math-model", streaming: true, hasKey: true, keyStatus: "ok", capabilities: {} };
const writableRuntime = { writable: true, backend: "memory", encrypted: false, persistent: false, available: true };
const readonlyRuntime = { writable: false, backend: "dpapi", encrypted: true, persistent: true, available: true };

test("远程只读标志真正禁用全部配置控件（button/input/select）并保留服务选择", async () => {
  const harness = createHarness({
    runtime: readonlyRuntime,
    profiles: [{ id: "p1", name: "已保存服务", baseUrl: "http://127.0.0.1:9/v1", model: "math-model", streaming: true, hasKey: true, keyStatus: "ok", capabilities: {} }],
  });
  await flush();
  for (const control of harness.host.querySelectorAll("button, input, select")) {
    if (control.dataset.config === "1") assert.equal(control.disabled, true, `${control.tagName} ${control.name || control.dataset.action || ""} 远程只读应禁用`);
  }
  assert.equal(harness.host.querySelector('[data-action="add-reasoning-preset"]').disabled, true, "新增档位按钮在远程只读禁用");
  assert.equal(harness.field("defaultReasoningPresetId").disabled, true, "默认档位 select 在远程只读禁用");
  const use = harness.host.querySelector("[data-use]");
  assert.equal(use.disabled, false, "选择服务按钮必须保留");
  assert.match(harness.host.querySelector("[data-storage]").textContent, /DPAPI/);
  assert.match(harness.host.querySelector("[data-storage]").textContent, /远程只读/);
  harness.click('[data-action="new"]');
  assert.equal(harness.form().hidden, true, "远程只读不得打开编辑表单");
  assert.match(harness.status(), /只读/);
  harness.click('[data-action="add-reasoning-preset"]');
  assert.equal(harness.rows().length, 0, "远程只读不得新增档位行");
  harness.click("[data-delete]");
  assert.match(harness.status(), /只读/);
  assert.ok(!harness.calls.some((call) => ["POST", "PATCH", "DELETE"].includes(call.method)), "远程只读不得发起配置写请求");
  assert.ok(harness.calls.some((call) => call.url === "./api/runtime" && call.method === "GET"));
  assert.ok(harness.calls.some((call) => call.url === "./api/ai/profiles" && call.method === "GET"));
});

test("busy 时档位 textarea/select 也进入禁用集合（syncBusy 不再只覆盖 button/input）", async () => {
  const harness = createHarness({ runtime: writableRuntime, profiles: [], savedProfile });
  await flush();
  harness.click('[data-action="new"]');
  harness.click('[data-action="add-reasoning-preset"]');
  assert.equal(harness.rows().length, 1);
  harness.hooks.busy = () => true;
  harness.host.aiSettings.syncBusy();
  assert.equal(harness.rows()[0].querySelector("[data-preset-params]").disabled, true, "档位 textarea 纳入 syncBusy");
  assert.equal(harness.rows()[0].querySelector("[data-preset-name]").disabled, true, "档位名称 input 纳入 syncBusy");
  assert.equal(harness.field("defaultReasoningPresetId").disabled, true, "默认档位 select 纳入 syncBusy");
});

test("本机会话可打开表单、提交 clearKey 并提示基地址更改后重新提供 Key", async () => {
  const harness = createHarness({ runtime: writableRuntime, profiles: [], savedProfile });
  await flush();
  harness.click('[data-action="new"]');
  assert.equal(harness.form().hidden, false);
  assert.equal(harness.host.querySelector("[data-title]").textContent, "新增服务");
  harness.field("name").value = "我的服务";
  harness.field("baseUrl").value = "http://127.0.0.1:9/v1";
  harness.field("key").value = "sk-fake-ui-key";
  harness.submit();
  await flush();
  const created = harness.calls.find((call) => call.url === "./api/ai/profiles" && call.method === "POST");
  assert.ok(created, "保存应 POST /api/ai/profiles");
  assert.equal(created.body.key, "sk-fake-ui-key");
  assert.equal(created.body.clearKey, false);
  assert.deepEqual(created.body.reasoningPresets, [], "未配置档位时提交空数组");
  assert.equal(created.body.defaultReasoningPresetId, "", "未选默认档位时提交空串");
  assert.match(harness.status(), /服务已保存/);

  const editing = createHarness({
    runtime: { writable: true, backend: "dpapi", encrypted: true, persistent: true, available: true },
    profiles: [{ id: "p1", name: "已保存服务", baseUrl: "http://127.0.0.1:9/v1", model: "math-model", streaming: true, hasKey: true, keyStatus: "ok", capabilities: {} }],
    savedProfile,
  });
  await flush();
  editing.click("[data-edit]");
  assert.equal(editing.form().hidden, false);
  assert.match(editing.host.querySelector("[data-key-status]").textContent, /已保存；留空沿用/);
  assert.equal(editing.host.querySelector("[data-clear-key]").hidden, false);
  editing.field("baseUrl").value = "http://127.0.0.1:10/v1";
  editing.input();
  assert.match(editing.host.querySelector("[data-key-status]").textContent, /基地址已更改：请重新填写 API Key/);
  editing.field("clearKey").checked = true;
  editing.submit();
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
  await flush();
  assert.match(harness.host.querySelector("[data-list]").innerHTML, /需重新填写/);
  harness.click("[data-edit]");
  assert.match(harness.host.querySelector("[data-key-status]").textContent, /解密失败/);
  assert.equal(harness.host.querySelector("[data-clear-key]").hidden, true);
});

test("保存后回显旧 Key 已清除且需重新填写", async () => {
  const cleared = { ...savedProfile, keyCleared: true, warning: "接口地址已变更，旧 Key 已丢弃", hasKey: false, keyStatus: "none" };
  const harness = createHarness({
    runtime: { writable: true, backend: "dpapi", encrypted: true, persistent: true, available: true },
    profiles: [{ id: "p1", name: "已保存服务", baseUrl: "http://127.0.0.1:9/v1", model: "math-model", streaming: true, hasKey: true, keyStatus: "ok", capabilities: {} }],
    savedProfile: cleared,
  });
  await flush();
  harness.click("[data-edit]");
  harness.field("baseUrl").value = "http://127.0.0.1:11/v1";
  harness.submit();
  await flush();
  const status = harness.status();
  assert.match(status, /旧 Key 已清除/);
  assert.match(status, /请重新填写 API Key/);
  assert.match(status, /接口地址已变更/);
});

test("只有 warning 未清除 Key 时不得谎称 Key 已清除", async () => {
  const harness = createHarness({
    runtime: { writable: true, backend: "dpapi", encrypted: true, persistent: true, available: true },
    profiles: [],
    savedProfile: { ...savedProfile, keyCleared: false, warning: "旧版加密已无法解密，密文已保留", hasKey: true, keyStatus: "unreadable" },
  });
  await flush();
  harness.click('[data-action="new"]');
  harness.submit();
  await flush();
  const status = harness.status();
  assert.doesNotMatch(status, /旧 Key 已清除/);
  assert.doesNotMatch(status, /请重新填写 API Key/);
  assert.match(status, /服务已保存/);
  assert.match(status, /旧版加密已无法解密，密文已保留/);
});

test("流式开关遵循只读标志", async () => {
  const readOnly = createHarness({ runtime: readonlyRuntime, profiles: [] });
  const input = { checked: true, disabled: false, dataset: {}, addEventListener: (type, fn) => { readOnly.listeners = readOnly.listeners || {}; readOnly.listeners[type] = fn; } };
  const errors = [];
  readOnly.api.bindStreaming(input, { profile: () => ({ id: "p1", streaming: true }), busy: () => false, allowed: () => true, error: (message) => errors.push(message), changed() {} });
  await flush();
  assert.equal(input.disabled, true, "远程只读应禁用流式开关");
  readOnly.listeners.change();
  assert.equal(input.checked, true, "远程只读不得改动流式设置");
  assert.match(errors[0], /只读/);

  const writable = createHarness({ runtime: writableRuntime, profiles: [], savedProfile });
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
  assert.equal(Object.prototype.hasOwnProperty.call(patch.body, "reasoningPresets"), false, "流式开关的 PATCH 不得携带档位字段（避免删档位）");
});

test("自定义档位：新增/编辑/删除、默认档位提交、保存后回显（含嵌套参数）", async () => {
  const profile = {
    id: "p1", name: "我的服务", baseUrl: "http://127.0.0.1:9/v1", model: "math-model", streaming: true, hasKey: true, keyStatus: "ok", capabilities: {},
    reasoningPresets: [{ id: "reason-low", name: "省思考", params: { reasoning_effort: "low" } }],
    defaultReasoningPresetId: "reason-low",
  };
  const saved = { ...profile, reasoningPresets: [
    { id: "reason-low", name: "省思考", params: { reasoning_effort: "low" } },
    { id: "uuid-1", name: "深思", params: { thinking: { type: "enabled", budget_tokens: 4096 } } },
  ], defaultReasoningPresetId: "uuid-1" };
  const harness = createHarness({ runtime: writableRuntime, profiles: [profile], savedProfile: saved });
  await flush();
  harness.click("[data-edit]");

  // 已有档位与默认档位正确回显
  assert.equal(harness.rows().length, 1);
  assert.equal(harness.rows()[0].querySelector("[data-preset-name]").value, "省思考");
  assert.equal(harness.rows()[0].querySelector("[data-preset-params]").value, JSON.stringify({ reasoning_effort: "low" }, null, 2));
  assert.equal(harness.field("defaultReasoningPresetId").value, "reason-low");

  // 新增一档：名称 + 嵌套参数 JSON
  harness.click('[data-action="add-reasoning-preset"]');
  assert.equal(harness.rows().length, 2);
  const row = harness.rows()[1];
  row.querySelector("[data-preset-name]").value = "深思";
  row.querySelector("[data-preset-params]").value = '{"thinking":{"type":"enabled","budget_tokens":4096}}';
  harness.field("defaultReasoningPresetId").value = row.dataset.presetId;
  harness.submit();
  await flush();

  const patched = harness.calls.find((call) => call.url === "./api/ai/profiles/p1" && call.method === "PATCH");
  assert.ok(patched);
  assert.deepEqual(patched.body.reasoningPresets, [
    { id: "reason-low", name: "省思考", params: { reasoning_effort: "low" } },
    { id: "uuid-1", name: "深思", params: { thinking: { type: "enabled", budget_tokens: 4096 } } },
  ], "档位参数作为 JSON 对象发送，保留嵌套结构");
  assert.equal(patched.body.defaultReasoningPresetId, "uuid-1");
  assert.equal(Object.prototype.hasOwnProperty.call(patched.body, "model"), true);

  // 保存后按服务端回显档位（名称/默认档位）
  assert.equal(harness.rows().length, 2);
  assert.equal(harness.rows()[1].querySelector("[data-preset-name]").value, "深思");
  assert.equal(harness.field("defaultReasoningPresetId").value, "uuid-1");

  // 删除默认档位：默认选择回落到「模型默认（空）」
  harness.rows()[1].querySelector("[data-remove-preset]").dispatchEvent(createFakeEvent("click"));
  assert.equal(harness.rows().length, 1);
  assert.equal(harness.field("defaultReasoningPresetId").value, "", "删除当前默认档位后默认回落为空（模型默认）");
});

test("自定义档位：非法 JSON 明确提示且不 POST；名称为空也不 POST", async () => {
  const harness = createHarness({ runtime: writableRuntime, profiles: [], savedProfile });
  await flush();
  harness.click('[data-action="new"]');
  harness.field("name").value = "服务";
  harness.field("baseUrl").value = "http://127.0.0.1:9/v1";
  harness.click('[data-action="add-reasoning-preset"]');
  harness.rows()[0].querySelector("[data-preset-name]").value = "坏档位";
  harness.rows()[0].querySelector("[data-preset-params]").value = '{"reasoning_effort": }';
  harness.submit();
  await flush();
  assert.match(harness.status(), /不是合法 JSON/);
  assert.ok(!harness.calls.some((call) => call.method === "POST"), "非法 JSON 不得发出保存请求");

  // 参数必须是对象：数组/标量同样被拦下
  harness.rows()[0].querySelector("[data-preset-params]").value = '["high"]';
  harness.submit();
  await flush();
  assert.match(harness.status(), /必须是 JSON 对象/);
  assert.ok(!harness.calls.some((call) => call.method === "POST"));

  // 名称不能为空
  harness.rows()[0].querySelector("[data-preset-name]").value = "   ";
  harness.rows()[0].querySelector("[data-preset-params]").value = '{"reasoning_effort":"high"}';
  harness.submit();
  await flush();
  assert.match(harness.status(), /名称不能为空/);
  assert.ok(!harness.calls.some((call) => call.method === "POST"));

  // 修正后可以正常保存
  harness.rows()[0].querySelector("[data-preset-name]").value = "高推理";
  harness.submit();
  await flush();
  const created = harness.calls.find((call) => call.method === "POST");
  assert.ok(created);
  assert.deepEqual(created.body.reasoningPresets, [{ id: "uuid-1", name: "高推理", params: { reasoning_effort: "high" } }]);
});

test("自定义档位：dirty 指纹覆盖档位字段，未保存时拦截获取模型；最多 12 个", async () => {
  const profile = {
    id: "p1", name: "我的服务", baseUrl: "http://127.0.0.1:9/v1", model: "math-model", streaming: true, hasKey: true, keyStatus: "ok", capabilities: {},
    reasoningPresets: [{ id: "r1", name: "省思考", params: { reasoning_effort: "low" } }], defaultReasoningPresetId: "r1",
  };
  const harness = createHarness({ runtime: writableRuntime, profiles: [profile], savedProfile: profile });
  await flush();
  harness.click("[data-edit]");

  // 仅改档位参数：fingerprint 必须感知为 dirty，从而拦截「获取模型列表」
  harness.rows()[0].querySelector("[data-preset-params]").value = '{"reasoning_effort":"high"}';
  harness.click('[data-action="models"]');
  await flush();
  assert.match(harness.status(), /请先保存当前配置/);
  assert.ok(!harness.calls.some((call) => call.url.endsWith("/models")), "dirty 时不得获取模型列表");

  // 最多 12 个：加满后新增按钮禁用
  for (let i = harness.rows().length; i < 12; i += 1) harness.click('[data-action="add-reasoning-preset"]');
  assert.equal(harness.rows().length, 12);
  assert.equal(harness.host.querySelector('[data-action="add-reasoning-preset"]').disabled, true, "达到 12 个上限时新增按钮禁用");
  harness.click('[data-action="add-reasoning-preset"]');
  assert.equal(harness.rows().length, 12);
  assert.match(harness.status(), /最多只能设置 12 个推理档位/);
});

test("页面与 Service Worker 引用同步到新版本", () => {
  const indexHtml = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const legacyHtml = fs.readFileSync(new URL("../web/legacy.html", import.meta.url), "utf8");
  const sw = fs.readFileSync(new URL("../web/service-worker.js", import.meta.url), "utf8");
  for (const html of [indexHtml, legacyHtml]) {
    assert.ok(html.includes("./ai-settings.js?v=3"));
    assert.ok(html.includes("./ai-services.css?v=3"));
  }
  assert.ok(sw.includes('"./ai-settings.js?v=3"'));
  assert.ok(sw.includes('"./ai-services.css?v=3"'));
  assert.ok(sw.includes('"./new-ai.js?v=4"'));
  assert.ok(sw.includes('"./new-state.js?v=4"'));
  assert.match(sw, /daguan-shell-v172/);
  assert.ok(indexHtml.includes("./app-new.js?v=160"));
  assert.ok(legacyHtml.includes("./app-legacy.js?v=124"));
  assert.ok(sw.includes('"./app-new.js?v=160"'));
  assert.ok(sw.includes('"./app-legacy.js?v=124"'));
  // app-new 与 app-legacy 都跟随新缓存版本。
  assert.ok(fs.readFileSync(new URL("../web/app-new.js", import.meta.url), "utf8").includes("service-worker.js?v=172"));
  assert.ok(fs.readFileSync(new URL("../web/app-legacy.js", import.meta.url), "utf8").includes("service-worker.js?v=172"));
});

test("双界面 AI 入口接线完整（防止抽屉/清空/档位/会话函数被误删）", () => {
  const legacyApp = fs.readFileSync(new URL("../web/app-legacy.js", import.meta.url), "utf8");
  const newAi = fs.readFileSync(new URL("../web/new-ai.js", import.meta.url), "utf8");
  const newApp = fs.readFileSync(new URL("../web/app-new.js", import.meta.url), "utf8");
  // 旧版抽屉打开函数必须存在，且被两个入口引用（本轮曾因编辑误删导致旧版 chat 全挂）。
  assert.match(legacyApp, /function openAiDrawer\(/);
  assert.match(legacyApp, /function openAiForQuestion\(q\) \{ openAiDrawer\(/);
  assert.match(legacyApp, /function openNoteForQuestion\(q\) \{ openAiDrawer\(/);
  // 两界面清空按钮与实现。
  assert.match(legacyApp, /function clearAiChat\(/);
  assert.match(legacyApp, /#ai-clear-btn/);
  assert.match(newAi, /static async clearAIChat\(/);
  assert.match(newApp, /static clearAIChat\(/);
  // 新版档位与会话适配层。
  assert.match(newAi, /static syncReasoningPresets\(/);
  assert.match(newAi, /static historyFor\(/);
  assert.match(newAi, /id="ai-reasoning-preset-new"/);
  assert.match(legacyApp, /#ai-reasoning-preset/);
  // 旧草稿键清理失败必须显式上报（不能静默 catch {} 吞异常）。
  assert.match(legacyApp, /function cleanLegacyAiDraftKey\(/);
  assert.match(legacyApp, /console\.warn\(`清理旧 AI 草稿缓存失败/);
});
