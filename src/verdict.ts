/**
 * 三档判定。阈值不是拍脑袋定的，来自 25 份真实样本的分布
 * （见 docs/metrics-distribution.md §校准观察）：
 * - 文本类 empty_page_ratio ≤ 0.01，图像页恒为 1.0
 * - 英文论文 last_page_ratio 最低 0.0695（末页是参考文献结尾）
 * - 中文真实文档 cjk_ratio 最低 0.378
 * - 英文论文 single_char_line_ratio 最高 0.086
 */
import type { EngineName } from './engines.ts'
import type { Metrics } from './metrics.ts'

export interface Thresholds {
  failed: {
    replacement_ratio: number
    control_ratio: number
  }
  suspect: {
    /** 首部 CJK 占比下限：低于它说明"看起来不是中文文档"，就不该套用中文乱码判定。 */
    head_cjk_min: number
    /** 全文 CJK 占比下限：低于它且首部是中文，判编码异常。 */
    cjk_ratio_min: number
    avg_chars_per_line_min: number
    single_char_line_ratio_max: number
    empty_page_ratio_max: number
    last_page_ratio_min: number
    /** last_page_ratio 只在"平均每页字符数够多"时参与判定，扫描件另有信号。 */
    last_page_min_chars_per_page: number
  }
}

/** 每条 suspect 的扣分权重，集中在这里便于校准。 */
export const SUSPECT_WEIGHTS = {
  cjk_ratio: 25,
  empty_pages: 30,
  last_page: 15,
  avg_chars_per_line: 20,
  single_char_line: 15,
} as const

export const FAST_THRESHOLDS: Thresholds = {
  failed: { replacement_ratio: 0.005, control_ratio: 0.02 },
  suspect: {
    head_cjk_min: 0.05,
    cjk_ratio_min: 0.25,
    avg_chars_per_line_min: 5,
    single_char_line_ratio_max: 0.3,
    empty_page_ratio_max: 0.2,
    last_page_ratio_min: 0.05,
    last_page_min_chars_per_page: 100,
  },
}

/** hybrid 产出质量更高，阈值暂与 fast 一致；后续按样本再收紧。 */
export const HYBRID_THRESHOLDS: Thresholds = FAST_THRESHOLDS

/** fallback 的阅读顺序不可靠，行/占比类指标全部失真，只判 failed。 */
export const FALLBACK_THRESHOLDS: Thresholds = FAST_THRESHOLDS

export function thresholdsOf(engine: EngineName): Thresholds {
  if (engine === 'hybrid') return HYBRID_THRESHOLDS
  if (engine === 'fallback') return FALLBACK_THRESHOLDS
  return FAST_THRESHOLDS
}

export type Verdict = 'ok' | 'suspect' | 'failed' | 'unknown'

export interface Judgment {
  verdict: Verdict
  score: number
  issues: string[]
}

const pct = (value: number): string => (value * 100).toFixed(2).replace(/\.?0+$/, '')

/**
 * 判定一份转换结果。
 * @param metrics - computeMetrics 的输出。
 * @param engine - 产出它的引擎；fallback 不参与 suspect 判定。
 * @param judgeEnabled - 关闭时恒返回 unknown（阶段 2 行为）。
 * @returns 判定、分数与可读问题列表。
 */
export function judge(metrics: Metrics, engine: EngineName, judgeEnabled = true): Judgment {
  if (!judgeEnabled) return { verdict: 'unknown', score: 0, issues: [] }

  const thresholds = thresholdsOf(engine)
  const issues: string[] = []

  // 提取不到任何文本不是"转换坏了"，而是这类引擎不适用于这份文档：判 suspect，
  // 并明确指向扫描件/图片版，让模型知道该换 hybrid 或直接放弃提取正文。
  if (metrics.nonspace_chars === 0) {
    return {
      verdict: 'suspect',
      score: 10,
      issues: ['没有任何文本（只有空白）：疑似扫描件或图片版文档，当前引擎没有文本层'],
    }
  }
  if (metrics.replacement_ratio > thresholds.failed.replacement_ratio) {
    return {
      verdict: 'failed',
      score: 0,
      issues: [`replacement_ratio ${pct(metrics.replacement_ratio)}：提取出大量替换字符 U+FFFD，编码已损坏`],
    }
  }
  if (metrics.control_ratio > thresholds.failed.control_ratio) {
    return {
      verdict: 'failed',
      score: 0,
      issues: [`control_ratio ${pct(metrics.control_ratio)}：控制字符占比过高，内容不可用`],
    }
  }

  // fallback 的阅读顺序按 PDF 绘制顺序，行与占比类指标不可信：只判到 failed 为止
  if (engine === 'fallback') return { verdict: 'ok', score: 60, issues: [] }

  let score = 100
  const suspect = thresholds.suspect

  if (metrics.head_cjk_ratio >= suspect.head_cjk_min && metrics.cjk_ratio < suspect.cjk_ratio_min) {
    score -= SUSPECT_WEIGHTS.cjk_ratio
    issues.push(`cjk_ratio ${pct(metrics.cjk_ratio)}：首部是中文（${pct(metrics.head_cjk_ratio)}）但全文中文占比过低，疑似编码错`)
  }
  if (metrics.avg_chars_per_line < suspect.avg_chars_per_line_min) {
    score -= SUSPECT_WEIGHTS.avg_chars_per_line
    issues.push(`avg_chars_per_line ${metrics.avg_chars_per_line.toFixed(1)}：平均行长过短，疑似版面被切成碎片`)
  }
  if (metrics.single_char_line_ratio > suspect.single_char_line_ratio_max) {
    score -= SUSPECT_WEIGHTS.single_char_line
    issues.push(`single_char_line_ratio ${pct(metrics.single_char_line_ratio)}：单字符行过多，疑似逐字断行`)
  }
  if (metrics.empty_page_ratio > suspect.empty_page_ratio_max) {
    score -= SUSPECT_WEIGHTS.empty_pages
    issues.push(`empty_pages ${metrics.empty_pages}/${metrics.pages}：疑似扫描件，当前引擎没有文本层`)
  }
  const charsPerPage = metrics.pages === 0 ? 0 : metrics.chars / metrics.pages
  if (charsPerPage >= suspect.last_page_min_chars_per_page && metrics.last_page_ratio < suspect.last_page_ratio_min) {
    score -= SUSPECT_WEIGHTS.last_page
    issues.push(`last_page_ratio ${pct(metrics.last_page_ratio)}：末页几乎为空，疑似截断`)
  }

  if (issues.length > 0) return { verdict: 'suspect', score: Math.max(0, score), issues }
  return { verdict: 'ok', score: 100, issues: [] }
}
