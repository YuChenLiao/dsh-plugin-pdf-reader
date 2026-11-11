/** 引擎组件把能力注册进工具层提供的 ctx.pdfEngines。 */
import type { Ctx } from '../ctx.ts'
import type { EngineRegistry, PdfEngine } from '../engines.ts'

/**
 * 取注册表并注册引擎。
 *
 * 装载顺序由 cordis.patch.yml 保证（工具层在前），这里额外做一次短轮询，
 * 让引擎组件被单独装载或热重载时也不会静默失效。
 * @param ctx - 插件上下文。
 * @param make - 引擎工厂，只在注册成功时调用。
 */
export function attachEngine(ctx: Ctx, make: () => PdfEngine): void {
  const registryOf = (): EngineRegistry | undefined => {
    const candidate = ctx.get?.('pdfEngines')
    if (candidate !== null && typeof candidate === 'object' && typeof (candidate as EngineRegistry).register === 'function') {
      return candidate as EngineRegistry
    }
    return undefined
  }

  const registry = registryOf()
  if (registry !== undefined) {
    registry.register(make())
    return
  }

  let tries = 0
  const timer = setInterval(() => {
    tries += 1
    const late = registryOf()
    if (late !== undefined) {
      clearInterval(timer)
      late.register(make())
      return
    }
    if (tries >= 20) {
      clearInterval(timer)
      const log = typeof ctx.logger === 'function' ? (ctx.logger as (s: string) => { warn(...a: unknown[]): void } | undefined)('pdf-reader') : undefined
      log?.warn('未找到 ctx.pdfEngines：工具层组件没有装载，本引擎不生效')
    }
  }, 100)
  timer.unref?.()
}
