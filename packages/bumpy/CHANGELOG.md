# Changelog

## 🎉 1.0.0 <img src="https://raw.githubusercontent.com/dmno-dev/bumpy/main/images/frog-party.png" alt="bumpy-frog-party" width="80" style="image-rendering: pixelated;" align="right" />

_2026-04-21_

Initial stable release of bumpy — a modern monorepo versioning and changelog tool.

- Flexible dependency bump propagation with cascade control
- Fixed and linked package group strategies
- Flexible opt-in out for packages, custom deployment commands
- Pluggable changelog formatters with built-in GitHub formatter (PR links, commit links, contributor attribution)
- Interactive and non-interactive changeset creation (`bumpy add`)
- Conventional commits bridge for automatic changeset generation
- GitHub CI integration for PR checks and automated releases (`bumpy ci check`, `bumpy ci release`)
- Custom token support (`BUMPY_GH_TOKEN`) for triggering CI on version PRs
- Migration path from `@changesets/cli` (`bumpy migrate`)

_normal changelogs will be kept after this_
