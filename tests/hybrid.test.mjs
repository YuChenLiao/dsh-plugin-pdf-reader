import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backendArgv, backendUrlOf, createHybridEngine, probePort, readHybridState, resolveHybridConfig } from '../lib/hybrid.js'

const JAR = 'C:/x/lib/opendataloader-pdf-cli.jar'
const ctx = { tools: { register: () => () => {} }, get: () => undefined }

async function statePath() {
  const dir = await mkdtemp(join(tmpdir(), 'pdfhybrid-'))
  return join(dir, '.hybrid-state.json')
}

function engineWith(overrides = {}) {
  const seen = { runs: [], starts: 0, stops: 0 }
  const engine = createHybridEngine(
    ctx,
    resolveHybridConfig({ enabled: true, acceptModelDownload: true, port: 5002, javaBinary: 'java', startTimeoutMs: 30, healthTimeoutMs: 50, ...(overrides.config ?? {}) }),
    {
      jarOf: overrides.jarOf ?? (() => JAR),
      run: async (spec) => { seen.runs.push(spec); return { code: 0, stdout: '<!-- PAGE 1 -->\n正文', stderr: '', timedOut: false, aborted: false } },
      probe: overrides.probe ?? (async () => true),
      startBackend: () => { seen.starts += 1; return { stop: () => { seen.stops += 1 } } },
      sleep: async () => {},
      stateFile: overrides.stateFile,
    },
  )
  return { engine, seen }
}

test('开启但未同意模型下载时装载期报错，文案含 pip 安装命令', () => {
  assert.throws(
    () => resolveHybridConfig({ enabled: true, acceptModelDownload: false }),
    /pip install "opendataloader-pdf\[hybrid\]"/,
  )
})

test('默认关闭时不报错，端口默认 5002', () => {
  const cfg = resolveHybridConfig({})
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.port, 5002)
  assert.equal(backendUrlOf(cfg), 'http://127.0.0.1:5002')
})

test('backendBinary 可指向 venv 里的绝对路径', () => {
  const cfg = resolveHybridConfig({ enabled: true, acceptModelDownload: true, backendBinary: 'D:/venv/Scripts/opendataloader-pdf-hybrid.exe' })
  assert.equal(cfg.backendBinary, 'D:/venv/Scripts/opendataloader-pdf-hybrid.exe')
  assert.equal(resolveHybridConfig({}).backendBinary, 'opendataloader-pdf-hybrid')
})

test('hybridUrl 优先于端口', () => {
  const cfg = resolveHybridConfig({ hybridUrl: 'http://10.0.0.5:6000' })
  assert.equal(backendUrlOf(cfg), 'http://10.0.0.5:6000')
})

test('后端健康时 available 为 ok', async () => {
  const { engine } = engineWith()
  assert.deepEqual(await engine.available(), { ok: true })
})

test('后端不通时 available 判不可用并在后台触发一次启动', async () => {
  const stateFile = await statePath()
  const { engine, seen } = engineWith({ probe: async () => false, stateFile })
  const availability = await engine.available()
  assert.equal(availability.ok, false)
  assert.match(availability.reason, /docling 后端未就绪/)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(seen.starts, 1)
})

test('后端通时 convert 透传 hybrid 参数', async () => {
  const { engine, seen } = engineWith()
  const result = await engine.convert({ absPath: 'D:/docs/a.pdf', signal: new AbortController().signal })
  assert.equal(result.engine, 'hybrid')
  assert.equal(result.degraded, false)
  const argv = seen.runs[0].argv
  assert.ok(argv.includes('--hybrid'))
  assert.ok(argv.includes('docling-fast'))
  assert.ok(argv.includes('--hybrid-url'))
  assert.ok(argv.includes('http://127.0.0.1:5002'))
  assert.equal(seen.runs[0].cwd, 'D:/docs')
})

test('后端不通时 convert 抛 initializing 而不是崩溃', async () => {
  const stateFile = await statePath()
  const { engine } = engineWith({ probe: async () => false, stateFile })
  await assert.rejects(engine.convert({ absPath: 'D:/docs/a.pdf', signal: new AbortController().signal }), (error) => {
    assert.equal(error.kind, 'initializing')
    assert.match(error.message, /初始化/)
    return true
  })
})

test('jar 缺失时 available 判不可用', async () => {
  const { engine } = engineWith({ jarOf: () => null })
  const availability = await engine.available()
  assert.equal(availability.ok, false)
  assert.match(availability.reason, /@opendataloader\/pdf/)
})

test('组件关闭时 available 给出关闭原因', async () => {
  const { engine } = engineWith({ config: { enabled: false } })
  const availability = await engine.available()
  assert.equal(availability.ok, false)
  assert.match(availability.reason, /默认关闭/)
})

test('探测失败会写状态文件，便于排查', async () => {
  const stateFile = await statePath()
  const { engine } = engineWith({ probe: async () => false, stateFile })
  await engine.available()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const state = await readHybridState(stateFile)
  assert.ok(state !== null)
  assert.equal(state.port, 5002)
  assert.match(state.status, /starting|failed/)
})

test('dispose 停掉自己拉起的后端', async () => {
  const stateFile = await statePath()
  const { engine, seen } = engineWith({ probe: async () => false, stateFile })
  await engine.available()
  await new Promise((resolve) => setTimeout(resolve, 20))
  engine.dispose()
  assert.equal(seen.stops, 1)
})

test('probePort 对未监听端口返回 false', async () => {
  assert.equal(await probePort('127.0.0.1', 59999, 300), false)
})

test('backendArgs 透传进后端启动参数', () => {
  const cfg = resolveHybridConfig({
    enabled: true,
    acceptModelDownload: true,
    backendBinary: 'D:/py/opendataloader-pdf-hybrid.exe',
    backendArgs: ['--force-ocr', '--ocr-lang', 'ch_sim,en'],
  })
  assert.deepEqual(backendArgv(cfg), [
    'D:/py/opendataloader-pdf-hybrid.exe', '--port', '5002', '--force-ocr', '--ocr-lang', 'ch_sim,en',
  ])
})

test('backendArgs 过滤非字符串项', () => {
  const cfg = resolveHybridConfig({ backendArgs: ['--force-ocr', 42, '', '  '] })
  assert.deepEqual(cfg.backendArgs, ['--force-ocr'])
})

test('hybrid 标记为 explicitOnly，不进自动链', async () => {
  const { engine } = engineWith()
  assert.equal(engine.explicitOnly, true)
})

test('probe(false) 不启动后端：为一句建议拉起 1.3GB 服务不值得', async () => {
  const stateFile = await statePath()
  const { engine, seen } = engineWith({ probe: async () => false, stateFile })
  const availability = await engine.available(undefined, false)
  assert.equal(availability.ok, false)
  assert.match(availability.reason, /未启动/)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(seen.starts, 0, '只读探测不应触发启动')
})

test('启动失败后可重试，不会被永久缓存', async () => {
  const stateFile = await statePath()
  let starts = 0
  const engine = createHybridEngine(
    ctx,
    resolveHybridConfig({ enabled: true, acceptModelDownload: true, port: 5002, backendBinary: 'x', startTimeoutMs: 5, healthTimeoutMs: 5 }),
    {
      jarOf: () => JAR,
      probe: async () => false,
      startBackend: () => { starts += 1; return { stop: () => {} } },
      sleep: async () => {},
      stateFile,
    },
  )
  await engine.available(undefined, true)
  await new Promise((resolve) => setTimeout(resolve, 60))
  await engine.available(undefined, true)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(starts, 2, '第一次失败后第二次应重试启动')
})
