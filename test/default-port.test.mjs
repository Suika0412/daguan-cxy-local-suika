import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquireServiceInstance, SERVICE_API_PROTOCOL } from "../local-server/instance-lock.mjs";

const execFileAsync = promisify(execFile);

// 本地中控台的默认启动端口是 8247。它必须保留 PORT 环境变量覆盖，
// 以及服务实例复用与端口冲突向上寻找的处理方式。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 8247;
// 隔离副本与临时文件目录：优先 DAGUAN_TEST_TMP（CI 提供工作区目录），
// 本地 Windows 默认 F:\AI\tmp，其他平台用系统临时目录。该目录同时作为子进程的 TEMP/TMP。
const TMP_ROOT = process.env.DAGUAN_TEST_TMP || (process.platform === "win32" ? "F:\\AI\\tmp" : os.tmpdir());
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const running = new Set();
const tempDirs = new Set();

test.afterEach(async () => {
  for (const child of [...running]) await stopServer(child).catch(() => {});
  for (const dir of tempDirs) await fsp.rm(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  // Node/Chromium 拦截若干低位 HTTP 端口，因此只使用 12000 以上的端口。
  return port >= 12000 ? port : unusedPort();
}

async function isolatedDir(prefix) {
  // 先确保父目录存在：DAGUAN_TEST_TMP 可能指向尚未创建的工作区目录。
  await fsp.mkdir(TMP_ROOT, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(TMP_ROOT, prefix));
  tempDirs.add(dir);
  return dir;
}

// 直接用 node:http 且不复用连接：服务优雅退出时不必等待 keep-alive 空闲连接。
function request(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(5000, () => req.destroy(new Error(`请求超时: ${url}`)));
    req.once("error", reject);
    req.end();
  });
}

function startServer(root, dataDir, port) {
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DAGUAN_ROOT_DIR: root,
    DAGUAN_WEB_ROOT: path.join(root, "web"),
    DAGUAN_DATA_DIR: dataDir,
    DAGUAN_OPEN_BROWSER: "0",
    TEMP: TMP_ROOT,
    TMP: TMP_ROOT,
  };
  // 隔离副本必须自证不依赖宿主：不继承 NODE_PATH，也不让宿主通过
  // NODE_OPTIONS 预加载模块；题库自动更新同样关闭。
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  delete env.DAGUAN_AUTO_UPDATE_BANK;
  let output = "";
  const child = spawn(process.execPath, [path.join(root, "local-server", "server.mjs")], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.outputText = () => output;
  child.once("close", () => running.delete(child));
  running.add(child);
  return child;
}

async function waitReady(child, port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`服务进程提前退出（${child.exitCode}）：${child.outputText()}`);
    try {
      const response = await request(`http://127.0.0.1:${port}/api/health`);
      const health = JSON.parse(response.body);
      if (response.status === 200 && health.service === "daguan-local-console") return health;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`服务未在期限内启动：${child.outputText()}\n健康检查：${lastError?.message || "未收到有效服务身份"}`, { cause: lastError });
}

async function waitClosed(child, timeoutMs = 15000) {
  if (child.exitCode != null) return { code: child.exitCode, output: child.outputText() };
  const closed = once(child, "close");
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`服务退出超时：${child.outputText()}`)), timeoutMs).unref();
  });
  const [code] = await Promise.race([closed, timeout]);
  return { code, output: child.outputText() };
}

async function stopServer(child) {
  if (child.exitCode != null) return;
  try {
    child.send({ type: "shutdown" });
    await waitClosed(child, 8000);
  } catch {
    child.kill("SIGKILL");
    await waitClosed(child, 3000).catch(() => {});
  }
}

// Windows PowerShell 5.1 的 AST 只统计真正的命令调用：注释不产生节点，
// 字串只在作为命令名或 Get-Command 参数时才计入。
async function inspectPowerShellCommands(scriptPath) {
  const probe = path.join(await isolatedDir("daguan-ps-ast-"), "commands.ps1");
  await fsp.writeFile(probe, [
    "param([string]$TargetPath)",
    "$tokens = $null; $errors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseFile($TargetPath, [ref]$tokens, [ref]$errors)",
    "Write-Output ('errors=' + (($errors | ForEach-Object { $_.ErrorId }) -join '|'))",
    "$commands = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true)",
    "foreach ($command in $commands) {",
    "  $first = $command.CommandElements[0]",
    "  $arguments = @($command.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text }) -join '|'",
    "  [pscustomobject]@{ name = [string]$command.GetCommandName(); element = $first.Extent.Text; member = ($first -is [System.Management.Automation.Language.MemberExpressionAst]); operator = [string]$command.InvocationOperator; arguments = $arguments } | ConvertTo-Json -Compress",
    "}",
  ].join("\n"), "utf8");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probe, scriptPath], { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const lines = stdout.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  const parseErrors = lines.find((line) => line.startsWith("errors="))?.slice("errors=".length);
  if (parseErrors) throw new Error(`PowerShell 解析启动脚本失败: ${parseErrors}`);
  return lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
}

test("服务默认端口为 8247，且仍可由 PORT 环境变量覆盖", () => {
  // server.mjs 是运行时默认端口的唯一来源，PORT 未设置时才回退到 8247。
  assert.match(read("local-server/server.mjs"), /const PORT = Number\(process\.env\.PORT \|\| 8247\);/);
});

test("Windows 与源码启动器从 8247 起向上寻找可用端口", () => {
  const launcher = read("scripts/start-windows.ps1");
  assert.match(launcher, /^\$port = 8247\r?$/m);
  // 端口占用时仍逐个向上重试，保留冲突恢复行为。
  assert.match(launcher, /^\s*\$port \+= 1\r?$/m);
});

test("Windows 启动器不再调用 npm，直接用 Node 运行本地中控台", async (t) => {
  // PowerShell 解析只在 Windows 上执行；其他平台明确跳过，不做跨平台猜测。
  if (process.platform !== "win32") return t.skip("Windows PowerShell 解析检查仅在 Windows 上执行");
  const commands = await inspectPowerShellCommands(path.join(ROOT, "scripts", "start-windows.ps1"));
  // 双击启动不能依赖 npm：直接调用、动态 $runtime.Npm 或查找 npm 都算回到依赖安装路径。
  assert.deepEqual(commands.filter((command) => /^npm(\.cmd|\.exe)?$/i.test(command.name)), [], "启动脚本不应直接调用 npm");
  assert.deepEqual(commands.filter((command) => command.member && /\.Npm$/i.test(command.element)).map((command) => command.element), [], "启动脚本不应通过 $runtime.Npm 之类的动态调用 npm");
  assert.deepEqual(commands.filter((command) => /^(get-command|where(\.exe)?)$/i.test(command.name) && /npm/i.test(command.arguments)).map((command) => command.arguments), [], "启动脚本不应查找 npm 命令");
  // 仍然用便携/系统 Node 直接运行 local-server/server.mjs。
  assert.ok(commands.some((command) => command.member && command.element === "$runtime.Node" && command.operator === "Ampersand"), "启动脚本应直接以 & $runtime.Node 调用 Node");
  // 便携 Node 的下载与校验保留。这是结构断言，不代表已实际执行过下载。
  const launcher = read("scripts/start-windows.ps1");
  assert.match(launcher, /Invoke-WebRequest -Uri \$NodeUrl -OutFile \$NodeZip -UseBasicParsing/);
  assert.match(launcher, /Get-FileHash -Algorithm SHA256 -LiteralPath \$NodeZip/);
});

test("隔离副本不含 node_modules 即可启动服务并返回真实静态资源", async () => {
  // 真实启动一份隔离副本，用它证明服务只依赖 Node 内置模块与仓库内文件。
  const root = await isolatedDir("daguan-isolated-");
  const dataDir = path.join(root, "data");
  const webDir = path.join(root, "web");
  await fsp.cp(path.join(ROOT, "local-server"), path.join(root, "local-server"), { recursive: true });
  await fsp.cp(path.join(ROOT, "shared"), path.join(root, "shared"), { recursive: true });
  await fsp.mkdir(path.join(webDir, "vendor"), { recursive: true });
  await fsp.mkdir(path.join(webDir, "data"), { recursive: true });
  await fsp.copyFile(path.join(ROOT, "web", "index.html"), path.join(webDir, "index.html"));
  await fsp.copyFile(path.join(ROOT, "web", "vendor", "katex.min.css"), path.join(webDir, "vendor", "katex.min.css"));
  await fsp.copyFile(path.join(ROOT, "web", "data", "manifest.json"), path.join(webDir, "data", "manifest.json"));
  // 副本没有 node_modules，测试才真的证明服务不需要安装依赖。
  assert.equal(fs.existsSync(path.join(root, "node_modules")), false);

  const port = await unusedPort();
  const child = startServer(root, dataDir, port);
  const health = await waitReady(child, port);
  assert.equal(health.service, "daguan-local-console", child.outputText());
  assert.equal(health.port, port);
  assert.equal(health.apiProtocol, SERVICE_API_PROTOCOL);

  // 三份静态资源都要返回 200 且内容为副本中的真实文件，而不是兜底 HTML。
  const index = await request(`http://127.0.0.1:${port}/index.html`);
  assert.equal(index.status, 200);
  assert.match(index.headers["content-type"], /^text\/html/);
  assert.equal(index.body, await fsp.readFile(path.join(ROOT, "web", "index.html"), "utf8"));

  const katex = await request(`http://127.0.0.1:${port}/vendor/katex.min.css`);
  assert.equal(katex.status, 200);
  assert.match(katex.headers["content-type"], /^text\/css/);
  assert.ok(katex.body.includes("KaTeX_AMS"), "katex.min.css 内容应为真实样式表");
  assert.ok(!katex.body.includes("<!DOCTYPE"), "katex.min.css 不应是 HTML 兜底内容");

  const manifest = await request(`http://127.0.0.1:${port}/data/manifest.json`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers["content-type"], /^application\/json/);
  const served = JSON.parse(manifest.body);
  assert.equal(served.total, JSON.parse(read("web/data/manifest.json")).total);
  assert.ok(served.total > 0);

  // 未复制进副本的页面返回 404，证明服务读取的是隔离目录而不是仓库本身。
  assert.equal((await request(`http://127.0.0.1:${port}/landing.html`)).status, 404);

  // 通过 IPC 优雅退出，并确认实例锁随进程一起释放。
  child.send({ type: "shutdown" });
  const closed = await waitClosed(child);
  assert.equal(closed.code, 0, closed.output);
  assert.equal(fs.existsSync(path.join(dataDir, ".service-instance.json")), false);
});

test("浏览器包从 8247 起扫描可用端口", () => {
  const sea = read("packaging/sea-entry.cjs");
  assert.match(sea, /for \(let port = 8247; port <= 8266; port \+= 1\)/);
});

test("未显式指定端口时，服务实例锁记录默认端口 8247", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "daguan-default-port-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const lease = await acquireServiceInstance(dir);
  assert.equal(lease.acquired, true);
  t.after(() => lease.release());
  const owner = JSON.parse(await fsp.readFile(path.join(dir, ".service-instance.json"), "utf8"));
  assert.equal(owner.port, DEFAULT_PORT);
  assert.equal(owner.host, "127.0.0.1");
});
