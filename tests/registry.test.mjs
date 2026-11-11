import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngineRegistry } from '../lib/index.js'

const engine = (name, priority, ok, reason) => ({
  name,
  priority,
  version: 'v1',
  async available() {
    return ok ? { ok: true } : { ok: false, reason }
  },
  async convert() {
    throw new Error('not used')
  },
})

test('list() 按 priority 升序', () => {
  const registry = createEngineRegistry()
  registry.register(engine('fallback', 90, true))
  registry.register(engine('hybrid', 10, false, '关'))
  registry.register(engine('fast', 20, true))
  assert.deepEqual(registry.list().map((e) => e.name), ['hybrid', 'fast', 'fallback'])
})

test('select() 跳过不可用引擎', async () => {
  const registry = createEngineRegistry()
  registry.register(engine('hybrid', 10, false, '未同意模型下载'))
  registry.register(engine('fast', 20, true))
  registry.register(engine('fallback', 90, true))
  const picked = await registry.select()
  assert.equal(picked.name, 'fast')
})

test('全部不可用时抛 unavailable 并带每个引擎的原因', async () => {
  const registry = createEngineRegistry()
  registry.register(engine('fast', 20, false, '需要 Java 17+，当前 8'))
  registry.register(engine('fallback', 90, false, '组件已关闭'))
  await assert.rejects(registry.select(), (error) => {
    assert.equal(error.kind, 'unavailable')
    assert.match(error.message, /fast: 需要 Java 17\+，当前 8/)
    assert.match(error.message, /fallback: 组件已关闭/)
    return true
  })
})

test('可用性结果被缓存，重复 select 不再探测', async () => {
  let probes = 0
  const counting = {
    name: 'fast',
    priority: 20,
    version: 'v1',
    async available() {
      probes += 1
      return { ok: true }
    },
    async convert() {
      throw new Error('not used')
    },
  }
  const registry = createEngineRegistry()
  registry.register(counting)
  await registry.select()
  await registry.select()
  assert.equal(probes, 1)
})

test('注销后引擎从列表移除且可用于重载', async () => {
  const registry = createEngineRegistry()
  const dispose = registry.register(engine('fast', 20, true))
  dispose()
  assert.deepEqual(registry.list(), [])
  registry.register(engine('fast', 20, true))
  assert.equal((await registry.select()).name, 'fast')
})

test('重复注册同名引擎抛错', () => {
  const registry = createEngineRegistry()
  registry.register(engine('fast', 20, true))
  assert.throws(() => registry.register(engine('fast', 20, true)), /已注册/)
})

test('probe() 汇总每个引擎的可用性与原因', async () => {
  const registry = createEngineRegistry()
  registry.register(engine('fast', 20, false, '未安装 @opendataloader/pdf@2.5.20'))
  registry.register(engine('fallback', 90, true))
  const probes = await registry.probe()
  assert.deepEqual(probes.map((p) => [p.name, p.ok]), [['fast', false], ['fallback', true]])
  assert.match(probes[0].reason, /2\.5\.20/)
  assert.equal(probes[1].reason, undefined)
})

test('explicitOnly 引擎不进自动链，但可被 selectNamed 取到', async () => {
  const registry = createEngineRegistry()
  const slow = { ...engine('hybrid', 10, true), explicitOnly: true }
  registry.register(slow)
  registry.register(engine('fast', 20, true))
  assert.equal((await registry.select()).name, 'fast')
  assert.equal((await registry.selectNamed('hybrid')).name, 'hybrid')
})

test('selectNamed 对未注册或不可用的引擎给出明确原因', async () => {
  const registry = createEngineRegistry()
  registry.register(engine('fast', 20, false, '需要 Java 17+'))
  await assert.rejects(registry.selectNamed('fast'), (error) => {
    assert.equal(error.kind, 'unavailable')
    assert.match(error.message, /需要 Java 17\+/)
    return true
  })
  await assert.rejects(registry.selectNamed('hybrid'), /没有注册/)
})

test('probe 标出 explicitOnly', async () => {
  const registry = createEngineRegistry()
  registry.register({ ...engine('hybrid', 10, true), explicitOnly: true })
  registry.register(engine('fast', 20, true))
  const probes = await registry.probe()
  assert.deepEqual(probes.map((p) => [p.name, p.explicitOnly]), [['hybrid', true], ['fast', false]])
})

test('失败结果会过期重试，成功结果长期缓存', async () => {
  let ok = false
  let probes = 0
  const flaky = {
    name: 'fast',
    priority: 20,
    version: 'v1',
    async available() { probes += 1; return ok ? { ok: true } : { ok: false, reason: 'java 忙' } },
    async convert() { throw new Error('not used') },
  }
  const registry = createEngineRegistry(0)
  registry.register(flaky)
  await assert.rejects(registry.select())
  ok = true
  assert.equal((await registry.select()).name, 'fast')
  await registry.select()
  assert.equal(probes, 2, '成功之后不再重复探测')
})
