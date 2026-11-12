/** `pdf_read`：只读缓存，按页 / 区间取正文，不重新转换。 */
import { expandHome, readEntry, recentHandles } from '../cache.ts'
import { splitPagesWithNumbers, type PageSlice } from '../metrics.ts'
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
/** 与 tool-result-pruner 的 8192 对齐：默认一次别超过它，否则中段会被裁掉。 */
const SAFE_MAX_CHARS = 8_000
/** handle 是 12 位十六进制；不做校验就能被 `../../x` 穿越出缓存目录（code review I5）。 */
const HANDLE_PATTERN = /^[0-9a-f]{12}$/

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

/**
 * 按原始页码挑出要交付的页。
 *
 * 页码来自页标记本身，不是数组下标：`--pages 5-8` 提取的正文里第一条是 `PAGE 5`，
 * 它的下标是 0。按位置重编号会把第 5 页标成第 1 页（code review C1）。
 * @param slices - 带原始页码的页。
 * @param request - 页码或页区间（原文页码）。
 * @returns 命中的页与请求的范围；范围越界时抛错而不是悄悄夹取。
 */
export function selectPages(slices: PageSlice[], request: { page?: number; pageStart?: number; pageEnd?: number }): {
  picked: PageSlice[]
  from: number
  to: number
  available: number[]
} {
  const available = slices.map((slice) => slice.page)
  const lowest = available[0] ?? 1
  const highest = available.at(-1) ?? 0

  const want = (value: number, label: string): number => {
    const page = Math.trunc(value)
    if (!available.includes(page)) {
      throw new Error(`${label} ${page} 不在已提取的页范围内（可用 ${lowest}–${highest}，共 ${slices.length} 页）；用 pdf_extract 重新提取该页`)
    }
    return page
  }

  let from: number
  let to: number
  if (request.page !== undefined) {
    from = want(request.page, 'page')
    to = from
  } else {
    from = request.pageStart === undefined ? lowest : want(request.pageStart, 'pageStart')
    to = request.pageEnd === undefined ? highest : want(request.pageEnd, 'pageEnd')
    if (to < from) [from, to] = [to, from]
  }

  const picked = slices.filter((slice) => slice.page >= from && slice.page <= to)
  return { picked, from, to, available }
}

export function createReadTool(deps: ReadDeps): ToolDefinitionLike {
  return {
    name: 'pdf_read',
    description: '按 handle 读取 pdf_extract 已转换正文的指定页或页区间（页码是原文页码）。不重新转换；超出 maxChars 时截断并给出续读方式。',
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'pdf_extract 返回的 handle' },
        page: { type: 'number', description: '单页页码（原文页码）' },
        pageStart: { type: 'number', description: '区间起始页（原文页码），配合 pageEnd 使用' },
        pageEnd: { type: 'number', description: '区间结束页（含，原文页码）' },
        maxChars: { type: 'number', description: '返回字符上限，默认 8000（再高会被 dsh 的 pruner 裁剪）' },
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
            : `\n[已截断：只返回了区间开头，用 offset=${value.chars} 续读同一区间]`
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
      if (!HANDLE_PATTERN.test(handle)) throw new Error(`handle "${handle}" 格式不对：应为 12 位十六进制（pdf_extract 返回的值）`)

      const cacheDir = expandHome(deps.config.cacheDir)
      const entry = await readEntry(cacheDir, handle)
      if (entry === null) {
        const recent = await recentHandles(cacheDir, 5)
        const hint = recent.length > 0 ? `最近可用的 handle：${recent.join(', ')}` : '缓存目录里还没有任何转换结果，先调用 pdf_extract'
        throw new Error(`handle "${handle}" 不存在。${hint}`)
      }

      const slices = splitPagesWithNumbers(entry.body)
      // 旧缓存没有 pageNumbers，按出现顺序回退（并如实反映出来）
      const known = entry.meta.pageNumbers
      const numbered = known !== undefined && known.length === slices.length
        ? slices.map((slice, index) => ({ page: known[index] as number, text: slice.text }))
        : slices

      const requestedMax = asNumber(args.maxChars)
      const maxChars = requestedMax !== undefined && requestedMax > 0
        ? Math.trunc(requestedMax)
        : Math.min(deps.config.inlineLimit > 0 ? deps.config.inlineLimit : DEFAULT_MAX_CHARS, SAFE_MAX_CHARS)

      const selection = selectPages(numbered, {
        ...(asNumber(args.page) === undefined ? {} : { page: asNumber(args.page) as number }),
        ...(asNumber(args.pageStart) === undefined ? {} : { pageStart: asNumber(args.pageStart) as number }),
        ...(asNumber(args.pageEnd) === undefined ? {} : { pageEnd: asNumber(args.pageEnd) as number }),
      })

      // 拼成整段再切片：单页比 maxChars 长时，没有 offset 就只能重复读同一段开头
      const joined = selection.picked.map((slice) => `<!-- PAGE ${slice.page} -->\n${slice.text.trim()}`).join('\n')
      const offset = Math.max(0, Math.trunc(asNumber(args.offset) ?? 0))
      const slice = joined.slice(offset, offset + maxChars)
      const truncated = offset + slice.length < joined.length

      const value: ReadValue = {
        handle,
        from_page: selection.from,
        to_page: selection.to,
        pages: numbered.length,
        chars: slice.length,
        truncated,
        content: slice,
      }
      if (truncated) {
        // 始终给 offset，而不是"剩余页"：区间内被切开时，重读同一区间只会拿到同样的开头
        value.next_offset = offset + slice.length
      }
      return value
    },
  }
}
