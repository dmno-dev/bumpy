# CLI Reference

All commands can be run via `bunx @varlock/bumpy <command>` (or just `bunx bumpy` if installed locally). Alternatively, you can invoke it via a package.json script (e.g., `bun run bumpy <command>`).

## `bumpy init`

Initialize the `.bumpy/` config directory. If `.changeset/` is detected, it automatically migrates — renaming the directory to `.bumpy/`, converting config, keeping pending bump files, and offering to uninstall `@changesets/cli`. Also ensures `@varlock/bumpy` is installed as a dev dependency and warns about changeset references in GitHub workflows.

```bash
bumpy init
bumpy init --force    # skip interactive prompts
```

| Flag      | Description              |
| --------- | ------------------------ |
| `--force` | Skip interactive prompts |

## `bumpy add`

Create a bump file interactively or non-interactively.

```bash
bumpy add                                                # interactive
bumpy add --packages "core:minor,utils:patch" --message "Added features"  # non-interactive
bumpy add --empty --name "docs-only-pr"                  # empty (no releases)
```

| Flag                | Description                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| `--packages <list>` | Comma-separated `name:level` pairs                                         |
| `--message <text>`  | Changelog description                                                      |
| `--name <name>`     | Bump file filename (auto-slugified)                                        |
| `--empty`           | Create an empty bump file (marks a PR as intentionally having no releases) |

## `bumpy status`

Preview the release plan based on pending bump files.

```bash
bumpy status
bumpy status --json
bumpy status --packages
bumpy status --bump major --filter "@myorg/*"
bumpy status --verbose
```

| Flag               | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `--json`           | Output the full release plan as JSON                           |
| `--packages`       | Output only package names, one per line (useful for scripting) |
| `--bump <types>`   | Filter by bump type, e.g. `"major"` or `"minor,patch"`         |
| `--filter <names>` | Filter by package name or glob                                 |
| `--verbose`        | Show bump file details and summaries                           |

Exits with code `0` if releases are pending, `1` if none.

## `bumpy version`

Consume all pending bump files and apply the release plan:

1. Reads bump files and computes the release plan (including dependency propagation)
2. Updates `package.json` versions
3. Generates CHANGELOG.md entries
4. Deletes consumed bump files
5. Updates the lockfile
6. Optionally commits (if `commit: true` in config)

```bash
bumpy version
```

## `bumpy publish`

Publish packages that have been versioned but not yet published. For each package, bumpy packs a tarball (resolving `workspace:` and `catalog:` protocols), publishes it, creates a git tag, and after all packages are published, pushes tags and creates GitHub releases.

```bash
bumpy publish
bumpy publish --dry-run
bumpy publish --tag beta
bumpy publish --filter "@myorg/*"
```

| Flag               | Description                                               |
| ------------------ | --------------------------------------------------------- |
| `--dry-run`        | Preview what would be published without actually doing it |
| `--tag <tag>`      | npm dist-tag (e.g., `next`, `beta`)                       |
| `--no-push`        | Skip pushing git tags to the remote                       |
| `--filter <names>` | Only publish matching packages (supports globs)           |

**How bumpy detects unpublished packages:**

1. Custom `checkPublished` command (if configured per-package — see [`allowCustomCommands`](./configuration.md#custom-commands-and-allowcustomcommands))
2. Git tags (for packages with `skipNpmPublish` or custom `publishCommand`)
3. npm registry query (default)

## `bumpy check`

Verify that changed packages on the current branch have corresponding bump files. Designed for pre-push hooks — compares your branch to the base branch, maps changed files to packages.

By default, exits non-zero only if **no** bump files exist at all (matching changesets behavior). Use `--strict` to require every changed package to be covered.

```bash
bumpy check
bumpy check --strict
bumpy check --no-fail
```

| Flag        | Description                                                |
| ----------- | ---------------------------------------------------------- |
| `--strict`  | Fail if any changed package is not covered by a bump file  |
| `--no-fail` | Warn only, never exit non-zero (useful for advisory hooks) |

No GitHub API needed.

## `bumpy generate`

Auto-create bump files from commits on the current branch. Works with any commit style — conventional commits get enhanced bump-level detection, while all other commits are mapped to packages via changed file paths (defaulting to `patch`).

```bash
bumpy generate
bumpy generate --dry-run
bumpy generate --from v1.0.0   # override: scan from a specific ref instead of branch base
```

| Flag            | Description                                                              |
| --------------- | ------------------------------------------------------------------------ |
| `--from <ref>`  | Git ref to scan from (default: branch point from `baseBranch` in config) |
| `--dry-run`     | Preview without creating files                                           |
| `--name <name>` | Bump file filename                                                       |

**How commits are mapped:**

1. **Conventional commits** (`type(scope): description`) use the commit type for bump level and the scope to resolve to a package name:
   - `feat:` → minor
   - `fix:`, `perf:`, `refactor:`, `docs:`, `style:`, `test:`, `build:`, `ci:`, `chore:` → patch
   - `feat!:` or `BREAKING CHANGE:` → major
2. **All other commits** (including scopeless conventional commits) are mapped to packages by detecting which files changed in the commit and matching them to package directories. These default to `patch`.

When multiple commits affect the same package, the highest bump level wins.

## `bumpy ci check`

CI command for PR checks. Computes the release plan from bump files changed in the current PR and posts/updates a comment on the PR.

```bash
bumpy ci check
bumpy ci check --strict
bumpy ci check --no-fail
```

| Flag        | Description                                                      |
| ----------- | ---------------------------------------------------------------- |
| `--comment` | Force PR comment on or off (default: auto-detect CI environment) |
| `--strict`  | Fail if any changed package is not covered by a bump file        |
| `--no-fail` | Warn only, never exit non-zero                                   |

Requires `GH_TOKEN` environment variable (automatically available in GitHub Actions).

## `bumpy ci release`

CI command for releases. Has two modes:

**Version PR mode (default):** If pending bump files exist, creates or updates a "Version Packages" PR with all version bumps and changelog updates. If the current push is the Version Packages PR being merged, publishes the new versions, creates git tags, and creates GitHub releases.

**Auto-publish mode (`--auto-publish`):** Versions and publishes directly on merge without an intermediate PR.

```bash
bumpy ci release
bumpy ci release --auto-publish
bumpy ci release --auto-publish --tag beta
```

| Flag              | Description                                                |
| ----------------- | ---------------------------------------------------------- |
| `--auto-publish`  | Version + publish directly instead of creating a PR        |
| `--tag <tag>`     | npm dist-tag (for `--auto-publish`)                        |
| `--branch <name>` | Version PR branch name (default: `bumpy/version-packages`) |

Requires `GH_TOKEN`. When `BUMPY_GH_TOKEN` is set, it is automatically used to push the version branch and create/edit the PR so that PR workflows trigger (see [GitHub Actions setup](github-actions.md#token-setup)).

## `bumpy ci setup`

Interactive guide to set up `BUMPY_GH_TOKEN` for CI. Walks through creating a fine-grained PAT or GitHub App token and storing it as a repository secret.

```bash
bumpy ci setup
```

## `bumpy ai setup`

Install an AI skill for creating bump files in supported coding tools.

```bash
bumpy ai setup --target claude
bumpy ai setup --target opencode
bumpy ai setup --target cursor
bumpy ai setup --target codex
```

| Flag              | Description                                |
| ----------------- | ------------------------------------------ |
| `--target <tool>` | `claude`, `opencode`, `cursor`, or `codex` |

For Claude Code, this runs `claude plugin install @varlock/bumpy` under the hood. For other targets, it copies a command/rule file into your project.
