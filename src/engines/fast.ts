/** fast 引擎：OpenDataLoader（JVM）+ `--to-stdout` → Markdown。 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { detectJava } from '../probe/java.ts'
import { ENGINE_PRIORITY, EngineError, type Availability, type ConvertRequest, type ConvertResult, type PdfEngine } from '../engines.ts'
import { attachEngine } from './attach.ts'
import type { Ctx } from '../ctx.ts'

export const name = 'dsh-plugin-pdf-reader/fast'

/** 上游版本，精确锁；进缓存键的引擎指纹之一。 */
export const UPSTREAM_VERSION = '2.5.20'

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

/**
 * 定位上游 jar。
 * @returns jar 绝对路径；未安装上游包时返回 null。
 */
export function resolveJarPath(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve('@opendataloader/pdf/package.json')
    const jar = join(dirname(pkg), 'lib', 'opendataloader-pdf-cli.jar')
    return existsSync(jar) ? jar : null
  } catch {
    return null
  }
}

export function createFastEngine(ctx: Ctx, cfg: FastConfig, jarOf: () => string | null = resolveJarPath): PdfEngine {
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
    async convert(_request: ConvertRequest): Promise<ConvertResult> {
      throw new EngineError('unavailable', 'fast 引擎的转换在阶段 1 实现')
    },
  }
}

export function apply(ctx: Ctx, config: unknown): void {
  const cfg = resolveFastConfig(config)
  attachEngine(ctx, () => createFastEngine(ctx, cfg))
}
