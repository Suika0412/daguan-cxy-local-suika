import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// At-rest secret format: `<backendCipherTag>:<base64 payload>`. The tag lets us
// detect a cipher produced by a different backend (e.g. a Linux `mem1` cipher
// opened on Windows DPAPI) and report it as unreadable instead of crashing.
export const SECRET_FORMAT = "daguan-ai-secret-v1";

const POWERSHELL_TIMEOUT_MS = 15_000;
const MAX_BRIDGE_OUTPUT = 1024 * 1024;

export class SecretBackendError extends Error {
  constructor(message, { code = "SECRET_BACKEND_UNAVAILABLE", cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SecretBackendError";
    this.code = code;
  }
}

// Fixed bridge script. It is embedded in this module (no shipped .ps1, no temp
// file) and passed through `-EncodedCommand`; the secret itself only ever
// travels over stdin. `-EncodedCommand` carries this constant script, never
// secret material.
const DPAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch { try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop } catch { } }",
  "$raw = [Console]::In.ReadToEnd()",
  "try {",
  "  $request = $raw | ConvertFrom-Json",
  "  if ([string]$request.format -ne 'daguan-ai-secret-v1') { throw 'unsupported-format' }",
  "  $bytes = [Convert]::FromBase64String([string]$request.data)",
  "  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser",
  "  if ([string]$request.op -eq 'protect') {",
  "    $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)",
  "  } elseif ([string]$request.op -eq 'unprotect') {",
  "    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)",
  "  } else { throw 'unsupported-operation' }",
  "  $response = @{ ok = $true; data = [Convert]::ToBase64String($result) }",
  "} catch {",
  "  $response = @{ ok = $false; error = $_.Exception.GetType().Name }",
  "}",
  "[Console]::Out.Write(($response | ConvertTo-Json -Compress))",
].join("\n");

function base64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

export function splitCipher(value) {
  const text = String(value ?? "");
  const index = text.indexOf(":");
  if (index <= 0) return { tag: "", payload: "" };
  return { tag: text.slice(0, index), payload: text.slice(index + 1) };
}

export function cipherTag(value) {
  return splitCipher(value).tag;
}

// Resolve the full path to Windows PowerShell without trusting PATH first: a
// hijacked PATH entry must not be able to intercept the bridge process.
export function resolveWindowsPowerShell() {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const full = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    if (fs.existsSync(full)) return full;
  } catch { /* fall through to PATH lookup */ }
  return "powershell.exe";
}

function defaultBridgeArgs() {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(DPAPI_SCRIPT, "utf16le").toString("base64")];
}

// `spawnArgs` is a test-only seam for exercising the bridge failure paths with a
// fake child process. It must never be set from request input or configuration.
function runDpapiBridge({ op, data }, { command, spawnArgs, timeoutMs = POWERSHELL_TIMEOUT_MS } = {}) {
  const executable = command || resolveWindowsPowerShell();
  // Base64-only ASCII: immune to console code page differences on stdin/stdout.
  const payload = JSON.stringify({ format: SECRET_FORMAT, op, data: base64(data) });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, Array.isArray(spawnArgs) ? spawnArgs : defaultBridgeArgs(), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (cause) {
      reject(new SecretBackendError("无法启动 Windows DPAPI 桥接程序", { cause }));
      return;
    }
    const out = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => fail(new SecretBackendError("DPAPI 调用超时", { code: "SECRET_BACKEND_UNAVAILABLE" })), timeoutMs);
    function settle(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    }
    function fail(error) {
      try { child.kill(); } catch { /* already gone */ }
      settle(error);
    }
    child.stdout.on("data", (chunk) => {
      if (size + chunk.length > MAX_BRIDGE_OUTPUT) return fail(new SecretBackendError("DPAPI 桥接程序返回内容过大", { code: "SECRET_BACKEND_UNAVAILABLE" }));
      size += chunk.length;
      out.push(chunk);
    });
    // Drain stderr so the child can not block on a full pipe, but never surface
    // its content: a child process's output is not a trusted error channel.
    child.stderr.on("data", () => {});
    child.once("error", (cause) => fail(new SecretBackendError("DPAPI 桥接程序无法执行", { cause })));
    child.once("close", (code) => {
      if (settled) return;
      let parsed = null;
      try { parsed = JSON.parse(Buffer.concat(out).toString("utf8").trim()); } catch { parsed = null; }
      if (!parsed) {
        // No usable response at all: report the backend as unavailable, with the
        // numeric exit code only. The bridge's stderr and stdout are never
        // echoed, so child output can not smuggle credential material upward.
        fail(new SecretBackendError(`DPAPI 桥接程序未返回有效响应（退出码 ${Number.isInteger(code) ? code : "未知"}）`, { code: "SECRET_BACKEND_UNAVAILABLE" }));
        return;
      }
      if (parsed.ok !== true) {
        fail(new SecretBackendError(`DPAPI ${op === "protect" ? "加密" : "解密"}失败（退出码 ${Number.isInteger(code) ? code : "未知"}）`, { code: op === "protect" ? "SECRET_ENCRYPT_FAILED" : "SECRET_DECRYPT_FAILED" }));
        return;
      }
      settle(null, Buffer.from(String(parsed.data || ""), "base64"));
    });
    child.stdin.on("error", () => { /* the exit path reports the failure */ });
    child.stdin.end(payload);
  });
}

// A verified-success probe is cached for the process lifetime, but a failed
// probe is only remembered briefly: DPAPI can fail transiently (spawning
// PowerShell under load), and caching that forever would report a perfectly
// working backend as unavailable until restart.
const AVAILABLE_RETRY_MS = 5_000;

export function createDpapiSecretBackend({ command, spawnArgs, timeoutMs, availableRetryMs = AVAILABLE_RETRY_MS, platform = process.platform } = {}) {
  const tag = "dpapi1";
  const description = "Windows DPAPI（CurrentUser 范围）";
  let confirmed = false;
  let failedAt = 0;
  const bridge = (op, data) => runDpapiBridge({ op, data }, { command, spawnArgs, timeoutMs });
  function markAvailable() {
    confirmed = true;
    failedAt = 0;
  }
  function unavailable() {
    return new SecretBackendError("DPAPI 仅在 Windows 上可用，当前平台没有可用的 DPAPI", { code: "SECRET_BACKEND_UNAVAILABLE" });
  }
  return {
    id: "dpapi",
    cipherTag: tag,
    persistent: true,
    encrypted: true,
    description,
    async available() {
      if (platform !== "win32") return false;
      if (confirmed) return true;
      if (failedAt && Date.now() - failedAt < availableRetryMs) return false;
      try {
        const sample = Buffer.from("daguan-dpapi-probe", "utf8");
        const sealed = await bridge("protect", sample);
        const opened = await bridge("unprotect", sealed);
        if (!opened.equals(sample)) { failedAt = Date.now(); return false; }
        markAvailable();
        return true;
      } catch {
        failedAt = Date.now();
        return false;
      }
    },
    async protect(value) {
      if (platform !== "win32") throw unavailable();
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
      let sealed;
      try {
        sealed = await bridge("protect", buffer);
      } catch (cause) {
        // Errors already carry a fixed message + code. Anything unexpected is
        // wrapped with fixed text only: no backend metadata is interpolated, so
        // a message that reaches an HTTP response can never echo foreign data.
        if (cause instanceof SecretBackendError) throw cause;
        throw new SecretBackendError("DPAPI 密钥加密失败", { code: "SECRET_ENCRYPT_FAILED", cause });
      }
      // A successful round-trip is proof of availability, so status can never
      // contradict an operation that just worked.
      markAvailable();
      return `${tag}:${base64(sealed)}`;
    },
    async unprotect(cipher) {
      const { tag: found, payload } = splitCipher(cipher);
      if (found !== tag || !payload) throw new SecretBackendError("密钥密文不是本机 DPAPI 格式", { code: "SECRET_DECRYPT_FAILED" });
      if (platform !== "win32") throw unavailable();
      try {
        const opened = (await bridge("unprotect", Buffer.from(payload, "base64"))).toString("utf8");
        markAvailable();
        return opened;
      } catch (cause) {
        throw new SecretBackendError("DPAPI 无法解密该密钥密文（可能来自其他 Windows 账户或另一台机器，或密文已损坏）", { code: "SECRET_DECRYPT_FAILED", cause });
      }
    },
  };
}

export function createMemorySecretBackend({ key = crypto.randomBytes(32), id = "memory" } = {}) {
  const tag = "mem1";
  return {
    id,
    cipherTag: tag,
    // No persistence: the AES key lives in this process only, so ciphertext
    // written now cannot be decrypted after a restart. Reported as
    // `persistent: false` instead of silently degrading to plaintext.
    persistent: false,
    encrypted: true,
    description: "进程内存密钥（仅本进程有效，重启后无法解密）",
    async available() { return true; },
    async protect(value) {
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const sealed = Buffer.concat([cipher.update(buffer), cipher.final()]);
      return `${tag}:${base64(Buffer.concat([iv, cipher.getAuthTag(), sealed]))}`;
    },
    async unprotect(cipher) {
      const { tag: found, payload } = splitCipher(cipher);
      if (found !== tag || !payload) throw new SecretBackendError("密钥密文不是本进程内存格式", { code: "SECRET_DECRYPT_FAILED" });
      try {
        const raw = Buffer.from(payload, "base64");
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      } catch (cause) {
        throw new SecretBackendError("无法用本进程内存密钥解密该密文（服务重启后旧密文不可读）", { code: "SECRET_DECRYPT_FAILED", cause });
      }
    },
  };
}

export function createNoneSecretBackend() {
  const unavailable = () => { throw new SecretBackendError("当前环境不提供可用的密钥存储后端，已拒绝保存密钥", { code: "SECRET_BACKEND_UNAVAILABLE" }); };
  return {
    id: "none",
    cipherTag: "",
    persistent: false,
    encrypted: false,
    description: "不保存密钥（仅当次会话可用）",
    async available() { return false; },
    async protect() { return unavailable(); },
    async unprotect() { return unavailable(); },
  };
}

// Deterministic backend for tests: reversible so a round-trip can be asserted,
// while the plaintext never appears verbatim in the stored ciphertext. The
// fixed marker gives it AEAD-like integrity, so a wrong key or a tampered
// payload fails closed instead of returning mangled plaintext.
const TEST_MARKER = Buffer.from("DGS1", "utf8");

export function createTestSecretBackend({ xor = 0x5a, key = xor, tag = "test1", persistent = true, failProtect = false, failUnprotect = false } = {}) {
  const transform = (buffer, factor) => Buffer.from(buffer).map((byte) => byte ^ factor);
  return {
    id: "test",
    cipherTag: tag,
    persistent,
    encrypted: true,
    description: "测试用可预测后端",
    async available() { return !failProtect; },
    async protect(value) {
      if (failProtect) throw new SecretBackendError("测试后端拒绝加密", { code: "SECRET_ENCRYPT_FAILED" });
      const body = Buffer.concat([TEST_MARKER, Buffer.from(String(value ?? ""), "utf8")]);
      return `${tag}:${base64(transform(body, xor))}`;
    },
    async unprotect(cipher) {
      const { tag: found, payload } = splitCipher(cipher);
      if (failUnprotect) throw new SecretBackendError("测试后端拒绝解密", { code: "SECRET_DECRYPT_FAILED" });
      if (found !== tag || !payload) throw new SecretBackendError("密钥密文不是测试后端格式", { code: "SECRET_DECRYPT_FAILED" });
      const opened = transform(Buffer.from(payload, "base64"), key);
      if (opened.length < TEST_MARKER.length || !opened.subarray(0, TEST_MARKER.length).equals(TEST_MARKER)) {
        throw new SecretBackendError("测试后端无法校验该密文（密钥不符或密文已损坏）", { code: "SECRET_DECRYPT_FAILED" });
      }
      return opened.subarray(TEST_MARKER.length).toString("utf8");
    },
  };
}

export function normalizeSecretBackend(candidate) {
  const backend = candidate && typeof candidate === "object" ? candidate : null;
  if (!backend) throw new TypeError("secretBackend 必须是对象");
  for (const method of ["protect", "unprotect"]) {
    if (typeof backend[method] !== "function") throw new TypeError(`secretBackend 缺少 ${method}() 方法`);
  }
  return {
    id: String(backend.id || "custom"),
    cipherTag: String(backend.cipherTag || ""),
    // Unknown injected backends are reported conservatively: we do not claim
    // persistence or encryption we cannot verify.
    persistent: backend.persistent === true,
    encrypted: backend.encrypted === true,
    description: String(backend.description || "自定义密钥后端"),
    available: typeof backend.available === "function" ? () => backend.available() : async () => true,
    protect: (value) => backend.protect(value),
    unprotect: (value) => backend.unprotect(value),
  };
}

export function createSecretBackend({ secretBackend = null, platform = process.platform } = {}) {
  if (secretBackend) return normalizeSecretBackend(secretBackend);
  if (platform === "win32") return createDpapiSecretBackend({ platform });
  return createMemorySecretBackend();
}
