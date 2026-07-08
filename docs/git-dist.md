# Embedded Git Distribution

Artistic Git uses an embedded Git distribution for all production Git and Git
LFS operations. Runtime code and integration tests must resolve executables from
`ARTISTIC_GIT_DIST_DIR` during development or from packaged Tauri resources in
release builds. Falling back to `PATH` or a system `git` executable is a hard
failure.

## Pinned Versions

The current pins were verified from official sources on 2026-07-07:

| Component              | Version              | Official URL                                                                  | Status      |
| ---------------------- | -------------------- | ----------------------------------------------------------------------------- | ----------- |
| Git source             | `2.55.0`             | `https://www.kernel.org/pub/software/scm/git/git-2.55.0.tar.xz`               | stable      |
| Git for Windows MinGit | `2.55.0.windows.2`   | `https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.2`       | stable      |
| Git LFS                | `3.7.1`              | `https://github.com/git-lfs/git-lfs/releases/tag/v3.7.1`                      | stable      |
| Win32-OpenSSH          | `10.0.0.0p2-Preview` | `https://github.com/PowerShell/Win32-OpenSSH/releases/tag/10.0.0.0p2-Preview` | placeholder |

Win32-OpenSSH has no modern stable official GitHub release at the time of this
pin. The latest official package is explicitly marked preview/non-production
ready, so it is recorded in `git-dist.toml` with its real SHA-256 but remains
`placeholder = true` and `stable = false`. Real build mode rejects it until a
stable source is selected or a separate risk exception is documented.

## Configuration

`git-dist.toml` is the single source of truth for the distribution contract:

- pinned versions for Git, Git for Windows, Git LFS, Win32-OpenSSH, and helper
  binaries
- supported targets: `windows-x86_64`, `macos-universal`, `linux-x86_64`
- per-target source/archive entries with official release/source URLs
- structured SHA-256 fields: `checksum.algorithm`, `checksum.value`,
  `checksum.source`, and `checksum.url`
- Tauri resource layout shared by development and packaged builds
- build recipes for macOS and Linux Git artifacts
- validation policy that permits placeholders only in schema-only mode

Schema-only validation:

```sh
node scripts/check-git-dist.mjs --schema-only
node scripts/fetch-git-dist.mjs --schema-only --target=linux-x86_64
```

Real build policy validation fails while any selected source is a placeholder:

```sh
node scripts/check-git-dist.mjs --schema-only --real-build
```

That failure is intentional until the Windows OpenSSH pin is resolved.
The package script is wired for CI-friendly reporting of that expected block:

```sh
pnpm git-dist:check:real
```

It succeeds only when real build mode rejects the documented placeholder. Once
all pins are release-ready, this command will fail and tell the caller to
remove the expected-placeholder mode.

## Fetch Pipeline

`scripts/fetch-git-dist.mjs` is the local and CI entry point for preparing a
distribution tree. It never invokes `git`, never searches `PATH` for Git, and
never falls back to a system Git.

Useful commands:

```sh
node scripts/fetch-git-dist.mjs --print-env --target=macos-universal
node scripts/fetch-git-dist.mjs --dev-resources --target=macos-universal --helper-profile=release
node scripts/fetch-git-dist.mjs --target=linux-x86_64 --download-only
node scripts/fetch-git-dist.mjs --target=windows-x86_64 --helper-dir=/path/to/helpers
```

Current phase 1A behavior:

- `--schema-only` parses `git-dist.toml` and validates target/source/checksum
  structure without network or filesystem artifact work.
- `--print-env` prints the `ARTISTIC_GIT_DIST_DIR` export line for the chosen
  output directory.
- `--dev-resources` uses `src-tauri/resources/git-dist` as the output directory
  so `pnpm tauri:dev` and local Rust tests can point at the same resource tree.
- real fetch mode rejects placeholders before any download.
- non-placeholder sources are downloaded, SHA-256 checked, and extracted into a
  staging directory.
- archive targets can be assembled from staged archive contents into the
  configured `git-dist/` layout. Assembly strips common single-directory archive
  roots, copies helper binaries, writes `manifest.json`, and records SHA-256
  values only after every required executable is present.
- macOS Git source tarballs are built on macOS/Xcode runners once per
  architecture (`arm64`, `x86_64`) with `RUNTIME_PREFIX=YesPlease`; installed
  trees are merged into a Universal distribution with `lipo`.
- Linux Git source tarballs are built inside `ubuntu:20.04` with the configured
  trimmed Git flags. On non-20.04 Linux hosts the script runs the build in
  Docker; on Ubuntu 20.04 it builds directly. The build fails if the final Git
  executable still links dynamic `libcurl`, `libssl`, `libcrypto`, `zlib`,
  `pcre2`, or `expat`.
- macOS Git LFS downloads both official Darwin archives and combines the
  architecture binaries into `git-lfs/git-lfs` during assembly.
- helper binaries may be supplied with `--helper-dir`, with explicit
  `--credential-helper` and `--ssh-askpass` paths, or from
  `target/release` / `target/debug` via `--helper-profile=release|debug|auto`.
  `--dev-resources` and `--build-helpers` run the release helper build before
  assembly. If helper binaries cannot be resolved, assembly fails with the
  missing candidates and no incomplete `manifest.json` is written.

Windows real fetch remains blocked before download while the Win32-OpenSSH
entry is a rejected placeholder, even though MinGit, Git LFS, and archive
assembly paths are covered by SHA-256 pins and fixture tests.

## Development Resources

Prepare a local development tree outside the normal Git repository, then point
`ARTISTIC_GIT_DIST_DIR` at it:

```sh
export ARTISTIC_GIT_DIST_DIR=/absolute/path/to/git-dist
node scripts/check-git-dist.mjs
```

The intended repository-local development resources flow is:

```sh
cargo build -p artistic-git-helpers --bins --release
pnpm fetch:git-dist -- --dev-resources --target=macos-universal --helper-profile=release
export ARTISTIC_GIT_DIST_DIR="$PWD/src-tauri/resources/git-dist"
node scripts/check-git-dist.mjs --target=macos-universal --no-exec
```

`--dev-resources` also builds the release helper binaries automatically, so the
short form is:

```sh
pnpm fetch:git-dist -- --dev-resources --target=macos-universal
export ARTISTIC_GIT_DIST_DIR="$PWD/src-tauri/resources/git-dist"
node scripts/check-git-dist.mjs --target=macos-universal --no-exec
```

`src-tauri/resources/git-dist/README.md` is tracked as the mount point
placeholder, but downloaded archives, extracted tools, and generated
`manifest.json` are local build outputs and must not be committed to the normal
Git repository.

The checker requires `manifest.json` and every executable referenced by that
manifest. It invokes only those explicit paths for version checks. If
`ARTISTIC_GIT_DIST_DIR` is missing, invalid, or incomplete, the check fails and
does not search for a system Git.

## Expected Layout

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

The `manifest.json` paths are relative to the `git-dist` root and match
`GitDistManifest` in `crates/contracts`.

`manifest.sha256` is keyed by manifest-relative executable path, not by logical
name. For example:

```json
{
  "paths": {
    "gitExecutable": "git/bin/git",
    "gitLfsExecutable": "git-lfs/git-lfs",
    "credentialHelper": "helpers/artistic-git-credential-helper",
    "sshAskpass": "helpers/artistic-git-ssh-askpass"
  },
  "sha256": {
    "git/bin/git": "<sha256>",
    "git-lfs/git-lfs": "<sha256>",
    "helpers/artistic-git-credential-helper": "<sha256>",
    "helpers/artistic-git-ssh-askpass": "<sha256>"
  }
}
```

`scripts/check-git-dist.mjs` verifies that every required executable path is
present, accessible, covered by `manifest.sha256`, and byte-for-byte matches its
declared SHA-256. It also verifies that manifest paths exactly match
`git-dist.toml`.

## Tauri Bundle Resources

Release packaging maps `src-tauri/resources/git-dist/` to the packaged Tauri
resource path `git-dist/` through `src-tauri/tauri.conf.json`. This keeps the
development resource layout and packaged resource layout aligned with
`GitDistManifest` paths.

Config-only self-check:

```sh
node scripts/check-tauri-bundle-resources.mjs
```

Real release packaging must stage a complete embedded Git distribution before
bundling:

```sh
ARTISTIC_GIT_DIST_DIR=src-tauri/resources/git-dist \
  node scripts/check-git-dist.mjs --no-exec --target=linux-x86_64
node scripts/check-tauri-bundle-resources.mjs --require-manifest
```

The release workflow runs the config-only check during dry-run builds. The
gated publish path additionally requires `manifest.json` and the target-specific
embedded Git executables to be present under `src-tauri/resources/git-dist/`.

## CI Artifact And Cache Strategy

`.github/workflows/git-dist.yml` always runs contract checks on pull requests
that touch the git-dist pipeline. Manual `workflow_dispatch` runs expose two
modes:

- `contract` validates config, source layout, SHA-256 fields, placeholder
  rejection, and Tauri bundle resource mapping without downloading binaries.
- `build` runs a target matrix and prepares reusable git-dist artifacts.

Build mode uses this policy:

- matrix targets: `windows-x86_64`, `macos-universal`, `linux-x86_64`, each on
  its native GitHub runner image.
- non-placeholder matrix jobs first run target-scoped real-build policy
  validation, so placeholder pins fail before cache restore, helper builds,
  download, or package work.
- placeholder-blocked matrix jobs run the expected-placeholder rejection check
  and stop without uploading an artifact. This keeps Windows OpenSSH preview
  status visible without publishing a fake Windows distribution.
- source archive cache key includes target, `git-dist.toml`, fetch/check
  scripts, lockfiles, and a manual `GIT_DIST_CACHE_VERSION`.
- assembled distribution cache key includes target, `git-dist.toml`, fetch/check
  scripts, helper crate sources, lockfiles, and `GIT_DIST_CACHE_VERSION`.
- cache hit still runs `scripts/check-git-dist.mjs --no-exec` against the
  restored `ARTISTIC_GIT_DIST_DIR`.
- cache miss builds the helper binaries, then runs
  `scripts/fetch-git-dist.mjs --target=<target>` with explicit output,
  source-cache, and staging directories.
- placeholder versions, placeholder URLs, non-stable sources, or zero SHA-256
  values fail before download/build/package
- successful jobs upload `artistic-git-dist-<target>` artifacts for later test
  and packaging jobs to consume via `ARTISTIC_GIT_DIST_DIR`.

Current limitation: Windows build mode intentionally skips artifact generation
while the Win32-OpenSSH entry remains `placeholder = true` / `stable = false`.
macOS and Linux now have executable source-build plumbing, but the phase 1A
checkbox should remain open until CI has produced and validated real artifacts.

Downstream jobs should consume an artifact like this:

```yaml
- uses: actions/download-artifact@v4
  with:
    name: artistic-git-dist-linux-x86_64
    path: src-tauri/resources/git-dist
- run: node scripts/check-git-dist.mjs --target=linux-x86_64 --no-exec
  env:
    ARTISTIC_GIT_DIST_DIR: src-tauri/resources/git-dist
```

## Upgrade Flow

1. Update versions, source URLs, SHA-256 values, and build recipe pins in
   `git-dist.toml`.
2. Run schema-only and real-build validation for every target.
3. Run the distribution workflow on all supported platforms.
4. Verify `git --version`, `git lfs version`, manifest checksums, and downstream
   Rust integration tests using `ARTISTIC_GIT_DIST_DIR`.
5. Review binary provenance in the pull request.
6. Record user-visible toolchain changes in the release notes or changelog.

## App Release Gate

`.github/workflows/release.yml` calculates the next SemVer version and release
notes from Conventional Commits since the previous semver tag. `fix` commits
produce a patch bump, `feat` and `refactor` commits produce a minor bump,
`!`/`BREAKING CHANGE` commits produce a major bump, and unparsed commit messages
fall back to a patch bump. With no previous tag, the initial version is
`0.1.0`.

`main` pushes and manual dispatches publish only when `ENABLE_MAIN_RELEASE=true`
and the GitHub `release` Environment allows the job. Otherwise the workflow
runs tests and a Tauri `--no-bundle` dry-run package build without creating a
GitHub Release.
Manual dispatches may keep the automatic bump or override it with `patch`,
`minor`, or `major`.

Formal publishing also requires a completed Git Distribution workflow run id.
Pass it as the `git_dist_run_id` manual-dispatch input or set the
`GIT_DIST_RUN_ID` repository variable for main-push releases. The package matrix
downloads `artistic-git-dist-<target>` from that workflow run into
`src-tauri/resources/git-dist`, then runs:

```sh
node scripts/check-tauri-bundle-resources.mjs --require-manifest --release
ARTISTIC_GIT_DIST_DIR=src-tauri/resources/git-dist \
  node scripts/check-git-dist.mjs --no-exec --target=<target>
```

`--release` additionally rejects the placeholder Tauri updater public key and
requires the GitHub Releases `latest.json` endpoint. The publish job generates
`latest.json` from signed updater artifacts, preferring Tauri updater packages
such as Windows `.exe.zip` and Linux `.AppImage.tar.gz` when those are present,
then uploads installers, updater artifacts, signatures, and `latest.json` to
GitHub Releases.
