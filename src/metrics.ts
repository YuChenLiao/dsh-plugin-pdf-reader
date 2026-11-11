/**
 * 质量指标：全部从 Markdown 计算，不读上游 JSON（JSON 带 bbox，几十 MB）。
 * Markdown 自带结构标记：`#` 标题、`|` 表格、`- `/`1. ` 列表、页分隔符分页。
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/
const CJK_ALL = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g
const PAGE_SEPARATOR = /<!--\s*PAGE\s+\d+\s*-->/g

export interface Metrics {
  /** 字符总数（不含页分隔符）。 */
  chars: number
  /** 非空白字符数：只有空白等于"没提取到任何内容"。 */
  nonspace_chars: number
  /** 页数（按分隔符切分）。 */
  pages: number
  /** 首部 2000 字符的 CJK 占比：用来区分"本该是中文却提取成乱码"与"本来就是英文文档"。 */
  head_cjk_ratio: number
  replacement_ratio: number
  control_ratio: number
  private_use_ratio: number
  cjk_ratio: number
  question_run_max: number
  avg_chars_per_line: number
  single_char_line_ratio: number
  line_end_punct_ratio: number
  page_char_variance: number
  empty_pages: number
  empty_page_ratio: number
  /** 第一个空页的页码（1 起）；没有则为 0。用于 suggest 指向该页。 */
  first_empty_page: number
  last_page_ratio: number
  tables: number
  headings: number
  image_only_hint: boolean
}

/** 按页分隔符切页，去掉分隔符本身。 */
export function splitPages(markdown: string): string[] {
  const parts = markdown.split(PAGE_SEPARATOR)
  // 首段可能是分隔符前的空串
  if (parts.length > 1 && parts[0]?.trim() === '') return parts.slice(1)
  return parts.length === 0 ? [''] : parts
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number)
}

function countCjk(text: string): number {
  return (text.match(CJK_ALL) ?? []).length
}

/**
 * 计算全部指标。
 * @param markdown - 含页分隔符的 Markdown。
 * @returns 指标对象；`tables`/`headings` 是正则计数。
 */
export function computeMetrics(markdown: string): Metrics {
  const text = markdown.replace(PAGE_SEPARATOR, '')
  const chars = text.length
  const pageTexts = splitPages(markdown)
  // 分隔符换行会带出空白，不计入页内容长度
  const pageLengths = pageTexts.map((page) => page.trim().length)

  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  const nonSpace = text.replace(/\s/g, '')

  const replacementChars = (text.match(/\uFFFD/g) ?? []).length
  let controlChars = 0
  for (const char of text) {
    const code = char.codePointAt(0) as number
    const isControl = (code < 0x20 && char !== '\n' && char !== '\t' && char !== '\r') || (code >= 0x7F && code <= 0x9F)
    if (isControl) controlChars += 1
  }
  const privateUse = (text.match(/[\uE000-\uF8FF]/g) ?? []).length

  const questionRun = Math.max(0, ...(text.match(/\?+/g) ?? []).map((run) => run.length))

  const avgCharsPerLine = lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + line.length, 0) / lines.length
  const singleCharLines = lines.filter((line) => line.trim().length <= 1).length
  const punctLines = lines.filter((line) => /[。．.！!？?；;:：]$/.test(line.trim())).length

  const mean = pageLengths.length === 0 ? 0 : pageLengths.reduce((a, b) => a + b, 0) / pageLengths.length
  const variance = pageLengths.length === 0
    ? 0
    : pageLengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / pageLengths.length
  const cv = mean === 0 ? 0 : Math.sqrt(variance) / mean

  const emptyPages = pageLengths.filter((length) => length < 20).length
  const emptyPageRatio = ratio(emptyPages, pageLengths.length)
  // 中位数只取非空页：空页成片时（扫描件）若把空页算进中位数，末页比例会被抬到失真
  const nonEmptyLengths = pageLengths.filter((length) => length >= 20)
  const pageMedian = median(nonEmptyLengths.length > 0 ? nonEmptyLengths : pageLengths)
  const lastPageRatio = pageMedian === 0 ? 0 : (pageLengths.at(-1) ?? 0) / pageMedian

  const tableLines = text.split(/\r?\n/).filter((line) => /^\s*\|/.test(line)).length
  const tables = tableLines > 0 ? text.split(/\r?\n/).reduce((count, line, index, all) => {
    const isRow = /^\s*\|/.test(line)
    const prevRow = index > 0 && /^\s*\|/.test(all[index - 1] as string)
    return isRow && !prevRow ? count + 1 : count
  }, 0) : 0
  const headings = (text.match(/^\s*#{1,6}\s+\S/gm) ?? []).length

  return {
    chars,
    nonspace_chars: nonSpace.length,
    pages: pageTexts.length,
    head_cjk_ratio: ratio(countCjk(text.slice(0, 2000).replace(/\s/g, '')), text.slice(0, 2000).replace(/\s/g, '').length),
    replacement_ratio: ratio(replacementChars, chars),
    control_ratio: ratio(controlChars, chars),
    private_use_ratio: ratio(privateUse, chars),
    cjk_ratio: ratio(countCjk(nonSpace), nonSpace.length),
    question_run_max: questionRun,
    avg_chars_per_line: avgCharsPerLine,
    single_char_line_ratio: ratio(singleCharLines, lines.length),
    line_end_punct_ratio: ratio(punctLines, lines.length),
    page_char_variance: cv,
    empty_pages: emptyPages,
    empty_page_ratio: emptyPageRatio,
    first_empty_page: pageLengths.findIndex((length) => length < 20) + 1,
    last_page_ratio: lastPageRatio,
    tables,
    headings,
    image_only_hint: emptyPageRatio > 0.2 || (pageTexts.length > 0 && chars / pageTexts.length < 100),
  }
}

/** 粗略 token 估算：中文约 0.6 token/字符（用于判定块展示，不参与判定）。 */
export function estimateTokens(chars: number): number {
  return Math.round(chars * 0.6)
}

export { CJK }
