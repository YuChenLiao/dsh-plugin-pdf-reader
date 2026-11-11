/**
 * hybrid 引擎：OpenDataLoader 的 docling 后端。
 *
 * 转换仍由 Java CLI 完成（`--hybrid docling-fast --hybrid-url …`），后端只是加分项：
 * - 后端由用户 `pip install "opendataloader-pdf[hybrid]"` 提供，插件不代装；
 * - 首次启动会下载数百 MB 模型，因此**启动在后台进行**，期间 `available()` 报"初始化中"，
 *   选择链落回 fast，用户不会为一次调用等几分钟；
 * - 后端健康后本引擎优先级最高（10），此后所有转换都走它。
 */
import { connect } from 'node:net'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname as pathDirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { detectJava } from '../probe/java.ts'
import { runProcess, type RunResult, type RunSpec } from '../proc.ts'
import { buildConvertArgv, classifyFailure, resolveJarPath, UPSTREAM_VERSION } from '../upstream.ts'
import { ENGINE_PRIORITY, EngineError, type Availability, type ConvertRequest, type ConvertResult, type PdfEngine } from '../engines.ts'
import { expandHome } from '../cache.ts'
import { attachEngine } from './attach.ts'
import type { Ctx } from '../ctx.ts'

export const name = 'dsh-plugin-pdf-reader/hybrid'

/** 后端可执行文件（由 Python 包装提供）。 */
const BACKEND_BINARY = 'opendataloader-pdf-hybrid'

export interface HybridConfig {
  enabled: boolean
  acceptModelDownload: boolean
  port: number
  autoStart: boolean
  hybridUrl?: string
  timeoutMs: number
  /** 启动后端后等待端口就绪的上限（首次含模型下载）。 */
  startTimeoutMs: number
  /** 单次健康检查的 TCP 连接超时。 */
  healthTimeoutMs: number
  /** 转换用的 java 可执行文件。 */
  javaBinary: string
  /** docling 后端可执行文件；可为绝对路径（venv 安装时用）。 */
  backendBinary: string
  /** 额外传给后端的参数，如 ['--force-ocr', '--ocr-lang', 'ch_sim,en']。 */
  backendArgs: string[]
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * 校验 hybrid 配置。开启但未同意模型下载时在装载期报错 —— 报错文案就是"取得同意"的入口。
 * @param raw - 原始配置。
 * @returns 完整配置。
 */
export function resolveHybridConfig(raw: unknown): HybridConfig {
  const input = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const enabled = input.enabled === true
  const acceptModelDownload = input.acceptModelDownload === true
  if (enabled && !acceptModelDownload) {
    throw new ConfigError(
      'hybrid 引擎需要本机具备 docling 后端：先执行 pip install "opendataloader-pdf[hybrid]"（会连带装 docling 与依赖），'
      + '首次转换下载数百 MB 模型，并常驻一个后端进程（默认端口 5002）。'
      + '同意这些之后，把本组件 config.acceptModelDownload 设为 true 并重启。'
      + '若已有自建后端，填 hybridUrl 即可跳过自动启动。',
    )
  }
  const port = typeof input.port === 'number' && Number.isInteger(input.port) && input.port > 0 && input.port < 65_536 ? input.port : 5002
  const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 600_000
  const startTimeoutMs = typeof input.startTimeoutMs === 'number' && Number.isFinite(input.startTimeoutMs) && input.startTimeoutMs > 0 ? input.startTimeoutMs : 300_000
  const healthTimeoutMs = typeof input.healthTimeoutMs === 'number' && Number.isFinite(input.healthTimeoutMs) && input.healthTimeoutMs > 0 ? input.healthTimeoutMs : 1_500
  return {
    enabled,
    acceptModelDownload,
    port,
    autoStart: input.autoStart !== false,
    ...(typeof input.hybridUrl === 'string' && input.hybridUrl.trim() !== '' ? { hybridUrl: input.hybridUrl.trim() } : {}),
    timeoutMs,
    startTimeoutMs,
    healthTimeoutMs,
    javaBinary: typeof input.javaBinary === 'string' && input.javaBinary.trim() !== '' ? input.javaBinary : 'java',
    backendBinary: typeof input.backendBinary === 'string' && input.backendBinary.trim() !== '' ? input.backendBinary : BACKEND_BINARY,
    backendArgs: Array.isArray(input.backendArgs)
      ? input.backendArgs.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      : [],
  }
}

/** 默认后端地址。 */
export function backendUrlOf(cfg: HybridConfig): string {
  return cfg.hybridUrl ?? `http://127.0.0.1:${cfg.port}`
}

/**
 * TCP 探活：不依赖后端暴露的具体健康检查端点，端口通就算就绪。
 * @param host - 主机。
 * @param port - 端口。
 * @param timeoutMs - 连接超时。
 * @returns 是否可建立连接。
 */
export function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export interface HybridState {
  status: 'starting' | 'ready' | 'failed'
  port: number
  startedAt: string
  detail?: string
}

export interface HybridDeps {
  jarOf?: () => string | null
  run?: (spec: RunSpec) => Promise<RunResult>
  probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  /** 启动后端；返回句柄用于停止。测试里注入假实现。 */
  startBackend?: (cfg: HybridConfig) => { stop(): void }
  stateFile?: string
  /** 供测试跳过真实等待。 */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

export function createHybridEngine(ctx: Ctx, cfg: HybridConfig, deps: HybridDeps = {}): PdfEngine {
  const jarOf = deps.jarOf ?? resolveJarPath
  const run = deps.run ?? ((spec: RunSpec) => runProcess(ctx, spec))
  const probe = deps.probe ?? probePort
  const sleep = deps.sleep ?? defaultSleep
  const stateFile = deps.stateFile ?? join(expandHome('~/.dsh/pdf-cache'), '.hybrid-state.json')
  const startBackend = deps.startBackend ?? ((config: HybridConfig) => spawnBackend(ctx, config))

  let backend: { stop(): void } | null = null
  let starting: Promise<boolean> | null = null

  const target = (): { host: string; port: number } => {
    const url = backendUrlOf(cfg)
    try {
      const parsed = new URL(url)
      return { host: parsed.hostname, port: Number(parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : parsed.port) }
    } catch {
      return { host: '127.0.0.1', port: cfg.port }
    }
  }

  const isRemote = (): boolean => cfg.hybridUrl !== undefined

  const writeState = async (state: HybridState): Promise<void> => {
    await mkdir(pathDirname(stateFile), { recursive: true }).catch(() => undefined)
    await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8').catch(() => undefined)
  }

  /** 后台启动后端并轮询端口；并发调用共享同一个 promise。 */
  const ensureBackend = (): Promise<boolean> => {
    starting ??= (async () => {
      const { host, port } = target()
      if (await probe(host, port, cfg.healthTimeoutMs)) return true
      if (isRemote() || !cfg.autoStart) {
        await writeState({ status: 'failed', port, startedAt: new Date().toISOString(), detail: isRemote() ? '远程后端不可达' : 'autoStart 已关闭' })
        return false
      }
      await writeState({ status: 'starting', port, startedAt: new Date().toISOString() })
      try {
        backend = startBackend(cfg)
      } catch (error) {
        await writeState({ status: 'failed', port, startedAt: new Date().toISOString(), detail: error instanceof Error ? error.message : String(error) })
        return false
      }
      const deadline = Date.now() + cfg.startTimeoutMs
      while (Date.now() < deadline) {
        await sleep(1_000)
        if (await probe(host, port, cfg.healthTimeoutMs)) {
          await writeState({ status: 'ready', port, startedAt: new Date().toISOString() })
          return true
        }
      }
      await writeState({ status: 'failed', port, startedAt: new Date().toISOString(), detail: `后端在 ${cfg.startTimeoutMs}ms 内未就绪` })
      return false
    })()
    return starting
  }

  return {
    name: 'hybrid',
    priority: ENGINE_PRIORITY.hybrid,
    // 实测 8–10s/页（扫描件 + OCR 约 25s/页）：只接受显式调用，不进自动链
    explicitOnly: true,
    version: UPSTREAM_VERSION,
    async available(signal): Promise<Availability> {
      if (!cfg.enabled) return { ok: false, reason: '组件已关闭（默认关闭）' }
      if (!cfg.acceptModelDownload) return { ok: false, reason: '未同意模型下载' }
      if (jarOf() === null) return { ok: false, reason: `未安装 @opendataloader/pdf@${UPSTREAM_VERSION}` }
      const java = await detectJava(ctx, cfg.javaBinary, signal)
      if (!java.ok) return { ok: false, reason: java.reason ?? 'Java 不可用' }

      const { host, port } = target()
      if (await probe(host, port, cfg.healthTimeoutMs)) return { ok: true }
      // 后端没起来：触发一次后台启动，本次仍判不可用，让调用先走 fast
      void ensureBackend()
      return { ok: false, reason: 'docling 后端未就绪（已在后台启动，首次需下载模型；状态见 ~/.dsh/pdf-cache/.hybrid-state.json）' }
    },
    async convert(request: ConvertRequest): Promise<ConvertResult> {
      const jar = jarOf()
      if (jar === null) throw new EngineError('unavailable', `未安装 @opendataloader/pdf@${UPSTREAM_VERSION}`)
      const { host, port } = target()
      if (!(await probe(host, port, cfg.healthTimeoutMs))) {
        void ensureBackend()
        throw new EngineError('initializing', 'docling 后端还在初始化（首次需下载模型）。稍后重试，或先让 fast 引擎处理。')
      }

      // 与 fast 引擎一致：相对路径必须先绝对化，否则会被 cwd 二次拼接
      const input = isAbsolute(request.absPath) ? request.absPath : resolvePath(request.absPath)
      const result = await run({
        argv: buildConvertArgv(cfg.javaBinary, jar, {
          input,
          ...(request.pages === undefined ? {} : { pages: request.pages }),
          extra: { hybrid: 'docling-fast', hybridUrl: backendUrlOf(cfg), hybridTimeout: String(cfg.timeoutMs) },
        }),
        cwd: pathDirname(input),
        timeoutMs: cfg.timeoutMs,
        signal: request.signal,
        graceMs: 10_000,
      })

      if (result.aborted) throw new EngineError('aborted', '转换被取消')
      if (result.timedOut) throw new EngineError('timeout', `hybrid 引擎转换超时（${cfg.timeoutMs}ms）`)
      if (result.code !== 0) {
        const failure = classifyFailure(result)
        throw new EngineError(failure.kind, failure.message)
      }
      if (result.stdout.trim() === '') throw new EngineError('engine-error', '转换成功但没有任何输出（疑似扫描件或空文档）')
      return { markdown: result.stdout, engine: 'hybrid', engineVersion: UPSTREAM_VERSION, degraded: false }
    },
    /** 供工具层 dispose 时收尾：停掉自己拉起的后端。 */
    dispose() {
      backend?.stop()
      backend = null
    },
  } as PdfEngine & { dispose(): void }
}

/**
 * 后端的启动 argv。
 * @param cfg - hybrid 配置。
 * @returns 可执行文件 + 端口 + 额外参数（如 --force-ocr --ocr-lang ch_sim,en）。
 */
export function backendArgv(cfg: HybridConfig): string[] {
  return [cfg.backendBinary, '--port', String(cfg.port), ...cfg.backendArgs]
}

/** 用 dsh 的 subprocess 服务拉起后端。 */
function spawnBackend(ctx: Ctx, cfg: HybridConfig): { stop(): void } {
  const service = ctx.get?.('subprocess') as
    | { spawn(spec: { argv: readonly string[]; cwd: string; stdio: unknown; graceMs: number }): { terminate(): void } }
    | undefined
  if (service === undefined) throw new Error('没有 ctx.subprocess，无法拉起 docling 后端')
  const handle = service.spawn({
    argv: backendArgv(cfg),
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    graceMs: 10_000,
  })
  return { stop: () => handle.terminate() }
}

/** 读后端状态文件（pdf_ping 与排查用）。 */
export async function readHybridState(path?: string): Promise<HybridState | null> {
  const file = path ?? join(expandHome('~/.dsh/pdf-cache'), '.hybrid-state.json')
  try {
    return JSON.parse(await readFile(file, 'utf8')) as HybridState
  } catch {
    return null
  }
}

export function apply(ctx: Ctx, config: unknown): void {
  const cfg = resolveHybridConfig(config)
  attachEngine(ctx, () => createHybridEngine(ctx, cfg))
}

export { resolveJarPath }
