/** Java 探测：只需要主版本号，用来判断 17+。 */
import { runProcess } from '../proc.ts'
import type { Ctx } from '../ctx.ts'

/**
 * 从 `java -version` 的 stderr 里取主版本号。
 * 兼容 `openjdk version "17.0.11" …`、`java version "1.8.0_391"`、`jdk-21.0.1` 这类写法。
 * @param text - java -version 的原始输出。
 * @returns 主版本号；无法解析返回 null。
 */
export function parseJavaVersion(text: string): number | null {
  const match = /version\s+"(\d+)(?:\.(\d+))?/i.exec(text) ?? /"?(\d+)\.(\d+)\./i.exec(text)
  if (match === null) return null
  const major = Number.parseInt(match[1] as string, 10)
  if (!Number.isFinite(major)) return null
  // 1.8.0_391 → 8
  if (major === 1) {
    const minor = Number.parseInt(match[2] ?? '', 10)
    return Number.isFinite(minor) ? minor : null
  }
  return major
}

export interface JavaProbe {
  ok: boolean
  binary: string
  version?: number
  raw?: string
  reason?: string
}

/**
 * 探测可用的 java 及其版本。
 * @param ctx - 插件上下文（决定是否走 ctx.subprocess）。
 * @param binary - 配置里的 java 可执行文件，默认 `java`。
 * @param signal - 调用方取消信号。
 * @returns 探测结果；失败时带可读 reason，不抛异常。
 */
export async function detectJava(ctx: Ctx, binary = 'java', signal?: AbortSignal): Promise<JavaProbe> {
  const result = await runProcess(ctx, { argv: [binary, '-version'], cwd: process.cwd(), timeoutMs: 10_000, ...(signal === undefined ? {} : { signal }) })
  const raw = `${result.stdout}${result.stderr}`.trim()
  if (result.aborted) return { ok: false, binary, raw, reason: '探测被取消' }
  if (result.timedOut) return { ok: false, binary, raw, reason: 'java -version 超时（10s）' }
  if (result.code === null) return { ok: false, binary, raw, reason: `找不到可执行文件 "${binary}"` }
  if (result.code !== 0) return { ok: false, binary, raw, reason: `java -version 退出码 ${result.code}` }
  const version = parseJavaVersion(raw)
  if (version === null) return { ok: false, binary, raw, reason: '无法从输出解析 Java 版本' }
  if (version < 17) return { ok: false, binary, version, raw, reason: `需要 Java 17+，当前 ${version}` }
  return { ok: true, binary, version, raw }
}
