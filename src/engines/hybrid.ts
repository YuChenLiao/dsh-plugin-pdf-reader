/** hybrid 引擎：docling 后端。默认关闭；开启必须先同意模型下载。 */
import { ENGINE_PRIORITY, EngineError, type Availability, type ConvertRequest, type ConvertResult, type PdfEngine } from '../engines.ts'
import { attachEngine } from './attach.ts'
import type { Ctx } from '../ctx.ts'

export const name = 'dsh-plugin-pdf-reader/hybrid'

export interface HybridConfig {
  enabled: boolean
  acceptModelDownload: boolean
  port: number
  autoStart: boolean
  hybridUrl?: string
  timeoutMs: number
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * 校验 hybrid 配置。开启但未同意模型下载时在装载期报错，
 * 报错文案即"提示用户并取得同意"的入口。
 * @param raw - 原始配置。
 * @returns 完整配置。
 */
export function resolveHybridConfig(raw: unknown): HybridConfig {
  const input = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const enabled = input.enabled === true
  const acceptModelDownload = input.acceptModelDownload === true
  if (enabled && !acceptModelDownload) {
    throw new ConfigError(
      'hybrid 引擎需要本机具备 docling 后端：先装 Python 依赖（pip install "opendataloader-pdf[hybrid]"），'
      + '首次转换会下载数百 MB 模型，并常驻一个后端进程（默认端口 5002）。'
      + '同意这些之后，把本组件的 config.acceptModelDownload 设为 true 再重启。'
      + '若已有自建后端，填 hybridUrl 即可跳过自动启动。',
    )
  }
  const port = typeof input.port === 'number' && Number.isInteger(input.port) && input.port > 0 && input.port < 65_536 ? input.port : 5002
  const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 600_000
  return {
    enabled,
    acceptModelDownload,
    port,
    autoStart: input.autoStart !== false,
    ...(typeof input.hybridUrl === 'string' && input.hybridUrl.trim() !== '' ? { hybridUrl: input.hybridUrl } : {}),
    timeoutMs,
  }
}

export function createHybridEngine(cfg: HybridConfig): PdfEngine {
  return {
    name: 'hybrid',
    priority: ENGINE_PRIORITY.hybrid,
    version: 'pending',
    async available(): Promise<Availability> {
      if (!cfg.enabled) return { ok: false, reason: '组件已关闭（默认关闭）' }
      if (!cfg.acceptModelDownload) return { ok: false, reason: '未同意模型下载' }
      return { ok: false, reason: 'hybrid 转换在阶段 6 实现' }
    },
    async convert(_request: ConvertRequest): Promise<ConvertResult> {
      throw new EngineError('unavailable', 'hybrid 引擎的转换在阶段 6 实现')
    },
  }
}

export function apply(ctx: Ctx, config: unknown): void {
  const cfg = resolveHybridConfig(config)
  attachEngine(ctx, () => createHybridEngine(cfg))
}
