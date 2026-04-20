<p align="center">
  <a href="https://bumpy.varlock.dev" target="_blank" rel="noopener noreferrer">
    <img src="/images/github-readme-banner.png" alt="Bumpy banner">
  </a>
</p>
<br/>
<p align="center">
  <a href="https://npmjs.com/package/@varlock/bumpy"><img src="https://img.shields.io/npm/v/@varlock/bumpy.svg" alt="npm package"></a>
  <a href="/LICENSE.md"><img src="https://img.shields.io/npm/l/@varlock/bumpy.svg" alt="license"></a>
  <a href="https://github.com/dmno-dev/bumpy/actions/workflows/ci.yaml"><img src="https://img.shields.io/github/actions/workflow/status/dmno-dev/bumpy/ci.yaml?style=flat&logo=github&label=CI" alt="build status"></a>
  <a href="https://chat.dmno.dev"><img src="https://img.shields.io/badge/chat-discord-5865F2?style=flat&logo=discord" alt="discord chat"></a>
</p>
<br/>

# @varlock/bumpy 🐸

A modern package versioning and changelog generation tool — built for monorepos (works great in single packages too).

## How It Works

Bumpy uses **bump files** (you may know them as "changesets" if coming from that tool) — small markdown files that declare which packages changed and how (patch/minor/major), along with a description that ends up in changelogs. Developers create these files as part of their PRs. As PRs merge to the base branch, a "release PR" is kept up to date showing what packages will be released and their changelogs — including packages bumped automatically due to dependency relationships. When the release PR is merged, bump files are consumed (deleted), and packages are published with updated versions and changelogs.

### Example bump file

`.bumpy/add-user-language.md`:

```markdown
---
'@myorg/core': minor
'@myorg/utils': patch
---

Added user language preference to the core config.
Fixed locale fallback logic in utils.
```

The typical CI driven workflow is:

1. **`bumpy add`** — developers create bump files as part of their PRs
2. **`bumpy ci check`** — CI comments on each PR with a release plan preview
3. **`bumpy ci release`** — on merge to main, CI opens a "Version Packages" PR that bumps versions and updates changelogs. When that PR is merged, it publishes packages.

All of this is automated via two simple GitHub Actions workflows (see [CI setup](#ci--github-actions) below). You can also run everything locally with `bumpy status`, `bumpy version`, and `bumpy publish`.

## Features

- **All package managers** — npm, pnpm, yarn, and bun workspaces
- **Smart dependency propagation** — configurable rules for how version bumps cascade through your dependency graph (see [version propagation docs](docs/version-propagation.md))
- **Pack-then-publish** — by default, publishes to npm (resolving `workspace:` and `catalog:` protocols, with OIDC/provenance support). Per-package custom publish commands let you target anything — VSCode extensions, Docker images, JSR, private registries, etc.
- **Flexible package management** — include/exclude any package individually via per-package config, glob patterns, or `privatePackages` setting
- **Non-interactive CLI** — `bumpy add` works fully non-interactively for CI/CD and AI-assisted development
- **Aggregated GitHub releases** — optionally create a single consolidated release instead of one per package
- **Conventional commits bridge** — `bumpy generate` auto-creates bump files from conventional commit messages
- **Pluggable changelog formatters** — built-in `"default"` and `"github"` formatters, or write your own
- **Zero runtime dependencies** — dependencies are minimal and bundled at release time

## Getting Started

```bash
# Install
bun add -d @varlock/bumpy  # or npm/pnpm/yarn

# Initialize (creates .bumpy/ config directory)
bumpy init

# Create a bump file
bumpy add

# Preview the release plan
bumpy status
```

Then set up CI to automate versioning and publishing (see below).

## CI / GitHub Actions

No separate action to install — just call `bumpy ci` directly in your workflows. Two commands handle the entire release lifecycle:

- **`bumpy ci check`** — runs on every PR. Computes the release plan from pending bump files and posts/updates a comment on the PR showing what versions would be released. Warns if any changed packages are missing bump files.
- **`bumpy ci release`** — runs on push to main. If pending bump files exist, it opens (or updates) a "Version Packages" PR that applies all version bumps and changelog updates. If the current push _is_ the Version Packages PR being merged, it publishes the new versions, creates git tags, and creates GitHub releases.

### PR check workflow

```yaml
# .github/workflows/bumpy-check.yml
name: Bumpy Check
on: pull_request

jobs:
  check:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx @varlock/bumpy ci check
        env:
          GH_TOKEN: ${{ github.token }}
```

### Release workflow

```yaml
# .github/workflows/bumpy-release.yml — trusted publishing (OIDC, no secret needed)
name: Bumpy Release
on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      id-token: write # required for npm trusted publishing (OIDC)
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
      - run: bun install
      - run: bunx @varlock/bumpy ci release
        env:
          GH_TOKEN: ${{ github.token }}
```

> **Trusted publishing setup:** Configure each package on [npmjs.com](https://docs.npmjs.com/trusted-publishers/) → Package Settings → Trusted Publishers → GitHub Actions. Specify your org/user, repo, and the workflow filename (`bumpy-release.yml`). No `NPM_TOKEN` secret needed. Requires npm >= 11.5.1 — bumpy will warn if your version is too old.

<details>
<summary>Alternative: token-based auth (NPM_TOKEN secret)</summary>

```yaml
# .github/workflows/bumpy-release.yml — token-based auth
name: Bumpy Release
on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx @varlock/bumpy ci release
        env:
          GH_TOKEN: ${{ github.token }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

</details>

You can also use `bumpy ci release --auto-publish` to version + publish directly on merge without the intermediate PR.

### Token setup

The default `github.token` works for basic functionality, but GitHub's anti-recursion guard means PRs created by the default token won't trigger other workflows — so your regular CI (tests, linting, etc.) won't run automatically on the Version Packages PR. To fix this, provide a `BUMPY_GH_TOKEN` secret using either a **fine-grained PAT** or a **GitHub App token**. See the [full token setup guide](docs/github-actions.md#token-setup) for details.

Run `bumpy ci setup` for interactive guidance, or set it up manually:

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens) with:
   - **Repository access:** your repo only
   - **Permissions:** Contents (read & write), Pull requests (read & write)
2. Add it as a repository secret named `BUMPY_GH_TOKEN`
3. Add it to your release workflow:
   ```yaml
   - run: bunx @varlock/bumpy ci release
     env:
       GH_TOKEN: ${{ github.token }}
       BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }}
   ```

### Local versioning and publishing

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

The skill teaches the AI to examine git changes, identify affected packages, choose bump levels, and run `bumpy add` with the right arguments.

## Documentation

- [Bump file format](docs/bump-files.md) — syntax, bump levels, cascade control
- [Configuration reference](docs/configuration.md) — all `.bumpy/_config.json` and per-package options
- [CLI reference](docs/cli.md) — every command with flags and examples
- [GitHub Actions setup](docs/github-actions.md) — CI workflows, token setup, trusted publishing
- [Version propagation](docs/version-propagation.md) — how dependency bumps cascade through your graph
- [LLM-friendly reference](./llms.md) — single-file reference optimized for AI tools

## Why files instead of conventional commits?

Tools like semantic-release infer version bumps from commit messages (`feat:` → minor, `fix:` → patch). This works for simple projects but breaks down in monorepos — a single PR often touches multiple packages with different bump levels, squash merges lose per-commit metadata, and commit messages are a poor place to write user-facing changelog entries. Bump files are explicit, reviewable in the PR diff, and can describe changes in language meant for consumers rather than developers. If you prefer conventional commits, `bumpy generate` can bridge the gap by auto-creating bump files from commit history.

## Why not just use changesets?

Bumpy is built as a successor to [@changesets/changesets](https://github.com/changesets/changesets). Changesets is mature and widely adopted, but has stagnated — hundreds of open issues around core design problems that are unlikely to be fixed without a rewrite. See [DIFFERENCES_FROM_CHANGESETS.md](./DIFFERENCES_FROM_CHANGESETS.md) for a detailed comparison with links to specific issues. The biggest pain points bumpy addresses:

- **Sane dependency propagation** — changesets hardcodes aggressive behavior where a minor bump triggers a major bump on all peer dependents. Bumpy uses a [three-phase algorithm](docs/version-propagation.md) with sensible defaults and full configurability.
- **Workspace protocol resolution** — changesets uses `npm publish` even in pnpm/yarn workspaces, so `workspace:^` and `catalog:` protocols are NOT resolved, resulting in broken published packages.
- **Custom publish commands** — changesets is hardcoded to `npm publish`. Bumpy supports per-package custom publish for VSCode extensions, Docker images, JSR, etc.
- **Flexible package management** — changesets treats all private packages the same. Bumpy lets you include/exclude any package individually.
- **CI without a separate action** — just `bunx @varlock/bumpy ci check` in any workflow, no bot or action to install.
- **`bumpy migrate`** — converts `.changeset/` config and pending changeset files to `.bumpy/`.

## Development

```bash
bun install
bun test
bun src/cli.ts --help
```

## Roadmap

- Prerelease mode (for now, use [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new) for preview packages)
- Bun standalone binary for use outside of JS projects
- Better support for versioning non-JS packages and usage without package.json files
- Tracking workspace-level / non-publishable changes
