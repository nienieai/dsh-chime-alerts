# dsh-chime-alerts · DSH 声音提醒插件

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 加一组轻量声音提醒：Agent 干完活、需要你批准、提交计划等你评审、有问题问你、目标受阻、后台任务完成/挂了，电脑响一声——不用一直盯着页面。

## 特性

- **十类事件**，每类独立开关 / 声音 / 音量：任务完成、子任务完成、后台任务完成、需要授权、插件授权、Agent 提问、计划评审、目标受阻、其他打断、后台任务失败
- **混合发声**：网页响铃（Web Audio 合成音）与宿主蜂鸣（系统音效，页面关闭也响）两个独立开关，另有网页通知独立开关
- **工作区静音按钮**：侧栏每个工作区旁的喇叭按钮，按工作区独立静音，已静音常驻橙色斜杠标志
- **并行/后台任务逐个响**：3 个并行子代理分别完成 = 3 声（节流按种类+来源独立）
- **宿主蜂鸣跨平台**：Windows 播系统 wav（`wscript`+WMP）；Linux 播 freedesktop 主题音（`canberra-gtk-play` → 回退 `paplay`）；macOS 用 `afplay` 播系统音
- **声音可替换**：每事件可换内置音或上传自定义音频（动态 ≤5MB / 静态 ≤3MB）
- **中英双语界面**、**Node 可跑的自动化测试**（`npm test`，247 项断言）

## 默认声音

**默认声音全部是浏览器合成的**（Web Audio 振荡器实时生成，每类事件独立音型，如任务完成=渐强上行琶音、需要授权=慢叮咚、插件授权=短叮咚），**不附带任何音频文件，无版权、无许可证负担**，开箱即用可商用。

宿主蜂鸣（可选，默认关）使用**操作系统自带音效**（Windows wav / Linux freedesktop / macOS 系统音），受系统许可条款约束；不开启就完全不涉及。

## 安装

### 方式 A：静态安装（npm 包，推荐，功能与动态版一致、开箱即响）

一键安装（CLI 会写入 profile 依赖并注册 bundle 层）：

```sh
dsh plugin --profile web add dsh-chime-alerts
```

> npm 包地址：https://www.npmjs.com/package/dsh-chime-alerts ；GitHub Release：https://github.com/nienieai/dsh-chime-alerts/releases

安装/升级后需**重启 DSH + 重开网页标签**生效。若插件装了但不加载（CLI 偶发只写依赖、漏注册 bundle 层），手动确认 profile 的 `package.json` 两处齐备：

1. `dependencies`（或 devDependencies）里有 `dsh-chime-alerts`——npm 包名，或本地调试用 `link:`/`file:` 指向插件目录
2. `dsh.profile.bundles` 数组里有 `"dsh-chime-alerts"`

然后在 profile 目录执行 `pnpm install`，再重启 DSH + 重开网页标签。

- 宿主半（事件记录 + 系统蜂鸣）经 `lib/index.js` 自动加载；客户端半（浏览器合成音 + 设置页 + 工作区静音）经 `exports["./client"]` 以经典脚本加载（`dsh.client.platform: "web"`）
- 客户端直接订阅 DSH 会话/工作区快照，**只保留「目标受阻」**由快照自检（`projectionValues.goal` 仍在）；其余九类（需要授权 / Agent 提问 / 计划评审 / 插件授权 / 后台任务完成 / 后台任务失败 / 任务完成 / 子任务完成 / 打断）统一改由宿主半检测后经 `/dsh-chime-alerts/events` 增量转发——`pendingInteraction` 自 DSH 0.1.5 起不在 `SessionSummary` 内，`jobsBySession` 自 0.1.7 起不在 `SessionListState` 内，而完成/子任务/打断原先也读 `pendingInteraction`，该守卫恒真会把「因等待授权而结束的回合」误判成完成；设置存浏览器（键与动态版相同，**切换安装方式设置自动继承**）
- **静态版差异**：「其他打断」并入「任务完成」（快照无 turn 结束原因字段）、自定义音频存浏览器且上限 3MB；其余（十类事件、总开关 / 宿主蜂鸣开关 / 每事件宿主音下拉 / 宿主静音 / 宿主试听 / 工作区静音）与动态版一致
- 设置页底部显示**版本号**（如「静态版 v0.5.8」），便于确认页面已加载最新代码

### 方式 B：动态插件（免安装，重启 DSH 后需重新部署）

1. `cordis_define`：`code.host` 粘贴 [`lib/host.js`](lib/host.js) 全文，`code.client` 粘贴 [`lib/client.js`](lib/client.js) 全文（`kind: "new"`，idPrefix 自取）
2. `cordis_run`（mode `run`）激活，客户端包首次激活需在页面上批准
3. DSH 重启后按同样步骤重装；宿主音/自定义音频存本地磁盘，其余设置存浏览器，重装后自动恢复

> **两条必须注意的坑（都实测踩过）**
>
> - **两半要放在同一个包里。** 后续用 `cordis_run` 的 `update` 切换版本时是**整包替换**，不是「只换宿主半」——如果你先只定义客户端半、再用一个 host-only 的新包去 update，会把它从浏览器里卸载掉（表现为设置页消失、浏览器不响），而 `cordis_inspect_self` 只会告诉你 `hasClientHalf: false`。改代码时请**一次性**给出 host+client 的新包。
> - **别用 `.chunks/host.txt` 之外的旧文本**：`.chunks/*.txt` 由 `npm run chunks` 从 `lib/*.js` 生成、并由 `npm test` 校验一致（见下）；直接抄 README 之外的任何旧副本都可能装到过期宿主。

## 设置页

设置 → 「🔊 声音提醒」：

- 四个总开关：启用 / 网页响铃 / 宿主蜂鸣 / 网页通知
- 十个事件单行（分组：主要通知 / 其他通知 / 需要人介入时）：名称 / 声音下拉（默认 + 内置音 + 音频库）/ 静音键 / 音量条 / 试听；宿主蜂鸣开启时每行追加第二行：宿主音下拉 + 宿主静音键 + 宿主试听
- 固定监听所有会话，范围控制交给工作区静音按钮；底部显示本地存储位置

存储位置：动态安装优先 `sandboxPolicy.workspaceRoot`，落在系统目录时（如 DSH 从 System32 启动）自动改用 DSH 数据目录；**静态安装固定存 DSH 数据目录** `%USERPROFILE%\.dsh\plugins\dsh-chime-alerts`（Linux/macOS 对应 `$HOME/...`，经 node:fs 直写，旧数据自动迁移）。

## 工作原理

- 宿主半监听 `agent/status`（完成/打断/子任务）、`session/event`（授权）、`goal/changed`（目标受阻）、`tools/execute`（提问、计划评审）、`tools/result`（插件授权，v0.4.4+）、`jobs.onJobDone`（后台任务完成/失败，静态安装延迟挂接，v0.5.4+），节流 3s（种类+来源）后入事件缓冲
- 动态客户端每 700ms 拉取播放；15 秒以上旧事件跳过；boot 令牌防版本串扰；完成/打断类 800ms 防抖，主代理 `inbox.hasPending` 跳过。静态客户端订阅 `sessions`/`workspaces` 快照，**只保留「目标受阻」（goal 投影）**由快照自检，并每 1500ms 拉 `/dsh-chime-alerts/events` 补齐其余九类（授权 / 提问 / 计划评审 / 插件授权 / 后台任务完成 / 后台任务失败 / 完成 / 子任务完成 / 打断；宿主只对这九类入队，与快照自检不重叠——`jobsBySession` 自 0.1.7 起不在快照内、完成三类的 `pendingInteraction` 守卫自 0.1.5 起恒真，故一并改由宿主判定）；`/events` 响应的 `boot` 令牌每次宿主重启都会更换、`seq` 从 0 重新计数，客户端据此把游标归零——漏掉这一步，长开标签页的游标会停在旧宿主的 `seq` 上，此后被宿主侧 `ev.seq > after` 全部挡掉而永久失声（只能靠刷新恢复）
- 浏览器音零音频文件；系统蜂鸣 Windows 走临时 `.vbs` + `wscript.exe` + WMP（避开安全软件拦截 PowerShell；静态安装经 node:fs 直写，v0.5.4+），Linux/macOS 见上

## 已知限制

- 仅覆盖本 DSH 进程内宿主能观察到的事件
- 浏览器音需要页面开着；页面关闭时只有宿主蜂鸣（需开启）
- **Linux / macOS 分支已实现并通过 Node 模拟测试，但尚未在真实机器上实测**；Windows 为本机实测平台
- 轮询延迟：动态版 ≤~1.5s（700ms 轮询 + 800ms 防抖）；静态版「完成/子任务/后台/目标受阻」为准实时（快照订阅），「授权/提问/计划评审/插件授权」≤~1.5s（1500ms 轮询 + 宿主 3s 节流）
- 设置导航扬声器图标与工作区静音按钮依赖外壳 DOM 结构（CSS hack / 固定定位注入），外壳改版需同步适配
- **待修：工作区行内静音按钮在真实浏览器中未验证**（记录于 2026-09，尚未定位）。静态/动态客户端都用
  `document.querySelectorAll('div[role="treeitem"][aria-expanded]')` 取工作区行，再把**整行 `textContent`** 与
  工作区标题做**精确相等**匹配（`client.web.js` 的 `syncWorkspaceMuteButtons`）；匹配不上就 `continue` 静默跳过——
  **按钮不出现且不报任何错**。因此只要外壳把行文本改成「标题 + 计数 / 图标 / 空白」之类，或在行内渲染了额外文本，
  按钮就会整片消失而没有任何迹象。已知代码层面该 role/属性确实存在（`dsh-client-ui-workspace`），但**尚未在真实
  DOM 上确认匹配成功**；现象待复现后再决定改法（候选：改用行元素上的稳定标识而非文本、或加一次匹配失败告警日志）
- **依赖 DSH 内部契约**：事件名与参数签名（`goal/changed`、`Session.ownEvents()`、`SessionSummary` 字段）不是公开 API，DSH 升级可能再次漂移；本仓库的测试用真实契约做回归（见 `tools/test-host.mjs` 的「契约回归」与 `tools/test-client-web.mjs` 的 `/events` 用例），升级 DSH 后请先跑 `npm test`
- **实参与类型声明可能不一致**：实测 `session/event` 的 listener 只收到 2 个实参（`Session`、`SessionEvent`），而 inspect 签名写的是 3 个位置参数；插件因此**按对象形状**而非实参位置识别（`type` 字段判事件、`id`+`snapshotEvents()` 判 Session），两种布局都能工作。同类坑：动态宿主半没有 `process`（故动态安装的平台检测恒为 null，走 win32 兼容分支），静态安装是真实 Node 模块、不受此限

## 仓库结构

```
lib/host.js          宿主半（函数体，动态安装粘贴；静态入口也消费它）
lib/client.js        客户端半（函数体，动态安装粘贴）
lib/client.web.js    静态客户端（经典脚本封套，npm 安装使用）
lib/index.js         静态宿主入口（npm 包 main）
lib/types/index.d.ts 类型声明
cordis.patch.yml     bundle 补丁层
tools/               syntax-check + 宿主/客户端/静态客户端测试
docs/REGISTRIES.md   社区市场上架指南
```

## 开发

本插件由 AI Agent 工具辅助开发（功能设计、代码实现、代码审计、测试与文档），详见 [CHANGELOG.md](CHANGELOG.md)。

```sh
npm test      # 宿主 112 + 客户端 96 + 静态客户端 74 项断言（Node 即可，无需浏览器/DSH）
npm run check # 语法检查 + .chunks 与源码一致性检查
npm run chunks # 改完 lib/host.js 或 lib/client.js 后重建动态安装用的 .chunks/*.txt
```

## 发布与上架

见 [`docs/REGISTRIES.md`](docs/REGISTRIES.md)（npm 发布清单 + 社区市场提交入口）。

## License

[MIT](LICENSE) © 2026 dsh-chime-alerts contributors
