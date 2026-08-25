# dsh-chime-alerts · DSH 声音提醒插件

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 加一组轻量声音提醒：Agent 干完活、需要你批准、提交计划等你评审、有问题问你、目标受阻、后台任务完成/挂了，电脑响一声——不用一直盯着页面。

> 前身 `dsh-chime` / `dsh-sound-alerts`。v0.3.5 因市场名称冲突更名；存储键自动迁移，设置不丢。

## 特性

- **十类事件**，每类独立开关 / 声音 / 音量：任务完成、子任务完成、后台任务完成、需要授权、插件授权、Agent 提问、计划评审、目标受阻、其他打断、后台任务失败
- **混合发声**：网页响铃（Web Audio 合成音）与宿主蜂鸣（系统音效，页面关闭也响）两个独立开关，另有网页通知独立开关
- **工作区静音按钮**：侧栏每个工作区旁的喇叭按钮，按工作区独立静音，已静音常驻橙色斜杠标志
- **并行/后台任务逐个响**：3 个并行子代理分别完成 = 3 声（节流按种类+来源独立）
- **宿主蜂鸣跨平台**：Windows 播系统 wav（`wscript`+WMP）；Linux 播 freedesktop 主题音（`canberra-gtk-play` → 回退 `paplay`）；macOS 用 `afplay` 播系统音
- **声音可替换**：每事件可换内置音或上传自定义音频（动态 ≤5MB / 静态 ≤3MB）
- **中英双语界面**、**Node 可跑的自动化测试**（`npm test`，221 项断言）

## 默认声音

**默认声音全部是浏览器合成的**（Web Audio 振荡器实时生成，每类事件独立音型，如任务完成=渐强上行琶音、需要授权=慢叮咚、插件授权=短叮咚），**不附带任何音频文件，无版权、无许可证负担**，开箱即用可商用。

宿主蜂鸣（可选，默认关）使用**操作系统自带音效**（Windows wav / Linux freedesktop / macOS 系统音），受系统许可条款约束；不开启就完全不涉及。

## 安装

### 方式 A：动态插件（功能完整，推荐）

1. `cordis_define`：`code.host` 粘贴 [`lib/host.js`](lib/host.js) 全文，`code.client` 粘贴 [`lib/client.js`](lib/client.js) 全文（`kind: "new"`，idPrefix 自取）
2. `cordis_run`（mode `run`）激活，客户端包首次激活需在页面上批准
3. DSH 重启后按同样步骤重装；宿主音/自定义音频存本地磁盘，其余设置存浏览器，重装后自动恢复

### 方式 B：静态安装（npm 包，v0.5.6 起与动态版功能对齐、开箱即响）

```
dsh plugin --profile web add dsh-chime-alerts
```

（或 `npm install dsh-chime-alerts` 后加入 profile 的 `dsh.profile.bundles`；npm 包地址 https://www.npmjs.com/package/dsh-chime-alerts ，GitHub Release 见 https://github.com/nienieai/dsh-chime-alerts/releases ）

- 宿主半（事件记录 + 系统蜂鸣）经 `lib/index.js` 自动加载；客户端半（浏览器合成音 + 设置页 + 工作区静音）经 `exports["./client"]` 以经典脚本加载（`dsh.client.platform: "web"`）
- 客户端直接订阅 DSH 会话/工作区快照检测事件，无需动态桥；设置存浏览器（键与动态版相同，**切换安装方式设置自动继承**）
- **静态版差异（v0.5.5 起宿主音配置 UI 已补齐）**：「插件授权」无快照信号（仅宿主蜂鸣兜底）、「其他打断」并入「任务完成」、自定义音频存浏览器且上限 3MB；其余（总开关 / 宿主蜂鸣开关 / 每事件宿主音下拉 / 宿主静音 / 宿主试听）与动态版一致
- 设置页底部显示**版本号**（如「静态版 v0.5.6」），便于确认页面已加载最新代码
- 更新静态插件后需**重启 DSH + 重开网页标签**生效

## 设置页

设置 → 「🔊 声音提醒」：

- 四个总开关：启用 / 网页响铃 / 宿主蜂鸣 / 网页通知
- 十个事件单行（分组：主要通知 / 其他通知 / 需要人介入时）：名称 / 声音下拉（默认 + 内置音 + 音频库）/ 静音键 / 音量条 / 试听；宿主蜂鸣开启时每行追加第二行：宿主音下拉 + 宿主静音键 + 宿主试听
- 固定监听所有会话，范围控制交给工作区静音按钮；底部显示本地存储位置

存储位置：动态安装优先 `sandboxPolicy.workspaceRoot`，落在系统目录时（如 DSH 从 System32 启动）自动改用 DSH 数据目录；**静态安装固定存 DSH 数据目录** `%USERPROFILE%\.dsh\plugins\dsh-chime-alerts\`（Linux/macOS 对应 `$HOME/...`，经 node:fs 直写，旧数据自动迁移）。

## 工作原理

- 宿主半监听 `agent/status`（完成/打断/子任务）、`session/event`（授权、目标受阻）、`tools/execute`（提问、计划评审）、`tools/result`（插件授权，v0.4.4+）、`jobs.onJobDone`（后台任务完成/失败，静态安装延迟挂接，v0.5.4+），节流 3s（种类+来源）后入事件缓冲
- 动态客户端每 700ms 拉取播放；15 秒以上旧事件跳过；boot 令牌防版本串扰；完成/打断类 800ms 防抖，主代理 `inbox.hasPending` 跳过。静态客户端直接订阅 `sessions`/`workspaces` 快照检测（running 边沿 / pendingInteraction / goal 投影 / jobsBySession 终态）
- 浏览器音零音频文件；系统蜂鸣 Windows 走临时 `.vbs` + `wscript.exe` + WMP（避开安全软件拦截 PowerShell；静态安装经 node:fs 直写，v0.5.4+），Linux/macOS 见上

## 已知限制

- 仅覆盖本 DSH 进程内宿主能观察到的事件
- 浏览器音需要页面开着；页面关闭时只有宿主蜂鸣（需开启）
- **Linux / macOS 分支已实现并通过 Node 模拟测试，但尚未在真实机器上实测**；Windows 为本机实测平台
- 轮询延迟 ≤~1.5s（700ms 轮询 + 800ms 防抖）
- 设置导航扬声器图标与工作区静音按钮依赖外壳 DOM 结构（CSS hack / 固定定位注入），外壳改版需同步适配

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
npm test      # 宿主 85 + 客户端 97 + 静态客户端 39 项断言（Node 即可，无需浏览器/DSH）
npm run check # 语法检查
```

## 发布与上架

见 [`docs/REGISTRIES.md`](docs/REGISTRIES.md)（npm 发布清单 + 社区市场提交入口）。

## License

[MIT](LICENSE) © 2026 dsh-chime-alerts contributors
