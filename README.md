# Artistic Git

Artistic Git is a Git desktop client designed for artists and binary-heavy
asset workflows. It is built with Tauri 2, React, TypeScript, Vite, shadcn/ui,
Tailwind CSS, and Rust.

## Features

- Open existing Git repositories, clone HTTPS or SSH remotes, and manage recent
  projects across multiple windows.
- Browse branch history with a virtualized commit graph, branch/tag badges,
  commit search, and reusable diff details.
- Review local changes with text, image, binary, oversized-file, LFS pointer,
  submodule pointer, and lock-aware diff surfaces.
- Commit selected files, stash all or selected changes, switch/create/delete
  branches, revert commits, and recover conflicts through one shared conflict
  workflow.
- Sync current and non-current branches without force-push, handle rewritten
  remote history through local safety backups, and apply project automatic
  tracking rules with fast-forward-only semantics.
- Use review mode, crash/close guards, scheduled fetch, updater prompts, and
  embedded Git/Git LFS resources designed for reproducible releases.

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

## Privacy Baseline

Artistic Git has no telemetry, analytics SDKs, crash-report uploaders, or
developer-operated network services. By default, the app only contacts user
configured Git remotes and the GitHub Releases updater endpoint. Gravatar avatar
URLs are generated only after the user enables Gravatar in settings. The CI
`pnpm privacy:audit` check scans runtime code, release scripts, and docs for
unapproved URL literals or browser network APIs.

To prepare local development resources once the pinned distribution is
buildable, run:

```sh
pnpm fetch:git-dist -- --dev-resources --target=macos-universal
export ARTISTIC_GIT_DIST_DIR="$PWD/src-tauri/resources/git-dist"
pnpm git-dist:check:runtime -- --target=macos-universal
```

Downloaded Git, Git LFS, OpenSSH, and generated manifests are local build
outputs; do not commit them. See [docs/git-dist.md](docs/git-dist.md) for the
current pins, CI artifact/cache policy, and build limitations.
Real Git Tauri E2E setup and skipped/failed report semantics are documented in
[docs/e2e-real-git.md](docs/e2e-real-git.md).

Win32-OpenSSH is selected by a stable-first rule: use an official stable
`OpenSSH-Win64.zip` when available; otherwise use the pinned latest official
preview package as an explicit fallback. `pnpm git-dist:check:real` validates
that every git-dist source is stable or an approved fallback.

## Release Baseline

Minimum supported release targets:

- macOS 13 or newer (`.app`, `.dmg`, and signed updater tar artifacts)
- Windows 10 1809 or newer with Microsoft Edge WebView2 (`.exe` NSIS
  current-user installer)
- Linux distributions compatible with the Ubuntu 22.04 WebKitGTK 4.1 stack
  (`.AppImage` and `.deb`)

Updater artifacts are signed with the Tauri updater key. The initial `0.1.x`
release line does not require Apple notarization or OS-level Windows code
signing; those certificates are tracked as future release-hardening work. Move
the macOS app to `/Applications` and use right-click → Open once to approve it
in Gatekeeper. On Windows, SmartScreen may require More info → Run anyway.

The release workflow runs on `main` pushes and `workflow_dispatch`, but it
publishes only from `main` when `ENABLE_MAIN_RELEASE=true`. No GitHub
Environment or manual approval step is used. When the gate is not enabled, the
workflow runs tests and a Tauri `--no-bundle` dry-run build without publishing.
Manual runs can keep the automatic version calculation or override the SemVer bump level.
Publishing also requires a completed Git Distribution workflow run id, supplied
as the `git_dist_run_id` dispatch input or the `GIT_DIST_RUN_ID` repository
variable, so each platform package stages and verifies the matching
`artistic-git-dist-*` artifact before bundling, then scans the target-specific
build output for `git-dist/manifest.json` after bundling. The repository and
GitHub Releases must stay public so updater asset URLs remain reachable.

Publishing requires a Tauri updater key pair generated outside the repository.
Store the public key in GitHub Variables as `TAURI_UPDATER_PUBLIC_KEY` (or the
same-named Secret), the private key in GitHub Secrets as
`TAURI_SIGNING_PRIVATE_KEY`, and, when used, its password as
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The release job injects the public key
into `src-tauri/tauri.conf.json` before signed packaging and rejects placeholder
values. The publish job uploads the platform installers, signed updater
artifacts, and a generated `latest.json` for GitHub Releases; AppImage supports
in-app updates, while `.deb` users should install new versions from the release
page.

## Commit Convention

Use Conventional Commits in English, for example:

```text
feat: add repository health check
fix: preserve selected files after stash restore
```
