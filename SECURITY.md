# 安全说明

本插件会调用系统能力发声、弹系统通知，并在宿主进程里开几个本地 HTTP 端点。这里说明它具体做了什么、边界在哪、以及怎么报告问题。

## 它访问什么

| 能力 | 用途 | 实现 |
|---|---|---|
| 本地 HTTP 端点（仅 `dsh web` 存在时注册） | 设置页读写宿主设置、试听、事件增量下发 | 5 条 `exact` 路由，见下 |
| 子进程 | 播放系统音、弹系统通知 | Windows：`wscript.exe`（播 `.vbs`）/ `powershell.exe`（WinRT toast）；macOS：`afplay`、`osascript`；Linux：`canberra-gtk-play`、`paplay`、`notify-send` |
| 文件写入 | 宿主设置、音频库、临时脚本 | `$DSH_HOME/plugins/dsh-chime-alerts/`（Windows 为 `%USERPROFILE%\.dsh\plugins\dsh-chime-alerts`） |
| 浏览器存储 | 网页响铃/通知配置、自定义音频 | `localStorage`（`dsh-chime-alerts-v1`） |

**没有网络外联**：除上面的本地端点外，插件不向任何第三方域名发请求；事件下发只含事件种类、会话 id、时间戳，不含会话标题与工作区名（标题只在浏览器本地拼进通知正文）。

## 本地端点的鉴权（v0.6.1 起）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET/HEAD | `/dsh-chime-alerts/sysget` | 读宿主设置与能力探测结果 |
| POST | `/dsh-chime-alerts/sysset` | 写宿主设置 |
| POST | `/dsh-chime-alerts/sysbeep` | 试听宿主音 |
| POST | `/dsh-chime-alerts/sysnotify` | 试发宿主通知 |
| GET/HEAD | `/dsh-chime-alerts/events?after=N` | 浏览器拉取待播事件 |

DSH 的 `webServer` 只按路径派发，**不给插件路由做鉴权**（Host/Origin 与会话校验只做在 `/api` 通道上）。因此本插件自己接 `ctx.connection.requestRejection({ headers })`：没有会话凭据或跨站请求一律 401/403；没有 `connection` 服务的组合下退回「Origin 必须与 Host 同源、Host 必须是 loopback」的判定。

另有限制：请求体上限 64KB（超限 413）；试听端点限流（同事件 700ms、全局 10 次/10s，超限 429）；`hostSounds` 只接受设置页下拉里存在的枚举值（防止任意字符串被拼进 `.vbs` / 播放器参数）。

## 已知的信任边界

- **本机用户即同权限**：能读写你的用户目录、能以你的身份跑进程的本地程序，不受上面这些约束。
- **杀毒软件**：Windows 的系统通知需要借 `powershell.exe` 调 WinRT，且是隐藏窗口运行；部分安全软件（如火绒）会把「隐藏运行 PowerShell」判为可疑并弹窗。插件默认不启用宿主提醒，开启时会弹窗说明；介意就只用「响铃」或关闭。macOS/Linux 的通知不经过 PowerShell。
- **浏览器通知**依赖页面授权；页面关闭后只有宿主侧（响铃/通知）照常工作。
- **动态安装**：`cordis_define` 粘贴的是纯 JS 源码（`dynamic/host.body.js` + `lib/client.js`），可在激活前逐行审阅；插件不下载、不执行任何外部代码。

## 供应链

- 无运行时依赖（`peerDependencies` 只有 `@deepseek-ai/cordis`，由宿主提供）。
- 仓库内**没有预编译二进制**，也没有 `preinstall`/`install`/`postinstall` 钩子。
- 发布的 tarball 只含 `lib/`、`dynamic/`、`cordis.patch.yml`、`docs/`、`CHANGELOG.md`、`README.md`、`SECURITY.md`；`tools/`（测试与截图脚本）不随包发布。

## 报告问题

发现漏洞请在 GitHub 开 issue（若是敏感细节，请先只写「需要私下沟通」与影响范围，我会给一个私下渠道）：<https://github.com/nienieai/dsh-chime-alerts/issues>

请附上：DSH 版本、操作系统、插件版本（设置页底部可见）、复现步骤。
