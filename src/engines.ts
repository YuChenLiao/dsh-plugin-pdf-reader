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
  | 'missing-file'
  | 'corrupted'
  | 'encrypted'
  | 'aborted'
  | 'timeout'
  | 'engine-error'
  | 'initializing'
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
  /**
   * 额外进缓存键的指纹（例如 hybrid 的后端参数/地址）。
   * 不参与的话，开了 `--force-ocr` 仍会命中旧的非 OCR 结果（code review I2）。
   */
  readonly cacheSignature?: string
  /** 卸载时调用：停掉自己拉起的后端等（code review I3）。 */
  dispose?(): void
  /**
   * 只按名字显式调用，不参与自动选择链。
   * hybrid 用它：真机实测 8–10s/页（扫描件 + OCR 约 25s/页），放进默认链等于每次慢两个数量级。
   */
  readonly explicitOnly?: boolean
  available(signal?: AbortSignal): Promise<Availability>
  convert(request: ConvertRequest): Promise<ConvertResult>
}

export interface EngineProbe {
  name: EngineName
  priority: number
  version: string
  ok: boolean
  explicitOnly: boolean
  reason?: string
}

export interface EngineRegistry {
  register(engine: PdfEngine): () => void
  /** 按 priority 升序。 */
  list(): PdfEngine[]
  /** 自动链里第一个可用引擎（跳过 explicitOnly）；全部不可用时抛 EngineError('unavailable')。 */
  select(signal?: AbortSignal): Promise<PdfEngine>
  /** 按名字取引擎；不存在或不可用时抛 EngineError。 */
  selectNamed(name: EngineName, signal?: AbortSignal): Promise<PdfEngine>
  /** 每个注册引擎的可用性汇总，供 pdf_ping 展示。 */
  probe(signal?: AbortSignal): Promise<EngineProbe[]>
}

/**
 * 建一个注册表。可用性结果按引擎名缓存，注册/注销时失效，
 * 避免每次调用都重复探测（尤其避免重复起 java）。
 *
 * 缓存策略：**成功永久缓存，失败过期重试**。否则一次瞬时失败（java 忙、磁盘抖动）
 * 会让整份进程生命周期内再也用不到该引擎。
 * @param availabilityRetryMs - 失败结果的缓存时长，默认 60s。
 * @returns 空注册表。
 */
export function createEngineRegistry(availabilityRetryMs = 60_000): EngineRegistry {
  const engines = new Map<EngineName, PdfEngine>()
  const cache = new Map<EngineName, { value: Availability; at: number }>()
  const inflight = new Map<EngineName, Promise<Availability>>()

  const check = (engine: PdfEngine, signal?: AbortSignal): Promise<Availability> => {
    const cached = cache.get(engine.name)
    if (cached !== undefined && (cached.value.ok || Date.now() - cached.at < availabilityRetryMs)) {
      return Promise.resolve(cached.value)
    }
    const running = inflight.get(engine.name)
    if (running !== undefined) return running
    const pending = engine.available(signal)
      .then((result) => {
        cache.set(engine.name, { value: result, at: Date.now() })
        return result
      })
      .catch((error: unknown) => {
        const result: Availability = { ok: false, reason: error instanceof Error ? error.message : String(error) }
        cache.set(engine.name, { value: result, at: Date.now() })
        return result
      })
      .finally(() => { inflight.delete(engine.name) })
    inflight.set(engine.name, pending)
    return pending
  }

  const sorted = (): PdfEngine[] => [...engines.values()].sort((a, b) => a.priority - b.priority)

  return {
    register(engine) {
      // 同名替换而不是抛错：热重载时旧实例可能还没卸载完，
      // 抛错会发生在 timer 回调里直接掀翻宿主（code review I3）
      const previous = engines.get(engine.name)
      if (previous !== undefined && previous !== engine) previous.dispose?.()
      engines.set(engine.name, engine)
      cache.delete(engine.name)
      inflight.delete(engine.name)
      return () => {
        // 只移除自己这一份：晚到的旧 disposer 不能把新实例摘掉
        if (engines.get(engine.name) !== engine) return
        engines.delete(engine.name)
        cache.delete(engine.name)
        inflight.delete(engine.name)
        engine.dispose?.()
      }
    },
    list() {
      return sorted()
    },
    async select(signal) {
      const reasons: string[] = []
      for (const engine of sorted()) {
        if (engine.explicitOnly === true) continue
        const availability = await check(engine, signal)
        if (availability.ok) return engine
        reasons.push(`${engine.name}: ${availability.reason ?? '不可用'}`)
      }
      throw new EngineError('unavailable', reasons.length === 0 ? '自动链里没有可用引擎' : `自动链里没有可用引擎（${reasons.join('；')}）`)
    },
    async selectNamed(name, signal) {
      const engine = engines.get(name)
      if (engine === undefined) throw new EngineError('unavailable', `引擎 "${name}" 没有注册（对应组件未装载）`)
      const availability = await check(engine, signal)
      if (!availability.ok) throw new EngineError('unavailable', `引擎 "${name}" 不可用：${availability.reason ?? '未知原因'}`)
      return engine
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
          explicitOnly: engine.explicitOnly === true,
          ...(availability.reason === undefined ? {} : { reason: availability.reason }),
        })
      }
      return out
    },
  }
}
