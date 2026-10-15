// 准备 Android 离线题图目录。
//
// 题库中的题图是内容寻址的：引用形如 asset://sha256/<64 位小写十六进制>，
// 对应源文件 <source>/<hash>.png。Android 端的运行路径固定为
// assets/question_images/<hash>.png（见 lib/math_content.dart 与 pubspec.yaml），
// 因此本脚本只保证这些路径存在，并优先用硬链接把同一份物理数据同时暴露给
// web/data/assets 与 android/assets/question_images，避免同一张图在磁盘上存两份。
//
// 约定：
// - 源目录视为不可变，本脚本只读；生成物不要原地编辑，改动后重跑准备。
// - 先完整预检（引用格式、源文件存在、SHA-256、PNG 签名），预检失败不触碰输出。
// - 只对已知“该平台不支持硬链接”的错误码回退为复制，并显式计入统计；其余错误抛出。

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ASSET_REFERENCE = /^asset:\/\/sha256\/([a-f0-9]{64})$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// 跨卷、文件系统或平台明确不支持硬链接时允许复制回退；其他错误必须上报。
const LINK_FALLBACK_CODES = new Set(["EXDEV", "ENOTSUP", "EOPNOTSUPP", "EPERM"]);

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "..", "..");

export const defaultPaths = {
  questions: path.join(repositoryRoot, "android", "assets", "questions.json"),
  source: path.join(repositoryRoot, "web", "data", "assets"),
  output: path.join(repositoryRoot, "android", "assets", "question_images"),
};

async function sha256File(file) {
  const content = await fs.readFile(file);
  return { content, digest: createHash("sha256").update(content).digest("hex") };
}

/** 目标路径缺失或不可读时返回 null，不吞其他错误。 */
async function contentDigest(file) {
  let content;
  try {
    content = await fs.readFile(file);
  } catch (cause) {
    if (cause.code === "ENOENT") return null;
    throw new Error(`无法读取题图目标：${file}`, { cause });
  }
  return createHash("sha256").update(content).digest("hex");
}

/** 读取题库，返回去重排序后的题图 hash；任何不合规引用都直接抛错。 */
export async function collectRequiredHashes(questionsPath) {
  let raw;
  try {
    raw = await fs.readFile(questionsPath, "utf8");
  } catch (cause) {
    throw new Error(`无法读取题库文件：${questionsPath}`, { cause });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`题库 JSON 解析失败：${questionsPath}`, { cause });
  }
  if (!Array.isArray(parsed?.items)) {
    throw new Error(`题库缺少 items 数组：${questionsPath}`);
  }

  const hashes = new Set();
  const invalid = [];
  for (const question of parsed.items) {
    const assets = question?.assets;
    if (assets === undefined || assets === null) continue;
    if (!Array.isArray(assets)) {
      invalid.push(`题目 ${question?.id} 的 assets 不是数组`);
      continue;
    }
    for (const reference of assets) {
      const match = typeof reference === "string" ? ASSET_REFERENCE.exec(reference) : null;
      if (match) hashes.add(match[1]);
      else invalid.push(`题目 ${question?.id} 引用了无效题图：${JSON.stringify(reference)}`);
    }
  }
  if (invalid.length) {
    throw new Error(`题库存在无效题图引用（${invalid.length} 处）：\n${invalid.join("\n")}`);
  }
  return [...hashes].sort();
}

/** 校验全部源图；返回 hash -> { size, dev, ino }。失败时一次性列出所有问题。 */
export async function inspectSourceImages(hashes, sourceDirectory) {
  let sourceStat;
  try {
    sourceStat = await fs.stat(sourceDirectory);
  } catch (cause) {
    throw new Error(`题图源目录不可用：${sourceDirectory}`, { cause });
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`题图源路径不是目录：${sourceDirectory}`);
  }

  const failures = [];
  const entries = new Map();
  for (const hash of hashes) {
    const file = path.join(sourceDirectory, `${hash}.png`);
    let stat;
    let content;
    let digest;
    try {
      stat = await fs.stat(file);
      if (!stat.isFile()) {
        failures.push(`${file} 不是普通文件`);
        continue;
      }
      ({ content, digest } = await sha256File(file));
    } catch (cause) {
      failures.push(`${file} 读取失败：${cause.code ?? cause.message}`);
      continue;
    }
    if (!content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      failures.push(`${file} 不是 PNG 文件`);
      continue;
    }
    if (digest !== hash) {
      failures.push(`${file} 内容 SHA-256 为 ${digest}，与文件名不符`);
      continue;
    }
    entries.set(hash, { size: stat.size, dev: stat.dev, ino: stat.ino });
  }

  if (failures.length) {
    throw new Error(
      `题图源预检失败（${failures.length}/${hashes.length}）：\n${failures.join("\n")}`,
    );
  }
  return entries;
}

/**
 * 用源图占位目标路径：先写临时文件再 rename，绝不原地截断已链接的内容。
 * 硬链接不可用时回退复制；若此时目标已是同内容的独立副本，则保留原文件不动。
 * expectedHash 即目标文件名对应的内容 hash（内容寻址，所以两者必然相同）。
 */
async function placeFromSource(source, target, expectedHash, stats) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    try {
      await fs.link(source, temporary);
    } catch (cause) {
      if (!LINK_FALLBACK_CODES.has(cause.code)) {
        throw new Error(
          `创建硬链接失败（${cause.code ?? cause.message}）：${source} -> ${target}`,
          { cause },
        );
      }
      // 即使最终没有重写，也如实记录这次回退尝试的原因。
      stats.fallbackReasons[cause.code] = (stats.fallbackReasons[cause.code] ?? 0) + 1;
      if ((await contentDigest(target)) === expectedHash) {
        stats.unchanged += 1;
        return;
      }
      await fs.copyFile(source, temporary);
      await fs.rename(temporary, target);
      stats.copied += 1;
      return;
    }
    await fs.rename(temporary, target);
    stats.linked += 1;
  } catch (cause) {
    await fs.rm(temporary, { force: true });
    throw cause;
  }
}

/**
 * 让 output 目录包含所需题图，内容与来源逐字节一致。
 * 参数只有 questions/source/output 三个路径。
 */
export async function prepareQuestionImages({ questions, source, output }) {
  const hashes = await collectRequiredHashes(questions);
  const sourceEntries = await inspectSourceImages(hashes, source);

  await fs.mkdir(output, { recursive: true });
  const stats = {
    required: hashes.length,
    linked: 0,
    copied: 0,
    unchanged: 0,
    bytes: 0,
    fallbackReasons: {},
  };

  for (const hash of hashes) {
    const sourceFile = path.join(source, `${hash}.png`);
    const targetFile = path.join(output, `${hash}.png`);
    const info = sourceEntries.get(hash);
    stats.bytes += info.size;

    let existing = null;
    try {
      existing = await fs.stat(targetFile);
    } catch (cause) {
      if (cause.code !== "ENOENT") {
        throw new Error(`无法读取题图目标：${targetFile}`, { cause });
      }
    }
    if (existing) {
      if (!existing.isFile()) {
        throw new Error(`题图目标不是普通文件：${targetFile}`);
      }
      // 已经是源图本体（硬链接）时保持不动，重复执行不重写。
      if (existing.dev === info.dev && existing.ino === info.ino) {
        stats.unchanged += 1;
        continue;
      }
    }
    // 缺失、内容已过期或是同内容的独立副本：统一换成指向源图的硬链接。
    await placeFromSource(sourceFile, targetFile, hash, stats);
  }

  return {
    status: "PASS",
    questions,
    source,
    output,
    ...stats,
  };
}

async function main() {
  const result = await prepareQuestionImages(defaultPaths);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
