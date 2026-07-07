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

## Fetch Pipeline

`scripts/fetch-git-dist.mjs` is the local and CI entry point for preparing a
distribution tree. It never invokes `git`, never searches `PATH` for Git, and
never falls back to a system Git.

Useful commands:

```sh
node scripts/fetch-git-dist.mjs --print-env --target=macos-universal
node scripts/fetch-git-dist.mjs --target=linux-x86_64 --download-only
node scripts/fetch-git-dist.mjs --target=windows-x86_64
```

Current phase 1A behavior:

- `--schema-only` parses `git-dist.toml` and validates target/source/checksum
  structure without network or filesystem artifact work.
- `--print-env` prints the `ARTISTIC_GIT_DIST_DIR` export line for the chosen
  output directory.
- real fetch mode rejects placeholders before any download.
- non-placeholder sources are downloaded, SHA-256 checked, and extracted into a
  staging directory.
- source builds and final artifact assembly stop with an explicit handoff
  message; no incomplete `manifest.json` is written.

The source-build handoff is deliberate: macOS and Linux Git builds require the
CI toolchains described in `git-dist.toml`.

## Development Resources

Prepare a local development tree outside the normal Git repository, then point
`ARTISTIC_GIT_DIST_DIR` at it:

```sh
export ARTISTIC_GIT_DIST_DIR=/absolute/path/to/git-dist
node scripts/check-git-dist.mjs
```

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

## CI Artifact And Cache Strategy

`.github/workflows/git-dist.yml` currently runs contract checks and verifies
that real-build mode rejects the documented placeholder. It uploads a contract
note artifact only; it does not publish binaries yet.

Future distribution jobs should use this policy:

- matrix targets: `windows-x86_64`, `macos-universal`, `linux-x86_64`
- cache key includes target, `git-dist.toml`, fetch/build scripts, lockfiles,
  and relevant container/toolchain versions
- cache hit still runs `scripts/check-git-dist.mjs` against the restored
  `ARTISTIC_GIT_DIST_DIR`
- cache miss runs `scripts/fetch-git-dist.mjs --target=<target>` and the
  platform build recipe from `git-dist.toml`
- placeholder versions, placeholder URLs, non-stable sources, or zero SHA-256
  values fail before download/build/package
- successful jobs upload `artistic-git-dist-<target>` artifacts for test and
  packaging jobs to consume via `ARTISTIC_GIT_DIST_DIR`

## Upgrade Flow

1. Update versions, source URLs, SHA-256 values, and build recipe pins in
   `git-dist.toml`.
2. Run schema-only and real-build validation for every target.
3. Run the distribution workflow on all supported platforms.
4. Verify `git --version`, `git lfs version`, manifest checksums, and downstream
   Rust integration tests using `ARTISTIC_GIT_DIST_DIR`.
5. Review binary provenance in the pull request.
6. Record user-visible toolchain changes in the release notes or changelog.
