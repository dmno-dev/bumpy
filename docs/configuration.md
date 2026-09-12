# Configuration Reference

Bumpy is configured via `.bumpy/_config.json`, created by `bumpy init`. Per-package config can also be set in each `package.json` under the `"bumpy"` key.

> **Tip:** The config file supports JSONC — you can use `//` line comments, `/* */` block comments, and trailing commas.

## Global config (`.bumpy/_config.json`)

| Option                       | Type                                   | Default                          | Description                                                                                            |
| ---------------------------- | -------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `baseBranch`                 | `string`                               | `"main"`                         | Branch used for release comparisons                                                                    |
| `access`                     | `"public" \| "restricted"`             | `"public"`                       | Default npm publish access level                                                                       |
| `changelog`                  | `false \| string \| [string, options]` | `"default"`                      | Changelog formatter — `"default"`, `"github"`, path to a custom formatter, or `false` to disable       |
| `fixed`                      | `string[][]`                           | `[]`                             | Package groups that always bump together to the same version                                           |
| `linked`                     | `string[][]`                           | `[]`                             | Package groups that share the highest bump level                                                       |
| `ignore`                     | `string[]`                             | `[]`                             | Package name globs to exclude from versioning                                                          |
| `include`                    | `string[]`                             | `[]`                             | Package name globs to explicitly include (overrides `ignore` and `privatePackages`)                    |
| `privatePackages`            | `{ version, tag }`                     | `{ version: false, tag: false }` | Whether to version and/or create git tags for `"private": true` packages (never published — see below) |
| `updateInternalDependencies` | `"patch" \| "minor" \| "out-of-range"` | `"out-of-range"`                 | When to update internal dependency version ranges                                                      |
| `dependencyBumpRules`        | `object`                               | see below                        | Controls how bumps propagate through dependency types                                                  |
| `versionCommitMessage`       | `string`                               | —                                | Customize the version commit message (see below)                                                       |
| `changedFilePatterns`        | `string[]`                             | `["**"]`                         | Glob patterns to filter which changed files count toward marking a package as changed                  |
| `ignoredPackageJsonFields`   | `string[]`                             | `["devDependencies"]`            | `package.json` fields whose change alone doesn't require a bump file (see below)                       |
| `publish`                    | `object`                               | see below                        | Publishing pipeline config (npm target defaults)                                                       |
| `targets`                    | `object`                               | `{}`                             | Named, reusable publish target instances (see [Publish targets](#publish-targets))                     |
| `gitUser`                    | `{ name, email }`                      | bumpy-bot                        | Git identity for CI commits                                                                            |
| `versionPr`                  | `{ title, branch, preamble }`          | see below                        | Customize the version PR                                                                               |
| `allowCustomCommands`        | `boolean \| string[]`                  | `false`                          | Allow a package's `package.json` to define a `buildCommand` / inline publish targets (see below)       |
| `packages`                   | `object`                               | `{}`                             | Per-package config overrides (keyed by package name)                                                   |
| `channels`                   | `object`                               | `{}`                             | Prerelease channels, keyed by channel name (see below)                                                 |
| `snapshot`                   | `{ versionStrategy }`                  | `{ versionStrategy: "sha" }`     | Snapshot release settings — how snapshot versions are made unique (see below)                          |

### Private packages and private registries

These are two different things, and bumpy treats them differently:

- **Publishing to a private registry** (scoped package + `access: "restricted"` and/or a `registry`, _without_ `"private": true`) works like any other publish — bumpy versions, publishes, tags, and snapshots them normally. This is the recommended setup for private/internal packages. See [Publishing to a private registry](snapshots.md#publishing-to-a-private-registry).
- **`"private": true` in `package.json`** is npm's "never publish" marker (`npm publish` refuses it). bumpy never publishes these to npm. `privatePackages` controls whether they're _versioned_ (`version`) and _git-tagged_ (`tag`) by default. Use this for apps and internal tooling you want bumpy to bump but never ship to a registry. A private package that declares [`publishTargets`](#publish-targets) (a marketplace extension, a PyPI stub, a CLI shipped as release assets) is always versioned and published to those targets — `"private": true` just keeps it off npm.

### Change detection and `package.json` fields

A package is "changed" (and so needs a bump file) when a changed file inside it matches `changedFilePatterns`. `package.json` is a special case: editing it shouldn't always demand a release — a `devDependencies` bump from Dependabot, for example, doesn't affect what consumers install.

So when `package.json` is the **only** changed file in a package, bumpy diffs it against the base branch and only flags the package if a field **outside** `ignoredPackageJsonFields` changed. The default ignore list is `["devDependencies"]`, meaning dev-only dependency updates don't require a bump file. Every other field — `dependencies`, `exports`, `bin`, `files`, `description`, `scripts`, etc. — still counts.

One exception keeps this safe: a changed `devDependencies` entry that matches the package's [`releaseTriggeringDevDeps`](#release-triggering-devdependencies) **does** flag the package, since such a dep affects the published output.

To relax additional fields (e.g. treat `scripts` changes as non-releasing too), extend the list:

```json
{
  "ignoredPackageJsonFields": ["devDependencies", "scripts"]
}
```

bumpy errs toward requiring a bump file whenever it can't compare cleanly — a brand-new `package.json`, or one it can't parse.

### Dependency bump rules

Controls how a version bump in one package propagates to packages that depend on it. Set globally in `dependencyBumpRules` or per-package.

Each rule has:

- `trigger` — minimum bump level that triggers propagation (`major`, `minor`, or `patch`)
- `bumpAs` — what level to bump the dependent (`major`, `minor`, `patch`, or `match` to mirror the triggering level)

Set a dependency type to `false` to disable propagation entirely.

**Defaults:**

| Dependency type        | Trigger | Bump as  |
| ---------------------- | ------- | -------- |
| `dependencies`         | `patch` | `patch`  |
| `peerDependencies`     | `major` | `match`  |
| `devDependencies`      | —       | disabled |
| `optionalDependencies` | `minor` | `patch`  |

See [version-propagation.md](version-propagation.md) for the full propagation algorithm.

### Version commit message

Customize the commit message used when versioning — both by `bumpy version --commit` and CI commands. Omit to use the default ("Version packages" + list of releases).

- `"My release"` — static commit message string
- `"./scripts/commit-msg.ts"` — path to a module (starts with `./` or `../`) that exports a function receiving the release plan and returning a message string

To auto-commit locally, pass the `--commit` flag: `bumpy version --commit`. CI commands always commit and push automatically.

### Publishing config

The `publish` object controls how packages are packed and published:

| Option               | Type                   | Default  | Description                                                           |
| -------------------- | ---------------------- | -------- | --------------------------------------------------------------------- |
| `packManager`        | `string`               | `"auto"` | Which package manager packs tarballs (`"auto"` detects from lockfile) |
| `publishManager`     | `string`               | `"npm"`  | Which tool runs `publish` (npm supports OIDC/provenance)              |
| `publishArgs`        | `string[]`             | `[]`     | Extra args passed to the publish command                              |
| `protocolResolution` | `"pack" \| "in-place"` | `"pack"` | How `workspace:` and `catalog:` protocols are resolved                |
| `provenance`         | `boolean`              | `false`  | Attach provenance attestation via npm (requires OIDC CI environment)  |
| `npmStaged`          | `boolean`              | `false`  | Use `npm stage publish` — requires 2FA approval on npmjs.com          |

#### Staged publishing

When `npmStaged` is enabled, bumpy uses `npm stage publish` instead of `npm publish`. This stages packages on npmjs.com, where they must be manually approved with 2FA before going live. This adds an extra security gate to your release process — even if CI credentials are compromised, packages can't be published without maintainer approval.

A staged publish is recorded as `staged` (🟡) in the draft GitHub release rather than as published, and the draft stays a draft — no dead npmjs.com link, no premature `release: published` event. Once the version is approved, the next `bumpy publish` run sees it live on the registry, records the success and finalizes the release. Snapshots are never staged (they must be installable immediately). The git tag is created at staging time — the staged artifact is already locked to that commit.

Requirements:

- `publishManager` must be `"npm"` (the default)
- npm >= 11.15.0
- The package must already exist on the npm registry (first publish cannot be staged)

```json
{
  "publish": {
    "provenance": true,
    "npmStaged": true
  }
}
```

### Publish targets

A package can publish to any number of **targets** — npm is just the default one. Each target is an instance of a target type; the built-in types are:

| Type                    | Publishes via                       | Auth                              | Notes                                                                   |
| ----------------------- | ----------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `npm`                   | `npm publish` (or configured PM)    | OIDC / `NPM_TOKEN` / `.npmrc`     | Supports dist-tags, prereleases, snapshots, staged publishes            |
| `jsr`                   | `npx jsr publish`                   | OIDC (linked GitHub repo)         | Requires a `jsr.json`; no dist-tags, so no snapshots                    |
| `pypi`                  | `uv build` + `uv publish`           | OIDC / `UV_PUBLISH_TOKEN`         | Requires a `pyproject.toml`; stable versions only                       |
| `vscode-marketplace`    | `vsce publish --packagePath <vsix>` | `VSCE_PAT` (or Azure credentials) | Stable versions only — the Marketplace rejects prereleases              |
| `open-vsx`              | `ovsx publish <vsix>`               | `OVSX_PAT`                        | Stable versions only                                                    |
| `github-release-assets` | `gh release upload`                 | `gh` (`GH_TOKEN`)                 | Attaches binaries/checksums to the `name@version` release; no snapshots |
| `docker`                | `docker buildx build --push`        | `docker login` (e.g. GHCR)        | Tags `:version`, `:latest` (stable), and the dist-tag                   |
| `homebrew`              | commit + tag + push to a tap repo   | `HOMEBREW_TAP_TOKEN`              | Renders a formula template; stable versions only                        |
| `custom`                | your shell command(s)               | yours                             | The declarative escape hatch for anything else                          |

Set a package's targets with `publishTargets` (in the root config's `packages` map, or — name references only — in the package's own `"bumpy"` config):

```jsonc
{
  "packages": {
    "my-lib": { "publishTargets": ["npm"] }, // the implicit default for public packages
    "my-vscode-extension": {
      // a private package can publish to marketplaces while never touching npm
      "publishTargets": ["vscode-marketplace", "open-vsx"],
    },
    "my-cli": {
      "publishTargets": [
        "npm",
        { "type": "custom", "name": "homebrew", "command": "./scripts/update-tap.sh {{version}}" },
      ],
    },
  },
}
```

Each entry is either a **string** (a built-in type name, or a named instance from the root `targets` map) or an **inline definition** (`{ "type": ..., ...options }`). The instance `name` (defaults to the type) keys the per-target publish state in the GitHub release metadata, so keep it stable. Public packages default to `["npm"]`, private packages to `[]`.

**Named instances (`targets` map).** Root-level `targets` defines reusable instances, referenced by key from any package. A key that is a built-in type name (`"npm"`, `"jsr"`, …) configures the instance of that name (`"type"` is implied); any other key needs a `"type"`. Instances are complete on their own — nothing is inherited between them. For npm-type instances, the root `publish` block supplies the defaults every instance starts from.

```jsonc
{
  "publish": { "provenance": true }, // defaults for every npm-type instance
  "targets": {
    "npm": { "access": "public" }, // the instance named "npm"
    "ghp": { "type": "npm", "registry": "https://npm.pkg.github.com" }, // another npm instance
  },
  "packages": {
    "@myorg/*": { "publishTargets": ["npm", "ghp"] }, // publish to both registries
  },
}
```

**Execution + retries.** Packages publish in dependency order; within a package, targets run in declared order. One target failing doesn't block its siblings on the same package — but it does block the _same_ target on dependents (`app@jsr` never goes out referencing a `lib@jsr` that didn't land); blocked targets are recorded as failed and retried on the next run. Publish state is tracked per target in the draft GitHub release, so a partial failure (npm succeeded, Open VSX errored) retries only what's missing on the next CI run. Before every publish the registry itself is asked whether the version is already live (`checkPublished`), so a lost draft never causes a duplicate publish.

**Tags and finalization.** The git tag `name@version` marks the commit a version's artifacts shipped from: it follows HEAD across failed attempts and freezes the first time anything ships. The draft GitHub release is finalized (published, firing `release: published`) once every _release-phase_ target is live. A [staged npm publish](#staged-publishing) holds the draft open until the version is approved — the next publish run sees it live and finalizes.

**Phases.** Targets run in two passes around the GitHub release. `release`-phase targets _constitute_ it (npm, JSR, PyPI, marketplaces, `github-release-assets`): the draft is held until they're done, then published. `post-release`-phase targets _consume_ it and run only once it's public — a Homebrew formula whose `url`s point at release assets, a Dockerfile that downloads them — because a draft release's assets aren't downloadable. `homebrew` and `docker` default to `post-release`; any target (e.g. a `custom` announcement command) can set `"phase": "post-release"`. If a package's release-phase targets don't all succeed (a failure, or a staged publish awaiting approval), its post-release targets wait for the next run. Builds happen in the release pass only.

**Shared artifacts.** Targets that publish the same artifact share one build: `vscode-marketplace` and `open-vsx` both publish the `.vsix` that `vsce package` produces, so it's built once and uploaded to both registries — the two published extensions are guaranteed byte-identical.

**Capabilities.** Marketplace targets don't participate in [snapshot releases](snapshots.md) or prerelease [channels](prereleases.md) (the VS Code Marketplace only accepts plain `x.y.z` versions), and JSR skips snapshots (no dist-tags to install them from) — those publishes record the target as `skipped` rather than failing.

**Removed fields.** The pre-targets `publishCommand`, `checkPublished` and `skipNpmPublish` package fields are gone — bumpy fails with the migration when it sees them: `publishCommand`/`checkPublished` become a `{ "type": "custom", "name": "custom", "command": ..., "checkPublished": ... }` entry (naming it `custom` lets an in-flight release resume from its existing metadata), `skipNpmPublish: true` becomes `"publishTargets": []`.

#### CLI binaries: release assets, Docker images, Homebrew

A CLI shipped as native binaries typically fans out to three places after npm. `github-release-assets` runs in the release phase; `homebrew` and `docker` are post-release targets, so by the time they run the release is published and the formula's `url`s and the Dockerfile's downloads resolve:

```jsonc
{
  "packages": {
    "varlock": {
      "buildCommand": "bun run build:binaries", // produces dist-sea/*.tar.gz + checksums.txt
      "publishTargets": [
        "npm",
        {
          "type": "github-release-assets",
          "files": ["dist-sea/*.tar.gz", "dist-sea/*.zip", "dist-sea/checksums.txt*"],
        },
        {
          "type": "homebrew",
          "tap": "dmno-dev/homebrew-tap",
          "template": "homebrew/varlock.rb.tmpl",
          "assets": ["dist-sea/*.tar.gz"],
        },
        {
          "type": "docker",
          "image": "ghcr.io/dmno-dev/varlock",
          "context": "../..",
          "dockerfile": "../../Dockerfile",
          "platforms": ["linux/amd64", "linux/arm64"],
          "buildArgs": { "VARLOCK_VERSION": "{{version}}" },
        },
      ],
    },
  },
}
```

**`github-release-assets`** uploads the files matching `files` (globs relative to the package dir; `{{version}}`/`{{name}}` substituted) to the package's GitHub release with `--clobber`. Because bumpy owns the release, the upload goes to the _draft_ — the release is only published, firing `release: published`, once the assets (and every other target) are done. Build the files first (`buildCommand`, or an earlier CI step). Needs the `gh` CLI with `contents: write`.

**`docker`** runs `docker buildx build --push` with `--tag image:<version>`, plus `image:latest` for stable releases (`"latest": false` to opt out) and `image:<dist-tag>` on channel/snapshot publishes — so `ghcr.io/org/tool:next` works like `npm install tool@next`. `context`/`dockerfile` are relative to the package dir; `platforms` builds a multi-arch manifest; `buildArgs` values and extra `tags` get `{{version}}` substituted. Auth is the environment's (`docker/login-action` with `GITHUB_TOKEN` + `packages: write` for GHCR). Idempotency uses `docker manifest inspect`.

**`homebrew`** renders a formula template from your repo and pushes it to the tap. The template is yours; bumpy fills `{{version}}`, `{{name}}`, and `{{sha256 <file>}}` (the SHA-256 of a release asset found by basename in the `assets` globs — which is why the assets target goes first). It writes `formula` (default `Formula/<name>.rb`) into a fresh clone of `tap` (or an existing checkout via `tapDir`, e.g. from `actions/checkout`), commits as `name@version`, tags the tap commit the same, and pushes. A workflow's `GITHUB_TOKEN` can't push to another repo: set `HOMEBREW_TAP_TOKEN` (falls back to `BUMPY_GH_TOKEN`/`GH_TOKEN`); it's passed to git through the environment, never on the command line. Idempotency reads the formula's `version` from the tap via the GitHub API.

#### JSR notes

- `jsr.json` must exist (name + exports), but commit its `version` as `"0.0.0"` and forget it — bumpy syncs it from package.json into the working tree at publish time. Publishes run with `--allow-dirty` for this reason.
- `workspace:`/`catalog:` dependency specifiers in package.json are resolved automatically before publishing (JSR reads npm ranges from package.json and silently drops protocol specifiers).
- JSR has **no create-on-first-publish**: claim each package in your scope on jsr.io first, and link the GitHub repo to publish token-lessly via OIDC (`id-token: write`). Unclaimed packages fail with guidance instead of publishing.
- Options: `allowSlowTypes: true` passes `--allow-slow-types`; `publishArgs` appends anything else.
- Credit: the JSR publishing behavior here (publish-time version sync, claim-first bootstrap) is modeled on [Drake Costa's](https://github.com/Saeris) setup in [mirrordown](https://github.com/mirrordown/mirrordown) — thanks Drake!

#### PyPI notes

bumpy's versioning spine is `package.json`, so a Python package in the workspace gets a **stub `package.json`** next to its `pyproject.toml`:

```json
{
  "name": "my-py-tool",
  "version": "1.2.0",
  "private": true,
  "bumpy": { "publishTargets": ["pypi"] }
}
```

Bump files, changelogs, and the release PR all flow through the stub; at publish time the target syncs the version into `pyproject.toml` (`[project].version` — commit any placeholder), builds with `uv build` into an isolated per-version directory (so stale `dist/` artifacts can never ride along), and uploads with `uv publish`.

- **Auth**: [PyPI trusted publishing](https://docs.pypi.org/trusted-publishers/) (OIDC) works token-lessly on GitHub Actions with `id-token: write` — `uv publish` picks it up automatically. Otherwise set `UV_PUBLISH_TOKEN`.
- The PyPI project name comes from `pyproject.toml` `[project].name`, not the stub's npm name.
- `dynamic = ["version"]` (setuptools-scm etc.) can't be synced — use a static version.
- PEP 440 doesn't cover bumpy's semver prerelease/snapshot suffixes, so channel prereleases and snapshots record the target as `skipped`.
- Options: `index` (alternative upload URL), `buildArgs` / `publishArgs`.

#### VS Code extension notes

- The `.vsix` is packaged with `vsce package --no-dependencies` by default — vsce's npm-based dependency detection breaks in workspace monorepos and silently ships broken extensions. Bundled extensions (the norm) don't need it; set `dependencies: true` on the target to restore vsce's default. `packageArgs` / `publishArgs` append extra flags to the respective step.
- Marketplace auth: `VSCE_PAT` by default, or set `azureCredential: true` to publish with `--azure-credential` (short-lived tokens minted via Azure OIDC — pair with `azure/login` in CI, no long-lived PAT secret).
- If the extension bundles a workspace sibling from `devDependencies`, list it in [`releaseTriggeringDevDeps`](#release-triggering-devdependencies) so the extension re-releases when the bundled package changes.

### Version PR config

The `versionPr` object customizes the PR that `bumpy ci release` creates:

| Option     | Type     | Default                    | Description                           |
| ---------- | -------- | -------------------------- | ------------------------------------- |
| `title`    | `string` | `"🐸 Versioned release"`   | PR title                              |
| `branch`   | `string` | `"bumpy/version-packages"` | Branch name for the version PR        |
| `preamble` | `string` | —                          | HTML content prepended to the PR body |

### Prerelease channels

The `channels` object maps long-lived branches to prerelease lines. See [prereleases.md](prereleases.md) for the full workflow.

```jsonc
{
  "channels": {
    "next": {
      "branch": "next", // required — branch that triggers this channel
      "preid": "rc", // version suffix (default: channel name)
      "tag": "next", // npm dist-tag (default: channel name)
      "versionPr": {
        "title": "🐸 Versioned release (next)", // default: "<base title> (<name>)"
        "branch": "bumpy/version-packages-next", // default: "<base branch>-<name>"
        "automerge": false, // enable auto-merge on the release PR
      },
    },
  },
}
```

Channel names become `.bumpy/<name>/` subdirectories (holding bump files that shipped on the channel), so they must be filesystem-safe and can't start with `_` or collide with reserved entries.

### Snapshot releases

The `snapshot` object configures one-off transient previews published with `bumpy publish --snapshot <name>`. See [snapshots.md → Snapshot releases](snapshots.md#snapshot-releases) for the full workflow.

```jsonc
{
  "snapshot": {
    // How snapshot versions are made unique (consumers install via the tag regardless):
    //   "sha"       → 1.4.0-pr-123-a1b2c3d  (short git SHA; idempotent per commit; default)
    //   "timestamp" → 1.4.0-pr-123-20260623123456  (always unique)
    "versionStrategy": "sha",
  },
}
```

## Per-package config

Per-package settings can be defined in two places:

1. In `.bumpy/_config.json` under the `packages` key (keyed by package name)
2. In each package's `package.json` under the `"bumpy"` key

`package.json` settings take precedence over global config.

| Option                     | Type                       | Description                                                                            |
| -------------------------- | -------------------------- | -------------------------------------------------------------------------------------- |
| `managed`                  | `boolean`                  | Opt this package in or out of versioning                                               |
| `access`                   | `"public" \| "restricted"` | Override the global access level                                                       |
| `publishTargets`           | `array`                    | Where this package publishes (see [Publish targets](#publish-targets))                 |
| `buildCommand`             | `string`                   | Command to run before publishing                                                       |
| `registry`                 | `string`                   | Custom npm registry URL                                                                |
| `changedFilePatterns`      | `string[]`                 | Glob patterns for changed-file detection (replaces root setting, not merged)           |
| `dependencyBumpRules`      | `object`                   | Per-package override for dependency propagation rules                                  |
| `cascadeTo`                | `object`                   | Explicit cascade targets — glob pattern mapped to `{ trigger, bumpAs }`                |
| `cascadeFrom`              | `object`                   | Explicit cascade sources — glob pattern mapped to `{ trigger, bumpAs }`                |
| `releaseTriggeringDevDeps` | `string[]`                 | devDependencies that affect published output — a change requires a release (see below) |

### Custom commands and `allowCustomCommands`

A `buildCommand` runs a shell command during publishing, and an inline `publishTargets` definition (`{ "type": "custom", "command": ... }`, `{ "type": "npm", "registry": ... }`, `publishArgs`, …) steers where and how a publish happens. Because these execute with CI credentials, bumpy distinguishes between two trust levels:

- **Root config** (`.bumpy/_config.json` → `packages` and `targets`): always trusted — repo admins control this file.
- **Per-package config** (`package.json` → `"bumpy"`): may only **reference** targets by name. A `buildCommand` or an inline target definition there requires opt-in via `allowCustomCommands` in the root config, and fails loudly otherwise.

To enable them, set `allowCustomCommands` in `.bumpy/_config.json`:

```json
{
  "allowCustomCommands": true
}
```

Or restrict to specific packages/globs:

```json
{
  "allowCustomCommands": ["@myorg/vscode-extension", "@myorg/deploy-*"]
}
```

This prevents a contributor from introducing arbitrary shell commands — or redirecting a publish to another registry, or injecting CLI flags — via a package's `package.json` without the root config explicitly allowing it. Referencing built-in or root-defined targets by name (`"publishTargets": ["vscode-marketplace"]`) is plain data and never requires `allowCustomCommands`. To give a package custom target options without opting in, define a named instance in the root `targets` map and reference it by name.

### Example: publishing a VSCode extension

Use the built-in targets — they package the `.vsix` once (via `vsce package`) and publish it to both registries, skip prerelease/snapshot publishes automatically, and track each registry separately for retries:

```json
{
  "packages": {
    "my-vscode-extension": {
      "publishTargets": ["vscode-marketplace", "open-vsx"]
    }
  }
}
```

Or in the package's own `package.json` (no `allowCustomCommands` needed — target references are plain data):

```json
{
  "name": "my-vscode-extension",
  "private": true,
  "bumpy": {
    "publishTargets": ["vscode-marketplace", "open-vsx"]
  }
}
```

Mark the extension `"private": true` so it never goes to npm; explicit `publishTargets` still publish it to the marketplaces. Auth comes from `VSCE_PAT` / `OVSX_PAT` environment variables in CI.

### Example: cascade from core to plugins (source-side)

```json
{
  "name": "@myorg/core",
  "bumpy": {
    "cascadeTo": ["@myorg/plugin-*", "@myorg/cli"]
  }
}
```

Or with custom trigger/bumpAs:

```json
{
  "name": "@myorg/core",
  "bumpy": {
    "cascadeTo": {
      "@myorg/plugin-*": { "trigger": "minor", "bumpAs": "patch" }
    }
  }
}
```

### Release-triggering devDependencies

By default a `devDependencies` change doesn't require a release — it's usually dev tooling (a linter, a type package, a test runner). But sometimes a dependency that affects your **published output** lives under `devDependencies`. `releaseTriggeringDevDeps` marks those, so a change to one requires a release (and, for internal workspace deps, its own releases cascade to you):

```json
{
  "name": "@myorg/astro-integration",
  "bumpy": {
    "releaseTriggeringDevDeps": ["@myorg/vite-integration", "nanoid"]
  }
}
```

**The usual reason is bundling.** A build step (tsup, tsdown, esbuild, rolldown/rollup, Vite, `bun build`, webpack, …) inlines imports into `dist/`, so consumers get a self-contained artifact. A bundled dependency isn't installed from the registry at consume time — its code is copied into your output — so it's conventionally declared under `devDependencies` (you don't want consumers to also install it). Taken to the extreme, a fully-bundled package can have **no runtime `dependencies` at all**; every library it imports sits in `devDependencies`. (bumpy itself is built this way with tsdown.) Other cases that fit: a dependency whose output you commit and ship (codegen), or a re-exported types-only package.

`releaseTriggeringDevDeps` declares intent — "a change to this dep changes what I publish" — and that drives **two** behaviors:

1. **Propagation** — when the dep gets its **own release**, this package is cascaded a **patch** bump (shorthand for a `cascadeFrom` rule of `{ "trigger": "patch", "bumpAs": "patch" }`). This only applies to **internal workspace** deps, since bumpy only releases packages in your workspace.
2. **Change detection** — when the dep's version is edited in **this** package's `package.json` (e.g. a Dependabot PR, or a manual bump), this package is flagged as changed and needs a bump file — even though `devDependencies` edits are normally ignored (see [Change detection](#change-detection-and-packagejson-fields)). This applies to **any** listed dep, internal or external.

So for an **internal** workspace dep, both paths fire; for an **external** dep (e.g. a published npm package you inline), only change detection applies — listing it is still useful, and is a harmless no-op for propagation.

#### Internal workspace deps: release-relevant or not

This is exactly the knob for "which `devDependencies` affect my published output." An internal workspace package listed under `devDependencies` is, by default, treated as dev-only — its releases don't cascade ([`dependencyBumpRules.devDependencies` is `false`](#dependency-bump-rules)) and bumping its range doesn't flag you. Add it to `releaseTriggeringDevDeps` to flip both: now its releases republish you, and editing its range flags you. Leave it out and it stays dev-only. No global setting is involved — it's per-dependency, per-consumer.

#### Proportional bumps

If you re-export the dependency's API and want **proportional** bumps (a minor in the dep → a minor here), use `cascadeFrom` directly instead — an explicit `cascadeFrom` rule for the same source takes precedence over the `releaseTriggeringDevDeps` patch default:

```json
{
  "name": "@myorg/astro-integration",
  "bumpy": {
    "cascadeFrom": { "@myorg/vite-integration": { "trigger": "patch", "bumpAs": "match" } }
  }
}
```

## Changelog formatters

Set `changelog` in config to control how changelog entries are generated. Built-in options are `"default"` and `"github"`, or you can provide a path to a custom formatter module. Set to `false` to disable changelog generation entirely.

See the [Changelog Formatters](./changelog-formatters.md) docs for full details and examples.

## Example config

```json
{
  "baseBranch": "main",
  "access": "public",
  "changelog": "github",
  "fixed": [["@myorg/core", "@myorg/types"]],
  "ignore": ["@myorg/internal-tools"],
  "privatePackages": { "version": true, "tag": false },
  "dependencyBumpRules": {
    "peerDependencies": { "trigger": "minor", "bumpAs": "match" }
  },
  "publish": {
    "provenance": true,
    "npmStaged": true
  },
  "targets": {
    "ghp": { "type": "npm", "registry": "https://npm.pkg.github.com" }
  },
  "packages": {
    "@myorg/vscode-extension": {
      "publishTargets": ["vscode-marketplace", "open-vsx"]
    },
    "@myorg/cli": {
      "publishTargets": ["npm", "ghp"]
    }
  },
  "allowCustomCommands": ["@myorg/deploy-*"]
}
```
