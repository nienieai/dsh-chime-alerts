// 语法检查：把两个“函数体”形态的半文件包进 new Function 验证可解析。
// 用法：node tools/syntax-check.mjs（npm run check 的一部分）
import { readFileSync } from 'node:fs'

let failed = false
const targets = [
  ['lib/host.js', ['ctx', 'harness']],
  ['lib/client.js', ['ctx', 'React', 'console', 'styles', 'host', 'harness']],
]
for (const [file, params] of targets) {
  const body = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  try {
    new Function(...params, body)
    console.log('OK   ' + file)
  } catch (err) {
    failed = true
    console.error('FAIL ' + file + ': ' + err.message)
  }
}
process.exitCode = failed ? 1 : 0
