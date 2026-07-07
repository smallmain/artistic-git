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

During development, keep the real tree outside the repository and point
`ARTISTIC_GIT_DIST_DIR` at it. Run:

```sh
node scripts/check-git-dist.mjs
```

The checker fails when the environment variable, manifest, or referenced
executables are missing. It never searches for a system Git fallback.

`manifest.sha256` is keyed by resource-relative executable path, for example
`git/bin/git` or `helpers/artistic-git-credential-helper`, and must cover every
required executable declared in `manifest.paths`.
