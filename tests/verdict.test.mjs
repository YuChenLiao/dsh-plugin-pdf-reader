import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMetrics, judge } from '../lib/index.js'

const page = (n, text) => `<!-- PAGE ${n} -->\n${text}`

// 一份健康的英文双栏论文：行长正常、无空页、末页不为空
const healthy = computeMetrics([
  page(1, '# Attention Is All You Need\n\nWe propose a new simple network architecture. '.repeat(20)),
  page(2, 'The encoder is composed of a stack of six identical layers. '.repeat(20)),
  page(3, 'References\n\nVaswani et al. 2017. Attention is all you need. '.repeat(10)),
].join('\n'))

test('健康文档判 ok 且满分', () => {
  const result = judge(healthy, 'fast', true)
  assert.equal(result.verdict, 'ok')
  assert.equal(result.score, 100)
  assert.deepEqual(result.issues, [])
})

test('judgeEnabled false 时恒为 unknown（阶段 2 行为）', () => {
  assert.equal(judge(healthy, 'fast', false).verdict, 'unknown')
})

test('没有任何文本判 suspect 并指向扫描件', () => {
  const result = judge(computeMetrics(page(1, '')), 'fast', true)
  assert.equal(result.verdict, 'suspect')
  assert.equal(result.score, 10)
  assert.match(result.issues[0], /疑似扫描件/)
})

test('替换字符超阈值判 failed', () => {
  const metrics = { ...healthy, replacement_ratio: 0.01 }
  const result = judge(metrics, 'fast', true)
  assert.equal(result.verdict, 'failed')
  assert.match(result.issues[0], /replacement_ratio/)
})

test('控制字符超阈值判 failed', () => {
  const result = judge({ ...healthy, control_ratio: 0.05 }, 'fast', true)
  assert.equal(result.verdict, 'failed')
  assert.match(result.issues[0], /control_ratio/)
})

test('扫描件：空页占比高判 suspect 并指出疑似扫描件', () => {
  const scanned = computeMetrics([page(1, ''), page(2, ''), page(3, '')].join('\n'))
  const result = judge(scanned, 'fast', true)
  assert.equal(result.verdict, 'suspect')
  assert.match(result.issues[0], /疑似扫描件/)

  const sparse = computeMetrics([page(1, 'x'.repeat(300)), page(2, ''), page(3, ''), page(4, '')].join('\n'))
  const sparseResult = judge(sparse, 'fast', true)
  assert.equal(sparseResult.verdict, 'suspect')
  assert.ok(sparseResult.issues.some((issue) => /疑似扫描件/.test(issue)))
  assert.ok(sparseResult.score < 100)
})

test('中文占比过低且首部是中文 → 判编码异常', () => {
  const broken = computeMetrics([page(1, `${'中文正文内容'.repeat(50)}\n${'abc '.repeat(2000)}`)].join('\n'))
  assert.ok(broken.head_cjk_ratio >= 0.05)
  assert.ok(broken.cjk_ratio < 0.25)
  const result = judge(broken, 'fast', true)
  assert.equal(result.verdict, 'suspect')
  assert.ok(result.issues.some((issue) => /编码错/.test(issue)))
})

test('纯英文文档不触发中文编码判定', () => {
  const result = judge(healthy, 'fast', true)
  assert.ok(!result.issues.some((issue) => /编码错/.test(issue)))
})

test('末页过短只在每页字符数够多时才判截断', () => {
  const manyPages = Array.from({ length: 10 }, (_, index) => page(index + 1, '正文'.repeat(300))).join('\n')
  const truncated = computeMetrics(`${manyPages}\n${page(11, '尾')}`)
  const result = judge(truncated, 'fast', true)
  assert.ok(result.issues.some((issue) => /疑似截断/.test(issue)))

  const sparsePages = computeMetrics([page(1, '短正文'), page(2, ''), page(3, '')].join('\n'))
  const sparseResult = judge(sparsePages, 'fast', true)
  assert.ok(!sparseResult.issues.some((issue) => /疑似截断/.test(issue)))
})

test('fallback 引擎永不判 suspect', () => {
  const fragmented = computeMetrics([page(1, 'a\nb\nc\nd\ne\nf'), page(2, ''), page(3, '')].join('\n'))
  const fast = judge(fragmented, 'fast', true)
  const fallback = judge(fragmented, 'fallback', true)
  assert.notEqual(fast.verdict, 'ok')
  assert.equal(fallback.verdict, 'ok')
  assert.equal(fallback.score, 60)
  assert.deepEqual(fallback.issues, [])
})

test('多项命中时分数按权重累减，且不低于 0', () => {
  const metrics = { ...healthy, single_char_line_ratio: 0.5, avg_chars_per_line: 2, empty_page_ratio: 0.5, empty_pages: 3 }
  const result = judge(metrics, 'fast', true)
  assert.equal(result.verdict, 'suspect')
  assert.ok(result.score <= 100 - 15 - 20 - 30)
  assert.ok(result.score >= 0)
})
