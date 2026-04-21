# 🐸 @varlock/bumpy — LLM Reference

> Bumpy is a modern monorepo versioning and changelog tool. It replaces @changesets/changesets with simpler config, sane defaults, and flexible dependency bump control.

## Quick Start

```bash
# Initialize in a monorepo root
bumpy init

# Create a bump file (interactive)
bumpy add

# Create a bump file (non-interactive, for CI/AI)
bumpy add --packages "pkg-a:minor,pkg-b:patch" --message "Added feature X" --name "add-feature-x"

# Preview what would be released
bumpy status
bumpy status --json
bumpy status --packages  # one name per line, for piping

# Apply bump files — bumps versions, updates changelogs, deletes bump files
bumpy version

# Publish (pack with PM, publish tarball with npm)
bumpy publish
bumpy publish --dry-run
bumpy publish --tag beta
```

## How It Works

1. Developers create **bump files** in `.bumpy/` describing what changed and which packages are affected
2. `bumpy version` reads all pending bump files, calculates version bumps (including dependency propagation), updates `package.json` versions and `CHANGELOG.md` files, then deletes the consumed bump files
3. `bumpy publish` finds packages with unpublished versions and publishes them in dependency order

## Bump File Format

Bump files are markdown with YAML frontmatter, stored in `.bumpy/<name>.md`.

### Simple format

```yaml
---
'@myorg/core': minor
'@myorg/utils': patch
---
Added new encryption provider for secrets management.
```

Valid bump types: `major`, `minor`, `patch`, `none`

`none` suppresses a bump on a package that would otherwise be included via propagation. If skipping would leave a broken range, bumpy throws an error.

### Nested format with explicit cascade control

```yaml
---
'@myorg/core':
  bump: minor
  cascade:
    '@myorg/plugin-*': patch
    '@myorg/cli': minor
'@myorg/utils': patch
---
Added new encryption provider. Plugins need a patch bump for compatibility.
```

## Configuration

### Root config: `.bumpy/_config.json`

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

  // When to update internal dependency version ranges (Phase C)
  // "out-of-range" = only fix broken ranges via Phase A (default)
  // "patch" = also proactively bump dependents on any dep bump
  // "minor" = also proactively bump dependents on minor+ dep bumps
  "updateInternalDependencies": "out-of-range",

  // Global rules for how dependency bumps propagate (Phase C only)
  // Each rule is either false (disabled) or { trigger, bumpAs }
  "dependencyBumpRules": {
    // When a regular dependency bumps, what happens to dependents?
    "dependencies": { "trigger": "patch", "bumpAs": "patch" },
    // When a peer dependency bumps, what happens to dependents?
    "peerDependencies": { "trigger": "major", "bumpAs": "match" },
    // Dev dependencies never propagate by default
    "devDependencies": false,
    "optionalDependencies": { "trigger": "minor", "bumpAs": "patch" },
  },

  // Whether to version/tag private packages by default
  "privatePackages": { "version": false, "tag": false },

  // Per-package config overrides (keys support globs)
  "packages": {
    "my-vscode-ext": {
      "skipNpmPublish": true,
      "publishCommand": ["bun run package", "bunx vsce publish"],
      "buildCommand": "bun run build",
    },
    "@myorg/plugin-*": {
      "access": "public",
    },
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
    "protocolResolution": "pack",
  },

  // GitHub release creation (requires gh CLI). Default: individual per package.
  // true = single aggregated release for all packages
  // { enabled: true, title: "Release {{date}}" } = aggregate with custom title
  "aggregateRelease": false,

  // Git identity for CI commits (default: bumpy-bot)
  "gitUser": {
    "name": "bumpy-bot",
    "email": "276066384+bumpy-bot@users.noreply.github.com",
  },

  // Version PR settings
  "versionPr": {
    // PR title (default: "🐸 Versioned release")
    "title": "🐸 Versioned release",
    // Branch name (default: "bumpy/version-packages")
    "branch": "bumpy/version-packages",
    // Preamble text shown at the top of the PR body
    "preamble": "Merge this PR when you are ready to release...",
  },
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
    }
  }
}
```

#### Per-package config fields

| Field                 | Type                                 | Description                                                                                           |
| --------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `managed`             | `boolean`                            | Explicitly opt in (`true`) or out (`false`) of version management. Overrides private/ignore/include.  |
| `access`              | `"public" \| "restricted"`           | npm access level override                                                                             |
| `publishCommand`      | `string \| string[]`                 | Custom publish command(s). Supports `{{version}}` and `{{name}}` template variables.                  |
| `buildCommand`        | `string`                             | Build command to run before publishing                                                                |
| `registry`            | `string`                             | Custom npm registry URL                                                                               |
| `skipNpmPublish`      | `boolean`                            | Skip npm publish (use with `publishCommand` for non-npm publishing)                                   |
| `checkPublished`      | `string`                             | Command to check if version is published. Should output the version string. Used for non-npm targets. |
| `dependencyBumpRules` | `object`                             | Override global dependency bump rules for this package (or `false` to disable)                        |
| `cascadeTo`           | `Record<string, DependencyBumpRule>` | When this package bumps, cascade to these packages (supports globs)                                   |

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

- `trigger`: minimum bump level in the dependency that activates propagation. Values: `"major"`, `"minor"`, `"patch"`
- `bumpAs`: what bump to apply to the dependent. Values: `"major"`, `"minor"`, `"patch"`, `"match"` (same level as triggering bump)

A rule can also be `false` to disable propagation for that dep type entirely.

Note: dependency bump rules only apply in **Phase C** (proactive propagation). **Phase A** (out-of-range fixes) always runs with hardcoded behavior: peer deps get "match", regular deps get "patch", dev deps are skipped.

### Rule resolution order

When package A bumps and package B depends on A, bumpy looks for a Phase C rule in this order:

1. **Per-package dep type rule** — `dependencyBumpRules[depType]` on package B _(most specific)_
2. **Global dep type rule** — root config `dependencyBumpRules[depType]`
3. **Built-in defaults** _(least specific)_

Bump file cascades and `cascadeTo` config are separate from dependency bump rules and always apply.

### Built-in defaults (the key difference from changesets)

| Dependency type        | Phase C trigger | Phase C bumpAs | Phase A behavior        |
| ---------------------- | --------------- | -------------- | ----------------------- |
| `dependencies`         | patch           | patch          | patch (on out-of-range) |
| `peerDependencies`     | **major**       | **match**      | match (on out-of-range) |
| `devDependencies`      | _(disabled)_    | —              | _(skipped)_             |
| `optionalDependencies` | minor           | patch          | patch (on out-of-range) |

The critical difference: changesets bumps dependents to **major** when a peer dependency gets a **minor** bump. Bumpy's Phase A matches the triggering bump level for peer deps, and Phase C only triggers on major by default.

## CLI Reference

### `bumpy init`

Creates `.bumpy/` directory with default `_config.json` and a README.

### `bumpy add`

Create a new bump file.

| Flag                | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `--packages <list>` | Non-interactive: comma-separated `"name:bumpType"` pairs |
| `--message <text>`  | Bump file summary                                        |
| `--name <name>`     | Bump file filename (default: random adjective-noun)      |
| `--empty`           | Create an empty bump file (no packages, for CI skip)     |

Interactive mode prompts for: packages, bump type per package, cascade options, summary, and filename for the bump file.

### `bumpy status`

Show pending releases.

| Flag                  | Description                                                         |
| --------------------- | ------------------------------------------------------------------- |
| `--json`              | Full JSON output with `releases[]`, `bumpFiles[]`, `packageNames[]` |
| `--packages`          | One package name per line (for piping to other commands)            |
| `--bump <types>`      | Filter by bump type: `"major"`, `"minor,patch"`                     |
| `--filter <patterns>` | Filter by package name/glob: `"@myorg/*"`                           |
| `--verbose`           | Show bump file details                                              |

Exit codes: `0` = releases pending, `1` = no releases pending.

JSON output shape:

```json
{
  "changesets": [{ "id": "...", "summary": "...", "releases": [{ "name": "...", "type": "..." }] }],
  "releases": [
    {
      "name": "...",
      "type": "...",
      "oldVersion": "...",
      "newVersion": "...",
      "dir": "...",
      "changesets": [],
      "isDependencyBump": false,
      "isCascadeBump": false
    }
  ],
  "packageNames": ["pkg-a", "pkg-b"]
}
```

### `bumpy check`

Verify that all changed packages on the current branch have corresponding bump files. Compares files changed vs the base branch, maps them to managed packages, and exits non-zero if any are missing bump files.

Designed for pre-push hooks — no GitHub API needed.

```yaml
# lefthook.yml
pre-push:
  jobs:
    - name: bumpy-check
      run: bunx @varlock/bumpy check
```

### `bumpy version`

Apply all pending bump files: bump versions in `package.json`, update `CHANGELOG.md`, delete consumed bump files. Optionally creates a git commit if `commit: true` in config.

### `bumpy publish`

Publish packages with unpublished versions.

| Flag          | Description                             |
| ------------- | --------------------------------------- |
| `--dry-run`   | Preview without publishing              |
| `--tag <tag>` | npm dist-tag (`"next"`, `"beta"`, etc.) |
| `--no-push`   | Skip pushing git tags to remote         |

Default flow: detects PM → packs tarball (resolves workspace:/catalog: protocols) → publishes tarball with npm → creates git tags → pushes tags → creates GitHub releases (if `gh` CLI is available).

### `bumpy ci check`

PR check — reports pending bump files and optionally comments on the PR with the release plan.

| Flag                | Description                                                           |
| ------------------- | --------------------------------------------------------------------- |
| `--comment`         | Force PR commenting on/off (auto-detected in CI environments)         |
| `--fail-on-missing` | Exit 1 if no bump files found                                         |
| `--pat-comments`    | Post PR comments using `BUMPY_GH_TOKEN` instead of default `GH_TOKEN` |

Auto-detects PR number from `GITHUB_REF` in GitHub Actions. Also checks `BUMPY_PR_NUMBER` and `PR_NUMBER` env vars.

### `bumpy ci release`

Release automation — either creates a "Version Packages" PR or auto-publishes directly.

| Flag              | Description                                                    |
| ----------------- | -------------------------------------------------------------- |
| `--auto-publish`  | Version + publish directly instead of creating a PR            |
| `--tag <tag>`     | npm dist-tag for auto-publish mode                             |
| `--branch <name>` | Branch name for version PR (default: `bumpy/version-packages`) |
| `--pat-pr`        | Create/edit the version PR using `BUMPY_GH_TOKEN`              |

Default mode (`version-pr`): creates a branch, runs `bumpy version`, commits, and opens/updates a PR via `gh`. Merging that PR triggers publish.

Auto-publish mode: runs `bumpy version`, commits, pushes, then `bumpy publish` in one step.

### `bumpy migrate`

Migrate from `.changeset/` to `.bumpy/`.

| Flag      | Description                                                |
| --------- | ---------------------------------------------------------- |
| `--force` | Skip interactive prompts (don't ask to delete .changeset/) |

Migrates `.changeset/config.json` fields to `.bumpy/_config.json`, copies pending bump files, and prints key differences from changesets.

## Changelog Customization

The `changelog` config controls how CHANGELOG.md entries are formatted.

### Built-in formatters

```json
{ "changelog": "default" }
```

Simple format: version heading, date, bullet points from bump file summaries.

```json
{ "changelog": "github" }
{ "changelog": ["github", { "repo": "dmno-dev/bumpy" }] }
```

GitHub-enhanced: adds PR links and author attribution (`- Added feature (#123) by @user`). Looks up PRs via `gh` CLI by finding the commit that introduced each bump file.

### Custom formatter (TypeScript or JavaScript)

```json
{ "changelog": "./my-changelog.ts" }
{ "changelog": ["./my-changelog.ts", { "someOption": true }] }
```

A custom formatter exports a function that receives full context and returns the complete changelog entry:

```ts
// my-changelog.ts
import type { ChangelogContext } from '@varlock/bumpy';

export default function (ctx: ChangelogContext): string {
  const { release, changesets, date } = ctx;
  const lines = [`## [${release.newVersion}] - ${date}\n`];

  const relevant = changesets.filter((cs) => release.changesets.includes(cs.id));
  for (const cs of relevant) {
    if (cs.summary) lines.push(`- ${cs.summary.split('\n')[0]}`);
  }

  lines.push('');
  return lines.join('\n');
}
```

The `ChangelogContext` interface:

```ts
interface ChangelogContext {
  release: PlannedRelease; // name, type, oldVersion, newVersion, etc.
  changesets: Changeset[]; // all changesets (filter by release.changesets for relevant ones)
  date: string; // ISO date (YYYY-MM-DD)
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
    "publishCommand": ["bunx vsce publish", "bunx ovsx publish"]
  }
}
```

Custom commands support `{{version}}` and `{{name}}` template variables. Bumpy resolves `workspace:`/`catalog:` protocols in-place before running custom commands.

#### Publish detection

When running `bumpy publish` or `bumpy ci release`, bumpy checks which packages need publishing using a layered strategy:

1. **Custom `checkPublished` command** — if set, bumpy runs it and compares the output to the current version
2. **Non-npm packages** (`skipNpmPublish` or custom `publishCommand`) — checks for a git tag (`<name>@<version>`)
3. **Default (npm packages)** — checks the npm registry via `npm info`

For VS Code extensions, you can provide a check command:

```json
{
  "bumpy": {
    "skipNpmPublish": true,
    "publishCommand": "bunx vsce publish",
    "checkPublished": "bunx vsce show my-ext --json | jq -r '.versions[0].version'"
  }
}
```

Or simply rely on git tags (the default for non-npm packages) — no extra config needed.

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

Configure via per-package dependency bump rules:

```json
// In root .bumpy/_config.json
{
  "packages": {
    "@myorg/internal-*": {
      "dependencyBumpRules": {
        "dependencies": false
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
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx @varlock/bumpy ci check
        env:
          GH_TOKEN: ${{ github.token }}
```

```yaml
# .github/workflows/bumpy-release.yml — trusted publishing (OIDC, no secret needed)
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
```

Trusted publishing setup: configure each package on npmjs.com → Package Settings → Trusted Publishers → GitHub Actions.
Specify your org/user, repo, and the workflow filename. No NPM_TOKEN secret needed. Requires npm >= 11.5.1 (included in Node.js LTS).

Alternative: token-based auth (uses `NPM_TOKEN` secret instead of OIDC):

```yaml
# .github/workflows/bumpy-release.yml — token-based auth
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
```

### Non-interactive bump file creation (AI/CI)

```bash
bumpy add \
  --packages "@myorg/core:minor,@myorg/cli:patch" \
  --message "Added new API for encryption providers" \
  --name "add-encryption-api"
```

### Aggregate GitHub releases

By default, `bumpy publish` creates one GitHub release per package (requires `gh` CLI). To create a single aggregated release instead:

```json
// .bumpy/_config.json
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

1. Create `.bumpy/` and migrate settings to `_config.json`
2. Copy pending bump `.md` files
3. Optionally remove `.changeset/` directory

Key behavioral differences after migration:

- Out-of-range peer dep bumps match the triggering bump level (not always major)
- Use `none` to suppress a propagated bump
- Per-package config moves to `package.json["bumpy"]` instead of root config only

## AI Integration

Bumpy ships with an AI skill that teaches LLMs how to create bump files.

### Claude Code (plugin)

```bash
claude plugin install @varlock/bumpy
```

Then use `/bumpy:add-change` in Claude Code to create a bump file.

### OpenCode / Cursor / Codex (setup command)

```bash
# OpenCode (creates .opencode/commands/add-bumpy-change.md)
bumpy ai setup --target opencode

# Cursor (creates .cursor/rules/add-bumpy-change.mdc)
bumpy ai setup --target cursor

# Codex (creates .codex/add-bumpy-change.md)
bumpy ai setup --target codex
```

### Any AI tool (non-interactive CLI)

Any LLM can create bump files using the non-interactive CLI:

```bash
bumpy add \
  --packages "@myorg/core:minor,@myorg/cli:patch" \
  --message "Added new encryption API" \
  --name "add-encryption-api"
```

See the "Non-interactive bump file creation" section above for details.
