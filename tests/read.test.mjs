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

test('超 maxChars 截断并标注剩余页范围', async () => {
  const { tool, handle } = await seed(['x'.repeat(3000), 'y'.repeat(3000), 'z'.repeat(3000)])
  const value = await tool.execute({ handle, maxChars: 4000 }, signal())
  assert.equal(value.truncated, true)
  assert.ok(value.content.length <= 4000)
  // 从第 2 页中间切开：剩余范围必须包含第 2 页的后半截
  assert.equal(value.remaining_from, 2)
  assert.equal(value.remaining_to, 3)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /已截断/)
  assert.match(text, /剩余第/)
})

test('handle 不存在时报错并给出最近可用的 handle', async () => {
  const { tool, handle } = await seed(['x'])
  await assert.rejects(tool.execute({ handle: 'ffffffffffff' }, signal()), new RegExp(handle))
})

test('页号越界时夹到合法范围', async () => {
  const { tool, handle } = await seed(['A', 'B'])
  const high = await tool.execute({ handle, page: 99 }, signal())
  assert.equal(high.from_page, 2)
  const low = await tool.execute({ handle, page: 0 }, signal())
  assert.equal(low.from_page, 1)
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
