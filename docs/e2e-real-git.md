# Real Git E2E

The Tauri/WebDriver smoke test always runs in Linux and Windows CI. The
full-chain real Git test runs only when a real embedded Git distribution is
available.

Required environment for the full-chain test:

```sh
export ARTISTIC_GIT_DIST_DIR=/absolute/path/to/git-dist
export ARTISTIC_GIT_E2E_REAL_GIT=1
pnpm e2e:tauri
```

`ARTISTIC_GIT_DIST_DIR` must contain `manifest.json` and the Git executable
declared by `manifest.paths.gitExecutable`. The E2E harness validates and uses
that explicit executable path. It must not search `PATH` and must not use the
system Git executable as a fallback.

CI Evidence

`pnpm e2e:real-git:report` writes
`artifacts/e2e-real-git-report-<platform>.json` with one of these statuses:

- `ready`: a real embedded Git executable was found and `git --version`
  succeeded through the manifest path. CI sets `ARTISTIC_GIT_E2E_REAL_GIT=1`
  and runs the full-chain WDIO spec.
- `skipped`: no `ARTISTIC_GIT_DIST_DIR` was configured. CI still runs the Tauri
  smoke spec and uploads the skipped report.
- `failed`: `ARTISTIC_GIT_E2E_REAL_GIT=1` was requested without a usable
  `ARTISTIC_GIT_DIST_DIR`, or the configured distribution is malformed. CI
  fails and uploads the failed report.

The full-chain WDIO spec is guarded by `pnpm e2e:check`, which rejects Tauri
backend invoke calls in `e2e/tauri/full-chain-real-git.e2e.ts`. Repository
readiness, commit selection, sync, conflict resolution, and revert must be
observed through stable UI selectors.
