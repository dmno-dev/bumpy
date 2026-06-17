<p align="center">
  <a href="https://bumpy.varlock.dev" target="_blank" rel="noopener noreferrer">
    <img src="https://raw.githubusercontent.com/dmno-dev/bumpy/refs/heads/main/images/github-readme-banner.png" alt="Bumpy banner">
  </a>
</p>
<p align="center">
  <a href="https://npmjs.com/package/@varlock/bumpy"><img src="https://img.shields.io/npm/v/@varlock/bumpy.svg" alt="npm package"></a>
  <a href="https://github.com/dmno-dev/bumpy/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@varlock/bumpy.svg" alt="license"></a>
  <a href="https://github.com/dmno-dev/bumpy/actions/workflows/ci.yaml"><img src="https://img.shields.io/github/actions/workflow/status/dmno-dev/bumpy/ci.yaml?style=flat&logo=github&label=CI" alt="build status"></a>
  <a href="https://chat.dmno.dev"><img src="https://img.shields.io/badge/chat-discord-5865F2?style=flat&logo=discord" alt="discord chat"></a>
</p>

<p align="center">Brought to you by <a href="https://varlock.dev">Varlock</a> 🧙‍♂️🔐 <a href="https://varlock.dev">check it out to secure your secrets</a></p>
<br/>

# @varlock/bumpy 🐸

A modern package versioning, release, and changelog generation tool. Built for monorepos, but works great in simple projects too.

## How It Works

Bumpy uses **bump files** (you may know them as "changesets" if coming from [that tool 🦋](https://github.com/changesets/changesets)) - small markdown files that declare an _intent to release packages_ with a bump level (patch/minor/major), and a description that ends up in changelogs. Developers create these files as part of their PRs, and these files are then used to consolidate changes, generate changelogs, and trigger publishing.

- Devs/agents create bump files as part of their PRs (using `bumpy add` or manually)
- A git hook (pre-commit or pre-push) can enforce bump files exist for changed packages
- In CI, a workflow checks PRs for bump files, leaves a comment on the PR detailing changed packages
- As PRs merge to the base branch, a "release PR" is kept up to date
  - Shows what packages will be released and their changelogs (incl. those bumped via dep relationships)
- When release PR is merged, publishing is triggered
  - Pending bump files are deleted and packages are published with updated versions and changelogs, github tags+releases created

All of this is automated via two simple GitHub Actions workflows (see [actions guide](https://github.com/dmno-dev/bumpy/blob/main/docs/github-actions.md)). Or can be triggered locally.

### Example bump file

`.bumpy/add-user-language.md`:

```markdown
---
'@myorg/core': minor
'@myorg/utils': patch
---

Added user lang prefs to core config.
Fixed locale fallback logic in utils.
```

## Features

- **All package managers** - npm, pnpm, yarn, and bun workspaces. With full `workspace:` and `catalog:` support
- **Smart dependency propagation** - configurable rules for how version bumps cascade through your dependency graph (see [version propagation docs](https://github.com/dmno-dev/bumpy/blob/main/docs/version-propagation.md))
- **OIDC + staged publishing** - supports OIDC, provenance, [npm staged publishing](https://docs.npmjs.com/staged-publishing)
- **Custom release targets** - Per-package custom publish commands let you target anything - VSCode extensions, Docker images, JSR, private registries, etc.
- **Flexible package management** - include/exclude any package individually via per-package config, glob patterns, or `privatePackages` setting
- **Non-interactive CLI** - `bumpy add` works fully non-interactively for CI/CD and AI-assisted development
- **Aggregated GitHub releases** - optionally create a single consolidated release instead of one per package
- **Prerelease channels** - branch-based `@next` / `@beta` release lines where prerelease versions are derived at publish time, never committed to git (see [prerelease channels docs](https://github.com/dmno-dev/bumpy/blob/main/docs/prereleases.md))
- **Auto-generate from commits** - `bumpy generate` creates bump files from branch commits - works with any commit style, with enhanced detection for conventional commits
- **Pluggable changelog formatters** - built-in `"default"` and `"github"` formatters, or write your own
- **Zero runtime dependencies** - dependencies are minimal and bundled at release time
- **No additional action/app needed** - no external github action or app to audit and trust

## Getting Started

```bash
# Install
bun add -d @varlock/bumpy  # or npm/pnpm/yarn

# Initialize (creates .bumpy/ directory and config, migrates from changesets if applicable)
bunx bumpy init

# Interactive guidance setting up CI
bunx bumpy ci setup

# Create a bump file
bunx bumpy add

# Preview the release plan
bunx bumpy status
```

Then set up CI to automate versioning and publishing (see below).

## CI / GitHub Actions

No GitHub App to install, no separate action to rely on — just call `bumpy ci` directly in your workflows. Three commands across two workflows handle the entire release lifecycle:

- **`bumpy ci check`** — on every PR, posts/updates a comment showing the release plan and warns if changed packages are missing bump files.
- **`bumpy ci plan`** — on push to main, detects what should happen next (`version-pr`, `publish`, or nothing) without needing write permissions or publish credentials. Used to gate downstream jobs in split-job workflows.
- **`bumpy ci release`** — opens/updates the "Version Packages" PR, or publishes new versions and creates git tags + GitHub releases when that PR is merged.

Run `bumpy ci setup` for interactive guidance, and see the [GitHub Actions setup guide](https://github.com/dmno-dev/bumpy/blob/main/docs/github-actions.md) for ready-to-copy workflows, token setup, and trusted publishing.

## Local versioning and publishing

If you prefer to version and publish locally instead of via CI:

```bash
bumpy version   # consume bump files, update versions and changelogs
bumpy publish   # pack and publish, create git tags, push tags, and create GitHub releases
```

## AI Integration

Bumpy ships with an AI skill that teaches LLMs how to create bump files.

```bash
bumpy ai setup --target claude    # installs Claude Code plugin
bumpy ai setup --target opencode  # creates OpenCode command file
bumpy ai setup --target cursor    # creates Cursor rule file
bumpy ai setup --target codex     # creates Codex instruction file
```

The skill teaches the AI to examine git changes, identify affected packages, choose bump levels, and create bump files with `bumpy add`. It also instructs the AI to keep existing bump files up to date as work continues on a branch - updating packages, bump levels, and summaries to reflect the final state of changes.

## Documentation

- [Bump file format](https://github.com/dmno-dev/bumpy/blob/main/docs/bump-files.md) - syntax, bump levels, cascade control
- [Configuration reference](https://github.com/dmno-dev/bumpy/blob/main/docs/configuration.md) - all `.bumpy/_config.json` and per-package options
- [CLI reference](https://github.com/dmno-dev/bumpy/blob/main/docs/cli.md) - every command with flags and examples
- [GitHub Actions setup](https://github.com/dmno-dev/bumpy/blob/main/docs/github-actions.md) - CI workflows, token setup, trusted publishing
- [VS Code extension OIDC publishing](https://github.com/dmno-dev/bumpy/blob/main/docs/vscode-oidc-publishing.md) - publish to the Marketplace via Azure workload identity instead of an expiring PAT
- [Version propagation](https://github.com/dmno-dev/bumpy/blob/main/docs/version-propagation.md) - how dependency bumps cascade through your graph
- [Prerelease channels](https://github.com/dmno-dev/bumpy/blob/main/docs/prereleases.md) - branch-based `@next` / `@beta` release lines

## Why files instead of conventional commits?

Tools like semantic-release infer version bumps from commit messages (`feat:` → minor, `fix:` → patch). This works for simple projects but breaks down in monorepos - a single PR often touches multiple packages with different bump levels, squash merges lose per-commit metadata, and commit messages are a poor place to write user-facing changelog entries. Bump files are explicit, reviewable in the PR diff, and can describe changes in language meant for consumers rather than developers. If you prefer commit-based workflows, `bumpy generate` can bridge the gap by auto-creating bump files from your branch commits - it works with any commit style, not just conventional commits.

## Why not just use changesets?

Bumpy is built as a successor to [🦋changesets](https://github.com/changesets/changesets). Changesets is mature and widely adopted, but has stagnated - hundreds of open issues around core design problems that are unlikely to be fixed without a rewrite. See [differences from changesets](https://github.com/dmno-dev/bumpy/blob/main/docs/differences-from-changesets.md) for a detailed comparison with links to specific issues. The biggest pain points bumpy addresses:

- **Sane dependency propagation** - changesets hardcodes aggressive behavior where a minor bump triggers a major bump on all peer dependents. Bumpy uses a [three-phase algorithm](https://github.com/dmno-dev/bumpy/blob/main/docs/version-propagation.md) with sensible defaults and full configurability.
- **Workspace protocol resolution** - changesets uses `npm publish` even in pnpm/yarn workspaces, so `workspace:^` and `catalog:` protocols are NOT resolved, resulting in broken published packages.
- **Custom publish commands** - changesets is hardcoded to `npm publish`. Bumpy supports per-package custom publish for VSCode extensions, Docker images, JSR, etc.
- **Flexible package management** - changesets treats all private packages the same. Bumpy lets you include/exclude any package individually.
- **CI without a separate action or bot** - changesets requires installing a [GitHub App](https://github.com/apps/changeset-bot) _and_ using a [separate GitHub Action](https://github.com/changesets/action). Bumpy replaces both with two CLI commands (`bumpy ci check` + `bumpy ci release`) that run directly in your workflows - no extra repos to trust, no app installation requiring org admin approval.
- **Prerelease channels that don't corrupt state** - changesets' prerelease mode is described in [their own docs](https://github.com/changesets/changesets/blob/main/docs/prereleases.md) as "very complicated" with states "very hard to fix." Bumpy uses [branch-based channels](https://github.com/dmno-dev/bumpy/blob/main/docs/prereleases.md) where prerelease versions are never committed - no global mode file to poison unrelated releases.
- **Automatic migration** - `bumpy init` detects `.changeset/`, renames it to `.bumpy/`, migrates config, keeps pending files, and offers to uninstall `@changesets/cli`.

## Development

```bash
bun install        # install deps
bun run test       # run tests
bun run build      # build CLI
bunx bumpy --help  # invoke built cli
```

## Roadmap

- Standalone binary for use outside of JS projects
- Better support for versioning non-JS packages and usage without package.json files
- Plugin system for different publish targets, and support multiple targets per package
- Tracking workspace-level / non-publishable changes
- More frogs 🐸🐸🐸

---

<p align="center">
  <a href="https://varlock.dev" target="_blank" rel="noopener noreferrer">
    <img src="https://raw.githubusercontent.com/dmno-dev/bumpy/refs/heads/main/images/github-readme-footer.jpg" alt="Bumpy was created by Varlock" >
  </a>
</p>
<p align="center">
  <b>Bumpy is a creation of the team behind <a href="https://varlock.dev">Varlock</a> 🧙‍♂️</b><br/>
  <a href="https://varlock.dev">
    Check it out for secure secret sorcery - get your keys out of plaintext!
  </a>
</p>

<!-- note this readme is also used for the bumpy package! -->
