# Artistic Git

Artistic Git is a Git desktop client designed for artists and binary-heavy
asset workflows. It is built with Tauri 2, React, TypeScript, Vite, shadcn/ui,
Tailwind CSS, and Rust.

## Development

Prerequisites:

- Node.js and pnpm
- Rust and Cargo
- Platform prerequisites required by Tauri 2

Common commands:

```sh
pnpm install
pnpm test
pnpm cargo:test
pnpm tauri:dev
```

The project intentionally uses an embedded Git distribution for production Git
operations. Core Git-flow tests must use `ARTISTIC_GIT_DIST_DIR` or packaged
resources and must never fall back to the system Git executable.

## Commit Convention

Use Conventional Commits in English, for example:

```text
feat: add repository health check
fix: preserve selected files after stash restore
```
