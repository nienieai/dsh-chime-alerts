// ============================================================
// dsh-chime-alerts · 静态宿主入口（npm 包主入口 main/exports["."]）
//
// v0.6.1 起不再用 new Function 把 lib/host.js 当字符串编译：host.js 本身是 ESM
// 模块，导出 createHostPlugin(ctx, harness, nodeIo) 工厂；这里只是把静态安装
// 需要的 node:fs 直通车（nodeIo）注进去，再交给 Cordis。
// 这样发布的代码里没有任何动态执行，静态扫描/审计/打包都能正常分析。
//
// 与动态安装的关系：动态安装（cordis_define 的 code.host）需要的仍是「可粘贴的
// 函数体」，由 tools/build-body.mjs 从 lib/host.js 生成到 dynamic/host.body.js，
// 两边的 apply 逻辑是同一份源码。
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { createHostPlugin } from './host.js'

export const name = 'dsh-chime-alerts'

// host.js 的函数体声明 inject: ['timer']；静态入口必须把该依赖提升为顶层导出，
// Cordis 才会注入 timer 服务（apply 内使用 ctx.timeout）。
export const inject = ['timer']

// 静态模式的 node:fs 直通车：绕过会话沙箱写入 DSH 数据目录。
// 只在无 harness 桥（静态安装）时生效；动态模式用沙箱 fs，不触碰这里。
const nodeIo = {
  isStatic: true,
  readText(absPath) { return readFileSync(absPath, 'utf8') },
  writeText(absPath, content) {
    mkdirSync(dirname(absPath), { recursive: true })
    const tmp = absPath + '.tmp'
    writeFileSync(tmp, content, 'utf8')
    try { renameSync(tmp, absPath) } catch (err) { rmSync(tmp, { force: true }); throw err }
  },
  exists(absPath) { return existsSync(absPath) },
  // v0.6.1：spawn 失败时清理临时 .vbs/.ps1（脚本自删只在它真被跑起来时才生效）
  rm(absPath) { rmSync(absPath, { force: true }) },
  join: join,
  dirname: dirname,
}

export function apply(ctx) {
  const plugin = createHostPlugin(ctx, void 0, nodeIo)
  return plugin.apply(ctx)
}
