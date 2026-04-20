# Configuration Reference

Bumpy is configured via `.bumpy/_config.json`, created by `bumpy init`. Per-package config can also be set in each `package.json` under the `"bumpy"` key.

## Global config (`.bumpy/_config.json`)

| Option                       | Type                                   | Default                          | Description                                                                         |
| ---------------------------- | -------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| `baseBranch`                 | `string`                               | `"main"`                         | Branch used for release comparisons                                                 |
| `access`                     | `"public" \| "restricted"`             | `"public"`                       | Default npm publish access level                                                    |
| `changelog`                  | `string \| [string, options]`          | `"default"`                      | Changelog formatter — `"default"`, `"github"`, or path to a custom formatter        |
| `fixed`                      | `string[][]`                           | `[]`                             | Package groups that always bump together to the same version                        |
| `linked`                     | `string[][]`                           | `[]`                             | Package groups that share the highest bump level                                    |
| `ignore`                     | `string[]`                             | `[]`                             | Package name globs to exclude from versioning                                       |
| `include`                    | `string[]`                             | `[]`                             | Package name globs to explicitly include (overrides `ignore` and `privatePackages`) |
| `privatePackages`            | `{ version, tag }`                     | `{ version: false, tag: false }` | Whether to version and/or create git tags for private packages                      |
| `updateInternalDependencies` | `"patch" \| "minor" \| "out-of-range"` | `"out-of-range"`                 | When to update internal dependency version ranges                                   |
| `dependencyBumpRules`        | `object`                               | see below                        | Controls how bumps propagate through dependency types                               |
| `aggregateRelease`           | `boolean \| { enabled, title }`        | `false`                          | Create a single GitHub release instead of one per package                           |
| `commit`                     | `boolean`                              | `false`                          | Auto-commit changes after `bumpy version`                                           |
| `publish`                    | `object`                               | see below                        | Publishing pipeline config                                                          |
| `gitUser`                    | `{ name, email }`                      | bumpy-bot                        | Git identity for CI commits                                                         |
| `versionPr`                  | `{ title, branch, preamble }`          | see below                        | Customize the version PR                                                            |
| `packages`                   | `object`                               | `{}`                             | Per-package config overrides (keyed by package name)                                |

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

### Publishing config

The `publish` object controls how packages are packed and published:

| Option               | Type                   | Default  | Description                                                           |
| -------------------- | ---------------------- | -------- | --------------------------------------------------------------------- |
| `packManager`        | `string`               | `"auto"` | Which package manager packs tarballs (`"auto"` detects from lockfile) |
| `publishManager`     | `string`               | `"npm"`  | Which tool runs `publish` (npm supports OIDC/provenance)              |
| `publishArgs`        | `string[]`             | `[]`     | Extra args passed to publish (e.g., `["--provenance"]`)               |
| `protocolResolution` | `"pack" \| "in-place"` | `"pack"` | How `workspace:` and `catalog:` protocols are resolved                |

### Version PR config

The `versionPr` object customizes the PR that `bumpy ci release` creates:

| Option     | Type     | Default                    | Description                           |
| ---------- | -------- | -------------------------- | ------------------------------------- |
| `title`    | `string` | `"🐸 Versioned release"`   | PR title                              |
| `branch`   | `string` | `"bumpy/version-packages"` | Branch name for the version PR        |
| `preamble` | `string` | —                          | HTML content prepended to the PR body |

## Per-package config

Per-package settings can be defined in two places:

1. In `.bumpy/_config.json` under the `packages` key (keyed by package name)
2. In each package's `package.json` under the `"bumpy"` key

`package.json` settings take precedence over global config.

| Option                | Type                       | Description                                                             |
| --------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `managed`             | `boolean`                  | Opt this package in or out of versioning                                |
| `access`              | `"public" \| "restricted"` | Override the global access level                                        |
| `publishCommand`      | `string \| string[]`       | Custom command(s) to publish this package (replaces npm publish)        |
| `buildCommand`        | `string`                   | Command to run before publishing                                        |
| `registry`            | `string`                   | Custom npm registry URL                                                 |
| `skipNpmPublish`      | `boolean`                  | Don't publish to npm (still creates git tags)                           |
| `checkPublished`      | `string`                   | Custom command that outputs the currently published version             |
| `dependencyBumpRules` | `object`                   | Per-package override for dependency propagation rules                   |
| `cascadeTo`           | `object`                   | Explicit cascade targets — glob pattern mapped to `{ trigger, bumpAs }` |

### Example: custom publish for a VSCode extension

```json
{
  "name": "my-vscode-extension",
  "bumpy": {
    "publishCommand": "vsce publish",
    "skipNpmPublish": true
  }
}
```

### Example: cascade from core to plugins

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

## Changelog formatters

Set `changelog` in config to control how changelog entries are generated. Built-in options are `"default"` and `"github"`, or you can provide a path to a custom formatter module.

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
  "aggregateRelease": true,
  "packages": {
    "@myorg/vscode-extension": {
      "publishCommand": "vsce publish",
      "skipNpmPublish": true
    }
  }
}
```
