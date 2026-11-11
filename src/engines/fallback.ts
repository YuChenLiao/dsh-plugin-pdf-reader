/** fallback 引擎：pdfium WASM，无 JVM、无外部依赖；正文顺序按 PDF 绘制顺序，标记为降级。 */
import { createRequire } from 'node:module'
import { ENGINE_PRIORITY, EngineError, type Availability, type ConvertRequest, type ConvertResult, type PdfEngine } from '../engines.ts'
import { attachEngine } from './attach.ts'
import type { Ctx } from '../ctx.ts'

export const name = 'dsh-plugin-pdf-reader/fallback'

export interface FallbackConfig {
  enabled: boolean
  timeoutMs: number
}

export function resolveFallbackConfig(raw: unknown): FallbackConfig {
  const input = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 60_000
  return { enabled: input.enabled !== false, timeoutMs }
}

/**
 * @returns 已安装的 pdfium 版本；未安装返回 null。
 */
export function resolvePdfiumVersion(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('@hyzyla/pdfium/package.json') as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return null
  }
}

export function createFallbackEngine(cfg: FallbackConfig, versionOf: () => string | null = resolvePdfiumVersion): PdfEngine {
  return {
    name: 'fallback',
    priority: ENGINE_PRIORITY.fallback,
    version: versionOf() ?? 'unknown',
    async available(): Promise<Availability> {
      if (!cfg.enabled) return { ok: false, reason: '组件已关闭（enabled: false）' }
      if (versionOf() === null) return { ok: false, reason: '未安装 @hyzyla/pdfium（阶段 5 接入）' }
      return { ok: false, reason: '兜底转换在阶段 5 实现' }
    },
    async convert(_request: ConvertRequest): Promise<ConvertResult> {
      throw new EngineError('unavailable', 'fallback 引擎的转换在阶段 5 实现')
    },
  }
}

export function apply(ctx: Ctx, config: unknown): void {
  const cfg = resolveFallbackConfig(config)
  attachEngine(ctx, () => createFallbackEngine(cfg))
}
