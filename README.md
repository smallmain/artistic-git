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

To prepare local development resources once the pinned distribution is
buildable, run:

```sh
pnpm fetch:git-dist -- --dev-resources --target=macos-universal
export ARTISTIC_GIT_DIST_DIR="$PWD/src-tauri/resources/git-dist"
pnpm git-dist:check
```

Downloaded Git, Git LFS, OpenSSH, and generated manifests are local build
outputs; do not commit them. See [docs/git-dist.md](docs/git-dist.md) for the
current pins, CI artifact/cache policy, and build limitations.

## Release Baseline

Minimum supported release targets:

- macOS 13 or newer (`.app`, `.dmg`, and signed updater tar artifacts)
- Windows 10 1809 or newer with Microsoft Edge WebView2 (`.exe` NSIS
  current-user installer)
- Linux distributions compatible with the Ubuntu 22.04 WebKitGTK 4.1 stack
  (`.AppImage` and `.deb`)

Official releases must be signed and, on macOS, notarized. For unsigned
development artifacts, move the macOS app to `/Applications` and use
right-click → Open once to approve it in Gatekeeper. On Windows, SmartScreen may
require More info → Run anyway for unsigned CI artifacts.

The release workflow runs on `main` pushes and `workflow_dispatch`, but it
publishes only when `ENABLE_MAIN_RELEASE=true` and the `release` GitHub
Environment allows the job. When the gate is not enabled, the workflow runs
tests and a Tauri `--no-bundle` dry-run build without publishing. Manual runs
can keep the automatic version calculation or override the SemVer bump level.

Publishing requires a Tauri updater key pair generated outside the repository.
Store the private key in GitHub Secrets as `TAURI_SIGNING_PRIVATE_KEY` and, when
used, its password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Replace the updater
`pubkey` placeholder in `src-tauri/tauri.conf.json` with the generated public
key before enabling public releases. The publish job uploads the platform
installers, signed updater artifacts, and a generated `latest.json` for GitHub
Releases; AppImage supports in-app updates, while `.deb` users should install
new versions from the release page.

## Commit Convention

Use Conventional Commits in English, for example:

```text
feat: add repository health check
fix: preserve selected files after stash restore
```
