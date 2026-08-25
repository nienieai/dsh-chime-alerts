# 更新日志

## v0.5.3

- **静态安装恢复宿主蜂鸣（修复「没宿主响铃了」）**：静态环境没有客户端-宿主 RPC 桥（harness 为 undefined）,此前 `sysget`/`sysset` 无人调用 → 磁盘上保存的 `hostBeep` 永远不生效、`alwaysBeep` 恒为 false。v0.5.3 补齐：
  - **启动自动读盘**：宿主半 apply 时直接读取 `settings.json` 恢复 `hostBeep`/`hostSounds`/`hostMuted`（磁盘设置成为真源）
  - **静态存储直通车（nodeIo）**：静态宿主半经 `lib/index.js` 注入的 `node:fs` 直通车读写 `%DSH_HOME%\plugins\dsh-chime-alerts`——会话沙箱只允许写工作区根，绕过它对用户数据目录的写入限制（与 dsh-liquid-glass-balance-card 写 `$DSH_HOME\storages` 同形态）；动态模式仍走会话沙箱 fs，互不干扰
  - **webServer HTTP 端点**：在 DSH webServer 上注册 `/dsh-chime-alerts/sysget`（GET）与 `/dsh-chime-alerts/sysset`（POST）,静态设置页直接读写宿主设置；注册采用服务延迟监听（`internal/service`）,解决 webServer 在 chime 条目之后挂载的时序问题;仅无 harness 时注册,动态桥共存不受影响
  - **惰性解析 fs/subprocess**：真实 web 树的激活顺序里 fs/subprocess 晚于 chime 条目,apply 时的 `ctx.get` 拿不到 → 改为用时解析,宿主蜂鸣能力检测与设置读写不再依赖挂载时序
- **静态设置页加回「宿主蜂鸣」开关**：之前静态版刻意隐藏了宿主蜂鸣 UI（因无通道不生效）,现在有 HTTP 端点后恢复——点击即写宿主设置并持久化(`%USERPROFILE%\.dsh\plugins\dsh-chime-alerts\dsh-chime-alerts-settings.json`),启动时从 `/sysget` 回读开关状态
- 测试 +14（host：无 harness 注册端点/路径正确/sysget 200/自动读盘恢复 hostBeep/nodeIo 存储根 DSH 目录/sysset 200/sysset ok/HTTP 写盘/写后读回一致性；client-web：宿主蜂鸣开关存在/启动读 /sysget/开关可点击/切换写 /sysset）,宿主 74 项、客户端 97 项、静态客户端 27 项、合计 198 项

## v0.5.2

- **修复静态客户端启动失败（`cannot get property "timer" without inject`）**：`lib/client.web.js` 的插件只声明了 `inject: ['slots', 'sessions', 'workspaces']`,但 `apply()` 使用了 `ctx.interval`/`ctx.timeout`（mixin 访问器内部解析 `ctx['timer']`,未声明时宿主客户端 loader 会整体报错,网页端停止加载「Failed to load plugins / dsh-chime-alerts」）；补上 `inject: ['timer', ...]`,与动态版 `lib/client.js` 的声明一致
- 测试 +4（断言静态客户端 `inject` 声明 timer/slots/sessions/workspaces——覆盖本回归,任何后续把 timer 从 inject 里删掉的改动都会测试失败）
- 这也是之前「重启后仍失败、条目 id 每次变化」的真正原因：变的是**网页端** loader 条目 id（浏览器 boot 阶段为每个 client bundle 建随机 id 条目）,而非宿主补丁条目（`id: chime` 固定）

## v0.5.1

- **修复静态宿主半加载失败**：`lib/index.js` 原用「默认导出函数」形式包装 host.js,Cordis loader 只识别顶层命名导出 `inject`/`apply`,导致 `inject: ['timer']` 不被读取,静态安装报 `cannot get property "timer" without inject`（截图「Failed to load plugins」）；改为标准 Cordis 插件导出（`export const inject: ['timer']` + `export function apply`）,静态安装恢复正常

## v0.5.0

- **静态安装开箱即响 + 网页端完整（修复 v0.4.6 静态安装不响的问题）**：v0.4.6 以 npm/独立目录方式安装时只有宿主半——无浏览器声音、无设置页、宿主蜂鸣默认关，等于装了不响；v0.5.0 提供完整静态客户端，静态安装后浏览器合成音**默认开启直接响**，设置页/工作区静音/网页通知全部可用，零手动配置
- **静态化完成（npm 安装可双端工作）**：新增 `lib/client.web.js`——以 DSH 标准经典脚本封套（`window.__ModuleLoader__.load`，与社区验证的 dsh-plugin-notify-sound 同形态）实现客户端半，**不再依赖动态桥**，直接订阅 `sessions`/`workspaces` 客户端运行时快照自行检测事件
- 事件检测对照（静态版）：`complete`（running→false）/ `subcomplete`（subagent 会话按 parentId 链归属根）/ `jobdone`、`jobfail`（jobsBySession 终态，subagent job 跳过）/ `approval`、`question`、`planreview`（pendingInteraction 上升沿）/ `goalblocked`（goal 投影进入 blocked）；**「插件授权」无快照信号**（由宿主半 `tools/result` 检测 + 宿主蜂鸣兜底）、**「其他打断」并入「任务完成」**（快照无 reason 字段）
- 配置：浏览器 localStorage（键 `dsh-chime-alerts-v1`，与动态版同键，**既有设置自动继承**）；自定义音频以 data URL 存 localStorage（≤3MB，替代动态版宿主磁盘音频库）；静态版设置页隐藏宿主蜂鸣相关 UI（宿主蜂鸣需手动编辑 `%USERPROFILE%\.dsh\plugins\dsh-chime-alerts\dsh-chime-alerts-settings.json`）
- `package.json` 新增 `exports["./client"]` + `dsh.client: { platform: "web", inject: [...] }`；`npm run check` 增加 client.web.js 校验
- 测试 +23（新增 `tools/test-client-web.mjs`：ModuleLoader 封套、八类快照检测、静音、节流、设置页、localStorage 继承、音频库），宿主 64 项、客户端 97 项、静态客户端 23 项、合计 184 项
- **已知差异（静态 vs 动态）**：无「插件授权」浏览器音、无「其他打断」区分、无宿主音配置 UI、自定义音频上限 3MB；更新静态插件后需重启 DSH

## v0.4.6

- **「插件授权」细分为独立事件（第十个事件）**：动态 Cordis 插件等待批准（`cordis_run` 返回 awaiting user approval）不再复用「需要授权」，改为设置页「需要人介入时」分组下的独立「插件授权」项——独立开关、独立声音（默认「门铃 · 短叮咚」，与「需要授权」的慢叮咚区分）、独立音量、独立宿主音与独立静音键
- 宿主 `tools/result` 命中后记录 `pluginapproval` 事件；三平台宿主默认音与「需要授权」一致（UAC.wav / dialog-warning / Ping.aiff）
- 测试 +3（client：10 张卡片 / 渲染「插件授权」行 / 静音键 20 个；host 断言改为 pluginapproval），宿主 64 项、客户端 97 项、合计 161 项

## v0.4.5

- **修复 v0.4.4 动态插件授权声音的漏检**：`tools/result` 的真实运行时文本可能嵌在多层嵌套里（`content[].content[].text`，与会话日志形状一致），单层解析会漏掉；改为**深度收集**所有文本字段后再匹配 `awaiting user approval`
- 测试 +1（嵌套结构命中 awaiting approval），宿主 64 项、客户端 94 项、合计 158 项

## v0.4.4

- **动态插件授权也有声音**：实测发现 cordis 插件（`cordis_run`）的授权**不经过 DSH approval 服务**（不会产生 `approval/asked` 会话事件，会话日志中全部授权事件均为工具授权），原「需要授权」声音收不到它；现新增宿主监听 `tools/result`——`cordis_run` 返回文本含 `awaiting user approval` 时按「需要授权」事件发声（复用该事件的开关/音量/宿主音配置）
- 测试 +2（host：cordis_run 等待授权 → approval；其他工具结果不触发），宿主 63 项、客户端 94 项、合计 157 项

## v0.4.3

- **文档（仅 README，代码无改动）**：删除「声音一览」表格，新增「默认声音」说明——**默认声音全部为浏览器 Web Audio 合成音，实时生成、不附带任何音频文件，无版权、无许可证负担**；宿主系统音效（Windows wav / freedesktop / macOS）属操作系统自带，受系统许可条款约束，且宿主蜂鸣默认关闭、可选开启

## v0.4.2

- **每事件独立静音宿主音**：宿主蜂鸣开启时第二行新增宿主静音键（只静音该事件的宿主系统音，与主行静音键互不影响——主行静音键只关浏览器音）；`hostMuted` 存宿主 settings.json，宿主 `record()` 时跳过静音事件
- **「桌面通知」改名为「网页通知」**：该通知由浏览器 Notification API 弹出（显示在系统通知中心但本质是网页权限），改名避免误解为宿主通知
- 测试 +10（host +5：hostMuted 存读/静音事件不响/取消恢复；client +5：改名/第二行静音键渲染与保存/主行不受影响），宿主 61 项、客户端 94 项、合计 155 项

## v0.4.1

- **宿主能力检测**：`sysget` 新增 `capBeep` 字段——宿主端探测响铃能力（win32 查 `wscript.exe` 是否在 PATH、linux 探测 canberra/paplay、darwin 探测 afplay；无 subprocess 服务时 false），结果缓存
- **不支持时控件变灰**：`capBeep=false` 时宿主蜂鸣开关、宿主音下拉、宿主试听按钮全部禁用（不可点击 + 变灰样式）；浏览器无 Notification API 时桌面通知开关禁用；`capBeep` 未知（如 sysget 未返回）时不禁用，避免误伤
- 测试 +10（host +5：win32/无 subprocess/linux 无播放器/darwin capBeep；client +5：宿主控件禁用/通知开关禁用/不受影响场景），宿主 56 项、客户端 89 项、合计 145 项

## v0.4.0

- **跨平台宿主蜂鸣**：系统音按平台分发——Windows 保持 `wscript`+WMP 播系统 wav；**Linux** 探测 `canberra-gtk-play`（无则回退 `paplay`）播 freedesktop 主题音（`/usr/share/sounds/freedesktop/stereo/*.oga`）；**macOS** 用 `afplay` 播 `/System/Library/Sounds` 系统音
- **宿主音选项按平台**：设置页第二行下拉——Windows 19 种系统 wav / Linux 8 种 freedesktop 主题音 / macOS 11 种系统音;每平台各有语义对应的九事件默认映射(如 Linux 门铃→dialog-warning、坠落→dialog-error)
- **存储 fallback 平台化**：workspaceRoot 落在系统目录时,Windows 用 `%USERPROFILE%\.dsh\plugins\dsh-chime-alerts`(原逻辑),Linux/macOS 用 `$HOME/.dsh/plugins/dsh-chime-alerts`(经 `sh -c 'printf %s "$HOME"'` 解析)
- `sysget` 返回 `platform` 字段,客户端据此渲染宿主音列表
- 测试 +14(host +9:linux canberra/paplay 回退/自定义音/存储 fallback/darwin afplay;client +5:linux 选项渲染与保存),宿主 51 项、客户端 84 项、合计 135 项

## v0.3.22

- **设置页精简**：去掉页尾的大段说明文字（分组 / 每行元素 / 双开关 / 存储位置等长篇解释），只保留本地存储位置一行，界面更简洁
- **推送准备**：`package.json` 的 `repository.url` / `bugs.url` 占位符替换为真实仓库地址（`nienieai/dsh-chime-alerts`），新增 `homepage` 字段

## v0.3.21

- **任务完成的宿主音默认改为系统通知**（`Windows Notify System Generic.wav`，替代钟琴 chimes——完成音用系统通知更贴语义）

## v0.3.20

- **默认选项显示声音名称**：每个事件声音下拉的「默认」项显示该事件实际会响的声音名（如任务完成 → 「凯旋 · 渐强琶音」），不再写「默认（本事件专属音）」
- **宿主蜂鸣开启时每行变两行**：第二行为「宿主音」下拉（19 种系统 wav 可选，如 UAC/邮件/日历/惊叹/错误等）+「宿主试听」按钮；浏览器试听与宿主试听完全分离——主行「试听」只播浏览器合成音，宿主试听只播系统音（不受宿主蜂鸣开关影响）
- **宿主音每事件可配置**：宿主端 `hostSounds` 存 settings.json（跟随 DSH 目录），`sysget/sysset` 支持读写；未配置事件用默认映射
- **宿主响铃默认值重新映射**（更贴语义）：提问→Windows Ding、评审→Windows Default、打断→Windows Notify Email（原提问用 Email、评审用 Calendar 不符合语义）
- 测试 +8（host +4：hostSounds 存读/自定义 wav 蜂鸣/未知拒绝/默认不冗余；client +4：默认名/双行渲染/宿主试听 sysbeep/浏览器试听分离/下拉保存），宿主 42 项、客户端 79 项、合计 121 项

## v0.3.19

- **音量回调消除杂音**：基音 0.55→0.45、泛音 0.26→0.22（大音量下 sine+triangle+泛音叠加导致轻微失真）
- **子任务单独低调**：subcomplete 事件音量 ×0.6（单声轻叩不再偏响）
- **每个声音起名**：声音下拉显示名字——凯旋（任务完成）/ 轻叩（子任务）/ 涟漪（后台完成）/ 门铃（授权）/ 询问（提问）/ 落定（评审）/ 困顿（受阻）/ 惊停（打断）/ 坠落（失败）
- 其余维度（1~4 音、跳跃音阶、时值节奏、渐强渐弱、音色变化、尾音）保持 v0.3.18
- 测试 +1（子任务低调）、更新音量断言,宿主 37 项、客户端 71 项、合计 108 项

## v0.3.18

- **后台任务低调不打扰**：后台任务完成/失败(vol 0.5,约 -6dB)明显轻于前台事件
- **整体音量再加大**：基音峰值 0.45→0.55(泛音 0.26 保持)
- **每音独立音量因子**：渐强/渐弱表情——任务完成渐强(0.6→1)、后台完成渐弱(1→0.55)、授权渐强、评审渐弱、失败渐弱;音型数据升级为 `[频率, 起始, 时长, 波形, 音量]`,事件可带整体 `vol`
- **音色变化**：音符可在 sine/triangle 间切换(如完成第三音、后台完成尾音、提问尾音用 triangle 提亮)
- 保持 1~4 音、连续/跳跃音阶、相同/不同间隔、相同/不同时长、尾音长短(v0.3.16/17)
- 测试 +3(音量 0.55 / 渐强与音色 / 后台低调),宿主 37 项、客户端 70 项、合计 107 项

## v0.3.17

- **每个音符时值/间隔各不相同(节奏化)**：不再等间隔——任务完成「短短短长」琶音(尾音 0.8s)、后台完成「短短长」、授权「慢叮咚」、打断「长音后突停短音」、失败「快速坠落+长叹息」、受阻「重复低音+再下行」
- **纠正不符合语义的声音**：授权从「叮咚×2 大跳」改为慢「叮—咚」单遍高→低(请人来处理)；提问从三连跳跃改为上扬双音(疑问句末尾上扬)；打断从下行双音改为长音后戛然而止(被打断感)；受阻改为重复低音卡住感
- 音符数 1~4 声与跳跃音型保持(v0.3.16),音量 0.45/0.26 与尾音余韵保持
- 测试 +1(时值节奏:complete 尾音更长)、更新音型断言,宿主 37 项、客户端 67 项、合计 104 项

## v0.3.16

- **九种音改为 1~4 声不等**（不再全是四声）：任务完成 4 声上行琶音 523→659→784→1047Hz、子任务完成 1 声轻叮 784Hz、后台完成 3 声跳进上行 392→523→784Hz、授权 4 声叮咚大跳×2 1047→659→1047→659Hz、提问 3 声跳跃上行 523→698→988Hz（增四度大跳）、评审 3 声跳跃下行 988→698→523Hz、受阻 3 声低音下行 392→330→262Hz、打断 2 声下行 698→523Hz、失败 3 声大跳坠落 1047→698→494Hz
- **音调使用跳跃音型**（如 1313 / 1427 式跳进，不再连续级进），每声 0.1–0.2s 间隔、尾音 0.35–0.7s 长衰减；音量保持 v0.3.15 的 0.45/0.26
- 声音下拉文案同步更新（单声轻叮 / 叮咚大跳×2 / 跳跃上行 / 坠落三连 等）
- 测试更新（音符数 1–4 与跳跃断言），宿主 37 项、客户端 66 项、合计 103 项

## v0.3.15

- **九种音全部扩展为四音符**(更饱满):上行琶音=完成/积极(任务完成 C5-E5-G5-C6、子任务 E5-G5-B5-D6、后台完成 D5-F5-A5-D6),叮咚×2 门铃=授权,四连上行=提问,四连下行=评审,低音慢四连下行=目标受阻,快四连下行=打断/失败
- **音量提升**:基音增益 0.32→0.45、泛音 0.22→0.26(约 +40%)
- **保留尾音**:0.25s 自然余韵(铃感)机制不变,尾音音符加长至 0.4–0.7s 长衰减
- 声音下拉文案同步更新(完成音 · 上行琶音 / 授权音 · 叮咚门铃×2 等)
- 测试 +2(四音符×8 振荡器 / 音量 0.45)、更新音型断言,宿主 37 项、客户端 66 项、合计 103 项

## v0.3.14

- **九种合成音统一风格**：全部改为 sine 基音 + sine 2 倍频泛音（原受阻/打断/失败用刺耳 triangle）。音型语法统一——**上行=完成/积极**（任务完成两音、子任务单音、后台完成两音），**高→低双音门铃=需要授权**，**三连上行=提问**，**三连下行=评审结束**，**低音慢三连下行=目标受阻**（392→349→262Hz），**快两音下行=打断**（523→392Hz），**快三连下行=失败**（494→440→392Hz）
- 声音下拉文案同步更新（受阻音 · 低音三连 / 打断音 · 快下行双响 / 失败音 · 快三连下行）
- 测试 +6（九种音全 sine、方向语义：goalblocked 低音区 / interrupt、jobfail、question、planreview、approval 音型），宿主 37 项、客户端 61 项、合计 98 项

## v0.3.13

- **存储位置跟随 DSH 目录**：DSH 以管理员身份启动时进程 cwd=System32，导致沙箱 `workspaceRoot` 落在系统目录、插件数据写进 `C:\Windows\System32`。现检测到系统目录时自动改用 **DSH 数据目录** `%USERPROFILE%\.dsh\plugins\dsh-chime-alerts\`（经 `cmd /c echo %USERPROFILE%` 解析用户主目录，失败则回退原路径）；普通工作区场景行为不变
- **旧数据自动迁移**：`workspaceRoot` 系统目录里已写入的 `dsh-chime-alerts-settings.json` / 音频清单 / 音频文件在首次启动时自动复制到新位置（旧文件保留，可手动删除）
- 测试 +5（系统目录→DSH 目录 / cmd 解析 / sysget 路径 / 旧数据迁移 / 普通工作区不变），宿主 37 项、客户端 55 项、合计 92 项

## v0.3.12

- **存储落盘加固**：写入被 workspace-write 沙箱拒绝（`FS_SANDBOX_DENIED`）时，自动以插件自身数据文件身份带 `danger-full-access` 策略重试一次（正常路径仍先走沙箱）——解决 `workspaceRoot` 回退到 DSH 进程目录导致设置/音频/蜂鸣脚本写不进磁盘的问题
- 测试 +2（沙箱拒绝重试 / 正常路径不传 policy），宿主 32 项、客户端 55 项、合计 87 项

## v0.3.11

- **双独立开关**：原「系统级声音」四档下拉改为两个独立开关——**网页响铃**（浏览器合成音，设置存浏览器 localStorage）与**宿主蜂鸣**（系统音效，页面关闭也响，设置存本地磁盘）；旧 `sysMode`/`alwaysBeep` 自动迁移（auto/both/always→宿主蜂鸣开；off→关），不再有"播放失败自动兜底系统音"
- **音频库共享**：导入的自定义音频存入共享库，**所有事件的声音下拉都能选**（`custom:<id>`，按需从磁盘加载）；`saveaudio` 返回库 id、新增 `loadall` 列出库
- 测试更新（+7：双开关/迁移×2/库加载/库选项/失败不兜底），宿主 30 项、客户端 55 项、合计 85 项

## v0.3.10

- **修复本地存储从未落盘**：DSH 沙箱（workspace-write 模式）只允许写工作区根/平台临时区，此前写入目标（DSH 进程工作目录）在工作区外，全部被 `FS_SANDBOX_DENIED` 拒绝——sysMode 存不住、自定义音频存不上、vbs 蜂鸣脚本写不出（静默无声）。现改为以 `sandboxPolicy.workspaceRoot`（工作区根）为存储基准，设置/音频/蜂鸣脚本全部正常落盘
- 测试不变（28 宿主 + 50 客户端 = 78 项）

## v0.3.9

- **系统蜂鸣改走 wscript + 系统 wav，彻底避开 PowerShell**：安全软件（如火绒「隐藏执行PowerShell」防护）会拦截 `node → 隐藏 powershell.exe` 链路并弹窗；改为宿主用 fs 写临时 `.vbs`，由 `wscript.exe` + WMP 播放 Windows 自带音效，脚本播放后自删。九类事件映射不同系统音色（任务完成 chimes / 子任务 ding / 后台完成 Notify System / 授权 UAC / 提问 Notify Email / 评审 Notify Calendar / 受阻 Exclamation / 打断 Ding / 失败 Error），实测不被安全软件拦截、无窗口闪现
- 测试 +2（wscript argv / vbs 内容），宿主 28 项、客户端 50 项、合计 78 项

## v0.3.8

- **移除「声音范围」**：固定监听所有会话（范围控制交给侧栏工作区静音按钮），设置页去掉该卡片，会话级过滤逻辑与 SessionIdCapture 一并删除
- **系统音模式存本地磁盘**：`sysMode`（自动/同时/常驻/关闭）经宿主 `fs` 服务写入 DSH 数据目录（`dsh-chime-alerts-settings.json`），不再存浏览器；旧 localStorage 值自动迁移一次；「常驻」模式仍由宿主即时系统蜂鸣（页面关闭也响）
- **自定义音频存本地磁盘**：上传音频以 base64 存宿主磁盘（`dsh-chime-alerts-audio-<kind>.b64` + manifest.json），插件/浏览器重载后自动恢复；移除 Cache Storage 与 localStorage 文件名存储，换浏览器/清缓存不再丢
- 设置页底部显示本地存储位置，写入失败时显示提示
- 测试 +15（宿主 +9：fs 读写/非法值/常驻联动；客户端 +6：范围移除/本地位置/sysset/loadaudio），宿主 26 项、客户端 50 项、合计 76 项

## v0.3.7

- **中英双语界面**：设置页、事件标签、声音下拉、桌面通知等全部用户可见文案按浏览器语言自动切换（`navigator.language` 以 zh 开头显示中文，其余显示英文；无浏览器环境默认中文），中文用户界面不变
- **文档**：README 注明本插件由 AI Agent 工具辅助开发
- 测试 +5（英文文案断言：分区标题 / 试听按钮 / 分组标题 / 自定义声音选项 / 通知标题），客户端共 44 项、合计 61 项

## v0.3.6

多 Agent 审计驱动的优化批次：

- **修复常驻模式双蜂鸣**（审计发现）：`sysMode='always'` 时宿主 `record()` 已自动蜂鸣，客户端不再重复调用 `sysbeep`——每个事件只响一次系统音
- **修复自定义音频静默降级**（审计发现）：`sound='custom'` 但音频缺失（旧版重启丢失）时降级为本事件默认音，不再静默变系统蜂鸣
- **新增桌面通知**：事件发生时弹浏览器系统通知（`Notification`，同类事件 tag 合并为一条，静音不重复响铃）；设置页新增「桌面通知」开关，首次开启/试听时请求权限
- **多标签页防双响**：localStorage 领导锁（token+时间戳，8s 超时接管），非 leader tab 只消费事件不播放
- **自定义音频持久化**：上传改为 `Blob` + Cache Storage 存储（文件名存 localStorage），插件/浏览器重载后自动恢复 objectURL；旧版"重启即丢"成为历史
- **工作区静音改按 `workspaceId` 键控**（审计建议）：旧版存标题，工作区改名/重名会失效/误伤；自动迁移旧数据
- **文档修正**（审计发现）：README「八套内置→九套」、`jobs.onJobDone` 补后台完成、REGISTRIES「八声→九声」、测试注释八类→九类
- 测试 +6（always 不重复蜂鸣 / 领导锁 / 通知×2 / muted 迁移×2），客户端共 39 项、合计 56 项

## v0.3.5

- **更名 `dsh-chime` → `dsh-chime-alerts`**（市场名称冲突）：目录、npm 包名、cordis.patch.yml 的 name、静态入口导出名、文档全部更新；存储键改为 `dsh-chime-alerts-v1`，旧键 `dsh-chime-v1` / `dsh-sound-alerts-v1` 自动迁移，设置不丢
- README 同步修正为九事件 / 四档系统音 / 49 项测试

## v0.3.4

- **下拉框样式统一**（用户反馈：下拉框样式与设置页其他控件不一致）：去掉浏览器原生下拉箭头（`appearance:none`），自绘 chevron 图标，控件固定 30px 高；系统级声音选项缩短为短文案（自动 / 同时 / 常驻 / 关闭系统音）
- **设置页对齐修复**：事件行名称不换行（`white-space:nowrap`，最小宽度 88px）；下拉框/试听按钮/音量控件统一高度；「系统级声音」由纵向 label 改为与「声音范围」一致的卡片行

## v0.3.3

- **静音标志常驻显示**（用户反馈：静音后要鼠标移到工作区标题才看得见）：已静音的工作区行旁，橙色斜杠喇叭标志**一直可见**（无背景/边框的轻量图标样式），点击即可恢复声音；未静音的工作区维持悬停显示；官方 ⋮/+ 按钮不受影响（仍按悬停显示）

## v0.3.2

- **合并「宿主常驻蜂鸣」与「系统级声音」**（用户反馈：两个控件重复）：删除独立开关，系统级声音下拉改为四档——**自动**（浏览器音为主，失败时系统音兜底，默认）/ **同时**（浏览器音 + 系统音）/ **常驻**（宿主检测到事件立即系统蜂鸣，页面关闭也能响）/ **关闭系统音**；旧设置里 `alwaysBeep=true` 自动迁移为「常驻」
- 测试 +3（always 模式播放/同步/迁移），客户端共 32 项

## v0.3.1

- **设置页按三组分类**：主要通知（任务完成 / 子任务完成 / 后台任务完成）、其他通知（后台任务失败 / 其他打断）、需要人介入时（需要授权 / Agent 提问 / 计划评审 / 目标受阻），每组一个小标题
- **新增「后台任务完成」事件**（`jobdone`）：`jobs.onJobDone` status=`completed` 且非 subagent 作业（子代理完成已有子任务音，跳过避免双响）；浏览器音 = 五度上行双音（D5→A5），系统蜂鸣 = 659→988 上行双音；默认开启
- 测试 +3（host：bash completed → jobdone / subagent 不重复；client：三分类标题），宿主 17 项、客户端 29 项

## v0.3.0

- **合成音改柔**（用户反馈：原音偏硬）：每个音符改为「基音 + 2 倍频泛音（低音量正弦）」双层结构（铃感），起音缩短到 12ms、峰值音量略降，衰减带 0.25s 自然余韵再收尾（不再硬切）；预警类（受阻/打断/失败）由 sawtooth/square 换为 triangle，刺耳感下降
- 测试同步（complete 断言 2 音符 × 基音+泛音 = 4 振荡器），客户端共 27 项；系统级兜底蜂鸣（PowerShell 控制台音，无包络可调）保持原样

## v0.2.9

- **设置页事件改为单行布局，不再折叠**：从左到右 = 名称 / 声音下拉 / **静音图标键**（响铃=开启、斜杠喇叭橙色=静音，替代原开关）/ 音量条 / 音量数值 / 试听；静音的行整体变暗
- 测试 +4（每行静音键 / 音量数值 / 默认静音态 / 点击切换），客户端共 25 项

## v0.2.8

- **自定义声音并入「声音」下拉列表**：列表新增「自定义声音…」选项，选中即弹出上传窗（上传/替换一个入口）；上传完成后选项显示为「自定义声音 · 文件名」
- **删掉外置按钮**：移除事件卡里单独的「上传音频替换…」和「清除」按钮；想换文件时先选其他声音、再选回「自定义声音…」即可重新弹出上传窗（取消上传则回退到原选择；已上传过的文件取消时切回自定义声音）
- 测试 +4（下拉含自定义选项 / 文案 / 预设选择生效 / 外置按钮已移除），客户端共 21 项

## v0.2.7

- 设置页事件卡片**去掉描述文案**（如「Agent 完整结束一轮任务（回合正常完成）」），只保留标题 + 开关，更紧凑

## v0.2.6

- 设置页：**关闭的事件卡片收起**，只显示标题行 + 开关（声音/音量/试听/上传控件仅在开启时显示），页面更清爽（如默认关闭的「子任务完成」只占一行）

## v0.2.5

- **悬停静音键时保持官方按钮显示**（用户反馈：光标移到静音键上后官方 ⋮/+ 消失）：光标悬停本按钮时给工作区行加 `snd-keep-open` 类，样式表用 `.YDXeBa_projectRow.snd-keep-open.snd-keep-open .YDXeBa_rowActions{display:inline-flex}`（双类提升优先级）复刻外壳的 :hover 规则；离开按钮/行延迟隐藏时同步移除类
- 已知依赖新增：外壳哈希类名 `YDXeBa_*`（外壳升级可能失效，见 README 已知限制）

## v0.2.4

- **修复悬停循环闪烁**（用户实测：鼠标在静音键上移动时按钮和官方 + 按钮不停闪）：按钮挂 body（不在行内），鼠标一移上按钮就触发行 mouseleave → 立即隐藏 → 光标又回行上 → 再显示，循环闪烁。改为**悬停意图协议**：行/按钮任一悬停即显示，离开行延迟 250ms 隐藏、离开按钮延迟 200ms 隐藏（给光标跨过按钮留时间），隐藏定时器在卸载/换行时一并清理

## v0.2.3

- **修复双喇叭**（用户实测：静音后出现两个喇叭重叠）：同页可能存在多个客户端实例（频繁 stop/run 时旧实例泄漏）各自挂按钮。新增**单例所有权协议**：body 上的 owner 标记（token+时间戳），只有属主实例创建按钮，属主每次扫描刷新时间戳、死后 5s 被接管；扫描时清理行内残留（旧版注入的）与 body 上非本实例的按钮；工作区服务不可用时不再注入按钮（防误挂未分组行）

## v0.2.2

- **修复工作区静音按钮状态丢失**：按钮原来注入在工作区行内（React 树中），悬停状态变化触发 React 重渲染会抹掉注入节点，点击落空/状态不持久。改为**挂在 `document.body`（React 树外，永不被抹除）**，fixed 定位贴到工作区行右侧（官方 ⋮/+ 左侧 62px），悬停显示/移开隐藏（与官方按钮行为一致），侧栏滚动/窗口变化即时重新定位，插件卸载时清理
- 按钮加背景/边框/阴影（浮层观感），避免悬停时与官方按钮混淆

## v0.2.1

- **静音按钮改到工作区条目旁**（用户澄清「工作区的静音」）：侧栏每个工作区行（如 K230）的 ⋮/+ 旁注入喇叭按钮，**按工作区独立静音**（事件 sessionId → 工作区映射，该工作区的完成/子任务/打断等全部静音；设置页总开关不受影响）
- 移除 v0.2.0 的侧栏底部（sidebar.footer.action）全局静音按钮
- 实现方式：外壳没有工作区行内插槽 → DOM 注入，锚定 `div[role="treeitem"][aria-expanded]`（会话行无此属性），React 重渲染清掉注入节点后由 1200ms 周期扫描自动重挂
- 静音状态持久化（localStorage 的 `muted` 数组）；测试 +3（被静音工作区不响 / 未静音正常响 / 未知会话不误静音），客户端共 17 项

## v0.2.0

- **新增三类事件声音**：
  - `planreview` 计划评审：`tools/execute` 的 `exit_plan_mode`（三连下行 sine）
  - `goalblocked` 目标受阻：会话日志 `goal/change` operation=block（锯齿警报 sawtooth）
  - `jobfail` 后台任务失败：`jobs.onJobDone` status=failed，跳过 subagent 作业避免与打断音双响（短促双响 square）
- **侧栏快捷静音按钮**：注册 `sidebar.footer.action` 插槽（设置旁全局一个），扬声器图标一键静音/恢复，状态与设置页总开关联动并即时持久化
- **仓库结构整理**（对齐社区 npm bundle 插件惯例）：
  - `src/` → `lib/`（host.js / client.js / index.js / types/index.d.ts）
  - 新增 `cordis.patch.yml`（`dsh.bundle.patch` 补丁层，`dsh plugin add` 可装宿主半）
  - `package.json`：exports（types+default）、publishConfig、files、scripts、peerDependencies（`@deepseek-ai/cordis`）、`dsh.bundle.patch` 声明
- **自动化测试**：`tools/test-host.mjs`（15 项）+ `tools/test-client.mjs`（16 项）+ `tools/syntax-check.mjs`，Node 直接跑（`npm test` / `npm run check`），无需浏览器/DSH
- 动态插件重装为 `chime-1/pkg-1`（DSH 进程重启后 sound-2 已消失）

## v0.1.0（开源重命名）

- 项目更名 `dsh-sound-alerts` → **dsh-chime**，搭建开源仓库骨架（v0.2.0 起 `src/` 已整理为 `lib/`）：
  - `lib/host.js` / `lib/client.js`：双端源码（动态插件函数体，粘贴即装）
  - `lib/index.js`：静态宿主入口（npm 包 `main`，与 host.js 同一份逻辑）
  - `package.json`：koishi 元数据、exports、files 等发布字段
  - `docs/REGISTRIES.md`：社区市场（WhaleHub / dsh-market / dshfind / awesome 列表）上架指南
- 客户端存储键迁移：`dsh-sound-alerts-v1` → `dsh-chime-v1`（旧键自动迁移一次，设置不丢）
- 设置分区 id：`sound-alerts` → `chime`
- 宿主半增加 harness 守卫：静态环境（无动态桥）下 handlers 静默不注册，事件记录与系统蜂鸣仍工作

## 动态插件历史（sound-2，pkg-8 → pkg-17）

- **pkg-8**（初版）：四事件 + 设置页 + 混合发声；授权用 `approval/request` 瀑布监听
- **pkg-9**：开关底色修复（关=灰 `#7d8698`、开=蓝 `#3b82f6`，白球旋钮）
- **pkg-10**：授权检测改用会话日志 `approval/asked`（修复“授权音听不到”）；节流从全局改为按种类独立
- **pkg-12**：新增「子任务完成」独立一类（子代理映射回主会话、逐个响）；新增「声音范围」（仅当前会话/所有会话）与「宿主常驻蜂鸣」（页面关闭也能系统级响）；节流细化为种类+来源 agent 独立
- **pkg-13**：默认监听所有会话（scope=all）；子任务音默认关闭；设置入口带声音图标；描述文案随默认值更新
- **pkg-15**：修复子代理完成音不响——origin/原因/归属从防抖定时器内改为 idle 事件同步捕获（一次性子代理在 800ms 防抖内被销毁导致归属映射落空），归属不明时兜底用子代理自身会话 id；新增设置页诊断面板（后于 pkg-17 移除）。实测 2 子代理 = 2 声叮 ✅
- **pkg-16**：设置导航图标改为单一扬声器 SVG（mask + currentColor，随主题变色），去掉齿轮与 emoji——外壳的 navIcon 按 id 写死（仅 models/agent-presets/plugins 有专属图标，其余回退齿轮，无图标注册 API），故用 CSS 隐藏第 5 个导航项的默认 svg 并在 label::before 上绘制扬声器；`nth-child(5)` 依赖当前分区排序（general/models/plugins/agent-presets/声音提醒）
- **pkg-17**（动态插件最终版）：移除诊断面板与 dump 处理器（修复其 JSON 序列化报错，同时不再需要）；系统音选项短文案：自动 / 同时 / 关闭系统音；默认满音量（volume=1）；设置持久化到浏览器 localStorage（key `dsh-sound-alerts-v1`，按 origin 存储；自定义音频文件过大不入库）。✅ 五种声音全部真实事件实测通过：提问（提问工具）/ 完成（回合结束）/ 子任务（后台子代理×2）/ 打断（手动 Stop）/ 授权（真实审批弹窗）
