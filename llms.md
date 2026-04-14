# @dmno-dev/bumpy — LLM Reference

> Bumpy is a modern monorepo versioning and changelog tool. It replaces @changesets/changesets with simpler config, sane defaults, and flexible dependency bump control.

## Quick Start

```bash
# Initialize in a monorepo root
bumpy init

# Create a changeset (interactive)
bumpy add

# Create a changeset (non-interactive, for CI/AI)
bumpy add --packages "pkg-a:minor,pkg-b:patch" --message "Added feature X" --name "add-feature-x"

# Preview what would be released
bumpy status
bumpy status --json
bumpy status --packages  # one name per line, for piping

# Apply changesets — bumps versions, updates changelogs, deletes changeset files
bumpy version

# Publish (pack with PM, publish tarball with npm)
bumpy publish
bumpy publish --dry-run
bumpy publish --tag beta
```

## How It Works

1. Developers create **changeset files** in `.bumpy/` describing what changed and which packages are affected
2. `bumpy version` reads all pending changesets, calculates version bumps (including dependency propagation), updates `package.json` versions and `CHANGELOG.md` files, then deletes the consumed changesets
3. `bumpy publish` finds packages with unpublished versions and publishes them in dependency order

## Changeset File Format

Changeset files are markdown with YAML frontmatter, stored in `.bumpy/<name>.md`.

### Simple format

```yaml
---
"@myorg/core": minor
"@myorg/utils": patch
---

Added new encryption provider for secrets management.
```

### Isolated bumps (skip dependency propagation)

```yaml
---
"@myorg/utils": patch-isolated
---

Internal refactor — no API changes, dependents don't need to bump.
```

Valid bump types: `major`, `minor`, `patch`, `major-isolated`, `minor-isolated`, `patch-isolated`

### Nested format with explicit cascade control

```yaml
---
"@myorg/core":
  bump: minor
  cascade:
    "@myorg/plugin-*": patch
    "@myorg/cli": minor
"@myorg/utils": patch
---

Added new encryption provider. Plugins need a patch bump for compatibility.
```

## Configuration

### Root config: `.bumpy/config.json`

```jsonc
{
  // Branch to compare against (default: "main")
  "baseBranch": "main",

  // npm access level for publishing (default: "public")
  "access": "public",

  // Auto-commit after `bumpy version` (default: false)
  "commit": false,

  // Changelog formatter: "default", "github", ["github", { repo: "..." }], or "./path.ts"
  "changelog": "default",

  // Packages whose versions are always bumped together to the same version
  "fixed": [["@myorg/core", "@myorg/types"]],

  // Packages whose versions are bumped to the same level but keep independent version numbers
  "linked": [["@myorg/plugin-*"]],

  // Package names/globs to exclude from version management
  "ignore": ["@myorg/internal-*", "test-fixtures"],

  // Package names/globs to explicitly include (overrides private status and ignore)
  "include": ["my-vscode-ext", "@myorg/app-*"],

  // When to update internal dependency version ranges
  // "out-of-range" = only when new version falls outside existing range (default)
  // "patch" = always bump dependents
  // "minor" = only on minor+ bumps
  // "none" = never auto-bump dependents
  "updateInternalDependencies": "out-of-range",

  // Global rules for how dependency bumps propagate
  "dependencyBumpRules": {
    // When a regular dependency bumps, what happens to dependents?
    "dependencies": { "trigger": "patch", "bumpAs": "patch" },
    // When a peer dependency bumps, what happens to dependents?
    // DEFAULT: only major triggers propagation (changesets uses minor!)
    "peerDependencies": { "trigger": "major", "bumpAs": "major" },
    // Dev dependencies never propagate by default
    "devDependencies": { "trigger": "none", "bumpAs": "patch" },
    "optionalDependencies": { "trigger": "minor", "bumpAs": "patch" }
  },

  // Whether to version/tag private packages by default
  "privatePackages": { "version": false, "tag": false },

  // Per-package config overrides (keys support globs)
  "packages": {
    "my-vscode-ext": {
      "skipNpmPublish": true,
      "publishCommand": ["bun run package", "bunx vsce publish"],
      "buildCommand": "bun run build"
    },
    "@myorg/plugin-*": {
      "access": "public"
    }
  },

  // Publish pipeline configuration
  "publish": {
    // Which PM to use for packing ("auto" detects from lockfile)
    "packManager": "auto",
    // Which tool to use for publishing (npm supports OIDC/provenance)
    "publishManager": "npm",
    // Extra args for the publish command
    "publishArgs": ["--provenance"],
    // How to resolve workspace:/catalog: protocols before publish
    // "pack" = PM packs tarball (resolves protocols), then npm publishes tarball (default)
    // "in-place" = rewrite package.json before publish
    // "none" = don't resolve
    "protocolResolution": "pack"
  },

  // GitHub release creation (requires gh CLI). Default: individual per package.
  // true = single aggregated release for all packages
  // { enabled: true, title: "Release {{date}}" } = aggregate with custom title
  "aggregateRelease": false
}
```

### Per-package config: `package.json["bumpy"]`

Any package can have bumpy config in its own `package.json`:

```json
{
  "name": "@myorg/my-vscode-ext",
  "private": true,
  "bumpy": {
    "managed": true,
    "skipNpmPublish": true,
    "publishCommand": ["bun run package", "bunx vsce publish", "bunx ovsx publish"],
    "buildCommand": "bun run build",
    "cascadeTo": {
      "@myorg/plugin-*": { "trigger": "minor", "bumpAs": "patch" }
    },
    "specificDependencyRules": {
      "@myorg/core": { "trigger": "minor", "bumpAs": "minor" }
    }
  }
}
```

#### Per-package config fields

| Field | Type | Description |
|-------|------|-------------|
| `managed` | `boolean` | Explicitly opt in (`true`) or out (`false`) of version management. Overrides private/ignore/include. |
| `access` | `"public" \| "restricted"` | npm access level override |
| `publishCommand` | `string \| string[]` | Custom publish command(s). Supports `{{version}}` and `{{name}}` template variables. |
| `buildCommand` | `string` | Build command to run before publishing |
| `registry` | `string` | Custom npm registry URL |
| `skipNpmPublish` | `boolean` | Skip npm publish (use with `publishCommand` for non-npm publishing) |
| `dependencyBumpRules` | `object` | Override global dependency bump rules for this package |
| `specificDependencyRules` | `Record<string, DependencyBumpRule>` | Rules for specific dependencies by name/glob |
| `cascadeTo` | `Record<string, DependencyBumpRule>` | When this package bumps, cascade to these packages (supports globs) |

## Package Management (include/exclude)

Resolution order (first match wins):

1. `managed: false` in package.json `bumpy` config → **skip**
2. Matches `ignore` glob → **skip** (unless `managed: true` or `include` glob)
3. `managed: true` in package.json `bumpy` config → **include**
4. Matches `include` glob → **include** (overrides private)
5. Private package + `privatePackages.version: false` → **skip**
6. Default → **include**

All `ignore`, `include`, `fixed`, `linked`, and per-package config keys support glob patterns: `*` (single segment), `**` (any depth), e.g., `@myorg/plugin-*`, `@myorg/**`.

## Dependency Bump Rules

A `DependencyBumpRule` has two fields:

```json
{ "trigger": "minor", "bumpAs": "patch" }
```

- `trigger`: what bump level in the dependency triggers propagation. Values: `"major"`, `"minor"`, `"patch"`, `"none"`
- `bumpAs`: what bump to apply to the dependent. Values: `"major"`, `"minor"`, `"patch"`, `"match"` (same as trigger)

### Rule resolution order

When package A bumps and package B depends on A, bumpy looks for a rule in this order:

1. **Changeset cascade** — explicit `cascade:` in the changeset file (always applies, no trigger check)
2. **Source cascadeTo** — `cascadeTo` config on package A
3. **Specific dependency rule** — `specificDependencyRules["A"]` on package B
4. **Per-package dep type rule** — `dependencyBumpRules[depType]` on package B
5. **Global dep type rule** — root config `dependencyBumpRules[depType]`
6. **Built-in defaults**

### Built-in defaults (the key difference from changesets)

| Dependency type | trigger | bumpAs | Changesets behavior |
|----------------|---------|--------|-------------------|
| `dependencies` | patch | patch | Same |
| `peerDependencies` | **major** | major | minor → major (!) |
| `devDependencies` | none | patch | patch → patch |
| `optionalDependencies` | minor | patch | Same |

The critical difference: changesets bumps dependents to **major** when a peer dependency gets a **minor** bump. Bumpy only propagates peer dep bumps on **major** by default.

## CLI Reference

### `bumpy init`

Creates `.bumpy/` directory with default `config.json` and a README.

### `bumpy add`

Create a new changeset.

| Flag | Description |
|------|-------------|
| `--packages <list>` | Non-interactive: comma-separated `"name:bumpType"` pairs |
| `--message <text>` | Changeset summary |
| `--name <name>` | Changeset filename (default: random adjective-noun) |
| `--empty` | Create an empty changeset (no packages, for CI skip) |

Interactive mode prompts for: packages, bump type per package, cascade options, summary, and filename.

### `bumpy status`

Show pending releases.

| Flag | Description |
|------|-------------|
| `--json` | Full JSON output with `releases[]`, `changesets[]`, `packageNames[]` |
| `--packages` | One package name per line (for piping to other commands) |
| `--bump <types>` | Filter by bump type: `"major"`, `"minor,patch"` |
| `--filter <patterns>` | Filter by package name/glob: `"@myorg/*"` |
| `--verbose` | Show changeset details |

Exit codes: `0` = releases pending, `1` = no releases pending.

JSON output shape:
```json
{
  "changesets": [{ "id": "...", "summary": "...", "releases": [{ "name": "...", "type": "..." }] }],
  "releases": [{ "name": "...", "type": "...", "oldVersion": "...", "newVersion": "...", "dir": "...", "changesets": [], "isDependencyBump": false, "isCascadeBump": false }],
  "packageNames": ["pkg-a", "pkg-b"]
}
```

### `bumpy version`

Apply all pending changesets: bump versions in `package.json`, update `CHANGELOG.md`, delete consumed changeset files. Optionally creates a git commit if `commit: true` in config.

### `bumpy publish`

Publish packages with unpublished versions.

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview without publishing |
| `--tag <tag>` | npm dist-tag (`"next"`, `"beta"`, etc.) |
| `--no-push` | Skip pushing git tags to remote |

Default flow: detects PM → packs tarball (resolves workspace:/catalog: protocols) → publishes tarball with npm → creates git tags → pushes tags → creates GitHub releases (if `gh` CLI is available).

### `bumpy ci check`

PR check — reports pending changesets and optionally comments on the PR with the release plan.

| Flag | Description |
|------|-------------|
| `--comment` | Force PR commenting on/off (auto-detected in CI environments) |
| `--fail-on-missing` | Exit 1 if no changesets found |

Auto-detects PR number from `GITHUB_REF` in GitHub Actions. Also checks `BUMPY_PR_NUMBER` and `PR_NUMBER` env vars.

### `bumpy ci release`

Release automation — either creates a "Version Packages" PR or auto-publishes directly.

| Flag | Description |
|------|-------------|
| `--auto-publish` | Version + publish directly instead of creating a PR |
| `--tag <tag>` | npm dist-tag for auto-publish mode |
| `--branch <name>` | Branch name for version PR (default: `bumpy/version-packages`) |

Default mode (`version-pr`): creates a branch, runs `bumpy version`, commits, and opens/updates a PR via `gh`. Merging that PR triggers publish.

Auto-publish mode: runs `bumpy version`, commits, pushes, then `bumpy publish` in one step.

### `bumpy migrate`

Migrate from `.changeset/` to `.bumpy/`.

| Flag | Description |
|------|-------------|
| `--force` | Skip interactive prompts (don't ask to delete .changeset/) |

Migrates config.json fields, pending changeset files, and prints key differences from changesets.

## Changelog Customization

The `changelog` config controls how CHANGELOG.md entries are formatted.

### Built-in formatters

```json
{ "changelog": "default" }
```
Simple format: version heading, date, bullet points from changeset summaries.

```json
{ "changelog": "github" }
{ "changelog": ["github", { "repo": "dmno-dev/bumpy" }] }
```
GitHub-enhanced: adds PR links and author attribution (`- Added feature (#123) by @user`). Looks up PRs via `gh` CLI by finding the commit that introduced each changeset file.

### Custom formatter (TypeScript or JavaScript)

```json
{ "changelog": "./my-changelog.ts" }
{ "changelog": ["./my-changelog.ts", { "someOption": true }] }
```

A custom formatter exports a function that receives full context and returns the complete changelog entry:

```ts
// my-changelog.ts
import type { ChangelogContext } from "@dmno-dev/bumpy";

export default function(ctx: ChangelogContext): string {
  const { release, changesets, date } = ctx;
  const lines = [`## [${release.newVersion}] - ${date}\n`];

  const relevant = changesets.filter(cs => release.changesets.includes(cs.id));
  for (const cs of relevant) {
    if (cs.summary) lines.push(`- ${cs.summary.split("\n")[0]}`);
  }

  lines.push("");
  return lines.join("\n");
}
```

The `ChangelogContext` interface:
```ts
interface ChangelogContext {
  release: PlannedRelease;  // name, type, oldVersion, newVersion, etc.
  changesets: Changeset[];  // all changesets (filter by release.changesets for relevant ones)
  date: string;             // ISO date (YYYY-MM-DD)
}
```

If the config is `["./my-changelog.ts", { ... }]`, the options object is passed to the exported function. If the function returns another function, it's treated as a factory pattern.

## Publish Pipeline

The publish pipeline is configurable via `publish` in root config:

### Default: pack-then-publish

1. **Build** — runs `buildCommand` if configured on the package
2. **Pack** — runs `bun pm pack` / `pnpm pack` / `npm pack` (auto-detected). This resolves `workspace:` and `catalog:` protocols into the tarball.
3. **Publish** — runs `npm publish <tarball>` (supports OIDC `--provenance`)
4. **Tag** — creates git tag `pkg-name@version`

### Custom publish commands

For non-npm packages (VSCode extensions, Docker images, etc.):

```json
{
  "bumpy": {
    "skipNpmPublish": true,
    "buildCommand": "bun run build",
    "publishCommand": [
      "bunx vsce publish",
      "bunx ovsx publish"
    ]
  }
}
```

Custom commands support `{{version}}` and `{{name}}` template variables. Bumpy resolves `workspace:`/`catalog:` protocols in-place before running custom commands.

## workspace: and catalog: Protocol Handling

Both `workspace:` (pnpm, bun, yarn) and `catalog:` (pnpm, bun) protocols are resolved before publishing.

- **Pack mode** (default): the PM's pack command handles resolution automatically
- **In-place mode**: bumpy rewrites package.json directly (used for custom publish commands)
- **Catalog sources**: pnpm reads from `pnpm-workspace.yaml`; bun reads from root `package.json` (`catalog`/`catalogs` keys or inside `workspaces`)

## Common Patterns

### Monorepo with a core package that drives plugin versions

```json
// In @myorg/core's package.json
{
  "bumpy": {
    "cascadeTo": {
      "@myorg/plugin-*": { "trigger": "minor", "bumpAs": "patch" }
    }
  }
}
```

### Private package that needs version management (e.g., VSCode extension)

```json
{
  "private": true,
  "bumpy": {
    "managed": true,
    "skipNpmPublish": true,
    "publishCommand": "bunx vsce publish"
  }
}
```

### Internal packages that should never propagate bumps

```yaml
---
"@myorg/internal-utils": patch-isolated
---
Refactored internal helpers.
```

Or permanently via config:
```json
// In root .bumpy/config.json
{
  "packages": {
    "@myorg/internal-*": {
      "dependencyBumpRules": {
        "dependencies": { "trigger": "none", "bumpAs": "patch" }
      }
    }
  }
}
```

### CI: conditionally run tests based on affected packages

```bash
# Get list of packages that would be released
PACKAGES=$(bumpy status --packages 2>/dev/null)

if echo "$PACKAGES" | grep -q "@myorg/core"; then
  echo "Core changed — running full test suite"
  bun test
fi
```

### CI: publish preview packages

```bash
bumpy version
bumpy publish --tag preview --no-push
```

### GitHub Actions — PR check + version PR workflow

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
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx @dmno-dev/bumpy ci check
        env:
          GH_TOKEN: ${{ github.token }}
```

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
      id-token: write  # for npm provenance
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      # Option A: Create a "Version Packages" PR
      - run: bunx @dmno-dev/bumpy ci release
        env:
          GH_TOKEN: ${{ github.token }}
      # Option B: Auto-publish directly
      # - run: bunx @dmno-dev/bumpy ci release --auto-publish
      #   env:
      #     GH_TOKEN: ${{ github.token }}
      #     NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Non-interactive changeset creation (AI/CI)

```bash
bumpy add \
  --packages "@myorg/core:minor,@myorg/cli:patch" \
  --message "Added new API for encryption providers" \
  --name "add-encryption-api"
```

### Aggregate GitHub releases

By default, `bumpy publish` creates one GitHub release per package (requires `gh` CLI). To create a single aggregated release instead:

```json
// .bumpy/config.json
{
  "aggregateRelease": true
}
```

Or with a custom title:
```json
{
  "aggregateRelease": {
    "enabled": true,
    "title": "Release {{date}}"
  }
}
```

### Migrating from changesets

```bash
bumpy migrate
```

This will:
1. Create `.bumpy/` and migrate `config.json` settings
2. Copy pending changeset `.md` files
3. Optionally remove `.changeset/` directory

Key behavioral differences after migration:
- Peer dependency minor bumps no longer cascade to major on dependents
- Use `patch-isolated`/`minor-isolated` bump types to skip propagation
- Per-package config moves to `package.json["bumpy"]` instead of root config only
