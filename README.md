# dsh-chime-alerts · DSH 声音提醒插件

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 加一组轻量声音提醒：Agent 干完活、需要你批准、提交计划等你评审、有问题问你、目标受阻、后台任务完成/挂了，电脑响一声——不用一直盯着页面。

> 前身 `dsh-chime`（更早 `dsh-sound-alerts`）。v0.3.5 因市场名称冲突更名为 **dsh-chime-alerts**；存储键自动迁移，设置不丢。

## 特性

- **九类事件**独立开关 / 独立声音 / 独立音量：任务完成、子任务完成、后台任务完成、需要授权、Agent 提问、计划评审、目标受阻、其他打断、后台任务失败
- **混合发声（双独立开关）**：**网页响铃**（浏览器 Web Audio 合成音，存浏览器）与**宿主蜂鸣**（系统音效，页面关闭也响，存本地磁盘）各自独立开关；另有桌面通知独立开关
- **工作区静音按钮**：侧栏每个工作区条目（如 K230）旁的喇叭按钮，按工作区独立静音/恢复；已静音的工作区**常驻显示橙色斜杠标志**，状态即点即存
- **并行/后台任务逐个响**：3 个并行子代理分别完成 = 3 声（节流按种类+来源独立，互不吞）
- **宿主常驻蜂鸣**：系统级声音选「常驻」后，页面最小化甚至关闭时宿主直接系统蜂鸣，任务照样响
- **声音可替换**：每事件可换其他内置音，或上传自定义音频（≤5MB）
- **设置本地化**：系统音模式与自定义音频存**本地磁盘（工作区根目录）**（v0.3.10 起以 `sandboxPolicy.workspaceRoot` 为存储基准，兼容 DSH 沙箱的 workspace-write 策略）；其余设置（总开关/事件开关/音量/工作区静音）存浏览器 localStorage（键 `dsh-chime-alerts-v1`，旧键自动迁移）
- **默认值即开箱即用**：总开关开、固定监听所有会话（范围控制交给工作区静音按钮）、满音量；子任务音默认关
- **中英双语界面**：设置页与通知按浏览器语言自动切换（中文环境不变，英文环境显示英文）
- **Node 可跑的自动化测试**：`npm test`（85 项断言，无需浏览器/DSH）

## 声音一览

| 事件 | 检测依据（宿主半） | 默认音 |
|---|---|---|
| 任务完成 `complete` | `agent/status` 回 idle + 会话日志最后 `turn/end` 原因 = completed（跳过 inbox 待处理） | 上行叮咚 659→988Hz（triangle/sine，长衰减） |
| 子任务完成 `subcomplete` | 子代理（origin=subagent）回 idle 且 `turn/end` = completed，经 `agents.isOwnedBy` 映射回运行时根（主会话），支持多层嵌套 | 单声叮 880Hz（sine） |
| 后台任务完成 `jobdone` | `jobs.onJobDone` 且 status=completed（跳过 subagent 作业，避免与子任务音双响） | 上行双音 587→880Hz（sine） |
| 需要授权 `approval` | 会话日志 `approval/asked`（勿用 `approval/request` 瀑布：会被 UI 应答器先行认领） | 双音门铃 988→740Hz（sine） |
| Agent 提问 `question` | `tools/execute` 且 `exec.name === 'ask_user_question'` | 三连上行 523→659→784Hz（sine） |
| 计划评审 `planreview` | `tools/execute` 且 `exec.name === 'exit_plan_mode'`（计划模式退出前请求批准） | 三连下行 784→659→523Hz（sine） |
| 目标受阻 `goalblocked` | 会话日志 `goal/change` 且 operation=block（或 goal.phase=blocked） | 低音警报 440→440→349Hz（triangle） |
| 其他打断 `interrupt` | `turn/end` 原因 = aborted / error / blocked / max-tokens（主代理与子代理均覆盖） | 低频双响 311Hz（triangle） |
| 后台任务失败 `jobfail` | `jobs.onJobDone` 且 status=failed（跳过 subagent 作业，避免与打断音双响；bash 等非代理作业覆盖） | 短促三响 494→494→392Hz（triangle） |

## 快速安装（动态插件，功能完整）

1. `cordis_define`：`code.host` 粘贴 [`lib/host.js`](lib/host.js) 全文，`code.client` 粘贴 [`lib/client.js`](lib/client.js) 全文（`kind: "new"`，idPrefix 自取，如 `chime`）
2. `cordis_run`（mode `run`）激活
3. 客户端包首次激活需在页面上批准（单勾授权本次；双勾以后更新免批）

> 动态插件不落盘：DSH 进程重启后按同样步骤重装即可（系统音模式与自定义音频存本地磁盘，其余设置存浏览器，重装后自动恢复）。

## 设置页

设置 → 「🔊 声音提醒」：

- 总开关：启用声音提醒
- **网页响铃**（浏览器合成音，设置存浏览器）与**宿主蜂鸣**（系统音效，页面关闭也响，设置存本地磁盘）两个独立开关
- 九个事件单行（分三组：主要通知 / 其他通知 / 需要人介入时）：名称 / 声音下拉（默认 + 九套内置 + 音频库「自定义声音 · 文件名」——**导入的音频所有事件下拉共享**；选中「自定义声音…」即弹上传窗 ≤5MB，音频存本地磁盘；换文件先选其他声音再选回）/ 静音图标键 / 音量条 + 数值 / 试听

固定监听**所有会话**（v0.3.8 起不再提供「声音范围」选项），范围控制交给工作区静音按钮。设置页底部显示本地存储位置。

侧栏**工作区条目旁**（如「K230」行的 ⋮/+ 按钮旁）有喇叭按钮：点击单独静音该工作区的所有事件声音（含其子任务）。**已静音的工作区会一直显示橙色斜杠标志**（无需悬停），点击即可恢复；未静音的工作区悬停行时显示喇叭按钮。状态持久化，与设置页总开关独立。

## 仓库结构

```
lib/host.js          宿主半（函数体，动态安装粘贴此文件；静态入口也消费它）
lib/client.js        客户端半（函数体，动态安装粘贴此文件）
lib/index.js         静态宿主入口（npm 包 main，与 host.js 同一份逻辑）
lib/types/index.d.ts 类型声明
cordis.patch.yml     bundle 补丁层（dsh.bundle.patch 指向它）
tools/               syntax-check + 宿主/客户端测试（npm test / npm run check）
docs/REGISTRIES.md   社区市场上架指南
```

## 工作原理

- 宿主半监听 `agent/status`（完成/打断/子任务）、`session/event`（授权、目标受阻）、`tools/execute`（提问、计划评审）、`jobs.onJobDone`（后台任务完成/失败），节流 3s（种类+来源）后入事件缓冲
- 客户端每 700ms `host.call('pull', …)` 拉取并播放；15 秒以上旧事件跳过；boot 令牌防插件版本串扰
- 防误报：800ms 防抖（完成/打断类）、主代理 `inbox.hasPending` 跳过
- 浏览器音用 Web Audio 振荡器合成，零音频资源文件；系统蜂鸣由宿主写临时 `.vbs` 经 `wscript.exe` + WMP 播放 Windows 自带 wav（v0.3.9 起，避开 PowerShell；九类事件音色映射见 CHANGELOG）

## 静态化路线图（npm 安装）

`dsh plugin --profile web add dsh-chime-alerts` 已可安装（`dsh.bundle.patch` 补丁层），但**当前静态安装只有宿主半**（事件记录 + 系统蜂鸣）——完整功能请以动态安装为准。

完整静态双端还需三步（社区已验证可行的封套形态）：

1. 客户端 bundle 封套：`lib/client.js` 需包成 `window.__ModuleLoader__.load({ id, factory })` 经典脚本，`package.json` 补 `exports["./client"]` + `dsh.client: { platform: "web" }`
2. `styles.insert` → 自建 `<style data-plugin data-plugin-css>` + HMR 去重
3. `host.call` 动态桥 → 该模板的答案是**不要桥**：静态客户端 inject `sessions`/`workspaces` 服务订阅快照（`running`/`pendingInteraction`/goal 投影/jobsBySession）自行检测；宿主半保留 reason 精确判定与常驻蜂鸣

官方契约（已从 `@deepseek-ai/dsh-client-modules` 源码核实）：`dsh.client.platform` 必须为 `"web"`，bundle 从 `/plugins/<id>/client.js` 以经典脚本加载。

## 已知限制

- 仅覆盖**本 DSH 进程**内宿主能观察到的事件；跨进程/跨机器任务需常驻方案
- 浏览器音需要页面开着；页面关闭时只有宿主常驻蜂鸣（需开启）
- 系统蜂鸣走 `wscript.exe` + WMP 播放 Windows 自带音效（v0.3.9 起，避开安全软件对「node → 隐藏 PowerShell」链路的拦截弹窗；九类事件映射不同系统 wav）；若 `wscript.exe`/Media 音效缺失则静默不响
- 轮询延迟 ≤~1.5s（700ms 轮询 + 完成/打断 800ms 防抖）
- 自定义上传音频与系统音模式存本地磁盘（工作区根目录），换浏览器/清缓存不影响；仅更换工作区或删文件才会丢
- 设置导航的扬声器图标是 CSS hack：外壳 navIcon 按分区 id 写死且无图标注册 API，故隐藏第 5 个导航项默认 svg、在 label::before 用 SVG mask 画扬声器；若将来设置分区排序变化需同步改 `nth-child(5)`
- 工作区行内静音按钮是 DOM 注入（外壳没有工作区行的插槽）：锚定 `div[role="treeitem"][aria-expanded]`（会话行无 aria-expanded），按钮挂在 `document.body`（React 树外，免疫重渲染抹除）、fixed 定位贴在工作区行右侧、悬停显示；悬停按钮时用 `snd-keep-open` 类 + 外壳哈希类名 `YDXeBa_*` 保持官方 ⋮/+ 按钮可见；外壳若改行结构/属性/类名需同步适配

## 开发

本插件由 **AI Agent 工具辅助开发**：功能设计、代码实现、多 Agent 代码审计、自动化测试与文档整理均由 Agent 工具协作完成（详见 [CHANGELOG.md](CHANGELOG.md)）。

```sh
npm test      # 宿主 30 + 客户端 55 项断言（Node 即可，无需浏览器/DSH）
npm run check # 语法检查（lib/index.js + 双半函数体）
```

## 发布与上架

见 [`docs/REGISTRIES.md`](docs/REGISTRIES.md)（npm 发布检查清单 + WhaleHub / dsh-market / dshfind / awesome 列表提交入口）。

## License

[MIT](LICENSE) © 2026 dsh-chime-alerts contributors
