#!/usr/bin/env node
// 四个入口各打一个 bundle：工具层（index）+ 三个引擎组件。
// 用 bundle 而不是逐文件编译，是为了让 link: 安装时 lib/ 直接可跑，不需要 runtime 解析相对路径。
import { build } from 'esbuild'

const entries = {
  index: 'src/plugin.ts',
  fast: 'src/engines/fast.ts',
  hybrid: 'src/engines/hybrid.ts',
  fallback: 'src/engines/fallback.ts',
}

const watch = process.argv.includes('--watch')

for (const [out, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [entry],
    outfile: `lib/${out}.js`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    minify: false,
    // 引擎依赖在运行时按需解析，不进 bundle
    external: ['@opendataloader/pdf', '@hyzyla/pdfium', 'node:*'],
    logLevel: watch ? 'info' : 'warning',
  })
  console.log(`built lib/${out}.js`)
}
