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

## 未验证项

| 项 | 原因 |
| --- | --- |
| hybrid 真机转换 | 需要 `pip install "opendataloader-pdf[hybrid]"`：106 个包、含 torch 2.15.0 / docling 2.150.0 / transformers 5.22.2，磁盘 1–2 GB，首次还要下模型。代码与单测已完备，等明确同意再装。 |
| 阶段 7 接入 `web` profile | 需要改用户日常 profile 并重启 GUI，按计划需单独确认。 |
| 真实扫描件（倾斜/阴影） | 现有扫描样本是 Pillow 生成的清洁图像页。 |
