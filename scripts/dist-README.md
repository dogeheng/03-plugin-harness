# Harness —— 本地、可插件扩展的 AI Agent 宿主（方案 A，macOS 预览版）

这是方案 A（Node 26 宿主 + 进程隔离插件 + macOS Seatbelt 沙箱）的可运行发行包，只包含构建产物，不包含开发源码。运行环境为 macOS 26、Apple 芯片；包内自带 Node 26 运行时，无需另外安装 Node。

## 快速开始

在解压后的目录中执行：

```bash
./bin/harness daemon start                       # 启动后台进程 harnessd（只监听 127.0.0.1 和本机 Unix 套接字）
./bin/harness auth set openrouter                # 隐藏输入 API Key，保存在 macOS 钥匙串，不写入任何文件
./bin/harness plugin install plugins/git-insight # 安装前会列出权限并请你确认
./bin/harness chat "这个仓库最近改了什么？" --workspace /path/to/some/git/repo
./bin/harness open                               # 用一次性登录链接在浏览器打开管理界面
```

如果首次启动时 macOS 提示无法验证开发者，到“系统设置 → 隐私与安全性”中允许即可（包内的 Node 来自 nodejs.org 官方签名版本）。

常用命令：

| 目的 | 命令 |
|---|---|
| 查看状态（含沙箱是否生效） | `./bin/harness status` |
| 列出、审查、安装插件 | `./bin/harness plugin catalog` / `plugin inspect <目录>` / `plugin install <目录>` |
| 启用、禁用、重启、卸载 | `./bin/harness plugin enable|disable|restart|uninstall <插件>` |
| 修改设置 | `./bin/harness plugin config git-insight maxCommits=50` |
| 授予、撤销权限 | `./bin/harness plugin grant git-insight llm.invoke` / `plugin revoke ...` |
| 插件出问题时 | `./bin/harness plugin doctor`、`plugin logs <插件>`、`plugin trace <插件>` |
| 运行插件命令 | `./bin/harness run /changelog` |
| 切换模型 | `./bin/harness model set openrouter <模型ID>` |
| 工具审批策略 | `./bin/harness approvals write ask` |
| 停止 | `./bin/harness daemon stop` |

用户数据位于 `~/Library/Application Support/Harness`（数据库与插件数据）和 `~/Library/Logs/Harness`（日志）。设置环境变量 `HARNESS_HOME=<目录>` 可以把所有数据放到一个独立目录，便于试用后整体删除。

## 目录说明

| 路径 | 内容 |
|---|---|
| `bin/harness` | 命令入口（固定使用包内 Node 26） |
| `apps/cli/src/main.mjs`、`apps/daemon/src/main.mjs` | CLI 与宿主进程的打包产物 |
| `apps/web/dist/` | 本地 Web 管理界面 |
| `plugins/git-insight/` | 正式插件：Git 仓库洞察（3 个只读工具、`/changelog` 命令、提交时间线面板） |
| `examples/misbehave/` | 演示插件：不用 SDK、手写协议实现，可注入崩溃、卡死、超时、内存溢出、越权访问，用来观察宿主如何隔离和恢复 |
| `examples/panel-probe/` | 演示插件：纯声明式（无代码进程），只贡献一个界面面板，面板会逐项尝试越过沙箱并报告结果 |
| `packages/manifest/schema/` | 插件清单 `harness.plugin.json` 的 JSON Schema，编辑器可据此补全和校验 |
| `docs/` | 技术选型报告 |
| `node_modules/` | 仅含无法打包进单文件的依赖：macOS 钥匙串原生模块、Seatbelt 沙箱运行时 |

## 状态与开发源码

本发行包使用进程插件、macOS Seatbelt 和本地 Web 界面。源码、开发说明、测试与当前限制见 https://github.com/dogeheng/03-plugin-harness 。

MIT © 2026 Yuki Li。依赖和 Node 运行时保留其各自的许可证。
