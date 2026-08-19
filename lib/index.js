// ============================================================
// dsh-chime-alerts · 静态宿主入口（npm 包主入口 main/exports["."]）
//
// 与 lib/host.js 是同一份宿主逻辑：本文件把 host.js 的函数体
// 包装成标准 Cordis 插件供静态安装使用。静态环境中不存在动态
// 包的 harness 桥（客户端-宿主 RPC），host.js 内部已做 typeof
// 守卫——handlers 静默不注册，但事件记录与 PowerShell 系统蜂鸣
// 照常工作。
//
// 完整功能（浏览器声音 + 设置页）需要客户端半；静态双端安装的
// 官方契约与待办见 README「静态化路线图」。
// ============================================================
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const body = readFileSync(fileURLToPath(new URL('./host.js', import.meta.url)), 'utf8')
const makePlugin = new Function('ctx', 'harness', '"use strict";\n' + body)

/** 静态宿主插件：默认导出函数形式，接收 ctx 返回 Cordis 插件对象。 */
export default function dshChimeAlerts(ctx) {
  return makePlugin(ctx, void 0)
}

/** 插件名（loader 条目 / fiber 名）。 */
export const name = 'dsh-chime-alerts'
