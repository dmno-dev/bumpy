# Changelog

## 1.5.0

<sub>2026-04-29</sub>

- [#60](https://github.com/dmno-dev/bumpy/pull/60) - Show source package info in changelogs for indirect bumps instead of inheriting the source package's change descriptions

## 1.4.2

<sub>2026-04-28</sub>

- [#58](https://github.com/dmno-dev/bumpy/pull/58) - Skip ^0.x peer dep warning when major bump triggers major cascade

## 1.4.1

<sub>2026-04-28</sub>

- [#55](https://github.com/dmno-dev/bumpy/pull/55) - Fixed CI check to skip gracefully when no managed packages changed, and count none entries as covered in strict mode.

## 1.4.0

<sub>2026-04-28</sub>

- [#53](https://github.com/dmno-dev/bumpy/pull/53) - Changed `none` bump type to no longer suppress cascading bumps — it now just skips the direct bump while allowing dependency propagation to apply normally. Added `--hook` flag to `bumpy check` for pre-commit/pre-push hook context, with untracked/staged bump file detection. Added `bumpy add --none` shortcut to acknowledge all changed packages without bumping. Empty bump files no longer bypass `--strict` mode.

## 1.3.0

<sub>2026-04-25</sub>

- [#51](https://github.com/dmno-dev/bumpy/pull/51) - Remove --pat-pr and --pat-comments flags; BUMPY_GH_TOKEN is now auto-detected for PR operations and comments always use the default token (fixes fork PR support)
- [#50](https://github.com/dmno-dev/bumpy/pull/50) _(patch)_ - Fix typos in docs/README, add claude to CLI help AI setup targets, and use changelog formatter for GitHub release bodies.

## 1.2.2

<sub>2026-04-24</sub>

- [#46](https://github.com/dmno-dev/bumpy/pull/46) - Improve empty bump file handling — show file links and list alongside valid bump files
- [#49](https://github.com/dmno-dev/bumpy/pull/49) - Use distinct frog image variants for different PR comment contexts and add Varlock links to README.

## 1.2.1

_2026-04-22_

- Add `inCurrentBranch` and `publishTargets` fields to `status --json` output
- [#44](https://github.com/dmno-dev/bumpy/pull/44) - Fix PR diff links to use full absolute URLs with `/changes` path and sha256 anchors. Preserve `workspace:^`, `workspace:~`, and `workspace:*` shorthand ranges during versioning instead of resolving them.
- [#45](https://github.com/dmno-dev/bumpy/pull/45) - Surface bump file parse errors to users instead of silently ignoring them
- [#43](https://github.com/dmno-dev/bumpy/pull/43) - Fix frog images getting color-inverted in Gmail dark mode by wrapping in anchor tags. Make commit links opt-in via `includeCommitLink` option in GitHub changelog formatter, and add default list of bot/AI authors to skip "Thanks" attribution for.

## 1.2.0

_2026-04-22_

- [#36](https://github.com/dmno-dev/bumpy/pull/36) - Support JSONC in config file — allows // line comments, block comments, and trailing commas in .bumpy/\_config.json
- [#37](https://github.com/dmno-dev/bumpy/pull/37) - Rework `bumpy check` and `bumpy ci check` behavior: default mode now only fails when no bump files exist at all (matching changesets), new `--strict` flag requires every changed package to be covered, and `--no-fail` makes checks advisory-only. Also fix false positive "empty bump file found" when deleted bump files appear in git diff.

## 1.1.0

_2026-04-22_

- [#29](https://github.com/dmno-dev/bumpy/pull/29) - Generate comprehensive README.md in .bumpy/ during init with auto-detected package manager commands
- [#30](https://github.com/dmno-dev/bumpy/pull/30) - Fix check command to only count bump files from current branch, and handle empty bump files correctly in both local and CI check
- [#32](https://github.com/dmno-dev/bumpy/pull/32) - Fix empty bump files not being deleted during versioning
- [#33](https://github.com/dmno-dev/bumpy/pull/33) - Generate command now detects bumps from all commits, not just conventional commits.
- [#34](https://github.com/dmno-dev/bumpy/pull/34) - Add published JSON schema for config file with editor autocomplete/validation. New config options: `changedFilePatterns` (root + per-package) for filtering which file changes trigger package detection, `commit` object form for custom commit messages, and `changelog: false` to disable changelog generation.
- [#35](https://github.com/dmno-dev/bumpy/pull/35) - Merge migrate command into init — `bumpy init` now auto-detects `.changeset/` and handles migration. Added 🐸 emoji to success messages across all commands.

## 🎉 1.0.0 <img src="https://raw.githubusercontent.com/dmno-dev/bumpy/main/images/frog-party.png" alt="bumpy-frog-party" width="80" style="image-rendering: pixelated;" align="right" />

_2026-04-21_

Initial stable release of bumpy — a modern monorepo versioning and changelog tool.

- Flexible dependency bump propagation with cascade control
- Fixed and linked package group strategies
- Flexible opt-in out for packages, custom deployment commands
- Pluggable changelog formatters with built-in GitHub formatter (PR links, optional commit links, contributor attribution)
- Interactive and non-interactive changeset creation (`bumpy add`)
- Conventional commits bridge for automatic changeset generation
- GitHub CI integration for PR checks and automated releases (`bumpy ci check`, `bumpy ci release`)
- Custom token support (`BUMPY_GH_TOKEN`) for triggering CI on version PRs
- Migration path from `@changesets/cli` (`bumpy migrate`)

_normal changelogs will be kept after this_
