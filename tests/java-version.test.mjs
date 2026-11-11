import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJavaVersion } from '../lib/index.js'

test('解析 openjdk 17', () => {
  const raw = 'openjdk version "17.0.11" 2024-04-16 LTS\nOpenJDK Runtime Environment (build 17.0.11+9-LTS-207)'
  assert.equal(parseJavaVersion(raw), 17)
})

test('解析 java 8 的 1.x 写法', () => {
  assert.equal(parseJavaVersion('java version "1.8.0_391"'), 8)
})

test('解析裸版本号写法', () => {
  assert.equal(parseJavaVersion('openjdk 21.0.1 2023-10-17'), 21)
})

test('无法识别时返回 null', () => {
  assert.equal(parseJavaVersion('command not found'), null)
  assert.equal(parseJavaVersion(''), null)
})
