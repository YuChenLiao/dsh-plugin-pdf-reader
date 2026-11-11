/** `pdf_ping`：阶段 0 的装载存在证明，之后升格为环境体检。 */
import { ENGINE_PRIORITY, type EngineRegistry } from '../engines.ts'
import { detectJava } from '../probe/java.ts'
import type { Ctx, ToolDefinitionLike } from '../ctx.ts'

export interface PingDeps {
  ctx: Ctx
  registry: EngineRegistry
  javaBinary: string
}

export interface PingValue {
  pong: true
  java: { ok: boolean; binary: string; version?: number; reason?: string }
  engines: Array<{ name: string; priority: number; version: string; ok: boolean; reason?: string }>
}

export function createPingTool(deps: PingDeps): ToolDefinitionLike {
  const schema = {
    type: 'object',
    properties: {
      pong: { type: 'boolean' },
      java: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          binary: { type: 'string' },
          version: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['ok', 'binary'],
      },
      engines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            priority: { type: 'number' },
            version: { type: 'string' },
            ok: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['name', 'priority', 'version', 'ok'],
        },
      },
    },
    required: ['pong', 'java', 'engines'],
  }

  return {
    name: 'pdf_ping',
    description: 'PDF 插件自检：返回本机 Java 探测结果与各引擎可用性。用于排查"为什么没走预期引擎"。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema,
      render(_args, raw) {
        const value = raw as PingValue
        const java = value.java.ok
          ? `java=${value.java.version ?? '?'} (${value.java.binary})`
          : `java=不可用（${value.java.reason ?? '未知原因'}）`
        const engines = value.engines
          .map((engine) => `${engine.name}:${engine.ok ? 'ok' : `关闭（${engine.reason ?? '不可用'}）`}`)
          .join(' · ')
        return [{ type: 'text', text: `pong · ${java}\n引擎（优先级 ${Object.entries(ENGINE_PRIORITY).map(([k, v]) => `${k}=${v}`).join(' ')}）: ${engines || '(无)'}` }]
      },
    },
    async execute(_args, exec) {
      const java = await detectJava(deps.ctx, deps.javaBinary, exec.signal)
      const engines = await deps.registry.probe(exec.signal)
      const value: PingValue = {
        pong: true,
        java: {
          ok: java.ok,
          binary: java.binary,
          ...(java.version === undefined ? {} : { version: java.version }),
          ...(java.reason === undefined ? {} : { reason: java.reason }),
        },
        engines: engines.map((engine) => ({
          name: engine.name,
          priority: engine.priority,
          version: engine.version,
          ok: engine.ok,
          ...(engine.reason === undefined ? {} : { reason: engine.reason }),
        })),
      }
      return value
    },
  }
}
