import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { applyLocalClassifications } from "../local-server/official-question-bank.mjs";

const data = name => JSON.parse(readFileSync(new URL(`../web/data/${name}`, import.meta.url), "utf8"));
// 本地题库 overlay 的题目（救命课 + 百宝书等），必须全部并入生成题库。
const localBankQuestions = readdirSync(new URL("../web/data/local_question_banks/", import.meta.url))
  .filter(name => name.endsWith(".json"))
  .flatMap(name => data(`local_question_banks/${name}`).questions);
const config = data("official-orphan-classifications.json");
const index = data("id_index.json");
const assignmentIds = Object.keys(config.assignments);
const euclidIds = assignmentIds.filter(id => config.assignments[id].category_ids.includes(9900100));
const openedShards = new Map();
const shardOf = name => {
  if (!openedShards.has(name)) openedShards.set(name, data(`shards/${name}.json`));
  return openedShards.get(name);
};
const bankQuestion = id => {
  const shardName = index[id];
  assert.ok(shardName, `题目 ${id} 不在 id_index 中`);
  const question = shardOf(shardName).find(item => String(item.id) === id);
  assert.ok(question, `题目 ${id} 在分片 ${shardName} 中缺失`);
  return question;
};
// 复核过的官网未分类题：取当前题库正文，去掉分类，作为 applyLocalClassifications 的输入。
const original = assignmentIds.map(id => ({ ...bankQuestion(id), category_id: null, category_ids: [], category_path: "" }));

// 官网可能已下线 2500（模拟哥专区）：夹具不再假设它也一定在线上，而是显式补出该根，
// 让本地 overlay 的挂载分支有确定的父节点；其余节点仍用当前生成的官网分类树。
function officialTree({ withOptionalRoot = true } = {}) {
  const tree = data("categories.json").filter(category => category.id !== "orphan");
  const optionalRoot = tree.find(category => category.id === 2500);
  if (optionalRoot) optionalRoot.children = [];
  if (withOptionalRoot && !optionalRoot) tree.push({ id: 2500, name: "模拟哥专区", children: [] });
  return tree;
}

test("reviewed assignments stay stable through overlay application without changing question content", () => {
  const snapshot = { questions: original, categories: officialTree(), total: original.length };
  const result = applyLocalClassifications(snapshot, config);
  assert.equal(assignmentIds.length, 43);
  assert.equal(euclidIds.length, 37);
  assert.equal(result.questions.length, 43);
  assert.equal(new Set(result.questions.map(question => question.id)).size, 43);
  assert.equal(result.questions.filter(question => question.category_id == null).length, 0);
  assert.equal(result.questions.every(question => question.category_ids.length === 1), true);
  // 正文、答案、来源不得被分类映射改动。
  assert.deepEqual(result.questions.map(question => [question.id, question.stem, question.answer, question.source]),
    original.map(question => [question.id, question.stem, question.answer, question.source]));
  // overlay 分类挂在配置声明的父节点下，名字取自配置。
  const optionalRoot = result.categories.find(category => category.id === 2500);
  assert.deepEqual(optionalRoot.children.filter(category => category.id === 9900100)
    .map(category => [category.id, category.name]), [[9900100, "Euclid 2027八月模考"]]);
  assert.equal(result.questions.filter(question => question.category_id === 9900100).length, euclidIds.length);
  // 指向官网分类的 assignment 保留官网 ID。
  const officialAssigned = result.questions.filter(question => question.category_id !== 9900100);
  assert.equal(officialAssigned.length, assignmentIds.length - euclidIds.length);
  for (const question of officialAssigned) {
    assert.deepEqual(question.category_ids, config.assignments[String(question.id)].category_ids);
  }
  assert.deepEqual(result.skippedLocalClassifications,
    { roots: [], categories: [], questions: [] });
  assert.equal(original.every(question => question.category_id == null), true);
});

test("official categories take priority and future unclassified questions stay unclassified", () => {
  const official = { ...original[0], category_id: 601, category_ids: [601] };
  const primaryOnly = { ...original[1], category_id: 223, category_ids: [] };
  const future = { ...original[0], id: 999999 };
  const result = applyLocalClassifications({ questions: [official, primaryOnly, future],
    categories: officialTree(), total: 3 }, config);
  assert.deepEqual(result.questions[0].category_ids, [601]);
  assert.deepEqual(result.questions[1].category_ids, [223]);
  assert.equal(result.questions[2].category_id, null);
  assert.deepEqual(result.questions[2].category_ids, []);
  assert.equal(result.categories.find(category => category.id === 2500)
    .children.some(category => category.id === 9900100), false);
});

// 可选根真正下线时的既有语义：本地分类无处可挂，显式跳过并保留题目为未分类。
test("assignments whose only target hangs under the offline optional root are skipped, not remapped", () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(String(message));
  let result;
  try {
    result = applyLocalClassifications({ questions: original,
      categories: officialTree({ withOptionalRoot: false }), total: original.length }, config);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(result.skippedLocalClassifications.roots, [2500]);
  assert.deepEqual(result.skippedLocalClassifications.categories, [9900100]);
  assert.deepEqual(result.skippedLocalClassifications.questions.map(String).sort(),
    euclidIds.slice().sort());
  assert.equal(result.categories.some(category => category.id === 2500), false);
  assert.equal(result.categories.some(category => (category.children || []).some(child => child.id === 9900100)), false);
  assert.equal(result.questions.filter(question => question.category_ids.length).length,
    assignmentIds.length - euclidIds.length);
  assert.deepEqual(result.questions.map(question => [question.id, question.stem, question.answer, question.source]),
    original.map(question => [question.id, question.stem, question.answer, question.source]));
  // 跳过必须可观察，不能静默。
  const skipWarnings = warnings.filter(message => message.includes("本地分类跳过"));
  assert.equal(skipWarnings.length, 1);
  assert.match(skipWarnings[0], /可选根分类 2500/);
  assert.match(skipWarnings[0], /忽略 1 个本地分类与 37 条题目映射/);
});

test("generated catalog indexes every question exactly once and keeps the reviewed mappings", () => {
  const manifest = data("manifest.json");
  const idIndex = data("id_index.json");
  const categoryQuestions = data("category_questions.json");
  const searchIndex = data("search_index.json");
  const shardTotal = Object.values(manifest.shards).reduce((sum, shard) => sum + shard.count, 0);
  // 分片计数、id 索引、搜索索引三者必须互相对齐（题号唯一）。
  assert.deepEqual(shardTotal, manifest.total);
  assert.equal(Object.keys(idIndex).length, manifest.total);
  assert.equal(new Set(searchIndex.map(question => question.id)).size, manifest.total);
  // 未分类分片与 orphan 索引来自同一批题目。
  assert.equal(manifest.shards["未分类"].count, categoryQuestions.orphan?.length || 0);
  // 本地题库全部并入生成题库。
  assert.ok(localBankQuestions.length > 0);
  for (const question of localBankQuestions) assert.ok(idIndex[question.id], `本地题库题目 ${question.id} 未并入`);
  for (const id of assignmentIds) {
    const question = bankQuestion(id);
    const shardName = idIndex[id];
    if (!question.category_ids.length) {
      // 唯一目标分类挂在已下线可选根上时，题目保留为未分类。
      assert.equal(shardName, "未分类", `题目 ${id} 应保留为未分类`);
      continue;
    }
    assert.ok(shardName && shardName !== "未分类", `题目 ${id} 未进入分片`);
    for (const categoryId of question.category_ids) {
      assert.ok(categoryQuestions[categoryId]?.includes(Number(id)), `题目 ${id} 未进入分类 ${categoryId}`);
    }
  }
});
