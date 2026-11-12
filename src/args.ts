/** 模型边界上的参数处理：tool 调用里的数字可能是字符串，路径可能是相对/`~` 形式。 */
import { homedir } from 'node:os'
import { isAbsolute, resolve as resolvePath } from 'node:path'

/**
 * 把模型给的数字转成数字。
 *
 * 实测 tool 调用里 `page: 13` 会以字符串 `"13"` 到达；不做转换就会静默退化成
 * "全篇 + 截断"（code review 遗留项）。工具边界上的值一律当不可信输入处理。
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

/** `~` 展开，优先 DSH_HOME。 */
export function expandHome(input: string): string {
  if (!input.startsWith('~')) return resolvePath(input)
  const home = process.env.DSH_HOME ?? homedir()
  return resolvePath(`${home}${input.slice(1)}`)
}

/** 输入路径：绝对路径、工作区相对路径，或 `~` 开头。 */
export function resolveInputPath(input: string): string {
  if (input.startsWith('~')) return expandHome(input)
  return isAbsolute(input) ? input : resolvePath(process.cwd(), input)
}
