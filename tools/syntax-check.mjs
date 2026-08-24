// 语法检查：把两个“函数体”形态的半文件包进 new Function 验证可解析；
// client.web.js 是完整经典脚本，用 node --check 验证（npm run check 已含）。
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
// client.web.js 以经典脚本形式加载：校验 window.__ModuleLoader__.load 封套存在
{
  const body = readFileSync(new URL('../lib/client.web.js', import.meta.url), 'utf8')
  if (body.indexOf('window.__ModuleLoader__.load') >= 0 && body.indexOf('factory: (require)') >= 0) {
    console.log('OK   lib/client.web.js (ModuleLoader wrapper)')
  } else {
    failed = true
    console.error('FAIL lib/client.web.js: ModuleLoader wrapper missing')
  }
}
process.exitCode = failed ? 1 : 0
