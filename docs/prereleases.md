# Prerelease Channels

Prerelease versioning lets you ship `1.2.0-rc.0`, `1.2.0-beta.1`, etc. before the stable `1.2.0` — for early adopters, integration testing, or staging risky changes.

Bumpy's model is **branch-based**: you nominate one or more long-lived branches (e.g. `next`, `beta`) in your config as prerelease channels. CI runs the same release workflow on those branches as it does on `main` — only the version suffix and dist-tag change. When you're ready to ship stable, you merge the channel branch into `main` and the ordinary stable release flow takes over.

**Prerelease versions are never committed to git.** On a channel branch, every `package.json` keeps the last stable version — identical to `main`. Prerelease versions are computed at publish time and exist only in the npm registry and in git tags.

No `pre enter` / `pre exit` commands. No mode files. No version churn in your branches. No hidden state that can poison unrelated merges.

> If you're coming from changesets, see [Comparison with changesets pre mode](#comparison-with-changesets-pre-mode) at the bottom for a side-by-side.

## The one rule everything follows from

> **Git carries inputs (bump files) and stable outputs (versions and `CHANGELOG.md`, on `main`). Everything prerelease — versions, counters, release notes — is derived on demand from bump files, the registry, and git tags. Bumpy never commits derived state.**

This is why there's no prerelease counter to corrupt, no suffix to strip at promotion, no stale index file to mislead you, and why `main` ↔ channel merges don't conflict on version numbers.

## When to use channels — and when not to

Channels are designed for **long-lived release lines** — an ongoing `next` / `beta` / `rc` cycle that accumulates changes over days or weeks before promotion to stable. They're worth setting up when you expect to ship multiple prereleases through the same cycle.

**For anything short-lived or ephemeral, use [pkg.pr.new](https://pkg.pr.new) instead.**

pkg.pr.new publishes throwaway packages from any PR, commit, or branch — no version planning, no branch discipline, no bump files. It pairs naturally with bumpy: bumpy owns the managed release lines, pkg.pr.new owns the ephemeral previews. Between the two, most teams need nothing else.

Rough rule of thumb:

| You want…                                                 | Use                              |
| --------------------------------------------------------- | -------------------------------- |
| Preview a single PR for review                            | [pkg.pr.new](https://pkg.pr.new) |
| Per-commit canary from `main`                             | [pkg.pr.new](https://pkg.pr.new) |
| One-off snapshot from a branch for ad-hoc testing         | [pkg.pr.new](https://pkg.pr.new) |
| Ship a `1.2.0-rc.N` line for weeks of integration testing | Bumpy channels (this doc)        |
| Parallel `@next` + `@beta` lines for different audiences  | Bumpy channels (this doc)        |

---

## Mental model

```
                git (versions stay at 1.1.0 throughout)        npm registry
                ┌──────────────────────────────────────┐
 feature PR ───►│  next branch                          │
 feature PR ───►│   ├─ release PR merge ────────────────┼──► 1.2.0-rc.0 → @next
 feature PR ───►│   └─ release PR merge ────────────────┼──► 1.2.0-rc.1 → @next
                └───────────────────┬──────────────────┘
                                    │ merge (no version changes in the diff)
                                    ▼
                ┌──────────────────────────────────────┐
                │  main branch                          │
                │   └─ version PR (1.1.0 → 1.2.0) ──────┼──► 1.2.0 → @latest
                └──────────────────────────────────────┘
```

- **Branch = channel.** The `next` branch is the `next` channel. Pushing to it produces prerelease publishes on the `@next` dist-tag.
- **Same flow as main.** Feature PRs land bump files. A "🐸 Versioned prerelease (next)" PR accumulates the cycle. Merging it triggers a prerelease publish.
- **The release PR moves files, not versions.** Its diff is bump files moving into `.bumpy/next/`. The computed versions appear in the PR title and merge commit message — so `git log` on the channel reads as a release history — but nothing version-shaped is committed.
- **Promotion is a merge.** `next` → `main` carries the accumulated bump files forward (and nothing else release-related — versions never diverged). Main's ordinary stable version PR consumes them.

---

## How state is tracked

The **only** channel state is bump file location:

```
.bumpy/
├── _config.json
├── README.md
├── feature-y.md            ← pending — will go into the next prerelease
├── another-feature.md      ← pending
└── next/                   ← shipped on the "next" channel
    ├── feature-x.md
    └── earlier-fix.md
```

The general rule: **a bump file is pending unless it's in the current context's own channel directory.**

- On `next`: files at `.bumpy/` root are pending; files in `.bumpy/next/` have shipped on this channel.
- On `main`: files anywhere (root **or** any channel subdir) are pending for the stable release.
- On `beta`, after merging `alpha` → `beta`: files in `.bumpy/alpha/` are pending-for-beta — they shipped on alpha but not here. Beta's release PR moves them into `.bumpy/beta/`. This is how **channel graduation** (alpha → beta → stable) works with no extra machinery.

At any time, `ls .bumpy/` tells you exactly where everything stands. No frontmatter flags, no committed mode files, no counters.

---

## Setup

### 1. Declare the channel in config

Add a `channels` block to `.bumpy/_config.json`:

```jsonc
{
  "baseBranch": "main",
  "channels": {
    "next": {
      "branch": "next",
      "preid": "rc", // version suffix: 1.2.0-rc.0
      "tag": "next", // npm dist-tag: published to @next
    },
  },
}
```

Multiple channels can coexist:

```jsonc
{
  "channels": {
    "next": { "branch": "next", "preid": "rc", "tag": "next" },
    "beta": { "branch": "beta", "preid": "beta", "tag": "beta" },
    "alpha": { "branch": "alpha", "preid": "alpha", "tag": "alpha" },
  },
}
```

> Semver orders prerelease identifiers lexically, so `alpha` < `beta` < `rc` for the same target version — graduated channels sort correctly by maturity out of the box.

### 2. Create the branch

```bash
git checkout -b next
git push -u origin next
```

### 3. Add the branch to your release workflow

In `.github/workflows/bumpy-release.yml`, add the channel branches to the `push` trigger:

```yaml
on:
  push:
    branches: [main, next] # add channel branches here
```

That's the only workflow change. `bumpy ci release` reads the current branch, looks up the channel in `_config.json`, and behaves accordingly.

> **If your publish job runs in a GitHub Environment with deployment branch restrictions** (the [recommended hardening](github-actions.md#optional-hardening-protection-rules-on-the-publish-environment) restricts it to `main`), add each channel branch to the environment's allowed deployment branches (repo Settings → Environments → publish → Deployment branches). Otherwise the publish job can't run from the channel branch — with npm trusted publishing this means OIDC token requests are rejected and channel publishes fail.

> Make sure the checkout step uses `fetch-depth: 0` (the [release workflow](github-actions.md) already requires this) — the channel publish trigger diffs the triggering push to detect release PR merges.

> The PR check workflow (`bumpy-check.yaml`) needs no changes — it runs on `pull_request_target` and handles any base branch.

---

## Day-to-day workflow

### Authoring a prerelease feature

PR authors do nothing different. They:

1. Branch off `next` (instead of `main`)
2. Make their change
3. Run `bumpy add` to create a bump file (always lands at `.bumpy/feature-x.md`, never directly in a channel subdir)
4. Open a PR targeting `next`

Bump files don't carry channel metadata. The branch they land on determines the channel; their location tracks whether they've shipped.

> Reviewing a feature PR and want to install it before merge? That's [pkg.pr.new](https://pkg.pr.new)'s job, not a channel publish. Channels only kick in once a PR has merged into the channel branch.

### Versioning a prerelease

When a feature PR merges to `next`:

1. `bumpy ci release` runs on the `next` push.
2. It sees a pending bump file and creates (or updates) a **release PR** — titled something like **"🐸 Versioned prerelease (next): 1.2.0-rc.4"**, targeting `next`, on the branch `bumpy/version-packages-next`.
3. The PR's diff is **only file moves**: `.bumpy/feature-x.md` → `.bumpy/next/feature-x.md`. The computed versions live in the PR title and body, and land in git history via the merge commit message.

When a maintainer merges that PR:

4. `bumpy ci release` runs again on `next`, sees newly-shipped files in `.bumpy/next/`, computes the prerelease versions fresh (see [Publish mechanics](#publish-mechanics) below), and publishes the full cycle to the `@next` dist-tag.
5. Git tags (`my-package@1.2.0-rc.0`) are pushed; a GitHub release is created (marked as prerelease) for each package, with notes built from the cycle's bump files that touched it.

```bash
# A consumer testing the prerelease:
npm install my-package@next       # gets 1.2.0-rc.0
```

> **The PR title is narrative, not state.** Versions are recomputed at publish time and the registry always wins. If reality moved between PR creation and merge (e.g. `main` shipped a stable release that overtakes the cycle's target), publish uses the recomputed versions and warns about the retarget in its logs. Bumpy never reads versions back out of PR titles or commit messages.

To skip the manual merge step, set `versionPr.automerge: true` on the channel — the release PR is created with auto-merge enabled, so each feature merge flows to a prerelease publish once checks pass. The PR (and its file-move commit) still exists, keeping the model intact; you just don't click the button.

### A second prerelease

When a new feature lands on `next`:

- The new bump file appears at `.bumpy/feature-y.md` (root). Previously-shipped `.bumpy/next/feature-x.md` stays put.
- `bumpy ci release` opens/updates the release PR, which moves `feature-y.md` into `.bumpy/next/`.
- Merge → publish computes `1.2.0-rc.1` and republishes the cycle. Each package's `rc.1` GitHub release carries notes from the cycle's bump files that touched it (`feature-y.md` shows up on the packages it changed).

If a feature merges immediately after a release PR merges, both halves happen in one run: bumpy publishes the rc for the already-moved files **and** opens the next release PR for the new pending file. The two actions are independent.

### Promotion to stable

When the prerelease has been tested and you're ready to ship the real `1.2.0`:

1. **Merge `next` → `main`** (regular PR — review it like any other). The diff contains your features and the bump files in `.bumpy/next/` — and **zero version changes**, because versions never diverged.
2. `bumpy ci release` runs on `main` and follows its completely ordinary flow: it sees pending bump files (everything in `.bumpy/next/` counts as pending on `main`) and opens the standard **"🐸 Versioned release"** PR, which:
   - Bumps versions stable-to-stable (`1.1.0` → `1.2.0` — there's no suffix to strip)
   - Consumes **all** bump files from `.bumpy/next/` (and any pending root files)
   - Writes a single consolidated `## 1.2.0` entry to `CHANGELOG.md` with every change from the cycle
   - Deletes `.bumpy/next/`
3. Merge that PR → bumpy publishes `1.2.0` to `@latest`, tags `v1.2.0`, and creates a stable GitHub release.

There is no special promotion mode. Promotion is literally "the bump files arrive on `main` and the stable flow eats them."

> The final stable `CHANGELOG.md` entry includes every change from the prerelease cycle — consumers of `@latest` see the full picture, not just the last rc's delta. Individual rc release notes remain available on the GitHub releases page.

### Continuing after promotion

After promotion, the cycle is over (no pending files, no `.bumpy/next/` on `main`). For the channel branch:

- **Delete and recreate (recommended).** Delete `next`, recreate it from `main` when the next cycle starts. The channel config doesn't require the branch to exist between cycles.
- **Force-reset and reuse.** `git reset --hard main && git push --force-with-lease`. Only do this if no feature PRs currently target `next` (they'd be left with garbage diffs), and note that branch protection on long-lived branches often forbids force-pushes — which is why delete-and-recreate is the default recommendation.

### Abandoning a prerelease cycle

Sometimes a cycle gets shelved without shipping stable. Force-reset or delete the branch — that's it.

Because versions are never committed and counters come from the registry, an abandoned cycle leaves nothing behind to clean up and nothing that can collide later: the published `1.2.0-rc.N` versions and their tags simply remain as history, and any future cycle targeting `1.2.0` resumes counting above them. There is no `bumpy channel reset` command because there is no state to reset.

---

## Publish mechanics

How `bumpy publish` (and the publish half of `bumpy ci release`) works on a channel, with no committed versions to read:

**Target** — computed from the cycle's bump files. The cycle = all bump files at root + in `.bumpy/<channel>/`, run through the normal [propagation phases](./version-propagation.md). This yields each package's target stable version (e.g. `core` → `1.2.0`, `plugin` → `1.0.1`).

**Counter** — derived from the registry: for each package, find the highest published `-<preid>.N` for its target version; the next publish is `N+1` (or `.0` if none exists). This makes counters immune to branch resets, abandoned cycles, and anything else that would corrupt committed state.

**Trigger** — in CI, publish fires when the triggering push added files to `.bumpy/<channel>/` (the push event's `before..after` range, falling back to the last commit). That's exactly what merging a release PR does; an ordinary feature merge never touches the channel dir, so it never causes a publish. This requires git history in the checkout — use `fetch-depth: 0`, which the [release workflow](github-actions.md) needs anyway. Running `bumpy publish` manually on the channel branch always publishes the cycle (manual = explicit intent).

**Idempotency & resume** — re-running on the same commit is a no-op: npm records the publishing commit (`gitHead`) in each version's metadata, so bumpy can tell "already published from this exact SHA — skip" apart from "needs the next counter." (Packages publishing outside npm — custom commands, `skipNpmPublish` — use their git tags for the same check.) If a publish fails partway, re-running resumes it package by package; `bumpy publish --filter` remains available as a manual fallback.

**Order of operations** — publish packages topologically, then push tags, then create the GitHub release. Tags are the completion marker, so they go up only after the registry is fully consistent.

**Where versions get written** — into the published artifacts, at publish time, using the same machinery that already resolves `workspace:` protocols. In the default `pack` mode the rewrite happens in the packing step; in `in-place` mode bumpy transiently writes computed versions to the working tree before running build/publish lifecycle scripts, then restores.

> **If your build bakes in the version** (reading `package.json` into a banner, `__VERSION__` replacement, etc.), the rewrite must happen before your build runs — use `in-place` mode or build inside the publish lifecycle. Otherwise your prerelease artifacts would report the last _stable_ version at runtime. The tarball's `package.json` is always correct either way.

---

## Changelogs and release notes

**Channel branches never write `CHANGELOG.md`.** Three reasons: the consolidated entry at promotion would supersede it anyway; it would be a merge-conflict magnet on every `main` → channel sync; and rewriting it at promotion is exactly how changesets' pre-exit ends up lossy.

Instead:

- **The cycle's changelog is the bump files themselves**, sitting readable in `.bumpy/next/`.
- **Per-rc notes** go to GitHub releases (marked prerelease), built per package from the cycle's bump files that touched it.
- **`bumpy status`** on a channel renders the would-be changelog for the whole cycle on demand — the answer to "what has shipped on `@next` so far," including for teams not on GitHub.
- **The stable `CHANGELOG.md` entry** is written once, at promotion, on `main` — lossless, because it's built from the bump files rather than from intermediate changelogs.

There is deliberately no versions index file or per-channel README either — any committed reflection of registry state can go stale and mislead (failed publishes, retargets, resets). The computed versions appear in the release PR title and merge commit message, which are understood as point-in-time narrative; live truth is always `bumpy status`, the dist-tags, and the git tags.

---

## Hotfixes during a prerelease

Patches can flow to `main` independently while a prerelease is in flight on `next`:

```
  main:  1.1.0 ──► 1.1.1 (hotfix)
                            ╲  merge main → next
  next:   1.2.0-rc.0 ──► 1.2.0-rc.1 (includes the hotfix)
```

After the hotfix lands on `main`, merge `main` → `next` to pick it up. Because versions are identical on both branches, these syncs don't conflict on `package.json` version lines or `CHANGELOG.md` — the perennial pain of long-lived release branches doesn't apply.

**Retargeting is automatic.** If `main` ships a release that overtakes the cycle's target (e.g. `main` ships `1.2.0` while the channel was publishing `1.2.0-rc.N`), the next channel publish recomputes naturally: the workspace base is now `1.2.0`, the bump files yield a target of `1.3.0`, and the registry floor starts the counter at `1.3.0-rc.0`. There's no committed state to fix up. (Ship an rc promptly after a retarget so the `@next` dist-tag doesn't linger below `@latest`.)

**Known wart — a hotfix that rides both trains.** If a bump file is authored on `main`, synced into `next` before `main` ships it, and then ships stable on `main`, the later `main` → `next` sync surfaces a rename/delete conflict on that file (deleted at root on `main`, moved into `.bumpy/next/` on the channel). **Resolve by deleting it** — the change already shipped stable and is in `main`'s changelog; keeping the channel copy would duplicate it in the consolidated entry at promotion. Authoring hotfixes on `main` and syncing promptly keeps this rare.

---

## Dependency handling in prerelease channels

Prereleases interact with semver differently from stable releases in one key way:

> A range like `"@org/core": "^1.0.0"` continues to satisfy through `1.1.0`, `1.99.0`, etc. **But it doesn't satisfy any prerelease** — `^1.0.0` matches `1.5.0` but not `1.5.0-rc.0`. Semver only resolves a prerelease against a range when major.minor.patch matches exactly.

This means **every prerelease of an upstream package breaks every dependent's range.** A "tighter" prerelease that left dependents on stable would force users to add `overrides` / `resolutions` by hand to install anything from the cycle. So channel cascades are wide by design — the cycle is exactly the set of packages a tester can mix and match via `@next`.

### The cycle moves as one

Because nothing is committed incrementally, **every publish recomputes the entire cycle from scratch** — all bump files, full propagation ([Phase A/B/C](./version-propagation.md) run unchanged, with proportional bump levels: `patch` for `dependencies`, match-the-trigger for `peerDependencies`, avoiding the changesets [#960](https://github.com/changesets/changesets/issues/960) force-major problem). Every in-cycle package gets a fresh counter and republishes together, every rc.

This lockstep isn't a special rule — it falls out of "there is no incremental state." And it's what makes the coherence guarantee real:

### The exact-pin rule

Within the cycle, every inter-cycle dependency is **exact-pinned** in the published artifacts:

> If `@org/plugin@1.0.1-rc.2` is in the same cycle as `@org/core@1.2.0-rc.2`, the published `@org/plugin@1.0.1-rc.2` has `"@org/core": "1.2.0-rc.2"` — not `"^1.2.0-rc.2"`.

Because the whole cycle republishes together, the `@next` dist-tags always point at one coherent, exact-pinned set: any combination installed via `@next` works against exactly the versions it was published with, and peer dependencies can never half-resolve across two different rcs. Channel-internal consistency is built into the artifacts, not relied on at install time.

Dependencies pointing **outside** the cycle (e.g., to a package excluded via `ignore`) keep their stable ranges.

### `workspace:` protocol resolution

`workspace:^` / `workspace:*` on an in-cycle dep resolves to the exact prerelease version at publish time. On an out-of-cycle dep, it resolves normally (the stable range bumpy would produce on `main`).

### Limiting cascade scope

If the default — "every dependent comes along" — is too wide for your monorepo, the standard bumpy controls bound the cycle:

- `ignore` / `include` in `_config.json` constrain which packages are managed at all
- Per-package `managed: false` excludes individual packages
- `linked` / `fixed` / `cascadeTo` declarations don't _narrow_ the cascade, but they make wider propagation more predictable when you want it

There's no channel-specific opt-out of the cascade — disabling it would produce stranded prereleases that consumers couldn't actually install together.

---

## CLI behavior on a channel branch

| Command            | On `main`                                             | On `next` (channel branch)                                                                        |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `bumpy status`     | shows planned stable versions                         | shows the cycle: pending vs shipped files, computed `-rc.N` (registry-derived; `rc.?` if offline) |
| `bumpy version`    | bumps versions, consumes bump files, writes changelog | **moves** pending files into `.bumpy/next/` — writes no versions, no changelog                    |
| `bumpy publish`    | publishes to `@latest`                                | computes prerelease versions, rewrites artifacts, publishes the cycle to `@next`, pushes tags     |
| `bumpy ci release` | version-PR / publish on main                          | release-PR (file moves) / publish on `next`                                                       |
| `bumpy ci check`   | (PR-level, unchanged)                                 | (PR-level, unchanged)                                                                             |
| `bumpy check`      | compares to `baseBranch`                              | skipped on channel/release-PR branches; use `--base next` on feature branches targeting a channel |

You can override the inferred channel with `--channel <name>` for local testing:

```bash
bumpy status --channel next        # preview what next would publish
bumpy version --channel next       # locally move pending files into .bumpy/next/
```

The override is mainly for debugging; CI should rely on branch detection.

Note that `bumpy status` on a channel needs registry access to show exact counters. Offline, it shows the computed target with a placeholder counter (`1.2.0-rc.?`).

---

## What if no channel matches?

If `bumpy ci release` runs on a branch that isn't `baseBranch` and isn't in `channels`, it exits with a clear error rather than guessing. This prevents accidental publishes from feature branches.

If you want a workflow that runs on every branch (e.g., for CI plan output), keep `bumpy ci plan` outside the channel guard — `plan` is read-only.

---

## Counter behavior

The `-rc.N` counter is derived from the **registry**, never from committed state:

- If no `1.2.0-rc.*` has ever been published for a package, the next version is `1.2.0-rc.0`.
- If `1.2.0-rc.3` is the highest published, the next is `1.2.0-rc.4` — regardless of what any branch looks like.
- If a new bump file raises the _target_ (e.g., a `major` lands when the cycle was targeting a minor), the target moves to `2.0.0` and the counter naturally restarts at `2.0.0-rc.0` (nothing published there yet). Previously-shipped files in `.bumpy/next/` carry forward and consolidate at the new target on promotion.
- Abandoned cycles, force-resets, and re-runs can't cause version collisions — the registry floor always counts above anything already published.

Counters are per-package. A package that joins the cycle late starts at its own `.0` while earlier members are at `.3`; from then on, lockstep republishing keeps them moving together.

This avoids the changesets [#381](https://github.com/changesets/changesets/issues/381) problem (counters requiring committed state) by construction rather than by careful bookkeeping.

---

## Configuration reference

```jsonc
{
  "channels": {
    "<name>": {
      "branch": "next", // required — branch that triggers this channel
      "preid": "rc", // version suffix, e.g. -rc.0
      "tag": "next", // npm dist-tag for publish
      "versionPr": {
        // optional — override the channel's release PR
        "title": "🐸 Versioned prerelease (next)",
        "branch": "bumpy/version-packages-next",
        "automerge": false, // true = enable auto-merge on the release PR
      },
    },
  },
}
```

Defaults applied when a field is omitted:

- `preid` — defaults to the channel name (e.g., `next` → `1.2.0-next.0`).
- `tag` — defaults to the channel name (so `@next`).
- `versionPr.title` — defaults to `<base-title> (<channel>): <computed versions>` — the versions in the title are advisory narrative; the registry wins at publish time.
- `versionPr.branch` — defaults to `<base-branch>-<channel>` (e.g., `bumpy/version-packages-next`).
- `versionPr.automerge` — defaults to `false`.

The directory used to hold shipped bump files matches the channel name: `.bumpy/<name>/`. Channel names that would collide with reserved `.bumpy/` entries (anything starting with `_`, `README.md`) are rejected.

> `preid` is optional in the schema (not just defaulted) to leave room for future **stable channels** — maintenance branches like `1.x` that publish stable versions to a non-`latest` dist-tag ([changesets#1235](https://github.com/changesets/changesets/discussions/1235)). Not part of the initial feature, but the config shape won't need a breaking change to add it.

---

## Comparison with changesets pre mode

|                                    | changesets pre mode                                                                                                                                | bumpy channels                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Entering                           | `changeset pre enter beta` writes `.changeset/pre.json`                                                                                            | Push to the channel branch                                                                                                     |
| Exiting                            | `changeset pre exit` + `version` + `publish` + delete `pre.json`                                                                                   | Merge channel branch → main; the ordinary stable flow consumes the cycle                                                       |
| State file                         | `.changeset/pre.json` committed to repo                                                                                                            | None — bump file location in `.bumpy/` is the only state                                                                       |
| Prerelease versions in git         | Committed to every `package.json` on every prerelease                                                                                              | Never — registry and tags only; `package.json` stays at the last stable version                                                |
| Wrong-branch hazard                | Merging while pre mode is active accidentally turns stable releases into prereleases ([#239](https://github.com/changesets/changesets/issues/239)) | Impossible — channel state lives in the branch and the file layout, not in a global mode                                       |
| Dist-tag control                   | Locked to mode tag, `--tag` is rejected ([#786](https://github.com/changesets/changesets/issues/786))                                              | Per-channel `tag` config, independent of suffix                                                                                |
| Dependent force-bumping            | Cascades to **major** on peer deps by default ([#960](https://github.com/changesets/changesets/issues/960))                                        | Cascades at **proportional levels**; full cycle republishes each rc with exact-pinned inter-cycle deps — always a coherent set |
| Counter                            | Requires committed `package.json` increments ([#381](https://github.com/changesets/changesets/issues/381))                                         | Derived from the registry (max published + 1); immune to resets and abandoned cycles                                           |
| Exit re-bumps everything           | Yes ([#729](https://github.com/changesets/changesets/issues/729))                                                                                  | No — promotion is an ordinary stable bump; there's no suffix to strip because none was committed                               |
| First publish during pre mode      | Silently goes to `@latest`                                                                                                                         | Always goes to channel's dist-tag                                                                                              |
| Stable changelog after prereleases | Lossy — only the `pre exit` step's diff                                                                                                            | Lossless — consolidated entry built from every bump file in the cycle                                                          |

---

## What's not (yet) supported

These are intentionally out of scope for the initial channel feature. If any of these is a blocker for you, please open an issue.

- **Ephemeral / preview / canary releases** — use [pkg.pr.new](https://pkg.pr.new) instead. It owns short-lived publishing (per-PR, per-commit, per-branch); bumpy channels are deliberately scoped to managed long-running release lines. See [When to use channels — and when not to](#when-to-use-channels--and-when-not-to) above.
- **Workflow-dispatch one-off prereleases** — planned. The no-commit architecture makes this nearly free: a one-off is the same compute-and-publish step run from any SHA with an explicit preid and dist-tag, no branch state required. It will likely follow shortly after channels.
- **Stable (maintenance) channels** — long-lived branches like `1.x` publishing stable versions to a non-`latest` dist-tag. Future work; the config schema already leaves room (see note above).
- **Prerelease changelog in the published tarball** — injecting the rendered cycle changelog into prerelease artifacts at publish time (derived content goes in the artifact, never in git). Possible later nice-to-have.
- **Per-bump-file channel routing** — declaring `channel: beta` inside a bump file's frontmatter. Not planned; channels stay branch-derived to keep the mental model simple.
