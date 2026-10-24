# dsh-chime-alerts · DSH 声音提醒插件

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 加一组轻量提醒：Agent 干完活、需要你批准、提交计划等你评审、有问题问你、目标受阻、后台任务完成/挂了，电脑响一声——不用一直盯着页面。

> ### ⚠️ 默认关闭
>
> - **宿主提醒默认关**：装好不会自己弹系统通知；要用得先在设置里打开「宿主提醒」，再逐个事件选「响铃」或「通知」。浏览器声音是另一条通道，默认已开六类。
> - **Windows 的系统通知会隐藏调用 PowerShell**（Node 无法直接调 WinRT，只能借它当桥）。部分杀毒软件（如「火绒」）会把「隐藏运行 PowerShell」判为可疑并弹窗，需要放行一次；介意的话请只用「响铃」或直接关掉。
> - macOS / Linux 的通知不经过 PowerShell（`osascript` / `notify-send`）。
> - 仓库内没有任何预编译二进制；toast 脚本运行时生成，可逐行审阅。

## 特性

- **十类事件**，每类独立开关 / 音色 / 音量：任务完成、子任务完成、后台任务完成、需要授权、插件授权、Agent 提问、计划评审、目标受阻、其他打断、后台任务失败
- **每个事件一个开关 + 宿主提醒三选一**：卡片开关决定要不要响（默认开「任务完成 / 需要授权 / Agent 提问 / 计划评审 / 目标受阻 / 后台任务失败」六类）；「宿主提醒」再选关 / 响铃 / 通知（静默 / 普通 / 重要）——选了响铃或通知就交给宿主，浏览器不再重复响。响铃走 Web Audio + 宿主系统音效，通知走系统通知中心，**关掉页面也能收到**
- **防双响**：网页响铃与宿主提醒都开着时出现，默认关；开启后**同一台设备只响一次**（只留宿主那一声），手机 / 另一台电脑各响各的
- **并行任务逐个响**（节流按种类 + 来源独立）；**中英双语**（跟随 DSH 语言设置）
- 声音可替换：内置音或上传自定义音频；内置音全部由浏览器合成，不附带音频文件
- Node 可跑的自动化测试：`npm test`，460 项断言
- **本地端点自行鉴权**（会话凭据 + Origin 校验）、请求体上限、试听限流；细节见 [SECURITY.md](SECURITY.md)

## 安装

**静态安装（推荐）**：

```sh
dsh plugin --profile web add dsh-chime-alerts
```

重启 DSH + 重开网页标签生效。若装了不加载，检查 profile 的 `package.json` 里 `dependencies` 有 `dsh-chime-alerts`、`dsh.profile.bundles` 也列了它，然后 `pnpm install` 再重启。

**动态安装（免安装，重启 DSH 后需重装）**：`cordis_define` 粘贴 `dynamic/host.body.js` + `lib/client.js` 全文（**必须同一个包**，否则 `update` 会把另一半卸载），再 `cordis_run` 激活。`dynamic/host.body.js` 由 `tools/build-body.mjs` 从 `lib/host.js` 生成，`npm run check` 会校验两者同步。

要求 Node ≥ 22.19（由 DSH 自身决定），包内声明了 `engines.dsh`，装到版本不匹配的 DSH 上会被拒绝。

## 跨平台

| | 响铃 | 系统通知 |
|---|---|---|
| Windows | `wscript` + WMP 播系统 wav | PowerShell + WinRT toast（归属借 DSH 的 AUMID，标题栏显示「DeepSeek Harness」） |
| macOS | `afplay` | `osascript` |
| Linux | `canberra-gtk-play` → 回退 `paplay` | `notify-send` |

平台实测情况：**Windows** 本机实测；**Linux** 在 Ubuntu 22.04.5（GNOME 42.9）实测——`canberra-gtk-play` / `paplay` 播放各音效、`notify-send` 三档等级全部成功，并发现并修掉了 `question` 事件在 freedesktop 主题缺 `dialog-question.oga` 时静默无声的问题；**macOS** 只有模拟测试，尚无真机验证。

## 设置页

设置 → **声音提醒**：顶部是总开关 + 三个通道 chip（网页响铃 / 网页通知 / 宿主提醒），下面是十张事件卡片（分组：主要通知 / 其他通知 / 需要人介入时）。

每张卡片：网页音（下拉 + 试听）、音量、宿主提醒三选一——选「响铃」才出现宿主音与试听，选「通知」才出现等级与测试。

「网页响铃 + 宿主提醒」同时开着时，顶部会多出一个**防双响**开关（默认关）：开启后本机只响一次，另一台设备上的页面不受影响。实现细节与待办见 [`docs/TODO.md`](docs/TODO.md)。

设置存浏览器（localStorage）；宿主提醒配置存 DSH 数据目录 `%USERPROFILE%\.dsh\plugins\dsh-chime-alerts`（Linux/macOS 为 `$HOME/...`），静态与动态安装共用，切换安装方式设置自动继承。

## 已知限制

- 只覆盖本 DSH 进程能观察到的事件；页面关闭时只有宿主提醒生效（且该事件不能是「关」）
- **macOS 分支已实现并通过 Node 模拟测试，尚未在真实机器实测**；Windows 本机实测、Linux 已在 Ubuntu 22.04 实测
- 防双响的「同机」是按页面地址判断的（`localhost`/`127.0.0.1`）：用端口转发/隧道从另一台机器以 `127.0.0.1` 打开时会被误判成本机，此时请把防双响关掉
- 延迟：动态版 ≤ ~1.5s；静态版完成类实时（快照订阅），需要人介入类 ≤ ~1.5s（轮询 + 宿主 3s 节流）
- 导航图标、工作区静音标记依赖外壳 DOM 结构，DSH 改版可能需要适配（「诊断信息」里能看到匹配计数）
- 依赖 DSH 内部事件契约（非公开 API），升级 DSH 后请先跑 `npm test`

实现细节、契约踩坑与历代变更见 [CHANGELOG.md](CHANGELOG.md)。

## 仓库结构

| 文件 | 作用 |
|---|---|
| `lib/host.js` | 宿主半（ESM 模块，导出 `createHostPlugin`） |
| `lib/client.js` | 动态版客户端（函数体，粘贴用） |
| `lib/client.web.js` | 静态版客户端（npm 安装使用） |
| `lib/index.js` | 静态宿主入口（`main`），import `host.js`，不再有 `new Function` |
| `dynamic/host.body.js` | 动态安装粘贴用的函数体（由 `tools/build-body.mjs` 生成） |
| `cordis.patch.yml` | bundle 补丁层 |
| `tools/` | 语法检查 + 三套测试 + 构建脚本 + 截图工具 |
| `SECURITY.md` | 安全边界与报告方式 |
| `docs/REGISTRIES.md` | 各市场准入要求与上架状态 |
| `docs/TODO.md` | 待办 |

## 开发

本插件由 AI Agent 工具辅助开发（功能设计、代码实现、代码审计、测试与文档）。

```sh
npm test       # 宿主 187 + 动态客户端 140 + 静态客户端 133 = 460 项断言（Node 即可）
npm run check  # 语法检查 + 生成物一致性（dynamic/host.body.js、.chunks）
npm run body   # 改完 lib/host.js 后重建 dynamic/host.body.js
npm run chunks # 重建 .chunks/*.txt（动态安装粘贴用的分帧文本）
```

## 发布与上架

见 [`docs/REGISTRIES.md`](docs/REGISTRIES.md)（npm 发布清单 + 社区市场提交入口）。npm 包：<https://www.npmjs.com/package/dsh-chime-alerts>

## License

[MIT](LICENSE) © 2026 dsh-chime-alerts contributors
