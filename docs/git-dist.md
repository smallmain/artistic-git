# Embedded Git Distribution

Artistic Git uses an embedded Git distribution for all production Git and Git
LFS operations. Runtime code and integration tests must resolve executables from
`ARTISTIC_GIT_DIST_DIR` during development or from packaged Tauri resources in
release builds. Falling back to `PATH` or the system `git` executable is a hard
failure.

## Configuration

`git-dist.toml` is the single source of truth for the distribution contract:

- pinned tool versions: Git, Git LFS, Win32-OpenSSH, helper binaries
- per-platform source/archive URL fields and SHA-256 fields
- build recipes for macOS and Linux Git artifacts
- the Tauri resource layout used by both development and packaged builds

The current file is a phase 1A skeleton. Its source URLs, versions, and hashes
are explicit placeholders so that no workflow accidentally downloads or packages
large binaries before the real distribution job is implemented.

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

For contract-only checks that do not require local binaries:

```sh
node scripts/check-git-dist.mjs --schema-only
```

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

## CI Artifact And Cache Strategy

The initial `.github/workflows/git-dist.yml` workflow validates the config
contract and uploads a small placeholder artifact that documents the intended
artifact name. It intentionally does not build or download Git binaries yet.

The real distribution workflow should later use this policy:

- cache key includes OS, architecture, `git-dist.toml`, build scripts, and
  relevant container/toolchain versions
- cache hit still verifies every SHA-256 from `manifest.json`
- cache miss downloads or builds strictly from `git-dist.toml`
- placeholder versions, placeholder URLs, or zero SHA-256 values fail the build
- successful jobs upload `artistic-git-dist-<platform>` artifacts for test and
  packaging jobs to consume via `ARTISTIC_GIT_DIST_DIR`

## Upgrade Flow

1. Update versions, source URLs, SHA-256 values, and build recipe pins in
   `git-dist.toml`.
2. Run the distribution workflow on all supported platforms.
3. Verify `git --version`, `git lfs version`, manifest checksums, and downstream
   Rust integration tests using `ARTISTIC_GIT_DIST_DIR`.
4. Review binary provenance in the pull request.
5. Record user-visible toolchain changes in the release notes or changelog.
