# Real Git E2E

The Tauri/WebDriver suites always use the embedded Git toolchain. There is no
opt-in mode, fake distribution, system Git lookup, or success-on-missing state.

## Local Run

Run the standard command for the current platform:

```sh
pnpm e2e:tauri
```

The command ensures `src-tauri/resources/git-dist` before building the current
application. The first run may download and build pinned components. Later runs
validate and reuse the same fingerprints without rebuilding.

To prepare or inspect the toolchain separately:

```sh
pnpm git-toolchain:ensure
pnpm git-toolchain:verify
```

## CI Evidence

Linux and Windows E2E jobs restore `.cache/artistic-git/git-toolchain` with an
exact target and lock-derived key, then run ensure and verify before WDIO. A
cache miss builds the pinned toolchain in that job. A missing, malformed, or
version-mismatched distribution fails the job.

`pnpm e2e:real-git:report` records the manifest target, toolchain revision,
distribution fingerprint, executable SHA-256 values, version smoke results, and
WDIO outcome. Phase 12 evidence is checkable only when the embedded Git and Git
LFS checks pass and the full-chain WDIO outcome succeeds. Evidence collection
does not turn a missing toolchain or failed test into a skipped success.

The full-chain WDIO spec is guarded by `pnpm e2e:check`, which rejects Tauri
backend invoke calls in `e2e/tauri/full-chain-real-git.e2e.ts`. Repository
readiness, commit selection, sync, conflict resolution, and revert are observed
through stable UI selectors.
