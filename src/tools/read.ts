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
    remaining_from: { type: 'number' },
    remaining_to: { type: 'number' },
    content: { type: 'string' },
  },
  required: ['handle', 'from_page', 'to_page', 'pages', 'chars', 'truncated', 'content'],
}

export function createReadTool(deps: ReadDeps): ToolDefinitionLike {
  return {
    name: 'pdf_read',
    description: '按 handle 读取 pdf_extract 已转换正文的指定页或页区间。不重新转换；超出 maxChars 时截断并标注剩余页范围。',
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'pdf_extract 返回的 handle' },
        page: { type: 'number', description: '单页页码（原文页码，1 起）' },
        pageStart: { type: 'number', description: '区间起始页，配合 pageEnd 使用' },
        pageEnd: { type: 'number', description: '区间结束页（含）' },
        maxChars: { type: 'number', description: '返回字符上限，默认 20000' },
      },
      required: ['handle'],
    },
    output: {
      schema,
      render(_args, raw) {
        const value = raw as ReadValue
        const range = value.from_page === value.to_page ? `第 ${value.from_page} 页` : `第 ${value.from_page}–${value.to_page} 页`
        const head = `${value.handle} · ${range}（共 ${value.pages} 页，${value.chars} 字符）`
        const tail = value.truncated
          ? `\n[已截断：剩余第 ${value.remaining_from}–${value.remaining_to} 页，可用 pdf_read 继续读取]`
          : ''
        return [{ type: 'text', text: `${head}\n\n${value.content}${tail}` }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs as { handle?: unknown; page?: unknown; pageStart?: unknown; pageEnd?: unknown; maxChars?: unknown }
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
      const maxChars = typeof args.maxChars === 'number' && Number.isFinite(args.maxChars) && args.maxChars > 0
        ? args.maxChars
        : DEFAULT_MAX_CHARS

      let from = 1
      let to = total
      if (typeof args.page === 'number') {
        from = clampPage(args.page, total)
        to = from
      } else {
        if (typeof args.pageStart === 'number') from = clampPage(args.pageStart, total)
        if (typeof args.pageEnd === 'number') to = clampPage(args.pageEnd, total)
        if (to < from) [from, to] = [to, from]
      }

      const chunks: string[] = []
      let used = 0
      let truncated = false
      let lastPage = from - 1
      /** 被从中间切开的那一页：剩余范围要从它开始，否则这页的后半截会丢掉。 */
      let cutPage = 0
      for (let page = from; page <= to; page += 1) {
        const text = (pageTexts[page - 1] ?? '').trim()
        const block = `<!-- PAGE ${page} -->\n${text}`
        if (used + block.length > maxChars) {
          const room = maxChars - used
          if (room > 0) {
            chunks.push(block.slice(0, room))
            used += room
            lastPage = page
          }
          cutPage = page
          truncated = true
          break
        }
        chunks.push(block)
        used += block.length + 1
        lastPage = page
      }

      const content = chunks.join('\n')
      const value: ReadValue = {
        handle,
        from_page: from,
        to_page: truncated ? lastPage : to,
        pages: total,
        chars: content.length,
        truncated,
        content,
      }
      if (truncated) {
        value.remaining_from = Math.max(from, cutPage)
        value.remaining_to = to
      }
      return value
    },
  }
}

function clampPage(value: number, total: number): number {
  const page = Math.trunc(value)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.min(page, total)
}
