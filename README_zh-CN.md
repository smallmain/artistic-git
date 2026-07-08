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

## 隐私基线

Artistic Git 不包含遥测、分析 SDK、崩溃上报上传器，也不连接开发者自营服务。默认
情况下，应用只会访问用户配置的 Git 远程仓库与 GitHub Releases 更新源。Gravatar
头像 URL 只有在用户于设置中启用 Gravatar 后才会生成。CI 中的
`pnpm privacy:audit` 会扫描运行时代码、发布脚本与文档，拦截未批准的 URL 字面量或
浏览器网络 API。

当钉死的分发产物可构建后，可用以下命令准备本地开发 resources：

```sh
pnpm fetch:git-dist -- --dev-resources --target=macos-universal
export ARTISTIC_GIT_DIST_DIR="$PWD/src-tauri/resources/git-dist"
pnpm git-dist:check:runtime -- --target=macos-universal
```

下载的 Git、Git LFS、OpenSSH 与生成的 manifest 都是本机构建产物，不提交到普通
Git 仓库。当前版本钉死、CI artifact/cache 策略与构建限制见
[docs/git-dist.md](docs/git-dist.md)。
真实 Git Tauri E2E 的环境准备与 skipped/failed 报告语义见
[docs/e2e-real-git.md](docs/e2e-real-git.md)。

在 Win32-OpenSSH 仍是记录明确的 preview 占位源期间，
`pnpm git-dist:check:real` 只有在确认 real build 模式会拒绝该占位源时才通过。
真正的下载、构建与打包任务仍会阻断，直到替换为稳定官方包，或在占位模式之外记录
单独的发布风险例外。

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

release workflow 会在 `main` push 与 `workflow_dispatch` 运行，但只有在
`ENABLE_MAIN_RELEASE=true` 且 GitHub `release` Environment 放行时才发布。闸门未
开启时，只执行测试与 Tauri `--no-bundle` dry-run 构建，不发布产物。手动运行可以
使用自动版本计算，也可以覆盖 SemVer 升级级别。正式发布还需要提供已经完成的 Git
Distribution workflow run id，可通过 `git_dist_run_id` 手动输入或
`GIT_DIST_RUN_ID` 仓库变量传入；每个平台打包前都会下载并校验对应的
`artistic-git-dist-*` artifact，并在打包后扫描对应 target 输出中的
`git-dist/manifest.json`。仓库和 GitHub Releases 必须保持公开，以保证 updater
产物 URL 可访问。

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
