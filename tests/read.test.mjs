import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheKey, createReadTool, writeEntry } from '../lib/index.js'

const page = (n, text) => `<!-- PAGE ${n} -->\n${text}`
const params = { separator: '<!-- PAGE %page-number% -->' }

async function seed(pages) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'pdfread-'))
  const body = pages.map((text, index) => page(index + 1, text)).join('\n')
  const handle = cacheKey('a'.repeat(64), 'fast', '2.5.20', params)
  await writeEntry(cacheDir, {
    handle,
    body,
    meta: {
      handle,
      engine: 'fast',
      engineVersion: '2.5.20',
      degraded: false,
      params,
      pages: pages.length,
      chars: body.length,
      cachedAt: '2026-11-11T00:00:00.000Z',
      fileSha256: 'a'.repeat(64),
      sourcePath: 'D:/x.pdf',
      sourceSize: 1,
      sourceMtimeMs: 1,
      stats: { chars: body.length },
      verdict: 'ok',
    },
  })
  const tool = createReadTool({ config: { cacheDir } })
  return { tool, handle, cacheDir }
}

const signal = () => ({ signal: new AbortController().signal })

test('按单页读取只给那一页', async () => {
  const { tool, handle } = await seed(['第一页内容', '第二页内容', '第三页内容'])
  const value = await tool.execute({ handle, page: 2 }, signal())
  assert.equal(value.from_page, 2)
  assert.equal(value.to_page, 2)
  assert.match(value.content, /第二页内容/)
  assert.ok(!value.content.includes('第一页内容'))
  assert.equal(value.truncated, false)
})

test('按区间读取拼接多页', async () => {
  const { tool, handle } = await seed(['A', 'B', 'C', 'D'])
  const value = await tool.execute({ handle, pageStart: 2, pageEnd: 3 }, signal())
  assert.match(value.content, /B/)
  assert.match(value.content, /C/)
  assert.ok(!value.content.includes('A\n'))
  assert.equal(value.from_page, 2)
  assert.equal(value.to_page, 3)
})

test('超 maxChars 截断并告诉模型怎么续读', async () => {
  const { tool, handle } = await seed(['x'.repeat(3000), 'y'.repeat(3000), 'z'.repeat(3000)])
  const value = await tool.execute({ handle, maxChars: 4000 }, signal())
  assert.equal(value.truncated, true)
  assert.ok(value.content.length <= 4000)
  assert.ok(value.next_offset !== undefined)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /已截断/)
  assert.match(text, /offset=/)
})

test('单页比 maxChars 长时给 next_offset，续读能拿到下一段', async () => {
  const { tool, handle } = await seed(['A'.repeat(500), 'B'.repeat(500)])
  const first = await tool.execute({ handle, page: 1, maxChars: 100 }, signal())
  assert.equal(first.truncated, true)
  assert.equal(first.next_offset, 100)
  const second = await tool.execute({ handle, page: 1, maxChars: 100, offset: first.next_offset }, signal())
  assert.notEqual(second.content, first.content)
  assert.ok(second.content.startsWith('A'.repeat(10)))
  const text = tool.output.render({}, first)[0].text
  assert.match(text, /offset=100/)
})

test('handle 不存在时报错并给出最近可用的 handle', async () => {
  const { tool, handle } = await seed(['x'])
  await assert.rejects(tool.execute({ handle: 'ffffffffffff' }, signal()), new RegExp(handle))
})

test('页号越界时报错，不静默夹取', async () => {
  const { tool, handle } = await seed(['A', 'B'])
  await assert.rejects(tool.execute({ handle, page: 99 }, signal()), /不在已提取的页范围内/)
  await assert.rejects(tool.execute({ handle, page: 0 }, signal()), /不在已提取的页范围内/)
})

test('页码按分隔符里的原始页号映射，不按数组下标', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'pdfread-'))
  // 模拟 --pages 5-8 的提取结果：正文里只有第 5–8 页
  const body = [[5, 'FIVE'], [6, 'SIX'], [7, 'SEVEN'], [8, 'EIGHT']]
    .map(([n, t]) => `<!-- PAGE ${n} -->\n${t}`)
    .join('\n')
  const handle = cacheKey('b'.repeat(64), 'fast', '2.5.20', params)
  await writeEntry(cacheDir, {
    handle,
    body,
    meta: {
      handle, engine: 'fast', engineVersion: '2.5.20', degraded: false, params,
      pages: 4, chars: body.length, bodyChars: body.length, pageNumbers: [5, 6, 7, 8],
      cachedAt: '2026-11-12T00:00:00.000Z', fileSha256: 'b'.repeat(64),
      sourcePath: 'D:/x.pdf', sourceSize: 1, sourceMtimeMs: 1, stats: { chars: body.length }, verdict: 'ok',
    },
  })
  const tool = createReadTool({ config: { cacheDir } })
  const five = await tool.execute({ handle, page: 5 }, signal())
  assert.match(five.content, /FIVE/)
  assert.ok(five.content.includes('<!-- PAGE 5 -->'), '标记应保留原始页码')
  assert.equal(five.from_page, 5)
  await assert.rejects(tool.execute({ handle, page: 1 }, signal()), /第 1 页不在已提取的页范围内|不在已提取的页范围内/)
})

test('handle 不是 12 位十六进制时拒绝（防目录穿越）', async () => {
  const { tool } = await seed(['A'])
  await assert.rejects(tool.execute({ handle: '../../etc/passwd' }, signal()), /格式不对/)
  await assert.rejects(tool.execute({ handle: 'ABCDEF123456' }, signal()), /格式不对/)
})

test('区间反向时自动纠正', async () => {
  const { tool, handle } = await seed(['A', 'B', 'C'])
  const value = await tool.execute({ handle, pageStart: 3, pageEnd: 2 }, signal())
  assert.equal(value.from_page, 2)
  assert.equal(value.to_page, 3)
})

test('render 头部带 handle 与页范围', async () => {
  const { tool, handle } = await seed(['A', 'B'])
  const value = await tool.execute({ handle, page: 1 }, signal())
  const text = tool.output.render({}, value)[0].text
  assert.match(text, new RegExp(handle))
  assert.match(text, /第 1 页（共 2 页/)
})
