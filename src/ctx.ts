/**
 * 本插件用到的 ctx 形状。第三方插件不 import cordis 运行时，只声明自己真正读写的成员，
 * 与 dsh-plugin-memory-ledger 的做法一致。
 */

export interface LoggerLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface SubprocessOutcomeLike {
  exitCode: number | null
  signal?: string | null
}

export interface SubprocessOutputReadLike {
  text: string
  nextOffset: number
  lossy: boolean
  spillPath?: string
}

export interface SubprocessOutputReaderLike {
  readFrom(fromByte: number): SubprocessOutputReadLike
}

export interface SubprocessHandleLike {
  readonly collected: {
    stdout?: SubprocessOutputReaderLike
    stderr?: SubprocessOutputReaderLike
  }
  readonly done: Promise<SubprocessOutcomeLike>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

export type StdioDisposition = 'ignore' | 'pipe' | 'inherit' | { maxBytes: number }

export interface SubprocessSpawnLike {
  argv: readonly string[]
  cwd: string
  stdio: {
    stdin?: StdioDisposition
    stdout?: StdioDisposition
    stderr?: StdioDisposition
  }
  graceMs: number
  signal?: AbortSignal
  env?: Record<string, string | undefined>
}

export interface SubprocessLike {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: SubprocessSpawnLike): SubprocessHandleLike
}

export interface ToolContentBlockLike {
  type: string
  text?: string
}

export interface ToolOutputLike {
  schema: Record<string, unknown>
  render(args: unknown, value: unknown): ToolContentBlockLike[]
  presentationMeta?(args: unknown, value: unknown): unknown
}

export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: ToolOutputLike
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

export interface ToolsLike {
  register(definition: ToolDefinitionLike): () => void
}

export interface Ctx {
  tools: ToolsLike
  get?(name: string): unknown
  provide?(name: string, value?: unknown): () => void
  logger?: unknown
  effect?(fn: () => void | (() => void)): () => void
}
