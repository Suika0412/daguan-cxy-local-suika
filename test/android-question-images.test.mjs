// Android 题图准备：只按题库引用选图、写出字节与 hash 正确的 PNG、
// 把同内容的独立副本换成源图硬链接、失败时不留下半成品，
// 以及硬链接不受支持时的显式复制回退。

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectRequiredHashes,
  prepareQuestionImages,
} from "../android/tool/prepare-question-images.mjs";

// 与 scripts/run-tests.mjs 一致：Windows 上的临时文件一律放 F 盘。
if (process.platform === "win32") {
  process.env.TEMP = process.env.TMP = process.env.DAGUAN_TEST_TMP || "F:\\AI\\tmp";
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png = (label) => Buffer.concat([PNG_SIGNATURE, Buffer.from(label, "utf8")]);
const hashOf = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "daguan-android-images-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "web-assets");
  const output = path.join(dir, "question_images");
  const questions = path.join(dir, "questions.json");
  await fs.mkdir(source, { recursive: true });
  return { source, output, questions };
}

async function putSource(source, bytes) {
  const hash = hashOf(bytes);
  await fs.writeFile(path.join(source, `${hash}.png`), bytes);
  return hash;
}

async function writeQuestions(questions, questionAssets) {
  await fs.writeFile(
    questions,
    `${JSON.stringify({ version: 1, total: questionAssets.length, items: questionAssets })}\n`,
  );
}

const question = (id, hashes) => ({
  id,
  assets: hashes.map((hash) => `asset://sha256/${hash}`),
});

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch (cause) {
    if (cause.code === "ENOENT") return null;
    throw cause;
  }
}

/** 输出目录快照：文件名 -> 字节，用于断言失败路径没有改动输出。 */
async function snapshot(directory) {
  const names = (await fs.readdir(directory)).sort();
  const files = {};
  for (const name of names) files[name] = (await fs.readFile(path.join(directory, name))).toString("hex");
  return files;
}

test("准备题图：只生成题库引用的图，内容与文件名 hash 一致", async (t) => {
  const { source, output, questions } = await fixture(t);
  const alpha = png("alpha");
  const beta = png("beta");
  const unused = png("unused");
  const hashA = await putSource(source, alpha);
  const hashB = await putSource(source, beta);
  await putSource(source, unused);
  // 两道题共 3 条引用、2 个唯一题图：验证去重选图。
  await writeQuestions(questions, [question(1, [hashA]), question(2, [hashA, hashB])]);

  const result = await prepareQuestionImages({ questions, source, output });

  assert.deepEqual(
    (await fs.readdir(output)).sort(),
    [`${hashA}.png`, `${hashB}.png`].sort(),
    "输出目录应只包含被引用的题图",
  );
  for (const [hash, bytes] of [[hashA, alpha], [hashB, beta]]) {
    const written = await fs.readFile(path.join(output, `${hash}.png`));
    assert.equal(written.toString("hex"), bytes.toString("hex"), `${hash}.png 字节应一致`);
    assert.equal(hashOf(written), hash, `${hash}.png 内容 hash 应与文件名一致`);
  }
  assert.equal(result.required, 2);
  assert.equal(result.linked + result.copied, 2);
  assert.equal(result.bytes, alpha.length + beta.length);
  assert.equal(result.unchanged, 0);
});

test("准备题图：重复执行幂等，第二次全部保留不变", async (t) => {
  const { source, output, questions } = await fixture(t);
  const hashA = await putSource(source, png("alpha"));
  const hashB = await putSource(source, png("beta"));
  await writeQuestions(questions, [question(1, [hashA, hashB])]);

  const first = await prepareQuestionImages({ questions, source, output });
  const before = await snapshot(output);
  const second = await prepareQuestionImages({ questions, source, output });

  assert.equal(first.unchanged, 0);
  assert.equal(second.unchanged, 2, "第二次运行应全部识别为已就绪");
  assert.equal(second.linked, 0);
  assert.equal(second.copied, 0);
  assert.deepEqual(await snapshot(output), before, "重复执行不应改写输出");
});

test("准备题图：独立副本换成源图硬链接，源文件不被改动", async (t) => {
  const { source, output, questions } = await fixture(t);
  const alpha = png("alpha");
  const hashA = await putSource(source, alpha);
  await writeQuestions(questions, [question(1, [hashA])]);

  // 先造一份同内容的独立副本，模拟仓库里已经存在的重复占用。
  await fs.mkdir(output, { recursive: true });
  await fs.copyFile(path.join(source, `${hashA}.png`), path.join(output, `${hashA}.png`));
  const sourceStat = await fs.stat(path.join(source, `${hashA}.png`));
  const copyStat = await fs.stat(path.join(output, `${hashA}.png`));
  assert.notEqual(copyStat.ino, sourceStat.ino, "前置条件：副本应是独立 inode");
  assert.equal(copyStat.nlink, 1);

  const result = await prepareQuestionImages({ questions, source, output });

  const linkedStat = await fs.stat(path.join(output, `${hashA}.png`));
  assert.equal(result.linked, 1);
  assert.equal(result.copied, 0);
  assert.equal(linkedStat.ino, sourceStat.ino, "输出应指向源图同一 inode");
  assert.equal(linkedStat.nlink, 2);
  assert.equal(
    (await fs.readFile(path.join(output, `${hashA}.png`))).toString("hex"),
    alpha.toString("hex"),
  );
  const sourceAfter = await fs.stat(path.join(source, `${hashA}.png`));
  assert.equal(sourceAfter.ino, sourceStat.ino, "源文件 inode 不应变化");
  assert.equal(sourceAfter.size, sourceStat.size, "源文件大小不应变化");
});

test("准备题图：源图缺失、损坏、非 PNG 或引用无效时明确失败且不动输出", async (t) => {
  const cases = [
    {
      name: "源图缺失",
      setup: async () => hashOf(png("missing")),
      expected: /读取失败/,
    },
    {
      name: "内容损坏",
      setup: async ({ source }) => {
        // 文件名是正确内容的 hash，磁盘内容却被改写。
        const hash = hashOf(png("damaged"));
        await fs.writeFile(path.join(source, `${hash}.png`), png("damaged!"));
        return hash;
      },
      expected: /内容 SHA-256 为/,
    },
    {
      name: "非 PNG 内容",
      setup: async ({ source }) => {
        const bytes = Buffer.from("not a png at all", "utf8");
        return putSource(source, bytes);
      },
      expected: /不是 PNG 文件/,
    },
  ];

  for (const { name, setup, expected } of cases) {
    await t.test(name, async (t) => {
      const { source, output, questions } = await fixture(t);
      const good = await putSource(source, png("good"));
      const hash = await setup({ source });
      await writeQuestions(questions, [question(1, [good]), question(2, [hash])]);

      // 输出目录里已经有一份内容，失败后必须原样保留。
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(path.join(output, "placeholder.txt"), "keep");
      const before = await snapshot(output);

      await assert.rejects(
        () => prepareQuestionImages({ questions, source, output }),
        (error) => {
          assert.match(error.message, expected);
          return true;
        },
      );
      assert.deepEqual(await snapshot(output), before, "预检失败不应改动输出");
    });
  }

  await t.test("引用格式无效", async (t) => {
    const { source, output, questions } = await fixture(t);
    const good = await putSource(source, png("good"));
    await fs.writeFile(
      questions,
      `${JSON.stringify({
        version: 1,
        total: 2,
        items: [
          question(1, [good]),
          { id: 2, assets: ["asset://sha256/not-a-hash"] },
        ],
      })}\n`,
    );
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, "placeholder.txt"), "keep");
    const before = await snapshot(output);

    await assert.rejects(
      () => collectRequiredHashes(questions),
      /无效题图引用/,
    );
    await assert.rejects(
      () => prepareQuestionImages({ questions, source, output }),
      /无效题图引用/,
    );
    assert.deepEqual(await snapshot(output), before, "引用无效不应改动输出");
  });
});

test("准备题图：文件系统不支持硬链接时回退复制并显式报告", async (t) => {
  const { source, output, questions } = await fixture(t);
  const alpha = png("alpha");
  const hashA = await putSource(source, alpha);
  await writeQuestions(questions, [question(1, [hashA])]);

  const mocked = mock.method(fs, "link", async () => {
    const error = new Error("cross-device link not permitted");
    error.code = "EXDEV";
    throw error;
  });
  t.after(() => mocked.mock.restore());

  const target = path.join(output, `${hashA}.png`);
  const first = await prepareQuestionImages({ questions, source, output });

  assert.equal(first.linked, 0);
  assert.equal(first.copied, 1);
  assert.equal(first.unchanged, 0);
  assert.deepEqual(first.fallbackReasons, { EXDEV: 1 }, "回退原因必须写进统计");
  assert.equal((await fs.readFile(target)).toString("hex"), alpha.toString("hex"));
  const copiedStat = await fs.stat(target);
  assert.notEqual(copiedStat.ino, (await fs.stat(path.join(source, `${hashA}.png`))).ino);

  // 第二遍：内容已正确，不应再复制或改写，但回退尝试的原因仍要如实报告。
  const second = await prepareQuestionImages({ questions, source, output });

  assert.equal(second.copied, 0, "内容正确的复制副本不应被再次重写");
  assert.equal(second.unchanged, 1);
  assert.equal(second.linked, 0);
  assert.deepEqual(second.fallbackReasons, { EXDEV: 1 });
  const afterSecond = await fs.stat(target);
  assert.equal(afterSecond.ino, copiedStat.ino, "第二遍不应替换目标文件");
  assert.equal(afterSecond.mtimeMs, copiedStat.mtimeMs);
  assert.equal((await fs.readFile(target)).toString("hex"), alpha.toString("hex"));
});

test("准备题图：目标内容损坏时重新生成，即使大小相同", async (t) => {
  const { source, output, questions } = await fixture(t);
  const alpha = png("alpha");
  const hashA = await putSource(source, alpha);
  await writeQuestions(questions, [question(1, [hashA])]);

  // 目标位上放一份名字正确、长度相同但内容错误的前次产物。
  const damaged = Buffer.from(alpha);
  damaged[damaged.length - 1] ^= 0xff;
  assert.equal(damaged.length, alpha.length, "前置条件：损坏内容长度不变");
  await fs.mkdir(output, { recursive: true });
  const target = path.join(output, `${hashA}.png`);
  await fs.writeFile(target, damaged);
  const damagedStat = await fs.stat(target);
  assert.equal(damagedStat.nlink, 1);

  const result = await prepareQuestionImages({ questions, source, output });

  assert.equal(result.unchanged, 0, "内容不符的目标不应算作已就绪");
  assert.equal(result.linked, 1);
  assert.equal((await fs.readFile(target)).toString("hex"), alpha.toString("hex"));
  assert.equal(result.bytes, alpha.length);
  const regenerated = await fs.stat(target);
  assert.equal(
    regenerated.ino,
    (await fs.stat(path.join(source, `${hashA}.png`))).ino,
    "重新生成后应指向源图",
  );
  assert.equal(
    (await fs.readFile(path.join(source, `${hashA}.png`))).toString("hex"),
    alpha.toString("hex"),
    "源图不应被损坏内容影响",
  );
});

test("准备题图：未知链接错误直接抛出，不静默回退", async (t) => {
  const { source, output, questions } = await fixture(t);
  const hashA = await putSource(source, png("alpha"));
  await writeQuestions(questions, [question(1, [hashA])]);

  const mocked = mock.method(fs, "link", async () => {
    const error = new Error("input/output error");
    error.code = "EIO";
    throw error;
  });
  t.after(() => mocked.mock.restore());

  await assert.rejects(
    () => prepareQuestionImages({ questions, source, output }),
    /创建硬链接失败（EIO）/,
  );
  assert.deepEqual(await fs.readdir(output), [], "失败后不应留下临时文件或半成品");
  assert.equal(await statOrNull(path.join(output, `${hashA}.png`)), null);
});
