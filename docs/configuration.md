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
| `publish`                    | `object`                               | see below                        | Publishing pipeline config                                                                             |
| `gitUser`                    | `{ name, email }`                      | bumpy-bot                        | Git identity for CI commits                                                                            |
| `versionPr`                  | `{ title, branch, preamble }`          | see below                        | Customize the version PR                                                                               |
| `allowCustomCommands`        | `boolean \| string[]`                  | `false`                          | Allow per-package custom commands from `package.json` (see below)                                      |
| `packages`                   | `object`                               | `{}`                             | Per-package config overrides (keyed by package name)                                                   |
| `channels`                   | `object`                               | `{}`                             | Prerelease channels, keyed by channel name (see below)                                                 |
| `snapshot`                   | `{ versionStrategy }`                  | `{ versionStrategy: "sha" }`     | Snapshot release settings — how snapshot versions are made unique (see below)                          |

### Private packages and private registries

These are two different things, and bumpy treats them differently:

- **Publishing to a private registry** (scoped package + `access: "restricted"` and/or a `registry`, _without_ `"private": true`) works like any other publish — bumpy versions, publishes, tags, and snapshots them normally. This is the recommended setup for private/internal packages. See [Publishing to a private registry](snapshots.md#publishing-to-a-private-registry).
- **`"private": true` in `package.json`** is npm's "never publish" marker (`npm publish` refuses it). bumpy never publishes these. `privatePackages` only controls whether they're _versioned_ (`version`) and _git-tagged_ (`tag`) — not published. Use this for apps and internal tooling you want bumpy to bump but never ship to a registry.

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
| `publishCommand`           | `string \| string[]`       | Custom command(s) to publish this package (replaces npm publish)                       |
| `buildCommand`             | `string`                   | Command to run before publishing                                                       |
| `registry`                 | `string`                   | Custom npm registry URL                                                                |
| `skipNpmPublish`           | `boolean`                  | Don't publish to npm (still creates git tags)                                          |
| `checkPublished`           | `string`                   | Custom command that outputs the currently published version                            |
| `changedFilePatterns`      | `string[]`                 | Glob patterns for changed-file detection (replaces root setting, not merged)           |
| `dependencyBumpRules`      | `object`                   | Per-package override for dependency propagation rules                                  |
| `cascadeTo`                | `object`                   | Explicit cascade targets — glob pattern mapped to `{ trigger, bumpAs }`                |
| `cascadeFrom`              | `object`                   | Explicit cascade sources — glob pattern mapped to `{ trigger, bumpAs }`                |
| `releaseTriggeringDevDeps` | `string[]`                 | devDependencies that affect published output — a change requires a release (see below) |

### Custom commands and `allowCustomCommands`

The `publishCommand`, `buildCommand`, and `checkPublished` fields run shell commands during publishing. Because these execute with CI credentials, bumpy distinguishes between two trust levels:

- **Root config** (`.bumpy/_config.json` → `packages`): always trusted — repo admins control this file.
- **Per-package config** (`package.json` → `"bumpy"`): requires opt-in via `allowCustomCommands` in the root config.

By default, custom commands defined in `package.json` are **ignored** with a warning. To enable them, set `allowCustomCommands` in `.bumpy/_config.json`:

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

This prevents a contributor from introducing arbitrary shell commands via a package's `package.json` without the root config explicitly allowing it.

### Example: custom publish for a VSCode extension

In `.bumpy/_config.json` (recommended — no `allowCustomCommands` needed):

```json
{
  "packages": {
    "my-vscode-extension": {
      "publishCommand": "vsce publish",
      "skipNpmPublish": true
    }
  }
}
```

Or in the package's `package.json` (requires `allowCustomCommands`):

```json
{
  "name": "my-vscode-extension",
  "bumpy": {
    "publishCommand": "vsce publish",
    "skipNpmPublish": true
  }
}
```

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
  "packages": {
    "@myorg/vscode-extension": {
      "publishCommand": "vsce publish",
      "skipNpmPublish": true
    }
  },
  "allowCustomCommands": ["@myorg/deploy-*"]
}
```
