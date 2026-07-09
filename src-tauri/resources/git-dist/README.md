# git-dist

Development and packaged embedded Git resources use this layout:

```text
git-dist/
  manifest.json
  git/
  git-lfs/
  openssh/
  helpers/
```

The actual Git, Git LFS, OpenSSH, and helper binaries are produced by the
distribution pipeline and are not committed to the normal Git repository.

During development, either keep the real tree outside the repository and point
`ARTISTIC_GIT_DIST_DIR` at it, or use the ignored repository-local mount:

```sh
pnpm fetch:git-dist -- --dev-resources --target=macos-universal
export ARTISTIC_GIT_DIST_DIR="$PWD/src-tauri/resources/git-dist"
```

`--dev-resources` must produce a complete runnable tree; it is intentionally
incompatible with `--output`, `--download-only`, and `--no-extract`.

Run:

```sh
node scripts/check-git-dist.mjs --target=macos-universal
```

The checker fails when the environment variable, manifest, or referenced
executables are missing. It never searches for a system Git fallback.

Everything under this directory except this README is ignored by Git and should
remain a generated local artifact.

`manifest.sha256` is keyed by resource-relative executable path, for example
`git/bin/git` or `helpers/artistic-git-credential-helper`, and must cover every
required executable declared in `manifest.paths`.
