# dsh-plugin-pdf-reader

给 DeepSeek Harness 的 PDF 专用工具：一次调用完成"转换 + 质量量化 + 三档判定"，正文按页读取，不再每次现场写脚本。

## 形态

工具层 + 三个可独立开关的引擎组件：

| 组件 | 装载名 | 引擎 | 默认 |
| --- | --- | --- | --- |
| 工具层 | `dsh-plugin-pdf-reader` | 注册工具、提供 `ctx.pdfEngines` | 开 |
| fast | `dsh-plugin-pdf-reader/fast` | OpenDataLoader（JVM）+ `--to-stdout` | 开（运行时探测 Java 17+） |
| hybrid | `dsh-plugin-pdf-reader/hybrid` | docling 后端 | **关**（开启需同意模型下载） |
| fallback | `dsh-plugin-pdf-reader/fallback` | pdfium WASM | 开（阶段 5 接入） |

选择链按 priority 升序取第一个可用引擎：`hybrid(10) → fast(20) → fallback(90)`。

## 工具

| 工具 | 状态 | 说明 |
| --- | --- | --- |
| `pdf_ping` | 已实现 | 环境体检：Java 版本、各引擎可用性与原因 |
| `pdf_extract` | 已实现 | 转换 + 指标 + 三档判定；小文件返正文，大文件返判定块 |
| `pdf_read` | 已实现 | 按句柄 + 页范围读缓存正文，不重新转换 |

## 配置

工具层（`config:` 下）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `inlineLimit` | `6000` | 入上下文字符上限。**硬顶 8192** —— 超过会被 dsh 的 `tool-result-pruner` 截成"头 4096 + 尾 1024"，中间正文静默消失 |
| `judgeEnabled` | `true` | 关闭后退回"只记录指标、不判定" |
| `cacheDir` | `~/.dsh/pdf-cache` | 转换结果与指标落盘位置 |
| `javaBinary` | `java` | fast 引擎用的可执行文件 |

hybrid 组件开启时若 `acceptModelDownload` 不为 `true`，**装载期报错**并说明需要下载模型、启动后端；同意后把它设为 `true`。

## 开发

```sh
npm install
npm run build      # esbuild → lib/{index,fast,hybrid,fallback}.js
npm test           # node --test
npx tsc --noEmit   # 类型检查
```

装进测试 profile：

```sh
dsh plugin --profile memtest add D:/dsh/dsh-plugin-pdf-reader
dsh --profile memtest --dump-config | grep pdf-reader   # 确认四条装载行
```

`lib/` 是构建产物且不进 `.gitignore`：profile 以 `link:` 引用本包，`main` 指向 `lib/`。

## 阶段状态

- [x] 阶段 0 骨架：工具层、引擎注册表、`pdf_ping`
- [x] 阶段 1 转换（fast）：`ctx.subprocess` + `--to-stdout`，abort 后整树退出
- [x] 阶段 2 指标与分布（25 份样本，见 `docs/metrics-distribution.md`）
- [x] 阶段 3 判定与分流（阈值来自 25 份样本分布）
- [x] 阶段 4 `pdf_read`（按页/区间读缓存，超 maxChars 截断并标注剩余页）
- [ ] 阶段 5 fallback 引擎
- [ ] 阶段 6 hybrid 引擎
- [ ] 阶段 7 接入日常会话的 `web` profile

设计与计划见 `docs/design.md`、`docs/plan.md`。
