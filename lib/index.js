// ============================================================
// dsh-chime-alerts · 静态宿主入口（npm 包主入口 main/exports["."]）
//
// 与 lib/host.js 是同一份宿主逻辑：本文件把 host.js 的函数体
// 包装成标准 Cordis 插件供静态安装使用。静态环境中不存在动态
// 包的 harness 桥（客户端-宿主 RPC），host.js 内部已做 typeof
// 守卫——handlers 静默不注册，但事件记录与系统蜂鸣照常工作。
//
// Cordis loader 只识别顶层命名导出 inject / apply（参照社区验证的
// dsh-plugin-notify-sound 形态），因此这里用命名导出而不是默认
// 导出函数——否则 inject 不被读取，apply 里用 ctx.timeout 会报
// "cannot get property 'timer' without inject"。
// ============================================================
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const body = readFileSync(fileURLToPath(new URL('./host.js', import.meta.url)), 'utf8')
const makePlugin = new Function('ctx', 'harness', '"use strict";\n' + body)

export const name = 'dsh-chime-alerts'

// host.js 的函数体声明 inject: ['timer']；静态入口必须把该依赖
// 提升为顶层导出，Cordis 才会注入 timer 服务（apply 内使用 ctx.timeout）。
export const inject = ['timer']

export function apply(ctx) {
  // makePlugin 返回 host.js 的插件对象（含自己的 apply），
  // 这里调用它的 apply(ctx) 完成事件监听与系统蜂鸣注册。
  const plugin = makePlugin(ctx, void 0)
  return plugin.apply(ctx)
}
