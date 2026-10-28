import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mergeLocalQuestionBanks } from "../shared/local-question-banks.mjs";
import { applyNativeSolutions } from "../shared/native-solutions.mjs";

const base = "https://www.cxyonly.fans";
const pageSize = 200;
// 根分类决定题库分片归属。223/1/601 是题库主体（高数/线代/概率），
// 缺失说明官网结构异常，同步必须中止；836/2500 属可选板块，
// 官网下线后不再阻断同步，对应分片按空数组生成（旧题目随快照重建自然消失，不保留）。
const requiredRootShards = new Map([
  [223, "高等数学"], [1, "线性代数"], [601, "概率统计"],
]);
const optionalRootShards = new Map([
  [836, "历年真题"], [2500, "模拟哥专区"],
]);
const shardByRoot = new Map([...requiredRootShards, ...optionalRootShards]);
const fileByShard = new Map([
  ...[...shardByRoot.values()].map(name => [name, `shards/${name}.json`]),
  ["未分类", "shards/未分类.json"],
]);
const localClassificationsFile = "official-orphan-classifications.json";

async function getJson(url, signal) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      if (signal?.aborted || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

async function fetchOfficial(signal) {
  const first = await getJson(`${base}/api/questions?page=1&per_page=${pageSize}`, signal);
  if (first.code !== 0 || !Array.isArray(first.data?.items)) throw new Error("官网题目接口格式不符");
  const { total, total_pages: pages } = first.data;
  const chunks = Array.from({ length: pages }, () => null);
  chunks[0] = first.data.items;
  let nextPage = 2;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (nextPage <= pages) {
      const page = nextPage++;
      const result = await getJson(`${base}/api/questions?page=${page}&per_page=${pageSize}`, signal);
      if (result.code !== 0 || result.data?.total !== total || result.data?.page !== page ||
          !Array.isArray(result.data.items)) throw new Error(`官网题目分页 ${page} 在同步时变化`);
      chunks[page - 1] = result.data.items;
    }
  }));
  const questions = chunks.flat();
  const categories = await getJson(`${base}/api/categories`, signal);
  const check = await getJson(`${base}/api/questions?page=1&per_page=${pageSize}`, signal);
  if (!Array.isArray(categories) || questions.length !== total ||
      new Set(questions.map(question => String(question.id))).size !== total ||
      check.data?.total !== total ||
      JSON.stringify(check.data?.items?.map(item => [item.id, item.content_hash])) !==
        JSON.stringify(first.data.items.map(item => [item.id, item.content_hash]))) {
    throw new Error("官网题库在同步期间变化；未写入本地题库，请重试");
  }
  // 官网标记答案未完成的题（document.answer.pending）不写入本题库，但要单独计数上报：
  // total 仍是官网原始总数，写入题数由 buildCatalog 的 writtenTotal 决定。
  const pendingQuestions = questions.filter(question => question?.document?.answer?.pending === true);
  const writable = questions.filter(question => question?.document?.answer?.pending !== true);
  return { questions: writable, categories, total, skippedPending: pendingQuestions.length };
}

// 分片名与根分类名一一对应（223/1/601 必需根 + 836/2500 可选根）。
const shardNames = new Set(shardByRoot.values());

function categoryIndex(categories) {
  const byId = new Map();
  // rootName 供 buildCatalog 按名称解析分片：合成出来的真题根不再是 836，
  // 只按 ID 查表会让真题找不到分片。
  function visit(category, parent = null, rootId = null, rootName = null, prefix = "") {
    const name = String(category.name || "");
    const id = Number(category.id);
    if (!Number.isInteger(id) || byId.has(id)) throw new Error(`官网分类 ID 不合法或重复：${category.id}`);
    const resolvedRootId = rootId ?? id;
    const resolvedRootName = rootName ?? name;
    byId.set(id, { source: category, parent, rootId: resolvedRootId, rootName: resolvedRootName,
      path: prefix ? `${prefix} / ${name}` : name });
    for (const child of category.children || []) {
      visit(child, id, resolvedRootId, resolvedRootName, byId.get(id).path);
    }
  }
  for (const rootCategory of categories) visit(rootCategory);
  // 只强制必需根分类；可选板块缺失时其分片按空数组生成。
  for (const rootId of requiredRootShards.keys()) {
    if (!byId.has(rootId) || byId.get(rootId).parent !== null) throw new Error(`官网缺少预期根分类 ${rootId}`);
  }
  return byId;
}

// 真题（历年真题）分类树重建。官网 /api/categories 已下线真题子树，而 /api/questions 仍返回
// 约 1300 道真题，其分类路径形如「历年真题 / 数一 / 2019」，叶子 category_id 仍是官网
// 给出的真题叶子分类。旧快照的 836/837/855/873 等 ID 已与当前记录错配，一律不复用：
// 只按记录自带的路径字符串补回缺失的根/中间节点，叶子保留官方 ID，题目本身不改动。
// 调用顺序：必须在 sanitizeOfficialCategories 之前，否则叶子引用会被判悬空而丢弃。
//
// 路径字段取自官网原始记录：category_full_path 优先，其次 category_name。
// 官网的 category_name 存的就是完整路径（last_study 读回 shape
// { has_record, category_id, category_name, category_full_path, ... } 见
// local-server/sync-format.mjs 与 test/local-server.test.mjs）。本地的 category_path
// 是 normalizeQuestion 的产物，原始快照里没有，不能当成输入字段。
const examRootCategoryName = "历年真题";
const examSubjectNames = ["数一", "数二", "数三"];
const examYearCategoryPattern = /^\d{4}$/;
const categoryPathFields = ["category_full_path", "category_name"];
// 合成 ID 专用区间：官网当前分类 ID 最大 2766，本地 overlay 用 9900001-9900408，
// 合成 ID 落在 980000000-980999999，与两者都不相交；同一路径每次得到同一 ID。
const reservedCategoryIdRanges = [[1, 99_999], [9_900_000, 9_999_999]];
const synthesizedCategoryIdBase = 980_000_000;
const synthesizedCategoryIdCount = 1_000_000;

export function synthesizedCategoryId(categoryPath, reservedIds = new Set()) {
  const text = String(categoryPath ?? "").trim();
  if (!text) throw new Error("合成分类 ID 需要非空路径");
  const id = synthesizedCategoryIdBase + (createHash("sha256").update(text, "utf8")
    .digest().readUIntBE(0, 6) % synthesizedCategoryIdCount);
  if (reservedCategoryIdRanges.some(([minimum, maximum]) => id >= minimum && id <= maximum)) {
    throw new Error(`合成分类 ID ${id} 落入保留区间：${text}`);
  }
  if (reservedIds.has(id)) throw new Error(`合成分类 ID ${id} 与已占用分类 ID 冲突：${text}`);
  return id;
}

// 分类树的 ID→路径索引。与 categoryIndex 的差别：不做官网必需根分类检查，
// 供合成前后的树使用。ID 不合法或重复仍显式失败。
function categoryPaths(categories) {
  const pathById = new Map();
  function visit(category, prefix) {
    const id = Number(category?.id);
    const path = prefix ? `${prefix} / ${String(category?.name ?? "")}` : String(category?.name ?? "");
    if (!Number.isInteger(id) || pathById.has(id)) throw new Error(`分类 ID 不合法或重复：${category?.id}`);
    pathById.set(id, path);
    for (const child of category.children || []) visit(child, path);
  }
  for (const category of categories) visit(category, "");
  return pathById;
}

// 路径切分：容忍首尾斜杠与空格差异，保留原层级顺序；中间出现空层级视为格式损坏，
// 由调用方判定（真题路径要求恰好三层）。
function splitCategoryPath(text) {
  const segments = String(text ?? "").split("/").map(segment => segment.trim());
  if (segments[0] === "") segments.shift();
  if (segments[segments.length - 1] === "") segments.pop();
  return segments;
}

// 读取官方记录的分类路径。两个已确认字段都缺失时返回 null，由调用方按“是否可能属于
// 已下线的真题树”决定放行或显式失败；两个字段同时存在但内容不一致必须报错，不挑一个算了。
// 返回 { text, normalized }：text 用于报错，normalized 是稳定最小表示，同时用于 fingerprint。
function officialCategoryPathOf(question) {
  const values = [];
  for (const field of categoryPathFields) {
    const value = question?.[field];
    if (value == null) continue;
    if (typeof value !== "string") throw new Error(`题目 ${question.id} 的 ${field} 不是字符串`);
    const text = value.trim();
    const normalized = text ? splitCategoryPath(text).join(" / ") : "";
    if (!normalized) continue;
    if (!values.some(item => item.normalized === normalized)) values.push({ field, text, normalized });
  }
  if (values.length > 1) {
    throw new Error(`题目 ${question.id} 的分类路径字段互相冲突：` +
      values.map(item => `${item.field}「${item.text}」`).join("、"));
  }
  return values[0] ? { text: values[0].text, normalized: values[0].normalized } : null;
}

// 只认「历年真题 / 数一|数二|数三 / 四位年份」三层路径；非真题记录返回 null 原样保留。
// 同一记录带多个真题路径、层级或科目/年份不合法都显式失败，不做猜测。
function examCategoryPathOf(question, path) {
  const candidates = path.normalized.split("、").map(text => splitCategoryPath(text))
    .filter(segments => segments[0] === examRootCategoryName);
  if (!candidates.length) return null;
  if (candidates.length > 1) throw new Error(`题目 ${question.id} 带有多个真题路径：${path.text}`);
  const segments = candidates[0];
  if (segments.length !== 3) {
    throw new Error(`题目 ${question.id} 的真题路径不是「${examRootCategoryName} / 科目 / 年份」三层：${path.text}`);
  }
  const [, subject, year] = segments;
  if (!examSubjectNames.includes(subject)) throw new Error(`题目 ${question.id} 的真题科目不合法：${subject}`);
  if (!examYearCategoryPattern.test(year)) throw new Error(`题目 ${question.id} 的真题年份不是四位年份：${year}`);
  return { subject, year, path: segments.join(" / "), subjectPath: `${examRootCategoryName} / ${subject}` };
}

// 卷内题号解析。source 是自由文本，一道题可能带多段「年份+科目（题号）」，
// 例如「2005数二（6）；2005数一（5）」在数一卷里是第 5 题、在数二卷里是第 6 题：
// 取第一个括号会把题号排到别的科目上，所以必须按叶子科目的年份取段。
// 括号内容只认两种已观察形态：纯数字，以及「一6、二7、三5」这类按科目列举；
// 其余括号（「仅数三」「先于真题出现」「版本二」「第三大题第（2）小题」）不是题号。
// 没有题号返回 { missing: true }，不抛错；同一卷解析出多个不同题号必须显式失败。
export function parsePaperNumber(source, { subject, year } = {}) {
  if (!examSubjectNames.includes(subject)) {
    throw new Error(`卷内题号需要真题科目（${examSubjectNames.join("、")}）：${subject}`);
  }
  const yearText = String(year ?? "");
  if (!examYearCategoryPattern.test(yearText)) throw new Error(`卷内题号需要四位年份：${year ?? ""}`);
  const subjectChar = subject.slice(1);
  const numbers = [];
  // 全角/半角括号都要认；年份与科目紧贴括号，避免把后面的题源括号当成题号。
  for (const match of String(source ?? "").matchAll(/(\d{4})\s*数([一二三]+)\s*[（(]([^）)]*)[）)]/g)) {
    if (match[1] !== yearText || !match[2].includes(subjectChar)) continue;
    const body = match[3].trim();
    if (/^\d+$/.test(body)) {
      numbers.push(Number(body));
      continue;
    }
    for (const part of body.split(/[、,，]/)) {
      const item = part.trim().match(/^([一二三])\s*(\d+)$/);
      if (item && item[1] === subjectChar) numbers.push(Number(item[2]));
    }
  }
  const unique = [...new Set(numbers)];
  if (!unique.length) return { missing: true };
  if (unique.length > 1) {
    throw new Error(`真题题号冲突：${subject} ${yearText} 解析出多个题号 ${unique.join("、")}：${String(source)}`);
  }
  return { number: unique[0] };
}

// 分类路径是否为「历年真题 / 科目 / 年份」叶子。真题聚合节点（根、科目二级）返回 null：
// 它们没有单一卷内题号，不能拿某个年份叶子的题号去排。
function examPaperLeafOf(categoryPath) {
  const segments = splitCategoryPath(categoryPath);
  if (segments.length !== 3) return null;
  const [root, subject, year] = segments;
  if (root !== examRootCategoryName) return null;
  if (!examSubjectNames.includes(subject) || !examYearCategoryPattern.test(year)) return null;
  return { subject, year };
}

// 单个真题叶子的卷内排序：题号升序；缺号项放末尾并保持输入相对顺序；同号保持原顺序。
// 不按 id 去重——跨卷共享题在各自叶子里是不同的卷内位置（如「一5、二7、三5」），
// 必须逐个叶子用该叶子的科目与年份解析。缺号不丢弃，随 missing 一起返回供审计。
// 非真题路径原样返回一份副本；题号冲突由 parsePaperNumber 抛出，不在此静默兜底。
export function sortExamPaperQuestions(categoryPath, ids, questionsById) {
  const leaf = examPaperLeafOf(categoryPath);
  if (!leaf) return { ids: [...ids], missing: [] };
  const rows = ids.map((id, index) => {
    const question = questionsById.get(Number(id));
    if (!question) throw new Error(`真题叶子 ${categoryPath} 引用了不存在的题目 ${id}`);
    return { id: Number(id), index, source: String(question.source ?? ""),
      parsed: parsePaperNumber(question.source, leaf) };
  });
  const missing = rows.filter(row => row.parsed.missing)
    .map(row => ({ id: row.id, path: categoryPath, source: row.source }));
  const ordered = [...rows].sort((left, right) => {
    const a = left.parsed, b = right.parsed;
    if (!!a.missing !== !!b.missing) return a.missing ? 1 : -1;
    if (!a.missing && a.number !== b.number) return a.number - b.number;
    return left.index - right.index;
  });
  return { ids: ordered.map(row => row.id), missing };
}

export function synthesizeExamCategoryTree(snapshot) {
  if (!Array.isArray(snapshot?.questions) || !Array.isArray(snapshot?.categories)) {
    throw new Error("真题分类合成需要 questions 与 categories 数组");
  }
  const categories = structuredClone(snapshot.categories);
  const pathById = categoryPaths(categories);
  // 先按记录建立「路径 ↔ 官方叶子 ID」一一对应；冲突即官网结构异常。
  const examEntries = [];
  const leafIdByPath = new Map();
  const pathByLeafId = new Map();
  for (const question of snapshot.questions) {
    const path = officialCategoryPathOf(question);
    if (path == null) {
      // 没有路径时不能一律当成非真题静默跳过：真题子树已从 /api/categories 下线，
      // 若该题引用了一个格式合法、却不在官网分类树上的分类，极可能就是真题记录，必须显式失败。
      // 0、负数、NaN 等损坏值不在此判定：留给 sanitizeOfficialCategories 报它原有的错误。
      const unknownCategoryIds = [...new Set([question.category_id,
        ...(Array.isArray(question.category_ids) ? question.category_ids : [])]
        .filter(id => id != null).map(Number))]
        .filter(id => Number.isInteger(id) && id > 0 && !pathById.has(id));
      if (unknownCategoryIds.length) {
        throw new Error(`题目 ${question.id} 缺少分类路径字段（${categoryPathFields.join(" / ")}），` +
          `且分类 ${unknownCategoryIds.join("、")} 不在官网分类树中，无法判断是否真题`);
      }
      continue;
    }
    const parsed = examCategoryPathOf(question, path);
    if (!parsed) continue;
    const leafId = Number(question.category_id);
    if (!Number.isInteger(leafId) || leafId <= 0) {
      throw new Error(`题目 ${question.id} 的真题路径缺少官方叶子分类 ID：${parsed.path}`);
    }
    const knownLeafId = leafIdByPath.get(parsed.path);
    if (knownLeafId != null && knownLeafId !== leafId) {
      throw new Error(`真题路径 ${parsed.path} 对应多个官方叶子分类 ID：${knownLeafId}、${leafId}`);
    }
    const knownPath = pathByLeafId.get(leafId);
    if (knownPath != null && knownPath !== parsed.path) {
      throw new Error(`真题叶子分类 ID ${leafId} 对应多个路径：${knownPath}、${parsed.path}`);
    }
    leafIdByPath.set(parsed.path, leafId);
    pathByLeafId.set(leafId, parsed.path);
    examEntries.push({ ...parsed, leafId });
  }
  const reservedIds = new Set(pathById.keys());
  for (const leafId of pathByLeafId.keys()) reservedIds.add(leafId);
  const findChild = (children, name, path) => {
    const matches = children.filter(child => String(child?.name ?? "") === name);
    if (matches.length > 1) throw new Error(`分类路径重复：${path}`);
    return matches[0] || null;
  };
  const createNode = (name, path, id) => {
    if (pathById.has(id)) throw new Error(`分类 ID 已被占用：${id}（${pathById.get(id)}）`);
    pathById.set(id, path);
    reservedIds.add(id);
    return { id, name, children: [] };
  };
  let examRoot = null;
  if (examEntries.length) {
    examRoot = findChild(categories, examRootCategoryName, examRootCategoryName);
    if (!examRoot) {
      examRoot = createNode(examRootCategoryName, examRootCategoryName,
        synthesizedCategoryId(examRootCategoryName, reservedIds));
      categories.push(examRoot);
    }
    examRoot.children ||= [];
    const yearsBySubject = new Map(examSubjectNames.map(name => [name, new Set()]));
    for (const entry of examEntries) yearsBySubject.get(entry.subject).add(entry.year);
    for (const subject of examSubjectNames) {
      const years = [...yearsBySubject.get(subject)];
      if (!years.length) continue;
      const subjectPath = `${examRootCategoryName} / ${subject}`;
      let subjectNode = findChild(examRoot.children, subject, subjectPath);
      if (!subjectNode) {
        subjectNode = createNode(subject, subjectPath, synthesizedCategoryId(subjectPath, reservedIds));
        examRoot.children.push(subjectNode);
      }
      subjectNode.children ||= [];
      for (const year of years.sort()) {
        const path = `${subjectPath} / ${year}`;
        const leafId = leafIdByPath.get(path);
        const leaf = findChild(subjectNode.children, year, path);
        if (leaf) {
          if (Number(leaf.id) !== leafId) {
            throw new Error(`真题叶子分类 ID 与官方记录不一致：${path}（分类树 ${leaf.id}，题目记录 ${leafId}）`);
          }
          continue;
        }
        // 叶子保留官方 category_id；该 ID 若已被分类树其它位置占用，createNode 会显式失败。
        subjectNode.children.push(createNode(year, path, leafId));
      }
    }
  }
  return { ...snapshot, categories, examRootId: examRoot ? Number(examRoot.id) : null };
}

// 隐藏分类恢复。官网 /api/categories 只返回部分子树，题目记录却仍带完整分类路径：
// 官网把这些子分类「藏起来」后，题目引用会被 sanitizeOfficialCategories 判为悬空并降级。
// 这里按记录证据把缺失的路径补回树上，只补下面这张表里的已知根：
//   223/1/601 是必修学科根（categoryIndex 已保证存在），2500 是可选根（允许缺席）。
// 真题树由 synthesizeExamCategoryTree 负责，不在此重复处理，也不复活旧的 836。
// 2500 在数据层叫「模拟哥专区」（分片名同此），官网路径首段却写「模拟卷」，两者是同一个根。
const recoveredRootIds = new Map([
  ["高等数学", 223], ["线性代数", 1], ["概率统计", 601],
  ["模拟卷", 2500], ["模拟哥专区", 2500],
]);
const recoveredRootNames = new Map([[2500, "模拟哥专区"]]);

/**
 * 按题目记录的分类路径恢复官网隐藏的分类节点。
 * 只对「官方主分类 ID（category_id）不在当前树上、且路径首段是已知根」的记录建节点：
 * 中间节点用 synthesizedCategoryId 的稳定哈希 ID，叶子保留官方 category_id。
 * 2500 的哈希与冲突比较固定用规范名「模拟哥专区」，与官网根是否存在、现有名字如何拼写无关。
 * 本次所有可恢复的叶子 ID 都预留给合成 ID 的占用检查，避免官方 ID 与合成中间 ID 撞车时误复用。
 * 没有路径证据的可选根仍允许缺席；同一 ID 对应多条路径、或同一路径对应多个 ID 都显式失败，
 * 不做多数投票猜测。题目本身、真题卷内顺序与学习记录都不改动。
 * 调用顺序：synthesizeExamCategoryTree 之后、sanitizeOfficialCategories 之前。
 */
export function rebuildOfficialCategoryPaths(snapshot) {
  if (!Array.isArray(snapshot?.questions) || !Array.isArray(snapshot?.categories)) {
    throw new Error("隐藏分类恢复需要 questions 与 categories 数组");
  }
  const categories = structuredClone(snapshot.categories);
  const pathById = categoryPaths(categories);
  const nodeById = new Map();
  const collect = node => {
    nodeById.set(Number(node.id), node);
    for (const child of node?.children || []) collect(child);
  };
  categories.forEach(collect);
  const reservedIds = new Set(pathById.keys());
  // 官网原样给出的分类 ID：这些记录不需要恢复，也不参与下面的冲突判定（避免误伤官网数据）。
  const originalIds = new Set(pathById.keys());
  // 本次可恢复的主分类叶子 ID 一律先预留：否则某条记录的官方叶子 ID 可能正好等于另一条恢复
  // 路径算出的合成中间 ID，造成节点被误复用或题目引用被静默漏建。撞车由 synthesizedCategoryId 显式抛出。
  for (const question of snapshot.questions) {
    const primaryRaw = question?.category_id;
    if (primaryRaw == null) continue;
    const leafId = Number(primaryRaw);
    if (!Number.isInteger(leafId) || leafId <= 0) continue;
    if (originalIds.has(leafId)) continue;
    reservedIds.add(leafId);
  }
  // 恢复路径的规范根名：2500 固定写「模拟哥专区」，与官网根是否在树上、现有名字是「模拟卷」
  // 还是「模拟哥专区」无关，保证同一中间路径在不同快照里得到同一个稳定哈希 ID。
  const canonicalRootName = rootId => {
    const fixed = recoveredRootNames.get(rootId);
    if (fixed) return fixed;
    const node = nodeById.get(rootId);
    if (!node) throw new Error(`已知根分类 ${rootId} 不在分类树中，无法恢复分类路径`);
    return String(node.name);
  };
  // 只在「需要恢复」的记录之间做一一对应校验：已经在树上的分类不进来，避免误伤官网原样数据。
  const leafIdByPath = new Map();
  const findChild = (children, name, path) => {
    const matches = (children || []).filter(child => String(child?.name ?? "") === name);
    if (matches.length > 1) throw new Error(`分类路径重复：${path}`);
    return matches[0] || null;
  };
  const createNode = (name, nodePath, id, parent) => {
    if (pathById.has(id)) {
      throw new Error(`分类 ID 已被占用：${id}（${pathById.get(id)}），无法恢复 ${nodePath}`);
    }
    pathById.set(id, nodePath);
    reservedIds.add(id);
    const node = { id, name, children: [] };
    if (parent) (parent.children ||= []).push(node);
    else categories.push(node);
    nodeById.set(id, node);
    return node;
  };
  for (const question of snapshot.questions) {
    const primaryRaw = question?.category_id;
    if (primaryRaw == null) continue;
    const leafId = Number(primaryRaw);
    // 0、负数、NaN 等损坏值不在此判定：留给 sanitizeOfficialCategories 报它原有的错误。
    if (!Number.isInteger(leafId) || leafId <= 0) continue;
    // 官网树上已有的分类不需要恢复，原样保留，不受恢复逻辑影响。
    if (originalIds.has(leafId)) continue;
    const path = officialCategoryPathOf(question);
    if (path == null) continue;
    // 路径字段可能多值（用「、」分隔）：只认首段是已知根的候选，其余交给既有净化逻辑。
    const candidates = path.normalized.split("、").map(text => splitCategoryPath(text))
      .filter(segments => segments.length && recoveredRootIds.has(segments[0]));
    if (!candidates.length) continue;
    if (candidates.length > 1) {
      throw new Error(`题目 ${question.id} 有多条已知根分类路径，无法确定隐藏分类归属：${path.text}`);
    }
    const segments = candidates[0];
    if (segments.some(segment => !segment)) throw new Error(`题目 ${question.id} 的分类路径含空层级：${path.text}`);
    const rootId = recoveredRootIds.get(segments[0]);
    const existingRoot = nodeById.get(rootId) || null;
    // 哈希与比较一律用规范根名；显示名仍沿用既有官网节点（不重命名）。
    const rootName = canonicalRootName(rootId);
    const targetPath = [rootName, ...segments.slice(1)].join(" / ");
    const knownLeafId = leafIdByPath.get(targetPath);
    if (knownLeafId != null && knownLeafId !== leafId) {
      throw new Error(`分类路径 ${targetPath} 对应多个官方叶子分类 ID：${knownLeafId}、${leafId}`);
    }
    // 这个 ID 若已在树上，必须确认是同一规范路径下已建好的叶子，否则是路径/ID 冲突，不能默默跳过。
    const existingLeafPath = pathById.get(leafId);
    if (existingLeafPath !== undefined) {
      if (existingLeafPath !== targetPath) {
        throw new Error(`官方叶子分类 ID ${leafId} 对应多个路径：${existingLeafPath}、${targetPath}`);
      }
      continue;
    }
    leafIdByPath.set(targetPath, leafId);
    if (segments.length === 1 && leafId !== rootId) {
      throw new Error(`题目 ${question.id} 的分类路径只到根分类 ${rootName}，无法恢复叶子 ${leafId}：${path.text}`);
    }
    let node = existingRoot || createNode(rootName, rootName, rootId, null);
    let currentPath = rootName;
    for (let index = 1; index < segments.length; index += 1) {
      const name = segments[index];
      const childPath = `${currentPath} / ${name}`;
      const isLeaf = index === segments.length - 1;
      let child = findChild(node.children, name, childPath);
      if (!child) {
        const id = isLeaf ? leafId : synthesizedCategoryId(childPath, reservedIds);
        child = createNode(name, childPath, id, node);
      } else if (isLeaf && Number(child.id) !== leafId) {
        throw new Error(`分类 ${childPath} 的 ID 与题目记录不一致：` +
          `分类树 ${child.id}，题目 ${question.id} 记录 ${leafId}`);
      }
      node = child;
      currentPath = childPath;
    }
  }
  return { ...snapshot, categories };
}

export function applyLocalClassifications(snapshot, config) {
  if (!config) return snapshot;
  if (config.version !== 1 || !config.assignments || typeof config.assignments !== "object" ||
      !Array.isArray(config.categories)) throw new Error("本地分类映射格式不合法");
  const categories = structuredClone(snapshot.categories);
  const existing = categoryIndex(categories);
  // 可选根分类（836/2500）官网已下线时，挂在它下面的本地分类无处可挂。
  // 显式跳过这些本地分类及其 assignment，题目保留并退回未分类；
  // 不删除题目、不改挂到其它父分类，也不影响必需根缺失与未知父节点的报错路径。
  const skippedLocalCategories = new Map();
  for (const added of config.categories) {
    if (!Number.isInteger(added.id) || !Number.isInteger(added.parent_id)) continue;
    if (existing.has(added.parent_id) || !optionalRootShards.has(added.parent_id)) continue;
    skippedLocalCategories.set(added.id, added.parent_id);
  }
  const appliedIds = new Set();
  const skippedQuestionIds = [];
  const questions = snapshot.questions.map(question => {
    const assignment = config.assignments[String(question.id)];
    if (question.category_id != null || (question.category_ids || []).length) {
      if (question.category_id != null && !(question.category_ids || []).length) {
        return { ...question, category_ids: [question.category_id] };
      }
      return question;
    }
    if (!assignment) return question;
    if (!Array.isArray(assignment.category_ids) || !assignment.category_ids.length ||
        assignment.category_ids.some(id => !Number.isInteger(id))) {
      throw new Error(`题目 ${question.id} 的本地分类无效`);
    }
    const ids = [...new Set(assignment.category_ids)];
    if (ids.some(id => skippedLocalCategories.has(Number(id)))) {
      skippedQuestionIds.push(question.id);
      return question;
    }
    ids.forEach(id => appliedIds.add(id));
    return { ...question, category_id: ids[0], category_ids: ids };
  });
  for (const added of config.categories) {
    if (!appliedIds.has(added.id)) continue;
    if (!Number.isInteger(added.id) || !Number.isInteger(added.parent_id) ||
        !added.name || existing.has(added.id)) throw new Error(`本地分类 ID 不合法或已被官网占用：${added.id}`);
    const parent = existing.get(added.parent_id)?.source;
    if (!parent) throw new Error(`本地分类缺少父节点：${added.parent_id}`);
    parent.children ||= [];
    const category = { id: added.id, name: added.name, children: [] };
    parent.children.push(category);
    existing.set(added.id, { source: category, parent: added.parent_id });
  }
  const validIds = categoryIndex(categories);
  // 只校验本地 assignment 引入的分类：官网原始 category_ids 里可能带有已被官网删除的次要分类，
  // 那些交给 buildCatalog/normalizeQuestion 统一过滤并计入 stray，不在此处判死。
  for (const question of questions) {
    for (const id of question.category_ids || []) {
      if (!appliedIds.has(Number(id))) continue;
      if (!validIds.has(Number(id))) throw new Error(`题目 ${question.id} 的本地分类不存在：${id}`);
    }
  }
  const skippedRoots = [...new Set(skippedLocalCategories.values())];
  if (skippedLocalCategories.size || skippedQuestionIds.length) {
    console.warn(`本地分类跳过：可选根分类 ${skippedRoots.join("、")} 官网已缺失，` +
      `忽略 ${skippedLocalCategories.size} 个本地分类与 ${skippedQuestionIds.length} 条题目映射，` +
      `相关题目保留为未分类（${skippedQuestionIds.join("、") || "无"}）`);
  }
  return { ...snapshot, questions, categories,
    skippedLocalClassifications: { roots: skippedRoots,
      categories: [...skippedLocalCategories.keys()], questions: skippedQuestionIds } };
}

async function readLocalClassifications(overlayDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(overlayDir, localClassificationsFile), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// 上一活动题库目录里的文件名沿用生成侧约定（manifest 索引 + id_index + 分片）。
const previousManifestFile = "manifest.json";
const previousIdIndexFile = "id_index.json";

// 读取旧库 JSON：只有「文件不存在」按明确空输入处理；JSON 损坏、权限错误等一律显式抛出，不吞。
async function readPreviousJson(file, label) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${file}（${error.message}）`);
  }
}

/**
 * 旧分类回填：官网把分类树清空时，题目会失去分类引用。这里只在题目「完全没有任何分类」
 * （category_id 为 null 且 category_ids 为空）时，才从上一活动题库目录读回仍然有效的旧分类。
 * 输入 snapshot 必须已经过隐藏分类恢复、净化并应用本地显式分类：已有有效新分类（含本地
 * assignment）的题目一律不覆盖。读回的 ID 必须仍在本次有效分类树上，没有有效旧分类就保持
 * 未分类，不新造分类根。previousDataDir 为空时不做任何读取。
 * 旧库目录/文件缺失按明确空输入处理；JSON 损坏、权限错误、manifest/id_index/分片格式不符，
 * 以及 manifest 里的分片路径逃出 previousDataDir，全部显式抛错。
 * 返回新增的 preservedPreviousCategories（被回填的题目数）供同步结果上报。
 */
export async function applyPreviousCategories(snapshot, previousDataDir) {
  if (!Array.isArray(snapshot?.questions) || !Array.isArray(snapshot?.categories)) {
    throw new Error("旧分类回填需要 questions 与 categories 数组");
  }
  const unfilled = question =>
    question?.category_id == null && !(question?.category_ids || []).length;
  if (!previousDataDir || !snapshot.questions.some(unfilled)) {
    return { ...snapshot, questions: snapshot.questions, preservedPreviousCategories: 0 };
  }
  const root = path.resolve(previousDataDir);
  const manifestFile = path.join(root, previousManifestFile);
  const manifest = await readPreviousJson(manifestFile, "上一活动题库 manifest");
  if (manifest == null) {
    return { ...snapshot, questions: snapshot.questions, preservedPreviousCategories: 0 };
  }
  if (typeof manifest !== "object" || Array.isArray(manifest) ||
      !manifest.shards || typeof manifest.shards !== "object") {
    throw new Error(`上一活动题库 manifest 格式不符：${manifestFile}`);
  }
  const idIndexFile = path.join(root, previousIdIndexFile);
  const idIndex = await readPreviousJson(idIndexFile, "上一活动题库 id_index");
  if (idIndex == null) {
    return { ...snapshot, questions: snapshot.questions, preservedPreviousCategories: 0 };
  }
  if (typeof idIndex !== "object" || Array.isArray(idIndex)) {
    throw new Error(`上一活动题库 id_index 格式不符：${idIndexFile}`);
  }
  // 依据 manifest 定位分片：拼好绝对路径后必须仍在 previousDataDir 内，不许借 file 字段逃出去。
  const fileOfShard = new Map();
  const shardIds = new Map();
  for (const question of snapshot.questions) {
    if (!unfilled(question)) continue;
    const shardName = idIndex[String(question.id)];
    if (typeof shardName !== "string" || !shardName) continue;
    if (!shardIds.has(shardName)) shardIds.set(shardName, new Set());
    shardIds.get(shardName).add(String(question.id));
  }
  for (const shardName of shardIds.keys()) {
    const entry = manifest.shards[shardName];
    if (!entry || typeof entry.file !== "string" || !entry.file) {
      throw new Error(`上一活动题库 manifest 缺少分片 ${shardName} 的 file 字段：${manifestFile}`);
    }
    const file = path.resolve(root, entry.file);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`上一活动题库分片路径越界：${entry.file}（${manifestFile}）`);
    }
    fileOfShard.set(shardName, file);
  }
  const previousById = new Map();
  for (const [shardName, file] of fileOfShard) {
    const rows = await readPreviousJson(file, `上一活动题库分片 ${shardName}`);
    if (rows == null) continue;
    if (!Array.isArray(rows)) throw new Error(`上一活动题库分片 ${shardName} 不是数组：${file}`);
    const wanted = shardIds.get(shardName);
    for (const row of rows) {
      if (row?.id == null) continue;
      const id = String(row.id);
      if (wanted.has(id)) previousById.set(id, row);
    }
  }
  const validIds = new Set(categoryPaths(snapshot.categories).keys());
  let preservedPreviousCategories = 0;
  const questions = snapshot.questions.map(question => {
    if (!unfilled(question)) return question;
    const previous = previousById.get(String(question.id));
    if (!previous) return question;
    // 主分类有效就沿用；主分类失效时用第一个有效次分类顶上（与 sanitize 的既有语义一致）。
    const ids = [];
    for (const raw of [previous.category_id,
      ...(Array.isArray(previous.category_ids) ? previous.category_ids : [])]) {
      if (raw == null) continue;
      const id = Number(raw);
      if (!Number.isInteger(id) || !validIds.has(id) || ids.includes(id)) continue;
      ids.push(id);
    }
    if (!ids.length) return question;
    preservedPreviousCategories += 1;
    return { ...question, category_id: ids[0], category_ids: ids };
  });
  return { ...snapshot, questions, preservedPreviousCategories };
}

// 官方题单（上游 30098381 / 774a695f）：独立于分类树的显式题序，用固定高位 ID 生成一套只读目录。
// 本轮只支持这一个真实题单，不做可注册的多根框架；目录只有一个学科根。
const officialCollections = [
  { id: "linear-algebra-selected-20261018", parentRootId: 1, categoryIdBase: 7_000_000 },
];

function findCategory(categories, id) {
  const target = Number(id);
  const stack = [...categories];
  while (stack.length) {
    const node = stack.pop();
    if (Number(node?.id) === target) return node;
    for (const child of node?.children || []) stack.push(child);
  }
  return null;
}

// 三个端点：列表本体、directory、items（分页）。
// 列表本体响应的 data 本身就是 metadata（官方/发布/explicit/revision/item_count），没有嵌套 metadata。
// directory 的 data 是 { total, roots: [...] }，节点只有 label / category_id / question_count / children。
// items 只保证 data.items 与 data.total；total 为 0 时 items 为空合法，不要求 page 字段。
// 原始 item 对象（position / available）原样保留，供 B4 指纹使用；题序按数组，不按 position。
async function fetchCollection(definition, signal) {
  const id = encodeURIComponent(definition.id);
  const metadata = await getJson(`${base}/api/question-lists/${id}`, signal);
  if (metadata.code !== 0 || !metadata.data || metadata.data.id !== definition.id ||
      metadata.data.is_official !== true || metadata.data.status !== "published" ||
      metadata.data.definition_kind !== "explicit") {
    throw new Error(`官网题单 ${definition.id} 不可用或格式不符`);
  }
  const directory = await getJson(`${base}/api/question-lists/${id}/directory`, signal);
  if (directory.code !== 0 || !Array.isArray(directory.data?.roots)) {
    throw new Error(`官网题单 ${definition.id} 的目录格式不符`);
  }
  const items = [];
  let page = 1;
  let total = null;
  while (page <= 1000) {
    const result = await getJson(`${base}/api/question-lists/${id}/items?page=${page}&per_page=${pageSize}`, signal);
    if (result.code !== 0 || !Array.isArray(result.data?.items) ||
        !Number.isInteger(result.data?.total)) {
      throw new Error(`官网题单 ${definition.id} 的第 ${page} 页格式不符`);
    }
    total ??= result.data.total;
    if (result.data.total !== total) throw new Error(`官网题单 ${definition.id} 在同步期间变化`);
    items.push(...result.data.items);
    if (items.length >= total) break;
    if (!result.data.items.length) throw new Error(`官网题单 ${definition.id} 分页提前结束`);
    page += 1;
  }
  if (items.length !== total || metadata.data.item_count !== total || directory.data.total !== total) {
    throw new Error(`官网题单 ${definition.id} 数量不一致：${items.length}/${total}`);
  }
  const ids = items.map(item => String(item.question_id));
  if (new Set(ids).size !== ids.length) throw new Error(`官网题单 ${definition.id} 含重复题目`);
  return { definition, metadata: metadata.data, directory: directory.data, items };
}

export async function fetchOfficialCollections(signal) {
  return Promise.all(officialCollections.map(definition => fetchCollection(definition, signal)));
}

function collectionQuestionMap(result) {
  const byId = new Map();
  for (const questions of Object.values(result.shards || {})) {
    for (const question of questions) byId.set(String(question.id), question);
  }
  return byId;
}

/**
 * 题单目录投影：把题单挂到主库分类树上，只新建题单自身的只读目录与有序题表。
 * 题目取自主库分片里的真实记录（不查 idIndex），题序按 items 数组序，不使用 position。
 * 放置依据是题目自身的 category_ids 命中目录节点，取最深；无命中挂题单根并计入 unmatched。
 * 目录节点只提供 label / category_id / question_count，不提供题号。
 * 不复制题目实体、不新增题数（manifest.total 与分片不变），也不把题单题号累加到原学科分类。
 * 题单根 ID 固定为 categoryIdBase，子节点 ID = categoryIdBase + 目录 category_id；
 * 冲突检查同时覆盖既有分类树与本次新建节点（新节点尚未挂进 categories）。
 */
export function addCollectionCategories(result, collections) {
  if (!result || !Array.isArray(result.categories) || !result.categoryQuestions ||
      typeof result.categoryQuestions !== "object" || !result.shards || !result.manifest) {
    throw new Error("题单投影需要目录构建结果（categories / categoryQuestions / shards / manifest）");
  }
  if (!Array.isArray(collections)) throw new Error("题单投影需要题单数组");
  if (!collections.length) return result;
  const questionById = collectionQuestionMap(result);
  const usedIds = new Set();
  const collectIds = node => {
    const id = Number(node?.id);
    if (Number.isInteger(id)) usedIds.add(id);
    for (const child of node?.children || []) collectIds(child);
  };
  result.categories.forEach(collectIds);
  const claimId = (id, label) => {
    if (!Number.isInteger(id) || id <= 0) throw new Error(`题单分类 ID 不合法：${id}（${label}）`);
    if (usedIds.has(id)) throw new Error(`题单分类 ID 已被占用：${id}（${label}）`);
    usedIds.add(id);
    return id;
  };
  const manifestCollections = [];
  for (const collection of collections) {
    const { definition, metadata, directory, items } = collection;
    if (!definition || !metadata || !directory || !Array.isArray(items)) {
      throw new Error("题单投影需要 { definition, metadata, directory, items } 结构");
    }
    const label = `题单 ${metadata.id}`;
    const parent = findCategory(result.categories, definition.parentRootId);
    if (!parent) throw new Error(`${label} 的父分类 ${definition.parentRootId} 不存在`);
    const localRootId = claimId(Number(definition.categoryIdBase), `${label} 根`);
    if (!Array.isArray(directory.roots) || directory.roots.length !== 1) {
      throw new Error(`${label} 目录必须恰好一个学科根：${directory.roots?.length ?? 0}`);
    }
    const rootDirectory = directory.roots[0];
    const directoryById = new Map();
    const localNodeById = new Map();
    const registerDirectory = (node, depth, local) => {
      const upstreamCategoryId = Number(node.category_id);
      if (!Number.isInteger(upstreamCategoryId) || upstreamCategoryId <= 0) {
        throw new Error(`${label} 目录分类 ID 不合法：${node.category_id}`);
      }
      if (directoryById.has(upstreamCategoryId)) {
        throw new Error(`${label} 目录重复 category_id：${upstreamCategoryId}`);
      }
      directoryById.set(upstreamCategoryId, { node, depth, local });
      localNodeById.set(local.id, local);
      for (const child of node.children || []) {
        const upstreamChildId = Number(child.category_id);
        if (directoryById.has(upstreamChildId)) {
          throw new Error(`${label} 目录重复 category_id：${upstreamChildId}`);
        }
        const childId = claimId(Number(definition.categoryIdBase) + upstreamChildId,
          `${label} 分类 ${child.label}`);
        const localChild = { id: childId, name: String(child.label), parent_id: local.id,
          question_count: 0, direct_count: 0, children: [] };
        local.children.push(localChild);
        registerDirectory(child, depth + 1, localChild);
      }
    };
    const localRoot = { id: localRootId, name: String(metadata.name), parent_id: Number(parent.id),
      collection_id: metadata.id, question_count: 0, direct_count: 0, children: [] };
    registerDirectory(rootDirectory, 0, localRoot);
    // 题序以 items 数组序为准；position / available 不参与排序，直接调用时也不得重复题号。
    const order = new Map(items.map((item, index) => [String(item.question_id), index]));
    if (order.size !== items.length) throw new Error(`${label} 含重复题目`);
    const direct = new Map([...localNodeById.keys()].map(id => [id, new Set()]));
    let unmatched = 0;
    for (const item of items) {
      const question = questionById.get(String(item.question_id));
      if (!question) throw new Error(`${label} 引用了题库中不存在的题目 ${item.question_id}`);
      const candidates = [];
      for (const categoryId of question.category_ids || []) {
        const entry = directoryById.get(Number(categoryId));
        if (entry) candidates.push(entry);
      }
      candidates.sort((left, right) => right.depth - left.depth);
      const local = candidates.length ? candidates[0].local : localRoot;
      if (!candidates.length) unmatched += 1;
      direct.get(local.id).add(String(item.question_id));
    }
    const collect = local => {
      const ids = new Set(direct.get(local.id));
      for (const child of local.children) for (const id of collect(child)) ids.add(id);
      const orderedIds = [...ids].sort((left, right) => order.get(left) - order.get(right));
      result.categoryQuestions[String(local.id)] = orderedIds.map(Number);
      local.question_count = orderedIds.length;
      local.direct_count = direct.get(local.id).size;
      return orderedIds;
    };
    collect(localRoot);
    const verifyDirectory = (local, directoryNode) => {
      if (local.question_count !== Number(directoryNode.question_count)) {
        throw new Error(`${label} 的分类 ${directoryNode.label} 题数不一致：` +
          `${local.question_count}/${directoryNode.question_count}`);
      }
      for (const child of directoryNode.children || []) {
        verifyDirectory(localNodeById.get(Number(definition.categoryIdBase) + Number(child.category_id)), child);
      }
    };
    verifyDirectory(localRoot, rootDirectory);
    parent.children ||= [];
    parent.children.push(localRoot);
    manifestCollections.push({ id: metadata.id, name: metadata.name,
      question_count: items.length, unmatched });
  }
  result.manifest.collections = manifestCollections;
  return result;
}

/**
 * 官方快照分类引用的唯一净化权威。必须在 applyLocalClassifications 之前调用，
 * 使本地 overlay 只能看到净化后的引用，无法借道绕过校验。
 * 三类语义：次要悬空过滤 / 失效主分类提升第一个有效分类 / 无有效分类归未分类；
 * NaN、0、负数、非整数等损坏值仍显式失败。
 */
function sanitizeOfficialCategories(snapshot, categories, refs) {
  const questions = snapshot.questions.map(source => {
    const requestedIds = [...new Set((source.category_ids || []).map(Number))];
    for (const id of requestedIds) {
      if (!Number.isInteger(id) || id <= 0) throw new Error(`题目 ${source.id} 指向不存在的分类 ${id}`);
    }
    const primaryRaw = source.category_id;
    const primaryId = primaryRaw == null ? null : Number(primaryRaw);
    if (primaryId != null && (!Number.isInteger(primaryId) || primaryId <= 0)) {
      throw new Error(`题目 ${source.id} 的主分类不合法：${primaryRaw}`);
    }
    const categoryIds = requestedIds.filter(id => categories.has(id));
    const strayCategoryIds = requestedIds.filter(id => !categories.has(id));
    if (strayCategoryIds.length) {
      refs.strayCategoryRefs.push({ id: Number(source.id), categoryIds: strayCategoryIds });
    }
    let categoryId = primaryId;
    if (primaryId != null && !categories.has(primaryId)) {
      if (categoryIds.length) {
        categoryId = categoryIds[0];
        refs.strayPrimaryRefs.push({ id: Number(source.id), original: primaryId,
          fallback: categoryId, categoryIds });
      } else {
        categoryId = null;
        refs.unclassifiedPrimaryRefs.push({ id: Number(source.id), original: primaryId });
      }
    }
    return { ...source, category_id: categoryId, category_ids: categoryIds };
  });
  return { ...snapshot, questions };
}

function normalizeQuestion(source, categories) {
  const document = source.document || {};
  const officialType = document.question_type || source.question_type;
  if (!["fill", "essay", "subjective", "single_choice", "multiple_choice"].includes(officialType)) {
    throw new Error(`题目 ${source.id} 的类型未知：${officialType}`);
  }
  const type = ["single_choice", "multiple_choice"].includes(officialType) ? officialType : "subjective";
  const options = Array.isArray(document.options) ? document.options : (source.options || []);
  const correctIds = document.answer?.option_ids || source.answer?.option_ids || [];
  const correctLabels = options.filter(option => correctIds.includes(option.id)).map(option => option.label);
  // 官网自身会留下残缺选择题（答案待补充、正确项不在选项里）。先算出原因，
  // 但分类与非法值校验必须先行：残缺题同样不得绕过分类完整性检查。
  const incompleteReason = type === "subjective" ? null
    : !correctIds.length ? "官网未提供正确选项"
    : !correctLabels.length ? "正确选项不在选项列表中"
    : correctLabels.length !== correctIds.length ? "正确选项数量与选项列表不匹配" : null;
  // 分类净化已在 sanitizeOfficialCategories 前置完成，这里只做幂等校验：
  // 仍悬空或不合法的引用说明净化被绕过，必须显式失败，不在此处再次降级。
  const requestedIds = [...new Set((source.category_ids || []).map(Number))];
  for (const id of requestedIds) {
    if (!Number.isInteger(id) || id <= 0) throw new Error(`题目 ${source.id} 指向不存在的分类 ${id}`);
  }
  const primaryRaw = source.category_id;
  const categoryId = primaryRaw == null ? null : Number(primaryRaw);
  if (categoryId != null && !Number.isInteger(categoryId)) {
    throw new Error(`题目 ${source.id} 的主分类不合法：${primaryRaw}`);
  }
  if (categoryId != null && !categories.has(categoryId)) {
    throw new Error(`题目 ${source.id} 的主分类在净化后仍不存在：${primaryRaw}`);
  }
  const categoryIds = requestedIds;
  for (const id of categoryIds) {
    if (!categories.has(id)) throw new Error(`题目 ${source.id} 的次要分类在净化后仍不存在：${id}`);
  }
  // 分类校验全部通过后，才允许跳过残缺题；它不进入任何分片或索引。
  if (incompleteReason) return { skip: { id: Number(source.id), reason: incompleteReason } };
  const answer = type === "subjective"
    ? String(document.answer?.reference_answer_md ?? source.answer?.reference_answer_md ?? source.correct_answer ?? "")
    : (correctLabels.length ? correctLabels.join("") : String(source.correct_answer || ""));
  const question = {
    id: Number(source.id),
    stem: String(document.stem_md ?? source.stem ?? ""),
    options,
    answer,
    explanation: String(document.explanation_md ?? source.answer_explanation ?? ""),
    source: String(document.source ?? source.source ?? ""),
    type,
    is_core: source.is_core === true,
    category_id: categoryId,
    category_ids: categoryIds,
    category_path: categoryIds.map(id => categories.get(id).path).join("、"),
    serial: Number.isFinite(Number(document.serial_number ?? source.serial_number))
      ? Number(document.serial_number ?? source.serial_number) : null,
    correct_labels: correctLabels,
  };
  if (!Number.isInteger(question.id) || question.id <= 0 || !question.stem || !question.answer) {
    throw new Error(`官网题目 ${source.id} 必要字段缺失`);
  }
  return JSON.parse(JSON.stringify(question).replaceAll("asset://sha256/", "assets/"));
}

async function writeJson(file, value, pretty = false) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function buildCatalog(snapshot, refs) {
  const categories = categoryIndex(snapshot.categories);
  const shards = Object.fromEntries([...fileByShard.keys()].map(name => [name, []]));
  const categoryQuestions = new Map();
  // 排序需要题目对象上的 source，而 categoryQuestions 只存 id。
  const questionById = new Map();
  const idIndex = {};
  const searchIndex = [];
  const types = {};
  const hashes = new Set();
  for (const source of snapshot.questions) {
    const normalized = normalizeQuestion(source, categories);
    if (normalized?.skip) {
      refs.incompleteQuestionRefs.push(normalized.skip);
      continue;
    }
    const question = normalized;
    const primary = categories.get(question.category_id) || categories.get(question.category_ids[0]);
    // 先按根 ID 查表（官网原样给出的 223/1/601/836/2500），再按根名兜底：
    // 真题根由 synthesizeExamCategoryTree 合成，ID 不是 836，只能按名称归到「历年真题」分片。
    const shard = primary
      ? shardByRoot.get(primary.rootId) || (shardNames.has(primary.rootName) ? primary.rootName : null)
      : "未分类";
    if (!shard) throw new Error(`题目 ${question.id} 找不到分片`);
    shards[shard].push(question);
    questionById.set(question.id, question);
    idIndex[question.id] = shard;
    searchIndex.push({ id: question.id, source: question.source, type: question.type,
      path: question.category_path, serial: question.serial, stem: question.stem });
    types[question.type] = (types[question.type] || 0) + 1;
    const assigned = new Set();
    for (const categoryId of question.category_ids) {
      let current = categoryId;
      while (current != null && !assigned.has(current)) {
        assigned.add(current);
        current = categories.get(current).parent;
      }
    }
    if (!assigned.size) assigned.add("orphan");
    for (const id of assigned) {
      if (!categoryQuestions.has(String(id))) categoryQuestions.set(String(id), []);
      categoryQuestions.get(String(id)).push(question.id);
    }
    for (const match of JSON.stringify(question).matchAll(/(?:assets\/|question-assets\/)([0-9a-fA-F]{64})(?:\.png)?/g)) {
      hashes.add(match[1].toLowerCase());
    }
  }
  // 目录与做题顺序只由 categoryQuestions 的数组顺序决定，而它在上面按官网返回顺序
  // （≈ 题目 id 序，与卷内题序无关）累积。这里只重排「历年真题 / 科目 / 年份」叶子，
  // 使每份试卷回到出题顺序；分片数组、聚合节点和其它分类都不动。
  for (const [categoryId, ids] of categoryQuestions) {
    const entry = categories.get(Number(categoryId));
    if (!entry) continue;
    const sorted = sortExamPaperQuestions(entry.path, ids, questionById);
    categoryQuestions.set(categoryId, sorted.ids);
    refs.missingPaperNumberRefs.push(...sorted.missing);
  }
  function normalizeCategory(source, parent = null) {
    const id = Number(source.id);
    return { id, name: String(source.name), parent_id: parent,
      question_count: categoryQuestions.get(String(id))?.length || 0,
      direct_count: snapshot.questions.filter(question => (question.category_ids || []).includes(id)).length,
      children: (source.children || []).map(child => normalizeCategory(child, id)) };
  }
  const catalog = snapshot.categories.map(category => normalizeCategory(category));
  catalog.push({ id: "orphan", name: "未分类", parent_id: null,
    question_count: categoryQuestions.get("orphan")?.length || 0,
    direct_count: categoryQuestions.get("orphan")?.length || 0, children: [] });
  // total 只统计真正写入分片的题数；被跳过的官网残缺题不计入，但 source_total 仍保留官网总数。
  const writtenTotal = Object.values(shards).reduce((sum, list) => sum + list.length, 0);
  const manifest = { version: 1, total: writtenTotal, types,
    shards: Object.fromEntries([...fileByShard].map(([name, file]) => [name, { file, count: shards[name].length }])),
    asset_count: hashes.size, asset_base: "./data/assets/", synced_at: new Date().toISOString(),
    source: `${base}/math`, source_total: snapshot.total };
  return { shards, categories: catalog, categoryQuestions: Object.fromEntries(categoryQuestions),
    idIndex, searchIndex, manifest, hashes,
    strayCategoryRefs: refs.strayCategoryRefs,
    strayPrimaryRefs: refs.strayPrimaryRefs,
    unclassifiedPrimaryRefs: refs.unclassifiedPrimaryRefs,
    incompleteQuestionRefs: refs.incompleteQuestionRefs,
    missingPaperNumberRefs: refs.missingPaperNumberRefs };
}

// 题图引用：assets/ 或 question-assets/ 下的 64 位 hash，扩展名只认既有支持的四种图片格式。
// 无扩展名按既有约定当 PNG；紧跟着不支持的扩展名（如 .bmp）不算题图，避免被误当成 PNG。
const assetReferencePattern = /(?:assets\/|question-assets\/)([0-9a-fA-F]{64})(?:\.(png|jpe?g|webp|gif))?(?![\w.])/g;
const assetExtensions = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const assetContentTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
// 引用扩展 → 期望的 Content-Type（jpg/jpeg 同族都是 image/jpeg）。
function assetContentTypeOf(extension) {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return `image/${extension.slice(1)}`;
}

// jpg/jpeg 是同族：盘上存任何一种都算命中，但引用用的名字要能真的被 HTTP 访问到。
function assetExtensionAliases(extension) {
  return extension === ".jpg" || extension === ".jpeg" ? [".jpg", ".jpeg"] : [extension];
}

/**
 * 收集「最终」题库里实际引用的题图：必须在本地库合并、精讲补全之后扫描最终分片，
 * 否则本地 overlay / 精讲新增的图片会被漏报。返回 Map<hash, Set<扩展名>>。
 */
export async function collectAssetReferences(dataDir) {
  const manifest = JSON.parse(await fs.readFile(path.join(dataDir, "manifest.json"), "utf8"));
  const references = new Map();
  for (const shard of Object.values(manifest.shards || {})) {
    const file = path.join(dataDir, String(shard.file));
    const text = await fs.readFile(file, "utf8");
    for (const match of text.matchAll(assetReferencePattern)) {
      const hash = match[1].toLowerCase();
      const extension = match[2] ? `.${match[2].toLowerCase()}` : ".png";
      if (!assetExtensions.includes(extension)) continue;
      if (!references.has(hash)) references.set(hash, new Set());
      references.get(hash).add(extension);
    }
  }
  return references;
}

// 在指定 assets 目录里找一个可用的题图文件（jpg/jpeg 同族互认），返回实际命中的扩展名。
async function findAssetFile(assetsDir, hash, extension) {
  for (const candidate of assetExtensionAliases(extension)) {
    try {
      await fs.access(path.join(assetsDir, `${hash}${candidate}`));
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

/**
 * 下载缺失题图。查找顺序：本次目标目录 → 上一活动版本 assets → bundled fallback。
 * 以引用里的文件名落盘（保留扩展名）；Content-Type 只接受四种已知图片格式，不擅自改扩展名。
 * 没有 DAGUAN_ASSET_TOKEN 时只按缺图计数；有 token 时单张非 2xx/IO/网络失败记入 failures，
 * 不吞异常；取消信号必须向上传播。
 */
export async function downloadAssets(references, dataDir, { previousAssetsDir = null, fallbackAssetsDir = null, signal } = {}) {
  // 已取消时直接失败：否则「无需下载」或「无 token」的路径会假成功。
  const assertActive = () => {
    if (signal?.aborted) throw signal.reason ?? new Error("题图下载已取消");
  };
  assertActive();
  const targetAssets = path.join(dataDir, "assets");
  const needed = [];
  for (const [hash, extensions] of references) {
    for (const extension of extensions) {
      let available = await findAssetFile(targetAssets, hash, extension);
      if (!available && previousAssetsDir) available = await findAssetFile(previousAssetsDir, hash, extension);
      if (!available && fallbackAssetsDir) available = await findAssetFile(fallbackAssetsDir, hash, extension);
      if (!available) needed.push({ hash, extension });
    }
  }
  const failures = [];
  if (!needed.length) {
    assertActive();
    return { missing: 0, failures };
  }
  const assetAccess = process.env.DAGUAN_ASSET_TOKEN;
  if (!assetAccess) {
    assertActive();
    return { missing: needed.length, failures };
  }
  let next = 0;
  const worker = async () => {
    while (next < needed.length) {
      assertActive();
      const item = needed[next++];
      try {
        const response = await fetch(`${base}/api/v1/question-assets/${item.hash}`, {
          headers: { Authorization: `Bearer ${assetAccess}` },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          failures.push({ hash: item.hash, extension: item.extension, reason: `HTTP ${response.status}` });
          continue;
        }
        const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (contentType && !assetContentTypes.has(contentType)) {
          failures.push({ hash: item.hash, extension: item.extension, reason: `内容类型不符：${contentType}` });
          continue;
        }
        // Content-Type 必须与引用扩展族一致：不能把 image/jpeg 静默写成 .webp 再由 HTTP 按 image/webp 提供。
        // 缺 Content-Type 时按最小契约放行（不额外要求），由实际字节决定；这里不做转码、不改引用后缀。
        if (contentType && contentType !== assetContentTypeOf(item.extension)) {
          failures.push({ hash: item.hash, extension: item.extension,
            reason: `内容类型与引用格式不符：${contentType} ≠ ${assetContentTypeOf(item.extension)}` });
          continue;
        }
        await fs.mkdir(targetAssets, { recursive: true });
        await fs.writeFile(path.join(targetAssets, `${item.hash}${item.extension}`),
          Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        failures.push({ hash: item.hash, extension: item.extension, reason: `下载失败：${error.message}` });
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  let missing = 0;
  for (const item of needed) {
    if (!(await findAssetFile(targetAssets, item.hash, item.extension))) missing += 1;
  }
  return { missing, failures };
}

async function reconcileVideoMappings(stage, dataDir) {
  const ids = new Set(Object.keys(JSON.parse(await fs.readFile(path.join(stage, "id_index.json"), "utf8"))));
  const archiveFile = path.join(dataDir, "retired-video-mappings.json");
  const archive = await fs.readFile(archiveFile, "utf8").then(JSON.parse, () => ({ lecture: {}, paradiyu: {} }));
  for (const [name, file] of [["lecture", "lecture-video-mappings.json"], ["paradiyu", "paradiyu-linear-video.json"]]) {
    const mapping = JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8"));
    const combined = { ...(archive[name] || {}), ...mapping.questions };
    const current = {};
    const retired = {};
    for (const [id, entry] of Object.entries(combined)) {
      (ids.has(id) ? current : retired)[id] = entry;
    }
    mapping.questions = current;
    if (name === "paradiyu") mapping.questionIds = Object.keys(current);
    archive[name] = retired;
    await writeJson(path.join(stage, file), mapping, true);
  }
  await writeJson(path.join(stage, "retired-video-mappings.json"), archive, true);
}

export async function syncOfficialQuestionBank({ targetDir, overlayDir = targetDir, previousDataDir = overlayDir, fallbackAssetsDir = null, signal, currentFingerprint = null }) {
  const officialSnapshot = await fetchOfficial(signal);
  // 题单也必须先读：题单 metadata/目录/题序都要进指纹，否则只改题单会被误判 unchanged。
  const collections = await fetchOfficialCollections(signal);
  // 官网原始分类路径（category_full_path / category_name）也要进指纹：真题子树已从
  // /api/categories 下线，路径变化是本仓库能看到的唯一真题结构信号，漏掉会被误判 unchanged。
  // 题单只取 id/name/revision、目录结构（含 label 与层级）和有序题序元组，
  // 不加入抓取时间或上一活动版本产物，避免每次更新都漂移。
  const fingerprint = createHash("sha256").update(JSON.stringify({
    questions: officialSnapshot.questions.map(question => [question.id, question.content_hash, question.is_core,
      question.category_ids, question.category_id, officialCategoryPathOf(question)?.normalized ?? null]),
    categories: officialSnapshot.categories,
    source: { total: officialSnapshot.total, pending: officialSnapshot.skippedPending },
    collections: collections.map(collection => ({
      metadata: [collection.metadata.id, collection.metadata.name, collection.metadata.revision],
      directory: collection.directory,
      items: collection.items.map(item => [item.question_id, item.position ?? null, item.available ?? null]),
    })),
  })).digest("hex");
  if (fingerprint === currentFingerprint) return { unchanged: true, fingerprint, sourceTotal: officialSnapshot.total };
  // 顺序固定：官网分类树校验 → 真题分类合成 → 隐藏分类恢复 → 官方快照分类净化 → 本地 overlay → 构建目录。
  // 必需根（223/1/601）校验先行，缺根本身就是官网结构异常，不该被合成或净化的报错盖掉；
  // 合成必须先于净化：真题叶子只存在于题目记录里，树不补齐就会被判悬空并丢弃；隐藏分类同理。
  const refs = { strayCategoryRefs: [], strayPrimaryRefs: [], unclassifiedPrimaryRefs: [],
    incompleteQuestionRefs: [], missingPaperNumberRefs: [] };
  categoryIndex(officialSnapshot.categories);
  const synthesized = synthesizeExamCategoryTree(officialSnapshot);
  const recovered = rebuildOfficialCategoryPaths(synthesized);
  const sanitized = sanitizeOfficialCategories(recovered, categoryIndex(recovered.categories), refs);
  const localized = applyLocalClassifications(sanitized, await readLocalClassifications(overlayDir));
  // 旧分类回填必须在本地显式分类之后：本地 assignments 已经落位的题目不再参与回填。
  const snapshot = await applyPreviousCategories(localized, previousDataDir);
  const result = buildCatalog(snapshot, refs);
  // 题单只投影目录与有序题表，不复制题目、不改题数，放在构建目录之后、本地库合并之前。
  addCollectionCategories(result, collections);
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-official-sync-"));
  try {
    for (const [name, file] of fileByShard) await writeJson(path.join(stage, file), result.shards[name]);
    await Promise.all([
      writeJson(path.join(stage, "categories.json"), result.categories),
      writeJson(path.join(stage, "category_questions.json"), result.categoryQuestions),
      writeJson(path.join(stage, "id_index.json"), result.idIndex),
      writeJson(path.join(stage, "search_index.json"), result.searchIndex),
      writeJson(path.join(stage, "manifest.json"), result.manifest, true),
    ]);
    const overlay = await mergeLocalQuestionBanks(stage, overlayDir);
    const merged = JSON.parse(await fs.readFile(path.join(stage, "manifest.json"), "utf8"));
    // 基线用构建后的 manifest.total（已排除跳过的残缺题），不能用官网原始总数硬比。
    if (merged.total !== result.manifest.total + overlay.added) {
      throw new Error(`本地题库合并异常：${merged.total}`);
    }
    const nativeSolutionStats = await applyNativeSolutions(stage, overlayDir);
    await reconcileVideoMappings(stage, overlayDir);
    if (signal?.aborted) throw signal.reason;
    // 题图引用在「最终」分片上收集：本地库合并与精讲补全之后才能包含它们新增的图片。
    // asset_count 也按最终引用的 hash 去重计数，不用构建目录时的中间结果。
    const assetReferences = await collectAssetReferences(stage);
    const stageManifestFile = path.join(stage, "manifest.json");
    const stageManifest = JSON.parse(await fs.readFile(stageManifestFile, "utf8"));
    if (stageManifest.asset_count !== assetReferences.size) {
      stageManifest.asset_count = assetReferences.size;
      await writeJson(stageManifestFile, stageManifest, true);
    }
    await fs.mkdir(targetDir, { recursive: true });
    for (const file of [...fileByShard.values(), "categories.json", "category_questions.json", "id_index.json", "search_index.json", "manifest.json",
      "lecture-video-mappings.json", "paradiyu-linear-video.json", "retired-video-mappings.json"]) {
      const target = path.join(targetDir, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(stage, file), target);
    }
    const assetDownload = await downloadAssets(assetReferences, targetDir, {
      previousAssetsDir: previousDataDir ? path.join(previousDataDir, "assets") : null,
      fallbackAssetsDir, signal,
    });
    const missingAssets = assetDownload.missing;
    const assetFailures = assetDownload.failures;
    const { strayCategoryRefs, strayPrimaryRefs, unclassifiedPrimaryRefs, incompleteQuestionRefs,
      missingPaperNumberRefs } = result;
    if (strayCategoryRefs.length) {
      console.warn(`官网分类悬空引用：${strayCategoryRefs.length} 道题的次要分类已被官网删除，已按题意丢弃；` +
        strayCategoryRefs.map(item => `${item.id}->[${item.categoryIds.join("、")}]`).join("，"));
    }
    if (strayPrimaryRefs.length) {
      console.warn(`官网主分类失效（已降级到有效备用分类）：${strayPrimaryRefs.length} 道题；` +
        strayPrimaryRefs.map(item => `${item.id}: ${item.original}->${item.fallback}`).join("，"));
    }
    if (unclassifiedPrimaryRefs.length) {
      console.warn(`官网主分类失效（无有效分类，归入未分类）：${unclassifiedPrimaryRefs.length} 道题；` +
        unclassifiedPrimaryRefs.map(item => `${item.id}: ${item.original}`).join("，"));
    }
    if (incompleteQuestionRefs.length) {
      console.warn(`官网残缺题（已跳过，不写入题库）：${incompleteQuestionRefs.length} 道题；` +
        incompleteQuestionRefs.map(item => `${item.id}: ${item.reason}`).join("，"));
    }
    if (missingPaperNumberRefs.length) {
      console.warn(`真题缺少卷内题号（已排在卷末，卷内其余题按题号排列）：${missingPaperNumberRefs.length} 条；` +
        missingPaperNumberRefs.map(item => `${item.id}@${item.path}`).join("，"));
    }
    if (officialSnapshot.skippedPending) {
      console.warn(`官网答案未完成的题（已跳过，不写入题库）：${officialSnapshot.skippedPending} 道题`);
    }
    const preservedPreviousCategories = snapshot.preservedPreviousCategories || 0;
    if (preservedPreviousCategories) {
      console.warn(`官网分类被清空，已从上一活动版本回填有效旧分类：${preservedPreviousCategories} 道题`);
    }
    if (missingAssets) {
      console.warn(`题图缺失：${missingAssets} 张` + (assetFailures.length
        ? `；失败 ${assetFailures.length} 张：${assetFailures.map(item => `${item.hash}${item.extension}: ${item.reason}`).join("，")}`
        : "（未配置 DAGUAN_ASSET_TOKEN，仅计数）"));
    }
    return { fingerprint, sourceTotal: snapshot.total, total: merged.total, missingAssets, assetFailures,
      native_solution_stats: nativeSolutionStats,
      skippedPending: officialSnapshot.skippedPending,
      preservedPreviousCategories,
      collections: result.manifest.collections || [],
      strayCategoryRefs, strayCategoryCount: strayCategoryRefs.length,
      strayPrimaryRefs, strayPrimaryCount: strayPrimaryRefs.length,
      unclassifiedPrimaryRefs, unclassifiedPrimaryCount: unclassifiedPrimaryRefs.length,
      incompleteQuestionRefs, incompleteQuestionCount: incompleteQuestionRefs.length,
      missingPaperNumberRefs, missingPaperNumberCount: missingPaperNumberRefs.length };
  } finally {
    const resolvedStage = path.resolve(stage);
    if (!resolvedStage.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
        !path.basename(resolvedStage).startsWith("daguan-official-sync-")) {
      throw new Error("同步临时目录位置异常，已保留以供检查");
    }
    await fs.rm(resolvedStage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
