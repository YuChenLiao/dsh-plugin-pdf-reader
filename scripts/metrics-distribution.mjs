/**
 * 阶段 2 的指标分布采集：把样本目录与本地真实 PDF 全部跑一遍 fast 引擎，
 * 输出 docs/metrics-distribution.md 供阈值校准。verdict 恒为 unknown。
 */
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createFastEngine, resolveFastConfig } from '../lib/fast.js'
import { computeMetrics } from '../lib/index.js'
import { sha256File } from '../lib/index.js'

const SAMPLE_DIR = 'fixtures/samples'
// 本地真实样本走环境变量，仓库里不放任何个人路径与文件名：
//   PDF_SAMPLES="/path/a.pdf;/path/b.pdf" node scripts/metrics-distribution.mjs
const LOCAL = (process.env.PDF_SAMPLES ?? '')
  .split(';')
  .map((item) => item.trim())
  .filter((item) => item !== '')

function classify(path) {
  const name = path.replace(/\\/g, '/').split('/').pop()
  if (name.startsWith('scan-')) return '图像页（噪点扫描件）'
  if (name.startsWith('imgpage-')) return '图像页（Pillow 生成）'
  if (name.startsWith('arxiv-')) return '英文论文（双栏）'
  return '本地真实文档（中文）'
}

const localFiles = LOCAL.filter((path) => existsSync(path))
const downloaded = (await readdir(SAMPLE_DIR).catch(() => []))
  .filter((name) => name.endsWith('.pdf'))
  .map((name) => join(SAMPLE_DIR, name))

const seen = new Map()
for (const path of [...localFiles, ...downloaded]) {
  const sha = await sha256File(path)
  if (!seen.has(sha)) seen.set(sha, path)
}
const files = [...seen.values()]
// 本地样本的真实文件名可能含个人信息，表格里一律用序号代替
const displayName = (path) => {
  const base = path.split(/[\\/]/).pop()
  const index = localFiles.indexOf(path)
  return index >= 0 ? `local-${index + 1}.pdf` : base
}

const ctx = { tools: { register: () => () => {} }, get: () => undefined }
const engine = createFastEngine(ctx, resolveFastConfig({ enabled: true }))
const availability = await engine.available()
if (!availability.ok) {
  console.error('fast 引擎不可用：', availability.reason)
  process.exit(1)
}

const rows = []
for (const path of files) {
  const started = performance.now()
  try {
    const result = await engine.convert({ absPath: path, signal: new AbortController().signal })
    const metrics = computeMetrics(result.markdown)
    const ms = Math.round(performance.now() - started)
    rows.push({ path: displayName(path), klass: classify(path), ms, metrics })
    console.log(`${metrics.pages}页 ${metrics.chars}字符 ${ms}ms  ${displayName(path)}`)
  } catch (error) {
    rows.push({ path: displayName(path), klass: classify(path), error: `${error.kind ?? 'error'}: ${error.message.slice(0, 80)}` })
    console.log(`失败 ${displayName(path)}: ${error.message.slice(0, 80)}`)
  }
}

const ok = rows.filter((row) => row.metrics !== undefined)
const metricKeys = [
  'chars', 'pages', 'replacement_ratio', 'control_ratio', 'private_use_ratio', 'cjk_ratio',
  'question_run_max', 'avg_chars_per_line', 'single_char_line_ratio', 'line_end_punct_ratio',
  'page_char_variance', 'empty_pages', 'empty_page_ratio', 'last_page_ratio', 'tables', 'headings',
]

const quantile = (values, q) => {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  return sorted[base + 1] === undefined ? sorted[base] : sorted[base] + rest * (sorted[base + 1] - sorted[base])
}

const classes = [...new Set(ok.map((row) => row.klass))]
const lines = []
lines.push('# 指标分布（阶段 2 校准用）')
lines.push('')
lines.push(`样本 ${files.length} 份（去重后），成功 ${ok.length} 份。verdict 恒为 unknown，本表只记录原始指标。`)
lines.push('')
lines.push('## 按类别的分位')
lines.push('')
lines.push('| 类别 | 指标 | min | p25 | 中位 | p75 | max |')
lines.push('| --- | --- | --- | --- | --- | --- | --- |')
for (const klass of classes) {
  const subset = ok.filter((row) => row.klass === klass)
  for (const key of metricKeys) {
    const values = subset.map((row) => row.metrics[key])
    lines.push(`| ${klass} | ${key} | ${fmt(Math.min(...values))} | ${fmt(quantile(values, 0.25))} | ${fmt(quantile(values, 0.5))} | ${fmt(quantile(values, 0.75))} | ${fmt(Math.max(...values))} |`)
  }
}
lines.push('')
lines.push('## 逐份明细')
lines.push('')
lines.push('| 文件 | 类别 | 页 | 字符 | cjk | 替换 | 空页 | 末页比 | 表 | 标题 | 单字行 | 行均长 | image_only_hint | 耗时 |')
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const row of rows) {
  if (row.metrics === undefined) {
    lines.push(`| ${row.path} | ${row.klass} | — | — | — | — | — | — | — | — | — | — | 失败：${row.error} | — |`)
    continue
  }
  const m = row.metrics
  lines.push(`| ${row.path} | ${row.klass} | ${m.pages} | ${m.chars} | ${fmt(m.cjk_ratio)} | ${fmt(m.replacement_ratio)} | ${m.empty_pages} | ${fmt(m.last_page_ratio)} | ${m.tables} | ${m.headings} | ${fmt(m.single_char_line_ratio)} | ${fmt(m.avg_chars_per_line)} | ${m.image_only_hint} | ${row.ms}ms |`)
}
await writeFile('docs/metrics-distribution.md', `${lines.join('\n')}\n`, 'utf8')
console.log(`\n写入 docs/metrics-distribution.md（${ok.length}/${files.length} 成功）`)

function fmt(value) {
  if (!Number.isFinite(value)) return '—'
  return Math.abs(value) >= 100 ? String(Math.round(value)) : String(Math.round(value * 10000) / 10000)
}
