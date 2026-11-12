import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMetrics, estimateTokens, splitPages } from '../lib/index.js'

// 转换后的真实分隔符：模板里的 %page-number% 已被替换为页码
const page = (n, text) => `<!-- PAGE ${n} -->\n${text}`

test('按页分隔符切页，分隔符本身不进正文', () => {
  const pages = splitPages(`${page(1, '第一页正文')}\n${page(2, '第二页正文')}`)
  assert.equal(pages.length, 2)
  assert.match(pages[0], /第一页/)
  assert.ok(!pages[0].includes('<!-- PAGE'))
})

test('替换字符与私用区字符计数', () => {
  const metrics = computeMetrics('正常文本\uFFFD\uFFFD\uE001')
  assert.ok(metrics.replacement_ratio > 0)
  assert.ok(metrics.private_use_ratio > 0)
})

test('CJK 占比：纯中文接近 1，纯英文为 0', () => {
  assert.ok(computeMetrics('这是一段中文正文用来测试占比').cjk_ratio > 0.9)
  assert.equal(computeMetrics('pure english text here.').cjk_ratio, 0)
})

test('空页与末页比例', () => {
  const markdown = [page(1, '正文'.repeat(200)), page(2, '短'), page(3, '')].join('\n')
  const metrics = computeMetrics(markdown)
  assert.equal(metrics.pages, 3)
  assert.equal(metrics.empty_pages, 2)
  assert.ok(metrics.empty_page_ratio > 0.2)
  assert.equal(metrics.image_only_hint, true)
  assert.ok(metrics.last_page_ratio < 0.1)
})

test('标题与表格计数', () => {
  const markdown = [
    '# 一级标题',
    '## 二级标题',
    '正文',
    '| a | b |',
    '| 1 | 2 |',
    '正文',
    '| c | d |',
  ].join('\n')
  const metrics = computeMetrics(markdown)
  assert.equal(metrics.headings, 2)
  assert.equal(metrics.tables, 2)
})

test('单字符行与问号连串', () => {
  const markdown = ['啊', '哦', '这是正常的一行正文', '?????'].join('\n')
  const metrics = computeMetrics(markdown)
  assert.ok(metrics.single_char_line_ratio > 0.4)
  assert.equal(metrics.question_run_max, 5)
})

test('页字符数变异系数：等长页为 0', () => {
  const pageText = 'x'.repeat(100)
  const metrics = computeMetrics([page(1, pageText), page(2, pageText)].join('\n'))
  assert.equal(metrics.page_char_variance, 0)
})

test('estimateTokens 按脚本占比估算：中文 0.6、其余 0.25', () => {
  // 10 个汉字 → 6；10 个 ASCII → 2.5 → 3
  assert.equal(estimateTokens('一二三四五六七八九十'), 6)
  assert.equal(estimateTokens('abcdefghij'), 3)
  // 混排：5 汉字 + 4 ASCII → 3 + 1 = 4
  assert.equal(estimateTokens('一二三四五abcd'), 4)
})
