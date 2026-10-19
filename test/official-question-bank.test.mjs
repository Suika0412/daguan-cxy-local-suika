import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parsePaperNumber, sortExamPaperQuestions, syncOfficialQuestionBank, synthesizeExamCategoryTree, synthesizedCategoryId } from "../local-server/official-question-bank.mjs";

// 官网原始记录的字段是 category_full_path / category_name；category_path 只是本地
// normalizeQuestion 的产物，原始快照里没有，这里不构造它。
const question = (id, categoryPath, categoryId) => ({ id, category_id: categoryId,
  category_ids: categoryId == null ? [] : [categoryId], category_full_path: categoryPath,
  category_name: categoryPath, stem: `题干${id}`, answer: `答案${id}` });

test("synthetic category IDs are reproducible, path-specific and stay out of the reserved ranges", () => {
  const first = synthesizedCategoryId("历年真题 / 数一");
  assert.equal(synthesizedCategoryId("历年真题 / 数一"), first);
  assert.notEqual(synthesizedCategoryId("历年真题 / 数二"), first);
  assert.ok(first >= 980_000_000 && first < 981_000_000, `合成 ID 落在专用区间外：${first}`);
  assert.equal(first, synthesizedCategoryId("  历年真题 / 数一  "));
  assert.throws(() => synthesizedCategoryId("历年真题 / 数一", new Set([first])), /冲突/);
  assert.throws(() => synthesizedCategoryId(""), /非空路径/);
});

test("missing 历年真题 tree is rebuilt from question paths while official leaf IDs are kept", () => {
  const categories = [{ id: 223, name: "高等数学", children: [] }];
  const questions = [
    question(1, "高等数学 / 极限", 223),
    question(2, "历年真题 / 数一 / 2019", 3510),
    question(3, "历年真题 / 数一 / 2020", 3511),
    question(4, "历年真题 / 数三 / 2020", 3512),
  ];
  const result = synthesizeExamCategoryTree({ questions, categories, total: 4 });
  const root = result.categories.find(category => category.name === "历年真题");
  assert.equal(root.id, synthesizedCategoryId("历年真题"));
  assert.equal(result.examRootId, root.id);
  assert.deepEqual(root.children.map(category => category.name), ["数一", "数三"]);
  const first = root.children[0];
  assert.equal(first.id, synthesizedCategoryId("历年真题 / 数一"));
  assert.deepEqual(first.children.map(category => [category.name, category.id]), [["2019", 3510], ["2020", 3511]]);
  assert.deepEqual(root.children[1].children.map(category => [category.name, category.id]), [["2020", 3512]]);
  assert.deepEqual(result.questions, questions);
  assert.deepEqual(result.categories[0], { id: 223, name: "高等数学", children: [] });
});

test("only the confirmed official path fields are read, tolerating leading and trailing slashes", () => {
  const byCategoryNameOnly = { id: 1, category_id: 3510, category_ids: [3510],
    category_name: "历年真题 / 数一 / 2019", stem: "题干1", answer: "答案1" };
  const withLeadingSlash = { id: 2, category_id: 3511, category_ids: [3511],
    category_full_path: "/历年真题/数二/2019/", stem: "题干2", answer: "答案2" };
  const localOnlyField = { id: 3, category_id: 223, category_ids: [223],
    category_path: "历年真题 / 数一 / 2021", stem: "题干3", answer: "答案3" };
  const result = synthesizeExamCategoryTree({ total: 3,
    categories: [{ id: 223, name: "高等数学", children: [] }],
    questions: [byCategoryNameOnly, withLeadingSlash, localOnlyField] });
  const root = result.categories.find(category => category.name === "历年真题");
  assert.deepEqual(root.children.map(category => category.name), ["数一", "数二"]);
  assert.deepEqual(root.children[0].children.map(category => [category.name, category.id]), [["2019", 3510]]);
  assert.deepEqual(root.children[1].children.map(category => [category.name, category.id]), [["2019", 3511]]);
  // 只有本地 category_path 的记录不参与合成：它不是官网字段。
  assert.equal(root.children[0].children.some(category => category.name === "2021"), false);
});

test("conflicting path fields and non-string paths fail loudly", () => {
  assert.throws(() => synthesizeExamCategoryTree({ total: 1, categories: [],
    questions: [{ id: 1, category_id: 3510, category_ids: [3510], stem: "题干1", answer: "答案1",
      category_full_path: "历年真题 / 数一 / 2019", category_name: "历年真题 / 数二 / 2020" }] }),
  /字段互相冲突/);
  assert.throws(() => synthesizeExamCategoryTree({ total: 1, categories: [],
    questions: [{ id: 1, category_id: 3510, category_ids: [3510], stem: "题干1", answer: "答案1",
      category_full_path: 2019 }] }), /不是字符串/);
});

test("a record with categories missing from the tree but no path field fails instead of being skipped", () => {
  // 真题子树已下线：叶子 3510 不在树上，此时字段缺失不能当作非真题静默跳过。
  assert.throws(() => synthesizeExamCategoryTree({ total: 1,
    categories: [{ id: 223, name: "高等数学", children: [] }],
    questions: [{ id: 1, category_id: 3510, category_ids: [3510], stem: "题干1", answer: "答案1" }] }),
  /缺少分类路径字段/);
  // 分类都在官网上、且没有真题路径时才是真正的非真题记录，可以原样保留。
  const result = synthesizeExamCategoryTree({ total: 1,
    categories: [{ id: 223, name: "高等数学", children: [] }],
    questions: [{ id: 1, category_id: 223, category_ids: [223], stem: "题干1", answer: "答案1" }] });
  assert.equal(result.examRootId, null);
  assert.deepEqual(result.categories, [{ id: 223, name: "高等数学", children: [] }]);
});

test("existing 历年真题 nodes are reused instead of re-synthesized", () => {
  const categories = [{ id: 836, name: "历年真题", children: [{ id: 837, name: "数一", children: [] }] }];
  const questions = [question(1, "历年真题 / 数一 / 2019", 3510), question(2, "历年真题 / 数二 / 2019", 3511)];
  const result = synthesizeExamCategoryTree({ questions, categories, total: 2 });
  const root = result.categories.find(category => category.name === "历年真题");
  assert.equal(root.id, 836);
  assert.equal(result.examRootId, 836);
  assert.deepEqual(root.children.map(category => [category.name, category.id]),
    [["数一", 837], ["数二", synthesizedCategoryId("历年真题 / 数二")]]);
  assert.deepEqual(root.children[0].children.map(category => [category.name, category.id]), [["2019", 3510]]);
});

test("records without a 历年真题 path leave the category tree and questions untouched", () => {
  const categories = [{ id: 223, name: "高等数学", children: [{ id: 224, name: "极限", children: [] }] }];
  const questions = [question(1, "高等数学 / 极限", 224), question(2, "", null),
    { id: 3, category_id: null, category_ids: [], stem: "题干3", answer: "答案3" }];
  const result = synthesizeExamCategoryTree({ questions, categories, total: 3 });
  assert.deepEqual(result.categories, categories);
  assert.equal(result.examRootId, null);
  assert.deepEqual(result.questions, questions);
});

test("multi-valued 真题 paths are accepted only when exactly one segment is 历年真题", () => {
  const single = synthesizeExamCategoryTree({ categories: [], total: 1,
    questions: [question(1, "高等数学 / 极限、历年真题 / 数一 / 2019", 3510)] });
  assert.equal(single.examRootId, synthesizedCategoryId("历年真题"));
  assert.throws(() => synthesizeExamCategoryTree({ categories: [], total: 1,
    questions: [question(1, "历年真题 / 数一 / 2019、历年真题 / 数二 / 2019", 3510)] }), /多个真题路径/);
});

test("illegal 真题 paths and missing official leaf IDs fail loudly", () => {
  const cases = [
    [question(1, "历年真题 / 数一", 3510), /三层/],
    [question(1, "历年真题 / 数四 / 2019", 3510), /科目不合法/],
    [question(1, "历年真题 / 数一 / 19", 3510), /四位年份/],
    [question(1, "历年真题 / 数一 / 2019", null), /叶子分类 ID/],
    [question(1, "历年真题 / 数一 / 2019", 0), /叶子分类 ID/],
  ];
  for (const [record, pattern] of cases) {
    assert.throws(() => synthesizeExamCategoryTree({ categories: [], questions: [record], total: 1 }), pattern);
  }
});

test("path and official leaf ID must stay one-to-one", () => {
  assert.throws(() => synthesizeExamCategoryTree({ categories: [], total: 2, questions: [
    question(1, "历年真题 / 数一 / 2019", 3510), question(2, "历年真题 / 数一 / 2019", 3511)] }),
  /多个官方叶子分类 ID/);
  assert.throws(() => synthesizeExamCategoryTree({ categories: [], total: 2, questions: [
    question(1, "历年真题 / 数一 / 2019", 3510), question(2, "历年真题 / 数二 / 2019", 3510)] }),
  /对应多个路径/);
});

test("synthesized IDs and official leaf IDs conflicting with the current tree fail loudly", () => {
  const rootId = synthesizedCategoryId("历年真题");
  assert.throws(() => synthesizeExamCategoryTree({ total: 1, categories: [{ id: rootId, name: "其它分类", children: [] }],
    questions: [question(1, "历年真题 / 数一 / 2019", 3510)] }), /冲突/);
  assert.throws(() => synthesizeExamCategoryTree({ total: 1,
    categories: [{ id: 223, name: "高等数学", children: [{ id: 224, name: "极限", children: [] }] }],
    questions: [question(1, "历年真题 / 数一 / 2019", 224)] }), /已被占用：224/);
  assert.throws(() => synthesizeExamCategoryTree({ total: 1,
    categories: [{ id: 836, name: "历年真题",
      children: [{ id: 837, name: "数一", children: [{ id: 999, name: "2019", children: [] }] }] }],
    questions: [question(1, "历年真题 / 数一 / 2019", 3510)] }), /与官方记录不一致/);
  assert.throws(() => synthesizeExamCategoryTree({ total: 1,
    categories: [{ id: 223, name: "高等数学", children: [] }, { id: 223, name: "重复", children: [] }],
    questions: [] }), /不合法或重复/);
});

// --- 卷内题号解析：source 是多段自由文本，必须按叶子科目与年份取段 ---
test("卷内题号从单科括号里取数字，全角半角括号都认", () => {
  assert.deepEqual(parsePaperNumber("2009数一（5）", { subject: "数一", year: "2009" }), { number: 5 });
  assert.deepEqual(parsePaperNumber("2009数一(23)", { subject: "数一", year: 2009 }), { number: 23 });
});

test("多科目列举只取当前科目那一项", () => {
  const source = "2009数一二三（一6、二7、三5）";
  assert.deepEqual(parsePaperNumber(source, { subject: "数一", year: "2009" }), { number: 6 });
  assert.deepEqual(parsePaperNumber(source, { subject: "数二", year: "2009" }), { number: 7 });
  assert.deepEqual(parsePaperNumber(source, { subject: "数三", year: "2009" }), { number: 5 });
});

test("多段来源按科目取对应段，不取第一个括号", () => {
  // 在数一卷里是第 5 题，在数二卷里是第 6 题；取第一个括号会把数一错排成第 6 题。
  const source = "2005数二（6）；2005数一（5）";
  assert.deepEqual(parsePaperNumber(source, { subject: "数一", year: "2005" }), { number: 5 });
  assert.deepEqual(parsePaperNumber(source, { subject: "数二", year: "2005" }), { number: 6 });
});

test("非题号括号和后续题源不会被当成题号", () => {
  assert.deepEqual(parsePaperNumber("2003数三（4）；25 版 880 矩阵基础填空 13", { subject: "数三", year: "2003" }),
    { number: 4 });
  assert.deepEqual(parsePaperNumber("2013数一二三（版本二）", { subject: "数一", year: "2013" }), { missing: true });
  assert.deepEqual(parsePaperNumber("2009数三（仅数三）", { subject: "数三", year: "2009" }), { missing: true });
});

test("没有题号返回 missing，不抛异常", () => {
  assert.deepEqual(parsePaperNumber("2005数一", { subject: "数一", year: "2005" }), { missing: true });
  assert.deepEqual(parsePaperNumber("1996数二；第三大题第（2）小题；880 基础解答 3-2",
    { subject: "数二", year: "1996" }), { missing: true });
  assert.deepEqual(parsePaperNumber("", { subject: "数一", year: "2009" }), { missing: true });
});

test("年份和科目都不串：段内年份或科目对不上即视为无题号", () => {
  assert.deepEqual(parsePaperNumber("2009数一（5）", { subject: "数一", year: "2010" }), { missing: true });
  assert.deepEqual(parsePaperNumber("2009数二（5）", { subject: "数一", year: "2009" }), { missing: true });
});

test("同一卷解析出多个不同题号时显式失败，不静默取第一个", () => {
  assert.throws(() => parsePaperNumber("2009数一（5）；2009数一（7）", { subject: "数一", year: "2009" }),
    /真题题号冲突/);
});

test("解析契约要求真题科目与四位年份", () => {
  assert.throws(() => parsePaperNumber("2009数一（5）", { subject: "数四", year: "2009" }), /真题科目/);
  assert.throws(() => parsePaperNumber("2009数一（5）", { subject: "数一", year: "09" }), /四位年份/);
});

// --- 卷内排序：只排「历年真题 / 科目 / 年份」叶子 ---
const paperIndex = rows => new Map(rows.map(([id, source, serial]) => [id, { id, source, serial }]));

test("乱序输入按卷内题号排序", () => {
  const index = paperIndex([
    [11, "2009数一（3）", 1],
    [12, "2009数一（1）", 2],
    [13, "2009数一（2）", 3],
  ]);
  const result = sortExamPaperQuestions("历年真题 / 数一 / 2009", [11, 12, 13], index);
  assert.deepEqual(result.ids, [12, 13, 11]);
  assert.deepEqual(result.missing, []);
});

test("serial 与题号相反时按题号排，不按 serial", () => {
  const index = paperIndex([
    [21, "2012数一（2）", 900],
    [22, "2012数一（1）", 100],
    [23, "2012数一（3）", 500],
  ]);
  const result = sortExamPaperQuestions("历年真题 / 数一 / 2012", [21, 22, 23], index);
  assert.deepEqual(result.ids, [22, 21, 23]);
});

test("不同科目与年份各自成卷，不串排", () => {
  const index = paperIndex([
    [31, "2009数一（2）", 1], [32, "2009数一（1）", 2],
    [33, "2009数二（1）", 3], [34, "2009数二（2）", 4],
    [35, "2010数一（1）", 5],
  ]);
  assert.deepEqual(sortExamPaperQuestions("历年真题 / 数一 / 2009", [31, 32], index).ids, [32, 31]);
  assert.deepEqual(sortExamPaperQuestions("历年真题 / 数二 / 2009", [33, 34], index).ids, [33, 34]);
  // 2010 卷看不到 2009 的题，同一份索引换叶子就是另一套顺序
  assert.deepEqual(sortExamPaperQuestions("历年真题 / 数一 / 2010", [35], index).ids, [35]);
});

test("跨卷共享题在每个叶子用该叶子的科目题号独立排序，不按 id 去重", () => {
  const shared = [101, "2009数一二三（一6、二7、三5）", 10];
  const index = paperIndex([shared,
    [102, "2009数一（1）", 11], [103, "2009数一（7）", 12],
    [104, "2009数二（1）", 13], [105, "2009数二（8）", 14]]);
  // 数一：共享题是第 6 题，排在 1 与 7 之间
  assert.deepEqual(sortExamPaperQuestions("历年真题 / 数一 / 2009", [102, 103, 101], index).ids, [102, 101, 103]);
  // 数二：同一道题是第 7 题，排在 1 与 8 之间；两个叶子各自保留这条 id，不去重
  assert.deepEqual(sortExamPaperQuestions("历年真题 / 数二 / 2009", [104, 105, 101], index).ids, [104, 101, 105]);
});

test("缺题号排在末尾并保持输入相对顺序，且随 refs 上报可审计", () => {
  const index = paperIndex([
    [41, "2005数一", 1],
    [42, "2005数一（2）", 2],
    [43, "2005数一", 3],
    [44, "2005数一（1）", 4],
  ]);
  const result = sortExamPaperQuestions("历年真题 / 数一 / 2005", [41, 42, 43, 44], index);
  assert.deepEqual(result.ids, [44, 42, 41, 43]);
  assert.deepEqual(result.missing, [
    { id: 41, path: "历年真题 / 数一 / 2005", source: "2005数一" },
    { id: 43, path: "历年真题 / 数一 / 2005", source: "2005数一" },
  ]);
});

test("非真题路径与真题聚合节点原样返回，不拿单卷题号去排", () => {
  const index = paperIndex([[51, "2009数一（2）", 1], [52, "2009数一（1）", 2]]);
  for (const path of ["高等数学 / 极限 / 计算", "历年真题", "历年真题 / 数一"]) {
    const result = sortExamPaperQuestions(path, [51, 52], index);
    assert.deepEqual(result.ids, [51, 52]);
    assert.deepEqual(result.missing, []);
  }
});

// --- 同步管线集成：官网 /api/categories 缺真题根，题目记录仍带真题路径 ---
const OFFICIAL_CATEGORIES = [
  { id: 223, name: "高等数学", children: [{ id: 224, name: "极限", children: [] }] },
  { id: 1, name: "线性代数", children: [] },
  { id: 601, name: "概率统计", children: [] },
  { id: 2500, name: "模拟哥专区", children: [] },
];

function officialQuestion(id, categoryPath, categoryId, extra = {}) {
  return { id, category_id: categoryId, category_ids: [categoryId], is_core: false,
    content_hash: `hash-${id}`, category_full_path: categoryPath, category_name: categoryPath,
    document: { question_type: "essay", stem_md: `题干${id}`,
      answer: { reference_answer_md: `答案${id}` }, explanation_md: "" }, ...extra };
}

function stubOfficialFetch(questions, categories) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const target = new URL(url);
    const json = value => new Response(JSON.stringify(value), { status: 200,
      headers: { "Content-Type": "application/json" } });
    if (target.pathname === "/api/categories") return json(categories);
    const page = Number(target.searchParams.get("page") || 1);
    const perPage = Number(target.searchParams.get("per_page") || 200);
    return json({ code: 0, data: { items: questions.slice((page - 1) * perPage, page * perPage),
      total: questions.length, total_pages: Math.max(1, Math.ceil(questions.length / perPage)), page } });
  };
  return () => { globalThis.fetch = original; };
}

async function writeMappingFiles(dir) {
  await fs.mkdir(dir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(dir, "lecture-video-mappings.json"), JSON.stringify({ questions: {} })),
    fs.writeFile(path.join(dir, "paradiyu-linear-video.json"), JSON.stringify({ questions: {} })),
  ]);
}

const readJson = async file => JSON.parse(await fs.readFile(file, "utf8"));

test("official sync rebuilds the missing 历年真题 subtree and files those questions into its shard", async () => {
  const questions = [
    officialQuestion(1, "高等数学 / 极限", 224),
    officialQuestion(2, "历年真题 / 数一 / 2019", 3510),
    officialQuestion(3, "历年真题 / 数二 / 2019", 3511),
    officialQuestion(4, "历年真题 / 数一 / 2019", 3510),
  ];
  const restoreFetch = stubOfficialFetch(questions, OFFICIAL_CATEGORIES);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-exam-tree-sync-"));
  const targetDir = path.join(temp, "target");
  try {
    await writeMappingFiles(targetDir);
    const result = await syncOfficialQuestionBank({ targetDir });
    assert.equal(result.sourceTotal, 4);
    assert.equal(result.strayCategoryRefs.length, 0);
    assert.equal(result.unclassifiedPrimaryRefs.length, 0);
    const manifest = await readJson(path.join(targetDir, "manifest.json"));
    assert.equal(manifest.shards["历年真题"].count, 3);
    assert.equal(manifest.shards["高等数学"].count, 1);
    assert.equal(manifest.shards["未分类"].count, 0);
    assert.equal(manifest.total, 4);
    const shard = await readJson(path.join(targetDir, "shards/历年真题.json"));
    assert.deepEqual(shard.map(item => [item.id, item.category_id, item.category_path]),
      [[2, 3510, "历年真题 / 数一 / 2019"], [3, 3511, "历年真题 / 数二 / 2019"], [4, 3510, "历年真题 / 数一 / 2019"]]);
    const idIndex = await readJson(path.join(targetDir, "id_index.json"));
    assert.deepEqual([idIndex[2], idIndex[3], idIndex[4]], ["历年真题", "历年真题", "历年真题"]);
    const categories = await readJson(path.join(targetDir, "categories.json"));
    const root = categories.find(category => category.name === "历年真题");
    assert.equal(root.id, synthesizedCategoryId("历年真题"));
    const numberOne = root.children.find(category => category.name === "数一");
    assert.equal(numberOne.id, synthesizedCategoryId("历年真题 / 数一"));
    assert.deepEqual(numberOne.children.map(category => [category.name, category.id]), [["2019", 3510]]);
    const categoryQuestions = await readJson(path.join(targetDir, "category_questions.json"));
    assert.deepEqual(categoryQuestions[root.id].sort(), [2, 3, 4]);
    assert.deepEqual(categoryQuestions[numberOne.id].sort(), [2, 4]);
    assert.deepEqual(categoryQuestions[3510].sort(), [2, 4]);
    // 这些 fixture 没有 source，题号必然缺失：叶子顺序保持原样，缺号必须上报而不是静默丢弃。
    assert.deepEqual(categoryQuestions[3510], [2, 4]);
    assert.deepEqual(result.missingPaperNumberRefs.map(item => [item.id, item.path]),
      [[2, "历年真题 / 数一 / 2019"], [4, "历年真题 / 数一 / 2019"], [3, "历年真题 / 数二 / 2019"]]);
    assert.equal(result.missingPaperNumberCount, 3);
    // 必需根 223/1/601 与可选根 2500 的既有语义不变：2500 在场但无题，分片为空。
    assert.deepEqual(categories.slice(0, 4).map(category => category.id), [223, 1, 601, 2500]);
    assert.equal(manifest.shards["模拟哥专区"].count, 0);
    assert.equal(manifest.shards["线性代数"].count, 0);
    assert.equal(manifest.shards["概率统计"].count, 0);
  } finally {
    restoreFetch();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("真题叶子在目录生成阶段按卷内题号重排，缺号排在卷末并上报", async () => {
  const sourced = (id, source) => officialQuestion(id, "历年真题 / 数一 / 2019", 3510, {
    document: { question_type: "essay", stem_md: `题干${id}`, source,
      answer: { reference_answer_md: `答案${id}` }, explanation_md: "" },
  });
  // 官网返回顺序与卷内题序无关：3、1、2，外加一条没有题号的。
  const questions = [
    sourced(5, "2019数一（3）"),
    sourced(6, "2019数一（1）"),
    sourced(7, "2019数一（2）"),
    sourced(8, "2019数一"),
  ];
  const restoreFetch = stubOfficialFetch(questions, OFFICIAL_CATEGORIES);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-exam-order-sync-"));
  const targetDir = path.join(temp, "target");
  try {
    await writeMappingFiles(targetDir);
    const result = await syncOfficialQuestionBank({ targetDir });
    const categoryQuestions = await readJson(path.join(targetDir, "category_questions.json"));
    assert.deepEqual(categoryQuestions[3510], [6, 7, 5, 8]);
    // 分片顺序保持官网返回顺序，本次改动不重排分片。
    const shard = await readJson(path.join(targetDir, "shards/历年真题.json"));
    assert.deepEqual(shard.map(item => item.id), [5, 6, 7, 8]);
    assert.deepEqual(result.missingPaperNumberRefs,
      [{ id: 8, path: "历年真题 / 数一 / 2019", source: "2019数一" }]);
    assert.equal(result.missingPaperNumberCount, 1);
  } finally {
    restoreFetch();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a changed official category path forces a resync instead of reporting unchanged", async () => {
  const questions = [officialQuestion(1, "高等数学 / 极限", 224)];
  const categories = OFFICIAL_CATEGORIES.map(category => structuredClone(category));
  const restoreFetch = stubOfficialFetch(questions, categories);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-exam-tree-fingerprint-"));
  const targetDir = path.join(temp, "target");
  try {
    await writeMappingFiles(targetDir);
    const first = await syncOfficialQuestionBank({ targetDir });
    assert.equal(first.unchanged, undefined);
    const unchanged = await syncOfficialQuestionBank({ targetDir, currentFingerprint: first.fingerprint });
    assert.equal(unchanged.unchanged, true);
    // 只改官网路径字段（content_hash 与分类 ID 都不变），指纹必须变化。
    questions[0].category_full_path = "高等数学 / 连续";
    questions[0].category_name = "高等数学 / 连续";
    const changed = await syncOfficialQuestionBank({ targetDir, currentFingerprint: first.fingerprint });
    assert.notEqual(changed.fingerprint, first.fingerprint);
    assert.equal(changed.unchanged, undefined);
  } finally {
    restoreFetch();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("required root validation still blocks the sync after 真题合成接入", async () => {
  const restoreFetch = stubOfficialFetch([officialQuestion(2, "历年真题 / 数一 / 2019", 3510)],
    OFFICIAL_CATEGORIES.filter(category => category.id !== 601));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-exam-tree-required-"));
  const targetDir = path.join(temp, "target");
  try {
    await writeMappingFiles(targetDir);
    await assert.rejects(() => syncOfficialQuestionBank({ targetDir }), /官网缺少预期根分类 601/);
    assert.deepEqual(await fs.readdir(targetDir).then(names => names.sort()), ["lecture-video-mappings.json", "paradiyu-linear-video.json"]);
  } finally {
    restoreFetch();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
