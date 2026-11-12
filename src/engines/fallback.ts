/** fallback 引擎：pdfium（WebAssembly），无 JVM、无外部进程；正文顺序按 PDF 绘制顺序，标记为降级。 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { ENGINE_PRIORITY, EngineError, type Availability, type ConvertRequest, type ConvertResult, type PdfEngine } from '../engines.ts'
import { PAGE_SEPARATOR, parsePageRange, pageMarker } from '../upstream.ts'
import { attachEngine } from './attach.ts'
import type { Ctx } from '../ctx.ts'

export const name = 'dsh-plugin-pdf-reader/fallback'

/** 兜底引擎用的 pdfium 版本，进缓存键的引擎指纹。 */
export function resolvePdfiumVersion(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('@hyzyla/pdfium/package.json') as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return null
  }
}

export interface FallbackConfig {
  enabled: boolean
  timeoutMs: number
}

export function resolveFallbackConfig(raw: unknown): FallbackConfig {
  const input = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 60_000
  return { enabled: input.enabled !== false, timeoutMs }
}

/** pdfium 的最小接触面，便于测试注入。 */
export interface PdfiumPageLike {
  getText(): Promise<string>
  /** 释放单页资源；不调只影响内存峰值。 */
  close?(): void
}
export interface PdfiumDocumentLike {
  getPageCount(): number
  getPage(index: number): PdfiumPageLike
  destroy(): void
}
export interface PdfiumLibraryLike {
  loadDocument(data: Uint8Array): Promise<PdfiumDocumentLike>
}

export interface FallbackDeps {
  libOf?: () => Promise<PdfiumLibraryLike>
  versionOf?: () => string | null
}

// WASM 初始化一次约 20ms，按进程复用
let cachedLibrary: Promise<PdfiumLibraryLike> | null = null

async function defaultLibrary(): Promise<PdfiumLibraryLike> {
  cachedLibrary ??= (async () => {
    const module = await import('@hyzyla/pdfium')
    const lib = await module.PDFiumLibrary.init()
    return lib as unknown as PdfiumLibraryLike
  })()
  try {
    return await cachedLibrary
  } catch (error) {
    cachedLibrary = null
    throw error
  }
}

export function createFallbackEngine(cfg: FallbackConfig, deps: FallbackDeps = {}): PdfEngine {
  const versionOf = deps.versionOf ?? resolvePdfiumVersion
  const libOf = deps.libOf ?? defaultLibrary

  return {
    name: 'fallback',
    priority: ENGINE_PRIORITY.fallback,
    get version() {
      return versionOf() ?? 'unknown'
    },
    async available(): Promise<Availability> {
      if (!cfg.enabled) return { ok: false, reason: '组件已关闭（enabled: false）' }
      if (versionOf() === null) return { ok: false, reason: '未安装 @hyzyla/pdfium' }
      return { ok: true }
    },
    async convert(request: ConvertRequest): Promise<ConvertResult> {
      if (!cfg.enabled) throw new EngineError('unavailable', '组件已关闭（enabled: false）')
      const version = versionOf()
      if (version === null) throw new EngineError('unavailable', '未安装 @hyzyla/pdfium')

      const deadline = AbortSignal.timeout(cfg.timeoutMs)
      const data = await readFile(request.absPath).catch((error: unknown) => {
        throw new EngineError('missing-file', `读取失败：${error instanceof Error ? error.message : String(error)}`)
      })

      let library: PdfiumLibraryLike
      try {
        library = await libOf()
      } catch (error) {
        throw new EngineError('engine-error', `pdfium 初始化失败：${error instanceof Error ? error.message : String(error)}`)
      }

      let document: PdfiumDocumentLike
      try {
        document = await library.loadDocument(data)
      } catch (error) {
        throw new EngineError('not-pdf', `无法解析为 PDF：${error instanceof Error ? error.message : String(error)}`)
      }

      try {
        const total = document.getPageCount()
        if (total === 0) throw new EngineError('engine-error', 'PDF 里没有任何页面')
        const wanted = request.pages === undefined ? null : parsePageRange(request.pages, total)
        const blocks: string[] = []
        for (let page = 1; page <= total; page += 1) {
          if (request.signal.aborted) throw new EngineError('aborted', '转换被取消')
          if (deadline.aborted) throw new EngineError('timeout', `fallback 引擎转换超时（${cfg.timeoutMs}ms）`)
          if (wanted !== null && !wanted.has(page)) continue
          const pageHandle = document.getPage(page - 1)
          try {
            const text = await pageHandle.getText()
            blocks.push(`${pageMarker(page)}\n${text.trim()}`)
          } finally {
            // 逐页释放：不调只是内存峰值高，destroy() 仍在 finally 里兜底
            pageHandle.close?.()
          }
        }
        if (blocks.length === 0) throw new EngineError('engine-error', `页范围 "${request.pages ?? ''}" 没有命中任何页`)
        return { markdown: blocks.join('\n'), engine: 'fallback', engineVersion: version, degraded: true }
      } finally {
        document.destroy()
      }
    },
  }
}

export function apply(ctx: Ctx, config: unknown): void {
  const cfg = resolveFallbackConfig(config)
  attachEngine(ctx, () => createFallbackEngine(cfg))
}

export { PAGE_SEPARATOR, pageMarker, parsePageRange }
