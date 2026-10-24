// build-body.mjs — 从 ESM 的 lib/host.js 生成「可粘贴函数体」dynamic/host.body.js
//
// 背景：v0.6.1 把 lib/host.js 改成了 ESM 模块（导出一层 createHostPlugin 工厂），
// 这样静态入口 lib/index.js 可以直接 import，不需要 new Function 运行时编译。
// 但动态安装（cordis_define 的 code.host）要的是一段自包含的函数体，不能带
// import/export。这个脚本负责把工厂外壳剥掉，只留 `return { ... }` 本体。
//
// 用法：
//   node tools/build-body.mjs           重新生成 dynamic/host.body.js
//   node tools/build-body.mjs --verify  只校验是否与 lib/host.js 同步（npm run check / npm test 调用）
//
// 与 tools/chunk-src.mjs 的分工：本脚本产出正文本体，chunk-src 再把它序列化成
// .chunks/host.txt（按 1500 字符一帧，便于手工粘贴核对）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcPath = join(root, 'lib/host.js')
const outPath = join(root, 'dynamic/host.body.js')
const verifyOnly = process.argv.slice(2).includes('--verify')

const HEADER = [
  '// ============================================================',
  '// dsh-chime-alerts · 动态安装用宿主函数体（自动生成，请勿手改）',
  '//',
  '// 由 tools/build-body.mjs 从 lib/host.js 生成：去掉 createHostPlugin 工厂外壳，',
  '// 只保留 `return { inject, apply }` 本体。cordis_define 的 code.host 直接粘贴本文件全文。',
  '// 语义与静态安装完全一致（同一份源码），生成的 apply 里通过 typeof __nodeIo 探测，',
  '// 动态环境没有该标识符 → nodeIo 为 undefined，全部走 harness 桥与沙箱 fs。',
  '// ============================================================',
  ''
].join('\n')

const WALL = /^export function createHostPlugin\(ctx, harness, __nodeIo\) \{$/

const src = readFileSync(srcPath, 'utf8')
const lines = src.split('\n')
const start = lines.findIndex((line) => WALL.test(line))
if (start < 0) {
  console.error('build-body: lib/host.js 里找不到 createHostPlugin 外壳，拒绝生成')
  process.exit(1)
}
// 外壳的最后一行是文件末尾单独一个 `}`（跳过尾部空行）
let end = lines.length - 1
while (end > start && lines[end].trim() === '') end -= 1
if (lines[end].trim() !== '}') {
  console.error('build-body: lib/host.js 末尾不是工厂的收尾 `}`，拒绝生成')
  process.exit(1)
}
const body = lines.slice(start + 1, end).join('\n')
if (!/^\s*return \{/m.test(body)) {
  console.error('build-body: 函数体里没有 `return {`，拒绝生成')
  process.exit(1)
}

const expected = HEADER + body + '\n'

// 生成物必须是合法 JS 函数体（cordis_define 的 code.host 只会被当函数体求值）。
// 这里用 new Function 做一次语法校验：只解析我们自己的构建产物，不执行任何外部输入。
try {
  // eslint-disable-next-line no-new-func
  new Function('ctx', 'harness', body)
} catch (err) {
  console.error('build-body: 生成的函数体语法错误：' + String((err && err.message) || err))
  process.exit(1)
}

if (verifyOnly) {
  let actual = null
  try { actual = readFileSync(outPath, 'utf8') } catch (err) { actual = null }
  if (actual === null) {
    console.error('body: MISSING dynamic/host.body.js — run: node tools/build-body.mjs')
    process.exit(1)
  }
  if (actual !== expected) {
    console.error(`body: STALE dynamic/host.body.js (disk ${actual.length} chars, expected ${expected.length}) — run: node tools/build-body.mjs`)
    process.exit(1)
  }
  console.log(`body: up to date (${expected.length} chars)`)
  process.exit(0)
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, expected, 'utf8')
console.log(`body: wrote dynamic/host.body.js (${expected.length} chars, ${body.split('\n').length} lines)`)
