/** 引擎契约与注册表。工具层持有注册表，引擎组件往里注册。 */

export type EngineName = 'hybrid' | 'fast' | 'fallback'

/** 选择顺序：数值越小越优先。 */
export const ENGINE_PRIORITY: Record<EngineName, number> = {
  hybrid: 10,
  fast: 20,
  fallback: 90,
}

export interface ConvertRequest {
  /** 已解析的绝对路径。 */
  absPath: string
  /** 页范围，原文语法（如 `1-10`）；省略为全部。 */
  pages?: string
  /** 调用方取消信号。 */
  signal: AbortSignal
}

export interface ConvertResult {
  /** Markdown 正文，含页分隔符。 */
  markdown: string
  engine: EngineName
  engineVersion: string
  /** 降级引擎为 true；调用方据此放宽判定。 */
  degraded: boolean
}

export type FailureCause =
  | 'not-pdf'
  | 'corrupted'
  | 'encrypted'
  | 'aborted'
  | 'timeout'
  | 'engine-error'
  | 'unavailable'

export class EngineError extends Error {
  readonly kind: FailureCause
  constructor(kind: FailureCause, message: string) {
    super(message)
    this.name = 'EngineError'
    this.kind = kind
  }
}

export interface Availability {
  ok: boolean
  reason?: string
}

export interface PdfEngine {
  readonly name: EngineName
  readonly priority: number
  readonly version: string
  available(signal?: AbortSignal): Promise<Availability>
  convert(request: ConvertRequest): Promise<ConvertResult>
}

export interface EngineProbe {
  name: EngineName
  priority: number
  version: string
  ok: boolean
  reason?: string
}

export interface EngineRegistry {
  register(engine: PdfEngine): () => void
  /** 按 priority 升序。 */
  list(): PdfEngine[]
  /** 第一个可用引擎；全部不可用时抛 EngineError('unavailable')。 */
  select(signal?: AbortSignal): Promise<PdfEngine>
  /** 每个注册引擎的可用性汇总，供 pdf_ping 展示。 */
  probe(signal?: AbortSignal): Promise<EngineProbe[]>
}

/**
 * 建一个注册表。可用性结果按引擎名缓存，注册/注销时失效，
 * 避免每次调用都重复探测（尤其避免重复起 java）。
 * @returns 空注册表。
 */
export function createEngineRegistry(): EngineRegistry {
  const engines = new Map<EngineName, PdfEngine>()
  const cache = new Map<EngineName, Availability>()
  const inflight = new Map<EngineName, Promise<Availability>>()

  const check = (engine: PdfEngine, signal?: AbortSignal): Promise<Availability> => {
    const cached = cache.get(engine.name)
    if (cached !== undefined) return Promise.resolve(cached)
    const running = inflight.get(engine.name)
    if (running !== undefined) return running
    const pending = engine.available(signal)
      .then((result) => {
        cache.set(engine.name, result)
        return result
      })
      .catch((error: unknown) => {
        const result: Availability = { ok: false, reason: error instanceof Error ? error.message : String(error) }
        cache.set(engine.name, result)
        return result
      })
      .finally(() => { inflight.delete(engine.name) })
    inflight.set(engine.name, pending)
    return pending
  }

  const sorted = (): PdfEngine[] => [...engines.values()].sort((a, b) => a.priority - b.priority)

  return {
    register(engine) {
      if (engines.has(engine.name)) throw new Error(`引擎 "${engine.name}" 已注册`)
      engines.set(engine.name, engine)
      cache.delete(engine.name)
      inflight.delete(engine.name)
      return () => {
        engines.delete(engine.name)
        cache.delete(engine.name)
        inflight.delete(engine.name)
      }
    },
    list() {
      return sorted()
    },
    async select(signal) {
      const reasons: string[] = []
      for (const engine of sorted()) {
        const availability = await check(engine, signal)
        if (availability.ok) return engine
        reasons.push(`${engine.name}: ${availability.reason ?? '不可用'}`)
      }
      throw new EngineError('unavailable', reasons.length === 0 ? '没有注册任何引擎' : `没有可用引擎（${reasons.join('；')}）`)
    },
    async probe(signal) {
      const out: EngineProbe[] = []
      for (const engine of sorted()) {
        const availability = await check(engine, signal)
        out.push({
          name: engine.name,
          priority: engine.priority,
          version: engine.version,
          ok: availability.ok,
          ...(availability.reason === undefined ? {} : { reason: availability.reason }),
        })
      }
      return out
    },
  }
}
