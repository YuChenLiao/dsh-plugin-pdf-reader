# dsh-plugin-pdf-reader 实施计划（阶段 0–4）

> **For agentic workers:** 按任务顺序执行，每个任务自带测试循环。步骤用 `- [ ]` 勾选。
>
> **Goal:** 让模型用一次 `pdf_extract` 调用拿到 PDF 正文与质量判定，大文件只拿判定、正文按页读。
>
> **Architecture:** 工具层（注册 `pdf_extract`/`pdf_read`/`pdf_ping`，提供 `ctx.pdfEngines` 注册表）与三个引擎组件（`/fast` OpenDataLoader+JVM、`/hybrid` docling 后端、`/fallback` pdfium WASM）分离；选择链按 priority 升序取第一个可用引擎。
>
> **Tech Stack:** TypeScript + esbuild（打包成 `lib/*.js` 四个入口）、node:test、`@opendataloader/pdf` 2.5.20、`@hyzyla/pdfium` 3.0.0、dsh `ctx.tools` / `ctx.subprocess`。
>
> **Spec:** `docs/design.md`（本仓库内），原始任务书 `docs/task.md`

## Global Constraints

- 上游 `@opendataloader/pdf` **精确锁 2.5.20**（`"2.5.20"`，不写 `^`）。
- `inlineLimit` 默认 **6000 字符**，硬顶 8192（`tool-result-pruner` 阈值），语义是字符不是 token。
- 缓存键 = `sha256(文件内容 + 引擎名 + 引擎版本 + pages + 页分隔符)` 前 12 位，即 handle；目录名即 handle。
- 查缓存必须在引擎探测之前：命中就直接返回，不调 `available()`。
- 不声明 `ToolDefinition.timeoutMs`；各引擎自持 deadline。
- canonical value 不使用 `null`，不可计算的字段省略；`required` 只含 `mode`、`engine`（`pdf_ping` 为 `pong`）。
- 模型可见面由 `output.render` 生成，JSON 不进上下文。
- 页分隔符固定 `<!-- PAGE %page-number% -->`；页码是原文页码（不重编号）。
- 固定 Markdown，不暴露 `format` 参数。
- 阶段 0–6 只在 `memtest` profile 验证；`web` profile 是阶段 7。
- 每个任务结束跑一次 `npm test`，全绿才提交。

## Review Focus

- **超长正文**：8000+ 字符的 PDF 若走 inline，会被 dsh 的 pruner 截成"头 4096 + 尾 1024"，中间静默丢失 → 必须有测试锁住"超 6000 字符一律 spilled"。
- **含中文与空格的路径**：spawn 参数数组传递，路径不拆分、不乱码 → 必须有含空格与中文的路径用例。
- **无 JVM 的机器**：fast `available()` 必须返回 reason 而不是抛异常炸掉工具调用 → 必须有用例覆盖"java 不存在"。
- **同一文件第二次调用**：必须不产生任何子进程（连 `java -version` 都不许有）→ 必须有用例断言缓存命中路径未调用探测。
- **abort**：转换中途取消后不得残留子进程 → 必须有 abort 用例。

---

## 任务 0：仓库骨架与 `pdf_ping`

**Files:**
- Create: `package.json`、`tsconfig.json`、`.gitignore`、`scripts/build.mjs`、`cordis.patch.yml`、`README.md`
- Create: `src/ctx.ts`、`src/engines.ts`、`src/proc.ts`、`src/probe/java.ts`、`src/tools/ping.ts`、`src/plugin.ts`
- Create: `src/engines/fast.ts`、`src/engines/hybrid.ts`、`src/engines/fallback.ts`
- Test: `tests/registry.test.mjs`、`tests/java-version.test.mjs`、`tests/ping.test.mjs`

**Interfaces:**
- Produces: `createEngineRegistry(): EngineRegistry`；`PdfEngine { name, priority, available(), convert() }`；`parseJavaVersion(text): number | null`；`detectJava(run, binary): Promise<{ok, version?, reason?}>`；`runProcess(run, spec): Promise<{code, stdout, stderr}>`

- [ ] **Step 1: 写失败测试** —— 注册表按 priority 升序、`select()` 跳过不可用引擎、`probe()` 汇总每个引擎的 reason；`parseJavaVersion('openjdk version "17.0.11" …') === 17`、`parseJavaVersion('java version "1.8.0_391"') === 8`、无法解析返回 `null`；`pdf_ping` 的 canonical value 含 `pong: true` 与 `engines` 数组。
- [ ] **Step 2: 跑测试确认失败** —— `npm test`，期望 `Cannot find module`。
- [ ] **Step 3: 实现上述模块** —— 注册表用 `Map`，`available()` 结果按引擎名缓存且注册/注销时失效；`runProcess` 优先用 `ctx.subprocess`，没有时退回 `node:child_process`（单元测试用后者）。
- [ ] **Step 4: 跑测试至全绿** —— `npm test`。
- [ ] **Step 5: 构建** —— `npm run build`，确认 `lib/index.js`、`lib/fast.js`、`lib/hybrid.js`、`lib/fallback.js` 均产出。
- [ ] **Step 6: 装进 memtest** —— `dsh plugin --profile memtest add D:/dsh/dsh-plugin-pdf-reader`，检查 profile `package.json` 的 `bundles` 出现四个名字。
- [ ] **Step 7: 提交并打标签** —— `git add -A && git commit -m "阶段 0 骨架：工具层、引擎注册表与 pdf_ping" && git tag v0.0.1-阶段0`

---

## 任务 1：fast 引擎的转换（`ctx.subprocess` + `--to-stdout`）

**Files:**
- Create: `src/engines/fast.ts`（补全 `convert`）、`src/upstream.ts`（jar 路径解析与 argv 拼装）
- Test: `tests/fast-convert.test.mjs`

**Interfaces:**
- Consumes: 任务 0 的 `runProcess`、`EngineRegistry`
- Produces: `buildArgv(input, options): string[]`；`convertFast(run, spec): Promise<ConvertResult>`

- [ ] **Step 1: 写失败测试** —— argv 断言：含 `-Dfile.encoding=UTF-8`、`--format markdown`、`--markdown-page-separator <!-- PAGE %page-number% -->`、`--to-stdout`、`--image-output off`；含空格与中文的路径作为**单个数组元素**出现；abort 时 `convertFast` 以 `cause: 'aborted'` 拒绝。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 argv 拼装与转换** —— 复用上游 `buildArgs` 生成参数；stdout 按 UTF-8 解码；非零退出按 stderr 正则分类（`not a PDF file` → `not-pdf`，`corrupted or truncated` → `corrupted`，`password|encrypt` → `encrypted`，其余 `engine-error` 带 stderr 尾 2KB）
- [ ] **Step 4: 跑测试至全绿**
- [ ] **Step 5: 真机验证** —— 对一份中文 4 页 PDF 转换一次，`body.md` 落盘，含 4 个页分隔符；abort 后 `tasklist | findstr java` 无残留
- [ ] **Step 6: 提交并打标签** —— `git commit -m "阶段 1 转换：fast 引擎经 ctx.subprocess 直出 Markdown"`、`git tag v0.0.2-阶段1`

---

## 任务 2：缓存、指标与 `pdf_extract` 骨架（`verdict: unknown`）

**Files:**
- Create: `src/cache.ts`、`src/metrics.ts`、`src/tools/extract.ts`
- Test: `tests/cache.test.mjs`、`tests/metrics.test.mjs`

**Interfaces:**
- Produces: `cacheKey(sha256, engine, version, params): string`；`writeEntry(dir, {body, meta, source}): Promise<void>`；`lookupFile(cacheDir, sha12, params): Promise<Entry | null>`；`computeMetrics(markdown, separator): Metrics`

- [ ] **Step 1: 写失败测试** —— 缓存键对引擎名/版本/pages 任一变化都不同；`lookupFile` 在无命中时返回 `null`、命中时返回最新 `cachedAt`；指标：全角替换字符计数、CJK 占比、`empty_pages`（页字符 < 20）、`last_page_ratio` 用中位数、`tables`/`headings` 正则计数
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 cache 与 metrics** —— 目录布局按设计 §7；指标只用 Markdown
- [ ] **Step 4: 跑测试至全绿**
- [ ] **Step 5: 真机跑 25 份样本** —— 产出 `docs/metrics-distribution.md`，`verdict` 恒为 `unknown`
- [ ] **Step 6: 提交并打标签**

---

## 任务 3：判定与 inline/spilled 分流

**Files:**
- Create: `src/verdict.ts`、`src/tools/extract.ts`（补全返回与 render）
- Test: `tests/verdict.test.mjs`、`tests/inline-split.test.mjs`

**Interfaces:**
- Produces: `judge(metrics, engine, thresholds): { verdict, score, issues }`；`decideMode(chars, inlineLimit): 'inline' | 'spilled'`

- [ ] **Step 1: 写失败测试** —— 分引擎阈值表；`chars = 6001` → `spilled`，`chars = 6000` → `inline`；`chars = 0` → `failed`；fallback 永不 `suspect`
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现判定与分流**
- [ ] **Step 4: 跑测试至全绿**
- [ ] **Step 5: 真机验证三类文件** —— 8 页中文 → inline；60 页 → spilled 且 `issues` 空；扫描件 → suspect 且含"疑似扫描件"
- [ ] **Step 6: 提交并打标签**

---

## 任务 4：`pdf_read`

**Files:**
- Create: `src/tools/read.ts`
- Test: `tests/read.test.mjs`

- [ ] **Step 1: 写失败测试** —— 按页读取返回该页正文；区间读取拼接多页；超 `maxChars` 截断且末尾标注剩余范围；handle 不存在时错误里含最近 5 个 handle
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现按页寻址**（按页分隔符切分，不重新转换）
- [ ] **Step 4: 跑测试至全绿**
- [ ] **Step 5: 真机验证** —— 从 `suggest` 给出的页读出内容
- [ ] **Step 6: 提交并打标签**

---

阶段 5（fallback 引擎）、6（hybrid 引擎）、7（接入 web profile）在阶段 0–4 落地后另出计划：它们的验证依赖外部环境（pdfium WASM 体积、docling 后端与模型下载），与本文档的任务没有接口耦合。
