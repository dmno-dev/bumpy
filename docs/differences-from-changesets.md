# Differences from Changesets

Bumpy is built as a modern successor to [@changesets/changesets](https://github.com/changesets/changesets). This document tracks the pain points, missing features, and design problems in changesets that bumpy addresses (or plans to address), with links back to the relevant GitHub issues.

---

## Implemented

### Sane dependency bump propagation

Changesets hardcodes aggressive behavior: a **minor** bump on a package triggers a **major** bump on all packages that peer-depend on it. This is the single biggest community complaint.

Bumpy splits propagation into three phases inside an iterative loop:

- **Phase A (always runs):** fixes broken version ranges — peer dep bumps match the triggering bump level, regular deps get patch, dev deps are skipped. Cannot be disabled.
- **Phase B:** enforces fixed/linked group constraints.
- **Phase C (opt-in):** proactive propagation via configurable `dependencyBumpRules` and `cascadeTo` rules. Off by default (`updateInternalDependencies: "out-of-range"`).

Key differences from changesets:

- Out-of-range peer dep bumps match the triggering bump level (not always major) — a minor bump on `core` → minor bump on `plugin`, not major
- Dev deps never propagate by default (configurable per-package for bundled devDeps)
- `cascadeTo` config for source-side "when I change, cascade to these packages"
- Per-bump-file `none` to suppress propagation on specific changes
- Warns about `^0.x` caret range gotchas and `workspace:*` on peer deps

See [docs/version-propagation.md](docs/version-propagation.md) for the full algorithm.

- [changesets#1011](https://github.com/changesets/changesets/issues/1011) — peerDependencies cause unnecessary major bumps (70+ thumbs-up)
- [changesets#822](https://github.com/changesets/changesets/issues/822) — unexpected major version bumps from peer deps
- [changesets#1126](https://github.com/changesets/changesets/issues/1126) — peer dep bumping is too aggressive
- [changesets#1228](https://github.com/changesets/changesets/issues/1228) — allow configuring peer dep bump behavior / 0.x versions
- [changesets#827](https://github.com/changesets/changesets/issues/827) — peer dep bump propagation should be configurable
- [changesets#960](https://github.com/changesets/changesets/issues/960) — unexpected version bumps in monorepos
- [changesets#944](https://github.com/changesets/changesets/issues/944) — devDependencies should be configurable (17 thumbs-up)
- [changesets#568](https://github.com/changesets/changesets/issues/568) — allow dependents to not be automatically bumped
- [changesets#1128](https://github.com/changesets/changesets/issues/1128) — `updateInternalDependencies` only on certain packages
- [changesets#808](https://github.com/changesets/changesets/issues/808) — ignore some packages on `updateInternalDependencies`
- [changesets#1819](https://github.com/changesets/changesets/issues/1819) — support major version propagation to dependents (`bumpAs: "match"`)
- [changesets#1735](https://github.com/changesets/changesets/issues/1735) — unidirectional dependency relationships (solved by `cascadeTo`)

### Custom publish commands

Changesets is hardcoded to `npm publish`. Bumpy supports per-package custom publish commands for VS Code extensions, Docker images, JSR, private registries, or anything else.

- [changesets#399](https://github.com/changesets/changesets/issues/399) — arbitrary publish steps (14 comments)
- [changesets#1318](https://github.com/changesets/changesets/issues/1318) — JSR support (39 thumbs-up)
- [changesets#1717](https://github.com/changesets/changesets/issues/1717) — JSR custom publish (12 thumbs-up)
- [changesets#1230](https://github.com/changesets/changesets/discussions/1230) — publishing Docker images
- [changesets#1297](https://github.com/changesets/changesets/discussions/1297) — publishing VS Code extensions

### Workspace protocol resolution

Changesets uses `npm publish` even in Yarn/pnpm workspaces, so `workspace:^` and `catalog:` protocols are NOT resolved, resulting in broken published packages. Bumpy resolves all workspace protocols correctly before publish.

- [changesets#432](https://github.com/changesets/changesets/issues/432) — workspace: ranges not resolved (33 comments)
- [changesets#1290](https://github.com/changesets/changesets/issues/1290) — workspace:^ not handled correctly
- [changesets#1421](https://github.com/changesets/changesets/issues/1421) — workspace:^ bumped on patch despite `updateInternalDependencies: "minor"`
- [changesets#1229](https://github.com/changesets/changesets/issues/1229) — workspace: protocol causes publish failures
- [changesets#1468](https://github.com/changesets/changesets/issues/1468) — workspace:^ published as-is (16 thumbs-up)
- [changesets#1454](https://github.com/changesets/changesets/issues/1454) — publishing with Yarn is broken (38 thumbs-up)
- [changesets#1707](https://github.com/changesets/changesets/issues/1707) — pnpm workspace catalog support (20 thumbs-up)

### Non-interactive CLI

`bumpy add` works fully non-interactively for CI/CD pipelines and AI-assisted development.

- [changesets#979](https://github.com/changesets/changesets/issues/979) — non-interactive mode (15 thumbs-up)
- [changesets#1118](https://github.com/changesets/changesets/discussions/1118) — CLI automation support

### Provenance and custom publish args

Bumpy supports passing extra args (like `--provenance`) to the publish command via config.

- [changesets#1152](https://github.com/changesets/changesets/issues/1152) — provenance support (36 thumbs-up, 26 comments)

### Topological publish order

Packages are published in dependency order so a partial failure doesn't leave the registry in a broken state.

- [changesets#238](https://github.com/changesets/changesets/issues/238) — publish order should respect dependency graph (11 comments)

### Default access: public

Bumpy defaults to `"access": "public"` since most open-source packages are public. Changesets defaults to `"restricted"`.

- [changesets#503](https://github.com/changesets/changesets/issues/503) — default access should be public (23 thumbs-up)

### Publish dry run

`bumpy publish --dry-run` previews what would be published without actually doing it.

- [changesets#614](https://github.com/changesets/changesets/issues/614) — dry run for publish (47 thumbs-up)

### Filtered/individual package publishing

`bumpy publish --filter "@myorg/core"` publishes only matching packages. Supports globs. Important for partial failure recovery and large monorepos.

- [changesets#1160](https://github.com/changesets/changesets/issues/1160) — filtered publish (34 thumbs-up)

### Aggregated GitHub releases

`aggregateRelease: true` in config creates a single consolidated GitHub release instead of one per package.

- [changesets#264](https://github.com/changesets/changesets/issues/264) — aggregated changelog (34 thumbs-up)
- [changesets#683](https://github.com/changesets/changesets/issues/683) — single changelog for fixed groups (16 thumbs-up)
- [changesets#1059](https://github.com/changesets/changesets/issues/1059) — aggregated GitHub releases (21 thumbs-up)
- [changesets#885](https://github.com/changesets/changesets/issues/885) — GitHub releases from CLI publish (19 thumbs-up)

### Lockfile update after version

`bumpy version` automatically runs `pnpm install --lockfile-only` / `bun install` / etc. to keep the lockfile in sync with bumped versions.

- [changesets#1139](https://github.com/changesets/changesets/issues/1139) — lockfile not updated (24 thumbs-up)

### Dates in changelog entries

Bumpy includes the release date in every changelog heading by default.

- [changesets#109](https://github.com/changesets/changesets/issues/109) — dates in changelog (17 thumbs-up)

### Migration tool

`bumpy init` detects `.changeset/` and automatically migrates — renaming the directory to `.bumpy/`, converting config, and keeping pending bump files.

- (Previously listed under Planned)

### Auto-generate from commits

`bumpy generate` scans commits on the current branch and auto-creates bump files. It works with any commit style — conventional commits get enhanced bump-level detection (`feat` → minor, `fix` → patch, `feat!` → major), while all other commits are mapped to packages via changed file paths (defaulting to `patch`). Not a replacement for explicit bump files — a bridge for teams migrating from semantic-release, or a convenience when you want both.

- [changesets#862](https://github.com/changesets/changesets/issues/862) — conventional commits integration (70 thumbs-up, 21 comments)

### Pluggable changelog formatters

Custom changelog formatters with full context (release info, bump files, dates). Built-in `"default"` and `"github"` (with PR links + author attribution) formatters. Users can write custom formatters in TypeScript or JavaScript. Changesets' API is limited to two awkward string-returning functions — bumpy gives you the full context and you return the complete entry.

- [changesets#658](https://github.com/changesets/changesets/issues/658) — changelog titles not customizable (12 thumbs-up)
- [changesets#556](https://github.com/changesets/changesets/issues/556) — changelog formatting (11 thumbs-up)
- [changesets#995](https://github.com/changesets/changesets/issues/995) — getChangelogEntry API (12 thumbs-up)

### CI without a separate action

`bumpy ci check` and `bumpy ci release` handle PR checks and release automation without needing a separate GitHub Action or bot installation. Just `bunx @varlock/bumpy ci check` in any workflow. No extra repository to trust, audit, or pin — your CI runs the same package you already depend on.

### Local bump file verification

`bumpy check` verifies that changed packages on the current branch have corresponding bump files. Designed for pre-push hooks — compares your branch to the base branch, maps changed files to packages. By default it only fails if no bump files exist at all (matching changesets behavior). Use `--strict` to require every changed package to be covered, or `--no-fail` for advisory-only mode. No GitHub API needed.

Changesets has no built-in equivalent — users rely on the CI bot comment to catch missing bump files after pushing.

---

## Planned / Not Yet Implemented

### Prerelease mode that actually works

Changesets' prerelease mode is described in their own docs as "very complicated" with "mistakes that can lead to repository and publish states that are very hard to fix." Key problems: no target on bump files, multi-branch corruption, exiting pre bumps ALL packages, bad interactions with linked/fixed groups.

- [changesets#729](https://github.com/changesets/changesets/issues/729) — exiting pre mode bumps all versions (14 comments)
- [changesets#786](https://github.com/changesets/changesets/issues/786) — can't control dist-tag in pre mode (13 comments)
- [changesets#635](https://github.com/changesets/changesets/issues/635) — prerelease workflow problems
- [changesets#239](https://github.com/changesets/changesets/issues/239) — prerelease mode design issues

### Root workspace / non-package changes

Track changes to CI, tooling, and monorepo-root-level config in changelogs — not just workspace packages.

- [changesets#1137](https://github.com/changesets/changesets/issues/1137) — root workspace support (26 thumbs-up)

### Non-JS ecosystem support

Support versioning and publishing beyond npm — Rust crates, .NET NuGet, Python packages, etc. — via a package manifest that doesn't require wrapper `package.json` files.

- [changesets#849](https://github.com/changesets/changesets/issues/849) — packages extensibility RFC (22 comments)
- [changesets#879](https://github.com/changesets/changesets/issues/879) — GitLab support (33 thumbs-up)
- [changesets#1329](https://github.com/changesets/changesets/discussions/1329) — .NET support
- [changesets#1760](https://github.com/changesets/changesets/discussions/1760) — pluggable architecture

### Maintenance / release branch workflows

Support for hotfixing older major versions on release branches.

- [changesets#1235](https://github.com/changesets/changesets/discussions/1235) — maintenance release workflow

---

## Changesets bugs we avoid by design

### "Does master exist?" CI failures

Bumpy doesn't shell out to git for branch comparisons during normal operations.

- [changesets#517](https://github.com/changesets/changesets/issues/517) — git failures in CI (41 comments)

### Infinite loop in version command

Bumpy's iterative propagation has a hard iteration cap.

- [changesets#571](https://github.com/changesets/changesets/issues/571) — infinite loop in changeset version (21 comments)
