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
- Unsigned release outputs are CI/development artifacts only. Do not add
  Gatekeeper, SmartScreen, or package-manager bypass instructions for official
  releases.
- Run `pnpm release:check` after changing release scripts, Tauri bundle
  resources, or release workflow files.
