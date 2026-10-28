import test from "node:test";
import assert from "node:assert/strict";
import { addCollectionCategories, fetchOfficialCollections } from "../local-server/official-question-bank.mjs";

// 契约取自上游 774a695f 的 local-server/official-question-bank.mjs / test/official-question-bank-categories.test.mjs：
// 列表本体响应的 data 就是 metadata；directory.data = { total, roots }，节点是 label / category_id / question_count / children；
// items 只保证 data.items 与 data.total。题序按 items 数组序，position 不参与排序。
const collectionId = "linear-algebra-selected-20261018";
const listPath = `/api/question-lists/${collectionId}`;
const itemsPath = `${listPath}/items?page=1&per_page=200`;

const definition = { id: collectionId, parentRootId: 1, categoryIdBase: 7_000_000 };

// 上游同名测试的夹具：题 101 归 9，题 102 归 10，items 数组序与 position 相反。
const buildResult = () => ({
  categories: [{ id: 1, name: "线性代数", parent_id: null, question_count: 2, direct_count: 0, children: [] }],
  categoryQuestions: { 1: [101, 102] },
  shards: { 线性代数: [{ id: 101, category_ids: [9] }, { id: 102, category_ids: [10] }] },
  manifest: { version: 1, total: 2, shards: { 线性代数: { file: "shards/线性代数.json", count: 2 } } },
});

const collectionOf = (overrides = {}) => ({
  definition,
  metadata: { id: collectionId, name: "线代严选题", revision: 2, item_count: 2,
    is_official: true, status: "published", definition_kind: "explicit" },
  directory: { total: 2, roots: [{ id: "1", label: "线性代数", category_id: 1, question_count: 2,
    children: [
      { id: "9", label: "行列式", category_id: 9, question_count: 1, children: [] },
      { id: "10", label: "矩阵", category_id: 10, question_count: 1, children: [] },
    ] }] },
  // position 与数组序故意相反：数组里 102 在前但 position 为 2，投影必须仍按数组序。
  items: [{ question_id: 102, position: 2, available: true }, { question_id: 101, position: 1, available: false }],
  ...overrides,
});

test("题单成为线性代数下的只读目录，题序按 items 数组序而非 position", () => {
  const result = buildResult();
  addCollectionCategories(result, [collectionOf()]);
  const root = result.categories[0].children.find(category => category.id === 7000000);
  assert.equal(root.name, "线代严选题", "显示名取自 metadata.name");
  assert.equal(root.collection_id, collectionId);
  assert.equal(root.parent_id, 1, "根直接挂在 parentRootId 下，不额外套一层");
  assert.equal(root.question_count, 2);
  // 数组序 [102, 101] 优先：102 的 position 是 2、101 是 1，按 position 排会得到 [101, 102]。
  assert.deepEqual(result.categoryQuestions["7000000"], [102, 101]);
  assert.deepEqual(result.categoryQuestions["7000009"], [101]);
  assert.deepEqual(result.categoryQuestions["7000010"], [102]);
  // 子节点用 label 作显示名，ID = base + 目录 category_id。
  assert.deepEqual(root.children.map(category => [category.id, category.name, category.parent_id]),
    [[7000009, "行列式", 7000000], [7000010, "矩阵", 7000000]]);
  // 题单不改变原学科题数与索引。
  assert.deepEqual(result.categoryQuestions["1"], [101, 102]);
  assert.equal(result.categories[0].question_count, 2);
  assert.equal(result.manifest.total, 2);
  assert.deepEqual(result.manifest.collections, [
    { id: collectionId, name: "线代严选题", question_count: 2, unmatched: 0 },
  ]);
});

test("无目录命中时挂到题单根并计入 unmatched，direct_count 用实际落位计数", () => {
  const result = buildResult();
  const collection = collectionOf();
  // 题 102 的 category_ids 改成目录里不存在的 99：目录 10 因此不再是它的落点。
  collection.directory.roots[0].children[1].question_count = 0;
  result.shards = { 线性代数: [{ id: 101, category_ids: [9] }, { id: 102, category_ids: [99] }] };
  addCollectionCategories(result, [collection]);
  const root = result.categories[0].children.find(category => category.id === 7000000);
  assert.equal(root.question_count, 2);
  assert.equal(root.direct_count, 1, "只有 102 落在题单根本层");
  assert.deepEqual(result.categoryQuestions["7000000"], [102, 101]);
  assert.deepEqual(result.manifest.collections[0].unmatched, 1);
});

test("缺题即使 idIndex 里伪造了也要失败（只用分片真实记录）", () => {
  const result = buildResult();
  result.idIndex = { 101: "线性代数", 102: "线性代数", 999: "线性代数" };
  const collection = collectionOf({ items: [{ question_id: 999, position: 1 }] });
  collection.directory = { total: 1, roots: [{ id: "1", label: "线性代数", category_id: 1,
    question_count: 1, children: [] }] };
  collection.metadata = { ...collection.metadata, item_count: 1 };
  assert.throws(() => addCollectionCategories(result, [collection]), /题库中不存在的题目 999/);
});

test("目录 question_count 与实际不一致、重复题目、ID 冲突、缺父分类都显式失败", () => {
  const wrongCount = collectionOf();
  wrongCount.directory.roots[0].children[0].question_count = 2;
  assert.throws(() => addCollectionCategories(buildResult(), [wrongCount]), /题数不一致/);

  const duplicated = collectionOf({ items: [{ question_id: 102 }, { question_id: 102 }] });
  assert.throws(() => addCollectionCategories(buildResult(), [duplicated]), /含重复题目/);

  // 题单根 ID 与既有分类冲突。
  const rootTaken = buildResult();
  rootTaken.categories.push({ id: 7000000, name: "既有分类", parent_id: null,
    question_count: 0, direct_count: 0, children: [] });
  assert.throws(() => addCollectionCategories(rootTaken, [collectionOf()]), /已被占用：7000000/);

  // 子节点派生 ID 与既有分类冲突。
  const childTaken = buildResult();
  childTaken.categories.push({ id: 7000009, name: "既有分类", parent_id: null,
    question_count: 0, direct_count: 0, children: [] });
  assert.throws(() => addCollectionCategories(childTaken, [collectionOf()]), /已被占用：7000009/);

  // 目录里重复 category_id。
  const repeatedDirectory = collectionOf();
  repeatedDirectory.directory.roots[0].children.push(
    { id: "9", label: "重复", category_id: 9, question_count: 0, children: [] });
  assert.throws(() => addCollectionCategories(buildResult(), [repeatedDirectory]), /重复 category_id/);

  // 父根分类不存在。
  const noParent = collectionOf();
  noParent.definition = { ...definition, parentRootId: 42 };
  assert.throws(() => addCollectionCategories(buildResult(), [noParent]), /父分类 42 不存在/);
});

// --- 读取层：严格路由 mock，未登记的 URL 直接抛错以免假阳性 ---
const metadataBody = (overrides = {}) => ({ code: 0, data: { id: collectionId, name: "线代严选题",
  revision: 2, item_count: 2, is_official: true, status: "published", definition_kind: "explicit",
  ...overrides } });
const directoryBody = (total = 2) => ({ code: 0, data: { total, roots: [{ id: "1", label: "线性代数",
  category_id: 1, question_count: 2, children: [
    { id: "9", label: "行列式", category_id: 9, question_count: 1, children: [] },
    { id: "10", label: "矩阵", category_id: 10, question_count: 1, children: [] },
  ] }] } });
const itemsBody = (items, total = 2) => ({ code: 0, data: { items, total, page: 1, per_page: 200 } });

function stubRoutes(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const target = new URL(url);
    const key = `${target.pathname}${target.search}`;
    if (!Object.hasOwn(routes, key)) throw new Error(`测试未预期的请求：${key}`);
    const value = routes[key];
    return new Response(JSON.stringify(typeof value === "function" ? value() : value),
      { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return () => { globalThis.fetch = original; };
}

const routesOf = (overrides = {}) => ({
  [listPath]: metadataBody(),
  [`${listPath}/directory`]: directoryBody(),
  [itemsPath]: itemsBody([{ question_id: 102, position: 2, available: true },
    { question_id: 101, position: 1, available: false }]),
  ...overrides,
});

test("metadata 用列表本体响应的 data，revision 与原始 item 字段都保留", async () => {
  const restore = stubRoutes(routesOf());
  try {
    const [collection] = await fetchOfficialCollections();
    assert.deepEqual(collection.definition, definition);
    assert.deepEqual(collection.metadata, metadataBody().data);
    assert.equal(collection.metadata.revision, 2);
    assert.deepEqual(collection.directory, directoryBody().data);
    // items 保留原始对象：position / available 不丢、也不参与排序（102 在前但 position 为 2）。
    assert.deepEqual(collection.items, [{ question_id: 102, position: 2, available: true },
      { question_id: 101, position: 1, available: false }]);
  } finally { restore(); }
});

test("题单为空（total 0、items 空数组）是合法输入", async () => {
  const restore = stubRoutes(routesOf({
    [listPath]: metadataBody({ item_count: 0 }),
    [itemsPath]: itemsBody([], 0),
    [`${listPath}/directory`]: { code: 0, data: { total: 0, roots: [{ id: "1", label: "线性代数",
      category_id: 1, question_count: 0, children: [] }] } },
  }));
  try {
    const [collection] = await fetchOfficialCollections();
    assert.deepEqual(collection.items, []);
    assert.equal(collection.metadata.item_count, 0);
    const result = { categories: [{ id: 1, name: "线性代数", parent_id: null, question_count: 0,
      direct_count: 0, children: [] }], categoryQuestions: {}, shards: {}, manifest: {} };
    addCollectionCategories(result, [collection]);
    const root = result.categories[0].children.find(category => category.id === 7000000);
    assert.equal(root.question_count, 0);
    assert.deepEqual(result.categoryQuestions["7000000"], []);
    assert.deepEqual(result.manifest.collections,
      [{ id: collectionId, name: "线代严选题", question_count: 0, unmatched: 0 }]);
  } finally { restore(); }
});

test("metadata 必须官方、已发布、显式且 ID 一致", async () => {
  const cases = [[{ is_official: false }, /不可用或格式不符/], [{ status: "draft" }, /不可用或格式不符/],
    [{ definition_kind: "auto" }, /不可用或格式不符/], [{ id: "other" }, /不可用或格式不符/]];
  for (const [patch, pattern] of cases) {
    const restore = stubRoutes(routesOf({ [listPath]: metadataBody(patch) }));
    try {
      await assert.rejects(() => fetchOfficialCollections(), pattern);
    } finally { restore(); }
  }
});

test("三处题数必须一致，缺页与重复题目都显式失败", async () => {
  // directory.total 与 metadata.item_count 不一致。
  let restore = stubRoutes(routesOf({ [`${listPath}/directory`]: directoryBody(3) }));
  try { await assert.rejects(() => fetchOfficialCollections(), /数量不一致/); } finally { restore(); }
  // items.total 与 metadata.item_count 不一致。
  restore = stubRoutes(routesOf({ [itemsPath]: itemsBody([{ question_id: 102 }, { question_id: 101 },
    { question_id: 103 }], 3) }));
  try { await assert.rejects(() => fetchOfficialCollections(), /数量不一致/); } finally { restore(); }
  // 分页提前结束：声称 2 条却只给了 1 条且第二页为空。
  restore = stubRoutes(routesOf({
    [itemsPath]: itemsBody([{ question_id: 102 }]),
    [`${listPath}/items?page=2&per_page=200`]: itemsBody([], 2),
  }));
  try { await assert.rejects(() => fetchOfficialCollections(), /分页提前结束/); } finally { restore(); }
  // 重复题目。
  restore = stubRoutes(routesOf({ [itemsPath]: itemsBody([{ question_id: 102 }, { question_id: 102 }]) }));
  try { await assert.rejects(() => fetchOfficialCollections(), /含重复题目/); } finally { restore(); }
});

test("产品只请求 mock 精确登记的 URL，路由漂移会立刻暴露", async () => {
  const routes = routesOf();
  delete routes[`${listPath}/directory`];
  const restore = stubRoutes(routes);
  try {
    await assert.rejects(() => fetchOfficialCollections(), /未预期的请求：.*\/directory$/);
  } finally { restore(); }
});
