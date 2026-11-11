import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFallbackEngine, pageMarker, parsePageRange, resolveFallbackConfig } from '../lib/fallback.js'

function fakeLibrary(pages) {
  const destroyed = []
  return {
    destroyed,
    lib: {
      async loadDocument() {
        let index = 0
        return {
          getPageCount: () => pages.length,
          getPage: () => ({ getText: async () => pages[index++] ?? '' }),
          destroy: () => destroyed.push(true),
        }
      },
    },
  }
}

async function pdfFile() {
  const dir = await mkdtemp(join(tmpdir(), 'pdffallback-'))
  const file = join(dir, 'doc.pdf')
  await writeFile(file, '%PDF-1.4 fake')
  return file
}

test('parsePageRange 解析逗号与区间并夹取越界', () => {
  assert.deepEqual([...parsePageRange('1,3,5-7', 10)], [1, 3, 5, 6, 7])
  assert.deepEqual([...parsePageRange('8-99', 10)], [8, 9, 10])
  assert.deepEqual([...parsePageRange('abc', 10)], [])
})

test('pageMarker 生成与上游一致的标记', () => {
  assert.equal(pageMarker(7), '<!-- PAGE 7 -->')
})

test('convert 逐页取文本并拼页标记，标记为降级', async () => {
  const file = await pdfFile()
  const { lib, destroyed } = fakeLibrary(['第一页', '第二页', '第三页'])
  const engine = createFallbackEngine(resolveFallbackConfig({}), { libOf: async () => lib, versionOf: () => '3.0.0' })
  const result = await engine.convert({ absPath: file, signal: new AbortController().signal })
  assert.equal(result.engine, 'fallback')
  assert.equal(result.engineVersion, '3.0.0')
  assert.equal(result.degraded, true)
  assert.match(result.markdown, /<!-- PAGE 1 -->\n第一页/)
  assert.match(result.markdown, /<!-- PAGE 3 -->\n第三页/)
  assert.equal(destroyed.length, 1, '文档必须被销毁')
})

test('pages 只取指定页，页码保持原文页码', async () => {
  const file = await pdfFile()
  const { lib } = fakeLibrary(['A', 'B', 'C', 'D'])
  const engine = createFallbackEngine(resolveFallbackConfig({}), { libOf: async () => lib, versionOf: () => '3.0.0' })
  const result = await engine.convert({ absPath: file, pages: '2-3', signal: new AbortController().signal })
  assert.ok(result.markdown.includes('<!-- PAGE 2 -->'))
  assert.ok(result.markdown.includes('<!-- PAGE 3 -->'))
  assert.ok(!result.markdown.includes('<!-- PAGE 1 -->'))
})

test('已取消的信号立即判 aborted', async () => {
  const file = await pdfFile()
  const { lib } = fakeLibrary(['A'])
  const engine = createFallbackEngine(resolveFallbackConfig({}), { libOf: async () => lib, versionOf: () => '3.0.0' })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(engine.convert({ absPath: file, signal: controller.signal }), (error) => {
    assert.equal(error.kind, 'aborted')
    return true
  })
})

test('未安装 pdfium 时 available 关闭，convert 报 unavailable', async () => {
  const engine = createFallbackEngine(resolveFallbackConfig({}), { versionOf: () => null })
  const availability = await engine.available()
  assert.equal(availability.ok, false)
  assert.match(availability.reason, /@hyzyla\/pdfium/)
  await assert.rejects(engine.convert({ absPath: 'x.pdf', signal: new AbortController().signal }), (error) => {
    assert.equal(error.kind, 'unavailable')
    return true
  })
})

test('组件关闭时 available 给出关闭原因', async () => {
  const engine = createFallbackEngine(resolveFallbackConfig({ enabled: false }), { versionOf: () => '3.0.0' })
  const availability = await engine.available()
  assert.equal(availability.ok, false)
  assert.match(availability.reason, /enabled/)
})

test('文件读取失败归类为 missing-file', async () => {
  const engine = createFallbackEngine(resolveFallbackConfig({}), { libOf: async () => fakeLibrary(['A']).lib, versionOf: () => '3.0.0' })
  await assert.rejects(engine.convert({ absPath: 'D:/nope/missing.pdf', signal: new AbortController().signal }), (error) => {
    assert.equal(error.kind, 'missing-file')
    return true
  })
})
