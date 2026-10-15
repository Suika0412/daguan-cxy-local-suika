import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 新版 AI 图片附件定向单元测试：在受控沙箱里加载真实的 web/new-ai.js，
// 用最小 DOM/FileReader 桩驱动附件状态机与发送契约。
// 真实浏览器交互（真实 FileReader、真实剪贴板/拖放、真实请求透传）不在本文件范围内。
const SOURCE = fs.readFileSync(new URL('../web/new-ai.js', import.meta.url), 'utf8');
const PNG_URL = 'data:image/png;base64,aGVsbG8=';
const AUTO_URL = 'data:image/png;base64,YXV0bw==';

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.parentNode = null;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = new Map();
    this.classes = new Set();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.markup = '';
  }

  get classList() {
    const classes = this.classes;
    return {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => {
        const next = force === undefined ? !classes.has(name) : force;
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
    };
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    this.attributes.class = String(value);
  }

  get className() { return [...this.classes].join(' '); }

  // 只识别标签/class/id 声明，用于让 getElementById / querySelector 找到模板里声明的节点。
  set innerHTML(markup) {
    this.markup = String(markup);
    this.children = [];
    for (const match of this.markup.matchAll(/<(\w+)([^>]*)>/g)) {
      const node = new FakeElement(match[1], this.ownerDocument);
      const id = /id="([^"]+)"/.exec(match[2]);
      const cls = /class="([^"]+)"/.exec(match[2]);
      if (id) node.setAttribute('id', id[1]);
      if (cls) node.className = cls[1];
      node.parentNode = this;
      this.children.push(node);
    }
  }

  get innerHTML() { return this.markup; }

  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  replaceChildren(...nodes) { this.children = []; nodes.forEach(node => this.appendChild(node)); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
    this.isConnected = false;
    for (const [id, node] of this.ownerDocument.byId) if (node === this) this.ownerDocument.byId.delete(id);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.ownerDocument.byId.set(String(value), this);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'id') for (const [id, node] of this.ownerDocument.byId) if (node === this) this.ownerDocument.byId.delete(id);
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  matches(selector) {
    if (selector.startsWith('#')) return this.attributes.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
}

function createFakeEvent(type, patch = {}) {
  return Object.assign({
    type,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  }, patch);
}

function fakeFile({ name, type, size, fail = false }) {
  return { name, type, size: size ?? 8, fail, url: PNG_URL };
}

// 可控制时序的 FileReader 桩：结果由 flush() 手动放行，用于验证“读取未完成不允许发送”。
function createFileReaderStub() {
  const pending = [];
  class StubFileReader {
    readAsDataURL(file) { pending.push({ reader: this, file }); }
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return {
    FileReader: StubFileReader,
    pending,
    async flush() {
      for (let guard = 0; guard < 64; guard += 1) {
        if (!pending.length) {
          await settle();
          if (!pending.length) return;
        }
        const { reader, file } = pending.shift();
        if (file.fail) reader.onerror?.(new Error('读取失败'));
        else { reader.result = file.url; reader.onload?.(); }
        await settle();
      }
      throw new Error('FileReader 桩未收敛');
    },
  };
}

function createContext() {
  const byId = new Map();
  const document = {
    byId,
    createElement(tag) { return new FakeElement(tag, document); },
    createTextNode(text) { const node = new FakeElement('#text', document); node.textContent = String(text); return node; },
    getElementById(id) { return byId.get(id) || null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: null,
  };
  document.body = new FakeElement('body', document);
  const toasts = [];
  const drafts = new Map();
  const files = createFileReaderStub();
  const sandbox = {
    document,
    location: { href: 'http://127.0.0.1/index.html' },
    TextEncoder,
    TextDecoder,
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    FileReader: files.FileReader,
    fetch: () => Promise.reject(new Error('tests do not fetch by default')),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const AppState = { questions: [], currentQuestionIndex: 0, aiBusy: false, ui: { aiPanelOpen: true }, answers: {} };
  sandbox.AppState = AppState;
  const StorageService = {
    getAIPreferences: () => ({}),
    saveAIPreference() {},
    getAIDraft: id => drafts.get(String(id)) || '',
    saveAIDraft: (id, value) => drafts.set(String(id), value),
    getProgress: () => ({ progress: {} }),
    getAnnotation: () => ({ content: '' }),
    isFavorite: () => false,
  };
  // 与真实 web/app-new.js 的 App facade 等价：只做 apply(this) 转发，本身没有附件相关方法。
  // 直接调 AIController.method() 时 this 是 AIController，会掩盖 this.xxx 缺陷，故统一经由 facade 调用。
  const app = {};
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'new-ai.js' });
  const api = sandbox.DaguanNewAI.create({
    window: sandbox, document, fetch: (...args) => sandbox.fetch(...args), location: sandbox.location,
    AppState, StorageService, assetUrl: value => value,
    escapeHtml: value => String(value ?? ''), renderMarkdown: value => String(value ?? ''),
    toast: message => toasts.push(String(message)),
    getAccess: () => ({ privateAllowed: () => true }),
    getRenderer: () => ({}),
    getApp: () => app,
  });
  // facade 只暴露原实现里确实存在的 App 方法；附件内部方法一概没有。
  for (const name of ['sendAIMessage', 'retryAIMessage', 'aiBusyUi', 'abortAIStream', 'clearAIChat']) {
    app[name] = (...args) => api.AIController[name].apply(app, args);
  }
  // navigate 是 App 自身的方法（facade 不转发），按真实情况提供。
  app.navigate = () => {};
  // 面板：只搭本测试真正用到的节点，节点 id 与渲染模板一致。
  const panel = document.createElement('div');
  panel.setAttribute('id', 'ai-panel');
  panel.dataset.questionId = '331';
  const messages = document.createElement('div');
  messages.setAttribute('id', 'ai-messages');
  const messagesScroll = { value: 0, ...{} };
  messages.scrollTop = messagesScroll.value;
  messages.scrollHeight = 0;
  const previews = document.createElement('div');
  previews.setAttribute('id', 'ai-attachment-previews');
  previews.hidden = true;
  const input = document.createElement('textarea');
  input.setAttribute('id', 'ai-input');
  const inputArea = document.createElement('div');
  inputArea.className = 'ai-input-area';
  const attachButton = document.createElement('button');
  attachButton.setAttribute('id', 'ai-attach-btn');
  const fileInput = document.createElement('input');
  fileInput.setAttribute('id', 'ai-attach-input');
  fileInput.files = [];
  const sendButton = document.createElement('button');
  sendButton.setAttribute('id', 'ai-send-btn');
  // 真实新面板里的思考档位选择框：默认空值 = 模型默认，契约要求始终发送该字段（不省略）。
  const reasoningSelect = document.createElement('select');
  reasoningSelect.setAttribute('id', 'ai-reasoning-preset-new');
  reasoningSelect.value = '';
  inputArea.append(previews, input, attachButton, fileInput, sendButton);
  panel.append(inputArea, messages, reasoningSelect);
  document.body.appendChild(panel);
  return { api, sandbox, document, AppState, StorageService, app, panel, previews, input, fileInput, sendButton, reasoningSelect, messages, toasts, drafts, files };
}

function question(id = 331) { return { id, stem: '题干', options: [], answer: 'A', explanation: '' }; }

function cards(previews) {
  return previews.children.filter(child => child.classes.has('ai-attachment') && !child.classes.has('ai-attachment-reading'));
}

function readingCards(previews) {
  return previews.children.filter(child => child.classes.has('ai-attachment-reading'));
}

async function addFiles(context, files) {
  const adding = context.api.AIAttachments.addFiles(files);
  await context.files.flush();
  await adding;
}

// 模拟 renderAIPanel 重建输入区：换上一个全新的 textarea 节点，旧节点成为 detached。
function replaceInput(context) {
  const stale = context.input;
  const fresh = context.document.createElement('textarea');
  fresh.setAttribute('id', 'ai-input');
  stale.parentNode.appendChild(fresh);
  stale.remove();
  context.input = fresh;
  return { stale, fresh };
}

// 把 AIService 的发送与题图取用替换为本地 mock，记录每次请求载荷。
function mockChat(context, { images = [], fail = false } = {}) {
  const asked = [];
  const autoLimits = [];
  context.api.AIService.chatStream = async payload => {
    asked.push(payload);
    if (fail) throw new Error('模拟上游失败');
    return { headers: { get: () => 'run-1' }, body: null };
  };
  context.api.AIService.questionImages = async (item, limit = 4) => {
    autoLimits.push(limit);
    return images.slice(0, limit);
  };
  return { asked, autoLimits };
}

function useProfile(context, vision) {
  context.AppState.aiProfiles = [{ id: 'p1', name: '附件测试', capabilities: { text: true, vision } }];
  context.AppState.aiProfileId = 'p1';
  context.AppState.questions = [question()];
  context.AppState.currentQuestionIndex = 0;
  context.api.AIService.loadProfiles = async () => context.AppState.aiProfiles;
}

test('附件状态：合法图片进入预览、逐张移除，格式/单图大小/数量超限明确报错', async () => {
  const context = createContext();
  context.api.AIAttachments.bindPanel(context.panel, question());
  assert.equal(context.previews.hidden, true);

  await addFiles(context, [fakeFile({ name: '图一.png', type: 'image/png' }), fakeFile({ name: '图二.jpg', type: 'image/jpeg' })]);
  assert.equal(cards(context.previews).length, 2);
  assert.equal(context.previews.hidden, false);
  assert.match(context.api.AIAttachments.dataUrls()[0], /^data:image\/png;base64,/);
  assert.equal(context.api.AIAttachments.items[0].name, '图一.png');

  // 逐张移除
  cards(context.previews)[0].querySelector('.ai-attachment-remove').dispatchEvent(createFakeEvent('click'));
  assert.equal(cards(context.previews).length, 1);
  assert.equal(context.api.AIAttachments.items.length, 1);

  // 不支持的格式与超过 2MiB 的单张原文件：整批拒绝，原有附件不动
  await addFiles(context, [fakeFile({ name: '文档.txt', type: 'text/plain' })]);
  assert.equal(cards(context.previews).length, 1);
  assert.ok(context.toasts.includes('不支持的图片格式：文档.txt'));
  await addFiles(context, [fakeFile({ name: '超大.png', type: 'image/png', size: 2 * 1024 * 1024 + 1 })]);
  assert.equal(cards(context.previews).length, 1);
  assert.ok(context.toasts.includes('图片超过 2MiB：超大.png'));

  // 最多 4 张：整批放不下就拒绝整批，不截断用户选择
  await addFiles(context, [fakeFile({ name: 'a.png', type: 'image/png' }), fakeFile({ name: 'b.png', type: 'image/png' }), fakeFile({ name: 'c.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.items.length, 4);
  await addFiles(context, [fakeFile({ name: 'e.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.items.length, 4);
  assert.ok(context.toasts.some(message => message.includes('最多只能添加 4 张图片')));
});

test('附件状态：文件名只做文本赋值，不写入 innerHTML', async () => {
  const context = createContext();
  context.api.AIAttachments.bindPanel(context.panel, question());
  const malicious = '<img src=x onerror="window.__pwn=1">.png';
  await addFiles(context, [fakeFile({ name: malicious, type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.items.length, 1);
  const name = cards(context.previews)[0].querySelector('.ai-attachment-name');
  assert.equal(name.textContent, malicious, '文件名必须作为文本节点保留原样');
  // 预览区里只应有缩略图这一张 img，恶意文件名不能变成元素
  assert.equal(context.previews.querySelectorAll('img').length, 1);
  assert.equal(cards(context.previews)[0].querySelectorAll('img').length, 1);
  assert.equal(context.app.__pwn, undefined);
});

test('附件状态：读取中不允许发送、读取失败明确提示、异步结果不串题', async () => {
  const context = createContext();
  context.api.AIAttachments.bindPanel(context.panel, question());
  const adding = context.api.AIAttachments.addFiles([fakeFile({ name: '慢图.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.reading, 1);
  assert.equal(readingCards(context.previews).length, 1);
  assert.equal(context.sendButton.disabled, true, '读取中必须禁用发送');
  await context.files.flush();
  await adding;
  assert.equal(context.api.AIAttachments.reading, 0);
  assert.equal(readingCards(context.previews).length, 0);
  assert.equal(context.sendButton.disabled, false);

  // 读取失败：明确提示且不进入附件区（此前成功的附件保持不动）
  await addFiles(context, [fakeFile({ name: '坏图.png', type: 'image/png', fail: true })]);
  assert.equal(context.api.AIAttachments.items.length, 1);
  assert.ok(context.toasts.includes('图片读取失败：坏图.png（无法读取文件）'));

  // 切题后到达的异步结果不得写进当前题，且不得改动新题的占位数
  const pending = context.api.AIAttachments.addFiles([fakeFile({ name: '迟到.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.reading, 1);
  context.api.AIAttachments.forQuestion('999');
  assert.equal(context.api.AIAttachments.reading, 0, '换题必须清空占位');
  await context.files.flush();
  await pending;
  assert.equal(context.api.AIAttachments.items.length, 0, '切题后不得恢复上一题的附件');
  assert.equal(context.api.AIAttachments.questionId, '999');
  assert.equal(context.api.AIAttachments.reading, 0, '过期批次不得把新题 reading 减成负数');
});

test('附件并发：两批同时读取时按整批占位，最多 4 张且占位不为负', async () => {
  const context = createContext();
  context.api.AIAttachments.bindPanel(context.panel, question());

  // 两批各 3 张同时发起：第二批必须因剩余名额不足被整批拒绝
  const first = context.api.AIAttachments.addFiles([
    fakeFile({ name: '1.png', type: 'image/png' }),
    fakeFile({ name: '2.png', type: 'image/png' }),
    fakeFile({ name: '3.png', type: 'image/png' }),
  ]);
  assert.equal(context.api.AIAttachments.reading, 3, '整批占位，而不是只占当前一张');
  const second = context.api.AIAttachments.addFiles([
    fakeFile({ name: '4.png', type: 'image/png' }),
    fakeFile({ name: '5.png', type: 'image/png' }),
    fakeFile({ name: '6.png', type: 'image/png' }),
  ]);
  assert.ok(context.toasts.some(message => message.includes('剩余名额只有 1 张')), '超额批次必须明确拒绝并说明剩余名额');
  assert.equal(context.api.AIAttachments.reading, 3);
  await context.files.flush();
  await Promise.all([first, second]);
  assert.equal(context.api.AIAttachments.items.length, 3, '被拒批次一张都不能进入');
  assert.equal(context.api.AIAttachments.reading, 0, '占位数不得为负');
  assert.equal(cards(context.previews).length, 3);

  // 补到 4 张后，任何新批次都被整体拒绝
  await addFiles(context, [fakeFile({ name: '7.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.items.length, 4);
  await addFiles(context, [fakeFile({ name: '8.png', type: 'image/png' }), fakeFile({ name: '9.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.items.length, 4);
  assert.equal(context.api.AIAttachments.reading, 0);
  assert.ok(context.toasts.some(message => message.includes('最多只能添加 4 张图片')));
});

test('附件并发：面板重渲染与 reset 都作废旧批次，不让旧读取污染新面板', async () => {
  const context = createContext();
  context.api.AIAttachments.bindPanel(context.panel, question());

  // 面板重渲染（新面板节点）时，旧批次结果不得写入，也不得改占位
  const stale = context.api.AIAttachments.addFiles([fakeFile({ name: '旧面板.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.reading, 1);
  const replacement = context.document.createElement('div');
  replacement.setAttribute('id', 'ai-panel-2');
  context.api.AIAttachments.bindPanel(replacement, question());
  assert.equal(context.api.AIAttachments.reading, 0, '重绑定必须作废占位');
  await context.files.flush();
  await stale;
  assert.equal(context.api.AIAttachments.items.length, 0, '旧面板批次结果必须丢弃');
  assert.equal(context.api.AIAttachments.reading, 0);

  // reset 之后到达的结果同样丢弃，且不产生负数
  const afterReset = context.api.AIAttachments.addFiles([fakeFile({ name: '重置.png', type: 'image/png' })]);
  context.api.AIAttachments.reset();
  await context.files.flush();
  await afterReset;
  assert.equal(context.api.AIAttachments.reading, 0, 'reset 后过期批次不得改占位');
  assert.equal(context.api.AIAttachments.items.length, 0);
});

test('附件并发：切回同一题时，来自上一轮的过期读取不得被写入', async () => {
  const context = createContext();
  context.api.AIAttachments.bindPanel(context.panel, question());

  // 题 331 的读取在途，切到 999 再切回 331：generation 已变，旧结果必须丢弃
  const inFlight = context.api.AIAttachments.addFiles([fakeFile({ name: '来回切换.png', type: 'image/png' })]);
  context.api.AIAttachments.forQuestion('999');
  context.api.AIAttachments.forQuestion('331');
  assert.equal(context.api.AIAttachments.questionId, '331');
  await context.files.flush();
  await inFlight;
  assert.equal(context.api.AIAttachments.items.length, 0, '切回同一题也不得恢复过期批次的结果');
  assert.equal(context.api.AIAttachments.reading, 0);

  // 新批次在新 generation 下正常工作
  await addFiles(context, [fakeFile({ name: '新一轮.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.items.length, 1);
});

test('附件入口：粘贴不支持图片格式时明确提示，普通文本粘贴仍不拦截', async () => {
  const context = createContext();
  context.api.AIAttachments.bindPanel(context.panel, question());

  // 剪贴板里是 SVG（不支持的图片格式）：明确提示且不进入附件
  const svgPaste = createFakeEvent('paste', { clipboardData: { items: [{ kind: 'file', type: 'image/svg+xml', getAsFile: () => fakeFile({ name: '图形.svg', type: 'image/svg+xml' }) }] } });
  context.input.dispatchEvent(svgPaste);
  assert.equal(svgPaste.defaultPrevented, true, '含文件的粘贴不应把内容交回默认行为');
  assert.ok(context.toasts.some(message => message.includes('不支持的图片格式：image/svg+xml')));
  assert.equal(context.api.AIAttachments.items.length, 0);

  // 混合：合法图片进入，非法图片只提示一次且不影响合法项
  const mixed = createFakeEvent('paste', {
    clipboardData: {
      items: [
        { kind: 'file', type: 'image/png', getAsFile: () => fakeFile({ name: '可用.png', type: 'image/png' }) },
        { kind: 'file', type: 'image/tiff', getAsFile: () => fakeFile({ name: '不可用.tiff', type: 'image/tiff' }) },
      ],
    },
  });
  context.input.dispatchEvent(mixed);
  await context.files.flush();
  assert.equal(context.api.AIAttachments.items.length, 1);
  assert.equal(context.api.AIAttachments.items[0].name, '可用.png');

  // 普通文本粘贴不拦截
  const textPaste = createFakeEvent('paste', { clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] } });
  context.input.dispatchEvent(textPaste);
  assert.equal(textPaste.defaultPrevented, false, '普通文本粘贴必须保持原行为');
  assert.equal(context.api.AIAttachments.items.length, 1);
});

test('附件入口：粘贴截图与拖放进入附件，纯文本粘贴不拦截', async () => {
  const context = createContext();
  context.api.AIAttachments.bindPanel(context.panel, question());
  const imageItem = { kind: 'file', type: 'image/png', getAsFile: () => fakeFile({ name: '截图.png', type: 'image/png' }) };
  const paste = createFakeEvent('paste', { clipboardData: { items: [imageItem] } });
  context.input.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, true, '图片粘贴应被截获');
  await context.files.flush();
  assert.equal(context.api.AIAttachments.items.length, 1);

  const drop = createFakeEvent('drop', { dataTransfer: { files: [fakeFile({ name: '拖放.png', type: 'image/png' })], types: ['Files'] } });
  context.panel.querySelector('.ai-input-area').dispatchEvent(drop);
  await context.files.flush();
  assert.equal(context.api.AIAttachments.items.length, 2);

  const textPaste = createFakeEvent('paste', { clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] } });
  context.input.dispatchEvent(textPaste);
  assert.equal(textPaste.defaultPrevented, false, '纯文本粘贴必须保持原行为');
  assert.equal(context.api.AIAttachments.items.length, 2);
});

test('发送契约：用户图优先、题图只补剩余名额，成功后清空且图片不落草稿', async () => {
  const context = createContext();
  const { asked, autoLimits } = mockChat(context, { images: [AUTO_URL] });
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());
  await addFiles(context, [fakeFile({ name: 'a.png', type: 'image/png' }), fakeFile({ name: 'b.png', type: 'image/png' })]);
  context.input.value = '看看这两张图';

  await context.app.sendAIMessage();
  assert.deepEqual(autoLimits, [2], '用户占用 2 张后题图只补剩余 2 个名额');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].prompt, '看看这两张图');
  assert.equal(asked[0].question.id, 331);
  assert.equal(asked[0].images.length, 3);
  assert.deepEqual([...asked[0].images.slice(0, 2)], [PNG_URL, PNG_URL]);
  assert.deepEqual([...asked[0].images.slice(2)], [AUTO_URL]);
  assert.equal(context.input.value, '');
  assert.equal(context.api.AIAttachments.items.length, 0);
  assert.equal(context.drafts.get('331'), '');
  assert.equal([...context.drafts.values()].join('').includes('data:image'), false);
  // 用户消息显示自己的图片，文件名不进 innerHTML
  const userBubble = context.messages.children[0].children[0];
  assert.equal(userBubble.querySelectorAll('img').length, 2);
  assert.doesNotMatch(userBubble.innerHTML, /a\.png/);
});

test('发送契约：纯图发送使用默认提示词，读取中与 AI 忙时不发送', async () => {
  const context = createContext();
  const { asked } = mockChat(context, { images: [] });
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());

  // 读取中不允许发送
  const adding = context.api.AIAttachments.addFiles([fakeFile({ name: '只图.png', type: 'image/png' })]);
  await context.app.sendAIMessage();
  assert.equal(asked.length, 0);
  assert.ok(context.toasts.some(message => message.includes('图片还在读取中')));
  await context.files.flush();
  await adding;

  context.input.value = '';
  await context.app.sendAIMessage();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].prompt, '请结合图片回答我的问题。');
  assert.equal(asked[0].images.length, 1);

  // AI 忙：不允许发送，也不允许更改附件
  context.AppState.aiBusy = true;
  await context.app.sendAIMessage();
  assert.equal(asked.length, 1);
  await addFiles(context, [fakeFile({ name: '忙时.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.items.length, 0);
  assert.ok(context.toasts.some(message => message.includes('AI 正在生成，暂时不能更改附件')));
});

test('发送契约：vision 未通过或整包超 10MiB 时明确失败并保留输入与附件', async () => {
  const context = createContext();
  const { asked } = mockChat(context, { images: [] });
  context.api.AIAttachments.bindPanel(context.panel, question());

  // vision 未通过
  useProfile(context, 'unknown');
  await addFiles(context, [fakeFile({ name: '图.png', type: 'image/png' })]);
  context.input.value = '这张图怎么看';
  await context.app.sendAIMessage();
  assert.equal(asked.length, 0, 'vision 未通过的含附件请求不得发出');
  assert.ok(context.toasts.some(message => message.includes('未通过图片能力测试')));
  assert.equal(context.input.value, '这张图怎么看');
  assert.equal(context.api.AIAttachments.items.length, 1, 'vision 失败后保留附件');

  // 整个请求 JSON 的 UTF-8 字节数超过 10MiB
  useProfile(context, 'passed');
  const big = 'A'.repeat(3 * 1024 * 1024);
  context.api.AIAttachments.items = Array.from({ length: 4 }, (_, index) => ({ id: `big-${index}`, name: `大图${index}.png`, dataUrl: `data:image/png;base64,${big}` }));
  await context.app.sendAIMessage();
  assert.equal(asked.length, 0, '超限请求不得发出');
  assert.ok(context.toasts.some(message => message.includes('超过 10MiB 上限')));
  assert.equal(context.api.AIAttachments.items.length, 4, '超限后保留附件');
  assert.equal(context.input.value, '这张图怎么看', '超限后保留输入');
});

test('发送契约：失败后自动恢复本次图文快照供重发，有新草稿则不覆盖', async () => {
  const context = createContext();
  const asked = [];
  context.api.AIService.questionImages = async () => [];
  context.api.AIService.chatStream = async payload => {
    asked.push(payload);
    throw new Error('模拟上游失败');
  };
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());
  await addFiles(context, [fakeFile({ name: '图.png', type: 'image/png' })]);
  context.input.value = '带着图片提问';
  await context.app.sendAIMessage();
  assert.equal(asked.length, 1);
  // 本次失败已自动恢复图文快照（发送瞬间的输入被清空过，随后按快照回填）
  assert.equal(context.api.AIAttachments.items.length, 1, '失败后自动恢复原图片');

  // 失败即自动恢复：输入与预览都回到发送前的图文，无需用户先点“重试”
  assert.equal(context.input.value, '带着图片提问', '失败后应自动恢复原文本');
  assert.equal(context.api.AIAttachments.items[0].name, '图.png');
  assert.equal(cards(context.previews).length, 1, '预览区要同步显示恢复的图片');
  assert.equal(context.drafts.get('331'), '带着图片提问', '恢复的文本写入草稿');

  // 在途期间用户才写入的新草稿 / 新图：失败后不得被本次旧快照覆盖
  let failFlight = null;
  context.api.AIService.chatStream = payload => {
    asked.push(payload);
    return new Promise((resolve, reject) => { failFlight = () => reject(new Error('模拟上游失败')); });
  };
  context.input.value = '带着旧图提问';
  const flight = context.app.sendAIMessage();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(context.input.value, '', '发送后输入清空，此时用户在途输入');
  context.input.value = '在途期间新写的追问';
  failFlight();
  await flight;
  assert.equal(asked.length, 2);
  assert.equal(context.input.value, '在途期间新写的追问', '在途期间的新草稿不得被旧快照覆盖');
  assert.equal(context.api.AIAttachments.items.length, 0, '在途期间未加新图，恢复被跳过，不把旧图塞回输入区');
});

test('发送契约：失败后重试按钮恢复并使用同一图文快照', async () => {
  const context = createContext();
  const asked = [];
  context.api.AIService.questionImages = async () => [];
  context.api.AIService.chatStream = async payload => {
    asked.push(payload);
    if (asked.length === 1) throw new Error('模拟上游失败');
    return { headers: { get: () => 'run-2' }, body: null };
  };
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());
  await addFiles(context, [fakeFile({ name: '图.png', type: 'image/png' })]);
  context.input.value = '带着图片提问';
  await context.app.sendAIMessage();
  assert.equal(asked.length, 1);
  // 失败已自动恢复输入与预览，此处验证重试按钮仍使用同一快照完成重发
  assert.equal(context.input.value, '带着图片提问');
  assert.equal(context.api.AIAttachments.items.length, 1);

  // 失败分支留下的重试按钮：用同一图文快照重发
  // （失败时回答节点已被移除 id，按消息结构定位）
  const responseEl = context.messages.children.at(-1)?.children[0];
  assert.ok(responseEl, '失败后应留下可重试的回答节点');
  const retryButton = responseEl.querySelector('.ai-retry-btn');
  assert.ok(retryButton, '失败后应提供重试按钮');
  retryButton.dispatchEvent(createFakeEvent('click'));
  assert.equal(context.input.value, '带着图片提问', '重试要恢复原文本');
  assert.equal(context.api.AIAttachments.items.length, 1, '重试要恢复原图片快照');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(asked.length, 2);
  assert.equal(asked[1].prompt, '带着图片提问');
  assert.equal(asked[1].images.length, 1);
});

test('发送契约：同一题连续发送时，发送后再次添加的附件仍能随新请求发出', async () => {
  const context = createContext();
  const { asked } = mockChat(context, { images: [] });
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());

  await addFiles(context, [fakeFile({ name: '第一次.png', type: 'image/png' })]);
  context.input.value = '第一问';
  await context.app.sendAIMessage();
  assert.equal(asked.length, 1);

  // 发送成功后输入区仍属于当前题：再添加附件必须能发出去，不能被一致性守卫误拒
  await addFiles(context, [fakeFile({ name: '第二次.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.items.length, 1);
  context.input.value = '第二问';
  await context.app.sendAIMessage();
  assert.equal(asked.length, 2, '同题连续发送不得被误拒');
  assert.equal(asked[1].prompt, '第二问');
  assert.equal(asked[1].images.length, 1);
  assert.equal(context.toasts.some(message => message.includes('状态已变化')), false);
});

test('发送契约：读取仍在进行时点击重试，不发送也不静默丢图', async () => {
  const context = createContext();
  const asked = [];
  context.api.AIService.questionImages = async () => [];
  context.api.AIService.chatStream = async payload => {
    asked.push(payload);
    throw new Error('模拟上游失败');
  };
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());
  await addFiles(context, [fakeFile({ name: '首图.png', type: 'image/png' })]);
  context.input.value = '第一次提问';
  await context.app.sendAIMessage();
  assert.equal(asked.length, 1);
  const responseEl = context.messages.children.at(-1)?.children[0];
  const retryButton = responseEl.querySelector('.ai-retry-btn');
  assert.ok(retryButton, '失败后应提供重试按钮');

  // 用户又选了一张图，读取尚未完成时点击重试
  const slow = context.api.AIAttachments.addFiles([fakeFile({ name: '在读.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.reading, 1);
  retryButton.dispatchEvent(createFakeEvent('click'));
  // restore 会作废在途批次；若没有守卫，reading 会被清零并放行发送，在途图片被静默丢弃
  assert.equal(asked.length, 1, '读取中点击重试不得发起新请求');
  assert.equal(context.api.AIAttachments.reading, 1, '守卫必须保留在途占位，不能被 restore 清零');
  assert.ok(context.toasts.some(message => message.includes('图片还在读取中')), '读取中重试要有明确提示');
  // 失败时自动恢复的“首图”保持不动，在读的“在读.png”不得被旧快照顶替或提前计入
  assert.equal(context.api.AIAttachments.items.length, 1, '不得用旧快照覆盖在读批次');
  assert.equal(context.api.AIAttachments.items[0].name, '首图.png', '在读期间附件必须仍是自动恢复的原始图片');

  // 读取完成后，重试才真正恢复快照并重发
  await context.files.flush();
  await slow;
  retryButton.dispatchEvent(createFakeEvent('click'));
  assert.equal(context.api.AIAttachments.items.length, 1, '读取完成后重试恢复原图片快照');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(asked.length, 2);
  assert.equal(asked[1].prompt, '第一次提问');
  assert.equal(asked[1].images.length, 1);
});

test('发送契约：AI 忙时点击重试，不覆盖当前运行', async () => {
  const context = createContext();
  const asked = [];
  context.api.AIService.questionImages = async () => [];
  context.api.AIService.chatStream = async payload => {
    asked.push(payload);
    if (asked.length === 1) throw new Error('模拟上游失败');
    return { headers: { get: () => 'run-3' }, body: null };
  };
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());
  context.input.value = '会失败的一问';
  await context.app.sendAIMessage();
  const retryButton = context.messages.children.at(-1)?.children[0].querySelector('.ai-retry-btn');
  assert.ok(retryButton);

  // 模拟当前已有运行在进行：重试必须让位，不覆盖在途请求
  context.AppState.aiBusy = true;
  context.input.value = '正在生成中的追问';
  retryButton.dispatchEvent(createFakeEvent('click'));
  assert.equal(asked.length, 1, 'AI 忙时重试不得发起请求');
  assert.equal(context.input.value, '正在生成中的追问', '忙时不得用旧快照覆盖用户当前输入');
  assert.equal(context.api.AIAttachments.items.length, 0);
});

test('附件入口：文件选择 change 事件先快照再清空 input，图片不被清空丢掉', async () => {
  const context = createContext();
  context.api.AIAttachments.bindPanel(context.panel, question());
  // 还原真实 FileList：同一个活对象，input.value='' 时原地清空（而非重新绑定变量）
  const liveList = [fakeFile({ name: '选择.png', type: 'image/png' })];
  Object.defineProperty(context.fileInput, 'files', { configurable: true, get: () => liveList });
  Object.defineProperty(context.fileInput, 'value', {
    configurable: true,
    get: () => (liveList.length ? 'C:\\fakepath\\选择.png' : ''),
    set: next => { if (next === '') liveList.length = 0; },
  });

  context.fileInput.dispatchEvent(createFakeEvent('change'));
  await context.files.flush();
  assert.equal(context.api.AIAttachments.items.length, 1, 'change 事件后必须保留用户选择的图片');
  assert.equal(context.api.AIAttachments.items[0].name, '选择.png');
  assert.equal(context.fileInput.value, '', '处理完后 input 要清空，便于重复选择同一文件');
  assert.equal(cards(context.previews).length, 1);
});

test('附件入口：文件选择的多张图片都不丢失', async () => {
  const context = createContext();
  context.api.AIAttachments.bindPanel(context.panel, question());
  const liveList = [fakeFile({ name: '甲.png', type: 'image/png' }), fakeFile({ name: '乙.jpg', type: 'image/jpeg' })];
  Object.defineProperty(context.fileInput, 'files', { configurable: true, get: () => liveList });
  Object.defineProperty(context.fileInput, 'value', {
    configurable: true,
    get: () => (liveList.length ? 'C:\\fakepath\\multi' : ''),
    set: next => { if (next === '') liveList.length = 0; },
  });

  context.fileInput.dispatchEvent(createFakeEvent('change'));
  await context.files.flush();
  assert.equal(context.api.AIAttachments.items.length, 2);
  assert.deepEqual([...context.api.AIAttachments.items.map(item => item.name)], ['甲.png', '乙.jpg']);
});

test('发送契约：生成期间输入框被重渲染替换后，失败恢复写入实时节点而非 detached 旧节点', async () => {
  const context = createContext();
  const asked = [];
  context.api.AIService.questionImages = async () => [];
  let failFlight = null;
  context.api.AIService.chatStream = payload => {
    asked.push(payload);
    return new Promise((resolve, reject) => { failFlight = () => reject(new Error('模拟上游失败')); });
  };
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());
  await addFiles(context, [fakeFile({ name: '图.png', type: 'image/png' })]);
  context.input.value = '带着图片提问';

  const flight = context.app.sendAIMessage();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(failFlight, '请求已发出');

  // 同题重渲染（如切换做题模式）替换输入框：旧节点 detached
  const { stale, fresh } = replaceInput(context);
  assert.equal(stale.isConnected, false);

  failFlight();
  await flight;

  assert.equal(stale.value, '', '不得写入已 detached 的旧输入框');
  assert.equal(fresh.value, '带着图片提问', '必须写入当前面板里的实时输入框');
  assert.equal(context.document.getElementById('ai-input'), fresh);
});

test('发送生命周期：准备题图期间不得并发二次发送或更改附件', async () => {
  const context = createContext();
  const asked = [];
  let releasePrepare = null;
  let prepareStarted = false;
  context.api.AIService.chatStream = async payload => {
    asked.push(payload);
    return { headers: { get: () => 'run-1' }, body: null };
  };
  // 确定性延迟：进入准备阶段后挂起，直到测试显式放行
  context.api.AIService.questionImages = async () => {
    prepareStarted = true;
    await new Promise(resolve => { releasePrepare = resolve; });
    return [];
  };
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());
  await addFiles(context, [fakeFile({ name: '图.png', type: 'image/png' })]);
  context.input.value = '第一问';

  const flight = context.app.sendAIMessage();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(prepareStarted, true, '已进入题图准备阶段');
  assert.equal(context.AppState.aiBusy, true, '准备阶段就必须锁定 busy');

  // 准备期间双击重发：不得并发准备，也不得再发一次
  context.input.value = '趁准备期的第二问';
  await context.app.sendAIMessage();
  assert.equal(asked.length, 0, '准备期间不得发出任何请求');
  assert.equal(context.api.AIAttachments.items.length, 1, '准备期间原附件仍在');
  assert.equal(context.sendButton.disabled, true, '准备期间发送按钮保持禁用');

  // 准备期间加图 / 改图：必须被明确拒绝，不能静默丢弃
  const itemsBefore = context.api.AIAttachments.items.length;
  await addFiles(context, [fakeFile({ name: '趁准备期加的图.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.items.length, itemsBefore, '准备期间不得更改附件');
  assert.ok(context.toasts.some(message => message.includes('AI 正在生成，暂时不能更改附件')));

  releasePrepare();
  await flight;
  assert.equal(asked.length, 1, '整个准备期只发出一次请求');
  assert.equal(asked[0].prompt, '第一问');
  assert.equal(asked[0].images.length, 1);
  assert.equal(context.input.value, '趁准备期的第二问', '准备期间新写的文本不得被提交时的清空静默抹掉');
  assert.equal(context.AppState.aiBusy, false, '发送结束后复位 busy');
});

test('发送生命周期：准备题图期间切题不得发出旧题请求', async () => {
  const context = createContext();
  const asked = [];
  let releasePrepare = null;
  context.api.AIService.chatStream = async payload => {
    asked.push(payload);
    return { headers: { get: () => 'run-1' }, body: null };
  };
  context.api.AIService.questionImages = () => new Promise(resolve => { releasePrepare = () => resolve([]); });
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());
  context.input.value = '旧题提问';

  const flight = context.app.sendAIMessage();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(context.AppState.aiBusy, true);

  // 准备期间切题：abortAIStream 会中止准备，并复位 busy
  context.AppState.questions = [question(999)];
  context.AppState.currentQuestionIndex = 0;
  context.app.abortAIStream();
  assert.equal(context.AppState.aiBusy, false, '切题必须能中止准备并复位 busy');

  releasePrepare();
  await flight;
  assert.equal(asked.length, 0, '准备期间切题后绝不能再发出旧题请求');
  assert.equal(context.messages.children.length, 0, '不得为旧题插入用户消息气泡');
});

test('发送生命周期：准备期间发出的是当前题而不是开始时的旧题', async () => {
  const context = createContext();
  const asked = [];
  let releasePrepare = null;
  context.api.AIService.chatStream = async payload => {
    asked.push(payload);
    return { headers: { get: () => 'run-1' }, body: null };
  };
  context.api.AIService.questionImages = () => new Promise(resolve => { releasePrepare = () => resolve([]); });
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());
  context.input.value = '旧题提问';

  const flight = context.app.sendAIMessage();
  await new Promise(resolve => setTimeout(resolve, 0));

  // 切题但未中止（模拟仍处于准备窗口）：题号已变，准备完成后必须放弃发送
  context.AppState.questions = [question(999)];
  context.AppState.currentQuestionIndex = 0;
  releasePrepare();
  await flight;
  assert.equal(asked.length, 0, '题号已变时准备完成后不得发送');
  assert.equal(context.AppState.aiBusy, false, '放弃发送时必须复位 busy');
});

test('切题清理：forQuestion 换题即清空并刷新预览，abortAIStream 一并清理', async () => {
  const context = createContext();
  context.api.AIAttachments.bindPanel(context.panel, question());
  await addFiles(context, [fakeFile({ name: '图.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.items.length, 1);

  context.api.AIAttachments.forQuestion('999');
  assert.equal(context.api.AIAttachments.items.length, 0);
  assert.equal(cards(context.previews).length, 0);
  assert.equal(context.previews.hidden, true);

  // 同一题重复进入不重复清理
  await addFiles(context, [fakeFile({ name: '图二.png', type: 'image/png' })]);
  context.api.AIAttachments.forQuestion('999');
  assert.equal(context.api.AIAttachments.items.length, 1);

  context.app.abortAIStream();
  assert.equal(context.api.AIAttachments.items.length, 0);
  assert.equal(context.AppState.aiBusy, false);
});

test('未真正换题的中止：abortAIStream 清空附件后，附件归属必须与仍存活的面板题号一致', async () => {
  const context = createContext();
  context.api.AIAttachments.bindPanel(context.panel, question());
  await addFiles(context, [fakeFile({ name: '图.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.items.length, 1);

  // 单题页越界点「上一题/下一题」、跳题输入当前题号都会执行 abortAIStream：面板未重建，dataset 仍是当前题。
  context.app.abortAIStream();
  assert.equal(context.api.AIAttachments.items.length, 0, 'abort 后清空附件');
  assert.equal(context.api.AIAttachments.questionId, '331', '附件归属跟随仍存活的面板题号');
  assert.equal(context.api.AIAttachments.panel, context.panel, '附件仍绑定原面板');

  // 归属一致后，同一题重新附图并发送，必须真正发出请求并带上图片。
  await addFiles(context, [fakeFile({ name: '再来.png', type: 'image/png' })]);
  assert.equal(context.api.AIAttachments.questionId, '331');
  useProfile(context, 'passed');
  const { asked } = mockChat(context);
  context.input.value = '我这个理解对吗?';
  await context.app.sendAIMessage();
  assert.equal(asked.length, 1, '中止后同题附图仍能发送');
  assert.equal(asked[0].images.length, 1, '图片随请求发出');
  assert.equal(context.toasts.length, 0, '不得出现附件状态已变化的拒绝提示');
});

test('请求体契约：images 为 dataURL 数组原样透传，整包校验按 UTF-8 字节计', async () => {
  const context = createContext();
  let captured = null;
  context.sandbox.fetch = async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body) };
    return { ok: true, headers: { get: () => 'run-1' }, body: null };
  };
  useProfile(context, 'passed');
  context.api.AIService.loadProfiles = async () => context.AppState.aiProfiles;
  await context.api.AIService.chatStream({
    question: question(),
    prompt: '看图',
    includePrivate: false,
    images: [PNG_URL, 'data:image/webp;base64,d2VicA=='],
  });
  assert.match(captured.url, /\/api\/ai\/chat$/);
  assert.deepEqual(captured.body.images, [PNG_URL, 'data:image/webp;base64,d2VicA==']);
  assert.equal(captured.body.profileId, 'p1');
  assert.equal(captured.body.prompt, '看图');
  assert.equal(captured.body.includePrivate, false);

  // 非 dataURL 的字符串按原样透传（契约由后端与调用方保证），空值归一为数组
  assert.equal(context.api.AIService.assertBodySize({ images: [] }) <= 10 * 1024 * 1024, true);
  assert.throws(() => context.api.AIService.assertBodySize({ images: ['A'.repeat(11 * 1024 * 1024)] }), /超过 10MiB 上限/);
  // 中文字符按 UTF-8 多字节计
  assert.equal(context.api.AIService.assertBodySize({ text: '汉'.repeat(3 * 1024 * 1024) }) > 9 * 1024 * 1024, true);
});

// vm 沙箱里构造的数组/对象原型与测试 realm 不同，deepStrictEqual 会因原型不同而失败；比较前先 JSON 归一。
const plain = value => JSON.parse(JSON.stringify(value));

test('临时会话：成功一轮后才把 user+assistant 作为 history 发送，reasoningPresetId 始终发送（空串=模型默认）', async () => {
  const context = createContext();
  const { asked } = mockChat(context);
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());

  context.input.value = '第一问';
  await context.app.sendAIMessage();
  assert.equal(asked.length, 1);
  assert.deepEqual(plain(asked[0].history), [], '首轮没有上文，history 为空数组');
  assert.equal(asked[0].reasoningPresetId, '', '档位框为空时按契约发送空串（模型默认），绝不省略该字段');

  // 选择档位后仍只发档位 id，不发参数 JSON。
  context.reasoningSelect.value = 'preset-deep';
  context.input.value = '第二问';
  await context.app.sendAIMessage();
  assert.equal(asked.length, 2);
  assert.equal(asked[1].reasoningPresetId, 'preset-deep', '选中的档位以 id 发送');
  assert.deepEqual(plain(asked[1].history), [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '' },
  ], '第二轮携带上一轮的 user+assistant 上下文');
  assert.deepEqual(plain(await context.api.AIService.loadHistory(question())), [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '' },
    { role: 'user', content: '第二问' },
    { role: 'assistant', content: '' },
  ], '内存历史适配层按题返回当前会话，不从 server 恢复');
});

test('清空：clearAIChat 清空消息/附件/草稿，作废在途生成，迟到回复不回填', async () => {
  const context = createContext();
  // 清空会对当前 profile/题号调用 DELETE conversations；这里返回 ok，验证不因失败中断本地清理。
  const deletes = [];
  context.sandbox.fetch = async (url, options = {}) => {
    if (options.method === 'DELETE') deletes.push(String(url));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  let releaseFlight = null;
  const asked = [];
  context.api.AIService.questionImages = async () => [];
  context.api.AIService.chatStream = payload => {
    asked.push(payload);
    return new Promise(resolve => { releaseFlight = () => resolve({ headers: { get: () => 'run-1' }, body: null }); });
  };
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());
  await addFiles(context, [fakeFile({ name: '清空.png', type: 'image/png' })]);
  context.input.value = '要被清空的提问';
  const flight = context.app.sendAIMessage();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(asked.length, 1);
  assert.equal(context.AppState.aiBusy, true);
  assert.equal(context.messages.querySelectorAll('.ai-message').length, 2, '发送后消息区有用户气泡与回答占位');

  await context.app.clearAIChat();
  assert.equal(context.AppState.aiBusy, false, '清空后复位 busy');
  assert.equal(context.api.AIAttachments.items.length, 0, '清空附件状态');
  assert.equal(cards(context.previews).length, 0, '清空附件预览');
  assert.equal(context.input.value, '', '清空草稿输入');
  assert.equal(context.drafts.get('331'), '', '清空内存草稿');
  assert.equal(context.messages.querySelectorAll('.ai-message').length, 0, '清空消息');
  assert.ok(context.messages.querySelector('.ai-empty'), '消息区回到空状态');
  assert.ok(deletes.some(url => /\/api\/ai\/conversations\/p1\/331$/.test(url)), '按当前 profile/题号清理遗留会话');

  // 迟到回复到达：代次已变，不得回填消息，也不得把旧答案写入内存上下文。
  releaseFlight();
  await flight;
  assert.equal(context.messages.querySelectorAll('.ai-message').length, 0, '迟到回复不得回填消息');
  assert.deepEqual(plain(await context.api.AIService.loadHistory(question())), [], '迟到回复不得进入临时会话');
  assert.equal(context.api.AIAttachments.items.length, 0, '迟到回复不得恢复附件');
});

test('清空：DELETE conversations 返回 500 时明确提示遗留清理失败，但本窗口消息仍清空', async () => {
  const context = createContext();
  const deletes = [];
  context.sandbox.fetch = async (url, options = {}) => {
    if (options.method === 'DELETE') { deletes.push(String(url)); return { ok: false, status: 500, json: async () => ({ error: '磁盘写失败' }) }; }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());
  context.api.AIService.rememberTurn(question(), '旧问', '旧答');
  await context.api.AIViews.renderAIHistory(question());
  assert.equal(context.messages.querySelectorAll('.ai-message').length, 2, '清空前有历史气泡');

  await context.app.clearAIChat();
  assert.ok(deletes.some(url => /\/api\/ai\/conversations\/p1\/331$/.test(url)));
  assert.equal(context.messages.querySelectorAll('.ai-message').length, 0, '本窗口消息仍清空');
  assert.ok(context.messages.querySelector('.ai-empty'), '仍回落空占位');
  assert.ok(context.toasts.some(message => /HTTP 500/.test(message) && /清理失败/.test(message)), 'DELETE 500 必须显式提示，不能静默当成功');
  assert.ok(context.toasts.some(message => /磁盘写失败/.test(message)), '提示里带上服务端错误信息');
});

test('缓存作用域：Q1 对话 -> 切 Q2 不发言 -> 切回 Q1 临时会话为空（切题即丢）', () => {
  const context = createContext();
  useProfile(context, 'passed');
  context.api.AIService.rememberTurn(question(331), 'Q1 提问', 'Q1 回答');
  assert.deepEqual(plain(context.api.AIService.historyFor(question(331))), [
    { role: 'user', content: 'Q1 提问' },
    { role: 'assistant', content: 'Q1 回答' },
  ], '同题读取保留当前会话');
  assert.deepEqual(plain(context.api.AIService.historyFor(question(999))), [], 'Q2 无上文');
  assert.deepEqual(plain(context.api.AIService.historyFor(question(331))), [], '切回 Q1 不得复活旧上下文');
  // 同题重复读取不应误清当前会话
  context.api.AIService.rememberTurn(question(331), '再问', '再答');
  assert.equal(plain(context.api.AIService.historyFor(question(331))).length, 2);
  assert.equal(plain(context.api.AIService.historyFor(question(331))).length, 2, '同题重绘/重复读取不清空');
});

test('缓存作用域：切服务后历史为空且 DOM 渲染为空占位，不残留上一服务对话', async () => {
  const context = createContext();
  useProfile(context, 'passed');
  context.AppState.aiProfiles = [
    { id: 'p1', name: '服务A', capabilities: { text: true, vision: 'passed' } },
    { id: 'p2', name: '服务B', capabilities: { text: true, vision: 'passed' } },
  ];
  context.AppState.aiProfileId = 'p1';
  context.api.AIService.rememberTurn(question(331), 'A 服务提问', 'A 服务回答');
  await context.api.AIViews.renderAIHistory(question(331));
  assert.equal(context.messages.querySelectorAll('.ai-message').length, 2);

  // 切换服务：历史与 DOM 都应清空（不能只 return 留旧内容）。
  context.AppState.aiProfileId = 'p2';
  await context.api.AIViews.renderAIHistory(question(331));
  assert.equal(context.messages.querySelectorAll('.ai-message').length, 0, '换服务后 DOM 不含旧服务对话');
  assert.ok(context.messages.querySelector('.ai-empty'), '换服务后渲染为空占位');
  assert.deepEqual(plain(context.api.AIService.historyFor(question(331))), [], '换服务后历史为空');
});

test('清空竞态：旧流在 clear 后到达的 started/delta 不得改全局 runId 或回填', async () => {
  const context = createContext();
  context.sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  let releaseRead = null;
  context.api.AIService.questionImages = async () => [];
  context.api.AIService.chatStream = async () => ({
    headers: { get: () => '' },
    body: {
      getReader: () => ({
        read: () => new Promise(resolve => {
          releaseRead = () => resolve({
            done: false,
            value: new TextEncoder().encode(
              'data: ' + JSON.stringify({ type: 'started', runId: 'late-run' }) + '\n\n' +
              'data: ' + JSON.stringify({ type: 'delta', content: '迟到内容' }) + '\n\n',
            ),
          });
        }),
      }),
    },
  });
  useProfile(context, 'passed');
  context.api.AIAttachments.bindPanel(context.panel, question());
  context.input.value = '生成中的提问';
  const flight = context.app.sendAIMessage();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(releaseRead, '已进入读取边界');
  assert.equal(context.AppState.aiBusy, true);

  await context.app.clearAIChat();
  assert.equal(context.AppState.aiRunId, '', '清空后 runId 归零');

  // 旧流迟到：reader 边界 epoch 复核，started/delta 都不生效。
  releaseRead();
  await flight;
  assert.equal(context.AppState.aiRunId, '', '旧流迟到 started 不得覆盖全局 runId');
  assert.equal(context.messages.querySelectorAll('.ai-message').length, 0, '迟到内容不得回填');
  assert.equal(context.AppState.aiBusy, false, '旧 finally 不得破坏新状态');
});

test('档位选择：同服务刷新保留用户显式选择的「模型默认」空串，不被档案默认覆盖', () => {
  const context = createContext();
  context.AppState.aiProfiles = [
    { id: 'p1', name: '服务A', reasoningPresets: [{ id: 'r1', name: '深度思考' }], defaultReasoningPresetId: 'r1', capabilities: { text: true, vision: 'passed' } },
    { id: 'p2', name: '服务B', reasoningPresets: [{ id: 'r2', name: '快速' }], defaultReasoningPresetId: 'r2', capabilities: { text: true, vision: 'passed' } },
  ];
  context.AppState.aiProfileId = 'p1';
  const select = context.reasoningSelect;
  // 首次设置（新建 select、无归属）用档案默认。
  context.api.AIController.syncReasoningPresets();
  assert.equal(select.value, 'r1', '首次用档案默认档位');
  // 用户明确选择「模型默认」空串：同服务刷新选项时不得被默认覆盖。
  select.value = '';
  context.api.AIController.syncReasoningPresets();
  assert.equal(select.value, '', '同服务刷新必须保留显式空串（模型默认）');
  // 档位被删：当前值无效则回档案默认。
  select.value = 'gone';
  context.api.AIController.syncReasoningPresets();
  assert.equal(select.value, 'r1', '无效/被删档位回退到档案默认');
  // 换服务用新服务默认。
  context.AppState.aiProfileId = 'p2';
  context.api.AIController.syncReasoningPresets();
  assert.equal(select.value, 'r2', '换服务用新服务默认');
});
