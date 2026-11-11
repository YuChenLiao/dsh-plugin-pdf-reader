/** `pdf_read`：只读缓存，按页 / 区间取正文，不重新转换。 */
import { expandHome, readEntry, recentHandles } from '../cache.ts'
import { splitPages } from '../metrics.ts'
import type { PluginConfig } from '../plugin.ts'
import type { ToolDefinitionLike } from '../ctx.ts'

export interface ReadDeps {
  config: PluginConfig
}

export interface ReadValue {
  handle: string
  from_page: number
  to_page: number
  pages: number
  chars: number
  truncated: boolean
  /** 单页内被截断时，下一次该用的 offset。 */
  next_offset?: number
  remaining_from?: number
  remaining_to?: number
  content: string
}

const DEFAULT_MAX_CHARS = 20_000

const schema = {
  type: 'object',
  properties: {
    handle: { type: 'string' },
    from_page: { type: 'number' },
    to_page: { type: 'number' },
    pages: { type: 'number' },
    chars: { type: 'number' },
    truncated: { type: 'boolean' },
    next_offset: { type: 'number' },
    remaining_from: { type: 'number' },
    remaining_to: { type: 'number' },
    content: { type: 'string' },
  },
  required: ['handle', 'from_page', 'to_page', 'pages', 'chars', 'truncated', 'content'],
}

/**
 * 模型边界上的数字可能是字符串（实测 tool 调用里 `page: 13` 会以 "13" 到达），
 * 统一在这里做强转，避免整条逻辑静默退化成"全篇"。
 * @param value - 原始参数。
 * @returns 有限数字或 undefined。
 */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function clampPage(value: number, total: number): number {
  const page = Math.trunc(value)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.min(page, total)
}

export function createReadTool(deps: ReadDeps): ToolDefinitionLike {
  return {
    name: 'pdf_read',
    description: '按 handle 读取 pdf_extract 已转换正文的指定页或页区间。不重新转换；超出 maxChars 时截断并给出续读方式。',
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'pdf_extract 返回的 handle' },
        page: { type: 'number', description: '单页页码（原文页码，1 起）' },
        pageStart: { type: 'number', description: '区间起始页，配合 pageEnd 使用' },
        pageEnd: { type: 'number', description: '区间结束页（含）' },
        maxChars: { type: 'number', description: '返回字符上限，默认 20000' },
        offset: { type: 'number', description: '从所选范围的第几个字符开始返回，默认 0；单页截断后用 next_offset 续读' },
      },
      required: ['handle'],
    },
    output: {
      schema,
      render(_args, raw) {
        const value = raw as ReadValue
        const range = value.from_page === value.to_page ? `第 ${value.from_page} 页` : `第 ${value.from_page}–${value.to_page} 页`
        const head = `${value.handle} · ${range}（共 ${value.pages} 页，${value.chars} 字符）`
        let tail = ''
        if (value.truncated) {
          tail = value.next_offset !== undefined
            ? `\n[已截断：本页还有内容，用 offset=${value.next_offset} 续读]`
            : `\n[已截断：剩余第 ${value.remaining_from}–${value.remaining_to} 页，可用 pdf_read 继续读取]`
        }
        return [{ type: 'text', text: `${head}\n\n${value.content}${tail}` }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs as {
        handle?: unknown
        page?: unknown
        pageStart?: unknown
        pageEnd?: unknown
        maxChars?: unknown
        offset?: unknown
      }
      const handle = typeof args.handle === 'string' ? args.handle.trim() : ''
      if (handle === '') throw new Error('handle 必填')
      const cacheDir = expandHome(deps.config.cacheDir)
      const entry = await readEntry(cacheDir, handle)
      if (entry === null) {
        const recent = await recentHandles(cacheDir, 5)
        const hint = recent.length > 0 ? `最近可用的 handle：${recent.join(', ')}` : '缓存目录里还没有任何转换结果，先调用 pdf_extract'
        throw new Error(`handle "${handle}" 不存在。${hint}`)
      }

      const pageTexts = splitPages(entry.body)
      const total = pageTexts.length
      const requestedMax = asNumber(args.maxChars)
      const maxChars = requestedMax !== undefined && requestedMax > 0 ? Math.trunc(requestedMax) : DEFAULT_MAX_CHARS

      const page = asNumber(args.page)
      const pageStart = asNumber(args.pageStart)
      const pageEnd = asNumber(args.pageEnd)
      let from = 1
      let to = total
      if (page !== undefined) {
        from = clampPage(page, total)
        to = from
      } else {
        if (pageStart !== undefined) from = clampPage(pageStart, total)
        if (pageEnd !== undefined) to = clampPage(pageEnd, total)
        if (to < from) [from, to] = [to, from]
      }

      // 先把选中范围拼成整段再切片：单页比 maxChars 长时，
      // 没有 offset 就只能重复读同一段开头，永远读不到后半截。
      const blocks: string[] = []
      for (let current = from; current <= to; current += 1) {
        const text = (pageTexts[current - 1] ?? '').trim()
        blocks.push(`<!-- PAGE ${current} -->\n${text}`)
      }
      const joined = blocks.join('\n')
      const offset = Math.max(0, Math.trunc(asNumber(args.offset) ?? 0))
      const slice = joined.slice(offset, offset + maxChars)
      const truncated = offset + slice.length < joined.length

      const value: ReadValue = {
        handle,
        from_page: from,
        to_page: to,
        pages: total,
        chars: slice.length,
        truncated,
        content: slice,
      }
      if (truncated) {
        if (from === to) value.next_offset = offset + slice.length
        else {
          value.remaining_from = from
          value.remaining_to = to
        }
      }
      return value
    },
  }
}
