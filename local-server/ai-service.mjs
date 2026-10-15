import dns from "node:dns/promises";
import net from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cipherTag, createSecretBackend, SECRET_FORMAT } from "./ai-secrets.mjs";

const PROFILE_VERSION = 2;
const MAX_PROFILES = 12;
const REQUEST_TIMEOUT_MS = 90_000;
// Keys shorter than this reveal no characters at all in keyHint.
const MIN_HINT_LENGTH = 16;
// Frozen vision-upload contract: at most 4 images, each a base64 dataURL for an
// allowed raster format whose decoded bytes stay within 2 MiB. The old
// safeText(url, 2_000_000) truncated a ~2.8M-char dataURL and silently corrupted
// large images, so images are forwarded verbatim after explicit validation.
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
// 思考档位（reasoningPresets）：预设多个自定义思考参数，聊天时按 id 选用。
// Frozen preset contract: at most 12 presets, each with a unique printable-ASCII
// id (1..64), a 1..40 char name, and a plain JSON-object `params` whose serialized
// form stays within 8 KiB. `params` may nest whatever field the provider expects
// (e.g. reasoning_effort / thinking / extra_body) — no hard-coded low/mid/high or
// model enums here. Only request-shaping or credential/address keys are refused.
const MAX_REASONING_PRESETS = 12;
const MAX_PRESET_ID = 64;
const MAX_PRESET_NAME = 40;
const MAX_PRESET_PARAMS_BYTES = 8 * 1024;
const PRESET_ID_PATTERN = /^[\x21-\x7e]{1,64}$/;
const MAX_CHAT_HISTORY = 24;
// Top-level params keys that would override the controlled request body, the auth
// headers or the request address. Keys are compared case-insensitively.
const FORBIDDEN_PRESET_KEYS = new Set(["model", "messages", "stream", "headers", "authorization", "apikey", "api_key", "key", "baseurl", "base_url", "url"]);
// Never allowed as a key anywhere in the nested params structure: prototype
// pollution via JSON input.
const FORBIDDEN_PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeText(value, max = 120_000) {
  return String(value ?? "").slice(0, max);
}

function profileKey(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "default";
}

// Image-contract violations are client errors (HTTP 400): server errorJson maps
// `error.status` to the response code. Local helper only — not a global policy.
function imageContractError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// Client-input violations (invalid preset, invalid chat history) are explicit
// HTTP 400 with a readable reason — never a silent drop or a 500 fallback.
function clientError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// Validate a single preset's `params`: a plain JSON object (no array, null, or
// scalar). Only the TOP level may not shadow the controlled request/auth/address
// fields (model/messages/stream/headers/authorization/apiKey/api_key/key/
// baseUrl/base_url/url); a nested payload such as extra_body.model is the
// provider's own business and stays allowed. Prototype keys are refused at any
// depth. The serialized form must fit in 8 KiB (measured in UTF-8 bytes, so a
// multi-byte value that is short in characters but long in bytes is caught).
// Returned verbatim so the chat body can map it 1:1 to the provider.
function normalizePresetParams(value, id) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw clientError(`思考档位「${id}」的 params 必须是 JSON 对象`);
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_PROTOTYPE_KEYS.has(key)) throw clientError(`思考档位「${id}」的 params 不能包含保留键「${key}」`);
    if (FORBIDDEN_PRESET_KEYS.has(String(key).toLowerCase())) throw clientError(`思考档位「${id}」的 params 不能覆盖受控字段「${key}」`);
  }
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    for (const key of Object.keys(current)) {
      if (FORBIDDEN_PROTOTYPE_KEYS.has(key)) throw clientError(`思考档位「${id}」的 params 不能包含保留键「${key}」`);
      const child = current[key];
      if (child && typeof child === "object") stack.push(child);
    }
  }
  let json;
  try { json = JSON.stringify(value); } catch { throw clientError(`思考档位「${id}」的 params 无法序列化为 JSON`); }
  if (Buffer.byteLength(json, "utf8") > MAX_PRESET_PARAMS_BYTES) throw clientError(`思考档位「${id}」的 params 超过 ${MAX_PRESET_PARAMS_BYTES} 字节上限`);
  return value;
}

// Whole-array validation for a profile write. `undefined` means "field not sent"
// and keeps the existing presets; any other non-array value is an explicit 400.
// Invalid entries and duplicate ids are rejected, never silently dropped.
function normalizeReasoningPresets(value, existing = {}) {
  if (value === undefined) return Array.isArray(existing.reasoningPresets) ? existing.reasoningPresets : [];
  if (!Array.isArray(value)) throw clientError("思考档位 reasoningPresets 必须是数组");
  if (value.length > MAX_REASONING_PRESETS) throw clientError(`最多保存 ${MAX_REASONING_PRESETS} 个思考档位`);
  const seen = new Set();
  return value.map((raw, index) => {
    const item = object(raw);
    const id = typeof item.id === "string" ? item.id : "";
    if (!PRESET_ID_PATTERN.test(id)) throw clientError(`第 ${index + 1} 个思考档位的 id 必须是不含空白的 1..${MAX_PRESET_ID} 位 ASCII 字符串`);
    if (seen.has(id)) throw clientError(`思考档位 id 重复：${id}`);
    seen.add(id);
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name || name.length > MAX_PRESET_NAME) throw clientError(`思考档位「${id}」的 name 必须是 1..${MAX_PRESET_NAME} 个字符`);
    return { id, name, params: normalizePresetParams(item.params, id) };
  });
}

// "" means "no extra params". A non-empty default must reference one of the
// resulting presets, otherwise the write fails instead of leaving a dangling id.
function normalizeDefaultReasoningPreset(value, existing = {}, presets) {
  const raw = value === undefined ? (existing.defaultReasoningPresetId ?? "") : value;
  const id = raw == null ? "" : String(raw);
  if (id === "") return "";
  if (!presets.some((preset) => preset.id === id)) throw clientError(`默认思考档位「${id}」不在该服务的档位列表中`);
  return id;
}

// Validate `payload.images` against the frozen vision contract and return the
// dataURLs to forward upstream verbatim (no slice, no safeText truncation).
// Omitted or empty stays text-only; any non-empty value is validated explicitly
// and never silently dropped or trimmed.
function normalizeImages(value, capabilities) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw imageContractError("图片参数必须是字符串数组");
  if (value.length === 0) return [];
  if (capabilities?.vision !== "passed") throw imageContractError("当前 AI 服务未通过视觉测试，不能上传图片。请先在服务档案中完成视觉测试");
  if (value.length > MAX_IMAGES) throw imageContractError(`一次最多上传 ${MAX_IMAGES} 张图片`);
  return value.map((url) => {
    const match = typeof url === "string" ? IMAGE_DATA_URL.exec(url) : null;
    if (!match) throw imageContractError("图片只支持 PNG/JPEG/WebP/GIF 格式的 base64 dataURL");
    const base64 = match[1];
    if (base64.length % 4 !== 0) throw imageContractError("图片 base64 数据不合法");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) throw imageContractError("图片内容为空");
    if (bytes.length > MAX_IMAGE_BYTES) throw imageContractError("图片解码后超过 2 MiB 上限");
    return url;
  });
}

function isPrivateAddress(address) {
  const ip = net.isIP(address);
  if (ip === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (ip === 6) return address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:");
  return false;
}

export async function validateBaseUrl(value) {
  const text = String(value || "").trim();
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error("AI API 地址必须是完整的 http:// 或 https:// 地址"); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("AI API 只支持 HTTP 或 HTTPS");
  if (parsed.username || parsed.password) throw new Error("API 地址不能内嵌账号或密码");
  if (parsed.hash) throw new Error("API 地址不能包含片段");
  const hostname = parsed.hostname.toLowerCase();
  let privateNetwork = hostname === "localhost" || hostname.endsWith(".local") || isPrivateAddress(hostname);
  if (!privateNetwork) {
    try {
      const records = await dns.lookup(hostname, { all: true });
      privateNetwork = records.length > 0 && records.every((item) => isPrivateAddress(item.address));
    } catch {
      if (parsed.protocol === "http:") throw new Error("无法确认 HTTP 地址的网络范围；公网地址请使用 HTTPS");
    }
  }
  if (parsed.protocol === "http:" && !privateNetwork) throw new Error("公网 AI 接口必须使用 HTTPS；本机或局域网服务可以使用 HTTP");
  return parsed.toString().replace(/\/+$/, "");
}

// Deterministic, DNS-free canonical form used to bind a saved Key to the exact
// address it was entered for. It deliberately mirrors what `endpoint()` will
// actually request: URL normalizes scheme/host case, default ports and dot
// segments, and a trailing slash is dropped because `endpoint()` strips it
// before joining. Internal duplicate slashes are PRESERVED, because
// "/v1/models" and "//v1/models" are different request targets (a host can
// reverse-proxy them to different backends), so they must count as a change.
export function canonicalBaseUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  let parsed;
  try { parsed = new URL(text); } catch { return ""; }
  return parsed.toString().replace(/\/+$/, "");
}

export function sameBaseUrl(left, right) {
  const a = canonicalBaseUrl(left);
  const b = canonicalBaseUrl(right);
  return Boolean(a) && a === b;
}

// Fixed masking policy: short keys never reveal a single character, so a
// truncated or paste-error Key can not be reconstructed from the hint.
export function maskKeyHint(value) {
  const key = String(value ?? "");
  if (!key) return "未设置";
  if (key.length < MIN_HINT_LENGTH) return "••••（已设置）";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function endpoint(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

// Hold partial tags across upstream chunks so hidden text never reaches clients.
export function createAnswerFilter() {
  let pending = "";
  let depth = 0;
  return {
    push(chunk, final = false) {
      pending += String(chunk || "");
      let visible = "";
      while (pending) {
        const start = pending.indexOf("<");
        if (start < 0) { if (!depth) visible += pending; pending = ""; break; }
        if (!depth) visible += pending.slice(0, start);
        pending = pending.slice(start);
        const end = pending.indexOf(">");
        const nextStart = pending.indexOf("<", 1);
        if (nextStart > 0 && (end < 0 || nextStart < end)) {
          if (!depth) visible += pending.slice(0, nextStart);
          pending = pending.slice(nextStart);
          continue;
        }
        if (end < 0) break;
        const tag = pending.slice(0, end + 1);
        const match = /^<(\/)?(?:think|thinking)(?:\s[^>]*)?>$/i.exec(tag);
        if (match) depth = match[1] ? Math.max(0, depth - 1) : depth + 1;
        else if (!depth) visible += tag;
        pending = pending.slice(end + 1);
      }
      if (final) {
        const partial = /^<\/?(?:t|th|thi|thin|think|thinki|thinkin|thinking)(?:\s[^>]*)?$/i.test(pending);
        if (!depth && !partial) visible += pending;
        pending = "";
      }
      return visible;
    },
  };
}

export function visibleAnswer(content) {
  return createAnswerFilter().push(safeText(content), true);
}

// Client-supplied multi-turn context for one shot chat. The server keeps no
// session, so the front-end passes prior turns. Reject anything that is not a
// [{role:user|assistant, content:string}] array; system/tool turns and array
// (multimodal) content are refused outright, and only the last 24 turns survive.
function normalizeChatHistory(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw clientError("history 必须是消息数组");
  const messages = value.map((raw, index) => {
    const item = object(raw);
    if (item.role !== "user" && item.role !== "assistant") throw clientError(`history 第 ${index + 1} 条消息的 role 只能是 user 或 assistant`);
    if (typeof item.content !== "string") throw clientError(`history 第 ${index + 1} 条消息的 content 必须是字符串`);
    return { role: item.role, content: safeText(item.content) };
  });
  return messages.slice(-MAX_CHAT_HISTORY);
}

// Pick the params for this request. Omitted id falls back to the profile's
// default preset; an explicit "" means "no reasoning params". A non-empty id
// must belong to the profile — a raw `params` in the chat payload is ignored.
function resolveReasoningPreset(payload, profile) {
  const raw = payload.reasoningPresetId;
  const wanted = raw === undefined || raw === null ? (profile.defaultReasoningPresetId || "") : String(raw);
  if (!wanted) return null;
  const presets = Array.isArray(profile.reasoningPresets) ? profile.reasoningPresets : [];
  const found = presets.find((preset) => preset.id === wanted);
  if (!found) throw clientError(`思考档位「${wanted}」不属于当前 AI 服务，请在服务设置中重新选择`);
  return found;
}

// Build the upstream body. model/messages/stream are always re-asserted after
// merging preset params, so nested JSON can not take over the request shape.
// With no preset the historical temperature 0.2 is kept; with a preset no
// temperature is forced, letting the preset or the provider decide.
function buildChatBody({ model, messages, stream, preset, temperature = 0.2 }) {
  const body = { model, messages, stream };
  if (preset) {
    Object.assign(body, preset.params);
    body.model = model; body.messages = messages; body.stream = stream;
  } else {
    body.temperature = temperature;
  }
  return body;
}

function authHeaders(profile) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (profile.key) headers.Authorization = `Bearer ${profile.key}`;
  return headers;
}

function upstreamError(label, status) {
  const detail = status === 401 ? "请检查 API Key 是否有效" : status === 403 ? "请检查服务或模型的访问权限" : status === 404 ? "请检查 API 基地址和模型名称" : status === 429 ? "服务限流或额度不足，请稍后再试" : status >= 500 ? "上游服务暂时不可用，请稍后再试" : "请检查服务配置";
  return new Error(`${label}（HTTP ${status}）：${detail}`);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("AI 请求超时")), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal, redirect: "error" }); }
  finally { clearTimeout(timer); }
}

// Public projection. Never returns `key`, `keyCipher` or `keyBaseUrl`: clients
// learn only whether a usable Key exists, plus a fixed-length mask.
function publicProfile(profile) {
  const status = profile.keyStatus || "none";
  const usable = status === "ok";
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    streaming: profile.streaming !== false,
    active: profile.active === true,
    keyHint: usable ? (profile.keyHint || "已设置") : "未设置",
    hasKey: usable,
    keyStatus: status,
    capabilities: profile.capabilities || { text: false, vision: "unknown" },
    reasoningPresets: Array.isArray(profile.reasoningPresets) ? profile.reasoningPresets : [],
    defaultReasoningPresetId: typeof profile.defaultReasoningPresetId === "string" ? profile.defaultReasoningPresetId : "",
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

// Capabilities are bounded to the keys the UI actually reads, so request input
// (or a hand-edited file) can not smuggle arbitrary JSON into the profile.
function normalizeCapabilities(value, existing = {}) {
  const source = { ...object(existing), ...object(value) };
  const capabilities = { text: source.text === true, vision: "unknown" };
  if (source.vision === "passed" || source.vision === "failed" || source.vision === "unknown") capabilities.vision = source.vision;
  // The timestamp only means something for a passed vision test.
  if (capabilities.vision === "passed" && typeof source.visionTestedAt === "string") capabilities.visionTestedAt = safeText(source.visionTestedAt, 40);
  return capabilities;
}

// Whitelisted input only. Security-relevant fields (`keyCipher`, `keyBaseUrl`,
// `keyHint`, timestamps) are deliberately unreadable from request input so a
// cross-site or local request can not rebind or replace a stored secret.
function normalizeProfile(value, existing = {}) {
  const input = object(value);
  const profile = {
    id: existing.id || String(input.id || randomUUID()),
    name: safeText(input.name || existing.name || "新 AI 服务", 80).trim() || "新 AI 服务",
    baseUrl: safeText(input.baseUrl || existing.baseUrl || "", 500).trim(),
    model: safeText(input.model || existing.model || "", 160).trim(),
    streaming: input.streaming == null ? existing.streaming !== false : input.streaming !== false,
    active: input.active == null ? existing.active === true : input.active === true,
    capabilities: normalizeCapabilities(input.capabilities, existing.capabilities),
    reasoningPresets: normalizeReasoningPresets(input.reasoningPresets, existing),
    defaultReasoningPresetId: "",
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  profile.defaultReasoningPresetId = normalizeDefaultReasoningPreset(input.defaultReasoningPresetId, existing, profile.reasoningPresets);
  return profile;
}


function parseModels(value) {
  const body = object(value);
  const items = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : Array.isArray(value) ? value : [];
  return items.map((item) => object(item).id || object(item).name).filter(Boolean).map(String).slice(0, 500);
}

function parseChatContent(value) {
  const body = object(value);
  const choice = Array.isArray(body.choices) ? object(body.choices[0]) : {};
  const message = object(choice.message);
  return visibleAnswer(message.content || choice.text || "");
}

// SSE writes must never throw: a client that vanished mid-stream must not turn
// into an exception that skips run release in the caller's finally.
function writeSse(res, value) {
  if (res.writableEnded || res.destroyed) return;
  try { res.write(`data: ${JSON.stringify(value)}\n\n`); } catch { /* client already gone */ }
}

function xml(value) {
  return safeText(value, 240).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));
}

function safeSvg(spec) {
  const input = object(spec);
  const kind = String(input.kind || "function");
  const title = xml(input.title || "数学示意图");
  const width = 720;
  const height = 420;
  const points = Array.isArray(input.points) ? input.points.slice(0, 160).map((point) => [Number(point?.[0]), Number(point?.[1])]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) : [];
  if (kind !== "function" && kind !== "polyline" && kind !== "vector") throw new Error("图形类型不在安全白名单中");
  if (kind === "vector" && points.length < 2) throw new Error("向量图至少需要两个点");
  if (kind !== "vector" && points.length < 2) throw new Error("示意图至少需要两个点");
  const xs = points.map(([x]) => x); const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const sx = (x) => 70 + ((x - minX) / Math.max(1e-9, maxX - minX)) * 580;
  const sy = (y) => 350 - ((y - minY) / Math.max(1e-9, maxY - minY)) * 260;
  const polyline = points.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(" ");
  const end = points[points.length - 1];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}"><rect width="720" height="420" rx="16" fill="#fffdf9"/><text x="36" y="38" fill="#33434b" font-size="18" font-family="sans-serif">${title}</text><path d="M70 350H650M70 350V80" stroke="#aaa49a" stroke-width="1"/><polyline points="${polyline}" fill="none" stroke="#1f5364" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>${kind === "vector" ? `<circle cx="${sx(end[0]).toFixed(1)}" cy="${sy(end[1]).toFixed(1)}" r="6" fill="#bf6a4e"/>` : ""}</svg>`;
}

function sanitizeSvgMarkup(value) {
  return String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\s(?:on[a-z]+|href|xlink:href)\s*=\s*("[^"]*"|'[^']*')/gi, (match, quoted) => /^(?:"|')\s*(?:#|data:image\/)/i.test(quoted) && !/javascript:|vbscript:|data:text/i.test(quoted) ? match : "")
    .replace(/<\/?(?:iframe|object|embed|style|link)\b[^>]*>/gi, "");
}

async function pythonSvg(spec) {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "render_math_diagram.py");
  const command = process.env.DAGUAN_PYTHON || (process.platform === "win32" ? "python" : "python3");
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [script], { stdio: ["pipe", "pipe", "pipe"] });
    const out = []; const err = []; let size = 0; let timer;
    const fail = (error) => { clearTimeout(timer); reject(error); };
    timer = setTimeout(() => { child.kill(); fail(new Error("Python 绘图超时")); }, 10_000);
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size <= 5 * 1024 * 1024) out.push(chunk); else child.kill(); });
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.once("error", (error) => fail(error));
    child.once("close", (code) => { clearTimeout(timer); if (code !== 0) return reject(new Error(Buffer.concat(err).toString("utf8").slice(0, 500) || "Python 绘图失败")); resolve(Buffer.concat(out).toString("utf8")); });
    child.stdin.end(JSON.stringify(spec));
  });
}

// 固定数学导师指令：知识点讲解必须落在考研视角，而不是泛泛的教材结论。
const TUTOR_SYSTEM_PROMPT = [
  "你是大观园数学学习区的固定数学导师，服务对象是正在准备考研数学（数学一、数学二、数学三）的学生。请用中文回答，以教学和可追踪推理为目标。",
  "讲解知识点时必须站在考研视角：先说明它对应考研大纲的哪一部分、要求到什么层次（了解／理解／掌握），再说明它在历年真题里的常见考法与题型，以及在试卷上的呈现形式（选择题、填空题还是解答题，大致分值权重）。优先使用考研通用的解题路径和规范的书写格式，指出阅卷时的得分点与常见失分陷阱。如果题目涉及的内容不属于考研大纲要求，或属于超纲的拓展结论，必须明确说明，不要让用户误以为它属于必考范围。不要只讲教材上的一般性结论而忽略考研的考查方式。",
  "除非用户特别要求，否则不要一开始直接给出最终答案；先建立总体解题路线，再逐步推导。每一步都要说明本步目标、使用的知识点、知识点的具体内容、触发该知识点的题干信息、推导过程、本步结果，以及该步在总体思路中的位置。",
  "必须区分题干直接信息、前一步推出的信息和官方解析中的信息；不能把没有出现在题干或图像中的信息说成题目已知。",
  "保留并正确使用 Markdown 与 LaTeX。不要用 diag、dim 等英文缩写代替完整的数学表达式或数学对象；涉及矩阵、维数、对角化等内容时，请写出完整的公式、定义或推导，不要只写缩写。",
  "需要图形时，只能在末尾输出 daguan-diagram JSON 结构，不要输出或执行任意 Python 代码。不要声称已经完成无法验证的计算。",
].join("");

export function createAiService({ store, secretBackend } = {}) {
  const runs = new Map();
  const backend = createSecretBackend({ secretBackend });
  // Plaintext keys resolved in this process, keyed by profile id.
  const decrypted = new Map();
  // Profiles whose cipher we already failed to open (or that belong to another
  // cipher tag), so `profiles()` reports `unreadable` without re-spawning the
  // DPAPI bridge on every call.
  const unreadable = new Map();
  let writeQueue = Promise.resolve();

  // Serializes every read-modify-write of ai-profiles.json so concurrent
  // upsert/remove/migrate calls cannot lose each other's updates.
  function withLock(task) {
    const previous = writeQueue;
    let release;
    writeQueue = new Promise((resolve) => { release = resolve; });
    return (async () => {
      await previous;
      try { return await task(); } finally { release(); }
    })();
  }

  // Error surfaces must never echo third-party text: a custom backend's
  // `message` (or a child process's output) could carry credential material and
  // would end up in an HTTP response or in a status report. Only a fixed
  // description plus a whitelisted code is ever reported.
  const ERROR_TEXT = {
    SECRET_ENCRYPT_FAILED: "密钥加密失败",
    SECRET_DECRYPT_FAILED: "密钥无法解密",
    SECRET_BACKEND_UNAVAILABLE: "密钥存储后端不可用",
    DATA_CORRUPT: "本地档案文件损坏",
    DATA_READ_FAILED: "本地档案文件无法读取",
  };

  function errorCode(error, fallback = null) {
    const code = typeof error?.code === "string" ? error.code : "";
    // Object.hasOwn, not a plain lookup: a code such as "constructor",
    // "toString" or "__proto__" must not resolve to an inherited member.
    if (Object.hasOwn(ERROR_TEXT, code)) return code;
    return fallback && Object.hasOwn(ERROR_TEXT, fallback) ? fallback : null;
  }

  function describeError(error, fallback = null) {
    const code = errorCode(error, fallback);
    return code ? `${ERROR_TEXT[code]}（${code}）` : "未知错误（无错误码）";
  }

  function errorLabel(error, fallback = null) {
    const code = errorCode(error, fallback);
    return code || "SECRET_UNKNOWN";
  }

  // The original error is kept only as `cause` for local debugging; it is never
  // interpolated into the message that callers and HTTP clients can read.
  function secretError(action, cause, fallbackCode) {
    const code = errorCode(cause, fallbackCode);
    const label = code ? `${ERROR_TEXT[code]}（${code}）` : "未知错误（无错误码）";
    const error = new Error(`${action}：${label}`, cause ? { cause } : undefined);
    error.code = code || fallbackCode || "SECRET_UNKNOWN";
    return error;
  }

  function parseProfile(item) {
    const source = object(item);
    const profile = {
      id: String(source.id || randomUUID()),
      name: safeText(source.name || "新 AI 服务", 80).trim() || "新 AI 服务",
      baseUrl: safeText(source.baseUrl || "", 500).trim(),
      model: safeText(source.model || "", 160).trim(),
      streaming: source.streaming !== false,
      active: source.active === true,
      keyCipher: typeof source.keyCipher === "string" ? source.keyCipher : "",
      keyBaseUrl: typeof source.keyBaseUrl === "string" ? source.keyBaseUrl : "",
      keyHint: typeof source.keyHint === "string" ? source.keyHint : "",
      legacyKey: typeof source.key === "string" ? source.key : "",
      capabilities: normalizeCapabilities(source.capabilities),
      reasoningPresets: normalizeReasoningPresets(source.reasoningPresets, {}),
      defaultReasoningPresetId: "",
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
    // Stored presets go through the same strict validation as a write: an
    // explicitly invalid new field is a real error, never a silent drop or a
    // quietly cleared default. Old files without the field default to []/"".
    profile.defaultReasoningPresetId = normalizeDefaultReasoningPreset(source.defaultReasoningPresetId, {}, profile.reasoningPresets);
    return profile;
  }

  async function readDocument() {
    const raw = object(await store.readAiProfiles());
    const secret = object(raw.secret);
    return {
      fileBackend: secret.backend ? String(secret.backend) : null,
      profiles: (Array.isArray(raw.profiles) ? raw.profiles : []).map(parseProfile),
    };
  }

  async function readAll() { return (await readDocument()).profiles; }

  // Usability of the stored credential, computable without decrypting it.
  function statusOf(profile) {
    if (profile.keyCipher) {
      if (unreadable.has(profile.id)) return "unreadable";
      const tag = cipherTag(profile.keyCipher);
      if (backend.cipherTag && tag !== backend.cipherTag) return "unreadable";
      if (!profile.keyBaseUrl) return "unreadable";
      return "ok";
    }
    if (profile.legacyKey) return "unmigrated";
    return "none";
  }

  function view(profile) {
    return publicProfile({ ...profile, keyStatus: statusOf(profile) });
  }

  function serializeProfile(profile) {
    const stored = {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      streaming: profile.streaming !== false,
      active: profile.active === true,
      capabilities: profile.capabilities || { text: false, vision: "unknown" },
      reasoningPresets: Array.isArray(profile.reasoningPresets) ? profile.reasoningPresets : [],
      defaultReasoningPresetId: typeof profile.defaultReasoningPresetId === "string" ? profile.defaultReasoningPresetId : "",
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
    if (profile.keyCipher) {
      stored.keyCipher = profile.keyCipher;
      stored.keyBaseUrl = profile.keyBaseUrl;
      stored.keyHint = profile.keyHint;
    } else if (profile.legacyKey) {
      // Only kept while encryption is impossible: an unrelated edit must never
      // destroy a secret migration has not handled yet. It is never used for
      // requests (status `unmigrated`).
      stored.key = profile.legacyKey;
    }
    return stored;
  }

  async function saveAll(profiles) {
    await store.writeAiProfiles({
      version: PROFILE_VERSION,
      secret: { format: SECRET_FORMAT, backend: backend.id },
      profiles: profiles.slice(0, MAX_PROFILES).map(serializeProfile),
    });
  }

  // A cipher may only be written when the backend can both encrypt and keep the
  // key material across restarts. Single source of truth for upsert and migrate.
  function canPersistCipher() {
    return backend.persistent === true && backend.encrypted === true;
  }

  async function protectKey(value) {
    try {
      return await backend.protect(value);
    } catch (cause) {
      throw secretError("无法加密保存 Key，密钥未写入。请检查当前环境的密钥存储后端", cause, "SECRET_ENCRYPT_FAILED");
    }
  }

  async function decryptKey(profile) {
    const cached = decrypted.get(profile.id);
    if (cached && cached.cipher === profile.keyCipher) return cached.value;
    try {
      const value = await backend.unprotect(profile.keyCipher);
      decrypted.set(profile.id, { cipher: profile.keyCipher, value });
      unreadable.delete(profile.id);
      return value;
    } catch (cause) {
      unreadable.set(profile.id, errorCode(cause, "SECRET_DECRYPT_FAILED") || "SECRET_DECRYPT_FAILED");
      throw secretError("无法读取已保存的 Key，密文已保留。请重新填写 Key", cause, "SECRET_DECRYPT_FAILED");
    }
  }

  // Fail-closed gate for every outbound request that could carry a credential.
  function requireUsableSecret(profile, baseUrl) {
    const status = statusOf(profile);
    if (status === "none") return false;
    if (status === "unmigrated") throw new Error("该 AI 服务的 Key 尚未完成加密迁移，已停止使用旧明文凭据。请重新填写 Key。");
    if (status === "unreadable") throw new Error("该 AI 服务的 Key 密文无法在本机读取（可能来自其他存储后端、其他 Windows 账户或其他机器）。密文已保留，请重新填写 Key。");
    if (!sameBaseUrl(profile.keyBaseUrl, baseUrl)) throw new Error("AI API 地址已变更，已停止把已保存的 Key 发送到新地址。请重新填写 Key，或清除 Key 后使用无需 Key 的服务。");
    return true;
  }

  async function getProfile(id, { requireModel = true } = {}) {
    const profile = (await readAll()).find((item) => item.id === String(id));
    if (!profile) throw new Error("AI 服务档案不存在");
    if (!profile.baseUrl) throw new Error("请先填写 AI API 地址");
    if (requireModel && !profile.model) throw new Error("请先选择或填写 AI 模型");
    const baseUrl = await validateBaseUrl(profile.baseUrl);
    const bound = requireUsableSecret(profile, baseUrl);
    const key = bound ? await decryptKey(profile) : "";
    return { ...profile, baseUrl, key };
  }

  async function profiles() { return (await readAll()).map(view); }

  async function upsert(input) {
    return withLock(async () => {
      const all = await readAll();
      const request = object(input);
      const existing = request.id ? all.find((item) => item.id === String(request.id)) : null;
      if (request.id && !existing) throw new Error("AI 服务档案不存在，请重新选择");
      if (!existing && all.length >= MAX_PROFILES) throw new Error(`最多保存 ${MAX_PROFILES} 个 AI 服务，请先删除不用的服务`);
      const next = normalizeProfile(request, existing || {});
      next.baseUrl = await validateBaseUrl(next.baseUrl);
      const nextBaseUrl = canonicalBaseUrl(next.baseUrl);
      const providedKey = typeof request.key === "string" ? request.key.trim() : "";

      let keyCipher = existing?.keyCipher || "";
      let keyBaseUrl = existing?.keyBaseUrl || "";
      let keyHint = existing?.keyHint || "";
      let legacyKey = existing?.legacyKey || "";
      let keyCleared = false;
      let warning = null;

      if (request.clearKey === true) {
        keyCleared = Boolean(keyCipher || legacyKey);
        keyCipher = ""; keyBaseUrl = ""; keyHint = ""; legacyKey = "";
      } else if (providedKey) {
        // A Key may only be stored as a cipher that will still be readable later.
        // With a non-persistent (or non-encrypting) backend there is no such
        // cipher, so this fails closed instead of writing one that a restart
        // would turn into an unreadable blob.
        if (!canPersistCipher()) {
          // Fail closed with fixed text: no user or third-party data is echoed.
          const error = new Error("当前密钥存储后端不持久化或未加密，拒绝把 Key 写入档案（SECRET_BACKEND_UNAVAILABLE）。档案未被修改，Key 需要可持久加密的后端才能保存。");
          error.code = "SECRET_BACKEND_UNAVAILABLE";
          throw error;
        }
        keyCipher = await protectKey(providedKey);
        keyBaseUrl = nextBaseUrl;
        keyHint = maskKeyHint(providedKey);
        legacyKey = "";
      } else if (keyCipher) {
        // No new Key supplied: it may only be reused for the very same address,
        // so a changed baseUrl can never forward the stored credential.
        if (!keyBaseUrl || keyBaseUrl !== nextBaseUrl) {
          keyCipher = ""; keyBaseUrl = ""; keyHint = ""; keyCleared = true;
          warning = `AI API 地址已变更为 ${next.baseUrl}，旧 Key 已清除以避免发送到新地址。如新地址仍需该 Key，请重新填写。`;
        }
      } else if (legacyKey) {
        // Plaintext left behind by a failed migration. An unrelated edit must
        // never turn it into a cipher that a restart cannot read, so it is only
        // encrypted when the backend can actually persist one; otherwise the
        // plaintext is preserved verbatim (still never used for requests).
        if (existing?.baseUrl && canonicalBaseUrl(existing.baseUrl) === nextBaseUrl) {
          if (!canPersistCipher()) {
            warning = "旧明文 Key 已原样保留（当前密钥存储后端不持久化或未加密，不做迁移），它不会被用于请求。请重新填写 Key。";
          } else {
            try {
              keyCipher = await protectKey(legacyKey);
              keyBaseUrl = nextBaseUrl;
              keyHint = maskKeyHint(legacyKey);
              legacyKey = "";
            } catch (cause) {
              warning = `旧明文 Key 仍未完成加密（${describeError(cause, "SECRET_ENCRYPT_FAILED")}），已原样保留但不会用于请求。请重新填写 Key。`;
            }
          }
        } else {
          legacyKey = "";
          keyCleared = true;
          warning = `AI API 地址已变更为 ${next.baseUrl}，未完成迁移的旧明文 Key 已清除以避免发送到新地址。请重新填写 Key。`;
        }
      }

      const stored = { ...next, keyCipher, keyBaseUrl, keyHint, legacyKey };
      if (!stored.active && !all.length) stored.active = true;
      if (stored.active) all.forEach((item) => { item.active = false; });
      const index = all.findIndex((item) => item.id === stored.id);
      if (index >= 0) all[index] = stored; else all.push(stored);
      await saveAll(all);
      // Caches only follow an actual cipher change: an unrelated edit (rename,
      // model change) must not make an unreadable secret look healthy again.
      if ((existing?.keyCipher || "") !== keyCipher || !keyCipher) {
        decrypted.delete(stored.id);
        unreadable.delete(stored.id);
      }
      return { ...view(stored), keyCleared, warning };
    });
  }

  async function remove(id, clearHistory = false) {
    const profile = await withLock(async () => {
      const all = await readAll();
      const found = all.find((item) => item.id === String(id));
      if (!found) throw new Error("AI 服务档案不存在");
      await saveAll(all.filter((item) => item.id !== found.id));
      decrypted.delete(found.id);
      unreadable.delete(found.id);
      return found;
    });
    if (clearHistory) {
      const files = await store.aiHistoryFiles();
      const prefix = `${profileKey(profile.id)}--`;
      await Promise.all(files.filter((file) => file.startsWith(prefix)).map((file) => store.clearAiHistory(file.slice(0, -5))));
    }
    return { ok: true };
  }

  // Any edit of a profile goes through the same lock and re-reads the file, so
  // capability updates can not resurrect a deleted profile or drop a secret.
  async function patchProfile(id, patch) {
    return withLock(async () => {
      const all = await readAll();
      const index = all.findIndex((item) => item.id === String(id));
      if (index < 0) return null;
      const updated = { ...patch(all[index]), updatedAt: new Date().toISOString() };
      all[index] = updated;
      await saveAll(all);
      return view(updated);
    });
  }

  function statusSnapshot(profilesList, extra = {}) {
    const keyStates = { ok: 0, none: 0, unmigrated: 0, unreadable: 0 };
    for (const profile of profilesList) {
      const status = statusOf(profile);
      if (keyStates[status] != null) keyStates[status] += 1;
    }
    return {
      backend: { id: backend.id, cipherTag: backend.cipherTag, persistent: backend.persistent, encrypted: backend.encrypted, description: backend.description },
      keyStorage: backend.id,
      persistent: backend.persistent,
      encrypted: backend.encrypted,
      canPersistSecrets: backend.persistent === true && backend.encrypted === true,
      profileCount: profilesList.length,
      keyStates,
      profiles: profilesList.map(view),
      ...extra,
    };
  }

  async function storageStatus() {
    let profilesList = [];
    let lastError = null;
    let corrupt = false;
    let fileBackend = null;
    try {
      const document = await readDocument();
      profilesList = document.profiles;
      fileBackend = document.fileBackend;
    } catch (cause) {
      lastError = describeError(cause);
      corrupt = cause?.code === "DATA_CORRUPT";
    }
    let available = false;
    try { available = (await backend.available()) === true; } catch { available = false; }
    const warnings = [];
    if (!backend.persistent) warnings.push("当前密钥后端不持久化：服务重启后已保存的 Key 无法解密，需要重新填写（不会退回明文保存）。");
    if (backend.id === "memory") warnings.push("当前环境不支持保存 Key，只能使用无需 Key 的服务。");
    if (!canPersistCipher()) warnings.push("当前环境不支持保存 Key（缺少可持久加密的密钥后端），只能使用无需 Key 的服务。");
    if (fileBackend && fileBackend !== backend.id) warnings.push(`档案由「${fileBackend}」后端写入，当前运行在「${backend.id}」后端，其中的密文无法解密。`);
    if (corrupt) warnings.push("本地 AI 档案已损坏，未做任何改动，请检查文件或从备份恢复。");
    const snapshot = statusSnapshot(profilesList, { available, lastError, corrupt, fileBackend, warnings });
    snapshot.backend.available = available;
    // Declared capability is not enough: a backend that can not encrypt right
    // now can not persist secrets, so callers get a fail-closed answer.
    snapshot.canPersistSecrets = snapshot.persistent === true && snapshot.encrypted === true && available === true;
    return snapshot;
  }

  // One-shot migration of legacy plaintext Keys. Never throws, never rewrites a
  // corrupt file, and preserves the plaintext (rather than destroying it) if any
  // single Key can not be encrypted.
  async function migrate() {
    try {
      return await withLock(async () => {
        let document;
        try {
          document = await readDocument();
        } catch (cause) {
          const corrupt = cause?.code === "DATA_CORRUPT";
          return statusSnapshot([], {
            ok: false, corrupt, migrated: 0, preserved: 0, failed: 0, skipped: 0,
            lastError: describeError(cause),
            warnings: [corrupt ? "本地 AI 档案已损坏，已跳过迁移且未改动文件。" : "本地 AI 档案无法读取，已跳过迁移且未改动文件。"],
          });
        }
        let migrated = 0;
        let preserved = 0;
        let failed = 0;
        const warnings = [];
        const next = [];
        for (const profile of document.profiles) {
          if (profile.keyCipher || !profile.legacyKey) { next.push(profile); continue; }
          if (!canPersistCipher()) {
            // A non-persistent backend would produce ciphertext that is
            // unreadable after restart, so the plaintext Key is preserved
            // instead of being replaced by an unrecoverable blob.
            preserved += 1;
            next.push(profile);
            continue;
          }
          try {
            const cipher = await protectKey(profile.legacyKey);
            next.push({
              ...profile,
              keyCipher: cipher,
              keyBaseUrl: canonicalBaseUrl(profile.baseUrl),
              keyHint: maskKeyHint(profile.legacyKey),
              legacyKey: "",
            });
            migrated += 1;
          } catch (cause) {
            failed += 1;
            warnings.push(`档案「${profile.name}」的 Key 加密失败（${errorLabel(cause, "SECRET_ENCRYPT_FAILED")}）`);
            next.push(profile);
          }
        }
        if (preserved > 0) warnings.push(`当前密钥后端不持久化，${preserved} 个旧明文 Key 未被覆盖迁移（保留原状）。`);
        if (failed > 0) {
          // Do not write at all: a partial rewrite could destroy un-migrated Keys.
          return statusSnapshot(document.profiles, {
            ok: false, corrupt: false, migrated, preserved, failed, skipped: 0,
            lastError: warnings[0] || null,
            warnings: [...warnings, "迁移未完成，已保留原文件内容，下次启动会重试。"],
          });
        }
        if (migrated > 0) {
          await saveAll(next);
          for (const profile of next) decrypted.delete(profile.id);
        }
        return statusSnapshot(next, { ok: true, corrupt: false, migrated, preserved, failed: 0, skipped: 0, lastError: null, warnings });
      });
    } catch (cause) {
      return statusSnapshot([], {
        ok: false, corrupt: cause?.code === "DATA_CORRUPT", migrated: 0, preserved: 0, failed: 0, skipped: 0,
        lastError: describeError(cause),
        warnings: ["密钥迁移未能完成，已保留原文件内容。"],
      });
    }
  }

  async function models(id) {
    const profile = await getProfile(id, { requireModel: false });
    const started = Date.now();
    const response = await fetchWithTimeout(endpoint(profile.baseUrl, "models"), { headers: authHeaders(profile) });
    const text = await response.text();
    if (!response.ok) throw upstreamError("模型列表失败", response.status);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error("模型列表返回的不是 JSON"); }
    return { models: parseModels(parsed), status: response.status, latencyMs: Date.now() - started };
  }

  async function test(id, kind = "text") {
    const profile = await getProfile(id);
    const started = Date.now();
    let content;
    const user = kind === "vision"
      ? [{ type: "text", text: "请只回复：视觉测试通过" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/5nR5WQAAAABJRU5ErkJggg==" } }]
      : "请只回复：文本测试通过";
    // Probe with the profile's default reasoning preset so the test matches the
    // chat configuration. No provider-specific adaptation or live model probing.
    const preset = resolveReasoningPreset({ reasoningPresetId: undefined }, profile);
    const response = await fetchWithTimeout(endpoint(profile.baseUrl, "chat/completions"), {
      method: "POST",
      headers: authHeaders(profile),
      body: JSON.stringify(buildChatBody({ model: profile.model, messages: [{ role: "user", content: user }], stream: false, preset, temperature: 0 })),
    });
    const text = await response.text();
    if (!response.ok) throw upstreamError("模型测试失败", response.status);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error("模型测试返回的不是 JSON"); }
    content = parseChatContent(parsed);
    if (!content.trim()) throw new Error("模型测试未返回正式答案，请检查模型或重试");
    const updated = await patchProfile(profile.id, (item) => ({
      ...item,
      capabilities: { ...(item.capabilities || {}), text: true, ...(kind === "vision" ? { vision: "passed", visionTestedAt: new Date().toISOString() } : {}) },
    }));
    if (!updated) throw new Error("AI 服务档案不存在");
    return { ok: true, kind, status: response.status, latencyMs: Date.now() - started, model: profile.model, response: content.slice(0, 2000), usage: parsed.usage || null };
  }

  function contextText(question, includePrivate = false) {
    const q = object(question);
    const lines = [
      `题号：${safeText(q.id, 40)}`,
      `知识路径：${safeText(q.category_path, 1000)}`,
      `来源：${safeText(q.source, 500)}`,
      `题型：${safeText(q.type, 100)}`,
      `题干：\n${safeText(q.stem)}`,
      `选项：\n${(Array.isArray(q.options) ? q.options : []).map((item) => `${safeText(item.label, 10)}. ${safeText(item.content_md)}`).join("\n") || "无"}`,
      `用户作答：${safeText(q.userAnswer || "未作答", 2000)}`,
      `标准答案：\n${safeText(q.answer)}`,
      `官方解析：\n${safeText(q.explanation)}`,
    ];
    if (includePrivate) lines.push(`本地批注：\n${safeText(q.annotation, 20_000)}`, `掌握：${safeText(q.mastery, 80)}`, `易错：${q.errorProne === true ? "是" : "否"}`, `收藏：${q.favorite === true ? "是" : "否"}`);
    return lines.join("\n\n");
  }

  async function streamChat(req, res, payload) {
    // A response that can no longer be written to must not register a run:
    // otherwise every such call would leak one of the two run slots.
    if (res.writableEnded || res.destroyed) return;
    if (runs.size >= 2) throw new Error("当前已有两个 AI 任务在生成，请稍后再试");
    const profile = await getProfile(payload.profileId);
    // No server-side session: multi-turn context is whatever the client passes
    // in `payload.history`, validated and bounded. Nothing is written to disk.
    const historyMessages = normalizeChatHistory(payload.history);
    const preset = resolveReasoningPreset(payload, profile);
    const prompt = safeText(payload.prompt || "请讲解这道题。", 20_000);
    const userMessage = `${contextText(payload.question, payload.includePrivate === true)}\n\n本次请求：${prompt}`;
    const messages = [
      { role: "system", content: TUTOR_SYSTEM_PROMPT },
      ...historyMessages.map((item) => ({ role: item.role, content: item.content })),
      { role: "user", content: userMessage },
    ];
    const images = normalizeImages(payload.images, profile.capabilities);
    if (images.length) {
      messages[messages.length - 1].content = [{ type: "text", text: userMessage }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
    }
    const runId = randomUUID();
    const controller = new AbortController();
    runs.set(runId, { controller });
    const timeout = setTimeout(() => controller.abort(new Error("AI 请求超时")), REQUEST_TIMEOUT_MS);
    const abortOnClose = () => controller.abort(new Error("浏览器已断开 AI 请求"));
    res.once("close", abortOnClose);
    let answer = "";
    try {
      // Every write after the run is registered stays inside this try, so any
      // failure here still reaches the finally that releases the run.
      if (!res.headersSent) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Daguan-Run-Id": runId });
      }
      writeSse(res, { type: "started", runId, historyTruncated: historyMessages.length >= 24 });
      const upstream = await fetch(endpoint(profile.baseUrl, "chat/completions"), {
        method: "POST",
        headers: { ...authHeaders(profile), Accept: "text/event-stream, application/json" },
        body: JSON.stringify(buildChatBody({ model: profile.model, messages, stream: profile.streaming !== false, preset })),
        signal: controller.signal,
        redirect: "error",
      });
      if (!upstream.ok) throw upstreamError("AI 请求失败", upstream.status);
      const contentType = upstream.headers.get("content-type") || "";
      if (!upstream.body) throw new Error("AI 服务没有返回内容");
      if (contentType.includes("text/event-stream")) {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        const filter = createAnswerFilter();
        let buffer = "";
        const emit = content => {
          if (!content) return;
          answer += content;
          if (profile.streaming !== false) writeSse(res, { type: "delta", content });
        };
        const consume = row => {
          if (!row.startsWith("data:")) return;
          const data = row.slice(5).trim();
          if (!data || data === "[DONE]") return;
          let parsed;
          try { parsed = JSON.parse(data); } catch { return; }
          if (parsed.error) throw new Error("AI 服务返回生成错误");
          emit(filter.push(safeText(object(object(parsed.choices?.[0]).delta).content)));
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const rows = buffer.split(/\r?\n/);
          buffer = rows.pop() || "";
          for (const row of rows) consume(row);
        }
        consume(buffer + decoder.decode());
        emit(filter.push("", true));
        if (profile.streaming === false && answer) writeSse(res, { type: "delta", content: answer });
      } else {
        let parsed;
        try { parsed = JSON.parse(await upstream.text()); } catch { throw new Error("AI 返回的不是 JSON"); }
        if (parsed.error) throw new Error("AI 服务返回生成错误");
        answer = parseChatContent(parsed);
        if (answer) writeSse(res, { type: "delta", content: answer });
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!answer.trim()) throw new Error("AI 服务未返回正式答案，请检查模型或重试");
      // No persistence: the successful answer is only streamed back, never saved.
      writeSse(res, { type: "done", runId, message: { role: "assistant", content: answer } });
    } catch (error) {
      writeSse(res, { type: "error", runId, error: error?.name === "AbortError" ? "AI 请求已停止" : safeText(error?.message || error, 500) });
    } finally {
      clearTimeout(timeout);
      res.off("close", abortOnClose);
      runs.delete(runId);
      // Cleanup must never throw: a failure here would skip the run release.
      if (!res.writableEnded && !res.destroyed) {
        try { res.end(); } catch { /* client already gone */ }
      }
    }
  }

  // One-shot answers with no persistent session: the conversation endpoint keeps
  // its original shape but never reloads old on-disk history. Any legacy file
  // left on disk is only removed via clearConversation (below).
  async function conversation(profileId, questionId) {
    return { messages: [], ephemeral: true };
  }

  async function clearConversation(profileId, questionId) {
    const key = `${profileKey(profileId)}--${profileKey(questionId)}`;
    await store.clearAiHistory(key);
    return { ok: true };
  }

  async function diagram(spec) {
    const input = object(spec);
    if (input.engine === "python") {
      try { return { engine: "python", svg: sanitizeSvgMarkup(await pythonSvg(input)) }; }
      catch { /* optional enhancement: use the safe SVG fallback below */ }
    }
    return { engine: "svg", svg: safeSvg(input) };
  }

  return {
    secretStorage: { id: backend.id, persistent: backend.persistent, encrypted: backend.encrypted, description: backend.description },
    migrate, storageStatus, profiles, upsert, remove, models, test, streamChat, conversation, clearConversation, diagram, stop: (runId) => { const run = runs.get(String(runId)); if (!run) return false; run.controller.abort(new Error("用户停止了 AI 请求")); return true; },
  };
}
