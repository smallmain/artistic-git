# Artistic Git Contracts

This document records the phase 0.5 baseline that allows later tracks to work
in parallel without drifting across Rust, TypeScript, resources, and tests.

## Rust Crates

- `crates/contracts`: shared DTO truth source for `AppError`, app events,
  diff/conflict payloads, and embedded Git distribution metadata.
- `crates/app`: command handlers and bindings export entry points.
- `crates/core`: Tauri-independent domain types and services.
- `crates/git-runner`: embedded Git distribution resolution and command runner.
- `crates/helpers`: application-owned credential helper and SSH askpass
  binaries; both are mandatory toolchain components.
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

Development and packaged resources expose the same fixed `git-dist` tree.
Local commands materialize it at `src-tauri/resources/git-dist`; packaged builds
resolve the same layout under Tauri resources. There is no path override.

```text
git-dist/
  manifest.json
  git/
    bin/git(.exe)
    libexec/git-core/...
  git-lfs/
    git-lfs(.exe)
  openssh/                       # Windows only
    ssh.exe
  helpers/
    artistic-git-credential-helper(.exe)
    artistic-git-ssh-askpass(.exe)
```

`manifest.json` is represented by schema 2 `GitDistManifest` in
`crates/contracts`. It records the target, manual toolchain revision,
base/helper/distribution fingerprints, component versions, executable paths,
and complete file hashes. Git execution code accepts an explicit distribution
root only. Searching `PATH` or using system Git is not allowed.

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

Both helper executables are thin application-owned adapters for Git's standard
credential-helper and SSH askpass protocols. They route prompts to the app's
local IPC contract and are not independent credential stores. They are built,
fingerprinted, packaged, and verified as mandatory parts of the embedded
toolchain.

## Test Bootstrap

Core Git integration tests load the fixed resource tree through the shared test
support. A missing or invalid `manifest.json` is a hard failure. Standard test
commands run toolchain ensure first; direct Cargo invocations report the ensure
command instead of skipping tests.
