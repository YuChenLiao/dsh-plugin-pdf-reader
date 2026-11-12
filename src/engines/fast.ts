/** fast 引擎：OpenDataLoader（JVM）+ `--to-stdout` → Markdown。 */
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { detectJava } from '../probe/java.ts'
import { runProcess, type RunResult, type RunSpec } from '../proc.ts'
import { buildConvertArgv, classifyFailure, resolveJarPath, UPSTREAM_VERSION } from '../upstream.ts'
import { ENGINE_PRIORITY, EngineError, type Availability, type ConvertRequest, type ConvertResult, type PdfEngine } from '../engines.ts'
import { attachEngine } from './attach.ts'
import type { Ctx } from '../ctx.ts'

export { buildConvertArgv, classifyFailure, PAGE_SEPARATOR, parsePageRange, resolveJarPath, UPSTREAM_VERSION } from '../upstream.ts'

export const name = 'dsh-plugin-pdf-reader/fast'

export interface FastConfig {
  enabled: boolean
  javaBinary: string
  timeoutMs: number
}

export function resolveFastConfig(raw: unknown): FastConfig {
  const input = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const javaBinary = typeof input.javaBinary === 'string' && input.javaBinary.trim() !== '' ? input.javaBinary : 'java'
  const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 120_000
  return { enabled: input.enabled !== false, javaBinary, timeoutMs }
}

/** 测试注入点：jar 定位与子进程执行。 */
export interface FastDeps {
  jarOf?: () => string | null
  run?: (spec: RunSpec) => Promise<RunResult>
}

export function createFastEngine(ctx: Ctx, cfg: FastConfig, deps: FastDeps = {}): PdfEngine {
  const jarOf = deps.jarOf ?? resolveJarPath
  const run = deps.run ?? ((spec: RunSpec) => runProcess(ctx, spec))

  return {
    name: 'fast',
    priority: ENGINE_PRIORITY.fast,
    version: UPSTREAM_VERSION,
    async available(signal): Promise<Availability> {
      if (!cfg.enabled) return { ok: false, reason: '组件已关闭（enabled: false）' }
      if (jarOf() === null) return { ok: false, reason: `未安装 @opendataloader/pdf@${UPSTREAM_VERSION}` }
      const java = await detectJava(ctx, cfg.javaBinary, signal)
      if (!java.ok) return { ok: false, reason: java.reason ?? 'Java 不可用' }
      return { ok: true }
    },
    async convert(request: ConvertRequest): Promise<ConvertResult> {
      const jar = jarOf()
      if (jar === null) throw new EngineError('unavailable', `未安装 @opendataloader/pdf@${UPSTREAM_VERSION}`)

      // 相对路径必须在这里补绝对化：cwd 会被设成文件所在目录，用相对路径会二次拼接
      const input = isAbsolute(request.absPath) ? request.absPath : resolvePath(request.absPath)
      const result = await run({
        argv: buildConvertArgv(cfg.javaBinary, jar, { input, ...(request.pages === undefined ? {} : { pages: request.pages }) }),
        cwd: dirname(input),
        timeoutMs: cfg.timeoutMs,
        signal: request.signal,
        // 24MB jar 起 JVM 后被杀要给足回收时间，避免留下半个 java
        graceMs: 5000,
      })

      if (result.aborted) throw new EngineError('aborted', '转换被取消')
      if (result.timedOut) throw new EngineError('timeout', `fast 引擎转换超时（${cfg.timeoutMs}ms）`)
      if (result.code !== 0) {
        const failure = classifyFailure(result)
        throw new EngineError(failure.kind, failure.message)
      }
      // 采集窗口溢出会丢掉 stdout 开头：正文缺页、页码错位，不能当成功结果交付
      if (result.stdoutLossy === true) {
        throw new EngineError('engine-error', 'fast 引擎输出超过采集上限，开头已丢失；请用 pages 分段提取')
      }
      if (result.stdout.trim() === '') throw new EngineError('engine-error', '转换成功但没有任何输出（疑似扫描件或空文档）')

      return { markdown: result.stdout, engine: 'fast', engineVersion: UPSTREAM_VERSION, degraded: false }
    },
  }
}

export function apply(ctx: Ctx, config: unknown): void {
  const cfg = resolveFastConfig(config)
  attachEngine(ctx, () => createFastEngine(ctx, cfg))
}
