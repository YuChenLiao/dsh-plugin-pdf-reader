# 验收记录

## 2026-11-11 隔离 sandbox 端到端（模型层）

环境：`sandbox_create` 出的独立实例（自带 home/profile/端口），`sandbox_install` 装载本插件后 `sandbox_restart`，用 `sandbox_prompt` 跑真实对话轮次。宿主 `web` profile 未改动。

### 第 1 轮：自检 + 大文件

```
pdf_ping:
pong · java=17 (java)
引擎（优先级 hybrid=10 fast=20 fallback=90）: fast:ok · fallback:ok

pdf_extract(D:/…/arxiv-2201.11903v6.pdf):
pdf ok · 43页 · 136800字符 · ~82080 tokens · 17表格 · 46标题 · engine=fast
handle=b27982854e2a
正文未进上下文：用 pdf_read 按页读取
```

- 模型能选中三个工具并正确传参（`tool/call`、`tool/result` 事件成对出现）。
- hybrid 组件 `disabled: true`，所以没有注册 —— 引擎列表如实反映，没有假装在候选里。
- 大文件正文 0 字符进上下文，只给判定块。

### 第 2 轮：按页读取 + 小文件 inline + 扫描件

```
pdf_read(handle=b27982854e2a, page=13):
b27982854e2a · 第 13 页（共 43 页，3393 字符）
<!-- PAGE 13 -->

pdf_extract(~/Downloads/<中文说明>.pdf):
pdf ok · 6页 · 1034字符 · 2表格 · 14标题 · engine=fast
handle=5072f85cb096

pdf_extract(fixtures/samples/scan-8p.pdf):
pdf suspect · 8页 · 16字符 · 0表格 · 0标题 · engine=fast
handle=5f6c72428de7
- 没有任何文本（只有空白）：疑似扫描件或图片版文档，当前引擎没有文本层
```

### 第 3 轮：inline 正文是否真的完整到达模型

问模型"那份补丁说明正文里最后一行是什么"，模型答：

```
## 6. 补丁程序显示成功安装后就可以开始游戏了
```

直接跑 CLI 取同一文件尾部，逐字一致。说明 ≤6000 字符的正文**完整**进入了上下文，没有被 dsh 的 `tool-result-pruner` 截断（这是 `inlineLimit` 硬顶 8192 的设计目的）。

## 2026-11-11 hybrid 真机验收（已补）

环境：`pip install --user "opendataloader-pdf[hybrid]"`（2.5.21，106 个包，含 torch 2.15.0 / docling 2.150.0）；
后端 `opendataloader-pdf-hybrid.exe --port 5002`。首次启动下载模型 52s（layout-heron + docling-models，缓存在 `~/.cache/huggingface`），
启动后常驻内存 **1296 MB**，验证完毕已终止进程、端口已释放。

| 样本 | fast | hybrid |
| --- | --- | --- |
| 中文说明 6 页 | **474ms**，1034 字符，2 表格，14 标题 | 49 600–58 800ms（8–10s/页），1392 字符，2 表格，11 标题 |
| 扫描件 8 页（无文本层） | 278ms，16 字符 → 判 suspect | 108 500ms，**57 字符乱码**（`5} ,` 反复），无表格 |

### 结论

1. **hybrid 在本机 CPU 上慢约 100 倍**（8–10s/页 vs 0.5s/页），上游 README 的 0.463s/页 在本机不成立。
2. **质量不是单调更好**：同一份中文说明，hybrid 多提取 358 字符，但把图片区域的数字识别成了 `| |1022|` 这种伪表格，标题层级也从 14 降到 11。
3. ~~hybrid 不能救扫描件~~ —— **这条结论是错的，已推翻**，见下节。
4. 因此"hybrid 优先级最高、开着就用它"这个默认是错的 —— 实测下它会让每次调用慢两个数量级，且不保证质量提升。

### 顺带修掉的 bug

hybrid 的 `convert()` 没有把相对路径绝对化（fast 引擎阶段 1 修过同类问题），真机第一次跑扫描件报
`File or folder 'scan-8p.pdf' not found`。已修，并复用 fast 的绝对化逻辑。

### 仍待决定

hybrid 的默认定位（见对话中的建议：移出自动选择链，改为 `pdf_extract` 的显式 `engine` 参数）。

| 阶段 7 接入 `web` profile | 需要改用户日常 profile 并重启 GUI，按计划需单独确认。 |
| 真实扫描件（倾斜/阴影） | 现有扫描样本是 Pillow 生成的清洁图像页。 |

## 2026-11-11 hybrid OCR 复验（推翻上节结论 3）

上一节说"hybrid 不能救扫描件"是错的。原因不是能力缺失，而是**后端默认 OCR 语言不含中文**。
后端 CLI 暴露了 `--force-ocr` / `--ocr-engine` / `--ocr-lang`，重跑结果：

| 配置 | 样本 | 耗时 | 结果 |
| --- | --- | --- | --- |
| 默认（easyocr，默认语言） | scan-8p | 108.5s | 57 字符乱码 |
| `--force-ocr`，默认语言 | scan-8p | 205.7s | 67 字符乱码 |
| `--force-ocr`，默认语言 | imgpage-1p | 28.9s | 2 字符（空） |
| **`--force-ocr --ocr-lang ch_sim,en`** | imgpage-1p | **25.9s** | **739 字符，cjk_ratio 0.94，中文正确识别** |

后端自己的耗时分解（1 页，来自 `--log-level info`）：

```
done status=ok dur=25.3s per_page=25.35s pages=1 ocr=24.1s layout=1.0s parse=0.0s tables=0.0s
```

即 **OCR 占 24.1s，版式检测只占 1.0s**。所以 hybrid 救扫描件的代价是 **约 25 秒/页**（8 页扫描件 ≈ 3.3 分钟），
适合"这份扫描件必须读出内容"的救场场景，不适合默认路径。

### 对插件的影响

1. `backendBinary` 只能改可执行文件，改不了参数 —— 需要 `backendArgs` 配置才能传 `--force-ocr --ocr-lang ch_sim,en`。
2. hybrid 不能作为默认引擎（慢 50–100 倍），应改为按需/救场。

## 2026-11-11 装进 desktop profile 后的实机验收

`dsh plugin --profile desktop add` 被拒（desktop 由 Electron 应用独占管理），改用宿主的 `plugin_manager`
工具 `install_bundle("link:D:/dsh/dsh-plugin-pdf-reader")`，装完**当场生效**（工具表立刻出现三个工具，无需重启）。

### 通过

```
pdf_ping   → pong · java=17 (java)
             引擎: fast:ok · fallback:ok
pdf_extract(~/Downloads/<中文说明>.pdf)
           → pdf ok · 6页 · 1034字符 · 2表格 · 14标题 · engine=fast
             正文全文进上下文（inline 路径正常工作）
pdf_extract(fixtures/samples/arxiv-2201.11903v6.pdf)
           → pdf ok · 43页 · 136800字符 · ~82080 tokens · 17表格 · 46标题 · engine=fast
             handle=b27982854e2a，正文 0 字符进上下文
```

### 抓到一个真实的互操作 bug

`pdf_read(handle=…, page=13, maxChars=600)` 返回了**第 1 页**。本地复现：

```
{ page: 13 }            → 第 13 页 ✓
{ page: "13" }          → 第 1 页 ✗（退化成"全篇 + 截断"）
```

即模型发出的 `13` 到达工具时是**字符串**，而实现只接受 `number`。按 dsh 的约定，模型边界上的值必须校验，
不能假定类型 —— 已加 `asNumber()` 强转，覆盖 `page` / `pageStart` / `pageEnd` / `maxChars` / `inlineLimit`。

修复后在新 sandbox 实例（新进程）验证：

```
pdf_read(page=13, maxChars=500) → b27982854e2a · 第 13 页（共 43 页，500 字符）
```

### 顺带修正 pdf_ping 的 render

原来 render 会把静态优先级表 `hybrid=10 fast=20 fallback=90` 一起打出来，即使 hybrid 组件被禁用也照打，
容易让模型以为它可用。改为只列真正注册的引擎，并把按需引擎标成 `(按需)`。

### 遗留

宿主进程里跑的还是修复前的 `lib/`，需要重启一次才能吃到 `asNumber` 与 render 修正。

## 2026-11-11 重启后复验 + 两处打磨

重启后确认修复生效：

```
pdf_ping  → pong · java=17 (java) / 引擎: fast:ok · fallback:ok   （静态优先级表已去掉）
pdf_read(handle=b27982854e2a, page=13, maxChars=400)
          → b27982854e2a · 第 13 页（共 43 页，400 字符）          （字符串页码已被强转）
pdf_extract(scan-8p.pdf) → pdf suspect · 8页 · 16字符
```

### 打磨 1：`pdf_read` 加 `offset`，让单页截断可续读

原来单页比 `maxChars` 长时，模型只能重复调用 `pdf_read(page=13)`，每次都拿到同样的开头 —— 死循环。
现在返回 `next_offset`，并在 render 里写明 `用 offset=N 续读`：

```
第一段（offset 0, maxChars 200）: "...ashkin, Vitaly Nikolaev, Matthew Lamm, M"  next_offset=200
续读段（offset 200）           : "ichael Collins, Dipanjan Das, Slav Petrov, ..."
```

### 打磨 2：零文本扫描件不再把页标记当正文

扫描件 16 个字符全是 `<!-- PAGE n -->` 标记，进上下文纯属浪费。现在 `nonspace_chars === 0` 时不返回 content。

测试 103/103。

## 2026-11-12 代码审查后的修复（第一批：C1–C3 + I5 + I9）

独立评审（`deepseek-flash` / max）在 4 轮审查 + 2 个运行时复现后给出 3 Critical / 9 Important / 18 Minor。
第一批修完 C1–C3 与两项守卫：

| 编号 | 问题 | 修法 | 证据 |
| --- | --- | --- | --- |
| C1 | `pdf_read` 按数组下标重建页号，`--pages 5-8` 的结果读第 1 页会被标成 `PAGE 1` | `splitPagesWithNumbers` 从标记里读原始页码；meta 增 `pageNumbers`；越界改为报错而非静默夹取 | `pages='5-8'` → `pdf_read(page=5)` 返回 `PAGE 5`；`page=1` 报"可用 5–8" |
| C2 | 缓存命中在读 `engine` 参数之前，`engine='hybrid'` 会命中 fast 的旧条目 | `lookupFile` 增加引擎过滤；显式引擎先解析再查缓存 | 单测：fast 缓存存在时 `engine='hybrid'` 确实调用 hybrid |
| C3 | inline 判定用剥离页标记后的字符数，交付却含标记 | `spillOrInline` 改用 `bodyChars`；单次 `inlineLimit` 也加硬顶校验 | 150 页稀疏文档（剥离 5700 字符）判 spilled |
| I5 | `handle` 未校验即拼路径，可 `../..` 穿越 | 限定 12 位十六进制 | 单测：`../../etc/passwd` 与大小写变体均被拒 |
| I9 | 测试 import `lib/`，`npm test` 不构建，src 改动仍全绿 | `pretest: npm run build` | 现在测试跑的是刚构建的产物 |

测试从 104 增至 109。
