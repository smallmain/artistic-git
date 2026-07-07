# Contributing

## Commit Messages

All commits must use Conventional Commits in English.

## Safety Rules

- Do not silently ignore expected, unexpected, or fatal errors.
- Destructive operations must require explicit confirmation.
- Core Git-flow tests must use real temporary repositories and the embedded Git
  distribution. Fake Git commands and system Git fallback are not allowed.
- UI text must go through i18n once the i18n layer is active.
