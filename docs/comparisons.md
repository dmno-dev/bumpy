# Comparisons with Other Tools

There are several great tools in the release management space, each with different design philosophies and trade-offs. This page gives an honest comparison of bumpy with the most popular alternatives, focusing on where each tool shines and where it falls short.

> Bumpy's core design choice is **explicit bump files per PR** — small markdown files that declare which packages are changing, at what level, and with a human-written description. This gives precise per-package control and produces consumer-facing changelogs, but requires slightly more work per PR than label- or commit-based approaches. Many of the differences below stem from this choice.

---

## Changesets

[Changesets](https://github.com/changesets/changesets) is the most direct comparison — bumpy uses the same bump-file-per-PR model and is designed as a successor to it. Changesets is mature, widely adopted, and battle-tested across many large monorepos.

**Where changesets shines:**

- Proven at scale with years of production use across the ecosystem
- Large community with extensive documentation and third-party integrations
- Stable, well-understood behavior

**Where bumpy differs:**

- **Dependency propagation** — changesets hardcodes aggressive peer dep behavior (a minor bump can trigger major bumps on dependents). Bumpy uses a [configurable three-phase algorithm](./version-propagation.md) with sensible defaults.
- **Workspace protocols** — changesets uses `npm publish` even in pnpm/yarn workspaces, so `workspace:^` and `catalog:` protocols may not be resolved correctly. Bumpy resolves these before publishing.
- **Custom publish commands** — changesets is locked to `npm publish`. Bumpy supports per-package custom commands for VSCode extensions, Docker images, JSR, etc.
- **CI setup** — changesets requires a [GitHub App](https://github.com/apps/changeset-bot) and a [separate GitHub Action](https://github.com/changesets/action). Bumpy uses two CLI commands (`bumpy ci check` + `bumpy ci release`) that run directly in your workflows.
- **Non-interactive CLI** — `bumpy add` works fully non-interactively, which is important for CI/CD and AI-assisted workflows.

For a detailed breakdown with links to specific changesets issues, see [Differences from Changesets](./differences-from-changesets.md).

---

## semantic-release

[semantic-release](https://github.com/semantic-release/semantic-release) is the most popular fully-automated release tool. It analyzes commit messages (typically [Angular convention](https://github.com/angular/angular/blob/main/contributing-docs/commit-message-format.md)) to determine version bumps, generate changelogs, and publish — all without human intervention after merge.

**Where semantic-release shines:**

- Truly zero-touch releases — no manual step between merge and publish
- Rich plugin ecosystem for different registries, CI providers, and changelog formats
- Enforces consistent commit discipline across teams
- Well-suited for single-package repos with a linear commit history

**Where bumpy differs:**

- **Monorepo support** — semantic-release was designed for single packages. Monorepo support exists via plugins like [multi-semantic-release](https://github.com/dhoulb/multi-semantic-release), but it's not first-class and can be fragile.
- **Per-PR granularity** — with semantic-release, a squash-merged PR produces a single commit, so the version bump is determined by the commit message of the squash. If a PR touches multiple packages at different levels, this is hard to express. Bump files let you specify different bump levels for different packages in a single PR.
- **Changelog quality** — semantic-release changelogs are derived from commit messages, which tend to be written for developers. Bump files let you write descriptions aimed at package consumers.
- **Review before release** — bumpy's release PR gives maintainers a chance to review the full release plan before it goes out. semantic-release publishes immediately on merge with no review step (by design — this is a feature for some teams).
- **Commit convention requirement** — semantic-release requires strict commit message formatting. Bumpy works with any commit style (though `bumpy generate` can optionally derive bump files from conventional commits).

**When to choose semantic-release:** You have a single-package repo (or a small set of independent packages), your team is disciplined about commit conventions, and you want fully hands-off publishing with no release PR step.

---

## release-please

[release-please](https://github.com/googleapis/release-please) is Google's release automation tool. Like semantic-release, it uses conventional commits — but instead of publishing immediately, it maintains a release PR that accumulates changes. Merging the PR triggers tagging and GitHub release creation.

**Where release-please shines:**

- Broad language support — 18+ ecosystems (Node, Python, Java, Go, Rust, Ruby, PHP, etc.) with language-specific version file updates
- Release PR model gives maintainers a review step before release (similar to bumpy)
- Squash-merge friendly with good linear history support
- Manual version overrides via `Release-As: x.y.z` commit footer
- Backed by Google with active maintenance

**Where bumpy differs:**

- **Commit convention requirement** — release-please requires conventional commits for version determination. Bumpy doesn't require any commit convention.
- **Per-package control in PRs** — release-please determines bump levels from commits, so a single PR can't easily express "minor for package A, patch for package B." Bump files make this explicit.
- **Publishing** — release-please deliberately does not handle publishing; you need separate CI steps for that. Bumpy handles versioning _and_ publishing (with workspace protocol resolution, topological ordering, etc.).
- **JS-specific features** — bumpy handles `workspace:` and `catalog:` protocol resolution, npm OIDC/provenance, staged publishing, and per-package publish commands. Release-please is language-agnostic but doesn't go as deep on npm-specific concerns.
- **Dependency propagation** — release-please doesn't model inter-package dependency relationships. In a JS monorepo where bumping `core` should cascade to `plugin`, you'd need to handle this yourself.

**When to choose release-please:** You have a polyglot monorepo (Go + Python + Rust, etc.), your team already uses conventional commits, and you handle publishing separately. Its breadth of language support is unmatched.

---

## release-it

[release-it](https://github.com/release-it/release-it) is a flexible, interactive CLI tool for managing releases. It handles version bumping, git tagging, GitHub/GitLab releases, and npm publishing — typically run locally by a developer rather than fully automated in CI.

**Where release-it shines:**

- Interactive mode with confirmation prompts gives developers full control over each release step
- Works as a generic release tool beyond just npm — supports any project with git tags
- Plugin system for conventional changelogs, custom version sources, and monorepo support
- Pre-release version support (alpha, beta, rc) out of the box
- Lightweight and flexible — doesn't impose a specific workflow

**Where bumpy differs:**

- **PR-based workflow** — bumpy is designed around accumulating changes across multiple PRs via bump files, then releasing them together. release-it is typically a point-in-time "release what's on main now" tool.
- **Monorepo support** — release-it has monorepo recipes and plugins, but it's primarily designed for single-package repos. Bumpy's dependency propagation, per-package config, and workspace protocol handling are built for complex monorepos.
- **Changelog source** — release-it generates changelogs from git history. Bumpy uses human-written descriptions from bump files.
- **CI-first design** — bumpy is designed to run unattended in CI with its release PR workflow. release-it's strength is its interactive local flow (though it supports CI mode too).

**When to choose release-it:** You prefer running releases locally with interactive confirmation, have a single-package repo, or need a lightweight tool that doesn't impose a PR-based workflow.

---

## uppt

[uppt](https://github.com/danielroe/uppt) is a composite GitHub Action by [Daniel Roe](https://github.com/danielroe) focused on secure npm publishing. It uses conventional commits to create release PRs, then packs and publishes via OIDC trusted publishing with npm staged releases.

**Where uppt shines:**

- Security-first design — OIDC trusted publishing with no stored tokens, immutable tarball artifacts, and staged publishing requiring manual npm approval
- Clean separation of concerns — four modular sub-actions (PR, release, pack, publish) with minimal permissions per step
- Fork protection guards against accidental releases from merged fork PRs
- Opinionated and simple — does one thing well with minimal configuration

**Where bumpy differs:**

- **Versioning model** — uppt uses conventional commits to determine versions. Bumpy uses explicit bump files, giving per-package control independent of commit style.
- **Monorepo support** — uppt is designed for single-package repos. Bumpy handles monorepos with dependency propagation, per-package config, and workspace protocol resolution.
- **Publishing flexibility** — uppt targets npm exclusively with staged publishing. Bumpy supports npm (with optional OIDC/provenance/staged), plus custom publish commands for other targets.
- **Scope** — uppt is a GitHub Action, so it's tied to GitHub Actions as a CI provider. Bumpy is a CLI that can run anywhere.

**When to choose uppt:** You have a single npm package, want maximum supply-chain security with staged publishing, and prefer a GitHub Actions-native solution with minimal setup.

---

## release-plan

[release-plan](https://github.com/release-plan/release-plan) uses PR labels to drive versioning. Merged PRs are categorized by label (`breaking`, `enhancement`, `bug`, etc.), and the tool creates a release PR with computed version bumps and changelogs derived from PR titles.

**Where release-plan shines:**

- Minimal per-PR overhead — contributors just add a label, no files to create
- Changelog entries come from PR titles, which teams are already writing
- Simple mental model — one label, one PR, one version impact
- Zero local credentials needed — everything runs in CI
- Good support for pre-release workflows via `semverIncrementAs` and `publishTag` config

**Where bumpy differs:**

- **Multi-package PRs** — release-plan assigns one label per PR, so all packages in that PR get the same bump level. Bump files can specify different levels for different packages.
- **Changelog quality** — PR titles are often written for developer context ("Fix flaky test in auth module") rather than consumer context ("Fixed authentication timeout on slow connections"). Bump file descriptions are purpose-written for changelogs.
- **Monorepo depth** — release-plan supports monorepos but all packages share the same configuration. Bumpy offers per-package config, dependency propagation rules, and include/exclude controls.
- **Per-package configuration** — release-plan applies uniform config across all packages. Bumpy supports per-package publish commands, access levels, and propagation rules.
- **Publish targets** — release-plan publishes to npm. Bumpy supports npm plus custom publish commands for other targets.

**When to choose release-plan:** You want the lowest possible friction per PR, your PRs typically affect one package each, and PR titles naturally serve as good changelog entries. Its simplicity is a genuine advantage for smaller projects.

---

## Quick Reference

|                      | Versioning source        | Monorepo       | Publish              | Release PR       | Commit convention required |
| -------------------- | ------------------------ | -------------- | -------------------- | ---------------- | -------------------------- |
| **bumpy**            | Bump files (per PR)      | First-class    | npm + custom targets | Yes              | No                         |
| **changesets**       | Changeset files (per PR) | First-class    | npm only             | Yes              | No                         |
| **semantic-release** | Commit messages          | Via plugins    | Via plugins          | No (immediate)   | Yes                        |
| **release-please**   | Commit messages          | Yes (manifest) | No (external)        | Yes              | Yes                        |
| **release-it**       | Interactive / plugins    | Via plugins    | npm + git platforms  | No (interactive) | Optional                   |
| **uppt**             | Commit messages          | No             | npm (staged)         | Yes              | Yes                        |
| **release-plan**     | PR labels                | Yes            | npm                  | Yes              | No                         |
