# Changelog

## 1.16.1

<sub>2026-06-25</sub>

- [#136](https://github.com/dmno-dev/bumpy/pull/136) _(patch)_
  Fixed GitHub release notes coming up empty (`No changelog entries.`) when the publish ran several commits after the version commit — e.g. a retry after the first publish was blocked and unrelated fixes landed on main. Bump-file recovery assumed the version commit was always `HEAD~1..HEAD`; it now locates the most recent commit that actually deleted bump files and recovers their content from that commit's parent, so release notes are populated regardless of how far HEAD has moved past versioning.

## 1.16.0

<sub>2026-06-23</sub>

- [#131](https://github.com/dmno-dev/bumpy/pull/131) _(minor)_
  Added a `$changelog: false` reserved frontmatter key for bump files, which omits a file's body from the changelog and release notes while still applying its version bump. Clearer than relying on a blank body, and lets you keep notes for reviewers. A per-package `changelog: false` option in the nested form suppresses the entry for just some of a file's packages.

## 1.15.2

<sub>2026-06-23</sub>

- [#129](https://github.com/dmno-dev/bumpy/pull/129) _(patch)_
  Degrade the version PR body when it would exceed GitHub's 65536-character limit (which previously failed the release for large multi-package releases). The body now drops inline change summaries — and hard-truncates as a last resort — instead of erroring.

## 1.15.1

<sub>2026-06-20</sub>

- [#127](https://github.com/dmno-dev/bumpy/pull/127) _(patch)_
  Streamline agent skill distribution and remove the `bumpy ai` command.

  The canonical `add-change` skill now lives at the repo root (`skills/`) as a single source of truth and is synced into the package on `prepack` (gitignored copy), so it ships version-pinned in the npm tarball and via the Claude Code plugin (`claude plugin install @varlock/bumpy`).

  The `bumpy ai setup` command has been removed. Its file-copying targets (`opencode`, `cursor`, `codex`) duplicated the skill into tool-specific directories that drifted from the canonical copy — and had silently been broken in the published package — while the `claude` target was a thin wrapper around `claude plugin install`. Install the skill via the Claude Code plugin, or reference the bundled `SKILL.md` directly from `node_modules/@varlock/bumpy/skills/add-change/SKILL.md`.

## 1.15.0

<sub>2026-06-18</sub>

- [#120](https://github.com/dmno-dev/bumpy/pull/120) _(minor)_
  Change detection is now `package.json`-field-aware: when `package.json` is the only changed file in a package, bumpy diffs it against the base branch and only requires a bump file if a publish-affecting field changed. The new `ignoredPackageJsonFields` option (default `["devDependencies"]`) controls which fields are ignored, so a dev-only dependency bump (e.g. Dependabot) no longer requires a bump file — unless the changed dep matches the package's `releaseTriggeringDevDeps`.

  `ci check` no longer posts a "you're good to go" comment while exiting 1. When the check fails because changed packages have no bump file, the comment now matches the failing status, lists the uncovered packages, and points at an empty bump file (`bumpy add --empty`) to acknowledge an intentional no-release.

  Add a per-package `releaseTriggeringDevDeps` option: names/globs of `devDependencies` that affect a package's published output (most often because they're bundled in). A change to one requires a release, and a listed internal workspace dep's own releases cascade with a patch bump — shorthand for a `cascadeFrom` rule of `{ trigger: 'patch', bumpAs: 'patch' }`.

- [#118](https://github.com/dmno-dev/bumpy/pull/118) _(patch)_
  Stream `buildCommand`/`publishCommand` output live to the parent process and surface the child's real failure reason. Custom publish commands (vsce, ovsx, anything bespoke) previously ran through a buffering runner that discarded stdout and never streamed output, so a failure like an expired marketplace token produced only a generic `Command failed` wrapper with no usable cause in CI logs. These commands now run through a streaming runner (`spawn` with piped+teed stdio) that prints output as it happens and includes both stdout and stderr in the thrown error. The capturing `runAsync`/`runArgsAsync` helpers (still used for internal git/npm calls whose output is parsed) also now include stdout in their error messages.
- [#122](https://github.com/dmno-dev/bumpy/pull/122) _(patch)_
  Changelog entries now use a block layout when a summary is multi-line, long (>120 chars), or contains markdown block syntax (headings, lists, blockquotes, code fences, tables). In those cases the entry metadata (`*(type)*`, PR link, "Thanks @user!") goes on its own line and the summary is rendered indented below it, instead of being jammed onto the same line. Short single-line summaries are unchanged and stay inline. Internal blank lines in a summary are now preserved so markdown paragraphs and lists render correctly. Applies to both the default and `github` formatters.
- [#124](https://github.com/dmno-dev/bumpy/pull/124) _(patch)_
  Label and link npm targets published to GitHub Packages correctly. Packages publishing to a GitHub Packages registry (`npm.pkg.github.com`) were labelled `npm` in the GitHub release notes and `bumpy status`/`bumpy ci plan` output, with a "Published to" badge linking to a non-existent npmjs.com page (404). The configured registry is now honoured: such targets are labelled **GitHub Packages** and link to the package page under the repo (`https://github.com/<owner>/<repo>/pkgs/npm/<name>`), resolving the repo from the package's `repository` field or `GITHUB_REPOSITORY`. Other custom/private registries no longer emit a dead npmjs.com link. `buildPublishUrl` now honours its registry argument (previously the unused `_registry` param).
- [#125](https://github.com/dmno-dev/bumpy/pull/125) _(patch)_
  Fix changed-package detection in single-package (non-monorepo) repos. Both `findChangedPackages` (used by `check`/`ci check`) and `mapFilesToPackages` (used by `generate`) matched changed files against `pkgRelDir + '/'`, but for the root package the relative dir is empty, so the check became `file.startsWith('/')` — always false for git's relative paths. As a result `ci check` always reported "No managed packages have changed" (never requiring a bump file or posting a PR comment) and `generate` never attributed commits to the root package. The root package (empty relative dir) now treats every changed file as belonging to it, while still honoring `changedFilePatterns`.

## 1.14.0

<sub>2026-06-13</sub>

- _(minor)_ - Add prerelease channels — branch-based prerelease lines (e.g. `next` → `@next` dist-tag) where prerelease versions are never committed to git. Targets derive from bump files, counters from the registry; shipped bump files are tracked by moving them into `.bumpy/<channel>/`. Includes channel-aware `version` / `publish` / `status` / `ci release` flows, exact-pinned lockstep cycle publishes, and promotion-by-merge to stable.
- [#110](https://github.com/dmno-dev/bumpy/pull/110) _(patch)_ - `ci check` now reads bump files in channel directories, so promotion PRs (channel → main) and graduation PRs (channel → channel) correctly report the cycle's pending releases instead of failing with "no bump files found". Channel-dir bump files render with their subdir path (`next/feature.md`) so view/edit links resolve.
- _(patch)_ - Channel release PR titles and bodies now show deterministic versions: targets with a wildcard counter (`1.2.0-rc.x`) derived purely from committed state, instead of registry-derived counters that could drift between PR creation and publish. Multi-package cycles show a package count in the title instead of an arbitrary lead package. The PR check comment and `version` output use the same `.x` wildcard; `status` / `ci plan` still show live registry-derived counters (`.?` when offline).
- [#110](https://github.com/dmno-dev/bumpy/pull/110) _(patch)_ - The PR check comment now explicitly calls out promotion PRs (channel → stable): the headline explains that merging ends the prerelease cycle and ships stable, and bump files that already shipped on a channel are annotated with their dist-tag (e.g. `next/feature.md` _(shipped on `@next`)_).
- [#115](https://github.com/dmno-dev/bumpy/pull/115) _(patch)_ - When a prerelease cycle is promoted (channel → main) or graduated (channel → channel), any lingering release PR on the source channel is now closed automatically with an explanatory comment — merging it would have offered another prerelease of a cycle that already moved on.

## 1.13.2

<sub>2026-06-05</sub>

- [#101](https://github.com/dmno-dev/bumpy/pull/101) _(patch)_ - Harden the publish flow for two failure modes hit when releasing brand-new packages via GitHub Actions + npm trusted publishing (OIDC).
  - Detect the new-package case before any side effects. When OIDC is the only available auth path (no `NPM_TOKEN`/`NODE_AUTH_TOKEN`, no `.npmrc` auth), bumpy now checks the npm registry up front and emits a clear error directing the user to publish a `0.0.0` placeholder before merging — instead of failing partway through with stranded GitHub draft releases and remote tags. The check is skipped when a token fallback is present, so users who enable `id-token: write` for provenance attestations alongside token auth are unaffected.
  - Replace blanket `git push --tags` after publish with per-tag force push. `gh release create --draft --target SHA` creates the tag on the remote at draft-creation time; if a prior publish failed and HEAD has since moved, the remote tag is stale and `git push --tags` rejects with "already exists". The new logic iterates `releasePlan.releases` minus failed packages and force-pushes each tag individually, preserving the anySucceeded-aware semantics already used for local tag movement — packages whose targets all succeeded in a prior run are stripped upstream and their tags stay at the SHA the artifact was actually published from.

## 1.13.1

<sub>2026-06-03</sub>

- [#99](https://github.com/dmno-dev/bumpy/pull/99) _(patch)_ - Fix scrolling in `bumpy add` when there are many packages. The interactive bump-select prompt now renders a viewport that fits within the terminal, scrolling the package list (with `▲ N more` / `▼ N more` indicators) as the cursor moves. Previously, when the list exceeded terminal height, navigating up would snap the cursor back to the bottom because the redraw cursor-up lost its anchor once content scrolled off-screen. Closes [#96](https://github.com/dmno-dev/bumpy/issues/96).

## 1.13.0

<sub>2026-06-03</sub>

- [#97](https://github.com/dmno-dev/bumpy/pull/97) _(minor)_ - Recommend `pull_request_target` for the `bumpy ci check` workflow so fork PRs receive release-plan comments. Previously, fork PRs running under `pull_request` got a read-only token, so the check would fail red with no helpful comment — a bad first impression for OSS projects. `bumpy ci check` now recognizes the `pull_request_target` event when reading the PR number from `GITHUB_EVENT_PATH`, and emits a clearer warning that links to the new docs when comment posting fails on a fork PR. See the updated [GitHub Actions docs](https://bumpy.varlock.dev/docs/github-actions) for the new workflow (the version is resolved from the base branch's `package.json`, so no version pinning duplication).

## 1.12.0

<sub>2026-06-03</sub>

- [#94](https://github.com/dmno-dev/bumpy/pull/94) _(minor)_ - Detect catalog entry changes as package changes. When a catalog version in `pnpm-workspace.yaml` (pnpm) or root `package.json` (bun/yarn `catalog`/`catalogs`, plus `workspaces.catalog`/`workspaces.catalogs`) is modified, `bumpy add` and `bumpy check` now flag every package that references the changed entry via `catalog:` / `catalog:<name>` as changed. Closes [#92](https://github.com/dmno-dev/bumpy/issues/92).

## 1.11.0

<sub>2026-06-02</sub>

- [#91](https://github.com/dmno-dev/bumpy/pull/91) _(minor)_ - Add `--expect-mode` flag to `bumpy ci release` for asserting the detected release mode (`version-pr` or `publish`). Enables split-job release workflows where each job fails loudly if the runtime state doesn't match what the job expects. Refactored `ReleaseOptions` to rename the existing `mode` field to `autoPublish: boolean` and add `assertMode`. `--expect-mode` and `--auto-publish` cannot be combined.

## 1.10.2

<sub>2026-05-27</sub>

- [#89](https://github.com/dmno-dev/bumpy/pull/89) _(patch)_ - Always show bump type label on each changelog item instead of only when it differs from the release type

## 1.10.1

<sub>2026-05-27</sub>

- [#87](https://github.com/dmno-dev/bumpy/pull/87) - Fix draft release functions (`createDraftRelease`, `updateReleaseBody`, `finalizeRelease`, `deleteRelease`) to use `BUMPY_GH_TOKEN` via `withReleaseToken` so that GitHub release events trigger downstream workflows. Also disables npm staged publishing (not yet ready).

## 1.10.0

<sub>2026-05-27</sub>

- [#84](https://github.com/dmno-dev/bumpy/pull/84) - feat: publish recovery with draft GitHub releases and removal of aggregate release mode
- [#85](https://github.com/dmno-dev/bumpy/pull/85) _(patch)_ - Use `BUMPY_GH_TOKEN` for GitHub release creation so releases trigger downstream workflows. Also adds token redaction to error messages in `withPatToken` and the new `withReleaseToken` helper to prevent leakage in CI logs.

## 1.9.2

<sub>2026-05-25</sub>

- [#81](https://github.com/dmno-dev/bumpy/pull/81) - Add provenance config option, fix staged publishing minimum npm version (>= 11.15.0), and throw errors for invalid publish config

## 1.9.1

<sub>2026-05-23</sub>

- [#79](https://github.com/dmno-dev/bumpy/pull/79) - Fix npm staged publishing docs URL in README

## 1.9.0

<sub>2026-05-23</sub>

- [#76](https://github.com/dmno-dev/bumpy/pull/76) - Add `npmStaged` publish config option for npm staged publishing (`npm stage publish`), which stages packages on npmjs.com requiring manual 2FA approval before going live.

## 1.8.1

<sub>2026-05-15</sub>

- [#74](https://github.com/dmno-dev/bumpy/pull/74) - Fix git push auth in CI by using remote URL token embedding instead of extraheader approach, which doesn't work with actions/checkout@v6
- [#73](https://github.com/dmno-dev/bumpy/pull/73) - Fix git tag push auth using http.extraheader; recover deleted bump files for GitHub release notes in post-merge publish flow

## 1.8.0

<sub>2026-05-05</sub>

- [#71](https://github.com/dmno-dev/bumpy/pull/71) - Add `cascadeFrom` config and simplify cascade API
  Added consumer-side `cascadeFrom` as the complement to `cascadeTo`, allowing packages to declare cascade relationships from either direction. Both now support an array shorthand with sensible defaults (trigger: "patch", bumpAs: "match") alongside the object form for custom rules.

## 1.7.1

<sub>2026-05-04</sub>

- [#69](https://github.com/dmno-dev/bumpy/pull/69) - Fix `bumpy add` interactive prompt: distinguish skip vs none, respect existing bump files, fix prompt rendering, remove cascade prompt
- [#68](https://github.com/dmno-dev/bumpy/pull/68) - Skip default values (empty arrays, baseBranch: main, etc.) during changeset migration

## 1.7.0

<sub>2026-04-30</sub>

- [#66](https://github.com/dmno-dev/bumpy/pull/66) - Add `bumpy ci plan` command for conditional CI builds

## 1.6.0

<sub>2026-04-30</sub>

- [#64](https://github.com/dmno-dev/bumpy/pull/64) - Support single-package (non-monorepo) repos

## 1.5.1

<sub>2026-04-29</sub>

- [#62](https://github.com/dmno-dev/bumpy/pull/62) - Fix changelog dependency bump tag showing incorrect bump level

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
