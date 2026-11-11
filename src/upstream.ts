/**
 * 上游 @opendataloader/pdf 的接触面：jar 定位、argv 拼装、失败分类。
 * 只用它的 `buildArgs`（参数表由上游维护），转换本身自己 spawn，才能接取消与超时。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { buildArgs } from '@opendataloader/pdf'
import type { FailureCause } from './engines.ts'
import type { RunResult } from './proc.ts'

/** 上游版本，精确锁；同时是缓存键里的引擎指纹。 */
export const UPSTREAM_VERSION = '2.5.20'

/** 页分隔符模板。`%page-number%` 由上游替换为原文页码，不重编号。 */
export const PAGE_SEPARATOR = '<!-- PAGE %page-number% -->'

/**
 * 生成真实页标记（上游 CLI 自己替换模板，兜底引擎要自己拼）。
 * @param page - 原文页码，1 起。
 * @returns 与上游一致的标记文本。
 */
export function pageMarker(page: number): string {
  return PAGE_SEPARATOR.replace('%page-number%', String(page))
}

/**
 * 解析 "1,3,5-7" 形式的页范围。
 * @param range - 页范围写法。
 * @param total - 总页数，用于夹取越界值。
 * @returns 命中页码集合；写法非法时返回空集合。
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

const JAR_NAME = 'opendataloader-pdf-cli.jar'

/**
 * 定位上游 jar。上游 `exports` 不导出 package.json，所以从入口文件反推。
 * @returns jar 绝对路径；未安装时返回 null。
 */
export function resolveJarPath(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('@opendataloader/pdf')
    const jar = join(dirname(entry), '..', 'lib', JAR_NAME)
    return existsSync(jar) ? jar : null
  } catch {
    return null
  }
}

export interface ConvertArgvRequest {
  input: string
  pages?: string
}

/**
 * 拼装完整 argv（含可执行文件本身，argv[0] 是 java）。`-Dfile.encoding=UTF-8` 必须显式给，
 * 否则 Windows 中文输出会变成问号。
 * @param javaBinary - java 可执行文件。
 * @param jarPath - jar 绝对路径。
 * @param request - 输入路径与可选页范围。
 * @returns 交给 spawn 的参数数组（路径作为单个元素，不会被拆分）。
 */
export function buildConvertArgv(javaBinary: string, jarPath: string, request: ConvertArgvRequest): string[] {
  const upstream = buildArgs({
    format: 'markdown',
    markdownPageSeparator: PAGE_SEPARATOR,
    imageOutput: 'off',
    toStdout: true,
    ...(request.pages === undefined ? {} : { pages: request.pages }),
  })
  return [
    javaBinary,
    '-Dfile.encoding=UTF-8',
    '-Djava.awt.headless=true',
    '-jar',
    jarPath,
    request.input,
    ...upstream,
  ]
}

export interface FailureClass {
  kind: FailureCause
  message: string
}

const STDERR_TAIL = 2048

/**
 * 按退出码与 stderr 文案分类失败原因。识别不了一律 engine-error，并保留 stderr 尾部。
 * @param result - 子进程结果。
 * @returns 失败类别与可读信息。
 */
export function classifyFailure(result: Pick<RunResult, 'code' | 'stdout' | 'stderr'>): FailureClass {
  const text = `${result.stderr}\n${result.stdout}`
  const tail = result.stderr.trim().slice(-STDERR_TAIL)
  if (/File or folder .* not found|No such file/i.test(text)) return { kind: 'missing-file', message: `路径不存在：${tail}` }
  if (/is not a PDF file/i.test(text)) return { kind: 'not-pdf', message: `不是 PDF 文件：${tail}` }
  if (/not a valid PDF file|corrupted or truncated/i.test(text)) return { kind: 'corrupted', message: `PDF 损坏或截断：${tail}` }
  if (/password|encrypted/i.test(text)) return { kind: 'encrypted', message: `PDF 已加密，需要密码：${tail}` }
  return { kind: 'engine-error', message: `上游 CLI 退出码 ${result.code ?? 'null'}：${tail}` }
}
