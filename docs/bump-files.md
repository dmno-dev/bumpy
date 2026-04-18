# Bump File Format

Bump files are small markdown files that declare which packages changed and at what level. They live in `.bumpy/` and are consumed (deleted) when you run `bumpy version` (usually automated in CI).

## Basic syntax

A bump file has YAML frontmatter mapping package names to bump levels, and a markdown body that becomes the changelog entry:

```markdown
---
'@myorg/core': minor
'@myorg/utils': patch
---

Added user language preference to the core config.
Fixed locale fallback logic in utils.
```

## Bump levels

| Level            | When to use                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `major`          | Breaking changes                                                                                                             |
| `minor`          | New features (backwards-compatible)                                                                                          |
| `patch`          | Bug fixes, minor improvements                                                                                                |
| `patch-isolated` | Like `patch`, but skips dependency propagation (Phase C). Useful for internal fixes that shouldn't trigger downstream bumps. |
| `none`           | Suppresses a bump — used in cascades to exclude specific packages from propagation                                           |

## Cascade control

You can explicitly push bumps to downstream packages using the nested object format:

```markdown
---
'@myorg/core':
  bump: minor
  cascade:
    '@myorg/plugin-*': patch
    '@myorg/react': minor
---

New plugin API in core.
```

Cascade targets support glob patterns. This is useful when a change in one package should always trigger releases of specific dependents, regardless of the default propagation rules.

## Creating bump files

Bump files are just markdown files — you can create them by hand, write them in your editor, or use the `bumpy add` CLI helper. Any `.md` file in `.bumpy/` (other than `README.md` and `_config.json`) is treated as a bump file.

### By hand

Create a file like `.bumpy/add-user-language.md` with the frontmatter and description. Name it whatever makes sense — a short description of the change is ideal. The filename doesn't affect behavior, it's just for human readability.

### With `bumpy add`

```bash
bumpy add                                                # interactive — walks you through selecting packages and bump levels
bumpy add --packages "core:minor,utils:patch" --message "Added new features"  # non-interactive
```

Flags:

- `--packages <list>` — comma-separated `name:level` pairs
- `--message <text>` — changelog description
- `--name <name>` — set the filename (auto-slugified). If omitted, a random name is generated.
- `--empty` — create an empty bump file (marks a PR as intentionally having no releases)

### From conventional commits

```bash
bumpy generate
```

Scans git history and auto-creates bump files from conventional commit messages:

- `feat:` → minor
- `fix:`, `perf:`, `refactor:`, etc. → patch
- `feat!:` or `BREAKING CHANGE:` → major

Commit scopes are mapped to package names automatically.

## File naming

Bump file names are purely for human readability — bumpy doesn't derive any meaning from them. Use whatever makes sense for your workflow:

- **Descriptive names** like `add-user-language.md` or `fix-login-timeout.md` make it easy to see what's pending at a glance
- **Auto-generated names** (what `bumpy add` produces when `--name` is omitted) are fine when you don't want to think about naming

## Empty bump files

For PRs that intentionally don't need a release (docs, CI changes, etc.), create an empty bump file:

```bash
bumpy add --empty --name "docs-update"
```

This prevents `bumpy ci check` from warning about missing bump files.

## Multiple bump files

A project can have many pending bump files at once — one per PR is typical. When `bumpy version` runs, all pending bump files are merged into a single release plan. If multiple bump files touch the same package, the highest bump level wins.
