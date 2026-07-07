# Artistic Git

Artistic Git 是面向美术资产工作流的 Git 桌面客户端，基于 Tauri 2、
React、TypeScript、Vite、shadcn/ui、Tailwind CSS 与 Rust 构建。

## 开发

环境要求：

- Node.js 与 pnpm
- Rust 与 Cargo
- Tauri 2 所需的平台依赖

常用命令：

```sh
pnpm install
pnpm test
pnpm cargo:test
pnpm tauri:dev
```

项目的生产 Git 操作必须使用内嵌 Git 分发。核心 Git 流程测试只能从
`ARTISTIC_GIT_DIST_DIR` 或打包 resources 获取显式 Git 路径，禁止回退到系统
Git。

## 发布基线

最低支持的发布目标：

- macOS 13 或更新版本（`.app`、`.dmg` 与带签名的 updater tar artifacts）
- Windows 10 1809 或更新版本，并安装 Microsoft Edge WebView2（NSIS 当前用户
  `.exe` 安装器）
- 与 Ubuntu 22.04 WebKitGTK 4.1 运行栈兼容的 Linux 发行版（`.AppImage` 与
  `.deb`）

正式发布必须签名；macOS 正式发布还必须完成 notarization。对于未签名的开发产物，
macOS 请先移动到 `/Applications`，再右键选择「打开」并确认一次；Windows
SmartScreen 可能需要选择「更多信息」→「仍要运行」。

release workflow 会在 `main` push 与 `workflow_dispatch` 运行，但只有在
`ENABLE_MAIN_RELEASE=true` 且 GitHub `release` Environment 放行时才发布。闸门未
开启时，只执行测试与 Tauri `--no-bundle` dry-run 构建，不发布产物。手动运行可以
使用自动版本计算，也可以覆盖 SemVer 升级级别。

发布需要在仓库外生成 Tauri updater 密钥对。私钥保存到 GitHub Secrets 的
`TAURI_SIGNING_PRIVATE_KEY`，如设置密码则保存到
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。公开发布前，需要把
`src-tauri/tauri.conf.json` 里的 updater `pubkey` 占位符替换为生成的公钥。
发布任务会上传各平台安装包、签名后的 updater 产物，并为 GitHub Releases 生成
`latest.json`；AppImage 支持应用内更新，`.deb` 用户应从 release 页面安装新版。

## 提交约定

提交信息使用英文 Conventional Commits，例如：

```text
feat: add repository health check
fix: preserve selected files after stash restore
```
