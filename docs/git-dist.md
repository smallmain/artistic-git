# Embedded Git Toolchain

Artistic Git treats Git and its companion executables as part of the product.
Every development, test, CI, and release path uses the generated resource tree
at `src-tauri/resources/git-dist`. The runtime has no configurable distribution
path and never searches for system Git.

## Version Contract

`git-dist.toml` pins Git, Git LFS, Windows OpenSSH, source URLs, SHA-256 values,
build recipes, `toolchain_revision`, and Rust `1.96.1` for the application-owned
credential and askpass helpers. `git-toolchain.lock.json` records the canonical
third-party definition digest for every target.

Versions never advance automatically. Changing a component, checksum, or base
build recipe without creating a new manual revision is rejected. The update
flow is:

1. Edit the intended versions, URLs, checksums, or recipes in `git-dist.toml`.
2. Choose a new revision and run:

   ```sh
   pnpm git-toolchain:update -- --revision=<new-revision>
   ```

3. Review the config and lock diff.
4. Run the Git Toolchain workflow's clean three-platform build audit.

The update command does not query or select the newest upstream release.

## Local Commands

```sh
pnpm git-toolchain:ensure
pnpm git-toolchain:ensure -- --target=macos-universal
pnpm git-toolchain:verify -- --target=macos-universal
pnpm git-toolchain:config:check
```

Supported targets are `macos-universal`, `windows-x86_64`, and
`linux-x86_64`. When no target is supplied, the command derives the current
platform target.

Ensure validates the complete active tree first. A valid tree returns without
network access, Cargo, file replacement, or mtime changes. Otherwise it reuses
valid base and helper cache entries, builds only missing fingerprints, assembles
a temporary complete tree, validates it, and atomically activates it. Failures
leave the previous tree intact but do not accept an outdated tree as success.

Verify is read-only and fails when any target, revision, fingerprint, manifest
path, file hash, executable mode, component version, or runtime smoke check is
invalid. Config check validates only the committed configuration and lock; it is
not proof that a product resource tree exists.

## Cache Layout

The ignored repository-local cache is fixed at
`.cache/artistic-git/git-toolchain`:

```text
downloads/<sha256>/
bases/<target>/<base-fingerprint>/
helpers/<target>/<helper-fingerprint>/
work/
locks/
```

Downloads are addressed by verified upstream SHA-256. Base fingerprints cover
third-party definitions and build recipes. Helper fingerprints cover helper
sources, `Cargo.lock`, the helper crate version, release profile, target, and
fixed Rust version. Per-fingerprint and activation locks make concurrent ensure
calls build each entry once.

The only active product tree is:

```text
src-tauri/resources/git-dist/
  manifest.json
  git/
  git-lfs/
  openssh/                 # Windows only
  helpers/
```

This directory is generated and ignored in its entirety; it contains no tracked
mount-point file. `GitDistManifest` records the explicit target,
`toolchainRevision`, base/helper/distribution fingerprints, component versions,
relative executable paths, and every regular file SHA-256.

## Platform Policy

- Windows packages pinned MinGit, Git LFS, Win32-OpenSSH, and both helpers.
- macOS packages universal Git, Git LFS, and helper binaries containing arm64
  and x86_64 slices. It uses the operating system OpenSSH.
- Linux packages Git, Git LFS, and both helpers. It uses the operating system
  OpenSSH.

Installed Git builtin aliases are represented by deterministic relative
wrappers rather than copied full Git binaries. Runtime smoke covers builtin
dispatch, transport, clone, fetch, push, and Git LFS.

## Build, Test, CI, and Release

The standard dev, build, test, Cargo test, E2E, and performance commands invoke
ensure before their work. Missing resources are built; invalid resources are
repaired or fail. Tests do not silently return early.

CI test and release jobs restore two independent exact caches: downloads plus
bases use the target and base fingerprint, while helpers use the target and
helper fingerprint. They do not use prefix restore keys. A helper-only change
therefore does not invalidate Git, Git LFS, or OpenSSH. Every job still runs
ensure and verify, so cache contents are an optimization rather than trusted
build input.

The Git Toolchain workflow's audit job performs a cold build for all three
targets and uploads only `manifest.json`, `build-evidence.json`, and
`size-report.json`.
The size report measures component composition and same-hash copies of the main
Git binary. macOS/Linux must reduce those duplicate bytes by at least 80% from
the audited v0.1.2 expanded distributions. It also emits total and per-component
`+10%` recommended budgets for fixing the first post-change CI baseline.
Release jobs build or reuse their own exact cache and never download a complete
toolchain from another workflow. Before and after bundling, release jobs validate
the manifest, file hashes, and runtime executables.
