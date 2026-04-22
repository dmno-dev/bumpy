# Changelog

## 1.2.0

_2026-04-22_

- [#36](https://github.com/dmno-dev/bumpy/pull/36) [`43ee7ee`](https://github.com/dmno-dev/bumpy/commit/43ee7eed7e1d80a7b4aafd012b616d93c496a348) - Support JSONC in config file — allows // line comments, block comments, and trailing commas in .bumpy/\_config.json
- [#37](https://github.com/dmno-dev/bumpy/pull/37) [`9b74ae4`](https://github.com/dmno-dev/bumpy/commit/9b74ae4dfb07a3df5ff14c513b88797007d51e9e) - Rework `bumpy check` and `bumpy ci check` behavior: default mode now only fails when no bump files exist at all (matching changesets), new `--strict` flag requires every changed package to be covered, and `--no-fail` makes checks advisory-only. Also fix false positive "empty bump file found" when deleted bump files appear in git diff.

## 1.1.0

_2026-04-22_

- [#29](https://github.com/dmno-dev/bumpy/pull/29) [`8a3006f`](https://github.com/dmno-dev/bumpy/commit/8a3006fca143810d71f418a58c65c7a2ee6c0135) - Generate comprehensive README.md in .bumpy/ during init with auto-detected package manager commands
- [#30](https://github.com/dmno-dev/bumpy/pull/30) [`f53a71d`](https://github.com/dmno-dev/bumpy/commit/f53a71d598176182f1a0b4be24d473467a94150f) - Fix check command to only count bump files from current branch, and handle empty bump files correctly in both local and CI check
- [#32](https://github.com/dmno-dev/bumpy/pull/32) [`d800783`](https://github.com/dmno-dev/bumpy/commit/d8007837c80afe1ac5cd383050eb5bffbf440e97) - Fix empty bump files not being deleted during versioning
- [#33](https://github.com/dmno-dev/bumpy/pull/33) [`3b23fcd`](https://github.com/dmno-dev/bumpy/commit/3b23fcd62b366c9ecafb3a10308da9fa45d8c6a0) - Generate command now detects bumps from all commits, not just conventional commits.
- [#34](https://github.com/dmno-dev/bumpy/pull/34) [`ea14829`](https://github.com/dmno-dev/bumpy/commit/ea14829ccb346e05b6d284ff80c0d76d074f25fb) - Add published JSON schema for config file with editor autocomplete/validation. New config options: `changedFilePatterns` (root + per-package) for filtering which file changes trigger package detection, `commit` object form for custom commit messages, and `changelog: false` to disable changelog generation.
- [#35](https://github.com/dmno-dev/bumpy/pull/35) [`3415164`](https://github.com/dmno-dev/bumpy/commit/3415164b9388456e130b14ca21f2c90a042055c6) - Merge migrate command into init — `bumpy init` now auto-detects `.changeset/` and handles migration. Added 🐸 emoji to success messages across all commands.

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
