# 安装与排错 · dsh-chime-alerts

## 前提

- 已装好 **DeepSeek Harness**（桌面端或 Web 端都可）。
- **Node ≥ 22.19**（由 DSH 自身决定，插件沿用）。包内声明了 `engines.dsh >= 0.2.0-rc.2`，装到更老的 DSH 上会被拒绝。
- 下文命令里的 `<profile>` 换成你自己的 profile 名：桌面端一般是 `desktop`（`dsh profile list` 可查），纯 Web 部署常见 `web`。

## 方式一：从插件页安装（推荐）

1. 打开 DSH → **插件**；
2. 点 **添加插件**，选择本仓库目录（含 `package.json` 的那一层）；
3. 装完在列表里把开关打开；
4. **刷新页面**；宿主半的改动需要**重启 DSH** 才生效。

## 方式二：从 npm

```bash
dsh plugin --profile desktop add dsh-chime-alerts
```

- 想固定版本：`dsh plugin --profile desktop add dsh-chime-alerts@0.6.1`。
- `dsh plugin --profile <name> <pnpm 参数>` 只是把参数转给 pnpm，**装完不等于启用**；启用状态来自 profile 的 `dsh.profile.bundles`，到「插件」页把开关打开即可。
- 安装完重开 DSH；如果「设置」里没有「声音提醒」，先确认插件确实在列表里且是开着的。

## 方式三：克隆 + link

```bash
git clone https://github.com/nienieai/dsh-chime-alerts.git
cd dsh-chime-alerts
dsh plugin --profile desktop add link:.
```

改代码后不需要重装，刷新页面（客户端）或重启 DSH（宿主）即可。

## 方式四：动态安装（不落盘）

适合「不想往 profile 里装东西」或「临时试一下」。**DSH 重启后要重装。**

1. 打开 `dynamic/host.body.js`，全文粘贴给 `cordis_define`（它是函数体形态，不是 ESM）；
2. 打开 `lib/client.js`，全文粘贴给 `cordis_define`；
3. 用 `cordis_run` 激活；
4. 刷新页面，设置里出现「声音提醒」。

注意事项：

- 两半**必须来自同一个包**——`cordis_define` 用包名合并，更新时如果只贴了一半，另一半会被当成旧内容卸载。
- 文件较大（宿主半 ~75 k 字符、客户端 ~95 k 字符），一次贴不进去时用 `.chunks/host.txt` / `.chunks/client.txt`：它们把同一份源码按 1500 字符切成 JSON 文本帧，**逐帧粘贴**（每帧都是 JSON 字符串，拼起来正好是原文）。
- 动态版没有 HTTP 端点，宿主半通过 `harness` 桥与页面通信；`sysget` / `sysset` 等能力的语义与静态版一致，但**不监听端口**。
- 动态版延迟略高（≤ ~1.5s），静态版完成类事件是实时的。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-chime-alerts
```

- 也可以只在「插件」页关掉开关（保留依赖，不再加载）。
- 宿主提醒的配置留在 `~/.dsh/plugins/dsh-chime-alerts/`（Windows：`%USERPROFILE%\.dsh\plugins\dsh-chime-alerts`）；不需要就整个目录删掉。
- 网页部分的设置存在浏览器 `localStorage`，卸载不会自动清；想彻底清理可在浏览器控制台执行 `localStorage.removeItem('dsh-chime-alerts-v1')` 与 `localStorage.removeItem('dsh-chime-alerts-v1-audiolib')`。

## 排错

| 现象 | 检查顺序 |
|---|---|
| 设置里没有「声音提醒」 | 插件列表里是否有它、开关是否打开、是否刷新过页面；再看 profile 的 `package.json`：`dependencies` 有 `dsh-chime-alerts`、`dsh.profile.bundles` 里也列了它 |
| 页面里不响 | 顶部总开关 → 该事件卡片的网页响铃开关 → 浏览器标签是否被静音 → 音量滑杆是否 0 |
| 宿主提醒没动静 | 卡片里是否显式选了「响铃」或「通知」；「诊断信息」里的 `capBeep` / `capNotify` 是否为 true |
| Windows 杀毒软件报警 | 「通知」通道会隐藏调用 PowerShell（WinRT 桥）；放行一次，或改用「响铃」 |
| 通知栏标题显示别的应用 | Windows toast 借 AUMID：DSH 注册过就显示「DeepSeek Harness」，否则回落 PowerShell 自带 AUMID（不影响功能） |
| 装完一直不加载 | 重启 DSH；再不行 `pnpm install`（在 profile 目录）后重启 |
| 升级 DSH 后不响 | 事件契约可能变了：跑 `npm test`，并看「诊断信息」里的匹配计数 |
| 设置页页脚版本号对不上 | 运行 `npm run check`：它会把页脚版本与 `package.json.version` 比对 |

需要更细的实现说明见 [TECHNICAL.md](TECHNICAL.md)；安全问题见 [SECURITY.md](../SECURITY.md)。
