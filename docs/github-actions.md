# GitHub Actions Setup

Bumpy handles CI automation with two commands — no separate GitHub Action or bot to install. Just call `bumpy ci` directly in your workflows.

## Overview

| Command            | Trigger        | What it does                                                                                                                        |
| ------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `bumpy ci check`   | `pull_request` | Posts/updates a PR comment with the release plan. Warns about missing bump files.                                                   |
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

### Trusted publishing (OIDC — recommended)

No `NPM_TOKEN` secret needed. Requires npm >= 11.5.1.

```yaml
# .github/workflows/bumpy-release.yml
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

## Token setup

### `GH_TOKEN` (required)

The default `${{ github.token }}` provides the basic permissions needed for both `ci check` and `ci release`.

**Permissions needed:**

- `pull-requests: write` — for posting PR comments and creating the version PR
- `contents: write` — for pushing commits and tags (release workflow only)
- `id-token: write` — for npm trusted publishing / OIDC (release workflow only)

### `BUMPY_GH_TOKEN` (recommended)

GitHub's anti-recursion guard prevents PRs created by the default `github.token` from triggering other workflows. This means your regular CI workflows (tests, linting, etc.) won't run automatically on the Version Packages PR — so you can't verify that the version bumps don't break anything before merging.

To fix this, provide a `BUMPY_GH_TOKEN` using either a **fine-grained PAT** or a **GitHub App token**. Bumpy uses this token to push the version branch and create the PR, which allows your CI workflows to trigger normally.

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

| Variable         | Required          | Used by                  | Description                                       |
| ---------------- | ----------------- | ------------------------ | ------------------------------------------------- |
| `GH_TOKEN`       | Yes               | `ci check`, `ci release` | GitHub token for API access                       |
| `BUMPY_GH_TOKEN` | Recommended       | `ci release`             | PAT or App token so version PRs trigger workflows |
| `NPM_TOKEN`      | If not using OIDC | `ci release`             | npm access token for publishing                   |
