# Snapshots & PR previews

A **snapshot** (or preview) is a throwaway, one-off publish of a single PR or commit — "what the next version would be, published right now" — so reviewers can install and test a change before it merges. Unlike [prerelease channels](./prereleases.md), there's no dedicated branch and no committed state: snapshots leave no trace in git.

Bumpy supports two tools here, depending on where your packages live:

- **Public packages** → [pkg.pr.new](#pkgprnew-public-packages) — a zero-setup external service that publishes previews to its own storage.
- **Private packages** → [`bumpy publish --snapshot`](#snapshot-releases) — publishes a transient preview to the private registry you already use.

> **"Private" here means a package you publish to a private registry** — a scoped package with [`access: "restricted"`](./configuration.md#publishing-config) and/or a per-package [`registry`](./configuration.md#per-package-config), installed by your team with normal `npm install`. It does **not** mean a package marked `"private": true` in `package.json` — that's npm's "never publish" flag, which `npm publish` refuses by design, so bumpy skips those everywhere ([details](#publishing-to-a-private-registry)).

> Looking for a long-lived `next` / `beta` / `rc` release line instead of a one-off preview? That's a [prerelease channel](./prereleases.md), not a snapshot.

## pkg.pr.new (public packages)

For **public** packages, [pkg.pr.new](https://pkg.pr.new) is the zero-setup way to publish a throwaway preview from any PR or commit. It publishes to its own storage (not npm) and comments install URLs on the PR, so reviewers can `npm i https://pkg.pr.new/your-pkg@<sha>` without you managing versions or dist-tags. Bumpy doesn't run it — it's an independent tool that pairs alongside your bumpy release workflow.

Two setup steps:

**1. Install the GitHub App** — [github.com/apps/pkg-pr-new](https://github.com/apps/pkg-pr-new), on the repo you want previews for. This is the easy-to-miss step: publishing fails without it.

**2. Add a workflow** that builds your packages and runs `pkg-pr-new publish` once:

```yaml
# .github/workflows/preview.yml
name: Preview release
on: [push, pull_request]

permissions: {}

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build
      # Run this exactly once per workflow — it's how pkg.pr.new avoids spam.
      - run: npx pkg-pr-new publish './packages/*'
```

It auto-comments the install URLs on the PR; no token wiring needed beyond the App. Because its storage is ephemeral, it's fine to run on **every** commit (unlike private snapshots, which you typically label-gate so a real registry doesn't fill up). For monorepos, pass explicit paths or a glob (`'./packages/*'`); for compact install URLs your package needs a valid `repository` field in `package.json`. See the [pkg.pr.new docs](https://github.com/stackblitz-labs/pkg.pr.new) for the full set of flags (`--compact`, `--comment`, `--template`, …).

> pkg.pr.new can't serve **private** packages — it publishes to public storage. For those, use [snapshot releases](#snapshot-releases) below, which publish to the private registry you already use.

## Snapshot releases

A **snapshot** is a throwaway, one-off publish of your pending release — "what the next version would be, published right now" — under a non-`latest` dist-tag. Unlike channels, it needs no dedicated branch and leaves no trace in git: no bump files consumed, no changelog, no commit, no git tag, no GitHub release. It's the private-registry counterpart to [pkg.pr.new](#pkgprnew-public-packages).

```sh
bumpy publish --snapshot pr-123
```

This computes the pending release plan, derives a unique prerelease version per package, writes those versions into the working tree, publishes them to the `@pr-123` dist-tag, and restores the working tree. Install with `npm i your-pkg@pr-123` — the tag always points at the newest snapshot for that name.

A snapshot **requires pending bump files** — it previews exactly the release you've planned, so with nothing to release it's a no-op. (This is the main difference from pkg.pr.new, which snapshots any commit regardless of intent.)

### Version format

The snapshot name is both the version preid and the default dist-tag. Consumers always install via the tag (`npm i your-pkg@pr-123`), so the exact version string is mostly an implementation detail — `snapshot.versionStrategy` just controls how re-runs behave:

| Strategy        | Version                       | Notes                                                                           |
| --------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| `sha` (default) | `1.4.0-pr-123-a1b2c3d`        | Short git SHA. **Idempotent per commit** — re-running on the same commit skips. |
| `timestamp`     | `1.4.0-pr-123-20260623123456` | UTC timestamp. Always unique; never idempotent.                                 |

```jsonc
// .bumpy/_config.json
{
  "snapshot": { "versionStrategy": "sha" },
}
```

In-cycle internal dependencies are exact-pinned (just like channels), so a set of snapshot packages always installs as a coherent group. Override the dist-tag independently with `--tag`:

```sh
bumpy publish --snapshot sha-a1b2c3d --tag pr-123   # version preid "sha-a1b2c3d", dist-tag "@pr-123"
```

### In CI

`bumpy ci release --snapshot <name>` runs the whole thing and, on a PR, posts/updates a comment with the published versions and install instructions. There's no `ci plan` / `ci release` split — snapshots are a single self-contained step that can run from any branch.

```yaml
# .github/workflows/snapshot.yml
on:
  pull_request:
    types: [opened, synchronize, labeled]

jobs:
  snapshot:
    # Opt-in per PR via a label so you don't fill the registry with every PR's builds
    if: contains(github.event.pull_request.labels.*.name, 'snapshot')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: ./.github/actions/setup # your registry auth (.npmrc / NPM_TOKEN)
      - run: bunx bumpy ci release --snapshot pr-${{ github.event.pull_request.number }}
        env:
          NPM_TOKEN: ${{ secrets.PRIVATE_REGISTRY_TOKEN }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} # for the PR comment
```

Label-gating is the recommended default: pkg.pr.new can fire on every commit because its storage expires, but a real registry keeps every snapshot version until a retention policy prunes it. Trigger on whatever event you like — it's just a CLI command.

> **Forks.** PRs from forks running on `pull_request` get a read-only token and no secrets, so they can't publish or comment. This is usually fine for private packages (contributors are internal); if you need fork snapshots, the same constraints (and `pull_request_target` caveats) apply as for [the check comment](./github-actions.md).

### What a snapshot does and doesn't do

| Does                                                   | Doesn't                             |
| ------------------------------------------------------ | ----------------------------------- |
| Compute the release plan from pending bump files       | Consume, move, or delete bump files |
| Derive a unique prerelease version per package         | Write changelogs                    |
| Exact-pin in-cycle internal dependencies               | Create a version PR                 |
| Publish to a non-`latest` dist-tag (default: the name) | Create git tags or GitHub releases  |
| Restore the working tree afterward                     | Commit anything                     |

Snapshots and channels are mutually exclusive on a single command (`--snapshot` + `--channel` is an error) — they're distinct release models.

## Publishing to a private registry

Snapshots — and normal `bumpy publish` — work with private registries out of the box; there's no separate "private" mode. The setup is the standard npm one:

- **Scope + restricted access.** Name the package under your org scope and set [`access: "restricted"`](./configuration.md#publishing-config) (globally, or per-package). That's npm's mechanism for "published, but not public."
- **Point at the registry.** Use the per-package [`registry`](./configuration.md#per-package-config) option, or npm's native `publishConfig.registry` / `.npmrc` (which npm honors automatically). Auth works exactly as for public packages — `NPM_TOKEN`, OIDC, or a pre-configured `.npmrc`.
- **Don't set `"private": true`.** That field is npm's _refuse-to-publish_ marker — `npm publish` errors on it and `--access` can't override it. bumpy mirrors that: a `"private": true` package is never published by any flow (snapshot, channel, or stable). It can still be versioned and git-tagged if you opt in via [`privatePackages`](./configuration.md#private-packages-and-private-registries), but it won't be sent to a registry. Reserve `"private": true` for things you truly never publish (apps, internal tooling); use `access: "restricted"` for "private but published."

```jsonc
// package.json — a package published privately (NOT "private": true)
{
  "name": "@acme/widgets",
  "version": "1.4.0",
  "publishConfig": { "registry": "https://npm.acme.internal" },
}
```

```jsonc
// .bumpy/_config.json
{ "access": "restricted" }
```

With that, `bumpy publish --snapshot pr-123` publishes `@acme/widgets@1.4.0-pr-123-<sha>` to `https://npm.acme.internal` under the `@pr-123` dist-tag, and your team installs it with `npm i @acme/widgets@pr-123`.
