# dsh-plugin-pdf-reader 设计文档

> 状态：待批准 ｜ 日期：2026-11-11 ｜ 上游：`@opendataloader/pdf` 2.5.20（精确锁）
> 任务书：`docs/pdf-reader-plugin-task.md`
> 位置说明：`D:\dsh` 本身不是 git 仓库。本文档现在只是草稿位置；阶段 0 建库时会把它和任务书一起移进插件仓库的 `docs/`，之后以仓库内版本为准（见 §14）。

## 1. 意图与为什么

现在模型每读一次 PDF 都要现场写一段脚本：找库、拼参数、处理编码、判断提取质量好不好。这件事一天重复几次，每次都花掉一次工具轮次和若干上下文。

这个插件把这件事变成一次调用：`pdf_extract(path)` 直接给判定与正文（小文件）或判定与句柄（大文件），正文按页用 `pdf_read` 取。模型不再关心 PDF 是怎么解析的，只关心"这份文件的文本能不能用"。

真正的目标不是"解析 PDF"，而是**让模型知道这次提取可不可信**。质量量化与三档判定因此是核心，不是附加项。

## 2. 目标、非目标、反目标

**目标**

- 小文件（转换后 ≤ `inlineLimit`，默认 **6000 字符**）一次调用拿到全文，不再二次调用。6000 是硬上限，理由见 §15.2：dsh base bundle 的 `tool-result-pruner` 在 8192 字符处把结果裁成"头 4096 + 尾 1024"，超过它会静默丢掉中间正文。
- 大文件默认只返回判定块，一段正文都不进上下文；需要时按页读。
- 同一文件第二次调用命中缓存，不启动任何解析引擎。
- 本机无 JVM 也能用（降级引擎），启用 hybrid 后能用 docling 后端。
- 中文路径、含空格路径、中文 PDF 不乱码。

**非目标**

- 不做 PDF 渲染、预览、批注、页面 UI。
- 不做 bbox / JSON 结构化输出（fast 的 JSON 带 bbox，体积大，本阶段只用 Markdown 做量化）。
- 不做批量目录转换（留接口，不做实现）。
- 不移植上游排版算法（见 §4 方案 B，已否决）。
- 不自建 Python 环境、不替用户执行 `pip install`。

**反目标**

- 把 20 万字符的正文塞进上下文，一次读 PDF 花掉大半上下文预算。
- 让模型在一个文件上反复试错：先 inline、再 pdf_read、再换页，最后还是一堆 token 换不到有效内容。
- 判定误报：正常文件被判 `suspect`，模型开始乱调 `pdf_read`。
- 为了"零 Java 依赖"把项目拖成三周以上的算法移植工程。

## 3. 约束（已实测的硬事实）

| 约束 | 实测值 | 影响 |
| --- | --- | --- |
| 工具名全局唯一，重复注册抛错 | `packages/core/scope/src/store.ts:45` `if (data.has(name)) throw` | 三个引擎不能各自注册 `pdf_extract`，必须分工具层与引擎层 |
| `ToolDefinition` 强制声明 `output: { schema, render }` | `packages/core/tools/src/index.ts:224` | 模型看到的不是 canonical JSON，是 `render` 产出的内容块 |
| `exec.signal` 是 `AbortSignal`，`timeoutMs` 由策略插件强制 | 同文件 `:237` / `:267` | 取消与超时都要真正传导到子进程 |
| `ctx.subprocess` 提供托管进程范围 | `packages/subprocess/README.md` | Windows 整树 terminate、`waitForExit()` 证明静默、abort 直连终止流程，不必手写 `taskkill` |
| `!!js` 可求值 patch 行的 `disabled`，但求值是同步的 | `docs/cordis-primer.md:39` | 装载期探测 JVM 要 `spawnSync`，阻塞启动约 400ms |
| CLI 支持 `--to-stdout` + `--format markdown` | 实测 4 页中文 PDF 0.55s，输出无盘写入 | 转换层可不落 output-dir，避免同名文件互踩 |
| CLI 支持 `--markdown-page-separator` 且支持 `%page-number%` | 实测 4 页产出 4 个分隔符 | `empty_pages` / `last_page_ratio` 可从 Markdown 计算 |
| fast 模式 JVM 内存占用低 | `-Xmx64m` 可跑完 4 页中文 PDF | 不需要为内存做特殊处理 |
| jar 24,277,941 字节，2.5.20 解包 24.7MB | 实测 | 走 npm 依赖引用，不 vendor 进仓库 |
| 上游 latest 已到 2.5.21 | npm registry | 精确锁 2.5.20，行为以实测为准 |
| `@hyzyla/pdfium` 3.0.0 为 MIT，解包 14.1MB | npm registry | 降级引擎可选；`mupdf` 是 AGPL-3.0，不可用于 MIT 插件 |
| pdfium WASM 4 页 init+load 22ms、取文本 5ms/页 | 实测 | 降级路径无冷启动问题 |
| pdfium WASM 暴露 page object（实测一页 `path:251 / text:164 / image:4`） | 实测 | 未来若做边框表格检测，绘制指令可达 |
| 上游 core main 111 文件 1.24MB Java，fast 管线子集约 1 万行 | `git ls-tree` 实测 | 移植成本 3–6 周，已否决 |

## 4. 方案取舍

### 方案 A：单组件，`engine: auto` 单开关

一个包一个组件，config 里三态选择。实现最省，但三个引擎无法独立开关、独立配置、独立禁用，用户没法"只关掉 hybrid"，也无法给每个引擎不同的超时与端口配置。

**否决**：与用户明确要求的"三档可独立开关"不符。

### 方案 B：移植上游排版算法到 TS（XY-Cut++ / 表格 / 标题）

无 JVM、单包、质量可控。但 fast 管线子集约 1 万行 Java（`XYCutPlusPlusSorter` 1,400 行、`ListProcessor` 1,800 行、`MarkdownGenerator` 1,400 行、表格五件套 1,300 行…），且输入源从 PDFBox `TextPosition` 换成 pdfium char box 后所有阈值需重新标定，上游至今仍在按 issue 修边界 case。工期 3–6 周且需长期跟版。

**否决**：成本超过插件本身的价值。

### 方案 C：工具层 + 三引擎层（**采用**）

```
dsh-plugin-pdf-reader              工具层（总是装载）
   ├─ ctx.tools.register(pdf_extract / pdf_read / pdf_ping)
   ├─ 提供 ctx.pdfEngines 注册表
   └─ 缓存、指标、分流：与引擎无关

dsh-plugin-pdf-reader/fast        引擎：OpenDataLoader + JVM（JVM 可用时参与）
dsh-plugin-pdf-reader/hybrid      引擎：docling 后端（默认关，同意后开，优先级最高）
dsh-plugin-pdf-reader/fallback    引擎：pdfium WASM（默认开，永远可用）
```

选它的理由：

- 满足"可独立开关"：每个引擎是独立装载行，独立 config、独立 `disabled`。
- 工具名只注册一次，绕开硬约束。
- 判定与分流逻辑只写一遍，引擎只实现 `convert(input, options, signal) → { markdown, engine, degraded }`。
- 引擎可换：将来若移植算法，只是新增一个引擎组件，工具层不动。

代价：多一层注册表服务，阶段 0 多半天。

## 5. 组件结构与注册表契约

### 5.1 工具层（主入口 `dsh-plugin-pdf-reader`）

- 注册三个工具，形态见 §6。
- 提供 `ctx.pdfEngines`：

```ts
interface PdfEngine {
  readonly name: 'fast' | 'hybrid' | 'fallback'
  /** 数值越小越优先；hybrid=10, fast=20, fallback=90 */
  readonly priority: number
  /** 探测本引擎当前是否可用；结果由工具层按进程生命周期缓存 */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>
  convert(request: ConvertRequest, signal: AbortSignal): Promise<ConvertResult>
}
```

- 选择链：按 `priority` 升序，对每个引擎调 `available()`（结果缓存），第一个 `ok` 的执行转换。全部失败时抛结构化错误，列出每个引擎的 `reason`。
- **超时不由 dsh 的 timeout-policy 管**：不声明 `ToolDefinition.timeoutMs`。三个引擎超时差异过大（120s/600s/60s），而 timeout-policy 只接受一个值、产出的错误文案固定为 "tool call timed out after Nms"，拿不到引擎名。改由各引擎自持 deadline（内部 AbortController），`exec.signal` fuse 进去，错误里带引擎名与已等待时长。
- 引擎卸载（dispose）必须从注册表移除，注册表本身用 `ctx.effect` 托管。

### 5.2 fast 引擎（`/fast`）

- `available()`：`ctx.subprocess.resolveExecutable(javaBinary)` → `java -version` 解析主版本，要求 ≥ 17；并检查 jar 存在。**惰性在首次调用时探测，结果缓存**；不在装载期同步探测（见 §3 `!!js` 约束）。
- `convert()`：`ctx.subprocess.spawn({ argv: [java, -Dfile.encoding=UTF-8, -Djava.awt.headless=true, -jar, jarPath, input, '--format', fmt, '--markdown-page-separator', SEP, '--to-stdout', '--image-output', 'off', ...extra], stdio: {stdin:'ignore', stdout:{maxBytes}}, graceMs, signal })`。
- 参数拼装复用上游 `buildArgs`（`@opendataloader/pdf` 的导出），不自己维护参数表。
- abort → 服务 `terminate()` 终止整树；插件侧 await `waitForExit()` 后才返回，保证不留残留 java。
- 超时默认 120s（`Config.timeoutMs`）。

### 5.3 hybrid 引擎（`/hybrid`）

- 默认 `enabled: false`。
- `enabled: true` 且 `acceptModelDownload: false` → **装载期抛错**，报错文案包含：需要 Python 3、`pip install "opendataloader-pdf[hybrid]"`、首次下载 docling 模型（数百 MB）、需要常驻后端与端口；并写明"同意即把 `acceptModelDownload` 设为 `true`"。
- `acceptModelDownload: true` 后：
  1. 健康检查 `hybridUrl/health`（或实际转换探针），通过则直接用；
  2. 不通过且 `autoStart: true` → 用 `ctx.subprocess` 拉起 `opendataloader-pdf-hybrid --port <port>`；
  3. 拉起后轮询健康，**首次启动的模型下载作为后台任务**，状态写入 `~/.dsh/pdf-cache/.hybrid-state.json`，期间工具调用返回"后端正在初始化（约需数分钟），稍后重试"，而不是超时失败；
  4. 转换时传 `--hybrid docling-fast` + `--hybrid-url`。
- 生命周期：后端常驻，插件 dispose 时 terminate（`ctx.subprocess` 的 service disposal 会终止其管理的进程）。
- 不负责 `pip install`。

### 5.4 fallback 引擎（`/fallback`）

- 默认 `enabled: true`，`@hyzyla/pdfium` 为插件依赖。
- `available()`：永远 `ok`（WASM 初始化失败时返回 reason）。
- `convert()`：`loadDocument` → 逐页 `getText()` → 用页分隔符拼接 → 返回 `degraded: true`。
- 顺序问题不修（不做 XY-Cut），在结果与 `meta.json` 中标注。

## 6. 工具契约

### `pdf_extract`

```js
parameters: {
  type: 'object',
  properties: {
    path:        { type: 'string', description: 'PDF 绝对路径或工作区相对路径' },
    pages:       { type: 'string', description: '页范围，如 1-10；省略为全部。页码是原文页码，不重编号' },
    inlineLimit: { type: 'number', description: '入上下文字符上限，默认 6000，0 表示总是落盘' },
    force:       { type: 'boolean', description: '忽略缓存重新转换', default: false }
  },
  required: ['path']
}
```

**已砍掉 `format` 参数**，固定 Markdown（理由见 §15.9）。`pages` 直接透传上游 `--pages`；实测 `--pages 2-3` 时 `%page-number%` 输出的是原文页码 2、3（非重编号），所以 `suggest` 给出的页码与 `pdf_read(page=N)` 的语义天然一致。

canonical value 按任务书 §5 的三类形态（inline / spilled / suspect），另加两个字段：`engine: 'fast'|'hybrid'|'fallback'`、`degraded: boolean`。

**schema 固定规则（`output.schema` 在 register 时即被 `assertSupportedJsonSchema` 校验，且该子集只支持单 type 或二分支 oneOf，字段可空性必须现在定死）**

- 不使用 `null`。不可计算的字段**直接省略**：fallback 下省略 `stats.tables`、`stats.headings`、`score`。
- `mode: 'inline' | 'spilled' | 'initializing'`；`initializing` 是**成功值**，带 `retryAfterMs`、无 `handle`、无 `verdict`。
- `verdict: 'ok' | 'suspect' | 'failed' | 'unknown'`，`unknown` 只出现在校准期（阶段 2）。
- 所有可选字段在 schema 里标 `optional`，`required` 只含 `mode`、`engine`。

模型可见面由 `output.render` 生成紧凑文本，例如：

```
pdf ok · 42页 · 86431字符 · ~51000 tokens · 12表格 · 48标题 · engine=fast
handle=3f2a91c8
```

`suspect` 时追加 issue 行与 `suggest`。JSON 只作为 canonical value 进日志，不进上下文。

### `pdf_read`

参数同任务书 §5；只读缓存，不转换；超 `maxChars` 截断并在末尾标注剩余范围（`剩余：第 13–42 页`）。

### `pdf_ping`

阶段 0 的存在证明，阶段 5 升级为环境体检：返回 `{ pong, java, jar, engines: [{name, available, reason}] }`。

## 7. 缓存与 handle

```
~/.dsh/pdf-cache/
  <handle>/            每次转换一个目录，handle = sha256(内容 + 引擎指纹 + 参数指纹) 前 12 位
    body.md            转换后的正文（含页分隔符）
    meta.json          全部原始指标 + engine + engineVersion + degraded + cachedAt
    source.json        { path, size, mtime, sha256, params }
  index/<sha12>.json   { fileSha256, entries: [{ handle, engine, engineVersion, params, pages, cachedAt }] }
```

- `engineSignature` 必含引擎名与引擎版本（fast 用上游版本，hybrid 用后端版本，fallback 用 pdfium 版本）。**不引入引擎指纹会直接错命中**：切到 hybrid 后读到 fast 的旧结果。
- `paramsSignature` 含 `pages`、页分隔符。`pages` 进键的理由：上游支持 `--pages`，只转部分页比全量快；不放进键就会把部分页结果当成全文缓存。

**查缓存在探测引擎之前**（硬指标 3：第二次调用不再启动 JVM）：

1. 读文件算 `sha256`（纯 I/O，无子进程）；
2. 读 `index/<sha12>.json`，按 `params` 过滤；
3. 有命中就**直接用**，不再调任何 `available()` —— 否则每次调用都要跑一次 `java -version`，既违背"无新增 java 进程"的验收，也白花 100ms+；
4. 命中结果按 `engine` 如实标注（可能是 `degraded` 的 fallback），模型觉得质量不够可用 `force: true` 重转；
5. 无命中才走引擎选择链。

- `pdf_read(handle)` 直接按目录寻址，不需要索引；handle 不存在时返回明确错误并附最近 5 个可用 handle。
- 缓存淘汰本阶段不做，只在 `pdf_ping` 里报目录大小。

**与 dsh 的结果后处理的边界**：spilled 模式下我们自身返回的是判定块（很小），不会触发 spill-policy；`pdf_read` 靠的是 handle + 按页寻址，不依赖任何临时文件路径，因此与 spill 机制不构成第二套恢复通道。

## 8. 指标与判定

指标计算全部从 Markdown 得出，指标定义沿用任务书 §6 的表格（`replacement_ratio`、`control_ratio`、`private_use_ratio`、`cjk_ratio`、`question_run_max`、`avg_chars_per_line`、`single_char_line_ratio`、`line_end_punct_ratio`、`page_char_variance`、`empty_pages`、`last_page_ratio`、`tables`、`headings`、`image_only_hint`）。

**分引擎阈值表**（`metrics.js` 里集中定义，便于校准）：

| 引擎 | failed 判定 | suspect 判定 | tables/headings |
| --- | --- | --- | --- |
| fast | 全套三个条件 | 任务书 §6 原本的五条 | 有效计数 |
| hybrid | 全套三个条件 | 同 fast，阈值可更严 | 有效计数 |
| fallback | 仅 `chars == 0` 与 `replacement_ratio > 0.005` | **不判定** | 省略（不输出 null，见 §15.4） |

fallback 不判 suspect 的理由：它的阅读顺序按 PDF 绘制顺序，`avg_chars_per_line`、`single_char_line_ratio`、`cjk_ratio` 会成片失真，沿用同一套阈值必然误报。

**校准流程（不可跳过）**：阶段 2 交付时 `verdict` 恒为 `unknown`，`meta.json` 记录全部原始值。样本约 25 份（本地 6 份真实 PDF + 联网抓取的公开 PDF + 自造无文本层扫描件），覆盖中文论文、双栏、含表格、纯英文、扫描件五类，跑完统计分布后再定阈值并打开判定。`Config.judgeEnabled` 可一键退回阶段 2 行为。

## 9. 配置

| 组件 | 字段 | 默认 | 说明 |
| --- | --- | --- | --- |
| 工具层 | `enabled` | `true` | 总开关 |
| | `inlineLimit` | `6000` | 入上下文上限（**字符**，非 token），硬顶 8192 见 §15.2；0 = 总是落盘 |
| | `cacheDir` | `~/.dsh/pdf-cache` | |
| | `judgeEnabled` | `false` | 阶段 3 后改 `true` |
| `/fast` | `enabled` | `true` | `true` 时仍要运行时探测 JVM |
| | `javaBinary` | `java` | |
| | `timeoutMs` | `120000` | |
| `/hybrid` | `enabled` | `false` | |
| | `acceptModelDownload` | `false` | 未设 true 时装载期报错 |
| | `hybridUrl` | — | 已自建后端时直接指过去 |
| | `port` | `5002` | |
| | `autoStart` | `true` | |
| | `timeoutMs` | `600000` | hybrid 慢，默认放宽 |
| `/fallback` | `enabled` | `true` | |
| | `timeoutMs` | `60000` | |

## 10. 错误与降级矩阵

| 情况 | 行为 |
| --- | --- |
| 文件不存在 / 不是 PDF | 明确报错，附解析后的绝对路径 |
| JVM 不存在或版本 < 17 | fast 引擎 `available()` 返回 reason；选择链落到 fallback 或 hybrid |
| 无任何引擎可用 | 结构化错误列出每个引擎 reason |
| 加密 PDF | 报错 `cause: 'encrypted'`，提示可用 `password` 配置透传；本阶段不暴露密码参数 |
| 扫描件 | fast 判 `suspect` + `image_only_hint`；fallback 标 `degraded` |
| 转换中途 abort | `terminate()` → `waitForExit()`，返回取消错误，不留 Java 进程 |
| 转换超时 | 引擎内部 deadline 触发，错误带引擎名与已等待时长 |
| hybrid 后端未就绪 | 返回 `mode: 'initializing'` 成功值（不是 error），带 `retryAfterMs` |
| handle 不存在 | 报错 + 最近 5 个可用 handle |

**失败原因分类**：`SubprocessOutcome` 只给 `exitCode`/`signal`，不做原因分类，所以分类在引擎的 `convert()` 里按 **退出码 + stderr 文案**做，返回 `cause`：

| stderr 特征（实测） | cause |
| --- | --- |
| `not a PDF file` | `not-pdf` |
| `not a valid PDF file (corrupted or truncated content)` | `corrupted` |
| 含 `password` / `encrypt`（上游走 `InvalidPasswordException` 分支，源码已确认有此分支） | `encrypted` |
| abort signal 已置位 | `aborted` |
| 其他非零退出 | `engine-error`，附 stderr 尾部 2KB |

无法识别时一律落 `engine-error`，不吞掉原始 stderr。

## 11. 阶段与验收

| 阶段 | 内容 | 验收 | 回滚 |
| --- | --- | --- | --- |
| 0 骨架 | 工具层 + `ctx.pdfEngines` + 四条装载行 + `pdf_ping` | memtest profile 装载成功，`pdf_ping` 返回本机能力（**只验 memtest，不动 web/default/desktop**） | 删 bundles 行 |
| 1 转换 | fast 引擎跑通 `ctx.subprocess` + `--to-stdout` | 单文件 `body.md` 落盘；abort 后 `tasklist` 无残留 java | `Config.enabled=false` |
| 2 指标 | 分引擎指标框架，`verdict: 'unknown'` | 25 份样本分布表 | 同上 |
| 3 判定 | fast 阈值校准 + inline/spilled 分流 | 小文件 inline、大文件 spilled、扫描件 suspect 三类各验一份 | `judgeEnabled=false` |
| 4 读取 | `pdf_read` | 从 `suggest` 给出的页能读出内容；超 `maxChars` 有标注 | 删除该工具注册 |
| 5 fallback | pdfium 引擎 + `degraded` 标注 | 临时把 java 移出 PATH，`pdf_extract` 仍成功且 `engine='fallback'` | `/fallback` 设 `enabled:false` |
| 6 hybrid | 同意机制 + 后端拉起 + 后台下载 + 健康检查 | 开启后一次转换走通；后端未就绪时返回初始化中；dispose 后无残留进程 | `/hybrid` 设 `enabled:false` |
| 7 接入日常会话 | 把四条装载行写进 `web` profile（当前 GUI 用的那个），备份后重启 | 新会话里 `pdf_ping` 可见；旧会话无报错 | 恢复备份的 `package.json` 并重启 |

阶段 0–6 的验收**只在 memtest 上进行**。`web` profile 有 `patchReload: live`，但新增 bundle 仍需重启才生效，且改它的 `bundles` 行前必须先备份 —— 所以单独列为阶段 7，等你确认后再做。

每个阶段结束都要跑：同一文件连调两次，第二次 `meta.json` 的 `cachedAt` 未变、无新增 java 进程。

## 12. 留给 builder 的决定

- `ctx.pdfEngines` 用 Cordis service 还是 `ctx.get()` + 显式提供者注入 —— 按实现时最少的样板选。
- 页分隔符的最终字面量（建议 `<!-- PAGE %page-number% -->`，已验证可用），以及正文是否保留它。
- `pdf_read` 输出的页标记格式。
- hybrid 健康检查的具体端点与轮询间隔、重试次数。
- 阶段 2 的 25 份样本清单与来源（公开 PDF 的抓取范围）。
- `render` 的紧凑格式细节（单行 / 多行、字段顺序）。

## 13. 风险

| 风险 | 后果 | 对策 |
| --- | --- | --- |
| fallback 顺序错导致模型误用正文 | 拿到语义错乱的段落 | 结果带 `degraded`，`render` 首行明确标注引擎 |
| hybrid 首次模型下载卡住工具调用 | 一次调用挂数分钟 | 下载走后台任务 + 状态文件，调用期返回"初始化中" |
| hybrid 后端端口冲突 | 启动失败 | 健康检查先探，冲突时选 `port+1` 并在 meta 记录实际端口 |
| 缓存键漏引擎指纹 | 换引擎后读到旧结果 | 键里强制含引擎名与版本，写测试锁定 |
| 三引擎同时可用导致转换重复 | 白花时间 | 选择链只取第一个 `ok`，不做并行试错 |
| 上游升版行为漂移 | 指标分布变化 | `package.json` 精确锁 2.5.20；升级需重跑阶段 2 分布 |
| 沙箱限制子进程 | JVM 起不来 | 阶段 1 第一步就验证；不可用则检查 `ctx.subprocess` 的 provider 是否装载 |

## 14. 版本管理

插件独立建仓，与本机现有插件（`dsh-plugin-memory-ledger`、`dsh-plugin-structured-prompt`、`dsh-comfyui-workbench` 各有独立 `.git`）保持一致。

**建库（阶段 0 第一步）**

```sh
cd /d/dsh && mkdir dsh-plugin-pdf-reader && cd dsh-plugin-pdf-reader
git init -b main
# docs/ 收进设计文档与任务书，之后以仓库内版本为准
mkdir -p docs src/tools tests
cp /d/dsh/docs/2026-11-11-pdf-reader-design.md docs/design.md
cp /d/dsh/docs/pdf-reader-plugin-task.md docs/task.md
```

**`.gitignore`**

```
node_modules/
*.log
.hybrid-state.json
```

`lib/` 不忽略：本机以 `link:` 装进 profile，`main` 指向 `lib/`，构建产物必须存在才能装载。与 `memory-ledger` 的做法一致。

**提交节奏**

- 每个阶段一个或多个提交，提交信息用中文并带阶段前缀：`阶段 0 骨架：工具层与引擎注册表`。
- 阶段边界打轻量标签：`v0.0.1-阶段0` … `v0.1.0`（阶段 6 完成）。
- 首次提交只含骨架（`package.json`、`cordis.patch.yml`、`src/plugin.ts`、`docs/`、`.gitignore`），不夹带 `node_modules` 与缓存。
- **不自动 push**：远端仓库要由你建好并给出地址后再加 remote，本设计不预设远端。

**与 dsh 的关系**

- 插件仓库独立于 `D:\dsh`；profile 里用 `link:D:/dsh/dsh-plugin-pdf-reader` 引用，不改 dsh 本体。
- 设计文档与任务书进仓库，避免"文档在 A、代码在 B"；`D:\dsh\docs` 下的两份保留为草稿副本，不再更新。

## 15. 评审修订（2026-11-11，builder check 反馈）

一份 builder 视角的评审对初稿提了 9 个"猜错就返工"的问题。逐条结论如下；标「实测」的有本机命令证据。

### 15.1 `pages` 在哪一层实现（原风险：`suggest → pdf_read` 静默读错页）

**实测**：上游 CLI 有 `--pages`，`--pages 2-3` 时 `%page-number%` 输出 **2、3**（原文页码，不重编号）。所以页范围在**引擎层直接透传**给 CLI，字符串原样进 `paramsSignature`，页码语义全链路一致。`pdf_read` 按原文页码寻址，无需映射。

### 15.2 `inlineLimit` 与 dsh 结果后处理的冲突（本项目最关键的一处修正）

base bundle 里有两道后处理，初稿完全没考虑：

| 插件 | 配置 | 作用 |
| --- | --- | --- |
| `tool-result-pruner` | `thresholdChars: 8192`、`headChars: 4096`、`tailChars: 1024` | 超过 8192 **字符**的工具结果被裁成"头 4096 + 尾 1024"，**中间正文静默消失** |
| `spill-policy` | `maxInlineTokens: 12500` | 超 token 预算的结果换成预览 + spill 文件路径 |

即：`inlineLimit: 15000` 的正文会被 pruner 砍成两截，模型看到"头 + 尾"却以为是全文，硬指标 1 在真实会话里根本不成立。

**决定**：`inlineLimit` 改为 **6000 字符**，且语义明确为字符而非 token。判定块（约 200–400 字符）+ 正文 6000 + JSON 包装，合计稳定在 8192 以下。超限一律走 `spilled` + `pdf_read`，绝不让 pruner 截断正文。这是正确性要求，不是调优项。

### 15.3 缓存命中与引擎探测的先后（原风险：每次调用都起 `java -version`）

**决定**：先查缓存、后探引擎（详见 §7）。文件哈希是纯 I/O；`index/<sha12>.json` 按 `params` 过滤后命中就直接返回，**不调用任何 `available()`**。命中的结果按引擎如实标注 `engine` / `degraded`，质量不够时用 `force: true` 重转。这样才能同时满足"第二次不启动 JVM"和"无新增 java 进程"。

同一文件存在多引擎缓存时：**返回参数匹配、`cachedAt` 最新的那份**，不按优先级重挑（重挑就要探测引擎，与上一条冲突）。`meta.json` 里保留 `engine` 供 `pdf_ping` 汇总。

### 15.4 fallback 的 canonical value（原风险：schema 改一次连带改全套）

`output.schema` 在注册时即被 `assertSupportedJsonSchema` 校验，且该子集只支持单 `type` 或二分支 `oneOf`，可空性必须现在定死。

**决定**：不用 `null`，用**省略**。fallback 下省略 `stats.tables`、`stats.headings`、`score`；`verdict` 取 `'ok' | 'failed'`（永不 `suspect`，理由见 §8）。schema 里 `required` 只含 `mode`、`engine`，其余全 optional。这样 fallback 不会因为字段缺失被 schema 拒绝，也不会因为报 `ok` 给错乱顺序盖章 —— `degraded: true` 与 `render` 首行的 `engine=fallback` 才是质量声明。

### 15.5 超时归谁管

**决定**：不声明 `ToolDefinition.timeoutMs`，各引擎自持 deadline（§5.1）。理由：三个引擎 120s/600s/60s 差异过大，而 timeout-policy 只接受单值、错误文案固定，拿不到引擎名；§10 要求错误里带引擎名与已等待时长，只能自己分类。

### 15.6 hybrid "初始化中"是值还是错

**决定**：**成功值**。`mode: 'initializing'` + `retryAfterMs`，无 `handle`、无 `verdict`，`render` 输出一句"后端正在初始化（首次需下载模型），约 N 秒后重试"。当 error 会让模型怀疑文件坏了并去试别的路径。

### 15.7 失败原因分类

`SubprocessOutcome` 只带 `exitCode`/`signal`，原因分类由引擎按 **退出码 + stderr 文案**做（表见 §10）。已实测的文案：

- `Error: 'x.txt' is not a PDF file. …` → `not-pdf`（exit 1）
- `Error: 'x.pdf' is not a valid PDF file (corrupted or truncated content).` → `corrupted`（exit 1）

加密走上游的 `InvalidPasswordException` 分支（`DocumentProcessor.java` 里显式 catch 并交给 CLI 处理），本机未能造出加密样本实测，因此**正则兜底 + `engine-error` 保底**，原始 stderr 尾部 2KB 一律带出。上游支持 `--password`，配置里预留 `password` 透传但默认不暴露。

### 15.8 交付到哪个 profile

**决定**：阶段 0–6 只验 `memtest`；`web`（当前 GUI 用的 profile）单独作为阶段 7，改前备份 `package.json`、改后重启，并明确"patchReload: live 不等于新增 bundle 免重启"。

### 15.9 砍掉 `format: 'text'`

**决定**：删掉 `format` 参数，固定 Markdown。`text` 格式下没有标题/表格结构标记，`tables`、`headings` 无法计算，而判定链依赖它们；留着等于维护第二条判定路径。页寻址不受影响（Markdown 侧已实测可用）。
