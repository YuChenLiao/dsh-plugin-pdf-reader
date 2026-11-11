/**
 * 工具层入口：注册 pdf_ping（阶段 0）、后续的 pdf_extract / pdf_read，
 * 并对外提供 ctx.pdfEngines 注册表。三个引擎组件通过它注册能力。
 */
import { createEngineRegistry, type EngineRegistry } from './engines.ts'
import { createPingTool } from './tools/ping.ts'
import type { Ctx } from './ctx.ts'

// 便于测试与外部复用；函数插件不能有 default export，这些具名导出不冲突。
export { createEngineRegistry, EngineError, ENGINE_PRIORITY } from './engines.ts'
export type { EngineName, EngineRegistry, PdfEngine, ConvertRequest, ConvertResult } from './engines.ts'
export { createPingTool } from './tools/ping.ts'
export type { PingValue } from './tools/ping.ts'
export { parseJavaVersion, detectJava } from './probe/java.ts'
export { runProcess } from './proc.ts'

export const name = 'dsh-plugin-pdf-reader'
export const inject = ['tools']

export interface PluginConfig {
  enabled: boolean
  /** 入上下文字符上限；硬顶 8192（dsh tool-result-pruner 阈值）。 */
  inlineLimit: number
  cacheDir: string
  judgeEnabled: boolean
  javaBinary: string
}

export const CONFIG_DEFAULTS: PluginConfig = {
  enabled: true,
  inlineLimit: 6000,
  cacheDir: '~/.dsh/pdf-cache',
  judgeEnabled: false,
  javaBinary: 'java',
}

const INLINE_HARD_CEILING = 8192

class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function asBoolean(value: unknown, key: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new ConfigError(`config.${key} 必须是布尔值`)
  return value
}

function asString(value: unknown, key: string, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(`config.${key} 必须是非空字符串`)
  return value
}

/**
 * 校验并补全配置。非法形状在装载期抛错，不静默兜底。
 * @param raw - cordis.patch.yml 里 `config:` 的原始值。
 * @returns 完整配置。
 */
export function resolveConfig(raw: unknown): PluginConfig {
  if (raw === undefined || raw === null) return { ...CONFIG_DEFAULTS }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config 必须是对象')
  const input = raw as Record<string, unknown>
  const inlineLimit = input.inlineLimit
  if (inlineLimit !== undefined) {
    if (typeof inlineLimit !== 'number' || !Number.isFinite(inlineLimit) || inlineLimit < 0) {
      throw new ConfigError('config.inlineLimit 必须是非负数字')
    }
    if (inlineLimit > INLINE_HARD_CEILING) {
      throw new ConfigError(`config.inlineLimit 上限是 ${INLINE_HARD_CEILING} 字符：超过它会被 dsh 的 tool-result-pruner 截成"头+尾"并静默丢正文`)
    }
  }
  return {
    enabled: asBoolean(input.enabled, 'enabled', CONFIG_DEFAULTS.enabled),
    inlineLimit: inlineLimit === undefined ? CONFIG_DEFAULTS.inlineLimit : (inlineLimit as number),
    cacheDir: asString(input.cacheDir, 'cacheDir', CONFIG_DEFAULTS.cacheDir),
    judgeEnabled: asBoolean(input.judgeEnabled, 'judgeEnabled', CONFIG_DEFAULTS.judgeEnabled),
    javaBinary: asString(input.javaBinary, 'javaBinary', CONFIG_DEFAULTS.javaBinary),
  }
}

/**
 * 装载工具层。
 * @param ctx - 插件上下文；`inject: ['tools']` 保证 `ctx.tools` 可用。
 * @param config - 原始配置。
 */
export function apply(ctx: Ctx, config: unknown): void {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) return

  const registry: EngineRegistry = createEngineRegistry()
  ctx.provide?.('pdfEngines', registry)

  ctx.tools.register(createPingTool({ ctx, registry, javaBinary: cfg.javaBinary }))

  const logger = typeof ctx.logger === 'function'
    ? (ctx.logger as (scope: string) => { info(...a: unknown[]): void } | undefined)('pdf-reader')
    : undefined
  logger?.info(`工具层已装载（inlineLimit=${cfg.inlineLimit}, judgeEnabled=${cfg.judgeEnabled}）`)
}
