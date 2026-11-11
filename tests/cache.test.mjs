import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cacheKey,
  lookupFile,
  paramsSignature,
  readEntry,
  recentHandles,
  sha256File,
  writeEntry,
} from '../lib/index.js'

const params = { separator: '<!-- PAGE %page-number% -->' }

function meta(handle, overrides = {}) {
  return {
    handle,
    engine: 'fast',
    engineVersion: '2.5.20',
    params,
    pages: 2,
    chars: 10,
    degraded: false,
    cachedAt: '2026-11-11T00:00:00.000Z',
    fileSha256: 'a'.repeat(64),
    sourcePath: 'D:/x.pdf',
    sourceSize: 100,
    sourceMtimeMs: 1,
    stats: { chars: 10 },
    ...overrides,
  }
}

test('cacheKey 对引擎名、版本、pages 任一变化都不同', () => {
  const sha = 'f'.repeat(64)
  const base = cacheKey(sha, 'fast', '2.5.20', params)
  assert.equal(base.length, 12)
  assert.equal(cacheKey(sha, 'fast', '2.5.20', params), base)
  assert.notEqual(cacheKey(sha, 'fast', '2.5.21', params), base)
  assert.notEqual(cacheKey(sha, 'hybrid', '2.5.20', params), base)
  assert.notEqual(cacheKey(sha, 'fast', '2.5.20', { ...params, pages: '2-3' }), base)
})

test('paramsSignature 与键序无关', () => {
  assert.equal(paramsSignature({ separator: 'x', pages: '1' }), paramsSignature({ pages: '1', separator: 'x' }))
})

test('sha256File 稳定且区分内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdfcache-'))
  const a = join(dir, 'a.bin')
  const b = join(dir, 'b.bin')
  await writeFile(a, 'hello')
  await writeFile(b, 'hello!')
  const hashA = await sha256File(a)
  assert.equal(hashA, await sha256File(a))
  assert.notEqual(hashA, await sha256File(b))
  assert.equal(hashA.length, 64)
})

test('writeEntry 后按文件 + 参数查得到，正文与元数据都在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdfcache-'))
  const handle = cacheKey('a'.repeat(64), 'fast', '2.5.20', params)
  await writeEntry(dir, { handle, body: '<!-- PAGE 1 -->\n正文', meta: meta(handle) })
  const hit = await lookupFile(dir, 'a'.repeat(64), params)
  assert.ok(hit)
  assert.equal(hit.meta.handle, handle)
  assert.match(hit.body, /正文/)
  assert.equal(hit.meta.engine, 'fast')
})

test('参数不同不命中（pages 参与寻址）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdfcache-'))
  const handle = cacheKey('b'.repeat(64), 'fast', '2.5.20', params)
  await writeEntry(dir, { handle, body: 'x', meta: meta(handle, { fileSha256: 'b'.repeat(64) }) })
  assert.equal(await lookupFile(dir, 'b'.repeat(64), { ...params, pages: '2-3' }), null)
  assert.ok(await lookupFile(dir, 'b'.repeat(64), params))
})

test('同一文件同一参数下返回最新的那份', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdfcache-'))
  const sha = 'c'.repeat(64)
  const older = cacheKey(sha, 'fast', '2.5.20', params)
  const newer = cacheKey(sha, 'fallback', '3.0.0', params)
  await writeEntry(dir, { handle: older, body: 'old', meta: meta(older, { fileSha256: sha, cachedAt: '2026-11-01T00:00:00.000Z' }) })
  await writeEntry(dir, { handle: newer, body: 'new', meta: meta(newer, { fileSha256: sha, engine: 'fallback', engineVersion: '3.0.0', degraded: true, cachedAt: '2026-11-11T00:00:00.000Z' }) })
  const hit = await lookupFile(dir, sha, params)
  assert.equal(hit.meta.handle, newer)
  assert.equal(hit.meta.degraded, true)
})

test('readEntry 按 handle 直读，recentHandles 给出最近列表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdfcache-'))
  const handle = cacheKey('d'.repeat(64), 'fast', '2.5.20', params)
  await writeEntry(dir, { handle, body: 'body', meta: meta(handle, { fileSha256: 'd'.repeat(64) }) })
  assert.equal((await readEntry(dir, handle)).body, 'body')
  assert.equal(await readEntry(dir, 'ffffffffffff'), null)
  assert.deepEqual(await recentHandles(dir), [handle])
})

test('没有索引时查缓存返回 null，不抛异常', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdfcache-'))
  assert.equal(await lookupFile(dir, 'e'.repeat(64), params), null)
})
