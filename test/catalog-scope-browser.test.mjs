import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { serviceFixture } from "./runtime-fixture.mjs";

// Playwright 是本项目浏览器测试的硬依赖：缺失必须显式失败，不能静默跳过。
const { chromium } = createRequire(import.meta.url)(process.env.DAGUAN_PLAYWRIGHT_MODULE || "playwright");
const launchOptions = process.env.DAGUAN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.DAGUAN_CHROMIUM_EXECUTABLE } : {};

// 极小固定题库：不依赖仓库当前快照，也不访问官网。
// 线性代数(1) 下挂 原章节(11)→深层章节(111)→深层叶子(1111)、零题章节(12)、部分覆盖章节(13)
// 与官方题单根(7000000, collection_id)；概率统计(601) 是当前范围零题的另一个科目根。
// 数据遵循真实目录聚合契约：父分类的 questions 必须包含子分类的题目，direct 由子树并集补集得出。
//   根 1      questions [101,102,103,104,105] → direct [104]（direct_count 1）
//   原章节 11 questions [101,102,103]（含子 111 的 103）→ direct [101,102]（direct_count 2）
//   深层章节 111 questions [103] → direct []（全部来自子 1111）
//   部分覆盖 13 questions [103,105] → direct [103,105]
//   题单 7000000 questions [101,102,103] → direct 同左
const QUESTIONS = [
  { id: 101, stem: "严选题一", options: [{ label: "A", content: "甲" }, { label: "B", content: "乙" }], answer: "A", type: "single_choice", source: "基础练习", is_core: true },
  { id: 102, stem: "真题二", options: [{ label: "A", content: "甲" }, { label: "B", content: "乙" }], answer: "B", type: "single_choice", source: "2022 数学一真题", is_core: false },
  { id: 103, stem: "严选题三", options: [{ label: "A", content: "甲" }, { label: "B", content: "乙" }], answer: "A", type: "single_choice", source: "基础练习", is_core: true },
  { id: 104, stem: "非严选四", options: [{ label: "A", content: "甲" }, { label: "B", content: "乙" }], answer: "B", type: "single_choice", source: "数一强化练习", is_core: false },
  { id: 105, stem: "严选题五", options: [{ label: "A", content: "甲" }, { label: "B", content: "乙" }], answer: "A", type: "single_choice", source: "基础练习", is_core: true },
];

const CATEGORIES = [
  {
    id: 1, name: "线性代数", parent_id: null, question_count: 5, direct_count: 1,
    children: [
      {
        id: 11, name: "原章节", parent_id: 1, question_count: 3, direct_count: 2,
        children: [
          { id: 111, name: "深层章节", parent_id: 11, question_count: 1, direct_count: 0, children: [
            { id: 1111, name: "深层叶子", parent_id: 111, question_count: 1, direct_count: 1, children: [] },
          ] },
        ],
      },
      { id: 12, name: "零题章节", parent_id: 1, question_count: 0, direct_count: 0, children: [] },
      { id: 13, name: "部分覆盖章节", parent_id: 1, question_count: 2, direct_count: 2, children: [] },
      { id: 7000000, name: "线代严选题", parent_id: 1, collection_id: "linear-algebra-selected-20261018", question_count: 3, direct_count: 3, children: [] },
    ],
  },
  { id: 601, name: "概率统计", parent_id: null, question_count: 0, direct_count: 0, children: [] },
];

const CATEGORY_QUESTIONS = {
  "1": [101, 102, 103, 104, 105],
  "11": [101, 102, 103],
  "111": [103],
  "1111": [103],
  "12": [],
  "13": [103, 105],
  "7000000": [101, 102, 103],
  "601": [],
};

const ID_INDEX = Object.fromEntries(QUESTIONS.map(question => [String(question.id), "fixture"]));

function manifestWithCollections() {
  return {
    version: "browser-fixture", total: QUESTIONS.length, types: ["single_choice"],
    shards: { fixture: { file: "shards/fixture.json" } },
    asset_count: 0, asset_base: "", synced_at: "2026-10-28T00:00:00Z", source: "fixture", source_total: QUESTIONS.length,
    collections: [{ id: "linear-algebra-selected-20261018", name: "线代严选题", question_count: 3, unmatched: 0 }],
  };
}

// 无题单摘要的第二份夹具：验证不依赖仓库快照、也不依赖题单的普通目录仍按原样工作。
function manifestWithoutCollections() {
  const { collections, ...rest } = manifestWithCollections();
  return rest;
}

function categoriesWithoutCollection() {
  return CATEGORIES.map(root => ({
    ...root,
    children: (root.children || []).filter(child => !child.collection_id),
  }));
}

function fixturePayloads({ withCollections }) {
  return {
    "manifest.json": withCollections ? manifestWithCollections() : manifestWithoutCollections(),
    "categories.json": { categories: withCollections ? CATEGORIES : categoriesWithoutCollection() },
    "category_questions.json": CATEGORY_QUESTIONS,
    "id_index.json": ID_INDEX,
    "shards/fixture.json": QUESTIONS,
    "search_index.json": [],
    "lecture-video-mappings.json": { questions: {} },
    "paradiyu-linear-video.json": { questions: {} },
    "explanation-videos.json": {},
    "explanations-v2.json": { version: "fixture", count: 0, explanations: {} },
  };
}

async function openLibrary(t, { withCollections }) {
  const { base } = await serviceFixture(t);
  const browser = await chromium.launch(launchOptions);
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  return { base, browser, context, page: await context.newPage(), payloads: fixturePayloads({ withCollections }) };
}

// 只放行夹具里的题库文件，其余 data/*.json 返回 404，避免读到仓库真实快照。
async function interceptData(page, payloads) {
  await page.route("**/data/**", async route => {
    const name = new URL(route.request().url()).pathname.split("/data/")[1] || "";
    if (!(name in payloads)) return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payloads[name]) });
  });
}

async function gotoLibrary({ base, page }) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base + "/index.html?ui=new", { waitUntil: "domcontentloaded" });
  // 先等服务端状态对账与目录数据都就绪，避免与初始化竞态后再点击。
  await page.waitForFunction(() => window.StateSync?.hydrated === true);
  await page.waitForFunction(() => window.AppState?.categories?.categories?.length > 0);
  await page.locator('.nav-item[data-view="library"]').click();
  await page.waitForSelector("#directory-columns .directory-column");
  return errors;
}

const columnNames = (page, index) => page
  .locator("#directory-columns .directory-column").nth(index)
  .locator("[data-catalog-node] .directory-column-name").allTextContents();
const columnLabels = (page, index) => page
  .locator("#directory-columns .directory-column").nth(index)
  .locator("[data-catalog-node]").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));
const pickerNames = (page, index) => page
  .locator("#chapter-picker .chapter-picker-column").nth(index)
  .locator("[data-picker-id] > span:first-child").allTextContents();
// 范围切换是异步统计题数后再重绘：等到目标列的可见目录项与期望一致再断言，不做固定时长等待。
const waitColumn = (page, index, names) => page.waitForFunction(
  ([column, expected]) => {
    const host = document.querySelectorAll("#directory-columns .directory-column")[column];
    if (!host) return false;
    const actual = [...host.querySelectorAll("[data-catalog-node] .directory-column-name")].map(item => item.textContent.trim());
    return actual.length === expected.length && actual.every((name, position) => name === expected[position]);
  }, [index, names], { timeout: 20000 });

test("目录范围可见性在真实浏览器中按点击生效", { timeout: 120000 }, async t => {
  const fixture = await openLibrary(t, { withCollections: true });
  const { browser, page } = fixture;
  await interceptData(page, fixture.payloads);
  const errors = await gotoLibrary(fixture);
  console.log("catalog-scope-browser-launch", JSON.stringify({ browser: browser.version(), url: page.url() }));

  // 完整范围：科目根 + 题单根与原章节同时存在，题数取真实 question_count。
  assert.deepEqual(await columnNames(page, 0), ["线性代数", "概率统计"]);
  assert.deepEqual(await columnNames(page, 1), ["原章节", "零题章节", "部分覆盖章节", "线代严选题"]);
  assert.deepEqual(await columnLabels(page, 1), [
    "原章节，当前范围 3 题", "零题章节，当前范围 0 题", "部分覆盖章节，当前范围 2 题", "线代严选题，当前范围 3 题",
  ], "完整范围显示真实题数，含零题章节");

  // 进入将被严选范围隐藏的深层章节。
  await page.locator("#directory-columns .directory-column").nth(1).locator('[data-catalog-node="11"]').click();
  await page.waitForFunction(() => document.getElementById("library-node-title").textContent.trim() === "原章节");
  await page.locator("#directory-columns .directory-column").nth(2).locator('[data-catalog-node="111"]').click();
  await page.waitForFunction(() => document.getElementById("library-node-title").textContent.trim() === "深层章节");
  assert.deepEqual(await columnNames(page, 3), ["深层叶子"]);

  // 切严选：深层路径整条被隐藏，目录/标题/面包屑退到可见祖先，被题单覆盖的原章节不再重复出现。
  await page.locator('.catalog-scopes [data-chapter-scope="core"]').click();
  await page.waitForFunction(() => document.getElementById("library-node-title").textContent.trim() === "线性代数");
  await waitColumn(page, 1, ["部分覆盖章节", "线代严选题"]);
  assert.equal(await page.locator("#directory-columns .directory-column").count(), 2);
  assert.deepEqual(await columnLabels(page, 1), ["部分覆盖章节，当前范围 2 题", "线代严选题，当前范围 2 题"]);
  assert.deepEqual(await page.locator("#library-breadcrumb .breadcrumb-part").allTextContents(), ["线性代数"]);

  // 章节目录组件沿用同一可见性：不出现零题/已被覆盖的目录，科目根仍然可见。
  // 局部限制：当前页面没有 picker 的可见触发器，这里只“激活该既有组件”，不代表用户点击打开。
  await page.evaluate(() => App.openChapterPicker());
  await page.waitForSelector("#chapter-picker.open .chapter-picker-dialog");
  assert.deepEqual(await pickerNames(page, 0), ["线性代数", "概率统计"], "弹窗里零题的科目根仍可进入");
  assert.deepEqual(await pickerNames(page, 1), ["部分覆盖章节", "线代严选题"]);
  assert.deepEqual(await page.locator("#chapter-picker .chapter-picker-path button").allTextContents(), ["科目", "线性代数"]);
  const pickerText = await page.locator("#chapter-picker .chapter-picker-dialog").textContent();
  for (const hidden of ["零题章节", "原章节", "深层章节", "深层叶子"]) assert.ok(!pickerText.includes(hidden), `弹窗不应出现 ${hidden}`);
  await page.locator('#chapter-picker button[data-picker-close]').click();
  await page.waitForSelector("#chapter-picker.open .chapter-picker-dialog", { state: "detached" });

  // 回到完整范围：原目录完整恢复。
  await page.locator('.catalog-scopes [data-chapter-scope="all"]').click();
  await waitColumn(page, 1, ["原章节", "零题章节", "部分覆盖章节", "线代严选题"]);
  assert.deepEqual(await columnLabels(page, 1), [
    "原章节，当前范围 3 题", "零题章节，当前范围 0 题", "部分覆盖章节，当前范围 2 题", "线代严选题，当前范围 3 题",
  ], "完整范围恢复真实题数");
  assert.deepEqual(await page.locator("#library-breadcrumb .breadcrumb-part").allTextContents(), ["线性代数"]);
  assert.deepEqual(errors, [], "浏览器不应出现 pageerror");
});

test("真题范围隐藏空目录项，无题单摘要时普通目录行为不变", { timeout: 120000 }, async t => {
  const fixture = await openLibrary(t, { withCollections: false });
  const { page } = fixture;
  await interceptData(page, fixture.payloads);
  const errors = await gotoLibrary(fixture);

  assert.deepEqual(await columnNames(page, 1), ["原章节", "零题章节", "部分覆盖章节"], "没有题单根时目录与题数按原样显示");

  // 没有 manifest 题单摘要时不做去重：原章节只按当前范围题数决定可见性。
  await page.locator('.catalog-scopes [data-chapter-scope="core"]').click();
  await waitColumn(page, 1, ["原章节", "部分覆盖章节"]);
  assert.deepEqual(await columnLabels(page, 1), ["原章节，当前范围 2 题", "部分覆盖章节，当前范围 2 题"], "严选范围只隐藏零题章节，原章节不被去重");

  // 真题范围：只有含真题的章节保留，零题与仅严选题的章节都隐藏。
  await page.locator('.catalog-scopes [data-chapter-scope="real"]').click();
  await waitColumn(page, 1, ["原章节"]);
  assert.deepEqual(await columnLabels(page, 1), ["原章节，当前范围 1 题"], "真题范围隐藏零题与无真题的目录项");
  assert.deepEqual(errors, [], "浏览器不应出现 pageerror");
});
