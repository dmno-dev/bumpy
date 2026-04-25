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

A modern package versioning, release, and changelog generation tool. Built for monorepos, but works great in simpler projects too.

## How It Works

Bumpy uses **bump files** (you may know them as "changesets" if coming from [that tool 🦋](https://github.com/changesets/changesets)) - small markdown files that declare an intent to release packages with a bump level (patch/minor/major), and a description that ends up in changelogs. Developers create these files as part of their PRs, and these files are then used to consolidate changes, generate changelogs, and trigger publishing. Specifically:

- Devs/agents create bump files as part of their PRs (using `bumpy add` or manually)
- A pre-push git hook can enforce bump files exist for changed packages
- In CI, a workflow checks PRs for bump files, leaves a comment on the PR detailing changed packages
- As PRs merge to the base branch, a "release PR" is kept up to date
  - Shows what packages will be released and their changelogs
    - Including packages bumped automatically due to dependency relationships
- When release PR is merged, publishing is triggered
  - Pending bump files are deleted and packages are published with updated versions and changelogs

All of this is automated via two simple GitHub Actions workflows (see [CI setup](#ci--github-actions) below). You can also run everything locally with `bumpy status`, `bumpy version`, and `bumpy publish`.

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

## Features

- **All package managers** - npm, pnpm, yarn, and bun workspaces
- **Smart dependency propagation** - configurable rules for how version bumps cascade through your dependency graph (see [version propagation docs](https://github.com/dmno-dev/bumpy/blob/main/docs/version-propagation.md))
- **Pack-then-publish** - by default, publishes to npm (resolving `workspace:` and `catalog:` protocols, with OIDC/provenance support). Per-package custom publish commands let you target anything - VSCode extensions, Docker images, JSR, private registries, etc.
- **Flexible package management** - include/exclude any package individually via per-package config, glob patterns, or `privatePackages` setting
- **Non-interactive CLI** - `bumpy add` works fully non-interactively for CI/CD and AI-assisted development
- **Aggregated GitHub releases** - optionally create a single consolidated release instead of one per package
- **Auto-generate from commits** - `bumpy generate` creates bump files from branch commits - works with any commit style, with enhanced detection for conventional commits
- **Pluggable changelog formatters** - built-in `"default"` and `"github"` formatters, or write your own
- **Zero runtime dependencies** - dependencies are minimal and bundled at release time

## Getting Started

```bash
# Install
bun add -d @varlock/bumpy  # or npm/pnpm/yarn

# Initialize (creates .bumpy/ directory and config, migrates from changesets if applicable)
bunx bumpy init

# Create a bump file
bunx bumpy add

# Preview the release plan
bunx bumpy status
```

Then set up CI to automate versioning and publishing (see below).

## CI / GitHub Actions

No GitHub App to install, no separate action to rely on - just call `bumpy ci` directly in your workflows. Two commands handle the entire release lifecycle:

- **`bumpy ci check`** - runs on every PR. Computes the release plan from pending bump files and posts/updates a comment on the PR showing what versions would be released. Warns if any changed packages are missing bump files.
- **`bumpy ci release`** - runs on push to main. If pending bump files exist, it opens (or updates) a "Version Packages" PR that applies all version bumps and changelog updates. If the current push _is_ the Version Packages PR being merged, it publishes the new versions, creates git tags, and creates GitHub releases.

_examples use bun, but works with Node.js_

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
          BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }} # additional PAT (optional)
```

### Release workflow

```yaml
# .github/workflows/bumpy-release.yml - trusted publishing (OIDC, no secret needed)
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
          BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }} # additional PAT, needed to trigger CI checks on release PR
```

> **Trusted publishing setup:** Configure each package on [npmjs.com](https://docs.npmjs.com/trusted-publishers/) → Package Settings → Trusted Publishers → GitHub Actions. Specify your org/user, repo, and the workflow filename (`bumpy-release.yml`). No `NPM_TOKEN` secret needed. Requires npm >= 11.5.1 - bumpy will warn if your version is too old.

<details>
<summary>Alternative: token-based auth (NPM_TOKEN secret)</summary>

```yaml
# .github/workflows/bumpy-release.yml - token-based auth
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
          BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

</details>

You can also use `bumpy ci release --auto-publish` to version + publish directly on merge without the intermediate PR.

### Token setup

The default `github.token` works for basic functionality, but GitHub's anti-recursion guard means PRs created by the default token won't trigger other workflows - so your regular CI (tests, linting, etc.) won't run automatically on the Version Packages PR. To fix this, provide a `BUMPY_GH_TOKEN` secret using either a **fine-grained PAT** or a **GitHub App token**. See the [full token setup guide](https://github.com/dmno-dev/bumpy/blob/main/docs/github-actions.md#token-setup) for details.

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

The skill teaches the AI to examine git changes, identify affected packages, choose bump levels, and create bump files with `bumpy add`. It also instructs the AI to keep existing bump files up to date as work continues on a branch - updating packages, bump levels, and summaries to reflect the final state of changes.

## Documentation

- [Bump file format](https://github.com/dmno-dev/bumpy/blob/main/docs/bump-files.md) - syntax, bump levels, cascade control
- [Configuration reference](https://github.com/dmno-dev/bumpy/blob/main/docs/configuration.md) - all `.bumpy/_config.json` and per-package options
- [CLI reference](https://github.com/dmno-dev/bumpy/blob/main/docs/cli.md) - every command with flags and examples
- [GitHub Actions setup](https://github.com/dmno-dev/bumpy/blob/main/docs/github-actions.md) - CI workflows, token setup, trusted publishing
- [Version propagation](https://github.com/dmno-dev/bumpy/blob/main/docs/version-propagation.md) - how dependency bumps cascade through your graph

## Why files instead of conventional commits?

Tools like semantic-release infer version bumps from commit messages (`feat:` → minor, `fix:` → patch). This works for simple projects but breaks down in monorepos - a single PR often touches multiple packages with different bump levels, squash merges lose per-commit metadata, and commit messages are a poor place to write user-facing changelog entries. Bump files are explicit, reviewable in the PR diff, and can describe changes in language meant for consumers rather than developers. If you prefer commit-based workflows, `bumpy generate` can bridge the gap by auto-creating bump files from your branch commits - it works with any commit style, not just conventional commits.

## Why not just use changesets?

Bumpy is built as a successor to [@changesets/changesets](https://github.com/changesets/changesets). Changesets is mature and widely adopted, but has stagnated - hundreds of open issues around core design problems that are unlikely to be fixed without a rewrite. See [differences from changesets](https://github.com/dmno-dev/bumpy/blob/main/docs/differences-from-changesets.md) for a detailed comparison with links to specific issues. The biggest pain points bumpy addresses:

- **Sane dependency propagation** - changesets hardcodes aggressive behavior where a minor bump triggers a major bump on all peer dependents. Bumpy uses a [three-phase algorithm](https://github.com/dmno-dev/bumpy/blob/main/docs/version-propagation.md) with sensible defaults and full configurability.
- **Workspace protocol resolution** - changesets uses `npm publish` even in pnpm/yarn workspaces, so `workspace:^` and `catalog:` protocols are NOT resolved, resulting in broken published packages.
- **Custom publish commands** - changesets is hardcoded to `npm publish`. Bumpy supports per-package custom publish for VSCode extensions, Docker images, JSR, etc.
- **Flexible package management** - changesets treats all private packages the same. Bumpy lets you include/exclude any package individually.
- **CI without a separate action or bot** - changesets requires installing a [GitHub App](https://github.com/apps/changeset-bot) _and_ using a [separate GitHub Action](https://github.com/changesets/action). Bumpy replaces both with two CLI commands (`bumpy ci check` + `bumpy ci release`) that run directly in your workflows - no extra repos to trust, no app installation requiring org admin approval.
- **Automatic migration** - `bumpy init` detects `.changeset/`, renames it to `.bumpy/`, migrates config, keeps pending files, and offers to uninstall `@changesets/cli`.

## Development

```bash
bun install        # install deps
bun run test       # run tests
bun run build      # build CLI
bunx bumpy --help  # invoke built cli
```

## Roadmap

- Prerelease mode (for now, use [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new) for branch preview packages)
- Standalone binary for use outside of JS projects
- Better support for versioning non-JS packages and usage without package.json files
- Plugin system for different publish targets, and support multiple targets per package
- Tracking workspace-level / non-publishable changes
- More frogs 🐸

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
