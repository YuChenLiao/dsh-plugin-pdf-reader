/**
 * 页身份：分隔符的拼装、解析与按页切分。
 *
 * 单独成模块是为了让"页"只有一处定义 —— 早先分隔符常量住在 `upstream.ts`
 * （OpenDataLoader 的接触面），切分逻辑住在 `metrics.ts`，而 `pdf_read` 又自己按
 * 数组下标重编号，结果是读错页（code review C1）。
 */

/** 上游 CLI 的页分隔符模板；`%page-number%` 由上游替换为原文页码。 */
export const PAGE_SEPARATOR = '<!-- PAGE %page-number% -->'

/** 匹配正文里已经落地的页标记。 */
export const PAGE_MARK_PATTERN = /<!--\s*PAGE\s+(\d+)\s*-->/g

export interface PageSlice {
  /** 分隔符里写的原始页码。 */
  page: number
  text: string
}

/**
 * 生成真实页标记（上游自己替换模板，兜底引擎要自己拼）。
 * @param page - 原文页码。
 * @returns 与上游完全一致的标记。
 */
export function pageMarker(page: number): string {
  return PAGE_SEPARATOR.replace('%page-number%', String(page))
}

/**
 * 按页标记切分，保留每页的原始页码。
 *
 * 页码必须来自标记本身：`--pages 5-8` 提取出的正文里第一条标记是 `PAGE 5`，
 * 但它在下标 0 上。
 * @param markdown - 含页标记的正文。
 * @returns 按出现顺序排列的页。
 */
export function splitPagesWithNumbers(markdown: string): PageSlice[] {
  const marks: Array<{ page: number; start: number; end: number }> = []
  PAGE_MARK_PATTERN.lastIndex = 0
  for (let match = PAGE_MARK_PATTERN.exec(markdown); match !== null; match = PAGE_MARK_PATTERN.exec(markdown)) {
    marks.push({
      page: Number.parseInt(match[1] as string, 10),
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  if (marks.length === 0) return [{ page: 1, text: markdown }]

  const slices: PageSlice[] = []
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index] as { page: number; end: number }
    const next = marks[index + 1]
    slices.push({ page: mark.page, text: markdown.slice(mark.end, next === undefined ? markdown.length : next.start) })
  }
  return slices
}

/** 只要正文、不要页码时的便捷包装。 */
export function splitPages(markdown: string): string[] {
  return splitPagesWithNumbers(markdown).map((slice) => slice.text)
}

/**
 * 解析 `1,3,5-7` 形式的页范围。
 * @param range - 页范围写法。
 * @param total - 总页数，用于夹取越界值。
 * @returns 命中的页码集合；写法非法时返回空集合。
 */
export function parsePageRange(range: string, total: number): Set<number> {
  const pages = new Set<number>()
  for (const part of range.split(',')) {
    const piece = part.trim()
    if (piece === '') continue
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(piece)
    if (match === null) continue
    const start = Math.max(1, Number.parseInt(match[1] as string, 10))
    const end = Math.min(total, match[2] === undefined ? start : Number.parseInt(match[2], 10))
    for (let page = start; page <= end; page += 1) pages.add(page)
  }
  return pages
}
