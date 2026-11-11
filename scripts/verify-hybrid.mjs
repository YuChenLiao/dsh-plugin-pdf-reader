/** hybrid 真机验证：拉起后端 → 等端口 → 用我们的引擎转换 → 与 fast 结果对比。
 * 用法：node scripts/verify-hybrid.mjs <pdf> <backend-exe>
 * 后端前置：pip install "opendataloader-pdf[hybrid]"，可执行文件通常在
 * %APPDATA%/Python/Python3xx/Scripts/opendataloader-pdf-hybrid.exe
 */
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHybridEngine, resolveHybridConfig, probePort, backendUrlOf } from '../lib/hybrid.js'
import { createFastEngine, resolveFastConfig } from '../lib/fast.js'
import { computeMetrics } from '../lib/index.js'

const PDF = process.argv[2] ?? 'Downloads/补丁安装说明.pdf'
const BACKEND = process.argv[3] ?? 'opendataloader-pdf-hybrid'
const port = 5002
const ctx = { tools: { register: () => () => {} }, get: () => undefined }

console.log('后端可执行文件:', BACKEND)
const alreadyUp = await probePort('127.0.0.1', port, 800)
console.log('端口已就绪（复用已运行的后端）:', alreadyUp)

let backend = null
let ready = alreadyUp
if (!alreadyUp) {
  backend = spawn(BACKEND, ['--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  backend.stdout.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`))
  backend.stderr.on('data', (chunk) => process.stdout.write(`[backend:err] ${chunk}`))
  // 首次启动要先下模型，端口在模型就绪后才打开
  const deadline = Date.now() + 900_000
  while (Date.now() < deadline) {
    if (await probePort('127.0.0.1', port, 800)) { ready = true; break }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}
console.log('后端就绪:', ready)
if (!ready) { backend?.kill(); process.exit(1) }

const engine = createHybridEngine(ctx, resolveHybridConfig({
  enabled: true,
  acceptModelDownload: true,
  port,
  backendBinary: BACKEND,
  timeoutMs: 900_000,
}))

try {
  const t0 = performance.now()
  const result = await engine.convert({ absPath: PDF, signal: new AbortController().signal })
  const ms = Math.round(performance.now() - t0)
  const metrics = computeMetrics(result.markdown)
  console.log(`\nhybrid: ${ms}ms, ${metrics.pages} 页, ${metrics.chars} 字符, ${metrics.tables} 表格, ${metrics.headings} 标题, degraded=${result.degraded}`)
  console.log('前 160 字符:', JSON.stringify(result.markdown.slice(0, 160)))

  const fastEngine = createFastEngine(ctx, resolveFastConfig({}))
  const t1 = performance.now()
  const fast = await fastEngine.convert({ absPath: PDF, signal: new AbortController().signal })
  const fastMetrics = computeMetrics(fast.markdown)
  console.log(`fast:   ${Math.round(performance.now() - t1)}ms, ${fastMetrics.pages} 页, ${fastMetrics.chars} 字符, ${fastMetrics.tables} 表格, ${fastMetrics.headings} 标题`)
  console.log('两者字符数差:', metrics.chars - fastMetrics.chars)
} catch (error) {
  console.log('hybrid 转换失败:', error.kind, '|', error.message.slice(0, 500))
} finally {
  backend?.kill()
}
