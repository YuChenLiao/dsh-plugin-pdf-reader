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

pdf_extract(Downloads/补丁安装说明.pdf):
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
3. **hybrid 不能救扫描件**：我的噪点扫描件经 docling-fast 后只有 57 字符乱码，说明该模式不启用 OCR 或 OCR 未生效。
4. 因此"hybrid 优先级最高、开着就用它"这个默认是错的 —— 实测下它会让每次调用慢两个数量级，且不保证质量提升。

### 顺带修掉的 bug

hybrid 的 `convert()` 没有把相对路径绝对化（fast 引擎阶段 1 修过同类问题），真机第一次跑扫描件报
`File or folder 'scan-8p.pdf' not found`。已修，并复用 fast 的绝对化逻辑。

### 仍待决定

hybrid 的默认定位（见对话中的建议：移出自动选择链，改为 `pdf_extract` 的显式 `engine` 参数）。

| 阶段 7 接入 `web` profile | 需要改用户日常 profile 并重启 GUI，按计划需单独确认。 |
| 真实扫描件（倾斜/阴影） | 现有扫描样本是 Pillow 生成的清洁图像页。 |
