import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngineRegistry, createExtractTool } from '../lib/index.js'

const page = (n, text) => `<!-- PAGE ${n} -->\n${text}`

async function fixture(markdown) {
  const dir = await mkdtemp(join(tmpdir(), 'pdfextract-'))
  const file = join(dir, 'doc.pdf')
  await writeFile(file, '%PDF-1.4 fake')
  let convertCalls = 0
  let availableCalls = 0
  const registry = createEngineRegistry()
  registry.register({
    name: 'fast',
    priority: 20,
    version: '2.5.20',
    async available() {
      availableCalls += 1
      return { ok: true }
    },
    async convert() {
      convertCalls += 1
      return { markdown, engine: 'fast', engineVersion: '2.5.20', degraded: false }
    },
  })
  const config = { enabled: true, inlineLimit: 6000, cacheDir: dir, judgeEnabled: false, javaBinary: 'java' }
  const tool = createExtractTool({ ctx: { tools: { register: () => () => {} } }, registry, config })
  return {
    tool,
    file,
    stats: () => ({ convertCalls, availableCalls }),
  }
}

const signal = () => ({ signal: new AbortController().signal })

test('小文件走 inline 并返回正文', async () => {
  const { tool, file } = await fixture(page(1, '这是一份八页以内的短文档。'))
  const value = await tool.execute({ path: file }, signal())
  assert.equal(value.mode, 'inline')
  assert.match(value.content, /短文档/)
  assert.equal(value.verdict, 'unknown')
  assert.equal(value.engine, 'fast')
  assert.equal(value.degraded, false)
  assert.equal(value.handle.length, 12)
})

test('大文件走 spilled，不返回正文，带 tokens_est 与 stats', async () => {
  const { tool, file } = await fixture(page(1, '长'.repeat(7000)))
  const value = await tool.execute({ path: file }, signal())
  assert.equal(value.mode, 'spilled')
  assert.equal(value.content, undefined)
  assert.ok(value.tokens_est > 3000)
  assert.equal(typeof value.stats.cjk_ratio, 'number')
})

test('第二次调用命中缓存：不再探测引擎、不再转换', async () => {
  const { tool, file, stats } = await fixture(page(1, '缓存命中测试正文。'))
  await tool.execute({ path: file }, signal())
  const before = stats()
  await tool.execute({ path: file }, signal())
  const after = stats()
  assert.equal(after.convertCalls, before.convertCalls, '第二次不应再转换')
  assert.equal(after.availableCalls, before.availableCalls, '第二次不应再探测引擎')
  assert.equal(after.convertCalls, 1)
})

test('force 跳过缓存重新转换', async () => {
  const { tool, file, stats } = await fixture(page(1, '强制重转。'))
  await tool.execute({ path: file }, signal())
  await tool.execute({ path: file, force: true }, signal())
  assert.equal(stats().convertCalls, 2)
})

test('inlineLimit: 0 时总是落盘', async () => {
  const { tool, file } = await fixture(page(1, '短文本'))
  const value = await tool.execute({ path: file, inlineLimit: 0 }, signal())
  assert.equal(value.mode, 'spilled')
  assert.equal(value.content, undefined)
})

test('inlineLimit 边界：等于上限走 inline，超一个字符走 spilled', async () => {
  const { tool, file } = await fixture(page(1, 'x'.repeat(99)))
  const atLimit = await tool.execute({ path: file, inlineLimit: 100 }, signal())
  assert.equal(atLimit.mode, 'inline')
  const over = await tool.execute({ path: file, inlineLimit: 98, force: true }, signal())
  assert.equal(over.mode, 'spilled')
})

test('pages 参与 handle：同文件不同页范围是两个 handle', async () => {
  const { tool, file } = await fixture(page(1, 'x'.repeat(50)))
  const all = await tool.execute({ path: file }, signal())
  const partial = await tool.execute({ path: file, pages: '1', force: true }, signal())
  assert.notEqual(all.handle, partial.handle)
})

test('文件不存在时给出绝对路径', async () => {
  const { tool } = await fixture(page(1, 'x'))
  await assert.rejects(tool.execute({ path: 'nope.pdf' }, signal()), /文件不存在或不是普通文件/)
})

test('render 在 inline 模式带正文，在 spilled 模式给下一步提示', async () => {
  const { tool, file } = await fixture(page(1, '短文档正文'))
  const inline = await tool.execute({ path: file }, signal())
  const blocks = tool.output.render({}, inline)
  assert.match(blocks[0].text, /pdf unknown/)
  assert.match(blocks[0].text, /短文档正文/)
  const spilled = await tool.execute({ path: file, inlineLimit: 0, force: true }, signal())
  const spilledText = tool.output.render({}, spilled)[0].text
  assert.match(spilledText, /pdf_read/)
  assert.ok(!spilledText.includes('短文档正文'))
})

async function fixtureWithHybrid(markdown) {
  const dir = await mkdtemp(join(tmpdir(), 'pdfextract2-'))
  const file = join(dir, 'doc.pdf')
  await writeFile(file, '%PDF-1.4 fake')
  const calls = []
  const registry = createEngineRegistry()
  registry.register({
    name: 'hybrid',
    priority: 10,
    version: '2.5.20',
    explicitOnly: true,
    async available() { return { ok: true } },
    async convert() { calls.push('hybrid'); return { markdown, engine: 'hybrid', engineVersion: '2.5.20', degraded: false } },
  })
  registry.register({
    name: 'fast',
    priority: 20,
    version: '2.5.20',
    async available() { return { ok: true } },
    async convert() { calls.push('fast'); return { markdown, engine: 'fast', engineVersion: '2.5.20', degraded: false } },
  })
  const config = { enabled: true, inlineLimit: 6000, cacheDir: dir, judgeEnabled: true, javaBinary: 'java' }
  const tool = createExtractTool({ ctx: { tools: { register: () => () => {} } }, registry, config })
  return { tool, file, calls }
}

test('默认 auto 跳过 hybrid，走 fast', async () => {
  const { tool, file, calls } = await fixtureWithHybrid(page(1, '正文'))
  const value = await tool.execute({ path: file }, signal())
  assert.equal(value.engine, 'fast')
  assert.deepEqual(calls, ['fast'])
})

test('显式 engine=hybrid 才走 hybrid', async () => {
  const { tool, file, calls } = await fixtureWithHybrid(page(1, '正文'))
  const value = await tool.execute({ path: file, engine: 'hybrid' }, signal())
  assert.equal(value.engine, 'hybrid')
  assert.deepEqual(calls, ['hybrid'])
})

test('未知引擎名报错', async () => {
  const { tool, file } = await fixtureWithHybrid(page(1, '正文'))
  await assert.rejects(tool.execute({ path: file, engine: 'magic' }, signal()), /magic/)
})

test('扫描件判 suspect 时，若 hybrid 可用则提示用 hybrid 救场', async () => {
  const { tool, file } = await fixtureWithHybrid(page(1, ''))
  const value = await tool.execute({ path: file }, signal())
  assert.equal(value.verdict, 'suspect')
  assert.match(value.suggest, /engine='hybrid'/)
})

test('零文本扫描件不把空页标记当正文返回', async () => {
  const { tool, file } = await fixtureWithHybrid(page(1, ''))
  const value = await tool.execute({ path: file }, signal())
  assert.equal(value.verdict, 'suspect')
  assert.equal(value.content, undefined, '空页标记不该当正文塞进上下文')
})
