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

## 提交约定

提交信息使用英文 Conventional Commits，例如：

```text
feat: add repository health check
fix: preserve selected files after stash restore
```
