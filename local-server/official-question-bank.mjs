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
  return { questions, categories, total };
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
    incompleteQuestionRefs: refs.incompleteQuestionRefs };
}

async function downloadAssets(hashes, dataDir, fallbackAssetsDir, signal) {
  const needed = [];
  for (const hash of hashes) {
    try { await fs.access(path.join(dataDir, "assets", `${hash}.png`)); }
    catch {
      if (fallbackAssetsDir) {
        try { await fs.access(path.join(fallbackAssetsDir, `${hash}.png`)); continue; } catch {}
      }
      needed.push(hash);
    }
  }
  if (!needed.length) return 0;
  const assetAccess = process.env.DAGUAN_ASSET_TOKEN;
  if (!assetAccess) return needed.length;
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < needed.length) {
      const hash = needed[next++];
      try {
        const response = await fetch(`${base}/api/v1/question-assets/${hash}`, {
          headers: { Authorization: `Bearer ${assetAccess}` },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        });
        if (!response.ok) continue;
        await fs.mkdir(path.join(dataDir, "assets"), { recursive: true });
        await fs.writeFile(path.join(dataDir, "assets", `${hash}.png`), Buffer.from(await response.arrayBuffer()));
      } catch {}
    }
  }));
  let remaining = 0;
  for (const hash of needed) {
    try { await fs.access(path.join(dataDir, "assets", `${hash}.png`)); }
    catch { remaining += 1; }
  }
  return remaining;
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

export async function syncOfficialQuestionBank({ targetDir, overlayDir = targetDir, fallbackAssetsDir = null, signal, currentFingerprint = null }) {
  const officialSnapshot = await fetchOfficial(signal);
  // 官网原始分类路径（category_full_path / category_name）也要进指纹：真题子树已从
  // /api/categories 下线，路径变化是本仓库能看到的唯一真题结构信号，漏掉会被误判 unchanged。
  const fingerprint = createHash("sha256").update(JSON.stringify({
    questions: officialSnapshot.questions.map(question => [question.id, question.content_hash, question.is_core,
      question.category_ids, question.category_id, officialCategoryPathOf(question)?.normalized ?? null]),
    categories: officialSnapshot.categories,
  })).digest("hex");
  if (fingerprint === currentFingerprint) return { unchanged: true, fingerprint, sourceTotal: officialSnapshot.total };
  // 顺序固定：官网分类树校验 → 真题分类合成 → 官方快照分类净化 → 本地 overlay → 构建目录。
  // 必需根（223/1/601）校验先行，缺根本身就是官网结构异常，不该被合成或净化的报错盖掉；
  // 合成必须先于净化：真题叶子只存在于题目记录里，树不补齐就会被判悬空并丢弃。
  const refs = { strayCategoryRefs: [], strayPrimaryRefs: [], unclassifiedPrimaryRefs: [], incompleteQuestionRefs: [] };
  categoryIndex(officialSnapshot.categories);
  const synthesized = synthesizeExamCategoryTree(officialSnapshot);
  const sanitized = sanitizeOfficialCategories(synthesized, categoryIndex(synthesized.categories), refs);
  const snapshot = applyLocalClassifications(sanitized, await readLocalClassifications(overlayDir));
  const result = buildCatalog(snapshot, refs);
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
    await fs.mkdir(targetDir, { recursive: true });
    for (const file of [...fileByShard.values(), "categories.json", "category_questions.json", "id_index.json", "search_index.json", "manifest.json",
      "lecture-video-mappings.json", "paradiyu-linear-video.json", "retired-video-mappings.json"]) {
      const target = path.join(targetDir, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(stage, file), target);
    }
    const missingAssets = await downloadAssets(result.hashes, targetDir, fallbackAssetsDir, signal);
    const { strayCategoryRefs, strayPrimaryRefs, unclassifiedPrimaryRefs, incompleteQuestionRefs } = result;
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
    return { fingerprint, sourceTotal: snapshot.total, total: merged.total, missingAssets,
      native_solution_stats: nativeSolutionStats,
      strayCategoryRefs, strayCategoryCount: strayCategoryRefs.length,
      strayPrimaryRefs, strayPrimaryCount: strayPrimaryRefs.length,
      unclassifiedPrimaryRefs, unclassifiedPrimaryCount: unclassifiedPrimaryRefs.length,
      incompleteQuestionRefs, incompleteQuestionCount: incompleteQuestionRefs.length };
  } finally {
    const resolvedStage = path.resolve(stage);
    if (!resolvedStage.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
        !path.basename(resolvedStage).startsWith("daguan-official-sync-")) {
      throw new Error("同步临时目录位置异常，已保留以供检查");
    }
    await fs.rm(resolvedStage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
