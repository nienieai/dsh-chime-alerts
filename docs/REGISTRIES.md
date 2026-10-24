# 上架各插件市场

调研与核对时间：2026-10-25。下面每一条都来自对方站点的「收录/提交」页面或官方文档，不是推测。

## 一、各渠道的要求

### 1. dsh.so（社区索引站，扫描最严）

来源：<https://www.dsh.so/zh/submit/>

接受标准（必须全部满足）：

- DSH 兼容信号至少其一：`package.json` 的 `dsh` 字段 / `cordis` manifest / `dsh.plugin.*` manifest / 仓库带 `dsh-plugin` 话题
- README 带安装说明
- 开源许可证（SPDX 可识别）
- 插件 id 合规：仓库名（纯 npm 条目则为包名）匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`
- **源码可扫描**：仓库里要有可供安全扫描分析的源码（纯文档或空仓库无法完成扫描）
- **安全扫描无阻断级发现**：硬编码密钥、数据外传端点、破坏性操作、挖矿特征。警告级发现需人工复核
- 扫描器是 [`wulun811/dsh-plugin-vet`](https://github.com/wulun811/dsh-plugin-vet)：JS/TS 走 AST 规则（R1–R20），shell/PowerShell 走「下载即执行」模式匹配
- 检查对象是**已发布的 tarball**，不是仓库工作区
- 收录后的兼容性状态只有 `Declared`（声明），实测通过才可能变 `Verified`

### 2. DSH Plugin Hub（dsh-plugin.org）

来源：<https://dsh-plugin.org/zh/submit>（经其发布教程转述）

- GitHub **公开仓库**（私有仓库或只提供二进制的插件无法通过自动扫描）
- 仓库 Topics 加 `dsh-plugin`
- README 含可复制的安装命令 `dsh plugin --profile web add <包名>`
- 导出 `apply(ctx)`，符合插件规范
- 不冒充官方项目
- 收录后初始状态 `unconfirmed`，人工核实兼容性后才转 `verified`

### 3. DSH-Store（第三方市场 + 生命周期管理）

来源：<https://github.com/AI-Scarlett/DSH-Store>

- 除常规收录外要求 **Runtime Verified**：绑定具体 DSH 版本、操作系统、Profile、时间，并附**公开证据**（单元测试不算）

### 4. 其他旧渠道（仍可发 PR）

| 市场 | 仓库 |
|---|---|
| WhaleHub | [vvlife/whalehub-dsh](https://github.com/vvlife/whalehub-dsh) |
| dsh-market | [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) |
| dshfind | [hikariming/dshfind](https://github.com/hikariming/dshfind) |
| awesome-deepseek-harness | [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) |

## 二、本仓库的对照结果

| 要求 | 状态 |
|---|---|
| `dsh.bundle.patch` + `dsh.client` 声明 | ✅ `cordis.patch.yml` + `platform: web` |
| README 安装命令 | ✅ `dsh plugin --profile web add dsh-chime-alerts` |
| SPDX 许可证 | ✅ MIT |
| id 规范 `^[a-z0-9]+(-[a-z0-9]+)*$` | ✅ `dsh-chime-alerts` |
| 公开仓库 + `dsh-plugin` 话题 | ✅ 校验：`api.github.com/repos/nienieai/dsh-chime-alerts/topics` |
| 源码可扫描 | ✅ 纯 JS，无编译产物依赖 |
| `engines` 声明 | ✅ `node >=22.19.0` + `engines.dsh`（v0.6.1 补） |

### 自扫结果（用 dsh-plugin-vet 0.3.17 的真实扫描引擎）

| 目标 | verdict | 说明 |
|---|---|---|
| 发布 tarball（`npm pack`） | **clean**（score 68） | 无 high/critical；仅 medium：`rmSync` 临时文件（R11）、循环内 Map.set（R9）；info：`react` 幽灵依赖（DSH 客户端由宿主提供）、动态 base（R15） |
| 仓库工作区 | suspicious | 9 条 R2 high 全部来自 `tools/`（测试需要 eval 函数体源码）与本地未跟踪的 `preview/` 截图脚本；`tools/` 不随包发布 |

结论：**发布物可过 dsh.so 自动扫描**；仓库级扫描的 high 是「测试代码 eval 自身源码」这一形态导致的，已在 SECURITY.md 说明。

## 三、发布前检查

- [x] `repository.url` / `bugs.url` 指向真实仓库
- [ ] `LICENSE` 版权行换成真实作者名
- [ ] README 放演示 GIF
- [x] 静态双端（`exports["./client"]` + `dsh.client`）实测可用
- [x] `npm publish`（`latest` 当前为 `0.5.10`；`0.6.0` 未发布）
- [x] 安全加固（v0.6.1）：端点鉴权、请求体上限、试听限流、宿主音白名单

## 四、发布命令（备忘）

```sh
npm test                       # 460 项断言
npm run check                  # 语法 + 生成物一致性
npm pack --dry-run             # 核对发布物清单
npm publish                    # 需要维护者终端做 2FA（--otp 或网页 /auth/cli/*）
git tag v0.6.x && git push origin v0.6.x
```

## 五、参考

- 官方打包与安装：[publish.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)
- 官方插件索引格式：[plugin-market.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.zh.md)
- Web 载体与鉴权：[web-server.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-server.zh.md)
