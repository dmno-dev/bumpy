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

## PR check

`bumpy ci check` confirms every PR carries a bump file and posts a release-plan comment showing what will be released. The simplest setup is one step in your existing PR workflow (or a new one triggered `on: pull_request`):

```yaml
- run: bunx @varlock/bumpy ci check
  env:
    GH_TOKEN: ${{ github.token }}
```

Give the job `permissions: pull-requests: write`. This runs in the ordinary `pull_request` context — the same trust level as the rest of your CI — so there's nothing special to be careful about: you can `bun install` and run bumpy from your devDeps like any other CLI. (If the job already ran `bun install`, `bunx` picks up your pinned version from `node_modules`; otherwise it fetches the latest.)

**Fork PRs get the check, but not the comment.** GitHub hands `pull_request` runs from forks a **read-only token and no secrets**, so the comment can't be posted there. `ci check` still runs and fails the job (red ✗) on a missing bump file, with the explanation in the job logs — forks stay gated correctly, you just don't get the rendered comment. For most repos that's the right trade. If you want the comment on fork PRs too, add the two-part setup below.

> **Inline step vs. dedicated workflow.** Folding `ci check` into an existing CI job is the least setup and the right default for most repos. Give it its own lightweight `on: pull_request` workflow when either of these applies:
>
> - **Slow CI + fork comments.** The fork-comment poster below (`workflow_run`) fires on _whole-workflow_ completion, so if `ci check --emit-comment` rides inside a multi-minute CI workflow, the release-plan comment won't post until everything (lint, typecheck, build, tests) finishes. A dedicated check — no `bun install`, just `bunx bumpy` — completes in seconds, so the comment lands almost immediately.
> - **A load-bearing gate.** If `ci check` is an early step in your test job, its non-zero exit on a missing bump file fails the job and skips the remaining steps — so a contributor who pushed code before adding the bump file loses all test signal. A separate workflow (or a separate _job_) keeps the gate independent. A separate job doesn't share the test job's `bun install`, so once you're paying for an extra checkout anyway, a dedicated workflow also buys the fast comment above.

## Commenting on fork PRs

**This is optional — set it up only if you want the release-plan comment to appear on PRs from forks.** The `ci check` above already runs on fork PRs and fails them red on a missing bump file; it just can't post the comment there, because GitHub gives a fork's `pull_request` run a read-only token (secrets withheld, writes blocked server-side). Posting requires a privileged run in the base-repo context, and the safe way to get one is a small extra workflow whose privileged half **never touches the fork's code or files**:

1. Your existing `pull_request` check **renders** the comment and uploads it as an artifact.
2. A small, separate `workflow_run` workflow downloads that artifact and **posts** it.

The poster never checks out the PR, never runs a package manager against fork config, and never reads a fork file — it only posts pre-rendered text. (No forks to worry about? You don't need any of this.)

### 1. Render + upload (in your existing check)

Add `--emit-comment` to the `ci check` step and upload what it writes:

```yaml
# in your existing `on: pull_request` job
- run: bunx @varlock/bumpy ci check --emit-comment ./bumpy-comment
  env:
    GH_TOKEN: ${{ github.token }}
- uses: actions/upload-artifact@v4
  if: always() # upload even when the check fails — the comment explains why
  with:
    name: bumpy-comment
    path: ./bumpy-comment
```

`--emit-comment` writes the rendered comment to `./bumpy-comment/comment.md` (an empty file when there's nothing to say, so the artifact is always present). This step stays unprivileged — on a fork PR it renders but can't post; same-repo PRs still comment directly from here. The poster below is what rescues forks.

### 2. Post it (a separate workflow_run workflow)

```yaml
# .github/workflows/bumpy-comment.yaml
name: Bumpy PR Comment
on:
  workflow_run:
    workflows: ['CI'] # ← the NAME of the workflow that runs your check
    types: [completed]
permissions:
  pull-requests: write

jobs:
  comment:
    runs-on: ubuntu-latest
    steps:
      # TRUSTED: default branch only — never the PR. This is the privileged half.
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
      - uses: actions/download-artifact@v4
        continue-on-error: true # the check may not have produced a comment
        with:
          name: bumpy-comment
          # Download OUTSIDE the checkout (runner.temp) so the untrusted artifact
          # can't overwrite trusted files.
          path: ${{ runner.temp }}/bumpy-comment
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ github.token }}
      - run: |
          VERSION=$(jq -r '.devDependencies["@varlock/bumpy"] // .dependencies["@varlock/bumpy"]' package.json | sed 's/[\^~]//')
          bunx "@varlock/bumpy@$VERSION" ci comment --body-file "$RUNNER_TEMP/bumpy-comment/comment.md"
        env:
          GH_TOKEN: ${{ github.token }}
```

Point `workflows: [...]` at the **name** of whatever runs your check (your existing CI workflow, or a dedicated one). When it finishes, GitHub triggers this poster, which posts the rendered comment and exits. No bump-file changes → `ci comment` no-ops.

> **Heads-up: it won't run until it's on your default branch.** `workflow_run` always uses the workflow file as it exists on the default branch, so the poster doesn't fire for the PR that _adds_ it — fork comments start working once `bumpy-comment.yaml` is merged to `main`. (Same-repo PRs are unaffected; they comment directly from the check.)

> **The one safety rule.** The uploaded artifact is **untrusted** — it's produced by the unprivileged `pull_request` run from fork-controlled inputs (the comment is rendered from the PR's own bump files, and the run may execute fork code), so treat its contents as attacker-controlled. Two things keep it safe: (1) download it to `runner.temp`, **outside the checkout**, so it can't overwrite trusted files; and (2) `bumpy ci comment` uses the body only as comment text and resolves the **target PR from the trusted `workflow_run` event** (`head_sha`), never from the artifact — that's what stops a fork from redirecting the comment onto a different PR or issue. Don't override it with a `--pr` derived from artifact data.

> **If CodeQL flags this step (`actions/artifact-poisoning`):** that query fires on any `workflow_run` workflow that consumes an artifact from the triggering run. Downloading to `runner.temp` as above addresses its core recommendation (extract to a folder that can't overwrite existing files). If your repo's query is strict enough to still flag the download, it's a false positive you can dismiss — the body is used only as comment text and the PR is resolved from the trusted event, never the artifact.

> **Why can't the fork run post it itself?** A fork's `pull_request` token is read-only at issuance and enforced server-side — REST, GraphQL, `gh`, and raw `curl` all 403 on a comment write, and secrets aren't exposed either. The write has to originate from a privileged base-repo run, which is exactly what `workflow_run` provides.

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

## Staged publishing (finalizing a release)

With [`npmStaged`](configuration.md#staged-publishing) enabled, your release job runs `npm stage publish` instead of `npm publish`. The package is **staged** on npmjs.com, not live — a human still has to approve it with 2FA before anyone can install it. bumpy reflects that honestly instead of pretending the release shipped:

- The publish target is marked **🟡 staged, awaiting approval** (not ✅ published).
- The GitHub release stays a **draft** — so the `release: published` event does _not_ fire yet, and downstream release automation doesn't run against a package that isn't out.
- The npm stage id is recorded in the release metadata.

### The lifecycle

A staged release goes live in three steps. **The two responsibilities are split:** npm owns approval, bumpy owns the GitHub release.

1. **CI stages it.** You merge the Version Packages PR, the release job runs `npm stage publish`, and the draft GitHub release appears marked 🟡 staged.
2. **You approve it on npm.** This is npm's 2FA gate — `bumpy publish finalize` does _not_ do this for you. List what's pending and approve it:
   ```bash
   npm stage list                 # find the staged version + its <stage-id>
   npm stage approve <stage-id>   # provide 2FA — this publishes it to the registry
   ```
   (You can also approve from the package's page on npmjs.com. The stage id is also stored in the draft release's metadata.)
3. **You finalize the GitHub release.** Once the version is live, `bumpy publish finalize` reconciles GitHub: it checks the registry, flips the target to ✅ with the live package URL, and publishes the release (which _then_ fires `release: published`). It's idempotent — a version that's still staged is left untouched — so it's always safe to run.

### Option A: finalize manually

The simplest setup is **no extra workflow at all**. After approving, run finalize from your machine (or wherever you have `gh` + `npm`):

```bash
npm stage approve <stage-id>   # step 2 — approve on npm
bumpy publish finalize          # step 3 — update the GitHub release (reconciles all staged)
```

`bumpy publish finalize` with no argument reconciles every staged release; pass `name@version` to target one. It only reads the registry and edits the GitHub release — **no publish credentials needed**.

### Option B: finalize automatically (scheduled)

If you'd rather not run finalize by hand, add a workflow that reconciles on a schedule (and can also be triggered manually from the Actions tab). You still approve on npm in step 2 — this just handles step 3 for you, so a release goes from "approved" to "published on GitHub" without you touching it.

```yaml
# .github/workflows/bumpy-finalize.yml
name: Finalize
on:
  # Scheduled reconcile — picks up releases you've approved on npm.
  schedule:
    - cron: '17 * * * *' # hourly; tune to taste
  # Manual — run from the Actions tab, optionally targeting one release.
  workflow_dispatch:
    inputs:
      tag:
        description: 'Release to finalize (name@version). Blank = reconcile all staged.'
        required: false
        type: string

concurrency:
  group: bumpy-finalize
  cancel-in-progress: false

jobs:
  finalize:
    runs-on: ubuntu-latest
    permissions:
      contents: write # update + publish the GitHub release and tags
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-node@v6 # npm is needed to check whether staged versions went live
        with:
          node-version: latest
      - run: bun install
      - run: bunx @varlock/bumpy publish finalize ${{ inputs.tag }}
        env:
          GH_TOKEN: ${{ github.token }}
          # PAT/App token so finalizing fires downstream `release: published` workflows
          BUMPY_GH_TOKEN: ${{ secrets.BUMPY_GH_TOKEN }}
```

This job needs **no publish credentials** — no `id-token`, no `NPM_TOKEN`. It only reads the registry and edits the GitHub release, so the low-privilege default token is enough (plus `BUMPY_GH_TOKEN` if you want the finalized release to trigger downstream workflows).

### Option C: finalize instantly (event-driven)

If you approve through automated tooling (a service that approves staged publishes), have it fire a `repository_dispatch` the moment it approves, so the GitHub release finalizes with no cron lag. Add this trigger to the workflow above:

```yaml
on:
  repository_dispatch:
    types: [bumpy-finalize]
```

Think of the dispatch as a **"something got approved — go reconcile" nudge, not a "finalize this one thing" command.** It carries no payload: the workflow above already runs `publish finalize` with no argument, which reconciles _every_ staged release that's now live. That's exactly what you want for a monorepo, where one release stages many packages together — the approver fires a single ping and the whole batch finalizes:

```bash
# after approving the batch on npm — one ping, no payload
gh api repos/OWNER/REPO/dispatches -f event_type=bumpy-finalize
```

Because finalize decides what to publish by probing the registry (not from the payload), this stays correct even when unrelated versions are staged — it only finalizes the ones that actually went live, and it's idempotent, so firing it more than once is harmless.

> **Targeting one release (optional).** In the rare case you want to finalize a single release and leave others staged, pass its tag in the payload and thread it into the run step — `publish finalize ${{ github.event.client_payload.tag }}`:
>
> ```bash
> gh api repos/OWNER/REPO/dispatches -f event_type=bumpy-finalize -F 'client_payload[tag]=my-pkg@1.2.3'
> ```
>
> For most repos you won't need this — the no-payload nudge above is the norm.

### If a staged publish is rejected

Approval is publicly observable (the package goes live, and finalize notices), but **rejection is not** — a rejected stage looks identical to a still-pending one to `npm info` (both are simply "not live"). So bumpy can't auto-detect a rejection, and the release would otherwise sit at 🟡 forever. When you reject a stage, tell bumpy — **this is a plain manual step; no CI, tooling, or stageflight required:**

```bash
npm stage reject <stage-id>              # reject on npm
bumpy publish reopen my-pkg@1.2.3        # tell bumpy — reopens the release for re-publish
```

`publish reopen` flips the staged target back to **failed**, which rejoins the normal fix-forward path: the 🟡 marker clears, the version tag un-freezes, and the **next `bumpy publish` re-stages the same version** (whether that publish runs on your machine or in CI). Push your fix and re-publish. It needs no npm credentials — it only edits the GitHub release.

You have three ways out of a rejected stage:

- **Redo it** → `bumpy publish reopen <tag>`, then re-publish. Keeps the release notes/changelog; re-stages the same version.
- **Start clean** → `gh release delete <tag>`, then re-publish. The next `bumpy publish` finds no draft and re-stages from scratch. (The nuclear option — you lose the draft's edits.)
- **Abandon it** → do nothing. Ship a different version instead and the stale draft gets superseded automatically.

If you approve/reject through tooling, have it run `bumpy publish reopen <tag>` (e.g. via a `repository_dispatch`) at rejection time — the mirror of the finalize nudge. But that's purely an automation convenience on top of the manual command above; the command is the baseline.

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
