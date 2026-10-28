import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncOfficialQuestionBank } from "../local-server/official-question-bank.mjs";
import { createQuestionBankUpdater } from "../local-server/question-bank-updater.mjs";

// --- 官网 mock：严格路由，三个题单端点、题目分页、分类各自精确匹配 ---
const collectionId = "linear-algebra-selected-20261018";
const listPath = `/api/question-lists/${collectionId}`;
const directoryPath = `${listPath}/directory`;
const itemsPath = `${listPath}/items`;

const question = (id, { categoryId = null, categoryIds = [], pending = false, type = "essay",
  options, optionIds } = {}) => ({
  id, content_hash: `h${id}`, is_core: false,
  category_id: categoryId, category_ids: categoryIds,
  document: { question_type: type, stem_md: `题干${id}`,
    ...(options ? { options } : {}),
    answer: pending ? { pending: true } : (optionIds ? { option_ids: optionIds } : { reference_answer_md: `答案${id}` }),
    explanation_md: `解析${id}` },
});

const categoriesOf = () => [
  { id: 223, name: "高等数学", children: [{ id: 261, name: "极限", children: [] }] },
  { id: 1, name: "线性代数", children: [] },
  { id: 601, name: "概率统计", children: [] },
];

const metadataOf = (revision = 1, itemCount = 2) => ({ code: 0, data: { id: collectionId,
  name: "线代严选题", revision, item_count: itemCount, is_official: true, status: "published",
  definition_kind: "explicit" } });

// 有题题单：根 category_id=1，两个子节点用真实分类 261 / 601，与下面的题目分类一一对应。
const directoryWithItems = (label = "线性代数") => ({ code: 0, data: { total: 2, roots: [
  { id: "1", label, category_id: 1, question_count: 2, children: [
    { id: "261", label: "极限", category_id: 261, question_count: 1, children: [] },
    { id: "601", label: "概率统计", category_id: 601, question_count: 1, children: [] },
  ] }] } });
const itemsWithQuestions = (rows = [{ question_id: 21, position: 1, available: true },
  { question_id: 22, position: 2, available: false }]) => ({ code: 0, data: { items: rows,
  total: rows.length, page: 1, per_page: 200 } });

// 空题单：合法 shape，questions 不参与题单，供与题单无关的用例使用。
const emptyCollection = () => ({
  metadata: metadataOf(1, 0),
  directory: { code: 0, data: { total: 0, roots: [{ id: "1", label: "线性代数",
    category_id: 1, question_count: 0, children: [] }] } },
  items: itemsWithQuestions([]),
});

function stubOfficial(state) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const target = new URL(url);
    const json = value => new Response(JSON.stringify(value), { status: 200,
      headers: { "Content-Type": "application/json" } });
    const name = target.pathname;
    if (name === listPath) {
      // 两种失败形态都要能复现：业务错误（HTTP 200 + code 1401）与真实 HTTP 401。
      if (state.collectionHttpError) {
        return new Response(JSON.stringify({ code: 1401, detail: "Could not validate credentials" }),
          { status: 401, headers: { "Content-Type": "application/json" } });
      }
      if (state.collectionError) return json({ code: 1401, detail: "Could not validate credentials" });
      return json(state.metadata || metadataOf());
    }
    if (name === directoryPath) return json(state.directory || directoryWithItems());
    if (name === itemsPath) return json(state.items || itemsWithQuestions());
    if (name === "/api/categories") return json(state.categories || categoriesOf());
    if (name === "/api/questions") {
      const page = Number(target.searchParams.get("page") || 1);
      const perPage = Number(target.searchParams.get("per_page") || 200);
      const questions = state.questions;
      return json({ code: 0, data: { items: questions.slice((page - 1) * perPage, page * perPage),
        total: questions.length, total_pages: Math.max(1, Math.ceil(questions.length / perPage)), page } });
    }
    throw new Error(`测试未预期的请求：${name}`);
  };
  return () => { globalThis.fetch = original; };
}

const readJson = async file => JSON.parse(await fs.readFile(file, "utf8"));

async function withTemp(prefix, run) {
  const root = process.env.DAGUAN_TEST_TMP || os.tmpdir();
  const temp = await fs.mkdtemp(path.join(root, prefix));
  try { return await run(temp); } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

async function writeMappings(dir) {
  await fs.mkdir(dir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(dir, "lecture-video-mappings.json"), JSON.stringify({ questions: {} })),
    fs.writeFile(path.join(dir, "paradiyu-linear-video.json"), JSON.stringify({ questions: {} })),
  ]);
}

// 题单用例：21 归 261（目录子节点），22 归 601（目录子节点），题单根因此是 2 题。
const itemsState = () => ({
  questions: [question(21, { categoryId: 261, categoryIds: [261] }),
    question(22, { categoryId: 601, categoryIds: [601] })],
  categories: categoriesOf(), metadata: metadataOf(), directory: directoryWithItems(),
  items: itemsWithQuestions(),
});

// 与题单无关的用例：官网给空题单，题目分类由各用例自己安排。
const emptyCollectionState = () => ({
  questions: [question(21, { categoryId: 261, categoryIds: [261] }),
    question(22, { categoryId: 1, categoryIds: [1] })],
  categories: categoriesOf(), ...emptyCollection(),
});

test("题单投影落盘，相同内容再同步报告 unchanged", async () => {
  await withTemp("daguan-pipeline-basic-", async temp => {
    const targetDir = path.join(temp, "target");
    await writeMappings(targetDir);
    const restore = stubOfficial(itemsState());
    try {
      const first = await syncOfficialQuestionBank({ targetDir });
      assert.equal(first.sourceTotal, 2);
      assert.equal(first.total, 2);
      assert.deepEqual(first.collections, [{ id: collectionId, name: "线代严选题",
        question_count: 2, unmatched: 0 }]);
      const manifest = await readJson(path.join(targetDir, "manifest.json"));
      assert.deepEqual(manifest.collections, first.collections);
      // 题单目录与有序题表真的落盘：根 7000000，子节点 base + 目录 category_id。
      const categoryQuestions = await readJson(path.join(targetDir, "category_questions.json"));
      assert.deepEqual(categoryQuestions["7000000"], [21, 22]);
      assert.deepEqual(categoryQuestions["7000261"], [21]);
      assert.deepEqual(categoryQuestions["7000601"], [22]);
      const categories = await readJson(path.join(targetDir, "categories.json"));
      const linear = categories.find(category => category.id === 1);
      const root = linear.children.find(category => category.id === 7000000);
      assert.equal(root.name, "线代严选题");
      assert.deepEqual(root.children.map(category => [category.id, category.name]),
        [[7000261, "极限"], [7000601, "概率统计"]]);
      // 题单不增主库题数。
      assert.equal(manifest.total, 2);

      const again = await syncOfficialQuestionBank({ targetDir, currentFingerprint: first.fingerprint });
      assert.equal(again.unchanged, true);
    } finally { restore(); }
  });
});

test("只改题单 revision、题序或目录标签都会触发重建", async () => {
  const changes = [
    ["revision", state => { state.metadata = metadataOf(2); }],
    ["题序", state => { state.items = itemsWithQuestions([{ question_id: 22, position: 1, available: true },
      { question_id: 21, position: 2, available: false }]); }],
    ["目录标签", state => { state.directory = directoryWithItems("线性代数（改）"); }],
  ];
  for (const [label, mutate] of changes) {
    await withTemp("daguan-pipeline-fingerprint-", async temp => {
      const targetDir = path.join(temp, "target");
      await writeMappings(targetDir);
      const state = itemsState();
      let restore = stubOfficial(state);
      let baseline;
      try {
        baseline = await syncOfficialQuestionBank({ targetDir });
      } finally { restore(); }
      mutate(state);
      restore = stubOfficial(state);
      try {
        const result = await syncOfficialQuestionBank({ targetDir, currentFingerprint: baseline.fingerprint });
        assert.notEqual(result.unchanged, true, `${label} 变化必须触发重建`);
        assert.notEqual(result.fingerprint, baseline.fingerprint, `${label} 变化必须改变指纹`);
        if (label === "题序") {
          const categoryQuestions = await readJson(path.join(targetDir, "category_questions.json"));
          assert.deepEqual(categoryQuestions["7000000"], [22, 21], "题序按 items 数组序落盘");
        }
      } finally { restore(); }
    });
  }
});

test("pending 题不写入但计入官方原始总数，残缺选择题仍按原规则跳过", async () => {
  await withTemp("daguan-pipeline-pending-", async temp => {
    const targetDir = path.join(temp, "target");
    await writeMappings(targetDir);
    const state = emptyCollectionState();
    state.questions = [
      question(21, { categoryId: 261, categoryIds: [261] }),
      question(22, { categoryId: 1, categoryIds: [1] }),
      question(23, { categoryId: 1, categoryIds: [1], pending: true }),
      question(24, { categoryId: 1, categoryIds: [1], type: "single_choice",
        options: [{ id: "opt-a", label: "A", content_md: "甲" }] }),
    ];
    const restore = stubOfficial(state);
    try {
      const result = await syncOfficialQuestionBank({ targetDir });
      // 官方原始总数包含 pending 题；manifest.total 只算真正写入的题。
      assert.equal(result.sourceTotal, 4);
      assert.equal(result.skippedPending, 1);
      assert.equal(result.incompleteQuestionCount, 1);
      assert.equal(result.total, 2);
      const manifest = await readJson(path.join(targetDir, "manifest.json"));
      assert.equal(manifest.total, 2);
      assert.equal(manifest.source_total, 4);
      const idIndex = await readJson(path.join(targetDir, "id_index.json"));
      assert.equal(idIndex["23"], undefined, "pending 题不得写入");
      assert.equal(idIndex["24"], undefined, "残缺选择题不得写入");
      assert.equal(idIndex["21"], "高等数学");
    } finally { restore(); }
  });
});

test("官网清空题目分类时从上一活动版本回填，而不是 bundled", async () => {
  await withTemp("daguan-pipeline-previous-", async temp => {
    const previousDir = path.join(temp, "previous-version");
    const overlayDir = path.join(temp, "bundled");
    const targetDir = path.join(temp, "target");
    // 上一活动版本：21 有分类 261、22 有分类 1。bundled 的 manifest 不含分片信息，
    // 所以只要回填成功，就证明读的是上一活动版本而不是 bundled。
    await writeMappings(previousDir);
    await fs.mkdir(path.join(previousDir, "shards"), { recursive: true });
    await fs.writeFile(path.join(previousDir, "shards/高等数学.json"), JSON.stringify([
      { id: 21, category_id: 261, category_ids: [261] },
      { id: 22, category_id: 1, category_ids: [1] },
    ]));
    await fs.writeFile(path.join(previousDir, "manifest.json"), JSON.stringify({ total: 2,
      shards: { 高等数学: { file: "shards/高等数学.json", count: 2 } } }));
    await fs.writeFile(path.join(previousDir, "id_index.json"),
      JSON.stringify({ 21: "高等数学", 22: "高等数学" }));
    await writeMappings(overlayDir);
    await fs.writeFile(path.join(overlayDir, "manifest.json"), JSON.stringify({ total: 0 }));
    await writeMappings(targetDir);
    const state = emptyCollectionState();
    state.questions = [question(21), question(22)];
    const restore = stubOfficial(state);
    try {
      const result = await syncOfficialQuestionBank({ targetDir, overlayDir, previousDataDir: previousDir });
      assert.equal(result.preservedPreviousCategories, 2);
      assert.equal(result.unclassifiedPrimaryCount, 0);
      const math = await readJson(path.join(targetDir, "shards/高等数学.json"));
      assert.deepEqual(math.map(item => [item.id, item.category_id]), [[21, 261]]);
      const linear = await readJson(path.join(targetDir, "shards/线性代数.json"));
      assert.deepEqual(linear.map(item => [item.id, item.category_id]), [[22, 1]]);
    } finally { restore(); }
  });
});

test("本地显式 assignment 优先于上一活动版本回填", async () => {
  await withTemp("daguan-pipeline-assignment-", async temp => {
    const previousDir = path.join(temp, "previous-version");
    const overlayDir = path.join(temp, "bundled");
    const targetDir = path.join(temp, "target");
    await writeMappings(previousDir);
    await fs.mkdir(path.join(previousDir, "shards"), { recursive: true });
    await fs.writeFile(path.join(previousDir, "shards/高等数学.json"),
      JSON.stringify([{ id: 21, category_id: 261, category_ids: [261] }]));
    await fs.writeFile(path.join(previousDir, "manifest.json"), JSON.stringify({ total: 1,
      shards: { 高等数学: { file: "shards/高等数学.json", count: 1 } } }));
    await fs.writeFile(path.join(previousDir, "id_index.json"), JSON.stringify({ 21: "高等数学" }));
    await writeMappings(overlayDir);
    await fs.writeFile(path.join(overlayDir, "manifest.json"), JSON.stringify({ total: 0 }));
    // bundled overlay 明确把 21 指到 601：本地显式映射必须先于旧版本回填生效。
    await fs.writeFile(path.join(overlayDir, "official-orphan-classifications.json"),
      JSON.stringify({ version: 1, categories: [], assignments: { 21: { category_ids: [601] } } }));
    await writeMappings(targetDir);
    const state = emptyCollectionState();
    state.questions = [question(21)];
    const restore = stubOfficial(state);
    try {
      const result = await syncOfficialQuestionBank({ targetDir, overlayDir, previousDataDir: previousDir });
      assert.equal(result.preservedPreviousCategories, 0, "本地 assignment 已落位的题不回填");
      const probability = await readJson(path.join(targetDir, "shards/概率统计.json"));
      assert.deepEqual(probability.map(item => [item.id, item.category_id]), [[21, 601]]);
    } finally { restore(); }
  });
});

test("题单读取失败（业务错误与真实 401）都显式报错，updater 不切换指针也不改动良好版本", async () => {
  const failures = [
    ["业务错误 200+code1401", state => { state.collectionError = true; }, /不可用或格式不符/],
    ["真实 HTTP 401", state => { state.collectionHttpError = true; }, /401/],
  ];
  for (const [label, fail, pattern] of failures) {
    await withTemp("daguan-pipeline-collection-fail-", async temp => {
      const bundledDataDir = path.join(temp, "bundled");
      const dataDir = path.join(temp, "user-data");
      const bankDir = path.join(dataDir, "question-bank");
      await writeMappings(bundledDataDir);
      await fs.writeFile(path.join(bundledDataDir, "manifest.json"), JSON.stringify({ total: 1 }));
      await fs.writeFile(path.join(bundledDataDir, "official-orphan-classifications.json"),
        JSON.stringify({ version: 1, categories: [], assignments: {} }));
      const state = emptyCollectionState();
      let restore = stubOfficial(state);
      let updater;
      try {
        updater = await createQuestionBankUpdater({ dataDir, bundledDataDir, enabled: true });
        const first = await updater.update();
        assert.equal(first.total, 2);
        assert.equal(first.skippedPending, 0);
        assert.equal(first.preservedPreviousCategories, 0);
        const activeId = updater.status().activeId;
        assert.equal(activeId, first.id);
        const versionDir = updater.dataRoot();
        const goodManifest = await readJson(path.join(versionDir, "manifest.json"));
        const goodPointer = await readJson(path.join(bankDir, "current.json"));
        restore();
        fail(state);
        restore = stubOfficial(state);
        await assert.rejects(() => updater.update(), pattern, `${label} 必须显式失败`);
        assert.equal(updater.status().activeId, activeId, `${label}：失败不得切换指针`);
        assert.deepEqual(await readJson(path.join(bankDir, "current.json")), goodPointer,
          `${label}：指针文件内容保持不变`);
        assert.deepEqual(await readJson(path.join(versionDir, "manifest.json")), goodManifest,
          `${label}：最后良好版本的文件保持不变`);
        // 失败不得留下未登记的 staging 目录。
        const leftovers = (await fs.readdir(bankDir)).filter(name => name.startsWith("stage-"));
        assert.deepEqual(leftovers, [], `${label}：不得留下 staging 目录`);
      } finally {
        restore();
        if (updater) await updater.stop();
      }
    });
  }
});

test("取消信号在同步过程中显式失败，不产生新版本", async () => {
  await withTemp("daguan-pipeline-abort-", async temp => {
    const targetDir = path.join(temp, "target");
    await writeMappings(targetDir);
    const controller = new AbortController();
    const restore = stubOfficial(emptyCollectionState());
    try {
      controller.abort(new Error("取消同步"));
      await assert.rejects(() => syncOfficialQuestionBank({ targetDir, signal: controller.signal }),
        /取消同步/);
    } finally { restore(); }
  });
});
