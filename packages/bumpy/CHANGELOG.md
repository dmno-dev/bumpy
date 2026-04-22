# Changelog

## 1.1.0

_2026-04-22_

- [#29](https://github.com/dmno-dev/bumpy/pull/29) [`040386c`](https://github.com/dmno-dev/bumpy/commit/040386c685ef08b66888a2fdf6b9dfaedb4298db) - Generate comprehensive README.md in .bumpy/ during init with auto-detected package manager commands
- [#30](https://github.com/dmno-dev/bumpy/pull/30) [`acdf57c`](https://github.com/dmno-dev/bumpy/commit/acdf57c2d403f6aef4b15f2876ed171c85bd771e) - Fix check command to only count bump files from current branch, and handle empty bump files correctly in both local and CI check
- [#32](https://github.com/dmno-dev/bumpy/pull/32) [`6f9bce7`](https://github.com/dmno-dev/bumpy/commit/6f9bce77b518cdc075467b46113f2f6b0e1d6a76) - Fix empty bump files not being deleted during versioning
- [#33](https://github.com/dmno-dev/bumpy/pull/33) [`d2d73c4`](https://github.com/dmno-dev/bumpy/commit/d2d73c4b91cb12d75635629454a63cc3d5ad4118) - Generate command now detects bumps from all commits, not just conventional commits.
- [#34](https://github.com/dmno-dev/bumpy/pull/34) [`32c3856`](https://github.com/dmno-dev/bumpy/commit/32c385600b43e1b6f8b414b748031bef8f47e1b5) - Add published JSON schema for config file with editor autocomplete/validation. New config options: `changedFilePatterns` (root + per-package) for filtering which file changes trigger package detection, `commit` object form for custom commit messages, and `changelog: false` to disable changelog generation.
- [#35](https://github.com/dmno-dev/bumpy/pull/35) [`83814c7`](https://github.com/dmno-dev/bumpy/commit/83814c76bd4ffdc1fd2ce5dfdb6ce281a2174e03) - Merge migrate command into init — `bumpy init` now auto-detects `.changeset/` and handles migration. Added 🐸 emoji to success messages across all commands.

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
