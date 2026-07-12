# Contributing

## Commit Messages

All commits must use Conventional Commits in English.

Release versioning reads commits since the previous semver tag. `fix` maps to a
patch bump, `feat` and `refactor` map to a minor bump, `!` or `BREAKING CHANGE`
maps to a major bump, and unparsed commit messages fall back to patch.

## Safety Rules

- Do not silently ignore expected, unexpected, or fatal errors.
- Destructive operations must require explicit confirmation.
- Core Git-flow tests must use real temporary repositories and the embedded Git
  distribution. Fake Git commands and system Git fallback are not allowed.
- UI text must go through i18n once the i18n layer is active.

## Release Safety

- Release publishing is disabled unless the source ref is `main` and
  `ENABLE_MAIN_RELEASE=true`; it does not use an Environment approval step.
- After a successful publish, CI applies the released version to
  `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and
  `crates/app/Cargo.toml`, then commits it back to the default branch with
  `[skip ci]` so local/dev builds show the same version as GitHub Releases.
- Local `tauri dev` builds do not run automatic updater checks. Development
  builds keep a placeholder updater public key and reject update network
  checks.
- Unsigned release outputs are CI/development artifacts only. Do not add
  Gatekeeper, SmartScreen, or package-manager bypass instructions for official
  releases.
- Run `pnpm release:check` after changing release scripts, Tauri bundle
  resources, or release workflow files.
