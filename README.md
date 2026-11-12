# dsh-plugin-pdf-reader

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的 PDF 读取工具：**让模型读 PDF 这件事本身变便宜**。

它不是又一个 PDF 解析器，而是把「模型每次要读 PDF 都得现场写一段脚本、跑一遍、再判断结果能不能用」这件事，收敛成一次工具调用：转换、质量判定、正文分流、按页回读，全部由插件完成，模型只管拿结果。

## 为什么需要它

实测同一份文件，「现场写脚本」与「调用本插件」的差别：

| 场景 | 现场写脚本 | 本插件 |
| --- | --- | --- |
| 小文件（4 页简历，2927 字符） | 576 字符脚本 + 首次运行报错（依赖解析不到）+ 修复重跑，**2–3 轮** | 1 次调用，1 轮；二次读同文件 **5ms** 命中缓存 |
| 大文件（43 页论文，136800 字符） | 输出 ≈ **82080 token**，还会被 `tool-result-pruner` 截成"头 4096 + 尾 1024"，**中间正文静默丢失** | ≈ **40 token** 的判定块 + handle，正文按页读 |
| 扫描件（8 页无文本层） | 16 字符，模型分不清"文件坏了"还是"本来没字"，容易反复试错 | 一轮给出 `suspect` +「疑似扫描件」+ 下一步建议 |

真正的价值不在省 token（小文件只省约 10%），而在三件事：

1. **不额外消耗模型轮次**——每多一轮都要重发整段上下文；
2. **大文件不会静默丢正文**——要么全文一次给到，要么一个字都不进上下文，只给句柄；
3. **提取失败会被明确判定**——编码损坏、扫描件、截断都能识别出来，模型不会拿着垃圾正文硬猜。

## 安装

装进任意 profile（把 `<仓库路径>` 换成本地克隆目录；Windows 上写成正斜杠或双反斜杠）：

```sh
git clone https://github.com/YuChenLiao/dsh-plugin-pdf-reader.git
cd dsh-plugin-pdf-reader && npm install && npm run build

dsh plugin --profile <profile> add <仓库路径>
dsh --profile <profile> --dump-config | grep pdf-reader   # 确认四条装载行
```

`<profile>` 用你实际运行的那个：桌面应用默认是 `desktop`，也可以用独立的测试 profile（如 `memtest`）先验。

装完**重启 DSH**。`lib/` 由 `npm run build` 产出，profile 以 `link:` 引用本目录，`main` 指向 `lib/index.js`，所以构建产物必须在。

> 如果 `add` 报权限类错误（例如提示 profile 被应用独占管理），先确认命令是在正常的用户 shell 里执行、且对该 profile 目录可写；这类报错来自执行环境的权限限制，不代表桌面版不能用标准命令安装。

## 工具

### `pdf_extract`

转换 PDF 并返回正文与质量判定。转换后 ≤ `inlineLimit`（默认 6000 字符）直接给全文；更大的文件只给判定块与 handle。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string，必填 | 绝对路径、工作区相对路径，或 `~` 开头 |
| `pages` | string | 页范围，如 `1-10`；页码是**原文页码**，不重编号 |
| `inlineLimit` | number | 本次调用的字符上限，0 表示总是落盘 |
| `force` | boolean | 忽略缓存重新转换 |
| `engine` | enum | `auto`（默认，fast → fallback）· `fast` · `fallback` · `hybrid` |

返回（小文件）：

```
pdf ok · 4页 · 2927字符 · 0表格 · 21标题 · engine=fast
handle=bb0f6e32c936

<!-- PAGE 1 -->
…全文…
```

返回（大文件，正文不进上下文）：

```
pdf ok · 43页 · 136800字符 · ~82080 tokens · 17表格 · 46标题 · engine=fast
handle=b27982854e2a
正文未进上下文：用 pdf_read 按页读取
```

返回（可疑）：

```
pdf suspect · 8页 · 16字符 · 0表格 · 0标题 · engine=fast
handle=5f6c72428de7
- 没有任何文本（只有空白）：疑似扫描件或图片版文档，当前引擎没有文本层
本引擎没有提取到文本，pdf_read 也读不到内容
```

### `pdf_read`

按 handle 读取已转换正文，**不重新转换**。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `handle` | string，必填 | `pdf_extract` 返回的句柄 |
| `page` | number | 单页（原文页码，1 起） |
| `pageStart` / `pageEnd` | number | 页区间，含两端 |
| `maxChars` | number | 字符上限，默认 20000 |
| `offset` | number | 从所选范围第几个字符开始；单页被截断时用它续读 |

单页比 `maxChars` 长时会返回 `next_offset`，并在输出里写明 `用 offset=N 续读`，不会出现"反复读同一段开头"的死循环。

### `pdf_ping`

环境体检：Java 版本、每个**真正注册了**的引擎及其可用性原因。只列已注册引擎，不列静态候选表。

```
pong · java=17 (java)
引擎: fast:ok · fallback:ok
```

## 三个引擎

选择链：`fast(20) → fallback(90)`。`hybrid(10)` **不进自动链**，只能显式 `engine: 'hybrid'` 调用。

| 组件 | 引擎 | 默认 | 实测 |
| --- | --- | --- | --- |
| `dsh-plugin-pdf-reader/fast` | OpenDataLoader（JVM CLI） | 开 | 文本 PDF 约 0.5s/页，含表格/标题层级与正确阅读顺序 |
| `dsh-plugin-pdf-reader/fallback` | pdfium（WebAssembly） | 开 | 无 JVM 时自动接管，同文件 **57ms**；无表格/标题结构，标 `degraded` |
| `dsh-plugin-pdf-reader/hybrid` | docling 后端 | 关 | 中文 6 页 **49.6–58.8s**（8–10s/页）；扫描件 + OCR 约 **25s/页** |

### hybrid 说明

开启前必须同意模型下载（`acceptModelDownload: true`），否则**装载期报错**并说明需要装什么、下多大、占哪个端口。

后端不属于本插件：

```sh
pip install "opendataloader-pdf[hybrid]"     # 106 个包，含 torch / docling，磁盘 1–2 GB
```

后端首次启动下载模型约 52s，常驻内存实测 **1296 MB**。插件负责健康检查与拉起（`ctx.subprocess`），不负责 `pip install`。

**扫描件要读中文必须显式开 OCR**，否则只有乱码：

```yaml
config:
  enabled: true
  acceptModelDownload: true
  backendArgs: ['--force-ocr', '--ocr-engine', 'easyocr', '--ocr-lang', 'ch_sim,en']
```

## 配置

工具层（`dsh-plugin-pdf-reader`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `inlineLimit` | `6000` | 入上下文字符上限。**硬顶 8192**：超过会被 dsh 的 `tool-result-pruner` 截成"头 4096 + 尾 1024"，中间正文静默消失，所以超过上限直接报错 |
| `judgeEnabled` | `true` | 关闭后退回"只记录指标、不判定" |
| `cacheDir` | `~/.dsh/pdf-cache` | 转换结果与指标落盘位置 |
| `javaBinary` | `java` | fast 引擎使用的可执行文件 |

引擎组件：

| 组件 | 字段 | 默认 |
| --- | --- | --- |
| `/fast` | `enabled` / `javaBinary` / `timeoutMs` | `true` / `java` / `120000` |
| `/hybrid` | `enabled` / `acceptModelDownload` / `port` / `autoStart` / `hybridUrl` / `backendBinary` / `backendArgs` / `timeoutMs` / `startTimeoutMs` | `false` / `false` / `5002` / `true` / — / `opendataloader-pdf-hybrid` / `[]` / `600000` / `300000` |
| `/fallback` | `enabled` / `timeoutMs` | `true` / `60000` |

## 缓存与 handle

```
~/.dsh/pdf-cache/
  <handle>/            12 位十六进制，= sha256(内容 + 引擎名 + 引擎版本 + pages + 分隔符) 前 12 位
    body.md            转换后的 Markdown（含页分隔符）
    meta.json          全部原始指标 + engine + engineVersion + degraded + cachedAt
    source.json        源文件路径、大小、mtime、sha256、参数
  index/<sha12>.json   按文件反查的多引擎索引
  index/_recent.json   最近用过的 handle
```

**查缓存在引擎探测之前**：读文件算哈希 → 查索引 → 命中直接返回，不再起 JVM、连 `java -version` 都不跑。引擎指纹必须进键，否则切引擎会读到旧引擎的结果。

## 质量判定

指标全部从 Markdown 计算（正则与统计，不读上游带 bbox 的 JSON）。阈值来自 25 份真实样本的分布校准（见 `docs/metrics-distribution.md`）：

| 规则 | 阈值 | 权重 |
| --- | --- | --- |
| 替换字符 `replacement_ratio` | `> 0.005` → **failed** | — |
| 控制字符 `control_ratio` | `> 0.02` → **failed** | — |
| 无文本（非空白字符为 0） | → **suspect**「疑似扫描件」 | 90 |
| `cjk_ratio` | `< 0.25`（且首部 CJK ≥ 5%） | −25 |
| `avg_chars_per_line` | `< 5` | −20 |
| `single_char_line_ratio` | `> 0.30` | −15 |
| `empty_page_ratio` | `> 0.20` | −30 |
| `last_page_ratio` | `< 0.05`（仅每页 ≥ 100 字符时计） | −15 |

`fallback` 引擎只判 `failed`，不判 `suspect` —— 它的阅读顺序按 PDF 绘制顺序，行与占比类指标不可信。

## 已知限制

| 项 | 说明 |
| --- | --- |
| 中文样本只有 5 份 | 阈值对中文论文、中文扫描件的覆盖仍偏薄 |
| hybrid 未进自动链 | 实测慢 50–100 倍，且质量不单调更好（同一份中文说明，hybrid 反而把图片数字认成伪表格） |
| 扫描件依赖 hybrid + OCR | fast/fallback 对无文本层 PDF 只能给 `suspect` |
| 不做 OCR 之外的版面理解 | 无公式提取、无图表描述、无 tagged-PDF 结构树 |
| `pdf_read` 的 `offset` 按字符切 | 不按块/句切，跨页续读要给 `pageStart/pageEnd` |

## 开发

```sh
npm install
npm run build      # esbuild → lib/{index,fast,hybrid,fallback}.js
npm test           # node --test，104 个用例
npx tsc --noEmit   # 类型检查
```

辅助脚本：

| 脚本 | 作用 |
| --- | --- |
| `scripts/make-fixtures.py` | 生成无文本层的图像页 PDF（Pillow），用于扫描件测试 |
| `scripts/metrics-distribution.mjs` | 跑样本分布，产出 `docs/metrics-distribution.md` |
| `scripts/verify-hybrid.mjs` | 拉起 docling 后端并与 fast 对比同一份文件 |

文档：`docs/design.md`（设计与评审修订）、`docs/plan.md`（实施计划）、`docs/acceptance.md`（全部实机数据）、`docs/task.md`（原始任务书）。

## 致谢

这个插件的转换能力几乎全部来自上游项目，本仓库只做了"给模型用的那一层"：调用编排、质量判定、缓存与按页回读。

### OpenDataLoader PDF

- 仓库：[opendataloader-project/opendataloader-pdf](https://github.com/opendataloader-project/opendataloader-pdf)
- 许可：**Apache-2.0**
- 用途：`fast` 与 `hybrid` 引擎的转换核心。依赖 npm 包 `@opendataloader/pdf`（内含 `opendataloader-pdf-cli.jar`），复用其导出的 `buildArgs` 生成参数表、`--markdown-page-separator` 生成页分隔符、XY-Cut++ 阅读顺序与表格识别。
- 说明：转换进程由本插件自己 spawn（不经上游 SDK 的 `convert()`），以便接入 dsh 的取消信号与超时；参数表仍由上游维护，避免版本漂移。

### pdfium

- npm 包：[`@hyzyla/pdfium`](https://github.com/hyzyla/pdfium)（**MIT**）
- 底层：[PDFium](https://pdfium.googlesource.com/pdfium/)（**BSD-3-Clause**，Chromium 项目）
- 用途：`fallback` 引擎。WebAssembly 构建，无 JVM、无外部进程，用于没有 Java 环境的机器。

### docling

- 仓库：[docling-project/docling](https://github.com/docling-project/docling)（**MIT**，IBM Research 发起）
- 用途：`hybrid` 引擎的后端。通过 docling-serve 兼容接口 `/v1/convert/file` 接收页面图像，返回版式、表格与 OCR 结果。

### 其他

- 设计文档的评审与阈值校准方法，参考了 dsh 自身的 `docs/` 与 `docs/defensive-patterns/`。
- `docs/metrics-distribution.md` 的英文样本来自 arXiv 公开论文，仅用于本地阈值校准，不随仓库分发。

## License

MIT，见 [LICENSE](LICENSE)。上游组件遵循各自许可：`@opendataloader/pdf` 为 Apache-2.0，`@hyzyla/pdfium` 与 docling 为 MIT，PDFium 为 BSD-3-Clause。
