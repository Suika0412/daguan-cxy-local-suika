import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPreviousCategories } from "../local-server/official-question-bank.mjs";

// 本次有效分类树：223 高等数学（含 224 极限）、1 线性代数、601 概率统计。
const currentTree = () => [
  { id: 223, name: "高等数学", children: [{ id: 224, name: "极限", children: [] }] },
  { id: 1, name: "线性代数", children: [] },
  { id: 601, name: "概率统计", children: [] },
];
const blank = id => ({ id, category_id: null, category_ids: [], stem: `题干${id}`, answer: `答案${id}` });
const snapshotOf = questions => ({ questions, categories: currentTree(), total: questions.length });

// 上一活动题库目录：manifest + id_index + 分片，文件名与生成侧一致。
async function writeBank(dir, { shards, idIndex, manifest } = {}) {
  await fs.mkdir(path.join(dir, "shards"), { recursive: true });
  const entries = shards || {};
  await fs.writeFile(path.join(dir, "manifest.json"), typeof manifest === "string" ? manifest
    : JSON.stringify(manifest || { version: 1, shards: Object.fromEntries(Object.keys(entries)
      .map(name => [name, { file: `shards/${name}.json`, count: entries[name].length }])) }));
  await fs.writeFile(path.join(dir, "id_index.json"), typeof idIndex === "string" ? idIndex
    : JSON.stringify(idIndex || Object.fromEntries(Object.entries(entries)
      .flatMap(([name, rows]) => rows.map(row => [String(row.id), name])))));
  for (const [name, rows] of Object.entries(entries)) {
    await fs.writeFile(path.join(dir, `shards/${name}.json`), JSON.stringify(rows));
  }
}

// 临时目录放 E0 专属根下（未设置时退回 os.tmpdir()），teardown 一律删除。
const tempRoot = process.env.DAGUAN_TEST_TMP || os.tmpdir();
async function withBank(fixture, run) {
  const temp = await fs.mkdtemp(path.join(tempRoot, "daguan-previous-categories-"));
  const bank = path.join(temp, "previous");
  try {
    await fs.mkdir(bank, { recursive: true });
    await writeBank(bank, fixture);
    return await run(bank, temp);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

test("回填有效旧分类，过滤已失效的旧次要分类", async () => {
  await withBank({ shards: { 高等数学: [
    { id: 1, category_id: 224, category_ids: [224, 8888] },
    { id: 2, category_id: 8888, category_ids: [8888, 601] },
    { id: 3, category_id: 8888, category_ids: [8888] },
  ] } }, async bank => {
    const snapshot = snapshotOf([blank(1), blank(2), blank(3), blank(4)]);
    const result = await applyPreviousCategories(snapshot, bank);
    // 主分类有效、失效次分类被过滤。
    assert.deepEqual([result.questions[0].category_id, result.questions[0].category_ids], [224, [224]]);
    // 主分类失效时由第一个有效次分类顶上；失效 ID 不保留。
    assert.deepEqual([result.questions[1].category_id, result.questions[1].category_ids], [601, [601]]);
    // 旧库有记录但没有有效分类：保持未分类，不猜。
    assert.deepEqual([result.questions[2].category_id, result.questions[2].category_ids], [null, []]);
    // 旧库里没有这道题：保持未分类。
    assert.deepEqual([result.questions[3].category_id, result.questions[3].category_ids], [null, []]);
    assert.equal(result.preservedPreviousCategories, 2);
    // 回填只改分类字段，正文不动。
    assert.deepEqual(result.questions.map(question => [question.id, question.stem, question.answer]),
      [[1, "题干1", "答案1"], [2, "题干2", "答案2"], [3, "题干3", "答案3"], [4, "题干4", "答案4"]]);
  });
});

test("已有新分类（含本地 assignment 结果）的题目不被旧库覆盖", async () => {
  await withBank({ shards: { 概率统计: [{ id: 1, category_id: 601, category_ids: [601] },
    { id: 2, category_id: 601, category_ids: [601] }] } }, async bank => {
    const primary = { ...blank(1), category_id: 223, category_ids: [223] };
    const secondaryOnly = { ...blank(2), category_id: null, category_ids: [1] };
    const result = await applyPreviousCategories(snapshotOf([primary, secondaryOnly]), bank);
    assert.deepEqual([result.questions[0].category_id, result.questions[0].category_ids], [223, [223]]);
    assert.deepEqual([result.questions[1].category_id, result.questions[1].category_ids], [null, [1]]);
    assert.equal(result.preservedPreviousCategories, 0);
  });
});

test("没有有效旧分类时不新造分类根", async () => {
  await withBank({ shards: { 高等数学: [{ id: 1, category_id: 2500, category_ids: [2500] }] } }, async bank => {
    const snapshot = snapshotOf([blank(1)]);
    const result = await applyPreviousCategories(snapshot, bank);
    assert.deepEqual(result.categories, snapshot.categories);
    assert.equal(result.preservedPreviousCategories, 0);
    assert.deepEqual([result.questions[0].category_id, result.questions[0].category_ids], [null, []]);
  });
});

test("未提供 previousDataDir 或旧库目录不存在时不做读取，直接空输入", async () => {
  const snapshot = snapshotOf([blank(1)]);
  for (const dir of [null, undefined, ""]) {
    const result = await applyPreviousCategories(snapshot, dir);
    assert.equal(result.preservedPreviousCategories, 0);
    assert.deepEqual(result.questions, snapshot.questions);
    assert.deepEqual(result.categories, snapshot.categories);
  }
  const missing = path.join(tempRoot, "daguan-previous-categories-does-not-exist");
  const result = await applyPreviousCategories(snapshot, missing);
  assert.equal(result.preservedPreviousCategories, 0);
  assert.deepEqual(result.questions, snapshot.questions);
});

test("旧库 JSON 损坏显式失败，不静默当作空输入", async () => {
  await withBank({ manifest: "{ not json" , shards: { 高等数学: [] } }, async bank => {
    await assert.rejects(() => applyPreviousCategories(snapshotOf([blank(1)]), bank), /不是合法 JSON/);
  });
  await withBank({ shards: { 高等数学: [] }, idIndex: "[1,2" }, async bank => {
    await assert.rejects(() => applyPreviousCategories(snapshotOf([blank(1)]), bank), /不是合法 JSON/);
  });
});

test("旧库格式不符显式失败", async () => {
  await withBank({ manifest: JSON.stringify({ version: 1 }) }, async bank => {
    await assert.rejects(() => applyPreviousCategories(snapshotOf([blank(1)]), bank), /manifest 格式不符/);
  });
  await withBank({ manifest: JSON.stringify({ version: 1, shards: { 高等数学: { file: "shards/高等数学.json" } } }),
    idIndex: JSON.stringify({ 1: "高等数学" }) }, async bank => {
    await fs.writeFile(path.join(bank, "shards/高等数学.json"), JSON.stringify({ not: "array" }));
    await assert.rejects(() => applyPreviousCategories(snapshotOf([blank(1)]), bank), /不是数组/);
  });
});

test("manifest 里的分片路径越界时显式失败", async () => {
  const idIndex = JSON.stringify({ 1: "高等数学" });
  await withBank({ manifest: JSON.stringify({ version: 1,
    shards: { 高等数学: { file: "../escape.json" } } }), idIndex }, async bank => {
    await fs.writeFile(path.join(bank, "..", "escape.json"), JSON.stringify([{ id: 1, category_id: 224 }]));
    await assert.rejects(() => applyPreviousCategories(snapshotOf([blank(1)]), bank), /路径越界/);
  });
  // 绝对路径同样必须挡住。
  await withBank({ manifest: JSON.stringify({ version: 1,
    shards: { 高等数学: { file: path.join(tempRoot, "escape-absolute.json") } } }), idIndex }, async bank => {
    await assert.rejects(() => applyPreviousCategories(snapshotOf([blank(1)]), bank), /路径越界/);
  });
});
