# Plugin Harness

[![CI](https://github.com/dogeheng/03-plugin-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/dogeheng/03-plugin-harness/actions/workflows/ci.yml)

A local agent runtime for macOS, with a command-line client, web interface and isolated plugins. Written in TypeScript. 插件负责具体能力，宿主负责权限、审批、会话与进程管理。

## 功能

- CLI 与本地 Web 界面共享 SQLite 会话、工具调用和审批状态。
- 插件通过 JSON-RPC over stdio 通信；提供 TypeScript SDK、清单校验和测试工具。
- 插件工具、命令、钩子和隔离面板均由清单声明，支持安装、更新、回滚、权限撤销和开发模式热重载。
- Node 权限模型、macOS Seatbelt 与能力代理共同限制文件、网络、子进程和密钥访问。
- Git Insight 示例提供仓库状态、提交记录、差异统计、时间线和需确认的变更日志写入。
- 本地 HTTP 仅监听回环地址，CLI 使用本机 Unix socket；Web 使用一次性登录链接和会话 Cookie。

## 从源码运行

支持 macOS（当前验收环境为 Apple silicon，浏览器回归覆盖 Chrome 与 WebKit）。需要 Git、Node.js 26 和 pnpm 12.15.0；钥匙串及沙箱功能依赖 macOS。

```bash
git clone https://github.com/dogeheng/03-plugin-harness.git
cd 03-plugin-harness
./scripts/fetch-runtime.sh     # 下载并校验固定 Node 26.12.1，保存在 .runtime/
npm install -g pnpm@12.15.0    # 已安装对应版本可跳过
./scripts/rt.sh pnpm install --frozen-lockfile
pnpm build
./bin/harness daemon start
./bin/harness auth set openrouter
./bin/harness plugin install plugins/git-insight
./bin/harness chat "这个仓库最近改了什么？" --workspace /absolute/path/to/repo
./bin/harness open
```

模型服务需要你自己的 API Key；通过隐藏输入保存到 macOS 钥匙串。可用 `./bin/harness model set openrouter <model-id>` 更换模型。不要把密钥写入源码或提交。

试用时可先设置 `export HARNESS_HOME=/absolute/path/to/test-data`，将所有运行数据隔离到指定目录。默认数据位于 `~/Library/Application Support/Harness`，日志位于 `~/Library/Logs/Harness`。

```bash
./bin/harness status
./bin/harness plugin doctor
./bin/harness daemon stop
```

## 开发与测试

```bash
pnpm typecheck                # 宿主、CLI、共享包、Web 与插件面板
pnpm lint
pnpm check:boundaries         # 插件与宿主的依赖边界
pnpm test                    # 单元/集成测试，使用模拟模型
pnpm test:e2e --project=chrome # 本机 Google Chrome
pnpm e2e:install             # 可选：安装 WebKit
pnpm test:e2e --project=webkit
```

测试使用临时数据目录，不需要模型密钥。沙箱测试需要正常的 macOS 进程权限。不要同时运行单元测试和浏览器测试：二者都会重建示例插件。

```text
apps/daemon/          会话、模型、审批、API、插件管理与能力代理
apps/cli/             命令行入口
apps/web/             React 管理界面
packages/             协议、清单、SDK 与共享基础库
plugins/git-insight/  Git 示例插件
test/                 测试夹具与浏览器测试
docs/                 架构与安全说明
```

## 当前范围

这是面向单个本地用户的预览版本，不是远程多用户服务。模型输出和插件都需要审查；进程隔离不能替代对插件来源的信任。非 macOS 平台、WASM 插件后端、公开插件市场和第二个正式业务插件尚未实现。真实模型服务兼容性取决于配置的服务商和模型。

## 许可证与作者

MIT © 2026 [Yuki Li](https://github.com/dogeheng)。项目作者：Yuki Li。

依赖及其版权声明受各自许可证约束；本仓库不包含依赖、模型、API Key 或 Node 二进制。见 [LICENSE](LICENSE) 和 [SECURITY.md](SECURITY.md)。
