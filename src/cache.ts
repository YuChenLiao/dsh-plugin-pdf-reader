/** 结果落盘：sha256 键、handle 寻址、按文件反查的多引擎索引。 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

export const HANDLE_LENGTH = 12
const RECENT_LIMIT = 200

export interface CacheParams {
  pages?: string
  separator: string
}

export interface CacheEntryRef {
  handle: string
  engine: string
  engineVersion: string
  params: CacheParams
  pages: number
  chars: number
  degraded: boolean
  cachedAt: string
}

export interface FileIndex {
  fileSha256: string
  entries: CacheEntryRef[]
}

export interface CacheMeta extends CacheEntryRef {
  fileSha256: string
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  /** 正文里实际出现的原始页码（有序）。pdf_read 靠它把页码映射到正文位置。 */
  pageNumbers: number[]
  /** 正文交付尺寸：含页标记的 body.md 字符数。inline 判定必须用它，不能用剥离标记后的 chars。 */
  bodyChars: number
  stats: Record<string, number>
  issues?: string[]
  score?: number
  verdict?: string
}

export interface CacheEntry {
  dir: string
  body: string
  meta: CacheMeta
}

/** `~` 展开，与宿主一致优先 DSH_HOME。 */
export function expandHome(input: string): string {
  if (!input.startsWith('~')) return resolvePath(input)
  const home = process.env.DSH_HOME ?? homedir()
  return resolvePath(`${home}${input.slice(1)}`)
}

/** 稳定序列化参数：键序固定，避免同样参数算出不同签名。 */
export function paramsSignature(params: CacheParams): string {
  return JSON.stringify({ pages: params.pages ?? '', separator: params.separator })
}

/**
 * 算 handle：内容 + 引擎指纹 + 参数指纹，取前 12 位十六进制。
 * 引擎指纹必须参与：否则换引擎后会命中旧引擎的结果。
 * @param fileSha256 - 文件内容哈希。
 * @param engine - 引擎名。
 * @param engineVersion - 引擎版本。
 * @param params - 转换参数。
 * @returns 12 位 handle，同时是缓存目录名。
 */
export function cacheKey(fileSha256: string, engine: string, engineVersion: string, params: CacheParams): string {
  return createHash('sha256')
    .update(`${fileSha256}:${engine}:${engineVersion}:${paramsSignature(params)}`)
    .digest('hex')
    .slice(0, HANDLE_LENGTH)
}

/**
 * 流式算文件 sha256。
 * @param path - 文件绝对路径。
 * @returns 十六进制摘要。
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

const indexDir = (cacheDir: string): string => join(cacheDir, 'index')
const fileIndexPath = (cacheDir: string, fileSha256: string): string => join(indexDir(cacheDir), `${fileSha256.slice(0, HANDLE_LENGTH)}.json`)
const recentPath = (cacheDir: string): string => join(indexDir(cacheDir), '_recent.json')

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, path)
}

/**
 * 写入一次转换结果并更新索引。
 * @param cacheDir - 缓存根目录。
 * @param entry - 正文与元数据。
 */
export async function writeEntry(cacheDir: string, entry: { handle: string; body: string; meta: CacheMeta }): Promise<void> {
  const dir = join(cacheDir, entry.handle)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'body.md'), entry.body, 'utf8')
  await writeJson(join(dir, 'meta.json'), entry.meta)
  await writeJson(join(dir, 'source.json'), {
    path: entry.meta.sourcePath,
    size: entry.meta.sourceSize,
    mtimeMs: entry.meta.sourceMtimeMs,
    sha256: entry.meta.fileSha256,
    params: entry.meta.params,
  })

  const ref: CacheEntryRef = {
    handle: entry.meta.handle,
    engine: entry.meta.engine,
    engineVersion: entry.meta.engineVersion,
    params: entry.meta.params,
    pages: entry.meta.pages,
    chars: entry.meta.chars,
    degraded: entry.meta.degraded,
    cachedAt: entry.meta.cachedAt,
  }
  const indexPath = fileIndexPath(cacheDir, entry.meta.fileSha256)
  const index = (await readJson<FileIndex>(indexPath)) ?? { fileSha256: entry.meta.fileSha256, entries: [] }
  index.entries = [...index.entries.filter((item) => item.handle !== ref.handle), ref]
  await writeJson(indexPath, index)

  const recent = (await readJson<CacheEntryRef[]>(recentPath(cacheDir))) ?? []
  await writeJson(recentPath(cacheDir), [ref, ...recent.filter((item) => item.handle !== ref.handle)].slice(0, RECENT_LIMIT))
}

/**
 * 按文件内容与参数查缓存：命中返回最新一份，**不触发任何引擎探测**。
 * @param cacheDir - 缓存根目录。
 * @param fileSha256 - 文件内容哈希。
 * @param params - 转换参数。
 * @returns 命中的条目；无命中返回 null。
 */
export async function lookupFile(
  cacheDir: string,
  fileSha256: string,
  params: CacheParams,
  engine?: string,
): Promise<CacheEntry | null> {
  const index = await readJson<FileIndex>(fileIndexPath(cacheDir, fileSha256))
  if (index === null) return null
  const signature = paramsSignature(params)
  const matches = index.entries.filter((entry) => paramsSignature(entry.params) === signature
    && (engine === undefined || entry.engine === engine))
  if (matches.length === 0) return null
  matches.sort((a, b) => (a.cachedAt < b.cachedAt ? 1 : a.cachedAt > b.cachedAt ? -1 : 0))
  return readEntry(cacheDir, (matches[0] as CacheEntryRef).handle)
}

/**
 * 按 handle 读缓存。
 * @param cacheDir - 缓存根目录。
 * @param handle - 12 位句柄。
 * @returns 条目；不存在返回 null。
 */
export async function readEntry(cacheDir: string, handle: string): Promise<CacheEntry | null> {
  const dir = join(cacheDir, handle)
  const meta = await readJson<CacheMeta>(join(dir, 'meta.json'))
  if (meta === null) return null
  const body = await readFile(join(dir, 'body.md'), 'utf8').catch(() => null)
  if (body === null) return null
  return { dir, body, meta }
}

/**
 * 最近若干 handle，用于"handle 不存在"时给模型可用选项。
 * @param cacheDir - 缓存根目录。
 * @param limit - 条数上限。
 * @returns handle 列表（新到旧）。
 */
export async function recentHandles(cacheDir: string, limit = 5): Promise<string[]> {
  const recent = (await readJson<CacheEntryRef[]>(recentPath(cacheDir))) ?? []
  return recent.slice(0, limit).map((entry) => entry.handle)
}

/** 缓存目录总大小，pdf_ping 展示用。 */
export async function cacheSize(cacheDir: string): Promise<{ entries: number; bytes: number }> {
  const dirs = await readdir(cacheDir, { withFileTypes: true }).catch(() => [])
  let entries = 0
  let bytes = 0
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name === 'index') continue
    const meta = await readJson<CacheMeta>(join(cacheDir, dir.name, 'meta.json'))
    if (meta === null) continue
    entries += 1
    const bodyStat = await stat(join(cacheDir, dir.name, 'body.md')).catch(() => null)
    bytes += bodyStat?.size ?? 0
  }
  return { entries, bytes }
}
