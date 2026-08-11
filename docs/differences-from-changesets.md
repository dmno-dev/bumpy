# Differences from Changesets

Bumpy is built as a modern successor to [changesets](https://github.com/changesets/changesets). This document tracks the real differences between the two tools, with links back to the relevant GitHub issues.

> **Changesets v3 note:** [`@changesets/cli@3.0.0`](https://github.com/changesets/changesets/releases/tag/%40changesets%2Fcli%403.0.0) and [`changesets/action@v2`](https://github.com/changesets/action/releases/tag/v2.0.0) shipped on 2026-08-11 — a major release that fixed many long-standing v2 complaints, including **15+ of the issues this doc previously tracked** (forced peer-dep major bumps, `workspace:` protocol resolution, non-interactive `add`, topological publish order, publish failure handling, and more). Credit where due — it's a substantial cleanup. This doc now compares against **v3**; the things v3 fixed are summarized in [Fixed in changesets v3](#fixed-in-changesets-v3) at the bottom.

---

## Remaining differences (vs changesets v3)

### Configurable dependency bump propagation

Changesets v2 hardcoded the most aggressive behavior possible: a **minor** bump on a package triggered a **major** bump on all packages that peer-depend on it — the single biggest community complaint (fixed in v3). Changesets v3 hardcodes the opposite extreme: peer dependency updates now always bump dependents by **patch**, i.e. every peer dep change is assumed non-breaking, and if it isn't you must remember to add a manual major changeset. Neither version lets you configure the behavior.

Bumpy splits propagation into three phases inside an iterative loop:

- **Phase A (always runs):** fixes broken version ranges — peer dep bumps **match the triggering bump level** (a minor bump on `core` → minor bump on `plugin`; not blanket major like changesets v2, not blanket patch like v3), regular deps get patch, dev deps are skipped. Cannot be disabled.
- **Phase B:** enforces fixed/linked group constraints.
- **Phase C (opt-in):** proactive propagation via configurable `dependencyBumpRules` and `cascadeTo` rules. Off by default (`updateInternalDependencies: "out-of-range"`).

Other propagation differences that remain:

- Dev deps never propagate by default, but specific ones can be opted in per-package via `releaseTriggeringDevDeps` (e.g. bundled deps) — still not configurable in changesets
- `cascadeTo` config for source-side "when I change, cascade to these packages"
- Per-bump-file `none` to acknowledge changes without triggering a direct bump
- Warns about `^0.x` caret range gotchas and `workspace:*` on peer deps

See [docs/version-propagation.md](./version-propagation.md) for the full algorithm.

Still-open changesets issues in this area:

- [changesets#944](https://github.com/changesets/changesets/issues/944) — devDependencies should be configurable (17 thumbs-up)
- [changesets#568](https://github.com/changesets/changesets/issues/568) — allow dependents to not be automatically bumped
- [changesets#1128](https://github.com/changesets/changesets/issues/1128) — `updateInternalDependencies` only on certain packages
- [changesets#808](https://github.com/changesets/changesets/issues/808) — ignore some packages on `updateInternalDependencies`
- [changesets#1819](https://github.com/changesets/changesets/issues/1819) — support major version propagation to dependents (`bumpAs: "match"`)

### Custom publish commands

Changesets only publishes to npm-compatible registries — v3 now routes publishes through the workspace's own package manager CLI (npm, pnpm, or Yarn Berry), but there's still no way to publish anything that isn't an npm package. Bumpy supports per-package custom publish commands for VS Code extensions, Docker images, JSR, private registries, or anything else.

- [changesets#399](https://github.com/changesets/changesets/issues/399) — arbitrary publish steps (14 comments)
- [changesets#1318](https://github.com/changesets/changesets/issues/1318) — JSR support (39 thumbs-up)
- [changesets#1230](https://github.com/changesets/changesets/discussions/1230) — publishing Docker images
- [changesets#1297](https://github.com/changesets/changesets/discussions/1297) — publishing VS Code extensions

### Catalog resolution (and workspace protocols beyond the package manager)

Changesets v3 fixed the biggest hole here: publishes now go through the package manager's own CLI, so `workspace:^` ranges get resolved by pnpm/Yarn at publish time ([#432](https://github.com/changesets/changesets/issues/432), [#1454](https://github.com/changesets/changesets/issues/1454) et al — closed). What remains:

- **`catalog:` support is still open** — [changesets#1707](https://github.com/changesets/changesets/issues/1707) (20 thumbs-up). Bumpy resolves pnpm catalogs, Bun catalogs, and Yarn catalogs (from `.yarnrc.yml`).
- Changesets' resolution only happens inside the package manager's publish. Bumpy resolves all workspace protocols itself before publish, so resolution also works for custom publish commands (packing a VS Code extension, publishing to JSR, etc.).

### Local bump file verification

`bumpy check` verifies that changed packages on the current branch have corresponding bump files. Compares your branch to the base branch, maps changed files to packages. By default it only fails if no bump files exist at all (matching changesets behavior). Use `--strict` to require every changed package to be covered, `--no-fail` for advisory-only mode, or `--hook pre-commit`/`--hook pre-push` to control which bump files count based on their git status. No GitHub API needed.

Changesets still has no local equivalent — users rely on the CI bot comment to catch missing bump files after pushing.

### CI without a separate action or bot

Changesets still requires **two** separate pieces of CI infrastructure beyond the CLI:

1. **[changeset-bot](https://github.com/apps/changeset-bot)** — a GitHub App you must install on your repo that watches PRs and posts "missing changeset" comments
2. **[changesets/action](https://github.com/changesets/action)** — a GitHub Action (separate repo) that handles creating the version PR and publishing. The v2 action (released alongside CLI v3) modernized a lot — pushes via the GitHub API, trusted-publishing-first auth, granular sub-actions — but it's still a separate repository with its own release cadence, breaking changes (v2 renamed most inputs), and a hard requirement on CLI v3.

This means you're trusting and auditing two additional dependencies with write access to your repo. The bot requires GitHub App installation (org admin approval in many orgs).

Bumpy replaces all of this with two CLI commands you run directly in standard workflows — `bumpy ci check` (PR comments) and `bumpy ci release` (version PR + publishing). No GitHub App to install, no separate action to trust. Your CI runs the same `@varlock/bumpy` package you already depend on. Works on any CI provider that can run shell commands — not just GitHub Actions.

- [changesets#134](https://github.com/changesets/changesets/issues/134) — requests for GitHub check integration (only available via bot)
- [changesets#1812](https://github.com/changesets/changesets/issues/1812) — can't filter which PRs the bot watches
- [changesets#946](https://github.com/changesets/changesets/issues/946) — bot doesn't check for new changes
- [changesets#43](https://github.com/changesets/changesets/issues/43) — can't customize bot messages

### Prerelease channels that actually work

Changesets' prerelease mode is described in their own docs as "very complicated" with "mistakes that can lead to repository and publish states that are very hard to fix." v3 improved the bookkeeping (versioned changesets now move to a `.changeset/pre/` folder instead of being id-tracked in `pre.json`), but the fundamental design is unchanged: pre mode is still a committed global state file, so it still poisons unrelated merges, exiting pre still bumps ALL packages, counters still require committed version state, and dist-tags still can't be controlled per-release.

Bumpy replaces the mode with **branch-based channels** ([docs/prereleases.md](./prereleases.md)): a long-lived branch (e.g. `next`) maps to a prerelease line. Bump file location (`.bumpy/<channel>/`) is the only state; prerelease versions are never committed — targets derive from bump files, counters from the registry. Promotion to stable is just a merge.

- [changesets#729](https://github.com/changesets/changesets/issues/729) — exiting pre mode bumps all versions (14 comments)
- [changesets#786](https://github.com/changesets/changesets/issues/786) — can't control dist-tag in pre mode (13 comments)
- [changesets#239](https://github.com/changesets/changesets/issues/239) — prerelease mode design issues
- [changesets#381](https://github.com/changesets/changesets/issues/381) — prerelease counters require committed state

### First-class staged publishing and provenance config

Changesets v3 gained useful building blocks here — `changeset pack`, `changeset publish-plan`, and `publish --from-pack-dir` enable pack-then-publish flows, and the provenance request ([#1152](https://github.com/changesets/changesets/issues/1152)) was closed because npm's trusted publishing (OIDC) now provides provenance automatically. Bumpy still goes further with explicit `provenance` and `npmStaged` config options, extra publish args, and a staged-release finalize flow (`bumpy publish finalize`) that keeps GitHub releases as drafts until staged packages actually go live.

### Publish dry run

`bumpy publish --dry-run` previews the entire publish (including custom commands) without doing it. Changesets v3's new `publish-plan` command covers part of this — it inspects which packages would be published or tagged — but a true `publish --dry-run` is still open.

- [changesets#614](https://github.com/changesets/changesets/issues/614) — dry run for publish (47 thumbs-up)

### Filtered/individual package publishing

`bumpy publish --filter "@myorg/core"` publishes only matching packages. Supports globs. Important for partial failure recovery and large monorepos. (v3 improved automatic partial-failure recovery, but there's still no manual filter.)

- [changesets#1160](https://github.com/changesets/changesets/issues/1160) — filtered publish (34 thumbs-up)

### Lockfile update after version

`bumpy version` automatically runs `pnpm install --lockfile-only` / `bun install` / etc. to keep the lockfile in sync with bumped versions.

- [changesets#1139](https://github.com/changesets/changesets/issues/1139) — lockfile not updated (24 thumbs-up)

### Dates in changelog entries

Bumpy includes the release date in every changelog heading by default.

- [changesets#109](https://github.com/changesets/changesets/issues/109) — dates in changelog (17 thumbs-up)

### Default access: public

Bumpy defaults to `"access": "public"` since most open-source packages are public. Changesets still defaults to `"restricted"`, though v3's interactive `init` now at least asks.

- [changesets#503](https://github.com/changesets/changesets/issues/503) — default access should be public (23 thumbs-up)

### Migration tool

`bumpy init` detects `.changeset/` and automatically migrates — renaming the directory to `.bumpy/`, converting config, and keeping pending bump files.

### Auto-generate from commits

`bumpy generate` scans commits on the current branch and auto-creates bump files. It works with any commit style — conventional commits get enhanced bump-level detection (`feat` → minor, `fix` → patch, `feat!` → major), while all other commits are mapped to packages via changed file paths (defaulting to `patch`). Not a replacement for explicit bump files — a bridge for teams migrating from semantic-release, or a convenience when you want both.

- [changesets#862](https://github.com/changesets/changesets/issues/862) — conventional commits integration (70 thumbs-up, 21 comments)

### Pluggable changelog formatters

Custom changelog formatters with full context (release info, bump files, dates). Built-in `"default"` and `"github"` (with PR links + author attribution) formatters. Users can write custom formatters in TypeScript or JavaScript. Changesets' API is still limited to two awkward string-returning functions — bumpy gives you the full context and you return the complete entry.

- [changesets#658](https://github.com/changesets/changesets/issues/658) — changelog titles not customizable (12 thumbs-up)
- [changesets#556](https://github.com/changesets/changesets/issues/556) — changelog formatting (11 thumbs-up)
- [changesets#995](https://github.com/changesets/changesets/issues/995) — getChangelogEntry API (12 thumbs-up)

---

## Planned / Not Yet Implemented

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

## Fixed in changesets v3

For the record — these were long-standing v2 pain points that bumpy addressed and this doc used to track. Changesets v3 fixed them:

- **Forced major bumps from peer deps** — v3 bumps peer dependents by patch instead of major (closed [#1011](https://github.com/changesets/changesets/issues/1011), [#822](https://github.com/changesets/changesets/issues/822), [#1126](https://github.com/changesets/changesets/issues/1126), [#1228](https://github.com/changesets/changesets/issues/1228), [#827](https://github.com/changesets/changesets/issues/827), [#960](https://github.com/changesets/changesets/issues/960), [#1735](https://github.com/changesets/changesets/issues/1735)). Still hardcoded — see [propagation](#configurable-dependency-bump-propagation) above.
- **`workspace:` ranges published unresolved** — v3 routes publishes through npm/pnpm/Yarn Berry CLIs (closed [#432](https://github.com/changesets/changesets/issues/432), [#1290](https://github.com/changesets/changesets/issues/1290), [#1421](https://github.com/changesets/changesets/issues/1421), [#1229](https://github.com/changesets/changesets/issues/1229), [#1454](https://github.com/changesets/changesets/issues/1454)). `catalog:` is still open.
- **Non-interactive `add`** — `--major`/`--minor`/`--patch` flags (comma-separated values supported), `-m` for the summary, and the confirmation prompt was removed (closed [#979](https://github.com/changesets/changesets/issues/979)).
- **Publish order & robustness** — releases are ordered in dependency-aware chunks (closed [#238](https://github.com/changesets/changesets/issues/238)); per-package error reporting, successful publishes get tagged even when another package fails, and auth retries no longer republish completed packages.
- **Provenance** — [#1152](https://github.com/changesets/changesets/issues/1152) closed via npm trusted publishing (OIDC provides provenance automatically); `changesets/action@v2` is trusted-publishing-first.
- **Infinite loops** — the `version` infinite loop (closed [#571](https://github.com/changesets/changesets/issues/571)) and a git-failure loop were fixed.
- **Misc:** `version` now exits 1 when there are no changesets (CI-friendly); private packages are no longer versioned by default; machine-readable output (`--output` JSON on `status`/`publish-plan`, NDJSON via `CHANGESETS_OUTPUT` for `publish`/`git-tag`); new `pack`/`publish-plan` commands; ESM-only with Node ≥22.11 and Yarn Classic support dropped.

---

## Changesets bugs we avoid by design

### "Does master exist?" CI failures

Bumpy doesn't shell out to git for branch comparisons during normal operations.

- [changesets#517](https://github.com/changesets/changesets/issues/517) — git failures in CI (41 comments)
