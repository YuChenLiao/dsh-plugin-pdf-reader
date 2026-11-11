import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildConvertArgv, classifyFailure, createFastEngine, PAGE_SEPARATOR, resolveFastConfig, UPSTREAM_VERSION } from '../lib/fast.js'

const JAR = 'C:/x/lib/opendataloader-pdf-cli.jar'

test('argv 带编码、headless、markdown、页分隔符、stdout、不产图', () => {
  const argv = buildConvertArgv('java', JAR, { input: 'D:/a/b.pdf' })
  assert.equal(argv[0], 'java')
  assert.deepEqual(argv.slice(1, 4), ['-Dfile.encoding=UTF-8', '-Djava.awt.headless=true', '-jar'])
  assert.equal(argv[4], JAR)
  assert.equal(argv[5], 'D:/a/b.pdf')
  for (const flag of ['--format', 'markdown', '--markdown-page-separator', '--to-stdout', '--image-output', 'off']) {
    assert.ok(argv.includes(flag), `缺少 ${flag}`)
  }
  assert.ok(argv.includes(PAGE_SEPARATOR))
})

test('含空格与中文的路径作为单个数组元素，不被拆分', () => {
  const input = 'D:/我的 文档/前端 简历.pdf'
  const argv = buildConvertArgv('java', JAR, { input })
  assert.equal(argv.filter((a) => a === input).length, 1)
  assert.ok(!argv.some((a) => a === 'D:/我的' || a === '文档/前端'))
})

test('pages 透传为 --pages', () => {
  const argv = buildConvertArgv('java', JAR, { input: 'x.pdf', pages: '2-3' })
  const at = argv.indexOf('--pages')
  assert.ok(at >= 0)
  assert.equal(argv[at + 1], '2-3')
})

test('省略 pages 时不出现 --pages', () => {
  assert.ok(!buildConvertArgv('java', JAR, { input: 'x.pdf' }).includes('--pages'))
})

test('失败原因按 stderr 文案分类', () => {
  assert.equal(classifyFailure({ code: 1, stdout: '', stderr: "Error: 'a.txt' is not a PDF file. Input must be a PDF file." }).kind, 'not-pdf')
  assert.equal(classifyFailure({ code: 1, stdout: '', stderr: "'a.pdf' is not a valid PDF file (corrupted or truncated content)." }).kind, 'corrupted')
  assert.equal(classifyFailure({ code: 1, stdout: '', stderr: 'PDF is password protected' }).kind, 'encrypted')
  const other = classifyFailure({ code: 2, stdout: '', stderr: 'boom at Foo.java:12' })
  assert.equal(other.kind, 'engine-error')
  assert.match(other.message, /退出码 2/)
  assert.match(other.message, /boom at Foo\.java:12/)
})

test('convert 成功时返回 stdout 与引擎指纹', async () => {
  const seen = []
  const engine = createFastEngine(
    { tools: { register: () => () => {} } },
    resolveFastConfig({}),
    { jarOf: () => JAR, run: async (spec) => { seen.push(spec); return { code: 0, stdout: '<!-- PAGE 1 -->\n\n# 标题', stderr: '', timedOut: false, aborted: false } } },
  )
  const result = await engine.convert({ absPath: 'D:/a/b.pdf', signal: new AbortController().signal })
  assert.equal(result.engine, 'fast')
  assert.equal(result.engineVersion, UPSTREAM_VERSION)
  assert.equal(result.degraded, false)
  assert.match(result.markdown, /# 标题/)
  assert.equal(seen[0].cwd, 'D:/a')
})

test('convert 在 abort 时以 aborted 拒绝', async () => {
  const engine = createFastEngine(
    { tools: { register: () => () => {} } },
    resolveFastConfig({}),
    { jarOf: () => JAR, run: async () => ({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true }) },
  )
  await assert.rejects(engine.convert({ absPath: 'D:/a/b.pdf', signal: new AbortController().signal }), (error) => {
    assert.equal(error.kind, 'aborted')
    return true
  })
})

test('convert 在超时时以 timeout 拒绝并带引擎名与时长', async () => {
  const engine = createFastEngine(
    { tools: { register: () => () => {} } },
    resolveFastConfig({ timeoutMs: 120000 }),
    { jarOf: () => JAR, run: async () => ({ code: null, stdout: '', stderr: '', timedOut: true, aborted: false }) },
  )
  await assert.rejects(engine.convert({ absPath: 'D:/a/b.pdf', signal: new AbortController().signal }), (error) => {
    assert.equal(error.kind, 'timeout')
    assert.match(error.message, /fast/)
    assert.match(error.message, /120000/)
    return true
  })
})

test('jar 缺失时 available 关闭且 convert 报 unavailable', async () => {
  const engine = createFastEngine(
    { tools: { register: () => () => {} } },
    resolveFastConfig({}),
    { jarOf: () => null, run: async () => { throw new Error('不该被调用') } },
  )
  const availability = await engine.available()
  assert.equal(availability.ok, false)
  assert.match(availability.reason, /@opendataloader\/pdf@2\.5\.20/)
  await assert.rejects(engine.convert({ absPath: 'D:/a/b.pdf', signal: new AbortController().signal }), (error) => {
    assert.equal(error.kind, 'unavailable')
    return true
  })
})
