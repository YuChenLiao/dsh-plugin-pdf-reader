/**
 * 统一的一次子进程调用：优先走 dsh 的 ctx.subprocess（Windows 上托管进程范围、
 * abort 直连终止、waitForExit 证明静默），没有该服务时退回 node:child_process，
 * 让单元测试与纯 Node 环境也能跑。
 */
import { spawn as spawnChild } from 'node:child_process'
import type { Ctx, SubprocessLike } from './ctx.ts'

export interface RunSpec {
  argv: readonly string[]
  cwd: string
  /** 内部 deadline；到期后终止进程并置 timedOut。 */
  timeoutMs?: number
  /** 调用方取消信号（来自 exec.signal）。 */
  signal?: AbortSignal
  /** 终止宽限期，交给 provider 的终止流程。 */
  graceMs?: number
  /** 每个采集流的内存上限。 */
  maxBytes?: number
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  /** 采集窗口丢过开头（stdout 超过上限）：正文不可信，调用方必须拒绝。 */
  stdoutLossy?: boolean
  timedOut: boolean
  aborted: boolean
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_GRACE_MS = 2000

/** 从 ctx 取 subprocess 服务；取不到返回 undefined。 */
export function subprocessOf(ctx: Ctx): SubprocessLike | undefined {
  const candidate = ctx.get?.('subprocess')
  if (candidate !== null && typeof candidate === 'object'
    && typeof (candidate as SubprocessLike).spawn === 'function'
    && typeof (candidate as SubprocessLike).resolveExecutable === 'function') {
    return candidate as SubprocessLike
  }
  return undefined
}

/**
 * 跑一次子进程并收集输出。
 * @param ctx - 插件上下文，用于取可选的 subprocess 服务。
 * @param spec - argv、cwd、deadline 与取消信号。
 * @returns 退出码、两路输出，以及超时/取消两个分类标志。
 */
export async function runProcess(ctx: Ctx, spec: RunSpec): Promise<RunResult> {
  const service = subprocessOf(ctx)
  if (service !== undefined) return runViaService(service, spec)
  return runViaChildProcess(spec)
}

async function runViaService(service: SubprocessLike, spec: RunSpec): Promise<RunResult> {
  const maxBytes = spec.maxBytes ?? DEFAULT_MAX_BYTES
  const controller = new AbortController()
  const abortOuter = (): void => controller.abort()
  if (spec.signal?.aborted === true) controller.abort()
  else spec.signal?.addEventListener('abort', abortOuter, { once: true })

  let timedOut = false
  const timer = spec.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true
    controller.abort()
  }, spec.timeoutMs)

  try {
    const handle = service.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes } },
      graceMs: spec.graceMs ?? DEFAULT_GRACE_MS,
      signal: controller.signal,
    })
    let code: number | null = null
    try {
      code = (await handle.done).exitCode
    } catch (error) {
      // spawn 失败没有 collected 内容可读，直接上抛原始错误
      throw error instanceof Error ? error : new Error(String(error))
    }
    // 直系命令退出不等于整树静默；等 provider 证明范围清空，避免残留 java
    await handle.waitForExit().catch(() => false)
    const outRead = handle.collected.stdout?.readFrom(0)
    const errRead = handle.collected.stderr?.readFrom(0)
    return {
      code,
      stdout: outRead?.text ?? '',
      stderr: errRead?.text ?? '',
      // 采集窗口滑出尾部意味着**开头丢了**：正文会缺页、页码会错位，必须让调用方知道
      stdoutLossy: outRead?.lossy === true,
      timedOut,
      aborted: spec.signal?.aborted === true,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    spec.signal?.removeEventListener('abort', abortOuter)
  }
}

function runViaChildProcess(spec: RunSpec): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawnChild(spec.argv[0] as string, spec.argv.slice(1), {
      cwd: spec.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const maxBytes = spec.maxBytes ?? DEFAULT_MAX_BYTES
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    // 按字节计，而不是 UTF-16 长度：中文一个字符占 3 字节，按 .length 判会把上限放大约 3 倍
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const used = target === 'stdout' ? stdoutBytes : stderrBytes
      if (used >= maxBytes) return
      const text = chunk.toString('utf8')
      if (target === 'stdout') {
        stdout += text
        stdoutBytes += chunk.length
      } else {
        stderr += text
        stderrBytes += chunk.length
      }
    }
    const appendStdout = (chunk: Buffer): void => append('stdout', chunk)
    const appendStderr = (chunk: Buffer): void => append('stderr', chunk)
    child.stdout?.on('data', appendStdout)
    child.stderr?.on('data', appendStderr)

    const kill = (): void => {
      if (process.platform === 'win32') spawnChild('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
    }
    const timer = spec.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      kill()
    }, spec.timeoutMs)
    const abortOuter = (): void => { kill() }
    if (spec.signal?.aborted === true) abortOuter()
    else spec.signal?.addEventListener('abort', abortOuter, { once: true })

    child.on('error', (error) => {
      if (timer !== undefined) clearTimeout(timer)
      spec.signal?.removeEventListener('abort', abortOuter)
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut, aborted: spec.signal?.aborted === true })
    })
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      spec.signal?.removeEventListener('abort', abortOuter)
      resolve({ code, stdout, stderr, stdoutLossy: false, timedOut, aborted: spec.signal?.aborted === true })
    })
  })
}
