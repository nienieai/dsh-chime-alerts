// ============================================================
// dsh-chime-alerts · 静态宿主入口（npm 包主入口 main/exports["."]）
//
// 与 lib/host.js 是同一份宿主逻辑：本文件把 host.js 的函数体
// 包装成标准 Cordis 插件供静态安装使用。静态环境中不存在动态
// 包的 harness 桥（客户端-宿主 RPC），host.js 内部已做 typeof
// 守卫——handlers 静默不注册，但事件记录与系统蜂鸣照常工作。
//
// 静态宿主半是真实的 Node 宿主模块（与 dsh-liquid-glass-balance-card
// 同形态），设置/音频文件直接走 node:fs 读写 DSH 数据目录
// %DSH_HOME%\plugins\dsh-chime-alerts；动态环境（harness 桥）仍走
// 会话沙箱 fs，两套路径保持互不干扰。
//
// Cordis loader 只识别顶层命名导出 inject / apply（参照社区验证的
// dsh-plugin-notify-sound 形态），因此这里用命名导出而不是默认
// 导出函数——否则 inject 不被读取，apply 里用 ctx.timeout 会报
// "cannot get property 'timer' without inject"。
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, readFileSync as rf, existsSync, renameSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const body = readFileSync(fileURLToPath(new URL('./host.js', import.meta.url)), 'utf8')
const makePlugin = new Function('ctx', 'harness', '__nodeIo', '"use strict";\n' + body)

export const name = 'dsh-chime-alerts'

// host.js 的函数体声明 inject: ['timer']；静态入口必须把该依赖
// 提升为顶层导出，Cordis 才会注入 timer 服务（apply 内使用 ctx.timeout）。
export const inject = ['timer']

// 静态模式的 node:fs 直通车：绕过会话沙箱写入 DSH 数据目录。
// 只在无 harness 桥（静态安装）时生效；动态模式用沙箱 fs，不触碰这里。
const nodeIo = {
  isStatic: true,
  readText(absPath) { return rf(absPath, 'utf8') },
  writeText(absPath, content) {
    mkdirSync(dirname(absPath), { recursive: true })
    const tmp = absPath + '.tmp'
    writeFileSync(tmp, content, 'utf8')
    try { renameSync(tmp, absPath) } catch (err) { rmSync(tmp, { force: true }); throw err }
    return { version: 1 }
  },
  exists(absPath) { return existsSync(absPath) },
  join: join,
  dirname: dirname,
}

export function apply(ctx) {
  // makePlugin 返回 host.js 的插件对象（含自己的 apply），
  // 这里调用它的 apply(ctx) 完成事件监听与系统蜂鸣注册。
  const plugin = makePlugin(ctx, void 0, nodeIo)
  return plugin.apply(ctx)
}
