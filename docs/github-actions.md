# GitHub Actions Setup

Bumpy handles CI automation through its `bumpy ci` subcommands — no separate GitHub Action or bot to install. Just call `bumpy ci` directly in your workflows.

## Overview

| Command            | Trigger        | What it does                                                                                                                                       |
| ------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bumpy ci check`   | `pull_request` | Posts/updates a PR comment with the release plan. Warns about missing bump files.                                                                  |
| `bumpy ci plan`    | `push` to main | Reports what `ci release` would do (JSON + GitHub Actions outputs). Use to gate downstream jobs.                                                   |
| `bumpy ci release` | `push` to main | Either creates/updates the "Version Packages" PR (if bump files are present) or publishes packages, tags, and GitHub releases (if just versioned). |

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

## Release workflow (recommended: split jobs)

The recommended release workflow splits version-PR maintenance from publishing into separate jobs. Only the publish job carries `id-token: write` and npm credentials, and it runs inside a GitHub Environment — so a rogue workflow elsewhere in the repo can't request an OIDC token that npm will accept.

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
  # Detect what `ci release` would do — no write permissions, no publish credentials.
  plan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      mode: ${{ steps.plan.outputs.mode }}
      packages: ${{ steps.plan.outputs.packages }}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - id: plan
        run: bunx @varlock/bumpy ci plan
        env:
          GH_TOKEN: ${{ github.token }}

  # Creates/updates the Version Packages PR. No publish credentials.
  version-pr:
    needs: plan
    if: needs.plan.outputs.mode == 'version-pr'
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
      - run: bunx @varlock/bumpy ci release --expect-mode version-pr
        env:
          GH_TOKEN: ${{ github.token }}
          BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }} # so the version PR triggers CI

  # Publishes packages. Scoped to the `publish` environment.
  publish:
    needs: plan
    if: needs.plan.outputs.mode == 'publish'
    runs-on: ubuntu-latest
    environment: publish
    permissions:
      contents: write
      id-token: write # required for npm trusted publishing (OIDC) and provenance
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-node@v6
        with:
          node-version: latest
      - run: npm install -g npm@latest # ensure npm >= 11.15.0 for OIDC/staged publishing
      - run: bun install
      # Expensive build steps that only matter before publish go here:
      # - run: bun run build
      - run: bunx @varlock/bumpy ci release --expect-mode publish
        env:
          GH_TOKEN: ${{ github.token }}
          BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }} # so `release: published` workflows trigger
```

**How the three jobs interact:**

- `plan` runs `bumpy ci plan` to determine whether the current push should update the Version Packages PR (`version-pr`), publish unpublished packages (`publish`), or do nothing.
- Only one of `version-pr` or `publish` runs per push. The other is skipped via the `if:` condition.
- The `--expect-mode` flag on `ci release` asserts that the detected mode matches what each job expects — if the runtime state ever drifts, the job fails loudly instead of silently doing the wrong thing.
- Expensive build steps (compilation, tests, bundling) only run inside the `publish` job, so PR merges that just maintain the version PR stay cheap.

### Required setup

1. **Pin the npm trusted publisher to environment `publish`** on each package's npmjs.com settings → Trusted Publishers → GitHub Actions. Set the environment field to `publish`. This binds the OIDC trust to that specific environment — even if someone adds a rogue workflow file, npm will reject any token request that doesn't carry the `publish` environment claim.
2. **Set `BUMPY_GH_TOKEN`** — see [Token setup](#token-setup) below.

That's it — the `publish` environment auto-creates on the first publish run, so no manual GitHub setup is required.

### Optional hardening: protection rules on the `publish` environment

If you create the environment manually in repo Settings → Environments _before_ the first publish, you can attach protection rules:

- **Restrict deployment branches to `main`** — recommended. Cheap defense in depth: non-`main` refs can never request an OIDC token from this environment, even if a workflow trigger is accidentally widened later.
- **Required reviewers** — optional. Adds a manual approval gate before each publish. Usually redundant if `npmStaged: true` is enabled (below), since you already have a 2FA approval gate on npmjs.com.

**Recommended publish config** — enable provenance and staged publishing for maximum security:

```json
{
  "publish": {
    "provenance": true,
    "npmStaged": true
  }
}
```

> **Staged publishing:** With `npmStaged` enabled, bumpy uses `npm stage publish` to stage packages on npmjs.com, requiring manual 2FA approval before they go live — even if your CI credentials are compromised, nothing gets published without maintainer approval. See the [staged publishing docs](./configuration.md#staged-publishing) for details.

### Using `NPM_TOKEN` instead of OIDC

If you can't use trusted publishing, swap `id-token: write` for an `NPM_TOKEN` secret. Scope the secret to the `publish` environment (repo Settings → Environments → publish → Add secret) so only this job can read it:

```yaml
publish:
  needs: plan
  if: needs.plan.outputs.mode == 'publish'
  runs-on: ubuntu-latest
  environment: publish
  permissions:
    contents: write
  steps:
    # ... checkout/setup-bun/setup-node/install steps ...
    - run: bunx @varlock/bumpy ci release --expect-mode publish
      env:
        GH_TOKEN: ${{ github.token }}
        NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
        BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }}
```

## Release workflow (simplified single-job)

For simpler setups, you can run everything in a single job. `bumpy ci release` will smart-route between version-PR and publish based on the current state.

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
          node-version: latest
      - run: npm install -g npm@latest
      - run: bun install
      - run: bunx @varlock/bumpy ci release
        env:
          GH_TOKEN: ${{ github.token }}
          BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }}
```

**Trade-off:** this is the shortest workflow you can write, but `id-token: write` and any publish secrets are exposed on every push to main — including pushes that only update the version PR. The split-job workflow above scopes those credentials to the publish step only. Prefer the split workflow unless you have a strong reason not to.

## Auto-publish mode (not recommended)

Instead of the two-step flow (version PR → merge → publish), you can version and publish directly on merge:

```yaml
- run: bunx @varlock/bumpy ci release --auto-publish
```

This is **not recommended** for two reasons:

- You lose the preview/review step. Every merge to main with a bump file ships immediately — no chance to catch a wrong bump level or unintended release in the Version Packages PR.
- The job needs `pull-requests: write` _and_ publish credentials (OIDC / `NPM_TOKEN`) in the same step. This rules out the split-job pattern that scopes publish credentials to a dedicated job/environment.

If you want fewer steps in your release flow, prefer the [split-job workflow](#release-workflow-recommended-split-jobs) — it's not more code on your side, and it keeps the security boundary intact.

## Advanced: per-package conditional builds

If you have one expensive package whose build you only want to run when that package itself is being released, use `ci plan`'s `packages` output to gate per-package steps:

```yaml
- id: plan
  run: bunx @varlock/bumpy ci plan
  env:
    GH_TOKEN: ${{ github.token }}

# Build only when this specific package is being released
- if: contains(fromJSON(steps.plan.outputs.packages), 'my-expensive-package')
  run: bun run build --filter=my-expensive-package
```

`ci plan` outputs:

| Output     | Description                                                   |
| ---------- | ------------------------------------------------------------- |
| `mode`     | `version-pr`, `publish`, or `nothing`                         |
| `packages` | JSON array of package names (for `fromJSON()` + `contains()`) |
| `json`     | Full JSON output (for `fromJSON()`)                           |

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

The default `${{ github.token }}` covers general API access (registry lookups, reading PRs, posting comments).

**Permissions needed per job:**

- `pull-requests: write` — for posting PR comments (`ci check`) or creating the version PR (`version-pr` job)
- `contents: write` — for pushing commits and tags (release jobs)
- `id-token: write` — for npm trusted publishing / OIDC (publish job only)

### `BUMPY_GH_TOKEN` (recommended)

GitHub's anti-recursion guard prevents PRs created by the default `github.token` from triggering other workflows. This means your regular CI workflows (tests, linting, etc.) won't run automatically on the Version Packages PR — so you can't verify that the version bumps don't break anything before merging.

To fix this, provide a `BUMPY_GH_TOKEN` using either a **fine-grained PAT** or a **GitHub App token**. Bumpy uses this token selectively — only for the specific operations where bypassing the anti-recursion guard matters (pushing the version branch, creating the version PR, creating the GitHub release). Everything else continues to use the default `GH_TOKEN`.

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

A classic npm access token. Create one at [npmjs.com → Access Tokens](https://www.npmjs.com/settings/~/tokens) and add it as a secret on the `publish` environment (repo Settings → Environments → publish → Add secret) so only the publish job can read it.

## Environment variables summary

| Variable         | Required          | Used by                  | Description                                                                   |
| ---------------- | ----------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `GH_TOKEN`       | Yes               | `ci check`, `ci release` | GitHub token for API access — `${{ github.token }}` is fine                   |
| `BUMPY_GH_TOKEN` | Recommended       | `ci check`, `ci release` | PAT or App token — selectively used for ops where workflow-triggering matters |
| `NPM_TOKEN`      | If not using OIDC | publish job              | npm access token for publishing                                               |
