/** `pdf_extract`：转换 + 指标 + 三档判定；小文件返正文，大文件只返判定块。 */
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { cacheKey, expandHome, lookupFile, paramsSignature, sha256File, writeEntry, type CacheMeta, type CacheParams } from '../cache.ts'
import { computeMetrics, estimateTokens, splitPagesWithNumbers, type Metrics } from '../metrics.ts'
import { judge } from '../verdict.ts'
import { PAGE_SEPARATOR } from '../upstream.ts'
import { asNumber } from './read.ts'
import type { EngineError, EngineRegistry } from '../engines.ts'
import type { PluginConfig } from '../plugin.ts'
import type { Ctx, ToolDefinitionLike } from '../ctx.ts'

export interface ExtractDeps {
  ctx: Ctx
  registry: EngineRegistry
  config: PluginConfig
}

export interface ExtractValue {
  mode: 'inline' | 'spilled'
  engine: string
  degraded: boolean
  handle: string
  verdict: string
  pages: number
  chars: number
  tokens_est?: number
  stats?: Record<string, number>
  issues?: string[]
  suggest?: string
  content?: string
}

const PARAMS_BASE: Omit<CacheParams, 'pages'> = { separator: PAGE_SEPARATOR }

/**
 * 入上下文字符硬顶。dsh 的 `tool-result-pruner` 在 8192 字符处把结果截成
 * "头 4096 + 尾 1024"，超过它正文会被静默丢弃，所以这里直接拒绝。
 */
export const INLINE_HARD_CEILING = 8192

const schema = {
  type: 'object',
  properties: {
    mode: { type: 'string' },
    engine: { type: 'string' },
    degraded: { type: 'boolean' },
    handle: { type: 'string' },
    verdict: { type: 'string' },
    pages: { type: 'number' },
    chars: { type: 'number' },
    tokens_est: { type: 'number' },
    stats: { type: 'object' },
    issues: { type: 'array', items: { type: 'string' } },
    suggest: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['mode', 'engine', 'degraded', 'handle', 'verdict', 'pages', 'chars'],
}

/** 解析输入路径：支持绝对路径、工作区相对路径、`~` 开头。 */
export function resolveInputPath(input: string): string {
  if (input.startsWith('~')) return expandHome(input)
  return isAbsolute(input) ? input : resolvePath(process.cwd(), input)
}

/**
 * inline 判定必须用**交付尺寸**（含页标记的 body 长度），而不是剥离标记后的字符数：
 * 150 页的稀疏文档剥离后只有 5999 字符，实际交付却超过 8192，会被 pruner 砍掉中段。
 */
function spillOrInline(bodyChars: number, inlineLimit: number): 'inline' | 'spilled' {
  if (inlineLimit === 0) return 'spilled'
  return bodyChars <= inlineLimit ? 'inline' : 'spilled'
}

function toValue(meta: Pick<CacheMeta, 'handle' | 'engine' | 'degraded' | 'verdict' | 'pages' | 'chars' | 'bodyChars' | 'stats' | 'issues' | 'score' | 'sourcePath'>, body: string, inlineLimit: number, hybridUsable = false): ExtractValue {
  const mode = spillOrInline(meta.bodyChars ?? meta.chars, inlineLimit)
  const value: ExtractValue = {
    mode,
    engine: meta.engine,
    degraded: meta.degraded,
    handle: meta.handle,
    verdict: meta.verdict ?? 'unknown',
    pages: meta.pages,
    chars: meta.chars,
  }
  if (mode === 'spilled') value.tokens_est = estimateTokens(meta.chars)
  if (meta.stats !== undefined) value.stats = meta.stats
  if (meta.issues !== undefined && meta.issues.length > 0) value.issues = meta.issues
  if (value.verdict === 'suspect') {
    const noText = (meta.stats?.nonspace_chars ?? 0) === 0
    if (noText && hybridUsable === true) {
      value.suggest = `pdf_extract(path='${meta.sourcePath}', engine='hybrid')  # 扫描件：hybrid + OCR 约 25s/页`
    } else if (!noText) {
      const page = (meta.stats?.first_empty_page ?? 0) > 0 ? meta.stats.first_empty_page : 1
      value.suggest = `pdf_read(handle='${meta.handle}', page=${page})`
    }
  }
  // 零文本（扫描件）时正文只有页标记，返回它纯属浪费上下文
  if (mode === 'inline' && (meta.stats?.nonspace_chars ?? 1) > 0) value.content = body
  return value
}

export function createExtractTool(deps: ExtractDeps): ToolDefinitionLike {
  return {
    name: 'pdf_extract',
    description: '读取 PDF 并返回正文与质量判定。转换后 ≤ inlineLimit（默认 6000 字符）的文件直接返回全文；更大的文件只返回摘要与 handle，正文用 pdf_read 按页读取。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PDF 绝对路径或工作区相对路径' },
        pages: { type: 'string', description: '页范围，如 1-10；省略为全部。页码是原文页码' },
        engine: {
          type: 'string',
          enum: ['auto', 'fast', 'fallback', 'hybrid'],
          description: '指定引擎。auto（默认）按 fast → fallback 顺序自动选；hybrid 慢（8–10s/页，扫描件 + OCR 约 25s/页）但能读复杂表格与扫描件，需显式指定',
        },
        inlineLimit: { type: 'number', description: '入上下文字符上限，默认用配置值（6000），0 表示总是落盘' },
        force: { type: 'boolean', description: '忽略缓存重新转换', default: false },
      },
      required: ['path'],
    },
    output: {
      schema,
      render(_args, raw) {
        const value = raw as ExtractValue
        const head = [
          `pdf ${value.verdict}`,
          `${value.pages}页`,
          `${value.chars}字符`,
          value.tokens_est === undefined ? null : `~${value.tokens_est} tokens`,
          value.stats === undefined ? null : `${value.stats.tables ?? 0}表格`,
          value.stats === undefined ? null : `${value.stats.headings ?? 0}标题`,
          `engine=${value.engine}${value.degraded ? '(降级)' : ''}`,
        ].filter((part) => part !== null).join(' · ')
        const lines = [head, `handle=${value.handle}`]
        for (const issue of value.issues ?? []) lines.push(`- ${issue}`)
        if (value.suggest !== undefined) lines.push(`下一步：${value.suggest}`)
        if (value.content !== undefined) lines.push('', value.content)
        else if (value.verdict === 'suspect' || value.verdict === 'failed') lines.push('本引擎没有提取到文本，pdf_read 也读不到内容')
        else lines.push('正文未进上下文：用 pdf_read 按页读取')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs as { path?: unknown; pages?: unknown; inlineLimit?: unknown; force?: unknown; engine?: unknown }
      if (typeof args.path !== 'string' || args.path.trim() === '') throw new Error('path 必填')
      const absPath = resolveInputPath(args.path)
      const info = await stat(absPath).catch(() => null)
      if (info === null || !info.isFile()) throw new Error(`文件不存在或不是普通文件：${absPath}`)

      const params: CacheParams = {
        ...PARAMS_BASE,
        ...(typeof args.pages === 'string' && args.pages.trim() !== '' ? { pages: args.pages.trim() } : {}),
      }
      const requestedInline = asNumber(args.inlineLimit)
      if (requestedInline !== undefined && requestedInline > INLINE_HARD_CEILING) {
        throw new Error(`inlineLimit 上限是 ${INLINE_HARD_CEILING} 字符：超过它会被 dsh 的 tool-result-pruner 截成"头+尾"并丢正文`)
      }
      const inlineLimit = requestedInline !== undefined && requestedInline >= 0
        ? requestedInline
        : deps.config.inlineLimit
      const cacheDir = expandHome(deps.config.cacheDir)

      const requested = typeof args.engine === 'string' ? args.engine.trim() : 'auto'
      const explicitEngine = requested === '' || requested === 'auto' ? undefined : requested as 'fast' | 'fallback' | 'hybrid'

      const hybridUsable = async (): Promise<boolean> => {
        const probes = await deps.registry.probe(exec.signal)
        return probes.some((probe) => probe.name === 'hybrid' && probe.ok)
      }

      const fileSha256 = await sha256File(absPath)
      if (args.force !== true) {
        // 显式指定引擎时只认该引擎的缓存条目：否则 engine='hybrid' 会命中 fast 的旧结果，
        // 而 suggest 恰恰让模型这么调（code review C2）
        const hit = await lookupFile(cacheDir, fileSha256, params, explicitEngine)
        if (hit !== null) return toValue(hit.meta, hit.body, inlineLimit, hit.meta.verdict === 'suspect' ? await hybridUsable() : false)
      }

      const engine = explicitEngine === undefined
        ? await deps.registry.select(exec.signal)
        : await deps.registry.selectNamed(explicitEngine, exec.signal)
      const converted = await engine.convert({ absPath, ...(params.pages === undefined ? {} : { pages: params.pages }), signal: exec.signal })
      const metrics: Metrics = computeMetrics(converted.markdown)
      // 只提取了部分页时，空页/末页类指标反映的是所选范围而不是整份文档，判它会误报
      const judgment = judge(metrics, converted.engine, deps.config.judgeEnabled, params.pages !== undefined)
      const pageNumbers = splitPagesWithNumbers(converted.markdown).map((slice) => slice.page)

      const handle = cacheKey(fileSha256, converted.engine, converted.engineVersion, params, engine.cacheSignature ?? '')
      const meta: CacheMeta = {
        handle,
        engine: converted.engine,
        engineVersion: converted.engineVersion,
        degraded: converted.degraded,
        params,
        pages: metrics.pages,
        chars: metrics.chars,
        pageNumbers,
        bodyChars: converted.markdown.length,
        cachedAt: new Date().toISOString(),
        fileSha256,
        sourcePath: absPath,
        sourceSize: info.size,
        sourceMtimeMs: info.mtimeMs,
        stats: {
          replacement_ratio: round(metrics.replacement_ratio),
          control_ratio: round(metrics.control_ratio),
          private_use_ratio: round(metrics.private_use_ratio),
          cjk_ratio: round(metrics.cjk_ratio),
          question_run_max: metrics.question_run_max,
          avg_chars_per_line: round(metrics.avg_chars_per_line),
          single_char_line_ratio: round(metrics.single_char_line_ratio),
          line_end_punct_ratio: round(metrics.line_end_punct_ratio),
          page_char_variance: round(metrics.page_char_variance),
          empty_pages: metrics.empty_pages,
          empty_page_ratio: round(metrics.empty_page_ratio),
          head_cjk_ratio: round(metrics.head_cjk_ratio),
          nonspace_chars: metrics.nonspace_chars,
          first_empty_page: metrics.first_empty_page,
          last_page_ratio: round(metrics.last_page_ratio),
          tables: metrics.tables,
          headings: metrics.headings,
        },
        verdict: judgment.verdict,
        ...(judgment.issues.length > 0 ? { issues: judgment.issues } : {}),
        ...(judgment.verdict === 'suspect' ? { score: judgment.score } : {}),
      }
      await writeEntry(cacheDir, { handle, body: converted.markdown, meta })
      const usable = meta.verdict === 'suspect' ? await hybridUsable() : false
      return toValue(meta, converted.markdown, inlineLimit, usable)
    },
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

export { paramsSignature }
export type { EngineError }
