import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SECRET_FORMAT,
  SecretBackendError,
  cipherTag,
  createDpapiSecretBackend,
  createMemorySecretBackend,
  createNoneSecretBackend,
  createSecretBackend,
  createTestSecretBackend,
  normalizeSecretBackend,
  resolveWindowsPowerShell,
  splitCipher,
} from "../local-server/ai-secrets.mjs";

const FAKE_KEY = "sk-fake-probe-key-1234567890";
const isWindows = process.platform === "win32";

// Fake bridge children. They only need Node itself, so the DPAPI failure paths
// can be exercised without PowerShell, extra dependencies or a real key.
const ECHO_CHILD = `let raw="";process.stdin.on("data",c=>{raw+=c});process.stdin.on("end",()=>{const q=JSON.parse(raw);process.stdout.write(JSON.stringify({ok:true,data:q.data}))});`;
const HANG_CHILD = `process.stdin.resume();setTimeout(()=>{},60000);`;
const GARBAGE_CHILD = `console.log("not-json-at-all");process.exit(0);`;
const NOISY_CHILD = `process.stderr.write("CHILD-STDERR-LEAK-marker");console.log("not-json-at-all");process.exit(3);`;
const REFUSE_CHILD = `let raw="";process.stdin.on("data",c=>{raw+=c});process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({ok:false,error:"SomeExceptionFromChild"}))});`;
const FAIL_ONCE_CHILD = `const fs=require("node:fs");let raw="";process.stdin.on("data",c=>{raw+=c});process.stdin.on("end",()=>{const marker=process.argv[2];if(!fs.existsSync(marker)){fs.writeFileSync(marker,"1");process.stdout.write("boom");process.exit(1)}const q=JSON.parse(raw);process.stdout.write(JSON.stringify({ok:true,data:q.data}))});`;

async function fakeBridge(t, name, source) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-secret-bridge-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, `${name}.cjs`);
  await fs.writeFile(script, source, "utf8");
  return { dir, script, marker: path.join(dir, "marker") };
}

// platform is forced to "win32" so this exercises the bridge plumbing on any OS
// while never touching real DPAPI.
function bridgedBackend({ script, marker, timeoutMs = 800, availableRetryMs } = {}) {
  return createDpapiSecretBackend({
    command: process.execPath,
    spawnArgs: marker ? [script, marker] : [script],
    timeoutMs,
    availableRetryMs,
    platform: "win32",
  });
}

async function rejectionCode(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error?.code || error?.name || "unknown";
  }
}

test("内存后端加密往返，密文不含明文，跨实例无法解密", async () => {
  const backend = createMemorySecretBackend();
  assert.equal(backend.id, "memory");
  assert.equal(backend.encrypted, true);
  assert.equal(backend.persistent, false, "内存后端必须显式声明不持久化");
  assert.equal(await backend.available(), true);

  const cipher = await backend.protect(FAKE_KEY);
  assert.match(cipher, /^mem1:/);
  assert.equal(cipher.includes(FAKE_KEY), false);
  assert.equal(await backend.unprotect(cipher), FAKE_KEY);

  // A fresh instance stands in for a restarted process: the AES key is new, so
  // the old ciphertext must be reported as unreadable instead of silently
  // falling back to plaintext.
  const restarted = createMemorySecretBackend();
  assert.equal(await rejectionCode(restarted.unprotect(cipher)), "SECRET_DECRYPT_FAILED");
  assert.equal(await rejectionCode(backend.unprotect("mem1:not-base64-cipher")), "SECRET_DECRYPT_FAILED");
});

test("测试后端可预测且拒绝加密/解密时有稳定错误码", async () => {
  const backend = createTestSecretBackend();
  const cipher = await backend.protect(FAKE_KEY);
  assert.match(cipher, /^test1:/);
  assert.equal(cipher.includes(FAKE_KEY), false);
  assert.equal(await backend.unprotect(cipher), FAKE_KEY);
  assert.equal(await backend.unprotect(await backend.protect(FAKE_KEY)), FAKE_KEY);

  const broken = createTestSecretBackend({ failProtect: true });
  assert.equal(await broken.available(), false);
  assert.equal(await rejectionCode(broken.protect(FAKE_KEY)), "SECRET_ENCRYPT_FAILED");
  const noDecrypt = createTestSecretBackend({ failUnprotect: true });
  assert.equal(await rejectionCode(noDecrypt.unprotect(cipher)), "SECRET_DECRYPT_FAILED");

  // Wrong XOR factor: same tag, wrong key material. Must fail, never return
  // mangled plaintext that would be sent upstream as a credential.
  const wrongKey = createTestSecretBackend({ key: 0x11 });
  assert.equal(await rejectionCode(wrongKey.unprotect(cipher)), "SECRET_DECRYPT_FAILED");
});

test("密文标签识别后端来源与跨后端误用", async () => {
  const memory = createMemorySecretBackend();
  const testBackend = createTestSecretBackend();
  assert.equal(cipherTag(await memory.protect("x")), "mem1");
  assert.equal(cipherTag(await testBackend.protect("x")), "test1");
  assert.deepEqual(splitCipher("test1:AA"), { tag: "test1", payload: "AA" });
  assert.deepEqual(splitCipher("no-tag"), { tag: "", payload: "" });
  assert.deepEqual(splitCipher(""), { tag: "", payload: "" });

  const crossBackend = await memory.protect(FAKE_KEY);
  assert.equal(await rejectionCode(testBackend.unprotect(crossBackend)), "SECRET_DECRYPT_FAILED");
  assert.equal(await rejectionCode(memory.unprotect(await testBackend.protect(FAKE_KEY))), "SECRET_DECRYPT_FAILED");
});

test("none 后端拒绝一切密钥操作，不提供明文降级", async () => {
  const backend = createNoneSecretBackend();
  assert.equal(backend.encrypted, false);
  assert.equal(backend.persistent, false);
  assert.equal(await backend.available(), false);
  assert.equal(await rejectionCode(backend.protect(FAKE_KEY)), "SECRET_BACKEND_UNAVAILABLE");
  assert.equal(await rejectionCode(backend.unprotect("mem1:AA")), "SECRET_BACKEND_UNAVAILABLE");
});

test("默认后端按平台解析：Windows 走 DPAPI，其他平台走内存", () => {
  const windows = createSecretBackend({ platform: "win32" });
  assert.equal(windows.id, "dpapi");
  assert.equal(windows.encrypted, true);
  assert.equal(windows.persistent, true);

  for (const platform of ["linux", "darwin", "freebsd"]) {
    const backend = createSecretBackend({ platform });
    assert.equal(backend.id, "memory");
    assert.equal(backend.encrypted, true);
    assert.equal(backend.persistent, false);
  }

  // Injected backends win over the platform default (test seam).
  const injected = createTestSecretBackend();
  assert.equal(createSecretBackend({ secretBackend: injected, platform: "win32" }).id, "test");
});

test("注入的后端先校验形状，未知后端不虚报加密与持久化", async () => {
  assert.throws(() => normalizeSecretBackend(null), /secretBackend 必须是对象/);
  assert.throws(() => normalizeSecretBackend({ protect: async () => "" }), /unprotect/);
  assert.throws(() => normalizeSecretBackend({ unprotect: async () => "" }), /protect/);

  const custom = normalizeSecretBackend({ protect: async (value) => `x:${value}`, unprotect: async (value) => String(value).slice(2) });
  assert.equal(custom.id, "custom");
  assert.equal(custom.encrypted, false, "无法核实的后端不得声明已加密");
  assert.equal(custom.persistent, false, "无法核实的后端不得声明持久化");
  assert.equal(await custom.available(), true);
  assert.equal(await custom.protect(FAKE_KEY), `x:${FAKE_KEY}`);
  assert.equal(await custom.unprotect(`x:${FAKE_KEY}`), FAKE_KEY);
});

test("SECRET_FORMAT 与错误类型可用于调用方分支", () => {
  assert.equal(SECRET_FORMAT, "daguan-ai-secret-v1");
  const error = new SecretBackendError("占位", { code: "SECRET_DECRYPT_FAILED" });
  assert.equal(error.name, "SecretBackendError");
  assert.equal(error.code, "SECRET_DECRYPT_FAILED");
  assert.equal(error instanceof Error, true);
  assert.equal(new SecretBackendError("占位").code, "SECRET_BACKEND_UNAVAILABLE");
});

test("后端错误信息只含固定文案，不回显明文、密文或输入", async () => {
  const memory = createMemorySecretBackend();
  const cipher = await memory.protect(FAKE_KEY);
  const payload = splitCipher(cipher).payload;
  const filler = Buffer.from("garbage-probe-bytes").toString("base64");

  const attempts = [
    () => createMemorySecretBackend().unprotect(cipher),
    () => memory.unprotect(`mem1:${filler}`),
    () => memory.unprotect(`test1:${payload}`),
    () => createTestSecretBackend().unprotect(cipher),
    () => createTestSecretBackend({ failUnprotect: true }).unprotect(cipher),
    () => createTestSecretBackend({ failProtect: true }).protect(FAKE_KEY),
    () => createNoneSecretBackend().protect(FAKE_KEY),
    () => createNoneSecretBackend().unprotect(cipher),
  ];
  if (isWindows) {
    const dpapi = createDpapiSecretBackend();
    attempts.push(
      () => dpapi.unprotect(`dpapi1:${filler}`),
      () => dpapi.unprotect(`mem1:${payload}`),
      () => dpapi.unprotect(cipher.slice(0, -8)),
    );
  }

  for (const attempt of attempts) {
    const error = await attempt().then(() => null, (cause) => cause);
    assert.ok(error, "该操作必须失败而不是返回垃圾明文");
    assert.equal(typeof error.code, "string", `错误码缺失：${error.name}`);
    // 消息里不允许出现明文 Key、密文内容或注入的填充内容。
    assert.doesNotMatch(error.message, /sk-fake-probe-key/);
    assert.doesNotMatch(error.message, /garbage-probe-bytes|Z2FyYmFnZQ/);
    assert.equal(error.message.includes(payload.slice(0, 24)), false);
    assert.equal(error.message.length < 200, true, "错误信息应保持固定且简短");
  }
});

test("DPAPI 桥接：命令不存在时报告不可用且不回显路径", async () => {
  const backend = createDpapiSecretBackend({ command: "definitely-not-a-real-bridge-exe-xyz", spawnArgs: [], timeoutMs: 800 });
  assert.equal(await backend.available(), false);
  const error = await backend.protect(FAKE_KEY).then(() => null, (cause) => cause);
  assert.ok(error);
  assert.equal(error.code, "SECRET_BACKEND_UNAVAILABLE");
  assert.doesNotMatch(error.message, /definitely-not-a-real-bridge-exe-xyz/);
  assert.doesNotMatch(error.message, /sk-fake-probe-key/);
});

test("DPAPI 桥接：非 Windows 平台直接 fail-closed", async () => {
  const backend = createDpapiSecretBackend({ platform: "linux" });
  assert.equal(await backend.available(), false);
  const protectError = await backend.protect(FAKE_KEY).then(() => null, (cause) => cause);
  assert.equal(protectError.code, "SECRET_BACKEND_UNAVAILABLE");
  assert.match(protectError.message, /仅在 Windows/);
  const decryptError = await backend.unprotect(`dpapi1:${Buffer.from("x").toString("base64")}`).then(() => null, (cause) => cause);
  assert.equal(decryptError.code, "SECRET_BACKEND_UNAVAILABLE");
  assert.match(decryptError.message, /仅在 Windows/);
});

test("DPAPI 桥接：超时被中止并报告不可用", async (t) => {
  const { script } = await fakeBridge(t, "hang", HANG_CHILD);
  const backend = bridgedBackend({ script, timeoutMs: 350 });
  const started = Date.now();
  const error = await backend.protect(FAKE_KEY).then(() => null, (cause) => cause);
  assert.ok(error, "挂起的桥接必须超时失败");
  assert.equal(error.code, "SECRET_BACKEND_UNAVAILABLE");
  assert.match(error.message, /超时/);
  assert.equal(Date.now() - started < 10_000, true, "超时后应立即返回而不是等到子进程结束");
});

test("DPAPI 桥接：无有效响应时不回显子进程 stdout/stderr", async (t) => {
  const garbage = await fakeBridge(t, "garbage", GARBAGE_CHILD);
  const parseError = await bridgedBackend({ script: garbage.script }).protect(FAKE_KEY).then(() => null, (cause) => cause);
  assert.equal(parseError.code, "SECRET_BACKEND_UNAVAILABLE");
  assert.doesNotMatch(parseError.message, /not-json-at-all/);
  assert.match(parseError.message, /退出码 0/);

  const noisy = await fakeBridge(t, "noisy", NOISY_CHILD);
  const noisyError = await bridgedBackend({ script: noisy.script }).protect(FAKE_KEY).then(() => null, (cause) => cause);
  assert.equal(noisyError.code, "SECRET_BACKEND_UNAVAILABLE");
  assert.doesNotMatch(noisyError.message, /CHILD-STDERR-LEAK-marker/, "子进程 stderr 不得进入错误信息");
  assert.doesNotMatch(noisyError.message, /not-json-at-all/);
  assert.match(noisyError.message, /退出码 3/);
});

test("DPAPI 桥接：结构化失败按操作区分加密/解密错误码且不回显原文", async (t) => {
  const { script } = await fakeBridge(t, "refuse", REFUSE_CHILD);
  const backend = bridgedBackend({ script });
  const protectError = await backend.protect(FAKE_KEY).then(() => null, (cause) => cause);
  assert.equal(protectError.code, "SECRET_ENCRYPT_FAILED");
  assert.doesNotMatch(protectError.message, /SomeExceptionFromChild/);
  const decryptError = await backend.unprotect(`dpapi1:${Buffer.from("payload").toString("base64")}`).then(() => null, (cause) => cause);
  assert.equal(decryptError.code, "SECRET_DECRYPT_FAILED");
  assert.doesNotMatch(decryptError.message, /SomeExceptionFromChild/);
});

test("DPAPI 桥接：成功的往返会确认可用，失败的探测不会永久缓存", async (t) => {
  // 正常桥接：available() 为 true，且成功加密后仍一致为 true。
  const echo = await fakeBridge(t, "echo", ECHO_CHILD);
  const good = bridgedBackend({ script: echo.script });
  assert.equal(await good.available(), true);
  const cipher = await good.protect(FAKE_KEY);
  assert.equal(await good.available(), true, "成功加密后 available 必须一致为 true");
  assert.equal(await good.unprotect(cipher), FAKE_KEY);

  // 首次探测失败、之后可用：失败结果必须能失效，而不是把后端永久判为不可用。
  const flaky = await fakeBridge(t, "fail-once", FAIL_ONCE_CHILD);
  const recovering = bridgedBackend({ script: flaky.script, marker: flaky.marker, availableRetryMs: 60 });
  assert.equal(await recovering.available(), false, "首次探测应失败");
  assert.equal(await recovering.available(), false, "重试间隔内沿用失败结论，不重复探测");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await recovering.available(), true, "失败结论必须过期后重新探测");
  assert.equal(await recovering.protect(FAKE_KEY).then(() => true, () => false), true);
});

test("Windows 上解析固定 PowerShell 路径", { skip: !isWindows }, () => {
  const command = resolveWindowsPowerShell();
  assert.match(command, /powershell\.exe$/i);
  assert.equal(command.includes("System32"), true, "优先使用系统绝对路径，避免 PATH 劫持");
});

test("Windows DPAPI 真实往返：密文可跨进程解密且不含明文", { skip: !isWindows }, async () => {  const backend = createDpapiSecretBackend();
  assert.equal(await backend.available(), true, "Windows 上 DPAPI 必须可用（fail-closed 前提）");

  const cipher = await backend.protect(FAKE_KEY);
  assert.match(cipher, /^dpapi1:/);
  assert.equal(cipher.includes(FAKE_KEY), false);

  // A second instance stands in for a new process / new Electron helper run.
  const restarted = createDpapiSecretBackend();
  assert.equal(await restarted.unprotect(cipher), FAKE_KEY);

  // Tampered payload must fail closed rather than yield garbage plaintext.
  const { tag, payload } = splitCipher(cipher);
  const tampered = Buffer.from(payload, "base64");
  tampered[0] ^= 0xff;
  assert.equal(await rejectionCode(backend.unprotect(`${tag}:${tampered.toString("base64")}`)), "SECRET_DECRYPT_FAILED");
  assert.equal(await rejectionCode(backend.unprotect(`mem1:${payload}`)), "SECRET_DECRYPT_FAILED");
});
