# GitHub Actions Setup

Bumpy handles CI automation with two commands — no separate GitHub Action or bot to install. Just call `bumpy ci` directly in your workflows.

## Overview

| Command            | Trigger        | What it does                                                                                                                        |
| ------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `bumpy ci check`   | `pull_request` | Posts/updates a PR comment with the release plan. Warns about missing bump files.                                                   |
| `bumpy ci plan`    | `push` to main | Reports what `ci release` would do (JSON + GitHub Actions outputs). Use to conditionally gate expensive steps.                      |
| `bumpy ci release` | `push` to main | Creates/updates a "Version Packages" PR. When that PR is merged, publishes packages, creates git tags, and creates GitHub releases. |

## PR check workflow

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

## Release workflow

### Trusted publishing (OIDC ��� recommended)

No `NPM_TOKEN` secret needed. Requires npm >= 11.5.1.

```yaml
# .github/workflows/bumpy-release.yml
name: Bumpy Release
on:
  push:
    branches: [main]

concurrency:
  group: bumpy-release
  cancel-in-progress: false

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
          BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }}
```

**Trusted publishing setup:** Configure each package on [npmjs.com](https://docs.npmjs.com/trusted-publishers/) → Package Settings → Trusted Publishers → GitHub Actions. Specify your org/user, repo, and the workflow filename (`bumpy-release.yml`).

### Token-based auth (NPM_TOKEN)

If you can't use trusted publishing, use an npm access token instead:

```yaml
# .github/workflows/bumpy-release.yml
name: Bumpy Release
on:
  push:
    branches: [main]

concurrency:
  group: bumpy-release
  cancel-in-progress: false

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
          BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }}
```

### Auto-publish mode

Instead of the two-step flow (version PR → merge → publish), you can version and publish directly on merge:

```yaml
- run: bunx @varlock/bumpy ci release --auto-publish
```

## Conditional builds with `ci plan`

Publishing often requires expensive build steps that aren't needed when just updating the version PR. Use `bumpy ci plan` to detect what `ci release` would do and conditionally gate those steps.

`ci plan` outputs JSON to stdout, sets GitHub Actions step outputs, and caches the result so that `ci release` can skip duplicate registry lookups in the same workflow run.

| Output     | Description                           |
| ---------- | ------------------------------------- |
| `mode`     | `version-pr`, `publish`, or `nothing` |
| `packages` | Comma-separated package names         |
| `json`     | Full JSON output (for `fromJSON()`)   |

### Basic: skip builds unless publishing

```yaml
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
      - run: bun install

      - id: plan
        run: bunx @varlock/bumpy ci plan
        env:
          GH_TOKEN: ${{ github.token }}

      # Only run expensive build when we're about to publish
      - if: steps.plan.outputs.mode == 'publish'
        run: bun run build

      - run: bunx @varlock/bumpy ci release
        env:
          GH_TOKEN: ${{ github.token }}
          BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }}
```

### Advanced: conditional steps per package

```yaml
- id: plan
  run: bunx @varlock/bumpy ci plan
  env:
    GH_TOKEN: ${{ github.token }}

# Build only specific packages that are being released
- if: contains(steps.plan.outputs.packages, 'my-expensive-package')
  run: bun run build --filter=my-expensive-package
```

## Concurrency

Use a concurrency group on your release workflow to prevent overlapping publish runs. Without this, rapid merges to main could trigger multiple workflows that race to publish the same packages.

```yaml
concurrency:
  group: bumpy-release
  cancel-in-progress: false # queue rather than cancel — don't skip releases
```

This is included in all the workflow examples above.

## Token setup

### `GH_TOKEN` (required)

The default `${{ github.token }}` provides the basic permissions needed for both `ci check` and `ci release`.

**Permissions needed:**

- `pull-requests: write` — for posting PR comments and creating the version PR
- `contents: write` — for pushing commits and tags (release workflow only)
- `id-token: write` — for npm trusted publishing / OIDC (release workflow only)

### `BUMPY_GH_TOKEN` (recommended)

GitHub's anti-recursion guard prevents PRs created by the default `github.token` from triggering other workflows. This means your regular CI workflows (tests, linting, etc.) won't run automatically on the Version Packages PR — so you can't verify that the version bumps don't break anything before merging.

To fix this, provide a `BUMPY_GH_TOKEN` using either a **fine-grained PAT** or a **GitHub App token**. Bumpy uses this token to push the version branch, which allows your CI workflows to trigger normally.

When `BUMPY_GH_TOKEN` is set, bumpy automatically uses it for git push operations and for creating/editing the version PR. PR comments always use the default `GH_TOKEN` so they appear from `github-actions[bot]`.

> **Note:** If you're using a developer's personal PAT, the version PR will be authored by that developer. Consider using a dedicated bot account or GitHub App so the developer can still review and approve the PR.

Run `bumpy ci setup` for interactive guidance, or set it up manually:

#### Option 1: Fine-grained personal access token

1. Go to [GitHub → Settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/personal-access-tokens)
2. Create a new token with:
   - **Repository access:** select your repo only
   - **Permissions:**
     - Contents: Read and write
     - Pull requests: Read and write
     - Metadata: Read (auto-selected)
3. Add it as a repository secret named `BUMPY_GH_TOKEN`

#### Option 2: GitHub App token

For organizations, a GitHub App avoids tying automation to a personal account:

1. Create a GitHub App with Contents and Pull Requests permissions (read & write)
2. Install it on your repository
3. Store `BUMPY_APP_ID` and `BUMPY_APP_PRIVATE_KEY` as repository secrets
4. Generate the token in your workflow:
   ```yaml
   - uses: actions/create-github-app-token@v2
     id: app-token
     with:
       app-id: ${{ secrets.BUMPY_APP_ID }}
       private-key: ${{ secrets.BUMPY_APP_PRIVATE_KEY }}
   - run: bunx @varlock/bumpy ci release
     env:
       GH_TOKEN: ${{ github.token }}
       BUMPY_GH_TOKEN: ${{ steps.app-token.outputs.token }}
   ```

### `NPM_TOKEN` (if not using trusted publishing)

A classic npm access token. Create one at [npmjs.com → Access Tokens](https://www.npmjs.com/settings/~/tokens) and add it as a repository secret named `NPM_TOKEN`.

## Environment variables summary

| Variable         | Required          | Used by                  | Description                                                       |
| ---------------- | ----------------- | ------------------------ | ----------------------------------------------------------------- |
| `GH_TOKEN`       | Yes               | `ci check`, `ci release` | GitHub token for API access                                       |
| `BUMPY_GH_TOKEN` | Recommended       | `ci check`, `ci release` | PAT or App token — used for push, and optionally for PRs/comments |
| `NPM_TOKEN`      | If not using OIDC | `ci release`             | npm access token for publishing                                   |
