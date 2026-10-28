import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createStore } from "./store.mjs";
import { CxyonlyClient } from "./cxyonly-client.mjs";
import { refreshCatalog } from "./catalog.mjs";
import { applyLocalChanges, buildPullMerge, buildReconcilePlan, localToAndroidDocument, mergeMigratedState, normalizeLocalState, nowIso, remoteStatesDocument } from "./sync-format.mjs";
import { createAiService } from "./ai-service.mjs";
import { acquireServiceInstance, serviceOwnerUrl, SERVICE_API_PROTOCOL, waitForServiceOwner } from "./instance-lock.mjs";
import { createQuestionBankUpdater } from "./question-bank-updater.mjs";
import { createVisitHistory } from "./visit-history.mjs";
import { createStudyActivity } from "./study-activity.mjs";

const ROOT = path.resolve(process.env.DAGUAN_ROOT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const WEB_ROOT = path.resolve(process.env.DAGUAN_WEB_ROOT || path.join(ROOT, "web"));
const PORT = Number(process.env.PORT || 8247);
const HOST = "127.0.0.1";
const DEFAULT_PAGE = process.env.DAGUAN_DEFAULT_PAGE === "/index.html" ? "/index.html" : "/landing.html";
const BUILD_VERSION = "2026.09.27-shared-service-r1";
const MAX_BODY = 10 * 1024 * 1024;
const PREVIEW_KEY = String(process.env.DAGUAN_PREVIEW_KEY || "");
const PREVIEW_MODE = process.env.DAGUAN_PREVIEW_MODE === "1" || Boolean(PREVIEW_KEY);
const PREVIEW_COOKIE = "daguan_preview_access";
const PREVIEW_TTL_SECONDS = 60 * 60 * 24 * 365;

const store = createStore(ROOT, process.env.DAGUAN_DATA_DIR);
const visitHistory = createVisitHistory(store.dataDir, () => store.readState());
const studyActivity = createStudyActivity(store.dataDir, () => store.readState());
const client = new CxyonlyClient({
  store,
  baseUrl: process.env.DAGUAN_BASE_URL || "https://www.cxyonly.fans",
});
const previews = new Map();
const catalogTasks = new Map();
let knownIdsPromise;
let syncLock = Promise.resolve();
const ai = createAiService({ store });
let serviceInstance = null;
const stateEventClients = new Set();
let requestGracefulShutdown = null;
let questionBank = null;

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function errorJson(res, error, status = 500) {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) { res.end(); return; }
  const code = error?.code === "AUTH_EXPIRED" ? 401 : Number(error?.status) || status;
  json(res, code, { ok: false, code: error?.code || null, error: String(error?.message || error), current: error?.current || undefined });
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return [part, ""];
    try { return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]; }
    catch { return [part.slice(0, index), ""]; }
  }));
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function previewToken(timestamp) {
  return createHmac("sha256", PREVIEW_KEY).update(String(timestamp)).digest("base64url");
}

function setPreviewCookie(res, timestamp = Date.now()) {
  res.setHeader("Set-Cookie", `${PREVIEW_COOKIE}=${timestamp}.${previewToken(timestamp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${PREVIEW_TTL_SECONDS}`);
}

function hasPreviewAccess(req) {
  if (!PREVIEW_MODE) return true;
  if (!PREVIEW_KEY) return false;
  const raw = cookies(req)[PREVIEW_COOKIE] || "";
  const [timestamp, signature] = raw.split(".");
  const issuedAt = Number(timestamp);
  if (!Number.isInteger(issuedAt) || !signature || Date.now() - issuedAt > PREVIEW_TTL_SECONDS * 1000 || issuedAt > Date.now() + 60_000) return false;
  return safeEqualText(signature, previewToken(issuedAt));
}

function privateApiPath(pathname) {
  return pathname === "/api/state" || pathname.startsWith("/api/state/") || pathname.startsWith("/api/visit-history") || pathname.startsWith("/api/study-activity") || pathname.startsWith("/api/ai/") || pathname.startsWith("/api/integrations/cxyonly/");
}

function requirePreviewAccess(req, res) {
  if (!PREVIEW_MODE || hasPreviewAccess(req)) return true;
  json(res, 403, { ok: false, code: "PREVIEW_LOCKED", error: "预览模式下的个人功能需要输入预览密钥" });
  return false;
}

// 远程网关（desktop/remote-gateway.cjs）在转发请求时打上该标记；本机页面、Electron/Node
// 代理和浏览器版都不会携带它。标记只用于收紧，客户端伪造它不会获得任何额外权限。
const REMOTE_SESSION_HEADER = "x-daguan-remote";
const LOOPBACK_HOST_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isRemoteSession(req) {
  return String(req.headers[REMOTE_SESSION_HEADER] || "") === "1";
}

function splitHost(value) {
  const host = String(value || "").toLowerCase();
  if (!host) return { name: null, port: null };
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return { name: null, port: null };
    return { name: host.slice(0, end + 1), port: host[end + 1] === ":" ? Number(host.slice(end + 2)) : null };
  }
  const index = host.indexOf(":");
  return { name: index > 0 ? host.slice(0, index) : host, port: index > 0 ? Number(host.slice(index + 1)) : null };
}

// 本地 AI 边界：请求必须经本机回环地址进入，挡住 DNS 重绑定等把外部域名指向 127.0.0.1 的攻击。
function loopbackHostOk(req) {
  const { name, port } = splitHost(req.headers.host);
  return LOOPBACK_HOST_NAMES.has(name) && (port == null || port === PORT);
}

// 同源 Origin 检查挡住跨站网页；不带 Origin 的本机 Node/Electron 代理保持兼容，
// 但同操作系统内的恶意进程仍可伪造请求，这一边界不声称已认证阻断。
// Origin 必须是“纯源”：不带用户凭据、路径、查询或片段；端口缺省时按 http 默认
// 端口 80 计算，因此用户把服务覆盖为 80 时无显式端口的同源 Origin 仍然合法，
// 而默认 8247 下无端口 Origin 会被正确拒绝。
function sameOriginOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const name = url.hostname.toLowerCase();
    if (url.protocol !== "http:" || !LOOPBACK_HOST_NAMES.has(name)) return false;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
    return Number(url.port || 80) === PORT;
  } catch { return false; }
}

function jsonWriteOk(req) {
  return String(req.headers["content-type"] || "").toLowerCase().split(";")[0].trim() === "application/json";
}

// /api/ai/* 统一边界：回环 Host + 同源 Origin + application/json 写入。
// 返回 true 表示已拒绝并已写出响应，调用方必须立即 return，
// 否则拒绝之后路由仍会继续执行，造成“客户端看到 403、副作用却已发生”。
function aiLocalBoundary(req, res) {
  if (!loopbackHostOk(req)) { json(res, 403, { ok: false, code: "HOST_REJECTED", error: "AI 接口只允许通过本机地址访问" }); return true; }
  if (!sameOriginOk(req)) { json(res, 403, { ok: false, code: "ORIGIN_REJECTED", error: "AI 接口只允许来自本机页面的同源请求" }); return true; }
  const method = String(req.method || "GET").toUpperCase();
  if (["POST", "PATCH", "PUT"].includes(method) && !jsonWriteOk(req)) {
    json(res, 415, { ok: false, code: "JSON_REQUIRED", error: "AI 写入请求必须使用 application/json" });
    return true;
  }
  return false;
}

// 远程会话只读 AI 服务配置；掩码列表（GET/HEAD）保留，供远程界面选择服务继续问答。
function aiConfigWrite(pathname, method) {
  const value = String(method || "GET").toUpperCase();
  if (pathname === "/api/ai/profiles") return value !== "GET" && value !== "HEAD";
  return pathname.startsWith("/api/ai/profiles/");
}

// 存储事实（后端 id、是否加密/持久/可用）在进程生命周期内不会变化，成功读取后永久缓存；
// 读取失败只按短 TTL 缓存，避免把一次瞬时失败固化成“永远未加密”的误报，也不反复读盘。
const AI_STORAGE_FACTS_RETRY_MS = 5000;
let aiStorageFacts = null;
async function aiStorageFactsCached() {
  if (aiStorageFacts && !(aiStorageFacts.failed && Date.now() - aiStorageFacts.at >= AI_STORAGE_FACTS_RETRY_MS)) return aiStorageFacts;
  const facts = { at: Date.now(), failed: false, backend: "none", available: false, encrypted: false, persistent: true, canPersistSecrets: false };
  try {
    if (typeof ai.storageStatus === "function") {
      const status = await ai.storageStatus();
      facts.backend = String(status?.backend?.id || status?.keyStorage || "none");
      facts.available = status?.available === true;
      facts.encrypted = status?.encrypted === true;
      facts.persistent = status?.persistent === true;
      facts.canPersistSecrets = status?.canPersistSecrets === true;
    }
  } catch { facts.failed = true; /* 读取失败不影响学习功能，按未加密处理并按短 TTL 重试 */ }
  aiStorageFacts = facts;
  return facts;
}

async function aiConfigStatus(req) {
  const writable = !isRemoteSession(req);
  const facts = await aiStorageFactsCached();
  return { writable, readOnlyReason: writable ? null : "remote", backend: facts.backend, available: facts.available, encrypted: facts.encrypted, persistent: facts.persistent, canPersistSecrets: facts.canPersistSecrets };
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("JSON 格式错误"); }
}

async function knownIds() {
  if (!knownIdsPromise) {
    knownIdsPromise = fs.readFile(path.join(questionBank?.dataRoot() || path.join(WEB_ROOT, "data"), "id_index.json"), "utf8")
      .then((text) => new Set(Object.keys(JSON.parse(text)).map(String)))
      .catch(() => null);
  }
  return knownIdsPromise;
}

async function withLock(task) {
  const previous = syncLock;
  let release;
  syncLock = new Promise((resolve) => { release = resolve; });
  await previous;
  try { return await task(); } finally { release(); }
}

// revision 只接受真正的非负整数：null、空串、布尔等不得被 Number() 折成 0 而误判为合法版本。
function readRevision(value) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function requestRevision(req, incoming) {
  return readRevision(req.headers["if-match"] != null ? req.headers["if-match"] : incoming?.revision);
}

// 学习数据写入的清除代次守卫：必须在真正写入的同一个 withLock 内调用，禁止锁外校验后写入。
// 缺字段的兼容仅限当前安装代次为 0；strict 用于正式清除，要求显式给出与当前一致的代次。
function progressResetRequired(current) {
  const error = new Error("本机的做题记录已被清除，本页进度已过期。请刷新页面（或切回最新版界面）后再继续学习。");
  error.code = "PROGRESS_RESET_REQUIRED";
  error.status = 428;
  error.current = current;
  return error;
}

function requireProgressGeneration(incoming, current, strict = false) {
  const raw = incoming?.reset_generation;
  const missing = raw === undefined || raw === null;
  if (missing && strict) throw progressResetRequired(current);
  const incomingGeneration = missing ? 0 : raw;
  if (!Number.isInteger(incomingGeneration) || incomingGeneration < 0 || incomingGeneration !== current.reset_generation) {
    throw progressResetRequired(current);
  }
}

function broadcastState(saved) {
  const event = `event: state\ndata: ${JSON.stringify({ revision: saved.revision, updated_at: saved.updated_at })}\n\n`;
  for (const response of stateEventClients) {
    try { response.write(event); } catch { stateEventClients.delete(response); }
  }
}

async function writeState(value, options) {
  const saved = await store.writeState(value, options);
  if (options?.studyImport) await studyActivity.observeImport(saved);
  broadcastState(saved);
  return saved;
}

function broadcastStudyActivity() {
  for (const response of stateEventClients) {
    try { response.write('event: study-activity\ndata: {}\n\n'); } catch { stateEventClients.delete(response); }
  }
}

function broadcastHistory() {
  for (const response of stateEventClients) {
    try { response.write("event: visit-history\ndata: {}\n\n"); } catch { stateEventClients.delete(response); }
  }
}

function openBrowser(url) {
  if (process.platform !== "win32" || process.env.DAGUAN_OPEN_BROWSER !== "1") return;
  const command = process.env.ComSpec || "cmd.exe";
  // URL 整体双引号包裹并以 windowsVerbatimArguments 透传，避免 cmd 把 & 当命令分隔符丢掉 browserPackage 等参数。
  spawn(command, ["/c", "start", '""', `"${url}"`], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
}

function localStateShape(value) {
  return normalizeLocalState(value);
}

async function catalogInfo() {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(questionBank?.dataRoot() || path.join(WEB_ROOT, "data"), "manifest.json"), "utf8"));
    return { version: manifest.version || manifest.generated_at || manifest.updated_at || null, total: Number(manifest.total || manifest.question_count || 0) || null };
  } catch { return { version: null, total: null }; }
}

function startCatalogRefresh() {
  const taskId = randomUUID();
  const task = { taskId, status: "running", progress: { completed: 0, total: 0 }, startedAt: nowIso(), error: null };
  catalogTasks.set(taskId, task);
  refreshCatalog(ROOT, (progress) => { task.progress = progress; })
    .then((result) => { Object.assign(task, { status: "completed", result, finishedAt: nowIso() }); knownIdsPromise = null; })
    .catch((error) => { Object.assign(task, { status: "failed", error: error.message, finishedAt: nowIso() }); });
  return task;
}

async function saveRemoteProgress(states, extra = {}) {
  await store.writeProgress({
    format: "daguan-cxyonly-progress",
    version: 1,
    exported_at: nowIso(),
    states: remoteStatesDocument(states).question_states.states,
    ...extra,
  });
}

async function pullPreview() {
  const local = await store.readState();
  const remote = await client.pullDocument();
  const merged = buildPullMerge(local, remote.states, await knownIds());
  const previewId = randomUUID();
  previews.set(previewId, { type: "pull", createdAt: Date.now(), remote, merged });
  return { previewId, summary: { entries: remote.states.length, changes: merged.changes.length, unknown: merged.unknownIds.length, unknownIds: merged.unknownIds }, document: remote.document };
}

async function applyPull(previewId, auto = false) {
  const preview = previews.get(previewId);
  if (!preview || Date.now() - preview.createdAt > 30 * 60 * 1000) throw new Error("读取预览已过期，请重新读取");
  const result = preview.merged;
  await writeState(localStateShape(result.state), { studyImport: true });
  await saveRemoteProgress(preview.remote.states, { last_pull_at: nowIso() });
  const integration = await store.readIntegration();
  if (integration) await store.writeIntegration({ ...integration, last_pull_at: nowIso(), updated_at: nowIso() });
  await store.appendHistory({ action: "pull", applied: result.changes.length, unknown: result.unknownIds.length, automatic: auto });
  previews.delete(previewId);
  return { applied: result.changes.length, unknown: result.unknownIds.length, unknownIds: result.unknownIds };
}

async function pushPreview() {
  const local = await store.readState();
  const plan = await client.pushPreview(local, await knownIds());
  const previewId = randomUUID();
  previews.set(previewId, { type: "push", createdAt: Date.now(), plan });
  return { previewId, summary: plan.summary };
}

async function applyPush(previewId) {
  const preview = previews.get(previewId);
  if (!preview || preview.type !== "push" || Date.now() - preview.createdAt > 30 * 60 * 1000) throw new Error("上传预览已过期，请重新预览");
  const current = await client.pullDocument();
  await store.writeBackup("daguan-site-progress", current.document);
  const plan = await client.pushPreview(await store.readState(), await knownIds());
  let succeeded = 0;
  const failures = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < plan.operations.length) {
      const operation = plan.operations[cursor++];
      try { await client.patchState(operation); succeeded += 1; }
      catch (error) { failures.push({ question_id: operation.questionId, error: error.message }); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const integration = await store.readIntegration();
  if (integration) await store.writeIntegration({ ...integration, last_push_at: nowIso(), updated_at: nowIso() });
  await store.appendHistory({ action: "push", succeeded, failed: failures.length, failures: failures.slice(0, 20) });
  previews.delete(previewId);
  return { succeeded, failed: failures.length, failures: failures.slice(0, 20), summary: plan.summary };
}

async function reconcilePreview(options = {}) {
  const local = await store.readState();
  const remote = await client.fetchRemoteSnapshot();
  await store.writeBackup("local-state-before-reconcile-preview", local);
  await store.writeBackup("cxyonly-before-reconcile-preview", remote.document);
  const firstRepair = !local.remote_seeded_at;
  const requestedWinner = ["latest", "remote", "local"].includes(options.winner) ? options.winner : "latest";
  const winner = firstRepair ? "remote" : requestedWinner;
  const plan = buildReconcilePlan(local, remote.states, await knownIds(), {
    remoteAuthoritative: firstRepair || winner === "remote",
    ...(winner !== "latest" && !firstRepair ? { forceWinner: winner } : {}),
  });
  const previewId = randomUUID();
  const createdAt = Date.now();
  const expiresAt = new Date(createdAt + 30 * 60 * 1000).toISOString();
  const value = {
    type: "reconcile",
    createdAt,
    expiresAt,
    revision: local.revision,
    remote,
    plan,
    firstRepair,
    winner,
    catalog: await catalogInfo(),
  };
  previews.set(previewId, value);
  return {
    ok: true,
    previewId,
    expiresAt,
    revision: local.revision,
    firstRepair,
    winner,
    summary: plan.summary,
    localChanges: plan.localChanges,
    remoteOperations: plan.remoteOperations,
    conflicts: plan.conflicts,
    unknownIds: plan.unknownIds,
    remoteActivity: remote.activity,
    remoteLastStudy: remote.lastStudy,
    activityImpact: { remoteActivityDays: remote.activity && typeof remote.activity === "object" ? Object.keys(remote.activity).length : null, possibleTodayWrites: plan.remoteOperations.length },
    catalog: value.catalog,
    backup: { willBackupLocal: true, willBackupRemote: true },
  };
}

async function applyReconcile(previewId, bodyValue = {}) {
  const preview = previews.get(previewId);
  if (!preview || preview.type !== "reconcile" || Date.now() > Date.parse(preview.expiresAt)) throw new Error("同步预览已过期，请重新检查");
  return withLock(async () => {
    const current = await store.readState();
    if (current.revision !== preview.revision) {
      const error = new Error("本地状态在预览后发生变化，请重新检查差异");
      error.code = "STATE_CONFLICT";
      error.status = 409;
      error.current = current;
      throw error;
    }
    await store.writeBackup("local-state-before-reconcile", current);
    await store.writeBackup("cxyonly-before-reconcile", preview.remote.document);
    const requestedWinner = ["latest", "remote", "local"].includes(bodyValue.winner) ? bodyValue.winner : preview.winner;
    if (!preview.firstRepair && requestedWinner !== preview.winner) {
      const error = new Error("同步策略已改变，请重新检查同步内容");
      error.code = "PREVIEW_STRATEGY_CHANGED";
      error.status = 409;
      throw error;
    }
    const plan = preview.plan;
    let next = applyLocalChanges(current, plan.localChanges, {
      remoteActivity: preview.remote.activity,
      remoteLastStudy: preview.remote.lastStudy,
      remoteSeededAt: current.remote_seeded_at || nowIso(),
    });
    const failed = [];
    let succeeded = 0;
    let saved = await writeState(next, { expectedRevision: current.revision, studyImport: true });
    for (const operation of plan.remoteOperations) {
      try { await client.patchState(operation); succeeded += 1; }
      catch (error) { failed.push({ question_id: operation.questionId, error: error.message, payload: operation.payload }); }
    }
    const localStudyAt = Date.parse(current.last_study?.updated_at || current.last_study?.updatedAt || "") || 0;
    const remoteStudyAt = Date.parse(preview.remote.lastStudy?.updated_at || preview.remote.lastStudy?.updatedAt || "") || 0;
    if (current.last_study && localStudyAt > remoteStudyAt) {
      try { await client.saveLastStudy(current.last_study); }
      catch (error) { failed.push({ scope: "last_study", error: error.message }); }
    }
    next = { ...saved, pending_unknown_states: Object.fromEntries(plan.unknownIds.map((id) => [id, { source: "reconcile", updated_at: nowIso() }])) };
    if (failed.length || plan.unknownIds.length || saved.pending_remote_operations?.length) {
      if (failed.length) next.pending_remote_operations = failed;
      else delete next.pending_remote_operations;
      saved = await writeState(next, { expectedRevision: saved.revision, studyImport: true });
    } else {
      delete next.pending_remote_operations;
    }
    let verified = null;
    try {
      verified = await client.fetchRemoteSnapshot();
      await saveRemoteProgress(verified.states, { last_reconcile_at: nowIso(), activity: verified.activity, last_study: verified.lastStudy });
    } catch (error) {
      failed.push({ scope: "verification", error: error.message });
    }
    const integration = await store.readIntegration();
    if (integration) await store.writeIntegration({ ...integration, last_reconcile_at: nowIso(), updated_at: nowIso() });
    await store.appendHistory({ action: "reconcile", first_repair: preview.firstRepair, local_applied: plan.localChanges.length, remote_succeeded: succeeded, remote_failed: failed.length, unknown: plan.unknownIds.length, failures: failed.slice(0, 20) });
    previews.delete(previewId);
    return { ok: failed.length === 0, state: saved, appliedLocal: plan.localChanges.length, succeeded, failed: failed.length, failures: failed.slice(0, 20), unknownIds: plan.unknownIds, verified: Boolean(verified) };
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const method = req.method || "GET";
  const subpath = "/daguan-math";
  const pathname = url.pathname === subpath ? "/" : url.pathname.startsWith(`${subpath}/`) ? url.pathname.slice(subpath.length) : url.pathname;
  if (pathname === "/api/runtime/stop" && method === "POST") {
    const remote = String(req.socket.remoteAddress || "");
    if (req.headers.origin !== `http://${HOST}:${PORT}` || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
      return json(res, 403, { ok: false, error: "停止服务只允许从本机应用页面发起" });
    }
    if (typeof requestGracefulShutdown !== "function") return json(res, 503, { ok: false, error: "服务正在关闭" });
    json(res, 200, { ok: true });
    setImmediate(() => requestGracefulShutdown());
    return;
  }
  if (pathname === "/api/health" && method === "GET") return json(res, 200, { ok: true, service: "daguan-local-console", apiProtocol: SERVICE_API_PROTOCOL, instanceId: serviceInstance?.instanceId || null, launcherKind: serviceInstance?.launcherKind || null, pid: process.pid, port: PORT, time: nowIso() });
  if (pathname === "/api/question-bank/status" && method === "GET") return json(res, 200, questionBank?.status() || { enabled: false, activeId: "bundled" });
  if (pathname === "/api/access/status" && method === "GET") {
    const unlocked = !PREVIEW_MODE || hasPreviewAccess(req);
    if (PREVIEW_MODE && unlocked) setPreviewCookie(res);
    return json(res, 200, {
      ok: true,
      previewMode: PREVIEW_MODE,
      configured: Boolean(PREVIEW_KEY),
      unlocked,
      privateFeatures: ["收藏", "错题", "掌握度", "批注", "进度备份", "官网同步", "AI 服务与历史"],
    });
  }
  if (pathname === "/api/access/unlock" && method === "POST") {
    if (!PREVIEW_MODE) return json(res, 200, { ok: true, previewMode: false, unlocked: true });
    if (!PREVIEW_KEY) return json(res, 503, { ok: false, code: "PREVIEW_KEY_MISSING", error: "预览模式尚未配置密钥" });
    const incoming = await body(req);
    const key = String(incoming.key || "");
    if (!key || !safeEqualText(key, PREVIEW_KEY)) {
      return json(res, 401, { ok: false, code: "PREVIEW_KEY_INVALID", error: "预览密钥不正确" });
    }
    const issuedAt = Date.now();
    setPreviewCookie(res, issuedAt);
    return json(res, 200, { ok: true, previewMode: true, unlocked: true });
  }
  if (pathname === "/api/access/lock" && method === "POST") {
    res.setHeader("Set-Cookie", `${PREVIEW_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return json(res, 200, { ok: true, previewMode: PREVIEW_MODE, unlocked: !PREVIEW_MODE });
  }
  if (pathname === "/api/runtime" && method === "GET") {
    const state = await store.readState();
    const profiles = !PREVIEW_MODE || hasPreviewAccess(req) ? await ai.profiles() : [];
    return json(res, 200, { ok: true, appVersion: BUILD_VERSION, stateRevision: PREVIEW_MODE && !hasPreviewAccess(req) ? 0 : state.revision, catalog: await catalogInfo(), ai: { configured: profiles.length > 0, profiles: profiles.length }, aiConfig: await aiConfigStatus(req), python: { optional: true, configured: process.env.DAGUAN_PYTHON !== "disabled" }, time: nowIso() });
  }
  if (pathname === "/api/catalog/refresh" && method === "POST") return json(res, 202, startCatalogRefresh());
  if (pathname.startsWith("/api/catalog/refresh/") && method === "GET") {
    const task = catalogTasks.get(pathname.slice("/api/catalog/refresh/".length));
    return task ? json(res, 200, task) : json(res, 404, { ok: false, error: "题库刷新任务不存在" });
  }
  if (privateApiPath(pathname) && !requirePreviewAccess(req, res)) return;
  if (pathname === "/api/study-activity" && method === "GET") return json(res, 200, await studyActivity.summary({ days: url.searchParams.get('days') || 1, timeZone: url.searchParams.get('timeZone') || 'Asia/Hong_Kong' }));
  if (pathname === "/api/study-activity/journal" && method === "GET") return json(res, 200, await studyActivity.journal({ end: url.searchParams.get('end') || undefined, timeZone: url.searchParams.get('timeZone') || 'Asia/Hong_Kong' }));
  if (pathname === "/api/study-activity/export" && method === "GET") return json(res, 200, await studyActivity.export());
  if (pathname === "/api/study-activity/events" && method === "POST") {
    // 正文只读一次；事件提交体为 { events, reset_generation }，活动写入与清除在同一把 withLock 内串行。
    const incoming = await body(req);
    return withLock(async () => {
      const current = await store.readState();
      requireProgressGeneration(incoming, current);
      const accepted = await studyActivity.append(incoming.events);
      broadcastStudyActivity(); return json(res, 200, { ok: true, accepted });
    });
  }
  if (pathname === "/api/study-activity/merge" && method === "POST") {
    // 合并体仍是备份文档：正文里的 reset_generation 只当请求当前代次校验，不作为导入代次使用。
    const incoming = await body(req);
    return withLock(async () => {
      const current = await store.readState();
      requireProgressGeneration(incoming, current);
      const result = await studyActivity.merge(incoming);
      broadcastStudyActivity(); return json(res, 200, { ok: true, ...result });
    });
  }
  if (pathname === "/api/visit-history" && method === "GET") return json(res, 200, { ok: true, entries: await visitHistory.list() });
  if (pathname === "/api/visit-history" && method === "POST") { const entry = await visitHistory.visit(await body(req)); broadcastHistory(); return json(res, 200, { ok: true, entry }); }
  if (pathname === "/api/visit-history" && method === "DELETE") { await visitHistory.clear(); broadcastHistory(); return json(res, 200, { ok: true }); }
  if (pathname === "/api/visit-history/merge" && method === "POST") { const count = await visitHistory.merge((await body(req)).entries); broadcastHistory(); return json(res, 200, { ok: true, count }); }
  if (pathname.startsWith("/api/visit-history/") && method === "DELETE") { await visitHistory.remove(pathname.slice("/api/visit-history/".length)); broadcastHistory(); return json(res, 200, { ok: true }); }
  if (pathname === "/api/state/events" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: state\ndata: ${JSON.stringify({ revision: (await store.readState()).revision, initial: true })}\n\n`);
    stateEventClients.add(res);
    const keepAlive = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch {} }, 15_000);
    const cleanup = () => { clearInterval(keepAlive); stateEventClients.delete(res); };
    res.on("close", cleanup);
    return;
  }
  if (pathname === "/api/state" && method === "GET") return json(res, 200, await store.readState());
  if (pathname === "/api/state" && method === "PUT") {
    const incoming = await body(req);
    const expectedRevision = requestRevision(req, incoming);
    if (expectedRevision == null) return json(res, 409, { ok: false, code: "REVISION_REQUIRED", error: "整份状态写入必须携带 revision；请改用逐题接口" });
    const saved = await withLock(async () => {
      const current = await store.readState();
      requireProgressGeneration(incoming, current);
      return writeState(localStateShape(incoming), { expectedRevision, studyImport: true });
    });
    return json(res, 200, { ok: true, state: saved, revision: saved.revision });
  }
  if (pathname === "/api/state/clear-progress" && method === "POST") {
    const incoming = await body(req);
    const expectedRevision = requestRevision(req, incoming);
    if (expectedRevision == null) return json(res, 409, { ok: false, code: "REVISION_REQUIRED", error: "清除做题记录必须携带 revision" });
    return withLock(async () => {
      const current = await store.readState();
      if (current.revision !== expectedRevision) {
        const error = new Error("本地状态版本已变化，请重新确认后再清除");
        error.code = "STATE_CONFLICT";
        error.status = 409;
        error.current = current;
        throw error;
      }
      requireProgressGeneration(incoming, current, true);
      // 预检：活动文件损坏或代次超前必须在 state 落盘前失败，避免把 state 推进到无法对齐的代次。
      await studyActivity.ensure();
      const saved = await store.writeState({ ...current, progress: {}, last_study: null }, { expectedRevision, resetProgress: true });
      try {
        await studyActivity.clear();
      } catch (cause) {
        const error = new Error(`做题记录与最近学习位置已清除（版本 ${saved.revision}、清除代次 ${saved.reset_generation}），但学习手账与战报清理未完成：${cause?.message || cause}。请稍后重新打开页面，服务会在下次访问时按同一代次重试清理。`);
        error.code = "ACTIVITY_RESET_FAILED";
        error.status = 500;
        error.current = saved;
        error.cause = cause;
        throw error;
      }
      broadcastState(saved);
      broadcastStudyActivity();
      return json(res, 200, { ok: true, state: saved, revision: saved.revision, reset_generation: saved.reset_generation });
    });
  }
  if (pathname.startsWith("/api/state/questions/") && !pathname.endsWith("/annotation") && method === "PATCH") {
    const questionId = pathname.slice("/api/state/questions/".length);
    if (!/^\d+$/.test(questionId)) return json(res, 400, { ok: false, error: "题目 ID 无效" });
    const incoming = await body(req);
    const expectedRevision = requestRevision(req, incoming);
    if (expectedRevision == null) return json(res, 409, { ok: false, code: "REVISION_REQUIRED", error: "逐题状态写入必须携带 revision" });
    const saved = await withLock(async () => {
      const current = await store.readState();
      requireProgressGeneration(incoming, current);
      if (expectedRevision != null && current.revision !== expectedRevision) {
        const error = new Error("本地状态版本已变化，请重新合并");
        error.code = "STATE_CONFLICT";
        error.status = 409;
        error.current = current;
        throw error;
      }
      const progress = { ...(current.progress || {}) };
      const entry = { ...(progress[questionId] || {}) };
      const at = incoming.updated_at || nowIso();
      if (incoming.mastery != null) {
        if (!["not_started", "learning", "mastered", "forgot"].includes(incoming.mastery)) throw Object.assign(new Error("掌握状态无效"), { status: 400 });
        entry.mastery = incoming.mastery === "forgot" ? "learning" : incoming.mastery;
        if (incoming.mastery === "forgot") entry.error_prone = true;
        entry.mastery_updated_at = at;
        entry.seen = incoming.seen !== false;
      }
      if (incoming.seen != null) entry.seen = incoming.seen === true;
      if (incoming.answered != null) entry.answered = incoming.answered === true;
      if (incoming.last_ok != null) entry.last_ok = incoming.last_ok === true;
      if (incoming.last_practiced_at != null) entry.last_practiced_at = incoming.last_practiced_at;
      if (incoming.error_prone != null) { entry.error_prone = incoming.error_prone === true; entry.error_prone_updated_at = at; }
      if (incoming.favorite != null || incoming.is_favorite != null) { entry.favorite = incoming.favorite ?? incoming.is_favorite === true; entry.favorite_updated_at = at; }
      entry.updated_at = at;
      progress[questionId] = entry;
      // 收藏意图以 current.favorites 为准：清除只清练习记录时该题的进度条目为空，
      // 逐题写练习字段（payload 不带 favorite）不能顺带删掉原有收藏；显式 favorite:false 仍取消收藏。
      const favorites = new Set(current.favorites || []);
      if (entry.favorite) favorites.add(questionId);
      else if (incoming.favorite != null || incoming.is_favorite != null) favorites.delete(questionId);
      return writeState({ ...current, progress, favorites: [...favorites].sort((a, b) => Number(a) - Number(b)) }, { expectedRevision: current.revision, studyAction: true });
    });
    return json(res, 200, { ok: true, revision: saved.revision, state: saved });
  }
  if (pathname.startsWith("/api/state/questions/") && pathname.endsWith("/annotation") && method === "PATCH") {
    const questionId = pathname.slice("/api/state/questions/".length, -"/annotation".length);
    if (!/^\d+$/.test(questionId)) return json(res, 400, { ok: false, error: "题目 ID 无效" });
    const incoming = await body(req);
    const expectedRevision = requestRevision(req, incoming);
    if (expectedRevision == null) return json(res, 409, { ok: false, code: "REVISION_REQUIRED", error: "批注写入必须携带 revision" });
    const saved = await withLock(async () => {
      const current = await store.readState();
      if (current.revision !== expectedRevision) {
        const error = new Error("本地状态版本已变化，请重新合并");
        error.code = "STATE_CONFLICT"; error.status = 409; error.current = current; throw error;
      }
      const annotations = { ...(current.annotations || {}) };
      const previous = annotations[questionId] && typeof annotations[questionId] === "object" ? annotations[questionId] : { history: [] };
      const markdown = String(incoming.markdown || "").slice(0, 100_000);
      const history = Array.isArray(previous.history) ? previous.history.slice(-9) : [];
      if (previous.markdown !== markdown) history.push({ markdown: previous.markdown || "", updated_at: previous.updated_at || nowIso() });
      annotations[questionId] = { markdown, updated_at: incoming.updated_at || nowIso(), history };
      return writeState({ ...current, annotations }, { expectedRevision: current.revision });
    });
    return json(res, 200, { ok: true, revision: saved.revision, state: saved });
  }
  if (pathname === "/api/state/last-study" && method === "PATCH") {
    const incoming = await body(req);
    const expectedRevision = requestRevision(req, incoming);
    if (expectedRevision == null) return json(res, 409, { ok: false, code: "REVISION_REQUIRED", error: "最近学习位置写入必须携带 revision" });
    const saved = await withLock(async () => {
      const current = await store.readState();
      requireProgressGeneration(incoming, current);
      if (expectedRevision != null && current.revision !== expectedRevision) {
        const error = new Error("本地状态版本已变化，请重新合并");
        error.code = "STATE_CONFLICT";
        error.status = 409;
        error.current = current;
        throw error;
      }
      return writeState({ ...current, last_study: { ...incoming, revision: undefined }, updated_at: nowIso() }, { expectedRevision: current.revision });
    });
    return json(res, 200, { ok: true, revision: saved.revision, state: saved });
  }
  if (pathname === "/api/state/migrate" && method === "POST") {
    const incoming = await body(req);
    const saved = await withLock(async () => {
      const current = await store.readState();
      requireProgressGeneration(incoming, current);
      const merged = mergeMigratedState(current, incoming);
      return writeState(merged, { expectedRevision: current.revision, studyImport: true });
    });
    return json(res, 200, { ok: true, state: saved });
  }
  if (pathname.startsWith("/api/ai/")) {
    if (aiLocalBoundary(req, res)) return;
    if (aiConfigWrite(pathname, method) && isRemoteSession(req)) {
      return json(res, 403, { ok: false, code: "AI_CONFIG_READONLY", error: "远程会话为只读：AI 服务配置请在本机修改" });
    }
  }
  if (pathname === "/api/ai/profiles" && method === "GET") return json(res, 200, { ok: true, profiles: await ai.profiles(), keyStorage: (await aiStorageFactsCached()).backend });
  if (pathname === "/api/ai/profiles" && method === "POST") return json(res, 200, { ok: true, profile: await ai.upsert(await body(req)) });
  if (pathname.startsWith("/api/ai/profiles/") && pathname.endsWith("/models") && method === "GET") {
    const id = pathname.slice("/api/ai/profiles/".length, -"/models".length);
    return json(res, 200, { ok: true, ...(await ai.models(id)) });
  }
  if (pathname.startsWith("/api/ai/profiles/") && pathname.endsWith("/test") && method === "POST") {
    const id = pathname.slice("/api/ai/profiles/".length, -"/test".length);
    const incoming = await body(req);
    return json(res, 200, await ai.test(id, incoming.kind === "vision" ? "vision" : "text"));
  }
  if (pathname.startsWith("/api/ai/profiles/") && method === "PATCH") {
    const id = pathname.slice("/api/ai/profiles/".length);
    return json(res, 200, { ok: true, profile: await ai.upsert({ ...(await body(req)), id }) });
  }
  if (pathname.startsWith("/api/ai/profiles/") && method === "DELETE") {
    const id = pathname.slice("/api/ai/profiles/".length);
    const incoming = await body(req);
    return json(res, 200, await ai.remove(id, incoming.clearHistory === true));
  }
  if (pathname === "/api/ai/chat" && method === "POST") return ai.streamChat(req, res, await body(req));
  if (pathname === "/api/ai/diagram" && method === "POST") return json(res, 200, { ok: true, ...(await ai.diagram(await body(req))) });
  if (pathname.startsWith("/api/ai/runs/") && method === "DELETE") return json(res, 200, { ok: ai.stop(pathname.slice("/api/ai/runs/".length)) });
  if (pathname.startsWith("/api/ai/conversations/") && method === "GET") {
    const parts = pathname.slice("/api/ai/conversations/".length).split("/");
    return json(res, 200, { ok: true, ...(await ai.conversation(parts[0], parts[1])) });
  }
  if (pathname.startsWith("/api/ai/conversations/") && method === "DELETE") {
    const parts = pathname.slice("/api/ai/conversations/".length).split("/");
    return json(res, 200, await ai.clearConversation(parts[0], parts[1]));
  }
  if (pathname === "/api/integrations/cxyonly/status" && method === "GET") {
    const status = await client.status();
    const local = await store.readState();
    return json(res, 200, { ...status, needsFirstSync: !local.remote_seeded_at });
  }
  if (pathname === "/api/integrations/cxyonly/login" && method === "POST") return json(res, 200, { ok: true, ...(await client.login(await body(req))) });
  if (pathname === "/api/integrations/cxyonly/logout" && method === "POST") { await store.clearIntegration(); return json(res, 200, { ok: true }); }
  if (pathname === "/api/integrations/cxyonly/pull/preview" && method === "POST") return json(res, 200, await pullPreview());
  if (pathname === "/api/integrations/cxyonly/pull/apply" && method === "POST") return json(res, 200, await applyPull((await body(req)).previewId));
  if (pathname === "/api/integrations/cxyonly/push/preview" && method === "POST") return json(res, 200, await pushPreview());
  if (pathname === "/api/integrations/cxyonly/push/apply" && method === "POST") return json(res, 200, await applyPush((await body(req)).previewId));
  if (pathname === "/api/integrations/cxyonly/reconcile/preview" && method === "POST") {
    const incoming = await body(req);
    return json(res, 200, await reconcilePreview(incoming));
  }
  if (pathname === "/api/integrations/cxyonly/reconcile/apply" && method === "POST") {
    const incoming = await body(req);
    return json(res, 200, await applyReconcile(incoming.previewId, incoming));
  }
  if (pathname === "/api/integrations/cxyonly/export" && method === "GET") {
    const source = url.searchParams.get("source") || "local";
    const value = source === "remote"
      ? (await client.pullDocument()).document
      : source === "backup"
        ? await store.readProgress()
        : source === "android"
          ? localToAndroidDocument(await store.readState())
          : await store.readState();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename=daguan-${source}-${new Date().toISOString().slice(0, 10)}.json`, "Cache-Control": "no-store" });
    return res.end(JSON.stringify(value, null, 2));
  }
  return serveStatic(pathname, res, url.searchParams.get("bank"));
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".ico": "image/x-icon" };
async function serveStatic(requestPath, res, bankId = null) {
  let relative;
  try { relative = decodeURIComponent(requestPath); } catch { return json(res, 400, { error: "路径错误" }); }
  if (relative === "/" || relative === "") relative = DEFAULT_PAGE;
  const isBankData = relative.startsWith("/data/");
  const bankRoot = isBankData ? questionBank?.dataRoot(bankId) : null;
  if (isBankData && bankId && !bankRoot) return json(res, 404, { error: "题库版本不存在" });
  const staticRoot = bankRoot || WEB_ROOT;
  const staticPath = bankRoot ? relative.slice("/data".length) : relative;
  const target = path.resolve(staticRoot, `.${staticPath}`);
  if (!target.startsWith(`${staticRoot}${path.sep}`)) return json(res, 403, { error: "禁止访问" });
  try {
    let file = target;
    try { const stat = await fs.stat(file); if (stat.isDirectory()) file = path.join(file, "index.html"); }
    catch {
      if (!bankRoot || !staticPath.startsWith("/assets/")) throw new Error("resource missing");
      const assetName = path.basename(staticPath);
      // 题图白名单只放开既有的四种图片格式；jpg/jpeg 同族互认，避免命中了别名却仍 404。
      if (!/^[0-9a-f]{64}\.(png|jpe?g|webp|gif)$/.test(assetName)) throw new Error("resource missing");
      const candidates = /\.jpe?g$/.test(assetName)
        ? [assetName, assetName.replace(/\.jpe?g$/, extension => extension === ".jpg" ? ".jpeg" : ".jpg")]
        : [assetName];
      // 查找范围不变：当前题库版本 → bundled → 既有 versions。
      const assetDirs = [path.join(bankRoot, "assets"), path.join(WEB_ROOT, "data", "assets")];
      const versionsRoot = path.join(store.dataDir, "question-bank", "versions");
      const versions = await fs.readdir(versionsRoot).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const version of versions) {
        if (/^[0-9a-f-]{36}$/.test(version)) assetDirs.push(path.join(versionsRoot, version, "assets"));
      }
      file = null;
      for (const dir of assetDirs) {
        for (const candidate of candidates) {
          const next = path.join(dir, candidate);
          try {
            await fs.access(next);
            file = next;
            break;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        if (file) break;
      }
      if (!file) throw new Error("resource missing");
    }
    const ext = path.extname(file).toLowerCase();
    const isHtml = ext === ".html";
    const isServiceWorker = path.basename(file) === "service-worker.js";
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": isBankData || isHtml || isServiceWorker ? "no-store" : "public, max-age=3600",
    });
    return res.end(await fs.readFile(file));
  } catch {
    return json(res, 404, { error: "资源不存在" });
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => errorJson(res, error));
});

let lease;
for (let attempt = 0; attempt < 60; attempt += 1) {
  lease = await acquireServiceInstance(store.dataDir, { host: HOST, port: PORT });
  if (lease.acquired || !lease.recovering) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!lease?.acquired) {
  if (lease?.owner && await waitForServiceOwner(lease.owner)) {
    const url = serviceOwnerUrl(lease.owner);
    console.log(`SERVICE_INSTANCE_REUSED ${url}`);
    openBrowser(`${url}?ui=new`);
    process.exitCode = 0;
  } else {
    const error = new Error(lease?.recovering
      ? "本地服务实例锁仍在恢复，请稍后重试"
      : `服务实例 PID ${lease?.owner?.pid ?? "未知"}（端口 ${lease?.owner?.port ?? "未知"}，实例 ${lease?.owner?.instanceId ?? "未知"}）持有数据目录 ${store.dataDir}，但健康检查未确认服务。可能是旧服务仍在退出，也可能是 Windows 重用了 PID。请先检查该 PID 的命令行和该端口；仅在确认没有 Daguan 服务进程使用此目录后，删除 ${path.join(store.dataDir, ".service-instance.json")} 并重试。切勿在服务进程仍运行时删除锁，以免两个进程同时写入。`);
    error.code = "SERVICE_INSTANCE_HELD";
    throw error;
  }
} else {
  serviceInstance = lease.owner;
  try {
    await store.readState();
    await studyActivity.ensure();
    if (typeof ai.migrate === "function") {
      // AI Key 存储迁移：只记录数量与存储后端，绝不输出 Key 内容；失败不阻塞启动。
      try {
        const migrated = await ai.migrate();
        console.log(`AI_SECRETS_MIGRATED ${JSON.stringify({
          migrated: Number(migrated?.migrated) || 0,
          keyStorage: migrated?.keyStorage || null,
          warnings: Array.isArray(migrated?.warnings) ? migrated.warnings.length : 0,
          lastError: migrated?.lastError || null,
        })}`);
      } catch (error) {
        console.log(`AI_SECRETS_MIGRATE_FAILED ${String(error?.message || error).slice(0, 200)}`);
      }
    }
    questionBank = await createQuestionBankUpdater({
      dataDir: store.dataDir, bundledDataDir: path.join(WEB_ROOT, "data"),
      enabled: process.env.DAGUAN_AUTO_UPDATE_BANK === "1",
      onUpdate: (pointer) => {
        knownIdsPromise = null;
        const event = `event: bank-updated\ndata: ${JSON.stringify({ activeId: pointer.id, total: pointer.total })}\n\n`;
        for (const response of stateEventClients) {
          try { response.write(event); } catch { stateEventClients.delete(response); }
        }
      },
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(PORT, HOST);
    });
  } catch (error) {
    await lease.release();
    throw error;
  }
  console.log(`SERVICE_INSTANCE_READY http://${HOST}:${PORT}/ ${serviceInstance.instanceId}`);
  questionBank.start();
  openBrowser(`http://${HOST}:${PORT}/index.html?ui=new${process.env.DAGUAN_BROWSER_PACKAGE === "1" ? "&browserPackage=1" : ""}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const response of stateEventClients) {
      try { response.write("event: server-stopping\ndata: {}\n\n"); response.end(); } catch {}
    }
    stateEventClients.clear();
    server.close(async () => {
      await questionBank?.stop();
      await lease.release();
      process.exit(0);
    });
    // Do not force-close active requests here: an in-flight state write must finish
    // before the data-directory lease is released to another process.
  };
  requestGracefulShutdown = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("disconnect", shutdown);
  process.on("message", (message) => {
    if (message?.type === "shutdown") void shutdown();
  });
}
