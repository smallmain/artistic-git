# Artistic Git

Artistic Git 是面向美术资产工作流的 Git 桌面客户端，基于 Tauri 2、
React、TypeScript、Vite、shadcn/ui、Tailwind CSS 与 Rust 构建。

## 功能

- 打开既有 Git 仓库、克隆 HTTPS 或 SSH 远程仓库，并在多窗口中管理最近项目。
- 浏览带虚拟滚动的提交图、分支/标签标记、提交搜索与可复用 Diff 详情。
- 查看本地更改，覆盖文本、图片、二进制、超大文件、LFS 指针、子模块指针与
  LFS 锁定状态。
- 按勾选文件提交、储藏全部或部分更改、切换/创建/删除分支、撤回提交，并通过同一
  冲突流程恢复。
- 无 force-push 同步当前与非当前分支，通过本地安全备份处理远程历史改写，并用
  fast-forward-only 语义应用项目自动跟踪规则。
- 支持审查模式、崩溃/关窗保护、定时 Fetch、更新提示，以及面向可复现发布的内嵌
  Git/Git LFS resources。

## 开发

环境要求：

- Node.js 与 pnpm
- Rustup 与 Cargo（helper 构建会安装钉死的 Rust 工具链）
- Tauri 2 所需的平台依赖

常用命令：

```sh
pnpm install
pnpm test
pnpm cargo:test
pnpm tauri:dev
```

项目的生产 Git 操作始终使用 `src-tauri/resources/git-dist` 中的内嵌工具链。
开发、构建、测试与发布打包都会先确保该固定资源树存在，且不会搜索或使用系统 Git。

## 隐私基线

Artistic Git 不包含遥测、分析 SDK、崩溃上报上传器，也不连接开发者自营服务。默认
情况下，应用只会访问用户配置的 Git 远程仓库与 GitHub Releases 更新源。Gravatar
头像 URL 只有在用户于设置中启用 Gravatar 后才会生成。CI 中的
`pnpm privacy:audit` 会扫描运行时代码、发布脚本与文档，拦截未批准的 URL 字面量或
浏览器网络 API。

常规开发命令会自动准备钉死的工具链，也可以显式执行：

```sh
pnpm git-toolchain:ensure -- --target=macos-universal
pnpm git-toolchain:verify -- --target=macos-universal
```

下载的 Git、Git LFS、OpenSSH、helper 与生成的 manifest 都是被忽略的本地构建产物。
仓库缓存固定为 `.cache/artistic-git/git-toolchain`；指纹有效时不会下载或重建。人工
revision 更新流程与 CI cache 策略见 [docs/git-dist.md](docs/git-dist.md)。真实 Git
Tauri E2E 说明见
[docs/e2e-real-git.md](docs/e2e-real-git.md)。

Windows 使用当前工具链 revision 明确钉死的 Win32-OpenSSH，macOS 与 Linux 使用
操作系统 OpenSSH。任何组件都不会自动更新；维护者必须先明确修改版本、URL 与
SHA-256，再执行 `pnpm git-toolchain:update -- --revision=<new-revision>`。

## 发布基线

最低支持的发布目标：

- macOS 13 或更新版本（`.app`、`.dmg` 与带签名的 updater tar artifacts）
- Windows 10 1809 或更新版本，并安装 Microsoft Edge WebView2（NSIS 当前用户
  `.exe` 安装器）
- 与 Ubuntu 22.04 WebKitGTK 4.1 运行栈兼容的 Linux 发行版（`.AppImage` 与
  `.deb`）

updater 产物使用 Tauri updater 密钥签名。初始 `0.1.x` 发布线不要求 Apple
notarization 或 Windows OS 级代码签名；这些证书作为后续发布硬化工作跟进。macOS
请先移动到 `/Applications`，再右键选择「打开」并确认一次；Windows SmartScreen
可能需要选择「更多信息」→「仍要运行」。

CI 仅保留两个 workflow：`Release`（测试、并行 phase12 perf、E2E、dry-run 或完整
打包、证据汇总、可选发布）与 `Git Toolchain`（契约校验、三平台冷构建审计、定时
keep-warm 保活 cache）。Release workflow 会在 `main` push 与 `workflow_dispatch`
运行，但只有来源为 `main` 且 `ENABLE_MAIN_RELEASE=true` 时才发布，不使用 GitHub
Environment 或人工审批。闸门未开启时，只执行测试与 Tauri `--no-bundle` dry-run
构建，不发布产物。手动运行可以使用自动版本计算，也可以覆盖 SemVer 升级级别。
每个平台发布 job 都会恢复精确的仓库工具链 cache，在本平台执行 ensure 与 verify，
打包固定资源树，并校验包内 manifest 与文件哈希；发布不再消费其他 workflow 的
二进制 artifact。仓库和 GitHub Releases 必须保持公开，以保证 updater 产物 URL
可访问。

发布需要在仓库外生成 Tauri updater 密钥对。私钥保存到 GitHub Secrets 的
`TAURI_SIGNING_PRIVATE_KEY`，公钥保存到 GitHub Variables 的
`TAURI_UPDATER_PUBLIC_KEY`（或同名 Secret），如设置密码则保存到
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。release job 会在签名打包前把公钥注入
`src-tauri/tauri.conf.json`，并拒绝占位值。发布任务会上传各平台安装包、签名后的
updater 产物，并为 GitHub Releases 生成 `latest.json`；AppImage 支持应用内更新，
`.deb` 用户应从 release 页面安装新版。

## 提交约定

提交信息使用英文 Conventional Commits，例如：

```text
feat: add repository health check
fix: preserve selected files after stash restore
```
