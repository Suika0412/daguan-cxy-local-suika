# 原版大观园题库同步（2026-09-28）

来源：[原版大观园学习区](https://www.cxyonly.fans/math) 的公开 `/api/questions` 和 `/api/categories`。同步命令 `npm run sync:data` 现从官网 API 分页读取，不再用旧的 `hsad.xyz` 静态镜像。同步只读取题库，不访问或修改官网账号进度。

- 官网当前题目：6,314 道。相对旧镜像的 6,183 道，新增题号 494 个，官网当前不再返回的旧题号 363 个。
- 仓库专有概率题：159 道，保持原有题号及分类。最终本地题库 6,473 道，题号唯一。
- 官网分类、题目正文、选项、答案、解析及题图引用已重建到本地分片和索引。服务工作线程缓存号更新到 v119，避免旧页面继续读取旧目录。
- 原讲解视频映射中，121 个李艳芳／没咋了题号和 9 个帕拉迪宇题号已不在当前题库。它们从活动映射移至 `web/data/retired-video-mappings.json`，保留原始链接信息供以后核对。
- 官网题图有 40 张尚未下载；图片接口返回 401，当前环境没有 `DAGUAN_ASSET_TOKEN`。提供临时 Token 后重新运行 `npm run sync:data` 可补齐。未补齐时，相应题目的文字与答案仍可使用。

`npm run verify` 已确认 6,473 道题与 6,473 个唯一题号，保留上述 40 张缺图警告。此前生成的 v1.0.2 安装器和浏览器归档仍含旧题库；公开发布前须重新构建并重新计算校验值。下载入口未改动。

## 2026-10-19 同步记录

以下为 2026-10-19 的同步结果，追加在原 2026-09-28 记录之后。上文 6,314 / 6,473 等数字是 09-28 当日的事实，本节不修改、不覆盖它们。本次 `manifest.synced_at` 为 `2026-10-19T05:20:55Z`。

- 官网 `/api/questions` 本次 `source_total` 为 7,082 道；生成题库 `total` 为 7,470 道（官网 7,082 + 本地专有 389 − 跳过残缺选择题 1）。
- 分片题数按当前 `manifest.json`：高等数学 3,457、线性代数 820、概率统计 547、历年真题 1,322、模拟哥专区 0、未分类 1,324。
- 历年真题：官网 `/api/categories` 已不再返回真题根，但 `/api/questions` 的题目记录仍带 `category_full_path` / `category_name`（形如「历年真题 / 数一 / 2019」）。同步改为按这些官方路径重建缺失的真题分类树，叶子沿用官网给出的 `category_id`；合成出的根与中间层 ID 由路径哈希生成（本次根为 980694423），**不是官网 ID**。旧的 836/837/855/873 映射与当前记录已错配，未再复用。
- 未分类 1,324 道中含本地 overlay 无法落位的部分：本地分类 9900100（Euclid 2027八月模考）挂在可选根 2500（模拟哥专区）下，而该根已下线，按既有语义显式跳过 1 个本地分类与 37 条题目映射，相关题目保留为未分类，不改挂其它父分类。
- 跳过官网残缺选择题 1 道（题号 11436，官网未提供能匹配选项的正确项），不进入任何分片或索引。
- 仍有 9 个次级悬空分类无法命名（官网删除了分类、题目引用还在），按既有语义告警丢弃，只保留题目的有效分类。
- 缺图数量两处口径不同：`npm run verify` 报 50 张，同步输出的 `missingAssets` 为 51。前者统计生成题库中缺失的题图，后者统计本次认为需要下载的数量；对外引用以 `verify` 的 50 张为准，补齐仍需 `DAGUAN_ASSET_TOKEN`。
- 官网下架题 10997，其讲解视频映射随同步归档到 `web/data/retired-video-mappings.json`（保留原始链接信息）。活动映射现为 6,032 个题号 / 9,784 条，其中汤家凤 3,084、李艳芳 1,913；未匹配审计仍为 73 条。

本节只记录上述已验证结果；未重新构建安装包，公开发布前仍须重新构建、核对校验值并以 GitHub Release 为准。

## 2026-10-28 上游同步能力适配与验收

本节记录 2026-10-28 对上游（`30098381`、`774a695f`）同步能力的适配与验收结果，追加在上文之后；上文 6,473 / 7,470 等数字是各当日事实，本节不修改、不覆盖。**本轮没有刷新官网题库**：`web/data/manifest.json` 仍是 2026-10-19 快照的 **7,470 题**，既不是上游快照的 7,599 题，也没有新增 376 道题单题目。

### 1. 实现范围

- 隐藏非真题分类恢复：新增纯函数按题目记录自带的分类路径补回官网隐藏的学科子分类，中间层用路径哈希生成的稳定 ID，叶子沿用官方 `category_id`；无路径证据的可选根仍允许缺席，ID/路径不一一对应时显式失败。
- 官方线代题单投影：读取固定题单 `linear-algebra-selected-20261018` 的列表本体、directory、items 三端点，校验官方/已发布/explicit 与 ID、三处题数一致；题单只做只读目录投影（根 `7000000`，子节点 `7000000 + 目录 category_id`），不复制题目、不改主库题数，题序取 items 数组序。
- 指纹纳入题单：metadata 的 id/name/revision、完整 directory 与有序 `[question_id, position, available]` 元组，从而「只改题单 revision / 题序 / 目录标签」也会触发重建。
- 活动旧分类保留：新增 `previousDataDir`（updater 传当前活动版本，overlay 仍用 bundled），只在题目分类被官网清空时回填仍有效的旧分类；本地显式 assignment 优先，不覆盖有效新分类。
- pending 口径：官网 `document.answer.pending === true` 的题不写入，独立计数；`source_total` 始终是官网原始总数，`total` 只统计写入题。原有残缺选择题跳过规则不变。
- 多格式题图：按引用识别 png/jpeg/jpg/webp/gif（缺扩展按 png，不支持的扩展不计入），在本地库合并与精讲补全**之后**收集最终引用；查找顺序为目标 → 上一活动版本 → bundled，jpg/jpeg 同族互认；服务端静态白名单放开到同样四种格式并支持别名回退。无 token 只按缺图计数；有 token 时单张失败进 `assetFailures` 诊断，Content-Type 必须与引用格式同族，不转码、不改后缀、取消必须传播。**未删除任何题干、答案、扫描图段或精讲解析来降低缺图数。**
- 新版主目录与章节选择弹窗：非完整范围隐藏空子节点但保留学科根，节点失效退回最近可见祖先，题单覆盖相同范围题目时去重；兼容无 `collection_id` 的历史节点。旧版只验证同一题库读取与题图。
- 上游模拟来源规则：移植上游 `mock_other` 规则（`线代王|押题王|余五|哈基米德|方浩|合工大|Beyond|超越`），使「27线代王六套*」181 题归入既有「模拟卷 / 其他模拟卷」。
- 保留项：学习数据机制、`reset_generation`、真题卷内题序、本地专有题库与精讲解析均未改动。

### 2. 最终实际验收（均在本轮隔离环境实跑）

- `npm test`：**628 项全部通过**（pass 628 / fail 0 / skipped 0 / cancelled 0），含真实 Chromium 浏览器用例。
- `npm run verify`：通过，**7,470 题与 7,470 个唯一题号**，保留既有 **50 张**缺图警告。
- `node --test test/service-instance.test.mjs test/electron-security.test.mjs test/server-safety.test.mjs`：**41/41 通过**，作为实例锁与 Electron 安全的独立证据。
- V2 正式隔离同步专项（`official-sync-pipeline` + `official-question-assets` + `native-solutions-overlay` + `reconcile-catalog-isolation`）：**35/35 通过**。
- 历史失败如实保留、未放宽断言：首轮 `npm test` 有 2 项静态数据失败（`explanations-v2` 的离库题号、`source-taxonomy` 的 214/7470 未识别来源），随后一次整合重跑暴露 `service-instance` 用例的 `null.pid` 一行测试缺陷（该用例在循环中允许 `currentOwner = null`，却在下一行裸读 `.pid`）。两者均已闭环：前者由 D2 归档与 source-taxonomy 规则修复，后者仅加 `currentOwner &&` 空值保护，最终断言（胜者/败者/健康/锁）全部保留。

### 3. 唯一数据整理（D2）

- [web/data/explanations-v2.json](web/data/explanations-v2.json)：活动解析 `count` 由 1,194 调整为 **1,188**，另有 **`retired_count: 6`** 与新对象 `retired_explanations`，二者相加仍为 **1,194**。
- 归档题号为 `7947`、`8059`、`8231`、`8232`、`8327`、`8466`，均确认已不在 [web/data/id_index.json](web/data/id_index.json) 中；原 entry 逐字段原样移入同文件，**没有删除任何解析内容**，原 `generated` 保留、原 `note` 未删只追加维护说明。
- 统一序列化后两侧内容哈希一致：`d4dcf8d0a61a1d9a547967ba7eaf0e65561131de0b7516b8cc1e71152b46a709`（独立复核 R2 亦得同一值）。
- 主库题干、[web/data/manifest.json](web/data/manifest.json)、[web/data/id_index.json](web/data/id_index.json) 与各分片**未改**。

### 4. 工程清理

- 本轮专属临时目录 `F:/AI/tmp/daguan-bank-sync-20261028-243ad4d-01` 已删除：**14 个文件 / 1 个子目录 / 387,665 字节**，含上游参考源码 2 份、三轮 V1 日志与 V2 日志共 10 份、测试截图 2 张。删除后该路径已确认不存在。
- B0、P1、P1U、P2、Q1、R2 均为只读内存会话，无脚本或产物落盘，无需物理回收。
- 预存产物保留：`tools/__pycache__/`（2026-10-18 生成）已在 `.gitignore` 覆盖范围内、`node_modules/`、F 盘既有 Playwright/npm 缓存、android 题图与 `.narrafork/` 计划均未触碰；**未新增 `.gitignore` 规则**。

### 5. 本轮变更文件

同步与服务（3）：

- [local-server/official-question-bank.mjs](local-server/official-question-bank.mjs)
- [local-server/question-bank-updater.mjs](local-server/question-bank-updater.mjs)
- [local-server/server.mjs](local-server/server.mjs)

前端与缓存引用（7）：

- [web/app-new.js](web/app-new.js)
- [web/app-legacy.js](web/app-legacy.js)
- [web/app2.js](web/app2.js)
- [web/index.html](web/index.html)
- [web/legacy.html](web/legacy.html)
- [web/service-worker.js](web/service-worker.js)
- [web/source-taxonomy.js](web/source-taxonomy.js)

测试：修改（9）

- [test/ai-settings-contract.test.mjs](test/ai-settings-contract.test.mjs)
- [test/explanations-v2.test.mjs](test/explanations-v2.test.mjs)
- [test/native-solutions-overlay.test.mjs](test/native-solutions-overlay.test.mjs)
- [test/new-ui-catalog.test.mjs](test/new-ui-catalog.test.mjs)
- [test/official-question-bank.test.mjs](test/official-question-bank.test.mjs)
- [test/question-bank-updater.test.mjs](test/question-bank-updater.test.mjs)
- [test/service-instance.test.mjs](test/service-instance.test.mjs)
- [test/source-taxonomy.test.mjs](test/source-taxonomy.test.mjs)
- [test/ui-contract.test.mjs](test/ui-contract.test.mjs)

测试：新增（5）

- [test/official-previous-categories.test.mjs](test/official-previous-categories.test.mjs)
- [test/official-question-collections.test.mjs](test/official-question-collections.test.mjs)
- [test/official-sync-pipeline.test.mjs](test/official-sync-pipeline.test.mjs)
- [test/official-question-assets.test.mjs](test/official-question-assets.test.mjs)
- [test/catalog-scope-browser.test.mjs](test/catalog-scope-browser.test.mjs)

数据与本记录（2）：

- [web/data/explanations-v2.json](web/data/explanations-v2.json)（D2 归档）
- [docs/official-question-bank-sync-2026-09-28.md](docs/official-question-bank-sync-2026-09-28.md)（本节）

### 6. 限制与未完成事项

- 官网分类、题单与 items 接口在匿名环境实测返回 **401 或 404**；仅凭状态码不能判定路由是否下线。本轮**未完成真实官网刷新与现网端到端验收**；实现依据是固定上游 commit 的契约加确定性夹具，**不等价于现网可用**。
- 缺图未补：题图下载另需 `DAGUAN_ASSET_TOKEN`，该变量只用于题图授权；未补齐时相关题目文字与答案仍可用。
- 章节选择弹窗当前**没有可见的打开入口**，浏览器用例通过公开方法激活该组件后验证；主目录与范围切换已用真实点击验证。
- 未打包、未安装、未替换日常用户数据、未提交、未推送、未发布；HEAD 仍为 `243ad4d`。

### 7. 最短验收步骤与现网待补

```bash
export TEMP='F:/AI/tmp' TMP='F:/AI/tmp' DAGUAN_TEST_TMP='F:/AI/tmp'
export PLAYWRIGHT_BROWSERS_PATH='F:/AI/tmp/playwright-browsers'
export DAGUAN_AUTO_UPDATE_BANK=0
unset DAGUAN_DATA_DIR
npm test                 # 期望 628/628，含 Chromium 用例
npm run verify           # 期望通过：7,470 题 / 7,470 唯一题号 + 50 张缺图警告
node --test test/service-instance.test.mjs test/electron-security.test.mjs test/server-safety.test.mjs
node --test test/official-sync-pipeline.test.mjs test/official-question-assets.test.mjs \
  test/native-solutions-overlay.test.mjs test/reconcile-catalog-isolation.test.mjs
```

现网待补（不在本轮范围，按顺序推进）：

1. 先确认并适配上题库与题单的授权读取方式：当前匿名访问受限，授权方式与鉴权后的真实字段都待验证。
2. 在此基础上核对三个题单端点（列表本体 / directory / items）的实际字段，再做一次真实更新并核对结果。
3. 题图授权独立处理：`DAGUAN_ASSET_TOKEN` 只覆盖题图，与题库/题单读取授权不是同一件事。
4. 打包、安装与发布需另行安排，并按发布规范核对校验值后以 GitHub Release 为准。
