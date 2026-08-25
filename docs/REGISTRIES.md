# 上架社区市场

调研结论（2026-05）：DSH 生态没有单一官方市场，社区是「GitHub 仓库 + PR 提交 registry 条目」模式。
官方 npm 发布路径见 [deepseek-harness 发布插件文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)
（Koishi 生态规范，见 [Koishi 发布指南](https://koishi.chat/zh-CN/guide/develop/publish.html)）。

> **状态（2026-08-25）**：npm 已发布 `dsh-chime-alerts@0.5.6`（`latest`），GitHub Release v0.5.6 为 Latest；静态安装与动态版功能对齐（含宿主蜂鸣开关 / 每事件宿主音配置 / 宿主试听）。

## 发布前检查

- [x] `package.json` 的 `repository.url` / `bugs.url` 换成真实仓库地址（`nienieai/dsh-chime-alerts`）
- [ ] `LICENSE` 版权行换成作者真名/昵称
- [x] npm 包名 `dsh-chime-alerts` 未被占用（已于 2026-08-25 发布 `0.5.6`，`latest` 指向它）
- [ ] README 放一段演示 GIF（九声试听：完成/子任务/后台完成/授权/提问/评审/受阻/打断/失败 + 静音按钮）
- [x] `npm publish`（package.json 已配 `publishConfig.access: public`；2026-08-25 首次发布 `0.5.6`）
- [x] 静态双端完成后再声明 `dsh.client`（v0.5.0 起已声明并实测：经典脚本封套 + `exports["./client"]`）

## 已实证的静态 bundle 模板

本仓库的 package.json 形态（`dsh.bundle.patch` + `exports` types/default + `publishConfig` + `files` + Node 测试）已按社区静态 bundle 模板验证：
- `dsh.bundle.patch` → `cordis.patch.yml`（`insert: [{ id, name: 包名 }]`）让 `dsh plugin --profile <name> add <包>` 一键安装
- 完整静态双端 = `exports["./client"]`（`window.__ModuleLoader__.load` 经典脚本封套）+ `dsh.client: { platform: "web", inject: [客户端服务模块 id] }`
- 客户端检测可以**不需要宿主桥**：inject `sessions`/`workspaces` 服务订阅快照（`running` / `pendingInteraction` / goal 投影 / `jobsBySession`）
- 设置页插槽一致（`settings.section`），label 支持 `() => string` 函数形式；样式用 `<style data-plugin data-plugin-css>` + HMR 去重

## 各市场提交入口

| 市场 | 仓库 | 提交方式 |
|---|---|---|
| WhaleHub 🐋 | [vvlife/whalehub-dsh](https://github.com/vvlife/whalehub-dsh) | 按仓库 README 的 registry 格式发 PR（发现/搜索/一键安装） |
| dsh-market | [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) | 按仓库 README 发 PR（DSH 内可视化市场） |
| dshfind | [hikariming/dshfind](https://github.com/hikariming/dshfind) | 发 PR / issue（插件市场 + 最佳实践） |
| awesome-deepseek-harness | [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) | 发 PR 加一条精选条目（低门槛高曝光） |

各市场 registry 字段名略有差异，以目标仓库 README 为准；通用元数据块：

```json
{
  "name": "dsh-chime-alerts",
  "description": "十类 Agent 事件的声音提醒：任务完成 / 子任务完成 / 后台任务完成 / 需要授权 / 插件授权 / Agent 提问 / 计划评审 / 目标受阻 / 其他打断 / 后台任务失败。浏览器 Web Audio 合成音 + 系统蜂鸣混合发声，每事件独立开关/声音/音量，工作区快捷静音。",
  "repo": "https://github.com/nienieai/dsh-chime-alerts",
  "npm": "dsh-chime-alerts",
  "tags": ["notification", "sound", "audio", "提醒", "声音"],
  "install": "动态插件：cordis_define 粘贴 lib/host.js + lib/client.js；静态 npm：dsh plugin add dsh-chime-alerts（npm 已发布 v0.5.6）",
  "platforms": ["windows", "linux", "macos"],
  "license": "MIT"
}
```

## 参考案例

- 官方发布文档：[publish.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)
- 官方脚手架 RFC（模板仓库 + `pnpm create dsh-plugin`）：[Discussion #1629](https://github.com/deepseek-ai/deepseek-harness/discussions/1629)
- 社区开发引导（含 entry-contract 参考）：[vlln/plugin-registry](https://github.com/vlln/plugin-registry)
