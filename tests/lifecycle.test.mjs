import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, cacheKey, createExtractTool, createEngineRegistry, judge, lookupFile, writeEntry } from '../lib/index.js'

const params = { separator: '<!-- PAGE %page-number% -->' }

/** 模拟宿主：同名工具二次注册会抛错（真实工具的语义），并提供 ctx.effect。 */
function hostCtx() {
  const tools = new Map()
  const effects = []
  return {
    ctx: {
      tools: {
        register(definition) {
          if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" already registered`)
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
      get: () => undefined,
      provide: () => () => {},
      effect(fn) {
        effects.push(fn())
        return () => {}
      },
    },
    tools,
    disposeAll() {
      for (const dispose of effects.reverse()) dispose()
      effects.length = 0
    },
  }
}

test('卸载后重新装载不会撞上"工具已注册"（热重载路径）', () => {
  const host = hostCtx()
  apply(host.ctx, {})
  assert.deepEqual([...host.tools.keys()].sort(), ['pdf_extract', 'pdf_ping', 'pdf_read'])

  // 宿主卸载：effect 的 disposer 应该把三个工具摘掉
  host.disposeAll()
  assert.equal(host.tools.size, 0)

  // 重新装载：不应抛错
  assert.doesNotThrow(() => apply(host.ctx, {}))
  assert.equal(host.tools.size, 3)
})

test('同一文件并发写索引：两份都在，且能按引擎分别查到', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'pdfconc-'))
  const sha = 'c'.repeat(64)
  const fastHandle = cacheKey(sha, 'fast', '2.5.20', params)
  const hybridHandle = cacheKey(sha, 'hybrid', '2.5.20', params)
  const base = {
    pages: 1,
    chars: 5,
    degraded: false,
    params,
    cachedAt: '2026-11-12T00:00:00.000Z',
    fileSha256: sha,
    sourcePath: 'D:/x.pdf',
    sourceSize: 1,
    sourceMtimeMs: 1,
    pageNumbers: [1],
    bodyChars: 5,
    stats: { chars: 5 },
  }

  await Promise.all([
    writeEntry(cacheDir, { handle: fastHandle, body: 'fast', meta: { ...base, handle: fastHandle, engine: 'fast', engineVersion: '2.5.20' } }),
    writeEntry(cacheDir, { handle: hybridHandle, body: 'hybrid', meta: { ...base, handle: hybridHandle, engine: 'hybrid', engineVersion: '2.5.20' } }),
  ])

  const fastHit = await lookupFile(cacheDir, sha, params, 'fast')
  const hybridHit = await lookupFile(cacheDir, sha, params, 'hybrid')
  assert.equal(fastHit.body, 'fast')
  assert.equal(hybridHit.body, 'hybrid')
  assert.ok((await lookupFile(cacheDir, sha, params)) !== null, '不带引擎过滤时也能命中')
})

test('引擎指纹变化会换 handle（hybrid 开后端参数后不命中旧缓存）', () => {
  const sha = 'd'.repeat(64)
  const plain = cacheKey(sha, 'hybrid', '2.5.20', params, JSON.stringify({ url: 'http://127.0.0.1:5002', args: [] }))
  const ocr = cacheKey(sha, 'hybrid', '2.5.20', params, JSON.stringify({ url: 'http://127.0.0.1:5002', args: ['--force-ocr'] }))
  assert.notEqual(plain, ocr)
})

test('只提取部分页时不判空页与末页（避免误报扫描件/截断）', () => {
  const metrics = {
    chars: 400,
    nonspace_chars: 400,
    pages: 2,
    head_cjk_ratio: 0,
    replacement_ratio: 0,
    control_ratio: 0,
    private_use_ratio: 0,
    cjk_ratio: 0,
    question_run_max: 0,
    avg_chars_per_line: 40,
    single_char_line_ratio: 0,
    line_end_punct_ratio: 0.5,
    page_char_variance: 0.1,
    empty_pages: 1,
    empty_page_ratio: 0.5,
    first_empty_page: 2,
    last_page_ratio: 0.01,
    tables: 0,
    headings: 0,
    image_only_hint: true,
  }
  const whole = judge(metrics, 'fast', true, false)
  assert.equal(whole.verdict, 'suspect', '整份文档时仍然要判')
  const partial = judge(metrics, 'fast', true, true)
  assert.equal(partial.verdict, 'ok', '部分页提取不该按整份文档的假设判')
})
