# Prerelease Channels

> ⚠️ **Proposed design — not yet implemented.** This document describes the planned prerelease feature. Feedback welcome before we build it.

Prerelease versioning lets you ship `1.2.0-rc.0`, `1.2.0-beta.1`, etc. before the stable `1.2.0` — for early adopters, integration testing, or staging risky changes.

Bumpy's model is **branch-based**: you nominate one or more long-lived branches (e.g. `next`, `beta`) in your config as prerelease channels. CI runs the same release workflow on those branches as it does on `main` — only the version suffix and dist-tag change. When you're ready to ship stable, you merge the channel branch into `main` and bumpy automatically strips the suffix.

No `pre enter` / `pre exit` commands. No mode files in your repo. No hidden state that can poison unrelated merges.

> If you're coming from changesets, see [Comparison with changesets pre mode](#comparison-with-changesets-pre-mode) at the bottom for a side-by-side.

## When to use channels — and when not to

Channels are designed for **long-lived release lines** — an ongoing `next` / `beta` / `rc` cycle that accumulates changes over days or weeks before promotion to stable. They carry per-cycle state in your branch and your `.bumpy/<channel>/` directory, and they're worth setting up when you expect to ship multiple prereleases through the same cycle.

**For per-PR preview releases, use [pkg.pr.new](https://pkg.pr.new) instead.**

pkg.pr.new publishes an ephemeral package from any open PR, gives you an install URL pinned to the PR's commit, and disappears when the PR closes. It's purpose-built for "let me try this PR before merging" workflows — no version planning, no branch discipline, no consumed bump files. Bumpy channels would be the wrong tool for that job: you'd be polluting your channel branch with throwaway state for every PR.

Rough rule of thumb:

| You want…                                                 | Use                                   |
| --------------------------------------------------------- | ------------------------------------- |
| Preview a single PR for review                            | [pkg.pr.new](https://pkg.pr.new)      |
| Ship a `1.2.0-rc.N` line for weeks of integration testing | Bumpy channels (this doc)             |
| One-off canary from `main`                                | (Planned: `bumpy publish --snapshot`) |

---

## Mental model

```
                 ┌─────────────────────────────────────────────┐
                 │                                             │
  feature PR ───►│  next branch  ──► 1.2.0-rc.0 ──► 1.2.0-rc.1 │ ── merge ──►
  feature PR ───►│                                             │            │
  feature PR ───►│                                             │            │
                 └─────────────────────────────────────────────┘            │
                                                                            ▼
                                                              ┌──────────────────────┐
                                                              │  main branch         │
                                                              │  ──► 1.2.0           │
                                                              └──────────────────────┘
```

- **Branch = channel.** The `next` branch is the `next` channel. Pushing to it produces prerelease versions on the `@next` dist-tag.
- **Same flow as main.** Feature PRs land bump files. A "🐸 Versioned release (next)" PR accumulates the planned bump. Merging it triggers a prerelease publish.
- **Promotion is a merge.** `next` → `main` carries the prerelease versions and accumulated bump files forward; bumpy strips the suffix on main, consumes the bump files, and publishes stable.

---

## How shipped vs pending bump files are tracked

A bump file's location tells you where it stands in the release lifecycle:

```
.bumpy/
├── _config.json
├── README.md
├── feature-y.md            ← pending — will trigger the next prerelease
├── another-feature.md      ← pending
└── next/                   ← shipped on the "next" channel
    ├── feature-x.md
    └── earlier-fix.md
```

- **`.bumpy/*.md`** — pending. Has not yet been included in any release.
- **`.bumpy/<channel>/*.md`** — shipped on `<channel>`, awaiting promotion to stable. The bump file itself is not modified; only its location changes.

On promotion (merge to main + main's version PR), files in both root and channel subdirs are consumed into a single consolidated stable changelog entry, then deleted.

This means at any time you can `ls .bumpy/` to see exactly what's pending vs shipped. No frontmatter flags, no committed mode files, no `git tag` archaeology.

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

### Versioning a prerelease

When a feature PR merges to `next`:

1. `bumpy ci release` runs on the `next` push.
2. It sees a bump file at `.bumpy/feature-x.md` (pending — not yet in `.bumpy/next/`) and creates (or updates) a **"🐸 Versioned release (next)"** PR — targeting `next`, on the branch `bumpy/version-packages-next`.
3. The PR's diff includes:
   - `package.json` versions bumped with the `-rc.N` suffix
   - `.bumpy/feature-x.md` **moved** to `.bumpy/next/feature-x.md`

When a maintainer merges that PR:

4. `bumpy ci release` runs again on `next`, detects no pending bump files (everything is in `.bumpy/next/`), sees unpublished packages at `1.2.0-rc.0`, and publishes them to the `@next` dist-tag.
5. Git tags `v1.2.0-rc.0` are pushed; a GitHub release is created (marked as prerelease) with notes drawn from the bump files that _just moved_ into `.bumpy/next/`.

```bash
# A consumer testing the prerelease:
npm install my-package@next       # gets 1.2.0-rc.0
```

### A second prerelease

When a new feature lands on `next`:

- The new bump file appears at `.bumpy/feature-y.md` (root). Previously-shipped `.bumpy/next/feature-x.md` stays put.
- `bumpy ci release` sees the pending file → opens the version PR.
- The PR bumps `1.2.0-rc.0` → `1.2.0-rc.1`, moves `feature-y.md` into `.bumpy/next/`.
- Merge → publish → GitHub release for `1.2.0-rc.1` includes only `feature-y.md` (the just-moved file).

### Promotion to stable

When the prerelease has been tested and you're ready to ship the real `1.2.0`:

1. **Merge `next` → `main`** (regular PR — review it like any other).
2. `main` now has package.json versions like `1.2.0-rc.5` _and_ all the accumulated bump files in `.bumpy/next/`.
3. `bumpy ci release` runs on `main`. It sees:
   - Prerelease versions in `package.json`
   - Bump files in `.bumpy/next/` (from the channel)
   - No pending files at `.bumpy/` root
4. It opens a **"🐸 Versioned release"** PR that:
   - Strips the prerelease suffix (`1.2.0-rc.5` → `1.2.0`)
   - Consumes **all** bump files from `.bumpy/next/`
   - Writes a single consolidated `## 1.2.0` entry to `CHANGELOG.md` with every change from the cycle
   - Deletes `.bumpy/next/` (and any pending files at root, if any)
5. Merge that PR → bumpy publishes `1.2.0` to `@latest`, tags `v1.2.0`, and creates a stable GitHub release.

> The final stable `CHANGELOG.md` entry includes every change from the prerelease cycle — consumers of `@latest` see the full picture, not just the `rc.5 → 1.2.0` step. Individual rc release notes remain available on the GitHub releases page.

### Continuing after promotion

After promotion, `next` is empty (no pending files, no `.bumpy/next/` subdir). You can either:

- **Reset and reuse it.** `git reset --hard main && git push --force-with-lease`. The next feature PR targeting `next` starts a new cycle (`1.3.0-rc.0`, etc.).
- **Delete and recreate later.** If your team only opens a prerelease cycle occasionally, delete the branch and recreate it when you need the next one.

Either is supported — the channel config doesn't require the branch to exist between cycles.

### Abandoning a prerelease cycle

Sometimes a prerelease cycle gets shelved without ever shipping stable. To reset:

- Delete `.bumpy/next/` in a PR to `next`, optionally also resetting package.json versions back to their pre-cycle state.
- Or simply force-reset the branch to a known-good commit.

There is no `bumpy channel reset` command — the state lives in your branch, so plain git commands handle it.

---

## Hotfixes during a prerelease

Patches can flow to `main` independently while a prerelease is in flight on `next`:

```
  main:  1.1.0 ──► 1.1.1 (hotfix)
                            ╲
  next:   1.2.0-rc.0 ──► 1.2.0-rc.1 (after rebasing main into next)
```

After the hotfix lands on `main`, rebase or merge `main` → `next` to pick it up. The next prerelease version will reflect the combined state.

> If `main` ships a bump that's higher than the prerelease's current target (e.g., `main` ships `1.2.0`, prerelease was targeting `1.2.0-rc.x`), bumpy automatically retargets the prerelease at `1.3.0-rc.0` on the next merge — the prerelease never accidentally publishes a version lower than what's already on `@latest`.

---

## Dependency handling in prerelease channels

Bumpy never automatically cascades a prerelease through your dependency graph. You decide which packages belong in each cycle through explicit declarations — bump files, `linked` / `fixed` groups, or `cascadeTo` rules. Whatever ends up in the cycle is then exact-pinned together.

### The exact-pin rule

Within a prerelease cycle, any inter-cycle dependency is **exact-pinned** at publish time:

> If `@org/plugin@1.1.0-rc.0` is in the same cycle as `@org/core@2.0.0-rc.0`, the published `@org/plugin@1.1.0-rc.0` has `"@org/core": "2.0.0-rc.0"` — not `"^2.0.0-rc.0"`.

This guarantees that any package from the cycle, installed via `@next`, works with the other packages it was published against. Channel-internal consistency is built into the artifact, not relied on at install time.

Dependencies pointing **outside** the cycle keep their stable ranges. Their existing `@latest` install continues to work; nothing in their published `package.json` points at a prerelease.

### `workspace:` protocol resolution

`workspace:^` / `workspace:*` on an in-cycle dep resolves to the exact prerelease version. On an out-of-cycle dep, it resolves normally (the stable range bumpy would produce on `main`).

### Why no automatic cascade

Changesets force-bumps every dependent whose range gets broken by a prerelease — including dependents that didn't otherwise need to change. This is the source of many of its prerelease pain points ([#960](https://github.com/changesets/changesets/issues/960), [#1228](https://github.com/changesets/changesets/issues/1228), [#1287](https://github.com/changesets/changesets/issues/1287)).

Bumpy already takes the "explicit propagation" stance for stable releases (`updateInternalDependencies: "out-of-range"` is the default). Channels apply the same principle: bumpy does what you asked it to do, nothing more. The trade-off — that you can ship a stranded prerelease if you forget to coordinate — is addressed by the next section.

---

## Coordinating multi-package prereleases

If you prerelease an upstream package without bringing its dependents along, those dependents won't be able to consume the prerelease.

Concrete failure mode:

- `@org/core@1.0.0` and `@org/plugin@1.0.0` (both on `@latest`)
- `@org/plugin`'s package.json: `"@org/core": "^1.0.0"`
- You author one bump file: `@org/core` → major
- Cycle ships `@org/core@2.0.0-rc.0` to `@next`. `@org/plugin` stays at `1.0.0`.

A tester running `npm install @org/core@next @org/plugin` hits a peer dep mismatch (or npm hoists two copies of core). The prerelease is "stranded" — usable on its own but not in combination with the rest of the ecosystem.

To make the prerelease usable, declare the relationship so `@org/plugin` joins the cycle. Pick whichever fits your situation:

| Declaration                                     | When to use                                             |
| ----------------------------------------------- | ------------------------------------------------------- |
| **Multi-package bump file**                     | Ad-hoc — this specific PR ships both packages together  |
| **`linked` group** in config                    | Two packages should always share the highest bump level |
| **`fixed` group** in config                     | Two packages should always share an exact version       |
| **`cascadeTo: ["@org/plugin"]`** on `@org/core` | Any change to core should always bump plugin            |

If you genuinely want a stranded prerelease (the package has no in-monorepo dependents that need it), no declaration is needed — bumpy will ship it as written.

> See [docs/version-propagation.md](./version-propagation.md) for the full propagation model and how `linked` / `fixed` / `cascadeTo` interact.

---

## CLI behavior on a channel branch

The commands behave the same as on `main`, with channel-derived suffixes and tags:

| Command            | On `main`                                | On `next` (channel branch)                                |
| ------------------ | ---------------------------------------- | --------------------------------------------------------- |
| `bumpy status`     | shows planned stable versions            | shows planned `-rc.N` versions (pending files only)       |
| `bumpy version`    | bumps to stable, consumes all bump files | bumps to `-rc.N`, moves pending files into `.bumpy/next/` |
| `bumpy publish`    | publishes to `@latest`                   | publishes to `@next`                                      |
| `bumpy ci release` | version-PR / publish on main             | version-PR / publish on `next`                            |
| `bumpy ci check`   | (PR-level, unchanged)                    | (PR-level, unchanged)                                     |
| `bumpy check`      | compares to `baseBranch`                 | compares to the channel branch                            |

You can override the inferred channel with `--channel <name>` for local testing:

```bash
bumpy status --channel next        # preview what next would publish
bumpy version --channel next       # locally bump to -rc.N and move pending files
```

The override is mainly for debugging; CI should rely on branch detection.

---

## What if no channel matches?

If `bumpy ci release` runs on a branch that isn't `baseBranch` and isn't in `channels`, it exits with a clear error rather than guessing. This prevents accidental publishes from feature branches.

If you want a workflow that runs on every branch (e.g., for CI plan output), keep `bumpy ci plan` outside the channel guard — `plan` is read-only.

---

## Counter behavior

The `-rc.N` counter is computed from the workspace's current state, not from cumulative metadata:

- If no package is currently on a prerelease, the next version is `<next-stable>-rc.0`.
- If a package is at `1.2.0-rc.3` and a new pending bump file lands, the next version is `1.2.0-rc.4`.
- If a new pending bump file would raise the _target_ (e.g., a `major` lands when current target was `minor`), the counter resets: `1.2.0-rc.3` → `2.0.0-rc.0`. Previously-shipped files in `.bumpy/next/` carry forward — they'll consolidate at the new target on promotion.

This matches user intuition (the counter resets when the underlying target moves) and avoids the changesets [#381](https://github.com/changesets/changesets/issues/381) problem where prerelease counters require committed state to function.

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
        // optional — override the channel's version PR
        "title": "🐸 Versioned prerelease (next)",
        "branch": "bumpy/version-packages-next",
      },
    },
  },
}
```

Defaults applied when a field is omitted:

- `preid` — defaults to the channel name (e.g., `next` → `1.2.0-next.0`).
- `tag` — defaults to the channel name (so `@next`).
- `versionPr.title` — defaults to `<base-title> (<channel>)`.
- `versionPr.branch` — defaults to `<base-branch>-<channel>` (e.g., `bumpy/version-packages-next`).

The directory used to hold shipped bump files matches the channel name: `.bumpy/<name>/`.

---

## Comparison with changesets pre mode

|                                    | changesets pre mode                                                                                                                                | bumpy channels                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Entering                           | `changeset pre enter beta` writes `.changeset/pre.json`                                                                                            | Push to the channel branch                                                                                                               |
| Exiting                            | `changeset pre exit` + `version` + `publish` + delete `pre.json`                                                                                   | Merge channel branch → main; bumpy strips suffix and consolidates                                                                        |
| State file                         | `.changeset/pre.json` committed to repo                                                                                                            | None — file location in `.bumpy/` is the state                                                                                           |
| Wrong-branch hazard                | Merging while pre mode is active accidentally turns stable releases into prereleases ([#239](https://github.com/changesets/changesets/issues/239)) | Impossible — channel state lives in the branch and the file layout, not in a global mode                                                 |
| Dist-tag control                   | Locked to mode tag, `--tag` is rejected ([#786](https://github.com/changesets/changesets/issues/786))                                              | Per-channel `tag` config, independent of suffix                                                                                          |
| Dependent force-bumping            | Always on, can't be disabled ([#960](https://github.com/changesets/changesets/issues/960))                                                         | Never automatic — cycle membership is declared (bump files, `linked`/`fixed`, `cascadeTo`); inter-cycle deps are exact-pinned at publish |
| Counter                            | Requires committed `package.json` increments ([#381](https://github.com/changesets/changesets/issues/381))                                         | Derived from current state; resets cleanly when target moves                                                                             |
| Exit re-bumps everything           | Yes ([#729](https://github.com/changesets/changesets/issues/729))                                                                                  | No — promotion strips suffixes and consumes pre-shipped bump files into one consolidated entry                                           |
| First publish during pre mode      | Silently goes to `@latest`                                                                                                                         | Always goes to channel's dist-tag                                                                                                        |
| Stable changelog after prereleases | Lossy — only the `pre exit` step's diff                                                                                                            | Lossless — consolidated entry built from every bump file in the cycle                                                                    |

---

## What's not (yet) supported

These are intentionally out of scope for the initial channel feature. If any of these is a blocker for you, please open an issue.

- **Per-PR preview releases** — use [pkg.pr.new](https://pkg.pr.new) instead. It's purpose-built for ephemeral per-PR packages and pairs well with bumpy. See [When to use channels — and when not to](#when-to-use-channels--and-when-not-to) above.
- **One-off snapshot publishes from `main`** (`0.0.0-snapshot-<sha>`) — planned as a separate `bumpy publish --snapshot` flag, not via channels.
- **Workflow-dispatch one-off prereleases** — planned as a complement to channels, for teams that want occasional prereleases without a dedicated branch.
- **Per-bump-file channel routing** — declaring `channel: beta` inside a bump file's frontmatter. Not planned; channels stay branch-derived to keep the mental model simple.
