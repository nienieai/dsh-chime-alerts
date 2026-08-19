/**
 * dsh-chime-alerts 宿主端类型声明（对应 lib/index.js）。
 *
 * 宿主半职责（与动态插件 lib/host.js 同一份逻辑）：
 * - 监听 agent/status、session/event（approval/asked、goal/change）、
 *   tools/execute（ask_user_question / exit_plan_mode）、jobs.onJobDone；
 * - 记录事件缓冲供客户端拉取（动态桥），并按需触发 PowerShell 系统蜂鸣。
 *
 * 注意：静态安装只得到宿主半（记录 + 系统蜂鸣）；浏览器声音与设置页
 * 需要客户端半（静态双端契约见 README「静态化路线图」）。
 */
import type { Context } from '@deepseek-ai/cordis'

/** loader 条目 / fiber 名。 */
export const name: 'dsh-chime-alerts'

/**
 * 静态宿主插件入口：默认导出函数形式。
 * @param ctx - Cordis 插件上下文。
 * @returns 可挂载的 Cordis 插件对象。
 */
export default function dshChimeAlerts(ctx: Context): unknown
