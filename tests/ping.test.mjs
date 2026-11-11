import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, createEngineRegistry, createPingTool } from '../lib/index.js'

function fakeCtx() {
  const registered = []
  return {
    ctx: {
      tools: {
        register(definition) {
          registered.push(definition)
          return () => {}
        },
      },
      get: () => undefined,
      provide: () => () => {},
    },
    registered,
  }
}

test('apply 注册 pdf_ping 并提供 pdfEngines', () => {
  const { ctx, registered } = fakeCtx()
  const provided = []
  ctx.provide = (key, value) => {
    provided.push([key, value])
    return () => {}
  }
  apply(ctx, {})
  assert.deepEqual(registered.map((d) => d.name), ['pdf_ping', 'pdf_extract', 'pdf_read'])
  assert.deepEqual(provided.map(([key]) => key), ['pdfEngines'])
  assert.equal(typeof provided[0][1].register, 'function')
})

test('inlineLimit 超过 8192 在装载期报错', () => {
  const { ctx } = fakeCtx()
  assert.throws(() => apply(ctx, { inlineLimit: 15000 }), /tool-result-pruner/)
})

test('非法配置形状在装载期报错', () => {
  const { ctx } = fakeCtx()
  assert.throws(() => apply(ctx, { inlineLimit: -1 }), /inlineLimit/)
  assert.throws(() => apply(ctx, { enabled: 'yes' }), /enabled/)
  assert.throws(() => apply(ctx, 42), /config 必须是对象/)
})

test('pdf_ping 返回 pong 与各引擎状态（java 不可用时如实报错）', async () => {
  const { ctx } = fakeCtx()
  const registry = createEngineRegistry()
  registry.register({
    name: 'fast',
    priority: 20,
    version: '2.5.20',
    async available() {
      return { ok: false, reason: '需要 Java 17+' }
    },
    async convert() {
      throw new Error('not used')
    },
  })
  const tool = createPingTool({ ctx, registry, javaBinary: 'definitely-not-java-xyz' })
  const value = await tool.execute({}, { signal: new AbortController().signal })
  assert.equal(value.pong, true)
  assert.equal(value.java.ok, false)
  assert.match(value.java.reason, /找不到可执行文件/)
  assert.deepEqual(value.engines.map((e) => [e.name, e.ok]), [['fast', false]])
  const blocks = tool.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /pong/)
  assert.match(blocks[0].text, /fast:关闭/)
  assert.ok(!blocks[0].text.includes('hybrid='), '静态优先级表不应出现在 render 里')
})
