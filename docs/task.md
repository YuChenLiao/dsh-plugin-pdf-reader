# OpenDataLoader PDF → dsh 插件 任务书

> 交接对象：负责实施的对话 / 子 agent。
> 本任务书自包含，不需要回读调查记录。标「已确认」的可直接采信，标「待验证」的必须先跑一遍再写代码。
>
> 状态：待实施 ｜ 创建：2026-11-10 ｜ 上游：`@opendataloader/pdf` 2.5.20

## 1. 目标与验收形态

做一个 dsh 插件 `dsh-plugin-pdf-reader`，给模型一个**专用于 PDF 的工具**，消除"每次读 PDF 都现场写脚本"的开销。

验收形态：模型在会话里直接调 `pdf_extract(path)`，插件内部完成转换与质量量化，返回 200–400 token 的判定块；正文默认不进上下文，需要时用 `pdf_read` 按页读取。

三条硬指标：

1. 小文件（转换后 ≤ 15,000 字符）全文进上下文，一次调用完成
2. 大文件默认只返回摘要与质量判定，一段正文都不返回
3. 同一文件第二次调用命中缓存，不再启动 JVM

## 2. 既定事实（勿重复调研）

| 事实 | 值 | 来源 |
| --- | --- | --- |
| 上游包 | `@opendataloader/pdf` 2.5.20，Apache-2.0 | npm registry |
| 内嵌 JVM 产物 | `package/lib/opendataloader-pdf-cli.jar`，24,277,941 字节 | 解包 npm tarball 实测 |
| SDK 体积与依赖 | `dist/index.cjs` 11KB，外部依赖只有 `commander@^15` | 同上 |
| SDK 入口 | `convert(inputPaths, options): Promise<string>`；`buildArgs(options): string[]` 已导出 | `dist/index.d.cts` |
| SDK 缺失能力 | 无 `AbortSignal`、无超时、无进度回调；`spawn(command, args)` 两参调用 | `dist/index.cjs:216` |
| 本机运行时 | Java 17.0.11、Node v24.19.0、Python 3.12.2 | 实测 |
| fast 模式性能 | 0.015–0.02 s/page，纯本地确定性，无模型下载 | 上游 README |
| hybrid 模式 | 0.463 s/page，需 `opendataloader-pdf-hybrid --port 5002` 起 docling 后端，首次下载模型数分钟 | 上游 README |
| 内置安全过滤 | 默认剔除透明文字、零号字体、离页内容、隐藏图层 | 上游 README `AI Safety` 段 |
| dsh 插件形态 | npm 包 + `dsh.bundle.patch` 指向 `cordis.patch.yml` + function plugin 具名导出 `name`/`inject`/`Config`/`apply`，**无 default export** | `harness-latest/packages/AGENTS.md` |
| 工具注册 | `ctx.tools.register({name, description, parameters, output})`，返回 disposer | `packages/core/tools/src/index.ts:1071` |
| 取消信号 | `tools/execute` 的 `exec.signal` 是 `AbortSignal` | 同文件 `:165` |
| 装载方式 | `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 加一条 | 本机 `dsh-plugin-memory-ledger` 可抄 |
| 市场现状 | PDF 类插件全是预览 / 阅读 UI，无"结构化提取 + 质量量化"实现 | awesome-dsh-plugin 清单 |

## 3. 范围边界

**做**：

- fast 模式（数字版 PDF），Markdown 输出
- 质量量化与三档判定
- 结果落盘 + sha256 缓存
- 按页读取
- Java 缺失、加密 PDF、中文路径的明确报错

**不做**：

- hybrid 模式与 OCR（另立后续任务；本阶段遇到扫描件只报"疑似扫描件"）
- bbox / JSON 输出（fast 的 JSON 带 bbox 但体积大，本阶段只用 Markdown 做量化）
- 批量目录转换（先单文件，批量留接口）
- 页面级渲染预览（UI 层，不属于本插件）

## 4. 目录与命名

| 路径 | 作用 |
| --- | --- |
| `D:\dsh\dsh-plugin-pdf-reader` | 插件包本体，`link:` 引入 profile |
| `src/plugin.js` | `name` / `inject` / `Config` / `apply` 入口 |
| `src/convert.js` | spawn JVM、参数拼装、取消与超时 |
| `src/metrics.js` | 指标计算与 verdict |
| `src/cache.js` | sha256 键、落盘、命中判定 |
| `src/tools/extract.js` | `pdf_extract` |
| `src/tools/read.js` | `pdf_read` |
| `cordis.patch.yml` | bundle patch，一条 `insert` |
| `~/.dsh/pdf-cache/<sha256>/` | `body.md`、`meta.json`、`source.json` |
| `~/.dsh/profiles/memtest` | 验证用隔离 profile |

## 5. 工具契约

### `pdf_extract`

```js
parameters: {
  type: 'object',
  properties: {
    path:        { type: 'string', description: 'PDF 绝对路径或工作区相对路径' },
    format:      { type: 'string', enum: ['markdown', 'text'], default: 'markdown' },
    pages:       { type: 'string', description: '页范围，如 1-10；省略为全部' },
    inlineLimit: { type: 'number', description: '入上下文字符上限，默认 15000，0 表示总是落盘' },
    force:       { type: 'boolean', description: '忽略缓存重新转换', default: false }
  },
  required: ['path']
}
```

返回（小文件）：

```json
{ "mode": "inline", "handle": "3f2a91c8", "verdict": "ok", "score": 92,
  "pages": 8, "chars": 12400, "content": "……全文 Markdown……" }
```

返回（大文件，默认路径）：

```json
{ "mode": "spilled", "handle": "3f2a91c8", "verdict": "ok", "score": 92,
  "pages": 42, "chars": 86431, "tokens_est": 51000,
  "stats": { "replacement_ratio": 0.0003, "cjk_ratio": 0.71, "avg_chars_per_line": 38,
             "single_char_line_ratio": 0.02, "tables": 12, "headings": 48,
             "empty_pages": 0, "last_page_ratio": 0.88 },
  "issues": [], "suggest": null }
```

返回（可疑）：

```json
{ "mode": "spilled", "handle": "9c14ee02", "verdict": "suspect", "score": 41,
  "pages": 42, "chars": 3102,
  "issues": [
    "cjk_ratio 0.08：中文 PDF 提取后中文占比过低，疑似编码错",
    "empty_pages 12/42：疑似扫描件，fast 模式无文本层",
    "last_page_ratio 0.04：末页几乎为空，疑似截断"
  ],
  "suggest": "pdf_read(handle='9c14ee02', page=13)" }
```

### `pdf_read`

```js
parameters: {
  type: 'object',
  properties: {
    handle:    { type: 'string' },
    page:      { type: 'number', description: '单页' },
    pageStart: { type: 'number' }, pageEnd: { type: 'number' },
    maxChars:  { type: 'number', default: 20000 }
  },
  required: ['handle']
}
```

只读缓存文件，不重新转换。超 `maxChars` 时截断并在末尾标注剩余范围。

## 6. 质量指标规格

全部从 Markdown 计算，不读 JSON（避免几十 MB 的 bbox 拖内存）。Markdown 自带结构标记：`#` 标题、`|` 表格、`- ` / `1. ` 列表、页分隔符可配置。

| 组 | 指标 | 计算方式 |
| --- | --- | --- |
| 字符完整 | `replacement_ratio` | `count(U+FFFD) / chars` |
| | `control_ratio` | C0/C1 控制字符占比（排除 `\n\t`） |
| | `private_use_ratio` | U+E000–U+F8FF 占比 |
| 编码正确 | `cjk_ratio` | CJK 字符 / 非空白字符 |
| | `question_run_max` | 连续 `?` 最长长度 |
| 版面结构 | `avg_chars_per_line` | 非空行平均字符数 |
| | `single_char_line_ratio` | 长度 ≤1 的行占比 |
| | `line_end_punct_ratio` | 以 `。．.！？；;:：` 结尾的行占比 |
| | `page_char_variance` | 各页字符数的变异系数 |
| 覆盖完整 | `empty_pages` | 页字符数 < 20 的页数 |
| | `last_page_ratio` | 末页字符 / 页字符中位数 |
| | `tables` / `headings` | 正则计数 |
| 扫描件信号 | `image_only_hint` | `empty_page_ratio > 0.2` 或 `chars / pages < 100` |

### verdict 规则（**初值，必须校准**）

```text
failed  ← replacement_ratio > 0.005 或 control_ratio > 0.02 或 chars == 0

suspect ← 任一成立：
          - 首部 2000 字符含 CJK（≥5%）但全文 cjk_ratio < 0.30
          - avg_chars_per_line < 5
          - single_char_line_ratio > 0.15
          - empty_page_ratio > 0.20
          - last_page_ratio < 0.10

ok      ← 以上都不成立
```

`score` = 100 − 各越界项按权重扣分（权重表在 `metrics.js` 里集中定义，便于校准）。

**校准流程（不可跳过）**：阶段 1 交付时 `verdict` 恒为 `unknown`，只把全部指标写进 `meta.json`。收集 20–30 份真实 PDF（中文论文、双栏、含表格、扫描件、纯英文各若干）跑完统计分布后，再定阈值并打开判定。拍脑袋定阈值必然误报。

## 7. 分阶段交付

| 阶段 | 做什么 | 验收 | 回滚 |
| --- | --- | --- | --- |
| 0 骨架 | 插件包、`cordis.patch.yml`、`apply()` 注册一个空工具 `pdf_ping` | `dsh plugin --profile memtest add D:/dsh/dsh-plugin-pdf-reader` 后重启，会话里能调到 `pdf_ping` 并返回 `pong` | 从 `bundles` 删行，重启 |
| 1 转换 | `convert.js` 自己 spawn（不用 SDK），`buildArgs` 复用；接 `exec.signal`，超时默认 120s；Windows 用 `taskkill /T /F` 杀树；`-Dfile.encoding=UTF-8` | 单文件转换成功，`body.md` 落盘；中途 abort 能真正结束进程（`tasklist` 里无残留 java） | 关 `Config.enabled` |
| 2 指标 | `metrics.js` 全量指标 + `verdict: 'unknown'`；`meta.json` 记录全部原始值 | 连跑 20–30 份真实 PDF，产出指标分布表 | 同上 |
| 3 判定 | 按分布定阈值，打开 verdict 与 issues 文案，接 `inlineLimit` 分流 | 小文件 inline、大文件 spilled、扫描件判 suspect，三类各验证一份 | 把 `Config.judgeEnabled` 置 false 回到阶段 2 |
| 4 读取 | `pdf_read` 按页 / 区间读缓存，含截断标注 | 从 `suggest` 给出的页能读出内容；超 `maxChars` 有明确标注 | 删除该工具注册 |

每阶段结束都要跑一次：同一文件连调两次，第二次必须命中缓存（检查 `meta.json` 的 `cachedAt` 未变、无新 JVM 进程）。

## 8. 风险与对策

| 风险 | 后果 | 对策 |
| --- | --- | --- |
| 大输出塞爆上下文 | 一次读 PDF 花掉大半上下文 | `inlineLimit` 默认 15000 字符；超限只返回摘要；`pdf_read` 强制 `maxChars` |
| JVM 冷启动 | 小文件里启动时间超过解析时间 | sha256 缓存；批量接口预留 |
| Windows 编码 | 中文输出全是问号 | 显式 `-Dfile.encoding=UTF-8`；测试必须含中文 PDF |
| 中文路径 | spawn 参数被拆断 | 参数数组传参，不拼字符串；测试含空格与中文路径 |
| 沙箱限制子进程 | JVM 起不来 | 阶段 1 第一件事就验证 spawn 可用；不可用时改用 dsh 的 subprocess 服务而非裸 spawn |
| 阈值误报 | 正常文件被判 suspect，模型开始乱调 `pdf_read` | 阶段 2 强制先收数据 |
| jar 体积 | 插件仓库 24MB | 走 npm 依赖引用 `@opendataloader/pdf`，不 vendor jar 进自己的 git |

## 9. 验收清单

- [ ] `dsh plugin --profile memtest add` 成功，重启后正常对话
- [ ] `pdf_extract` 对一份 8 页中文 PDF 返回 `mode: "inline"` 且正文可用
- [ ] 对一份 60 页 PDF 返回 `mode: "spilled"`，`issues` 为空，`suggest` 为 null
- [ ] 对一份扫描件返回 `verdict: "suspect"`，`issues` 明确指出"疑似扫描件"
- [ ] 同一文件第二次调用命中缓存，`tasklist` 中无新增 java 进程
- [ ] 转换中途 abort 后，Java 进程确实退出
- [ ] 路径含中文与空格的 PDF 能正常处理，输出无乱码
- [ ] `pdf_read` 能读取 `suggest` 指定的页
- [ ] 删除 bundle 行并重启后，工具消失、无残留报错
- [ ] `meta.json` 中含全部原始指标值，可事后重算阈值

## 10. 待确认问题

**阻塞项**

- dsh 沙箱是否允许插件 spawn JVM 子进程（当前 `danger-full-access`，但 Windows 沙箱对子进程另有约束）。阶段 1 第一步就验证，不通则改走 dsh 的 subprocess 服务。
- 上游 jar 的 `--format markdown` 是否默认带页分隔符？若不带，需要在参数里显式设置，否则 `empty_pages` / `last_page_ratio` 无法计算。

**记录项**

- `Config` 字段最终集合（`enabled`、`inlineLimit`、`timeoutMs`、`judgeEnabled`、`cacheDir`、`javaBinary`）需要随实现固定，写进插件 README。
- 是否需要 `pdf_search`（在正文里 grep）——先不做，等真实使用中出现需求再补。
- 缓存淘汰策略（按目录大小还是按时间）本阶段不做，只记录目录大小。
