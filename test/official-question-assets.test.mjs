import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { collectAssetReferences, downloadAssets, syncOfficialQuestionBank } from "../local-server/official-question-bank.mjs";
import { serviceFixture } from "./runtime-fixture.mjs";

const hash = seed => seed.repeat(64).slice(0, 64);
const PNG = hash("a");
const JPEG = hash("b");
const WEBP = hash("c");
const GIF = hash("d");
const MISSING = hash("e");

const tempRoot = () => process.env.DAGUAN_TEST_TMP || os.tmpdir();
async function withTemp(prefix, run) {
  const dir = await fs.mkdtemp(path.join(tempRoot(), prefix));
  try { return await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

// 直接造一个「最终题库目录」：manifest 指向分片，分片里带各种题图引用。
async function writeBank(dir, rows, extra = {}) {
  await fs.mkdir(path.join(dir, "shards"), { recursive: true });
  await fs.writeFile(path.join(dir, "shards/fixture.json"), JSON.stringify(rows));
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ total: rows.length,
    asset_count: 0, shards: { fixture: { file: "shards/fixture.json", count: rows.length } } }));
  for (const [name, body] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), JSON.stringify(body));
  }
}

const withToken = async (token, run) => {
  const previous = process.env.DAGUAN_ASSET_TOKEN;
  if (token == null) delete process.env.DAGUAN_ASSET_TOKEN;
  else process.env.DAGUAN_ASSET_TOKEN = token;
  try { return await run(); } finally {
    if (previous == null) delete process.env.DAGUAN_ASSET_TOKEN;
    else process.env.DAGUAN_ASSET_TOKEN = previous;
  }
};

test("题图引用识别四种扩展，缺扩展按 PNG，其它扩展忽略", async () => {
  await withTemp("daguan-assets-parse-", async dir => {
    await writeBank(dir, [
      { id: 1, stem: `![图](assets/${PNG}.png)` },
      { id: 2, stem: `![图](assets/${JPEG}.jpeg)` },
      { id: 3, stem: `![图](assets/${WEBP}.webp)` },
      { id: 4, stem: `![图](question-assets/${GIF}.gif)` },
      { id: 5, stem: `![图](assets/${MISSING})` },
      { id: 6, stem: `![图](assets/${hash("7")}.bmp)` },
    ]);
    const references = await collectAssetReferences(dir);
    assert.deepEqual([...references.get(PNG)], [".png"]);
    assert.deepEqual([...references.get(JPEG)], [".jpeg"]);
    assert.deepEqual([...references.get(WEBP)], [".webp"]);
    assert.deepEqual([...references.get(GIF)], [".gif"]);
    assert.deepEqual([...references.get(MISSING)], [".png"], "缺扩展按既有 PNG 处理");
    assert.equal(references.has(hash("7")), false, "不支持的扩展不纳入");
    assert.equal(references.size, 5);
  });
});

test("没有 token 时按缺图计数，且不动正文与解析", async () => {
  await withTemp("daguan-assets-notoken-", async dir => {
    await writeBank(dir, [{ id: 1, stem: `题干`, explanation: `解析 ![图](assets/${PNG}.png)` }]);
    const references = await collectAssetReferences(dir);
    await withToken(null, async () => {
      const result = await downloadAssets(references, dir, {});
      assert.equal(result.missing, 1);
      assert.deepEqual(result.failures, []);
    });
    // 扫描解析字符串原样保留：只读收集不改内容。
    const rows = JSON.parse(await fs.readFile(path.join(dir, "shards/fixture.json"), "utf8"));
    assert.equal(rows[0].explanation, `解析 ![图](assets/${PNG}.png)`);
  });
});

test("有 token 时按引用文件名落盘，单张失败计入 missing 与 diagnostics", async () => {
  await withTemp("daguan-assets-download-", async dir => {
    await writeBank(dir, []);
    const references = new Map([[PNG, new Set([".png"])], [JPEG, new Set([".jpeg"])], [MISSING, new Set([".png"])]]);
    const original = globalThis.fetch;
    const requested = [];
    globalThis.fetch = async url => {
      const target = new URL(url);
      if (!target.pathname.startsWith("/api/v1/question-assets/")) throw new Error(`测试未预期的请求：${target.pathname}`);
      const which = target.pathname.split("/").pop();
      requested.push(which);
      if (which === MISSING) return new Response("nope", { status: 404 });
      const contentType = which === JPEG ? "image/jpeg" : "image/png";
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": contentType } });
    };
    try {
      await withToken("secret-token", async () => {
        const result = await downloadAssets(references, dir, {});
        assert.equal(result.missing, 1);
        assert.deepEqual(result.failures, [{ hash: MISSING, extension: ".png", reason: "HTTP 404" }]);
      });
    } finally { globalThis.fetch = original; }
    // 以引用里的扩展名保存，不把非 PNG 统一当 PNG。
    assert.ok(await fs.stat(path.join(dir, "assets", `${PNG}.png`)));
    assert.ok(await fs.stat(path.join(dir, "assets", `${JPEG}.jpeg`)));
    assert.equal((await fs.readdir(path.join(dir, "assets"))).some(name => name === `${JPEG}.png`), false);
    assert.deepEqual(requested.sort(), [JPEG, MISSING, PNG].sort());
  });
});

test("查找顺序覆盖目标、上一活动版本与 bundled，jpg/jpeg 同族互认", async () => {
  await withTemp("daguan-assets-lookup-", async dir => {
    const previous = path.join(dir, "previous");
    const fallback = path.join(dir, "bundled");
    await fs.mkdir(path.join(previous, "assets"), { recursive: true });
    await fs.mkdir(path.join(fallback, "assets"), { recursive: true });
    // 上一活动版本只有 .jpg，引用写的是 .jpeg：同族互认，不必重新下载。
    await fs.writeFile(path.join(previous, "assets", `${JPEG}.jpg`), "jpg");
    await fs.writeFile(path.join(fallback, "assets", `${PNG}.png`), "png");
    const target = path.join(dir, "target");
    await fs.mkdir(path.join(target, "assets"), { recursive: true });
    await fs.writeFile(path.join(target, "assets", `${WEBP}.webp`), "webp");
    const references = new Map([[JPEG, new Set([".jpeg"])], [PNG, new Set([".png"])], [WEBP, new Set([".webp"])]]);
    await withToken(null, async () => {
      const result = await downloadAssets(references, target, {
        previousAssetsDir: path.join(previous, "assets"),
        fallbackAssetsDir: path.join(fallback, "assets"),
      });
      assert.equal(result.missing, 0, "三张都应命中已有文件");
    });
  });
});

test("取消信号在题图下载中显式失败", async () => {
  await withTemp("daguan-assets-abort-", async dir => {
    await writeBank(dir, []);
    const references = new Map([[PNG, new Set([".png"])]]);
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("不应真正下载"); };
    const controller = new AbortController();
    controller.abort(new Error("取消题图下载"));
    try {
      await withToken("secret-token", async () => {
        await assert.rejects(() => downloadAssets(references, dir, { signal: controller.signal }),
          /取消题图下载/);
      });
    } finally { globalThis.fetch = original; }
  });
});

test("已取消时「无需下载」与「无 token」两条早退路径也必须显式失败", async () => {
  await withTemp("daguan-assets-abort-early-", async dir => {
    await fs.mkdir(path.join(dir, "assets"), { recursive: true });
    // 已全部命中：不需要下载。
    await fs.writeFile(path.join(dir, "assets", `${PNG}.png`), "png");
    const satisfied = new Map([[PNG, new Set([".png"])]]);
    const controller = new AbortController();
    controller.abort(new Error("取消已命中"));
    await withToken(null, async () => {
      await assert.rejects(() => downloadAssets(satisfied, dir, { signal: controller.signal }),
        /取消已命中/, "全命中也不得假成功");
    });
    // 无 token 但有缺图：也不得静默返回计数。
    const missing = new Map([[MISSING, new Set([".png"])]]);
    const canceled = new AbortController();
    canceled.abort(new Error("取消无token"));
    await withToken(null, async () => {
      await assert.rejects(() => downloadAssets(missing, dir, { signal: canceled.signal }),
        /取消无token/, "无 token 也不得吞掉取消");
    });
  });
});

test("Content-Type 与引用格式不同族时记入 failures 与 missing，不改后缀不转码", async () => {
  await withTemp("daguan-assets-content-type-", async dir => {
    await writeBank(dir, []);
    const references = new Map([[WEBP, new Set([".webp"])]]);
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]),
      { status: 200, headers: { "Content-Type": "image/jpeg" } });
    try {
      await withToken("secret-token", async () => {
        const result = await downloadAssets(references, dir, {});
        assert.equal(result.missing, 1);
        assert.equal(result.failures.length, 1);
        assert.match(result.failures[0].reason, /内容类型与引用格式不符：image\/jpeg ≠ image\/webp/);
      });
    } finally { globalThis.fetch = original; }
    // 没有落盘，也没有被改名成 .jpeg。
    const assets = await fs.readdir(path.join(dir, "assets")).catch(() => []);
    assert.deepEqual(assets, []);
  });
});

// --- 同步集成：本地题库 overlay 追加的图片也要被收集（必须在合并之后扫描最终分片）---
test("本地题库 overlay 追加的题图会被收集并计入 asset_count", async () => {
  await withTemp("daguan-assets-overlay-", async dir => {
    const bundled = path.join(dir, "bundled");
    const target = path.join(dir, "target");
    const overlayHash = hash("f");
    await fs.mkdir(path.join(bundled, "local_question_banks"), { recursive: true });
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "lecture-video-mappings.json"), JSON.stringify({ questions: {} }));
    await fs.writeFile(path.join(target, "paradiyu-linear-video.json"), JSON.stringify({ questions: {} }));
    await fs.writeFile(path.join(bundled, "lecture-video-mappings.json"), JSON.stringify({ questions: {} }));
    await fs.writeFile(path.join(bundled, "paradiyu-linear-video.json"), JSON.stringify({ questions: {} }));
    // overlay 题目只出现在本地题库里，精讲/解析里带一张题图。
    await fs.writeFile(path.join(bundled, "local_question_banks/rescue.json"), JSON.stringify({
      id: "rescue", parentCategoryId: 601, shard: "概率统计",
      rootCategory: { id: 9900001, name: "本地题库" },
      chapters: [{ id: 9900002, number: 1, name: "第1章", questionCount: 1 }],
      questions: [{ id: 9001, category_id: 9900002, type: "subjective", stem: "本地题干",
        answer: "本地答案", explanation: `解析 ![图](assets/${overlayHash}.webp)` }],
    }));
    const original = globalThis.fetch;
    globalThis.fetch = async url => {
      const requestUrl = new URL(url);
      const json = value => new Response(JSON.stringify(value), { status: 200,
        headers: { "Content-Type": "application/json" } });
      if (requestUrl.pathname === "/api/categories") return json([
        { id: 223, name: "高等数学", children: [] }, { id: 1, name: "线性代数", children: [] },
        { id: 601, name: "概率统计", children: [] }]);
      if (requestUrl.pathname === "/api/questions") return json({ code: 0, data: { items: [],
        total: 0, total_pages: 1, page: 1 } });
      if (requestUrl.pathname === "/api/question-lists/linear-algebra-selected-20261018") {
        return json({ code: 0, data: { id: "linear-algebra-selected-20261018", name: "线代严选题",
          revision: 1, item_count: 0, is_official: true, status: "published", definition_kind: "explicit" } });
      }
      if (requestUrl.pathname.endsWith("/directory")) {
        return json({ code: 0, data: { total: 0, roots: [{ id: "1", label: "线性代数",
          category_id: 1, question_count: 0, children: [] }] } });
      }
      if (requestUrl.pathname.endsWith("/items")) return json({ code: 0, data: { items: [], total: 0 } });
      throw new Error(`测试未预期的请求：${requestUrl.pathname}`);
    };
    try {
      await withToken(null, async () => {
        const result = await syncOfficialQuestionBank({ targetDir: target, overlayDir: bundled });
        // 只有 overlay 那张图：构建目录时看不到它，必须在合并后重新收集。
        assert.equal(result.missingAssets, 1);
        assert.equal(result.total, 1);
      });
    } finally { globalThis.fetch = original; }
    const manifest = JSON.parse(await fs.readFile(path.join(target, "manifest.json"), "utf8"));
    assert.equal(manifest.asset_count, 1, "asset_count 按最终引用统计");
    const references = await collectAssetReferences(target);
    assert.deepEqual([...references.get(overlayHash)], [".webp"]);
  });
});

// --- HTTP：真实服务进程下，jpg/jpeg 别名与三跳查找范围（当前 bank / bundled / 既有 versions）---
const hashOf = seed => seed.repeat(64).slice(0, 64);

test("HTTP：题图按白名单格式提供，jpg/jpeg 别名与三跳回退可用", async t => {
  // rootDir 让 serviceFixture 注入隔离的 DAGUAN_WEB_ROOT，bundled 这一跳用 E0 下的极小 web/data/assets，
  // 不依赖仓库真实 assets。
  const isolatedRoot = await fs.mkdtemp(path.join(tempRoot(), "daguan-assets-webroot-"));
  t.after(() => fs.rm(isolatedRoot, { recursive: true, force: true }));
  const bundledAssets = path.join(isolatedRoot, "web", "data", "assets");
  await fs.mkdir(bundledAssets, { recursive: true });
  const { base, dir } = await serviceFixture(t, { rootDir: isolatedRoot });
  const current = randomUUID();
  const previous = randomUUID();
  for (const version of [current, previous]) {
    await fs.mkdir(path.join(dir, "question-bank", "versions", version, "assets"), { recursive: true });
  }
  const jpegAsJpg = hashOf("1");
  const pngInPrevious = hashOf("2");
  const gifInCurrent = hashOf("3");
  const webpInBundled = hashOf("6");
  const jpegInBundled = hashOf("8");
  // 当前版本只有 .jpg；引用按 .jpeg 请求，必须能命中别名。
  await fs.writeFile(path.join(dir, "question-bank", "versions", current, "assets", `${jpegAsJpg}.jpg`), "jpg");
  await fs.writeFile(path.join(dir, "question-bank", "versions", current, "assets", `${gifInCurrent}.gif`), "gif");
  // 上一活动版本（既有的另一个 versions 目录）里的 png 可被回退命中。
  await fs.writeFile(path.join(dir, "question-bank", "versions", previous, "assets", `${pngInPrevious}.png`), "png");
  // bundled：webp 本体 + 只有 .jpg 的 jpeg 别名。
  await fs.writeFile(path.join(bundledAssets, `${webpInBundled}.webp`), "webp");
  await fs.writeFile(path.join(bundledAssets, `${jpegInBundled}.jpg`), "jpeg-as-jpg");

  const fetchAsset = async (name, bank = current) => {
    const response = await fetch(`${base}/data/assets/${name}?bank=${bank}`);
    return { status: response.status, type: response.headers.get("content-type"),
      body: response.ok ? await response.text() : null };
  };

  // 当前 bank：jpg 文件被 .jpeg 请求命中。
  const alias = await fetchAsset(`${jpegAsJpg}.jpeg`);
  assert.equal(alias.status, 200);
  assert.equal(alias.type, "image/jpeg");
  assert.equal(alias.body, "jpg");
  // 当前 bank 的 gif。
  const gif = await fetchAsset(`${gifInCurrent}.gif`);
  assert.equal(gif.status, 200);
  assert.equal(gif.type, "image/gif");
  // 上一活动版本的 png 通过既有 versions 回退命中。
  const fallback = await fetchAsset(`${pngInPrevious}.png`);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body, "png");
  // bundled 这一跳：webp 200 且 MIME 正确。
  const bundledWebp = await fetchAsset(`${webpInBundled}.webp`);
  assert.equal(bundledWebp.status, 200, "bundled webp 应可回退命中");
  assert.equal(bundledWebp.type, "image/webp");
  assert.equal(bundledWebp.body, "webp");
  // bundled 里的 .jpg 被 .jpeg 请求命中，MIME 仍是 image/jpeg。
  const bundledAlias = await fetchAsset(`${jpegInBundled}.jpeg`);
  assert.equal(bundledAlias.status, 200, "bundled 的 jpg 别名应可命中 .jpeg 请求");
  assert.equal(bundledAlias.type, "image/jpeg");
  assert.equal(bundledAlias.body, "jpeg-as-jpg");

  // 非白名单格式与非法文件名都不得借回退越界（穿越请求由既有路径校验拒绝为 403）。
  assert.equal((await fetchAsset(`${hashOf("4")}.bmp`)).status, 404);
  assert.equal((await fetchAsset("not-a-hash.png")).status, 404);
  assert.ok([403, 404].includes((await fetchAsset("..%2F..%2Fmanifest.json")).status),
    "路径穿越必须被拒绝");
  assert.equal((await fetchAsset(`${hashOf("5")}.png`)).status, 404, "不存在的题图不得越界命中");
});
