import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyLocalClassifications, syncOfficialQuestionBank } from "../local-server/official-question-bank.mjs";
import { mergeLocalQuestionBanks } from "../shared/local-question-banks.mjs";
import { createQuestionBankUpdater } from "../local-server/question-bank-updater.mjs";
import { applyNativeSolutions, emptyNativeSolutionStats, questionSignature } from "../shared/native-solutions.mjs";

const ROOTS = [223, 1, 601, 836, 2500];
const CATEGORIES = ROOTS.map(id => ({ id, name: `分类${id}`, children: [] }));

const choiceOptions = [
  { id: "opt-a", label: "A", content_md: "甲" },
  { id: "opt-b", label: "B", content_md: "乙" },
];

const OFFICIAL_QUESTIONS = [
  { id: 1, category_id: 223, category_ids: [223], content_hash: "h1", is_core: false,
    document: { question_type: "essay", stem_md: "主观题干", answer: { reference_answer_md: "官网答案" },
      explanation_md: "官网解析" } },
  { id: 2, category_id: 1, category_ids: [1], content_hash: "h2", is_core: false,
    document: { question_type: "single_choice", stem_md: "选择题干", options: choiceOptions,
      answer: { option_ids: ["opt-b"] }, explanation_md: "官网解析2" } },
  { id: 3, category_id: 601, category_ids: [601], content_hash: "h3", is_core: false,
    document: { question_type: "essay", stem_md: "旧题干", answer: { reference_answer_md: "官网答案3" } } },
  { id: 4, category_id: 223, category_ids: [223], content_hash: "h4", is_core: false,
    document: { question_type: "single_choice", stem_md: "选择题干4", options: choiceOptions,
      answer: { option_ids: ["opt-b"] }, explanation_md: "官网解析4" } },
];

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function stubOfficialFetch(questions = OFFICIAL_QUESTIONS, categories = CATEGORIES) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const target = new URL(url);
    if (target.pathname === "/api/categories") return jsonResponse(categories);
    const page = Number(target.searchParams.get("page") || 1);
    const perPage = Number(target.searchParams.get("per_page") || 200);
    const total = questions.length;
    return jsonResponse({ code: 0, data: {
      items: questions.slice((page - 1) * perPage, page * perPage),
      total, total_pages: Math.max(1, Math.ceil(total / perPage)), page,
    } });
  };
  return () => { globalThis.fetch = original; };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function rmTemp(dir, prefix) {
  const resolved = path.resolve(dir);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith(prefix)) {
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

async function writeBundledData(dir) {
  await fs.mkdir(dir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ total: 1 })),
    fs.writeFile(path.join(dir, "lecture-video-mappings.json"), JSON.stringify({ questions: {} })),
    fs.writeFile(path.join(dir, "paradiyu-linear-video.json"), JSON.stringify({ questions: {} })),
    fs.writeFile(path.join(dir, "official-orphan-classifications.json"),
      JSON.stringify({ version: 1, categories: [], assignments: {} })),
  ]);
}

async function writeMappingFiles(dir) {
  await fs.mkdir(dir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(dir, "lecture-video-mappings.json"), JSON.stringify({ questions: {} })),
    fs.writeFile(path.join(dir, "paradiyu-linear-video.json"), JSON.stringify({ questions: {} })),
  ]);
}

async function writeSolutionsFile(dir, body) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "native-solutions.json"), JSON.stringify(body, null, 2));
}

test("official sync applies reviewed native solutions without touching identity or indexes", async () => {
  const restoreFetch = stubOfficialFetch();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-native-sync-"));
  const baseDir = path.join(temp, "baseline");
  const targetDir = path.join(temp, "target");
  try {
    await writeMappingFiles(baseDir);
    await writeMappingFiles(temp);
    const baseline = await syncOfficialQuestionBank({ targetDir: baseDir });
    assert.deepEqual(baseline.native_solution_stats, emptyNativeSolutionStats());

    const baselineIndex = await readJson(path.join(baseDir, "id_index.json"));
    const baselineCategories = await readJson(path.join(baseDir, "categories.json"));
    const baselineCategoryQuestions = await readJson(path.join(baseDir, "category_questions.json"));
    const baselineSearchIndex = await readJson(path.join(baseDir, "search_index.json"));
    const baselineManifest = await readJson(path.join(baseDir, "manifest.json"));
    const baselineShard = await readJson(path.join(baseDir, "shards/高等数学.json"));
    const baselineShader = await readJson(path.join(baseDir, "shards/线性代数.json"));
    assert.equal(baselineShard.find(question => question.id === 1).answer, "官网答案");
    assert.equal(Object.hasOwn(baselineShard.find(question => question.id === 1), "native_solution"), false);

    const nativeSource = { document: "MinerU 2026", label: "L1", file: "raw/page.md", block_start: 3, block_end: 5 };
    await writeSolutionsFile(temp, { version: 1, solutions: {
      "1": { question_hash: questionSignature({ stem: "主观题干", options: [] }),
        answer: "原生答案", explanation: "原生解析",
        stem: "注入题干", options: [{ label: "X" }], type: "single_choice", category_id: 9999, id: 777,
        native_solution: { html: "<math><mi>x</mi></math>", text: "x", source: nativeSource } },
      "2": { question_hash: questionSignature({ stem: "选择题干", options: choiceOptions }), answer: "b" },
      "3": { question_hash: questionSignature({ stem: "新题干", options: [] }), explanation: "不应出现" },
      "4": { question_hash: questionSignature({ stem: "选择题干4", options: choiceOptions }), answer: "A" },
      "9999": { question_hash: "1".repeat(64), answer: "未知题号" },
    } });

    const result = await syncOfficialQuestionBank({ targetDir, overlayDir: temp });
    assert.deepEqual(result.native_solution_stats, {
      entries: 5, applied: 2, answered: 2, explanations: 1, native_solutions: 1,
      skipped: { missing: 1, hash_mismatch: 1, conflict: 1 },
    });

    const shard = await readJson(path.join(targetDir, "shards/高等数学.json"));
    const updated = shard.find(question => question.id === 1);
    assert.equal(updated.answer, "原生答案");
    assert.equal(updated.explanation, "原生解析");
    assert.deepEqual(updated.native_solution, { html: "<math><mi>x</mi></math>", text: "x", source: nativeSource });
    assert.equal(updated.stem, "主观题干");
    assert.deepEqual(updated.options, []);
    assert.equal(updated.type, "subjective");
    assert.equal(updated.category_id, 223);
    assert.deepEqual(updated.category_ids, [223]);
    const untouched3 = (await readJson(path.join(targetDir, "shards/概率统计.json")))
      .find(question => question.id === 3);
    assert.equal(untouched3.stem, "旧题干");
    assert.equal(untouched3.explanation, "");
    assert.equal(Object.hasOwn(untouched3, "native_solution"), false);
    const conflict4 = shard.find(question => question.id === 4);
    assert.equal(conflict4.answer, "B");
    assert.deepEqual(conflict4.correct_labels, ["B"]);
    assert.equal(Object.hasOwn(conflict4, "native_solution"), false);

    const expected = structuredClone(baselineShard);
    const expectedUpdated = expected.find(question => question.id === 1);
    expectedUpdated.answer = "原生答案";
    expectedUpdated.explanation = "原生解析";
    expectedUpdated.native_solution = { html: "<math><mi>x</mi></math>", text: "x", source: nativeSource };
    assert.deepEqual(shard, expected);

    const choiceShard = await readJson(path.join(targetDir, "shards/线性代数.json"));
    const choice = choiceShard.find(question => question.id === 2);
    assert.equal(choice.answer, "B");
    assert.deepEqual(choice.correct_labels, ["B"]);
    assert.deepEqual(choice.options, choiceOptions);
    assert.deepEqual(choiceShard, baselineShader);
    assert.deepEqual(await readJson(path.join(targetDir, "id_index.json")), baselineIndex);
    assert.deepEqual(await readJson(path.join(targetDir, "categories.json")), baselineCategories);
    assert.deepEqual(await readJson(path.join(targetDir, "category_questions.json")), baselineCategoryQuestions);
    assert.deepEqual(await readJson(path.join(targetDir, "search_index.json")), baselineSearchIndex);
    const manifest = await readJson(path.join(targetDir, "manifest.json"));
    assert.equal(manifest.total, baselineManifest.total);
    assert.deepEqual(manifest.shards, baselineManifest.shards);

    const repeated = await syncOfficialQuestionBank({ targetDir: path.join(temp, "repeat"),
      overlayDir: temp, currentFingerprint: result.fingerprint });
    assert.equal(repeated.unchanged, true);
    const repeatDir = path.join(temp, "repeat-full");
    const full = await syncOfficialQuestionBank({ targetDir: repeatDir, overlayDir: temp });
    assert.deepEqual(full.native_solution_stats, result.native_solution_stats);
    assert.deepEqual(await readJson(path.join(repeatDir, "shards/高等数学.json")), shard);
    assert.deepEqual(await readJson(path.join(repeatDir, "shards/线性代数.json")), choiceShard);
  } finally {
    restoreFetch();
    await rmTemp(temp, "daguan-native-sync-");
  }
});

test("malformed native solution payloads are refused and nothing is written", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-native-invalid-"));
  const dataDir = path.join(temp, "data");
  const overlayDir = path.join(temp, "overlay");
  try {
    await fs.mkdir(path.join(dataDir, "shards"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "manifest.json"),
      JSON.stringify({ shards: { A: { file: "shards/A.json", count: 1 } } }));
    const question = { id: 1, stem: "题干", options: [], answer: "官网答案", explanation: "官网解析",
      type: "subjective", correct_labels: [] };
    await fs.writeFile(path.join(dataDir, "shards/A.json"), JSON.stringify([question]));
    const hash = questionSignature(question);
    const cases = [
      [{ version: 2, solutions: {} }, /不支持的本地方案版本/],
      [{ version: 1, solutions: [] }, /solutions 格式不合法/],
      [{ version: 1, solutions: { "1": { answer: "x" } } }, /question_hash/],
      [{ version: 1, solutions: { "1": { question_hash: "abc", answer: "x" } } }, /question_hash/],
      [{ version: 1, solutions: { "1": { question_hash: hash, note: "仅备注" } } }, /没有任何可应用/],
      [{ version: 1, solutions: { "1": { question_hash: hash, answer: 5 } } }, /answer 不合法/],
      [{ version: 1, solutions: { "1": { question_hash: hash, native_solution: { html: "" } } } }, /native_solution.html/],
      [{ version: 1, solutions: { "1": { question_hash: hash, native_solution: { html: "<p>x</p>", source: { block_start: "3" } } } } },
        /source.block_start/],
      [{ version: 1, solutions: { "0": { question_hash: hash, answer: "x" } } }, /题目 ID 不合法/],
    ];
    for (const [payload, pattern] of cases) {
      await writeSolutionsFile(overlayDir, payload);
      await assert.rejects(applyNativeSolutions(dataDir, overlayDir), pattern);
    }
    assert.deepEqual(await readJson(path.join(dataDir, "shards/A.json")), [question]);
  } finally {
    await rmTemp(temp, "daguan-native-invalid-");
  }
});

test("native solution overlay change forces a resync even when official content is unchanged", async () => {
  const restoreFetch = stubOfficialFetch();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-native-updater-"));
  const bundled = path.join(temp, "bundled");
  const dataDir = path.join(temp, "user-data");
  try {
    await writeBundledData(bundled);
    const updater = await createQuestionBankUpdater({ dataDir, bundledDataDir: bundled, enabled: true });
    try {
      const first = await updater.update();
      assert.equal(first.total, OFFICIAL_QUESTIONS.length);
      assert.equal(updater.status().native_solution_stats.applied, 0);
      assert.equal((await updater.update()).unchanged, true);

      await writeSolutionsFile(bundled, { version: 1, solutions: {
        "1": { question_hash: questionSignature({ stem: "主观题干", options: [] }),
          answer: "原生答案", explanation: "原生解析" },
      } });
      const revised = await updater.update();
      assert.notEqual(revised.id, first.id);
      assert.equal(revised.native_solution_stats.applied, 1);
      assert.equal(updater.status().native_solution_stats.applied, 1);
      const shard = await readJson(path.join(updater.dataRoot(), "shards/高等数学.json"));
      const question = shard.find(item => item.id === 1);
      assert.equal(question.answer, "原生答案");
      assert.equal(question.explanation, "原生解析");
      assert.equal(question.stem, "主观题干");
      assert.equal((await updater.update()).unchanged, true);
      assert.equal(updater.status().activeId, revised.id);
    } finally {
      await updater.stop();
    }
  } finally {
    restoreFetch();
    await rmTemp(temp, "daguan-native-updater-");
  }
});

// 836（历年真题）与 2500（模拟哥专区）是可选板块：官网下线时不应阻断同步，
// 但对应分片必须按空数组重建，旧题目不得残留。
test("optional root categories missing from the official site produce empty shards instead of failing", async () => {
  const restoreFetch = stubOfficialFetch(OFFICIAL_QUESTIONS, CATEGORIES.filter(category => ![836, 2500].includes(category.id)));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-optional-root-"));
  const targetDir = path.join(temp, "target");
  try {
    await writeMappingFiles(targetDir);
    const result = await syncOfficialQuestionBank({ targetDir });
    assert.equal(result.sourceTotal, OFFICIAL_QUESTIONS.length);
    const manifest = await readJson(path.join(targetDir, "manifest.json"));
    assert.equal(manifest.total, OFFICIAL_QUESTIONS.length);
    assert.equal(manifest.shards["历年真题"].count, 0);
    assert.equal(manifest.shards["模拟哥专区"].count, 0);
    assert.deepEqual(await readJson(path.join(targetDir, "shards/历年真题.json")), []);
    assert.deepEqual(await readJson(path.join(targetDir, "shards/模拟哥专区.json")), []);
    assert.equal(manifest.shards["高等数学"].count, 2);
    assert.equal(manifest.shards["线性代数"].count, 1);
    assert.equal(manifest.shards["概率统计"].count, 1);
  } finally {
    restoreFetch();
    await rmTemp(temp, "daguan-optional-root-");
  }
});

// 必需根分类（223/1/601）缺失仍必须中止，且不写任何文件。
test("required root category missing still blocks the sync before writing", async () => {
  const restoreFetch = stubOfficialFetch(OFFICIAL_QUESTIONS, CATEGORIES.filter(category => category.id !== 601));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-required-root-"));
  const targetDir = path.join(temp, "target");
  try {
    await writeMappingFiles(targetDir);
    await assert.rejects(() => syncOfficialQuestionBank({ targetDir }), /官网缺少预期根分类 601/);
    await assert.rejects(() => fs.access(path.join(targetDir, "manifest.json")));
  } finally {
    restoreFetch();
    await rmTemp(temp, "daguan-required-root-");
  }
});

// 挂在可选根 2500 下的本地分类在官网缺失时被跳过：题目保留并退回未分类，
// 该本地分类不写入结果目录，同时必须留下显式告警与计数。
test("local categories under a missing optional root are skipped while their questions stay unclassified", () => {
  const categories = [223, 1, 601].map(id => ({ id, name: `分类${id}`, children: [] }));
  const snapshot = {
    categories,
    total: 2,
    questions: [
      { id: 10, category_id: null, category_ids: [] },
      { id: 11, category_id: null, category_ids: [] },
    ],
  };
  const config = {
    version: 1,
    categories: [{ id: 9900100, name: "Euclid 2027八月模考", parent_id: 2500 }],
    assignments: { 10: { category_ids: [9900100] }, 11: { category_ids: [9900100] } },
  };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(String(message));
  try {
    const result = applyLocalClassifications(snapshot, config);
    assert.equal(result.questions.length, 2);
    assert.deepEqual(result.questions.map(question => question.category_id), [null, null]);
    assert.deepEqual(result.questions.map(question => question.category_ids), [[], []]);
    assert.equal(JSON.stringify(result.categories).includes("9900100"), false);
    assert.deepEqual(result.skippedLocalClassifications.roots, [2500]);
    assert.deepEqual(result.skippedLocalClassifications.categories, [9900100]);
    assert.deepEqual(result.skippedLocalClassifications.questions, [10, 11]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /可选根分类 2500 官网已缺失/);
    assert.match(warnings[0], /2 条题目映射/);
  } finally {
    console.warn = originalWarn;
  }
});

// 父节点既不是已存在的官网分类、也不在可选根白名单时，仍必须显式失败。
test("local category with an unknown non-optional parent still fails loudly", () => {
  const snapshot = {
    categories: [223, 1, 601].map(id => ({ id, name: `分类${id}`, children: [] })),
    total: 1,
    questions: [{ id: 10, category_id: null, category_ids: [] }],
  };
  const config = {
    version: 1,
    categories: [{ id: 9900101, name: "未知父节点分类", parent_id: 424242 }],
    assignments: { 10: { category_ids: [9900101] } },
  };
  assert.throws(() => applyLocalClassifications(snapshot, config), /本地分类缺少父节点：424242/);
});

// 官网保留已被分类树删除的次要分类引用（题 140 的 category_ids 含 2510）时必须可同步：
// 丢弃悬空次要分类、保留有效主分类，并留下题号/分类级别的可观察告警。
test("stray secondary category references are dropped with an observable warning while the primary category is kept", async () => {
  const strayed = {
    id: 140, category_id: 223, category_ids: [2510, 223], content_hash: "h140", is_core: false,
    document: { question_type: "essay", stem_md: "矩阵题干", answer: { reference_answer_md: "答案" } },
  };
  const restoreFetch = stubOfficialFetch([strayed]);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-stray-cat-"));
  const targetDir = path.join(temp, "target");
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(String(message));
  try {
    await writeMappingFiles(targetDir);
    const result = await syncOfficialQuestionBank({ targetDir });
    assert.equal(result.strayCategoryCount, 1);
    assert.deepEqual(result.strayCategoryRefs, [{ id: 140, categoryIds: [2510] }]);
    const shard = await readJson(path.join(targetDir, "shards/高等数学.json"));
    assert.equal(shard.length, 1);
    assert.equal(shard[0].id, 140);
    assert.equal(shard[0].category_id, 223);
    assert.deepEqual(shard[0].category_ids, [223]);
    assert.equal(shard[0].category_path.includes("分类223"), true);
    const strayWarnings = warnings.filter(message => message.includes("官网分类悬空引用"));
    assert.equal(strayWarnings.length, 1);
    assert.match(strayWarnings[0], /140->\[2510\]/);
  } finally {
    console.warn = originalWarn;
    restoreFetch();
    await rmTemp(temp, "daguan-stray-cat-");
  }
});

// 次要引用里的损坏值（NaN / 0 / 负数）不属于「官网已删除分类」，
// 不能被 stray 降级静默吞掉，必须和改动前一样显式失败。
test("malformed secondary category references still fail instead of being treated as stray", async () => {
  const cases = [
    { categoryIds: [223, "abc"], expected: /题目 142 指向不存在的分类 NaN/ },
    { categoryIds: [223, 0], expected: /题目 142 指向不存在的分类 0/ },
    { categoryIds: [223, -5], expected: /题目 142 指向不存在的分类 -5/ },
  ];
  for (const { categoryIds, expected } of cases) {
    const malformed = {
      id: 142, category_id: 223, category_ids: categoryIds, content_hash: "h142", is_core: false,
      document: { question_type: "essay", stem_md: "题干", answer: { reference_answer_md: "答案" } },
    };
    const restoreFetch = stubOfficialFetch([malformed]);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-malformed-cat-"));
    const targetDir = path.join(temp, "target");
    try {
      await writeMappingFiles(targetDir);
      await assert.rejects(() => syncOfficialQuestionBank({ targetDir }), expected);
      await assert.rejects(() => fs.access(path.join(targetDir, "manifest.json")));
    } finally {
      restoreFetch();
      await rmTemp(temp, "daguan-malformed-cat-");
    }
  }
});

// 前置净化之后再进入 applyLocalClassifications：官网悬空次要分类已被移除，
// 因此该函数看到的是干净引用，末端 validIds 校验不会因官网历史 ID 误报。
test("sanitized official snapshot passes applyLocalClassifications without stray references", async () => {
  const strayed = {
    id: 140, category_id: 223, category_ids: [2510, 223], content_hash: "h140", is_core: false,
    document: { question_type: "essay", stem_md: "题干", answer: { reference_answer_md: "答案" } },
  };
  const restoreFetch = stubOfficialFetch([strayed]);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-sanitized-flow-"));
  const targetDir = path.join(temp, "target");
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await writeMappingFiles(targetDir);
    const result = await syncOfficialQuestionBank({ targetDir });
    // 净化在 applyLocalClassifications 之前完成，同步整体成功
    assert.equal(result.strayCategoryCount, 1);
    assert.deepEqual(result.strayCategoryRefs, [{ id: 140, categoryIds: [2510] }]);
    const shard = await readJson(path.join(targetDir, "shards/高等数学.json"));
    assert.equal(shard.length, 1);
    assert.deepEqual(shard[0].category_ids, [223]);
    // 净化后的快照可安全通过 applyLocalClassifications（无悬空引用残留）
    const sanitized = {
      categories: [223, 1, 601].map(id => ({ id, name: `分类${id}`, children: [] })),
      total: 1,
      questions: [{ id: 140, category_id: 223, category_ids: [223] }],
    };
    const applied = applyLocalClassifications(sanitized, { version: 1, categories: [], assignments: {} });
    assert.deepEqual(applied.questions[0].category_ids, [223]);
  } finally {
    console.warn = originalWarn;
    restoreFetch();
    await rmTemp(temp, "daguan-sanitized-flow-");
  }
});

// 失效主分类必须能穿过 applyLocalClassifications（前置净化负责降级）。
test("invalid official primary survives applyLocalClassifications and is promoted downstream", async () => {
  const broken = {
    id: 189, category_id: 853, category_ids: [853, 2709], content_hash: "h189", is_core: false,
    document: { question_type: "essay", stem_md: "题干", answer: { reference_answer_md: "答案" } },
  };
  // 2709 必须挂在 223 之下，否则 rootId 不在 shardByRoot 中会触发「找不到分片」。
  const categories = [
    { id: 223, name: "分类223", children: [{ id: 2709, name: "分类2709", children: [] }] },
    { id: 1, name: "分类1", children: [] },
    { id: 601, name: "分类601", children: [] },
  ];
  const restoreFetch = stubOfficialFetch([broken], categories);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-primary-through-"));
  const targetDir = path.join(temp, "target");
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await writeMappingFiles(targetDir);
    const result = await syncOfficialQuestionBank({ targetDir });
    assert.equal(result.strayPrimaryCount, 1);
    assert.deepEqual(result.strayPrimaryRefs,
      [{ id: 189, original: 853, fallback: 2709, categoryIds: [2709] }]);
  } finally {
    console.warn = originalWarn;
    restoreFetch();
    await rmTemp(temp, "daguan-primary-through-");
  }
});

// 但本地 assignment 主动引入的不存在分类仍必须显式失败（overlay 校验不放宽）。
test("local assignment introducing a non-existent category still fails", () => {
  const snapshot = {
    categories: [223, 1, 601].map(id => ({ id, name: `分类${id}`, children: [] })),
    total: 1,
    questions: [{ id: 10, category_id: null, category_ids: [] }],
  };
  const config = { version: 1, categories: [], assignments: { 10: { category_ids: [888888] } } };
  assert.throws(() => applyLocalClassifications(snapshot, config), /题目 10 的本地分类不存在：888888/);
});

// 主分类失效但有有效备用分类：保留全部有效 category_ids，把第一个提升为主分类并按其分片。
test("invalid primary with a valid secondary category is promoted to that category", async () => {
  const broken = {
    id: 141, category_id: 9999, category_ids: [9999, 601, 223], content_hash: "h141", is_core: false,
    document: { question_type: "essay", stem_md: "题干", answer: { reference_answer_md: "答案" } },
  };
  const restoreFetch = stubOfficialFetch([broken]);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-promoted-primary-"));
  const targetDir = path.join(temp, "target");
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(String(message));
  try {
    await writeMappingFiles(targetDir);
    const result = await syncOfficialQuestionBank({ targetDir });
    assert.equal(result.strayPrimaryCount, 1);
    assert.deepEqual(result.strayPrimaryRefs,
      [{ id: 141, original: 9999, fallback: 601, categoryIds: [601, 223] }]);
    assert.equal(result.unclassifiedPrimaryCount, 0);
    const shard = await readJson(path.join(targetDir, "shards/概率统计.json"));
    assert.equal(shard.length, 1);
    assert.equal(shard[0].category_id, 601);
    assert.deepEqual(shard[0].category_ids, [601, 223]);
    const promoted = warnings.filter(message => message.includes("已降级到有效备用分类"));
    assert.equal(promoted.length, 1);
    assert.match(promoted[0], /141: 9999->601/);
  } finally {
    console.warn = originalWarn;
    restoreFetch();
    await rmTemp(temp, "daguan-promoted-primary-");
  }
});

// 主分类失效且没有任何有效分类：题目保留、归入未分类，并单独计数。
test("invalid primary without any valid category keeps the question unclassified", async () => {
  const broken = {
    id: 143, category_id: 8888, category_ids: [8888, 7777], content_hash: "h143", is_core: false,
    document: { question_type: "essay", stem_md: "题干", answer: { reference_answer_md: "答案" } },
  };
  const restoreFetch = stubOfficialFetch([broken]);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-unclassified-primary-"));
  const targetDir = path.join(temp, "target");
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(String(message));
  try {
    await writeMappingFiles(targetDir);
    const result = await syncOfficialQuestionBank({ targetDir });
    assert.equal(result.unclassifiedPrimaryCount, 1);
    assert.deepEqual(result.unclassifiedPrimaryRefs, [{ id: 143, original: 8888 }]);
    assert.equal(result.strayPrimaryCount, 0);
    const shard = await readJson(path.join(targetDir, "shards/未分类.json"));
    assert.equal(shard.length, 1);
    assert.equal(shard[0].category_id, null);
    assert.deepEqual(shard[0].category_ids, []);
    const unclassified = warnings.filter(message => message.includes("无有效分类，归入未分类"));
    assert.equal(unclassified.length, 1);
    assert.match(unclassified[0], /143: 8888/);
  } finally {
    console.warn = originalWarn;
    restoreFetch();
    await rmTemp(temp, "daguan-unclassified-primary-");
  }
});

// 非法主分类值（0 / 负数 / 非整数）属数据损坏，仍必须显式失败且不写盘。
test("illegal primary category values still fail before writing", async () => {
  const cases = [
    { categoryId: 0, expected: /题目 145 的主分类不合法：0/ },
    { categoryId: -3, expected: /题目 145 的主分类不合法：-3/ },
    { categoryId: "abc", expected: /题目 145 的主分类不合法：abc/ },
  ];
  for (const { categoryId, expected } of cases) {
    const illegal = {
      id: 145, category_id: categoryId, category_ids: [223], content_hash: "h145", is_core: false,
      document: { question_type: "essay", stem_md: "题干", answer: { reference_answer_md: "答案" } },
    };
    const restoreFetch = stubOfficialFetch([illegal]);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-illegal-primary-"));
    const targetDir = path.join(temp, "target");
    try {
      await writeMappingFiles(targetDir);
      await assert.rejects(() => syncOfficialQuestionBank({ targetDir }), expected);
      await assert.rejects(() => fs.access(path.join(targetDir, "manifest.json")));
    } finally {
      restoreFetch();
      await rmTemp(temp, "daguan-illegal-primary-");
    }
  }
});

// 官网残缺选择题（answer 待补充、正确项不在选项里）必须跳过且不写入任何分片/索引，
// manifest.total 只统计实际写入题数，source_total 仍保留官网总数。
test("incomplete official choice questions are skipped and excluded from manifest total", async () => {
  const incomplete = {
    id: 11436, category_id: 223, category_ids: [223], content_hash: "h11436", is_core: false,
    document: { question_type: "single_choice", stem_md: "题干", options: choiceOptions,
      answer: { option_ids: [] }, explanation_md: "本题题干存在错误" },
  };
  const healthy = {
    id: 11437, category_id: 223, category_ids: [223], content_hash: "h11437", is_core: false,
    document: { question_type: "single_choice", stem_md: "正常题干", options: choiceOptions,
      answer: { option_ids: ["opt-a"] } },
  };
  const restoreFetch = stubOfficialFetch([incomplete, healthy]);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-incomplete-choice-"));
  const targetDir = path.join(temp, "target");
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(String(message));
  try {
    await writeMappingFiles(targetDir);
    const result = await syncOfficialQuestionBank({ targetDir });
    assert.equal(result.incompleteQuestionCount, 1);
    assert.deepEqual(result.incompleteQuestionRefs, [{ id: 11436, reason: "官网未提供正确选项" }]);
    assert.equal(result.sourceTotal, 2);
    const manifest = await readJson(path.join(targetDir, "manifest.json"));
    assert.equal(manifest.total, 1);
    assert.equal(manifest.source_total, 2);
    assert.equal(manifest.shards["高等数学"].count, 1);
    const shard = await readJson(path.join(targetDir, "shards/高等数学.json"));
    assert.equal(shard.length, 1);
    assert.equal(shard[0].id, 11437);
    const idIndex = await readJson(path.join(targetDir, "id_index.json"));
    assert.equal(Object.hasOwn(idIndex, "11436"), false);
    assert.equal(idIndex["11437"], "高等数学");
    const searchIndex = await readJson(path.join(targetDir, "search_index.json"));
    assert.equal(searchIndex.some(item => item.id === 11436), false);
    const categoryQuestions = await readJson(path.join(targetDir, "category_questions.json"));
    assert.equal((categoryQuestions["223"] || []).includes(11436), false);
    const skipped = warnings.filter(message => message.includes("官网残缺题"));
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /11436: 官网未提供正确选项/);
  } finally {
    console.warn = originalWarn;
    restoreFetch();
    await rmTemp(temp, "daguan-incomplete-choice-");
  }
});

// 残缺选择题同样不得绕过分类完整性校验：非法分类必须先失败且不写盘。
test("incomplete choice question with an illegal category still fails before writing", async () => {
  const broken = {
    id: 11438, category_id: 0, category_ids: [223], content_hash: "h11438", is_core: false,
    document: { question_type: "single_choice", stem_md: "题干", options: choiceOptions,
      answer: { option_ids: [] } },
  };
  const restoreFetch = stubOfficialFetch([broken]);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-incomplete-illegal-cat-"));
  const targetDir = path.join(temp, "target");
  try {
    await writeMappingFiles(targetDir);
    await assert.rejects(() => syncOfficialQuestionBank({ targetDir }), /题目 11438 的主分类不合法：0/);
    await assert.rejects(() => fs.access(path.join(targetDir, "manifest.json")));
  } finally {
    restoreFetch();
    await rmTemp(temp, "daguan-incomplete-illegal-cat-");
  }
});

// 本地 overlay 题库的选择题形状校验不得随官网残缺题跳过而放宽。
test("local overlay malformed choice questions still fail", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-overlay-choice-"));
  const dataDir = path.join(temp, "data");
  const overlayDir = path.join(temp, "overlay");
  try {
    await fs.mkdir(path.join(dataDir, "shards"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(dataDir, "manifest.json"), JSON.stringify({ total: 1, types: {},
        shards: { 高等数学: { file: "shards/高等数学.json", count: 0 } } })),
      fs.writeFile(path.join(dataDir, "shards/高等数学.json"), JSON.stringify([])),
      fs.writeFile(path.join(dataDir, "categories.json"), JSON.stringify([
        { id: 223, name: "高等数学", parent_id: null, question_count: 0, direct_count: 0, children: [] }])),
      fs.writeFile(path.join(dataDir, "category_questions.json"), JSON.stringify({ 223: [] })),
      fs.writeFile(path.join(dataDir, "id_index.json"), JSON.stringify({})),
      fs.writeFile(path.join(dataDir, "search_index.json"), JSON.stringify([])),
    ]);
    await fs.mkdir(path.join(overlayDir, "local_question_banks"), { recursive: true });
    await fs.writeFile(path.join(overlayDir, "local_question_banks/bad.json"), JSON.stringify({
      shard: "高等数学",
      parentCategoryId: 223,
      rootCategory: { id: 9900300, name: "坏题库" },
      chapters: [{ id: 9900301, name: "一章", questionCount: 1 }],
      questions: [{ id: 990030001, type: "single_choice", category_id: 9900301,
        category_path: "坏题库 / 一章", stem: "题干", options: [], correct_labels: ["A"] }],
    }));
    await assert.rejects(() => mergeLocalQuestionBanks(dataDir, overlayDir), /缺少选项/);
  } finally {
    await rmTemp(temp, "daguan-overlay-choice-");
  }
});
