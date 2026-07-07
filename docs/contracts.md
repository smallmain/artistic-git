# Artistic Git Contracts

This document records the phase 0.5 baseline that allows later tracks to work
in parallel without drifting across Rust, TypeScript, resources, and tests.

## Rust Crates

- `crates/contracts`: shared DTO truth source for `AppError`, app events,
  diff/conflict payloads, and embedded Git distribution metadata.
- `crates/app`: command handlers and bindings export entry points.
- `crates/core`: Tauri-independent domain types and services.
- `crates/git-runner`: embedded Git distribution resolution and command runner.
- `crates/helpers`: future credential helper and SSH askpass binaries.
- `crates/test-support`: shared integration-test bootstrap utilities.

## TypeScript Bindings

Rust types derive `specta::Type`; `crates/app/src/bin/export-bindings.rs`
exports them into `src/lib/ipc/generated.ts`.

```sh
pnpm bindings:generate
pnpm bindings:check
```

`src/lib/ipc/generated.ts` is generated and must not be edited by hand.
`bindings:check` is part of CI and fails when regenerated bindings differ from
the committed file.

## Resource Layout

Development and packaged resources must expose the same `git-dist` tree.
`ARTISTIC_GIT_DIST_DIR` points at the development tree; packaged builds resolve
the same layout under Tauri resources.

```text
git-dist/
  manifest.json
  git/
    bin/git(.exe)
    libexec/git-core/...
  git-lfs/
    git-lfs(.exe)
  openssh/
    ssh.exe
  helpers/
    artistic-git-credential-helper(.exe)
    artistic-git-ssh-askpass(.exe)
```

`manifest.json` is represented by `GitDistManifest` in `crates/contracts`.
Git execution code must accept an explicit distribution root only. Searching
`PATH` or falling back to system Git is not allowed.

## Auth Helper IPC

Git commands that may need credentials receive a per-invocation local IPC
context through environment variables:

- `ARTISTIC_GIT_AUTH_SOCKET`: Unix socket path or future Windows named-pipe
  endpoint.
- `ARTISTIC_GIT_AUTH_TOKEN`: one-time token scoped to the invocation.
- `ARTISTIC_GIT_AUTH_INVOCATION_ID`: helper callback invocation id.
- `ARTISTIC_GIT_AUTH_OPERATION_ID`: parent app operation id.

The app injects `credential.helper`, `core.sshCommand`, `GIT_ASKPASS`, and
`SSH_ASKPASS` per command. Helpers must call only the local IPC endpoint from
the environment; they must not open network listeners. Unix sockets are
owner-only (`0600`). Windows named-pipe ACL enforcement is represented as a
platform security plan until the Windows implementation is added.

## Test Bootstrap

Core Git integration tests must call `artistic_git_test_support::require_git_dist`.
Missing `ARTISTIC_GIT_DIST_DIR` or missing `manifest.json` is a hard failure,
not a fallback path.
