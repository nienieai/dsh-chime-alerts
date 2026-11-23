# 技术文档 · dsh-chime-alerts

这份文档讲**它是怎么工作的**：两半架构、事件从哪来、端点与鉴权、设置存在哪、各平台怎么发声、测试与发版。想装插件请看 [README](../README.md) 或 [INSTALL.md](INSTALL.md)。

---

## 1. 设计取舍

| 诉求 | 做法 |
|---|---|
| 页面关着也要能提醒 | 一半逻辑在**宿主进程**（`lib/host.js`），它自己发声 / 弹通知，不依赖页面 |
| 网页里要零延迟 | 另一半在**浏览器**（`lib/client.web.js`），Web Audio 合成，不落盘、不联网 |
| 两种安装方式共用一套代码 | 动态安装粘贴的是 `dynamic/host.body.js` + `lib/client.js`，两者与静态版同源（生成物由脚本校验） |
| 用户不被默认打扰 | 宿主提醒默认关；网页只开「需要你知道」的六类 |
| 装到老版本 DSH 上要明确失败 | `engines.node >= 22.19`、`engines.dsh >= 0.2.0-rc.2`，由 DSH 自己校验 |

## 2. 两半架构

```
DSH 宿主进程                             浏览器（DSH web shell）
┌──────────────────────────────┐         ┌───────────────────────────┐
│ lib/index.js  (bundle 入口)  │         │ lib/client.web.js         │
│   └─ lib/host.js             │◄── HTTP │   ├─ 设置页（声音提醒分区）│
│        ├─ 订阅 DSH 内部事件  │  /events│   ├─ Web Audio 合成       │
│        ├─ 5 条本地端点       │  /sysget│   ├─ 网页通知             │
│        └─ 系统音效 / 通知    │  /sysset│   └─ 快照事件检测          │
└──────────────────────────────┘  /sysbeep└───────────────────────────┘
                                   /sysnotify
```

| 文件 | 角色 |
|---|---|
| `lib/index.js` | 静态安装的宿主入口（`main`），import `host.js` 并调 `createHostPlugin` |
| `lib/host.js` | 宿主半：事件订阅、发声、通知、端点、设置落盘（ESM） |
| `lib/client.web.js` | 静态安装的浏览器半（`exports["./client"]`，由 `dsh-client-modules` 扫描加载） |
| `lib/client.js` | 动态安装的浏览器半（函数体形态，粘贴用） |
| `dynamic/host.body.js` | 动态安装的宿主半（由 `lib/host.js` 生成，`npm run body`） |
| `.chunks/*.txt` | 上面两个文件按 1500 字符切帧的 JSON 文本，供 `cordis_define` 逐帧粘贴 |
| `cordis.patch.yml` | bundle 补丁层，只声明宿主半（`name: dsh-chime-alerts`） |

两半**不共享内存**，只通过 HTTP 端点 + 设置文件通信；因此页面刷新只重建浏览器半，宿主状态不受影响。

## 3. 事件从哪来

DSH 没有公开的「提醒事件」API，插件从三处拼出十类事件：

### 3.1 宿主订阅（`lib/host.js`）

| 来源 | 订阅方式 | 产出 |
|---|---|---|
| 会话事件 | `ctx.on('session/event', …)` | 回合完成 `complete`、审批 `approval`、提问 `question`、计划评审 `planreview` |
| 目标状态 | `ctx.on('goal/changed', …)` | `goalblocked`（长期目标被阻塞） |
| Agent 状态 | `ctx.on('agent/status', …)` | `interrupt`（停止 / 出错 / token 上限） |
| 工具调用 | `ctx.on('tools/execute' / 'tools/result', …)` | 提问工具、`exit_plan_mode`、动态插件审批 `pluginapproval` |
| 后台作业 | `jobs.events.subscribe({owners:'all'}, …)` | `jobdone` / `jobfail`；旧版本 DSH 回退到 `jobs.onJobDone` / `jobs.subscribe` |

作业事件有**五种历史形态**（0.1.x 到 0.2.x 的 API 变过），`subscribeJobEvents` 逐个探测；探测结果与最近 80 条原始事件存在诊断环里，出问题先看「诊断信息」。

### 3.2 浏览器快照

`complete` / `subcomplete` / `goalblocked` 由浏览器从会话快照自行判断（`SessionSummary` + 事件数组），宿主不重复下发，避免同一事件双响。

### 3.3 宿主下发队列（`/dsh-chime-alerts/events`）

「需要授权 / Agent 提问 / 计划评审」以及快照拿不到的部分（`pluginapproval`）由宿主检测后入队，浏览器每 1.5s 拉一次：

```json
{ "ok": true, "boot": "<宿主启动标识>", "seq": 42,
  "events": [{ "seq": 41, "kind": "question", "session": "…" }],
  "kinds": ["approval","question","planreview","pluginapproval","jobdone","jobfail"],
  "jobLog": [ … 最近 80 条作业事件，仅供诊断 … ] }
```

- 游标是 `?after=<seq>`，一次最多返回 50 条；
- `boot` 变化 = 宿主重启过，浏览器重置游标；
- 轮询带 in-flight 守卫（请求超时 8s，间隔 1.5s），端点变慢时不会堆积请求。

## 4. 端点

全部由宿主半注册；DSH 的 `webServer` **只按路径派发、不做鉴权**（Host/Origin 校验只在 `/api` 通道上），所以每条路由自己接鉴权。

| 方法 | 路径 | 作用 | 请求体 |
|---|---|---|---|
| GET/HEAD | `/dsh-chime-alerts/sysget` | 读宿主设置 + 平台 + 能力位（`capBeep` / `capNotify` / `dir`） | — |
| POST | `/dsh-chime-alerts/sysset` | 写宿主设置（`hostBeep` / `hostSounds` / `eventModes` / `notifyLevels`） | JSON，≤ 64 KB |
| POST | `/dsh-chime-alerts/sysbeep` | 试听：按事件播一声宿主音 | `{kind, sound?}` |
| POST | `/dsh-chime-alerts/sysnotify` | 试听：按事件弹一条通知 | `{kind, level?}` |
| GET/HEAD | `/dsh-chime-alerts/events?after=<seq>` | 拉取待处理事件 | — |

**准入**（`guard()`）：

1. 有 `connection` 服务 → `ctx.connection.requestRejection({headers})`，返回 401/403 即拒绝（与 DSH `/api` 同语义）；
2. 没有该服务 → 退回保守判定：`Origin` 必须与 `Host` 同源；无 `Origin` 时 `Host` 必须是 loopback 或 webserver 自身 origin。

**限流**：试听端点每事件 700ms、全局 10 次 / 10s（超出 429）；请求体超过 64 KB 直接 413；`sysset` 的 `hostSounds` 只接受白名单值。

## 5. 设置与存储

| 位置 | 键 / 文件 | 内容 |
|---|---|---|
| 浏览器 `localStorage` | `dsh-chime-alerts-v1` | 总开关、三通道开关、防双响、每事件 `{enabled, mode, level, sound, volume, customUrl}`、静音工作区列表 |
| 浏览器 `localStorage` | `dsh-chime-alerts-v1-audiolib` | 上传的自定义音频（data URL，单条 ≤ 3 MB） |
| 宿主磁盘 | `~/.dsh/plugins/dsh-chime-alerts/dsh-chime-alerts-settings.json` | `hostBeep`、`hostSounds`、`hostMuted`（派生兼容字段）、`eventModes`、`notifyLevels` |

宿主设置是「每事件模式」的真源，浏览器只是镜像；`hostMuted[kind] === true` 始终等价于 `eventModes[kind] === 'off'`，旧客户端读写它仍然有效。磁盘 JSON 解析失败时，原文会先另存一份再写新值，不会静默覆盖。

## 6. 发声与通知

| 平台 | 响铃 | 通知 |
|---|---|---|
| Windows | 生成 `.vbs`（WMP 播系统 wav）→ `wscript.exe`，跑完自删 | 生成 `.ps1`（UTF-8 **带 BOM**，否则 PowerShell 5.1 按 ANSI 解析、中文标题乱码）→ `powershell -WindowStyle Hidden`，跑完自删 |
| macOS | `afplay <系统音>` | `osascript -e 'display notification …'` |
| Linux | `canberra-gtk-play -i <主题音>`，失败回退 `paplay <wav>` | `notify-send -u low\|normal\|critical` |

- **通知归属**：Windows toast 的标题栏显示 AUMID 对应的应用名。插件优先借 DSH 的 `electron.app.DeepSeek Harness`，运行时用 `CreateToastNotifier(...).Setting` 判断是否已注册，未注册则回退到 PowerShell 自带 AUMID。
- **等级映射**：`silent` / `normal` / `important` → Windows `<audio silent>` / 默认音 / `scenario="urgent"` + `Reminder`；Linux `-u low/normal/critical`；macOS 静默不带提示音、其余带一声 Glass。
- **能力位**：探测失败（命令不在 PATH、杀软拦截隐藏 PowerShell）时 `capBeep` / `capNotify` 为 false，设置页把对应按钮置灰；负结论只缓存 5s，服务晚挂载能自愈。
- **代码注入防护**：宿主音只接受枚举白名单（平台默认音 + 客户端选项），加载旧设置、写入设置、生成脚本时各校验一次——这些字符串最终会被 `wscript` 执行。

## 7. 防双响

「网页响铃 + 宿主提醒」都开着时，顶部出现防双响开关（默认关）：

- 开启后，若宿主**有能力**接管（`capBeep` / `capNotify` 为 true 且该事件模式不是 `off`），浏览器不再发声；
- 「同一台设备」按页面地址判断：`localhost` / `127.0.0.1` / `::1` 算本机，其余算另一台设备；
- 反向误判（端口转发把远端 `127.0.0.1` 映射到本机）目前无解，见 [TODO.md](TODO.md)。

## 8. 0.6.1 的安全修复（发布说明的一部分）

| 级别 | 问题 | 修复 |
|---|---|---|
| P0 | `/sysset` 对 `hostSounds` 只校验类型 → 值被拼进 `.vbs` 交给 `wscript` 执行，任意网页一次跨站 POST 即可持久化代码执行 | 白名单枚举 + 加载/写入/生成三处校验 |
| P1 | 五条端点零鉴权 | 全部接入 `requestRejection`（或同源 + loopback 兜底） |
| P1 | 试听端点绕过节流，可被刷成通知轰炸 | 700ms / 10 次每 10s 限流 + 64 KB 请求体上限 |
| P1 | 宿主无发声能力时，防双响会压掉唯一能听见的那一声 | 能力位参与判定 |
| P1 | 动态版首个提示音静默丢失（`AudioContext` 处于 suspended） | 移植静态版的「排队 + 手势解锁 + statechange 补响」 |

完整清单见 [CHANGELOG.md](../CHANGELOG.md)。

## 9. 测试与生成物

```sh
npm test       # 460 项断言：tools/test-host.mjs 187 + test-client.mjs 140 + test-client-web.mjs 133
npm run check  # 语法检查 + 版本一致性 + 生成物一致性
```

- 测试用 `node:test` 直接跑，无需 DSH 进程：宿主测试用假 `ctx` 与假文件系统，客户端测试用 `tools/fake-dom.mjs` 造最小 DOM 与假 React。
- **版本一致性**：设置页页脚那句「静态版 vX.Y.Z」是手写常量，`tools/syntax-check.mjs` 会把它与 `package.json.version` 比对，漏改直接 FAIL（0.6.1 发布前就漏过一次，页脚仍显示 v0.6.0）。
- **生成物**：`dynamic/host.body.js` 由 `tools/build-body.mjs` 从 `lib/host.js` 生成，`.chunks/*.txt` 由 `tools/chunk-src.mjs` 生成；`npm run check` 用 `--verify` 校验两者与源码一致，防止「源码改了、粘贴物还是旧版」的静默漂移。

## 10. 发版流程

1. 确认工作区干净、`npm test` 与 `npm run check` 通过；
2. 改 `package.json` 的 `version`，同时改两处 `versionText()`（不改会被 `npm run check` 拦下）；
3. 在 `CHANGELOG.md` 顶上加新版本段落；
4. 提交、打 annotated tag：`git tag -a v0.6.1 -m "v0.6.1"`；
5. `git push origin main --tags`；
6. 在 `main` 上 `npm publish`（需要 OTP；发出去的是 tarball，`files` 已排除 `tools/`、`.chunks/`）；
7. 确认 `npm view dsh-chime-alerts version` 与 tag 一致；
8. 检查 GitHub 仓库 topics 里仍有 `dsh-plugin`（生态入口靠它）。

npm 上同一版本不能发两次——要补发只能提升版本号（或 72 小时内 unpublish）。

## 11. 约定

- 只用公开的 `ctx` API 与已探测的 DSH 服务；依赖 DSH 内部事件契约的地方都在代码里写了「旧形态 / 新形态」双分支。
- 浏览器半不发网络请求，只访问本机端点；宿主半不读会话正文，只读事件与元数据。
- 用户可见行为的变化必须进 CHANGELOG；纯重构不需要。
- 文档里的截图取自真实界面，敏感的工作区名会替换为示例名。
