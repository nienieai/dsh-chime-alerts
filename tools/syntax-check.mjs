// 语法检查：v0.6.1 起 lib/host.js 是 ESM 模块（node --check 直接验），
// dynamic/host.body.js 与 lib/client.js 仍是“函数体”形态，包进 new Function 验解析；
// client.web.js 是完整经典脚本，用 node --check 验证（npm run check 已含）。
// 用法：node tools/syntax-check.mjs（npm run check 的一部分）
import { readFileSync } from 'node:fs'

let failed = false
const targets = [
  ['dynamic/host.body.js', ['ctx', 'harness', '__nodeIo']],
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
// 版本一致性：设置页底部那句「静态版 vX.Y.Z」/「动态版 vX.Y.Z」是手写常量，
// 0.6.0 → 0.6.1 时忘改过（页脚仍显示 v0.6.0）。这里与 package.json 比对，漏改直接 FAIL。
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const checks = [
    ['lib/client.web.js', /versionText\(\)\s*\{\s*return T\('静态版 v([0-9]+\.[0-9]+\.[0-9]+)'/],
    ['lib/client.js', /versionText\(\)\s*\{\s*return T\('动态版 v([0-9]+\.[0-9]+\.[0-9]+)'/],
  ]
  for (const [file, re] of checks) {
    const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    const m = src.match(re)
    if (m === null) {
      failed = true
      console.error('FAIL ' + file + ': versionText literal not found')
    } else if (m[1] !== pkg.version) {
      failed = true
      console.error('FAIL ' + file + ': versionText v' + m[1] + ' != package.json ' + pkg.version)
    } else {
      console.log('OK   ' + file + ' version v' + m[1])
    }
  }
}
process.exitCode = failed ? 1 : 0
