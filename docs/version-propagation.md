# How bumpy calculates version bumps

When you run `bumpy version` (or `bumpy status` to preview), bumpy reads all pending bump files and builds a **release plan** — a list of packages to bump and by how much. This document explains the full algorithm, including how bumps propagate to dependent packages and the available settings.

## Overview

After collecting explicit bumps from bump files, bumpy runs a **propagation loop** that repeats until stable:

- **Phase A** — fix out-of-range dependencies (always runs)
- **Phase B** — enforce fixed/linked group constraints (optional/advanced)
- **Phase C** — apply cascades and proactive propagation rules (optional/advanced)

## Phase A: Out-of-range check

For every package in the release plan, bumpy checks each dependent's declared version range. If the new version would fall **outside** that range, the dependent must be bumped so its `package.json` stays valid.

The bump type applied to the dependent depends on the dependency type:

| Dependency type        | Bump applied to dependent   | Why                                                                  |
| ---------------------- | --------------------------- | -------------------------------------------------------------------- |
| `peerDependencies`     | matches the triggering bump | Proportional — a minor bump on the dep → minor bump on the dependent |
| `dependencies`         | `patch`                     | Internal detail — consumers don't see it                             |
| `optionalDependencies` | `patch`                     | Internal detail — consumers don't see it                             |
| `devDependencies`      | _(skipped)_                 | Doesn't affect published consumers                                   |

For peer deps, "matches the triggering bump" means if `core` gets a minor bump that breaks the range, `plugin` also gets a minor bump. This keeps version bumps proportional — especially important for `0.x` packages where `^` ranges cause minor bumps to go out of range frequently.

This phase is a **safety net** — it cannot be skipped. It ensures that published packages always have valid dependency ranges.

### `workspace:` protocol resolution

Workspace protocol shorthands (`workspace:^`, `workspace:~`, `workspace:*`) are resolved to actual semver ranges before checking satisfaction. The "current version" used is the dependency's version **before** bumping — we're checking whether the _new_ (post-bump) version still satisfies the _existing_ range:

| In `package.json` | Resolved to          | Example (dep at `1.2.0`)   |
| ----------------- | -------------------- | -------------------------- |
| `workspace:^`     | `^<currentVersion>`  | `^1.2.0`                   |
| `workspace:~`     | `~<currentVersion>`  | `~1.2.0`                   |
| `workspace:*`     | _(always satisfied)_ | never triggers propagation |

This resolution is only for range checking — bumpy does not modify the `workspace:^` string in the source `package.json`. At publish time, these protocols are resolved to real ranges either by the package manager (in the default `pack` mode) or by bumpy itself (in `in-place` mode or when using custom publish commands).

Full ranges like `workspace:^1.2.0` are resolved by stripping the `workspace:` prefix.

`catalog:` protocol references (used by pnpm catalogs) are always treated as satisfied — bumpy cannot resolve the catalog to check the actual range, so it never triggers propagation through catalog deps.

### `^0.x` caret ranges

npm's `^` operator behaves differently for `0.x` versions:

| Range    | Means            | Example                         |
| -------- | ---------------- | ------------------------------- |
| `^1.2.3` | `>=1.2.3 <2.0.0` | Minor/patch bumps stay in range |
| `^0.2.3` | `>=0.2.3 <0.3.0` | **Minor bumps break the range** |
| `^0.0.3` | `>=0.0.3 <0.0.4` | **Patch bumps break the range** |

This means a **minor** bump on a `0.x` package with `^0.x` peer deps will break the range. Since Phase A matches the triggering bump for peer deps, the dependent also gets a **minor** bump — but if the dependent is at `1.x+`, that minor bump is disproportionate to what's really just an internal dependency update. Bumpy warns when this happens.

> **Tip:** If you're seeing unexpected propagation from `0.x` peer deps, consider using explicit ranges (e.g. `workspace:>=0.2.0` or `>=0.2.0`) instead of `workspace:^` to widen the range and reduce breakage.

## Phase B: Fixed and linked groups (optional)

These constraints help keep a group of related packages arbitrarily in sync. This config can be set in root `.bumpy/_config.json` file, and package names can be names or glob patterns. Note that each setting is an array of arrays, since you can have multiple groups.

### Fixed groups

Packages in a `fixed` group always share the **same version number**. When any package in the group bumps, all packages get the highest bump level.

```json
{ "fixed": [["@myorg/core", "@myorg/types"]] }
```

Example: propagation bumps `@myorg/types` as patch → `@myorg/core` also gets a patch bump to stay in sync.

### Linked groups

Packages in a `linked` group share the **same bump level** but keep independent version numbers. Only packages already in the release plan are affected — linked groups don't pull in packages that have no bump files. Entries can be specific names or glob patterns.

```json
{ "linked": [["@myorg/plugin-*"]] }
```

## Example: multi-level propagation

`core` gets a minor bump → `utils` has `^1.0.0` dep on `core`, goes out of range (Phase A) → `utils` gets a patch bump → fixed group pulls in `types` to match (Phase B) → `app` depends on `types` and goes out of range (Phase A, next iteration) → `app` gets a patch bump → stable.

### Phase C: Proactive propagation (optional)

Most users don't need this, but bumpy provides flexible settings for more complex monorepo workflows.

Beyond fixing broken ranges, you may want dependents to re-release even when their ranges are still satisfied — for example, to ensure consumers always get the latest internal dependency versions.

#### Enabling proactive propagation

Set `updateInternalDependencies` in `.bumpy/_config.json`:

| Value                      | Phase A (out-of-range) | Phase C (proactive)                                         |
| -------------------------- | ---------------------- | ----------------------------------------------------------- |
| `"out-of-range"` (default) | Yes                    | No                                                          |
| `"patch"`                  | Yes                    | Yes — triggers when any dependency bumps (patch or higher)  |
| `"minor"`                  | Yes                    | Yes — triggers only when a dependency bumps minor or higher |

#### Dependency bump rules

When Phase C is active, **dependency bump rules** control which dependency types trigger proactive bumps and what bump level to apply.
Each rule is either `false` (disabled) or an object with two fields:

- `trigger` — minimum bump level in the dependency that activates propagation (`"major"`, `"minor"`, or `"patch"`)
- `bumpAs` — what bump to apply to the dependent (`"major"`, `"minor"`, `"patch"`, or `"match"`)

**Global rules** are set in `.bumpy/_config.json`. The following are the built-in defaults — you only need to specify overrides:

```json
{
  "dependencyBumpRules": {
    "dependencies": { "trigger": "patch", "bumpAs": "patch" },
    "peerDependencies": { "trigger": "major", "bumpAs": "match" },
    "devDependencies": false,
    "optionalDependencies": { "trigger": "minor", "bumpAs": "patch" }
  }
}
```

**Per-package overrides** can be set in `package.json["bumpy"]` to override the global rules for a specific package (as a dependent):

```json
{
  "bumpy": {
    "dependencyBumpRules": {
      "devDependencies": { "trigger": "patch", "bumpAs": "patch" }
    }
  }
}
```

For example, a private app might want devDeps to propagate because they're bundled at build time, even though the global default disables devDep propagation.

**Rule resolution order** (when package A bumps and package B depends on A):

1. `dependencyBumpRules[depType]` on package B _(most specific)_
2. `dependencyBumpRules[depType]` in root config
3. Built-in defaults _(least specific)_

#### `cascadeTo` config

Configured on the source package in `package.json["bumpy"]` to push bumps to other packages when it bumps. Keys are package names or glob patterns:

```json
{
  "bumpy": {
    "cascadeTo": {
      "@myorg/plugin-*": { "trigger": "minor", "bumpAs": "patch" },
      "@myorg/cli": { "trigger": "patch", "bumpAs": "patch" }
    }
  }
}
```

Unlike dependency bump rules (configured on the _dependent_), `cascadeTo` is configured on the _source_ — useful for expressing "when I change, these downstream packages should also release."

`cascadeTo` is checked separately from dependency bump rules and can add bumps beyond what the rules produce. All keys support glob patterns (`*`, `**`).

### Per-bump-file overrides

These are set directly in bump files for one-off control over a specific release.

**`none`** — suppresses a bump on a package that would otherwise be included via propagation. If skipping the bump would leave a dependent's range broken, bumpy throws an error.

```yaml
---
'@myorg/core': minor
'@myorg/plugin-a': none
---
```

**Bump-file-level cascades** — explicitly cascade bumps to other packages with glob support. The difference from listing packages directly in the bump file is that cascaded packages are marked as dependency bumps (not direct changes), which affects how they appear in changelogs and PR comments. These always apply (no trigger threshold check):

```yaml
---
'@myorg/core':
  bump: minor
  cascade:
    '@myorg/plugin-*': patch
---
```

Compare with listing packages directly — these are treated as independent changes and each gets the bump file's summary in their changelog:

```yaml
---
'@myorg/core': minor
'@myorg/plugin-a': patch
'@myorg/plugin-b': patch
---
```

> **Note:** `none` and bump-file-level cascades are not available in the interactive `bumpy add` UI — they are power-user features for bump files and the `--packages` CLI flag.
