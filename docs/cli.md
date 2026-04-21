# CLI Reference

All commands can be run via `bunx @varlock/bumpy <command>` or, (or just `bunx bumpy` if installed locally). Alternatively, you can invoke it via a package.json script (e.g., `bun run bumpy <command>`).

## `bumpy init`

Create the `.bumpy/` config directory with default settings.

```bash
bumpy init
```

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

Verify that all changed packages on the current branch have corresponding bump files. Designed for pre-push hooks — compares your branch to the base branch, maps changed files to packages, and exits non-zero if any are missing.

```bash
bumpy check
```

No flags. No GitHub API needed.

## `bumpy generate`

Auto-create bump files from conventional commit messages in git history.

```bash
bumpy generate
bumpy generate --from v1.0.0
bumpy generate --dry-run
```

| Flag            | Description                                                       |
| --------------- | ----------------------------------------------------------------- |
| `--from <ref>`  | Git ref to scan from (default: auto-detect from last version tag) |
| `--dry-run`     | Preview without creating files                                    |
| `--name <name>` | Bump file filename                                                |

**Commit mapping:**

- `feat:` → minor
- `fix:`, `perf:`, `refactor:`, `docs:`, `style:`, `test:`, `build:`, `ci:`, `chore:` → patch
- `feat!:` or `BREAKING CHANGE:` → major

Commit scopes (e.g., `feat(core):`) are mapped to package names automatically.

## `bumpy ci check`

CI command for PR checks. Computes the release plan from bump files changed in the current PR and posts/updates a comment on the PR.

```bash
bumpy ci check
bumpy ci check --fail-on-missing
```

| Flag                | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `--comment`         | Force PR comment on or off (default: auto-detect CI environment) |
| `--fail-on-missing` | Exit 1 if changed packages have no bump files                    |
| `--pat-comments`    | Post PR comments using `BUMPY_GH_TOKEN` instead of `GH_TOKEN`    |

Requires `GH_TOKEN` environment variable. The `--pat-comments` flag requires `BUMPY_GH_TOKEN` — use it when the token belongs to a dedicated automation account (bot user). If you're using a developer's personal PAT, leave this off so comments appear from `github-actions[bot]`.

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
| `--pat-pr`        | Create/edit the version PR using `BUMPY_GH_TOKEN`          |

Requires `GH_TOKEN`. Optionally uses `BUMPY_GH_TOKEN` to push the version branch so PR workflows trigger (see [GitHub Actions setup](github-actions.md#token-setup)). The `--pat-pr` flag additionally uses `BUMPY_GH_TOKEN` to create/edit the PR itself — use it when the token belongs to a dedicated automation account (bot user). If you're using a developer's personal PAT, leave this off so the PR is authored by `github-actions[bot]` and the developer can still approve it.

## `bumpy ci setup`

Interactive guide to set up `BUMPY_GH_TOKEN` for CI. Walks through creating a fine-grained PAT or GitHub App token and storing it as a repository secret.

```bash
bumpy ci setup
```

## `bumpy migrate`

Convert from changesets (`.changeset/`) to bumpy (`.bumpy/`). Migrates config and pending changeset files.

```bash
bumpy migrate
bumpy migrate --force
```

| Flag      | Description               |
| --------- | ------------------------- |
| `--force` | Skip cleanup confirmation |

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
