import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { listenHttp } from "./http-fixture.mjs";

const require = createRequire(import.meta.url);
const { createRemoteGateway } = require("../desktop/remote-gateway.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 仅使用假 Key 与回环 mock；不接触真实用户数据，不访问真实外网服务。
const FAKE_KEY = "sk-fake-boundary-test-key";
// 只有 Windows（DPAPI 持久加密后端）接受保存 Key；其他平台 fail-closed 拒绝保存，
// 因此非 Windows 用无 Key 档案继续覆盖同一套边界，不为此开放明文后端。
const CAN_SAVE_KEY = process.platform === "win32";

async function freePort() {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close((error) => error ? reject(error) : resolve(value)); });
  });
  return port >= 12000 ? port : freePort();
}

test("AI endpoints enforce loopback origin boundary and keep configuration read-only for remote sessions", { timeout: 60000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-ai-boundary-"));
  const upstream = http.createServer(async (req, res) => {
    if (req.url.endsWith("/models")) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ id: "math-model" }] })); return; }
    for await (const chunk of req) { /* drain the fake request */ }
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"choices":[{"delta":{"content":"边界"}}]}\n\n');
    res.end("data: [DONE]\n\n");
  });
  await listenHttp(upstream);
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "local-server", "server.mjs")], {
    cwd: ROOT,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DAGUAN_DATA_DIR: path.join(temp, "data"), DAGUAN_ROOT_DIR: ROOT, DAGUAN_WEB_ROOT: path.join(ROOT, "web"), DAGUAN_OPEN_BROWSER: "0" },
  });
  t.after(async () => {
    if (child.exitCode == null) child.kill();
    await fs.rm(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { health = await fetch(`${base}/api/health`); if (health.ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(health?.status, 200);

  const bodies = [];
  const call = async (route, { method = "GET", headers = {}, body } = {}) => {
    const response = await fetch(base + route, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body });
    const text = await response.text();
    bodies.push(text);
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE or empty */ }
    return { status: response.status, text, json };
  };
  const rawCall = (route, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const outgoing = http.request(base + route, { method, headers }, (incoming) => {
      const chunks = []; incoming.on("data", (chunk) => chunks.push(chunk)); incoming.on("end", () => resolve({ status: incoming.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    outgoing.on("error", reject); outgoing.end(body);
  });
  // 服务端 run 在响应结束后异步清理，连续问答可能偶发撞上“两个任务”上限；
  // 仅对该竞态重试，边界拒绝（403/415）仍会立即返回。
  const chatOk = async (route, payload, headers = {}) => {
    let last = null;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      last = await call(route, { method: "POST", headers, body: JSON.stringify(payload) });
      if (last.status === 200 || !/两个 AI 任务/.test(last.text)) return last;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return last;
  };

  // 本机同源页面可以创建档案（假 Key，仅落在隔离数据目录）。
  const seedBody = { name: "边界测试", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: "math-model", active: true };
  if (CAN_SAVE_KEY) seedBody.key = FAKE_KEY;
  const seeded = await call("/api/ai/profiles", { method: "POST", headers: { Origin: base }, body: JSON.stringify(seedBody) });
  assert.equal(seeded.status, 200, seeded.text);
  const profileId = seeded.json?.profile?.id;
  assert.ok(profileId);
  assert.equal(seeded.json.profile.key, undefined);
  assert.equal(seeded.json.profile.hasKey, CAN_SAVE_KEY);
  if (CAN_SAVE_KEY) assert.equal(seeded.json.profile.keyHint && seeded.json.profile.keyHint.includes(FAKE_KEY), false);

  // 掩码列表：不带 Origin 的本机代理（Electron/Node）与同源页面都可读取，且绝不返回 Key。
  for (const headers of [{}, { Origin: base }]) {
    const list = await call("/api/ai/profiles", { headers });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.json.profiles.length, 1);
    assert.equal(list.json.profiles[0].key, undefined);
    assert.equal(typeof list.json.keyStorage, "string");
  }

  // 本地学习功能保持可用：同源 Origin、无 Origin 代理、回环 Host + application/json。
  const chatSameOrigin = await chatOk("/api/ai/chat", { profileId, question: { id: "q1", stem: "求解" }, prompt: "讲解" }, { Origin: base });
  assert.equal(chatSameOrigin.status, 200, chatSameOrigin.text);
  assert.match(chatSameOrigin.text, /"type":"started"/);
  const chatNoOrigin = await chatOk("/api/ai/chat", { profileId, question: { id: "q2", stem: "求解" }, prompt: "讲解" });
  assert.equal(chatNoOrigin.status, 200, chatNoOrigin.text);
  assert.match(chatNoOrigin.text, /"type":"done"/);
  const diagram = await call("/api/ai/diagram", { method: "POST", headers: { Origin: base }, body: JSON.stringify({ kind: "polyline", points: [[0, 0], [1, 2]], title: "安全图" }) });
  assert.equal(diagram.status, 200, diagram.text);
  assert.match(diagram.json.svg, /^<svg/);
  assert.doesNotMatch(diagram.json.svg, /script|foreignObject|onload/i);
  assert.equal((await call(`/api/ai/runs/missing`, { method: "DELETE" })).status, 200);
  assert.equal((await call(`/api/ai/conversations/${profileId}/q1`)).status, 200);

  // 跨站网页被挡：外部 Origin、非回环 Host、非 JSON 写入。
  const crossOriginChat = await call("/api/ai/chat", { method: "POST", headers: { Origin: "https://attacker.example" }, body: JSON.stringify({ profileId, question: { id: "q3" }, prompt: "x" }) });
  assert.equal(crossOriginChat.status, 403);
  assert.equal(crossOriginChat.json.code, "ORIGIN_REJECTED");
  const crossOriginList = await call("/api/ai/profiles", { headers: { Origin: "https://attacker.example" } });
  assert.equal(crossOriginList.status, 403);
  assert.equal(crossOriginList.json.code, "ORIGIN_REJECTED");
  // 拒绝必须真正中止请求：被挡的跨站写入不得在 403 之后仍然产生副作用。
  for (const [route, payload] of [
    ["/api/ai/profiles", { name: "跨站注入", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }],
    ["/api/ai/profiles", { name: "非 JSON 注入", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }],
  ]) {
    const rejectedWrite = await call(route, { method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    assert.equal(rejectedWrite.status, 403);
    const after = await call("/api/ai/profiles", { headers: { Origin: base } });
    assert.equal(after.json.profiles.length, 1, "rejected cross-origin write must not create a profile");
    assert.equal(after.json.profiles.some((item) => item.name === "跨站注入" || item.name === "非 JSON 注入"), false);
  }
  // Origin 必须显式携带本服务端口：默认端口/其他端口的回环 Origin 都算跨源，
  // 否则本机其他端口上的页面也能借“同源”名义调用 AI 接口。
  // Origin 还必须是“纯源”：用户凭据、路径、查询、片段一律拒绝。
  const portless = `http://127.0.0.1`;
  for (const origin of [portless, `http://127.0.0.1:80`, "http://localhost", `http://127.0.0.1:9999`, `http://localhost:${upstream.address().port}`, `http://user:pass@127.0.0.1:${port}`, `http://127.0.0.1:${port}/evil`, `http://127.0.0.1:${port}?x=1`, `http://127.0.0.1:${port}#frag`]) {
    const rejected = await call("/api/ai/chat", { method: "POST", headers: { Origin: origin }, body: JSON.stringify({ profileId, question: { id: "qx" }, prompt: "x" }) });
    assert.equal(rejected.status, 403, `origin ${origin} must be rejected`);
    assert.equal(rejected.json.code, "ORIGIN_REJECTED");
  }
  // 被拒的跨站写入不得产生副作用（403 之后路由不得继续执行）。
  for (const origin of [`http://user:pass@127.0.0.1:${port}`, `http://127.0.0.1:${port}/evil`]) {
    const rejectedWrite = await call("/api/ai/profiles", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ name: "畸形 Origin 注入", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }) });
    assert.equal(rejectedWrite.status, 403);
    assert.equal(rejectedWrite.json.code, "ORIGIN_REJECTED");
  }
  const afterMalformed = await call("/api/ai/profiles", { headers: { Origin: base } });
  assert.equal(afterMalformed.json.profiles.length, 1, "malformed origins must not create profiles");
  // 显式携带本服务端口的同源 Origin 仍然放行（GET 不占用问答任务槽位）。
  const sameOriginExplicit = await call("/api/ai/profiles", { headers: { Origin: base } });
  assert.equal(sameOriginExplicit.status, 200, sameOriginExplicit.text);
  const plainText = await rawCall("/api/ai/chat", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "profileId=x" });
  assert.equal(plainText.status, 415);
  const rebound = await rawCall("/api/ai/chat", { method: "POST", headers: { Host: "attacker.example", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(rebound.status, 403);
  assert.match(rebound.text, /HOST_REJECTED/);
  // 边界只收紧 AI 接口，不影响其它本机接口。
  assert.equal((await rawCall("/api/health", { headers: { Host: "attacker.example" } })).status, 200);

  // 远程会话（网关标记）：配置写操作只读，学习功能与掩码列表保留。
  const remote = { "x-daguan-remote": "1" };
  const runtimeRemote = await call("/api/runtime", { headers: remote });
  assert.equal(runtimeRemote.status, 200);
  assert.equal(runtimeRemote.json.aiConfig.writable, false);
  assert.equal(runtimeRemote.json.aiConfig.readOnlyReason, "remote");
  assert.equal(typeof runtimeRemote.json.aiConfig.backend, "string");
  const runtimeLocal = await call("/api/runtime");
  assert.equal(runtimeLocal.json.aiConfig.writable, true);
  const remoteList = await call("/api/ai/profiles", { headers: remote });
  assert.equal(remoteList.status, 200, remoteList.text);
  assert.equal(remoteList.json.profiles[0].key, undefined);
  for (const [route, options] of [
    ["/api/ai/profiles", { method: "POST", body: JSON.stringify({ name: "远程新增", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }) }],
    [`/api/ai/profiles/${profileId}`, { method: "PATCH", body: JSON.stringify({ name: "远程改名" }) }],
    [`/api/ai/profiles/${profileId}`, { method: "DELETE", body: JSON.stringify({ clearHistory: false }) }],
    [`/api/ai/profiles/${profileId}/models`, { method: "GET" }],
    [`/api/ai/profiles/${profileId}/test`, { method: "POST", body: JSON.stringify({ kind: "text" }) }],
  ]) {
    const response = await call(route, { ...options, headers: remote });
    assert.equal(response.status, 403, `${options.method || "GET"} ${route}`);
    assert.equal(response.json.code, "AI_CONFIG_READONLY");
  }
  const remoteChat = await chatOk("/api/ai/chat", { profileId, question: { id: "q4", stem: "求解" }, prompt: "讲解" }, remote);
  assert.equal(remoteChat.status, 200, remoteChat.text);
  assert.match(remoteChat.text, /"type":"done"/);
  assert.equal((await call("/api/ai/diagram", { method: "POST", headers: remote, body: JSON.stringify({ kind: "polyline", points: [[0, 0], [1, 2]] }) })).status, 200);
  assert.equal((await call(`/api/ai/runs/missing`, { method: "DELETE", headers: remote })).status, 200);
  assert.equal((await call(`/api/ai/conversations/${profileId}/q1`, { headers: remote })).status, 200);

  // 任何响应都不得泄露假 Key。
  assert.ok(!bodies.some((text) => text.includes(FAKE_KEY)), "responses must never contain the API key");
});

test("remote gateway in front of the real service blocks AI configuration and keeps chat usable", { timeout: 60000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-ai-gateway-chain-"));
  const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-ai-gateway-auth-"));
  t.after(async () => {
    await fs.rm(temp, { recursive: true, force: true });
    await fs.rm(authDir, { recursive: true, force: true });
  });
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* drain */ }
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"choices":[{"delta":{"content":"链路"}}]}\n\n');
    res.end("data: [DONE]\n\n");
  });
  await listenHttp(upstream);
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "local-server", "server.mjs")], {
    cwd: ROOT,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DAGUAN_DATA_DIR: path.join(temp, "data"), DAGUAN_ROOT_DIR: ROOT, DAGUAN_WEB_ROOT: path.join(ROOT, "web"), DAGUAN_OPEN_BROWSER: "0" },
  });
  t.after(async () => { if (child.exitCode == null) child.kill(); });
  const service = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { if ((await fetch(`${service}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const gateway = createRemoteGateway({ authFile: path.join(authDir, "auth.json"), upstream: () => service, getMode: () => "quick" });
  await gateway.init();
  await gateway.setPassword("a strong testing password");
  gateway.setPublicHost("study.example.com");
  const gatewayPort = await gateway.start();
  t.after(() => gateway.stop());
  const remote = `http://127.0.0.1:${gatewayPort}`;
  const call = (route, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const outgoing = http.request(remote + route, { method, headers: { Host: "study.example.com", ...headers } }, (incoming) => {
      const chunks = []; incoming.on("data", (chunk) => chunks.push(chunk)); incoming.on("end", () => resolve({ status: incoming.statusCode, headers: incoming.headers, text: Buffer.concat(chunks).toString() }));
    });
    outgoing.on("error", reject); outgoing.end(body);
  });
  const login = await call("/__remote/login", { method: "POST", headers: { Origin: "https://study.example.com", "Content-Type": "application/json" }, body: JSON.stringify({ password: "a strong testing password" }) });
  assert.equal(login.status, 200);
  const cookie = Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : login.headers["set-cookie"];
  assert.ok(cookie, "login sets the remote session cookie");
  const headers = { Cookie: cookie.split(";")[0] };
  // 仅对“两个任务”竞态重试；网关层的 403/404 拒绝会立即返回。
  const chatOk = async (route, payload) => {
    let last = null;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      last = await call(route, { method: "POST", headers: { ...headers, Origin: "https://study.example.com", "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (last.status === 200 || !/两个 AI 任务/.test(last.text)) return last;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return last;
  };

  // 先在本机同源创建一个档案（假 Key），供远程会话验证学习功能仍然可用。
  const seedBody = { name: "链路测试", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: "math-model", active: true };
  if (CAN_SAVE_KEY) seedBody.key = FAKE_KEY;
  const seeded = await fetch(`${service}/api/ai/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: service },
    body: JSON.stringify(seedBody),
  });
  assert.equal(seeded.status, 200);
  const profileId = (await seeded.json()).profile.id;

  // 远程会话：配置写操作在网关层即被拒绝。
  for (const [route, options] of [
    ["/api/ai/profiles", { method: "POST", body: JSON.stringify({ name: "远程新增", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }) }],
    [`/api/ai/profiles/${profileId}`, { method: "PATCH", body: JSON.stringify({ name: "远程改名" }) }],
    [`/api/ai/profiles/${profileId}/models`, { method: "GET" }],
    [`/api/ai/profiles/${profileId}/test`, { method: "POST", body: JSON.stringify({ kind: "text" }) }],
  ]) {
    const response = await call(route, { ...options, headers: { ...headers, Origin: "https://study.example.com", ...(options.body ? { "Content-Type": "application/json" } : {}) } });
    assert.equal(response.status, 403, `${options.method} ${route}`);
  }
  // 远程会话：掩码列表、运行时只读标志与问答保持可用。
  const list = await call("/api/ai/profiles", { headers });
  assert.equal(list.status, 200);
  assert.equal(list.text.includes(FAKE_KEY), false);
  const runtime = await call("/api/runtime", { headers });
  assert.equal(runtime.status, 200);
  assert.equal(JSON.parse(runtime.text).aiConfig.writable, false);
  const chat = await chatOk("/api/ai/chat", { profileId, question: { id: "q9", stem: "求解" }, prompt: "讲解" });
  assert.equal(chat.status, 200, chat.text);
  assert.match(chat.text, /链路/);

  // 已认证远程会话下的 /daguan-math 前缀链路：判定与上游路由所见一致。
  const prefixedBlocked = [
    ["POST", "/daguan-math/api/ai/profiles"],
    ["PATCH", `/daguan-math/api/ai/profiles/${profileId}`],
    ["GET", `/daguan-math/api/ai/profiles/${profileId}/models`],
    ["POST", "/daguan-math/api/catalog/refresh"],
    ["GET", "/daguan-math/service-worker.js"],
    ["GET", "/daguan-math/api/state/events"],
    ["GET", "/%64aguan-math/api/catalog/refresh/task-1"],
  ];
  for (const [method, route] of prefixedBlocked) {
    const response = await call(route, { method, headers: { ...headers, Origin: "https://study.example.com" } });
    assert.notEqual(response.status, 200, `${method} ${route} must not be served remotely`);
  }
  // 带前缀的健康检查与掩码列表能穿过网关并被上游正确路由。
  const prefixedHealth = await call("/daguan-math/api/health", { headers });
  assert.equal(prefixedHealth.status, 200, prefixedHealth.text);
  assert.equal(JSON.parse(prefixedHealth.text).ok, true);
  const prefixedRuntime = await call("/daguan-math/api/runtime", { headers });
  assert.equal(prefixedRuntime.status, 200, prefixedRuntime.text);
  assert.equal(JSON.parse(prefixedRuntime.text).aiConfig.writable, false);
  const prefixedList = await call("/daguan-math/api/ai/profiles", { headers });
  assert.equal(prefixedList.status, 200, prefixedList.text);
  assert.equal(prefixedList.text.includes(FAKE_KEY), false);
  const prefixedChat = await chatOk("/daguan-math/api/ai/chat", { profileId, question: { id: "q10", stem: "求解" }, prompt: "讲解" });
  assert.equal(prefixedChat.status, 200, prefixedChat.text);
  assert.match(prefixedChat.text, /链路/);
  // 双重前缀不会被二次剥离成管理面路径：上游仍按带前缀路由并 404。
  const doubled = await call("/daguan-math/daguan-math/api/catalog/refresh", { method: "POST", headers: { ...headers, Origin: "https://study.example.com" } });
  assert.equal(doubled.status, 404, doubled.text);
});

test("PORT 覆盖为 80 时无显式端口的同源 Origin 被允许，错误端口仍拒绝", { timeout: 60000 }, async (t) => {
  // 条件式验收：端口 80 不可绑定（权限/占用）时跳过，不伪造通过。
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-ai-port80-"));
  t.after(async () => { await fs.rm(temp, { recursive: true, force: true }); });
  const child = spawn(process.execPath, [path.join(ROOT, "local-server", "server.mjs")], {
    cwd: ROOT,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, PORT: "80", HOST: "127.0.0.1", DAGUAN_DATA_DIR: path.join(temp, "data"), DAGUAN_ROOT_DIR: ROOT, DAGUAN_WEB_ROOT: path.join(ROOT, "web"), DAGUAN_OPEN_BROWSER: "0" },
  });
  let exited = null;
  child.on("exit", (code) => { exited = code; });
  t.after(() => { if (exited === null) child.kill(); });
  const base80 = "http://127.0.0.1:80";
  let health = null;
  for (let attempt = 0; attempt < 100 && exited === null; attempt += 1) {
    try { health = await fetch(`${base80}/api/health`); if (health.ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (exited !== null || !health?.ok) { t.skip("端口 80 不可绑定，跳过 PORT=80 同源验收"); return; }

  const call80 = async (route, { method = "GET", headers = {} } = {}) => {
    const response = await fetch(base80 + route, { method, headers });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { status: response.status, text, json };
  };
  // 无显式端口的回环 Origin 在 PORT=80 下就是正确同源。
  for (const origin of ["http://127.0.0.1", "http://localhost", base80]) {
    const allowed = await call80("/api/ai/profiles", { headers: { Origin: origin } });
    assert.equal(allowed.status, 200, `${origin} must be accepted when the service runs on port 80`);
    assert.equal(allowed.json.profiles.length, 0);
  }
  // 端口不匹配（含其他回环端口）仍然拒绝。
  for (const origin of [`http://127.0.0.1:9999`, `http://localhost:8080`]) {
    const rejected = await call80("/api/ai/profiles", { headers: { Origin: origin } });
    assert.equal(rejected.status, 403, `${origin} must be rejected`);
    assert.equal(rejected.json.code, "ORIGIN_REJECTED");
  }
});
