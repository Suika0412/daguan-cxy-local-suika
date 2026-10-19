#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncOfficialQuestionBank } from "../local-server/official-question-bank.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "web", "data");
const result = await syncOfficialQuestionBank({ targetDir: dataDir });
if (result.unchanged) {
  console.log(`官网题库无变化（${result.sourceTotal} 题），未写入`);
} else {
  const skipped = result.incompleteQuestionCount || 0;
  const officialWritten = result.sourceTotal - skipped;
  const localOnly = result.total - officialWritten;
  console.log(`官网 ${result.sourceTotal} 题 - 跳过残缺 ${skipped} 题 = 写入 ${officialWritten} 题；` +
    `本地专有 ${localOnly} 题；合计 ${result.total} 题；缺少 ${result.missingAssets} 张官网题图`);
}
