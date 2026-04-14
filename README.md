# @dmno-dev/bumpy

A modern monorepo versioning and changelog tool. Built as a replacement for [@changesets/changesets](https://github.com/changesets/changesets) — simpler, more flexible, and with sane defaults.

## Why?

Changesets is mature and widely adopted, but has stagnated. The community has hundreds of open issues around core design problems that are unlikely to be fixed without a rewrite. Bumpy addresses the biggest pain points:

### 1. Sane dependency bump propagation

Changesets hardcodes aggressive behavior: a **minor** bump on a package triggers a **major** bump on all packages that peer-depend on it. This is the #1 community complaint with 8+ open issues and no fix in sight.

Bumpy makes this **fully configurable** at multiple levels, with sensible defaults:
- **Global rules by dependency type** — e.g., peer dep bumps only propagate on major (not minor)
- **Per-package overrides** — in `package.json["bumpy"]`
- **Per-specific-dependency rules** — "when core bumps, bump me at X"
- **Source-side cascade rules** — "when I bump, cascade to `plugins/*`" (with glob support)
- **Per-changeset cascade overrides** — explicit downstream control in each bump file
- **Isolated bumps** — `minor-isolated` / `patch-isolated` skip propagation entirely

### 2. Custom publish commands

Changesets is hardcoded to `npm publish`. Bumpy supports per-package custom publish commands for VSCode extensions, Docker images, JSR, private registries, or anything else:

```json
{
  "bumpy": {
    "skipNpmPublish": true,
    "publishCommand": ["bun run package", "bunx vsce publish"]
  }
}
```

### 3. Non-interactive CLI

`bumpy add` works both interactively and fully non-interactively for CI/CD and AI assisted development:

```bash
bumpy add --packages "pkg-a:minor,pkg-b:patch-isolated" --message "Added X" --name "my-feature"
```

## Design Goals

- **Simple over clever** — one package, not a monorepo of tiny packages like changesets
- **Explicit intent** — developers declare what changed via changeset files (not inferred from commits)
- **Configurable propagation** — the dependency bump algorithm is the core differentiator, with 5 levels of rule resolution and glob pattern support throughout
- **Node.js compatible** — uses `node:fs`, `node:child_process`, etc. Developed with Bun but must run on Node.js too. Bun's standalone bundler can produce a binary for environments without either runtime.
- **All package managers** — detects and supports npm, pnpm, yarn, and bun workspaces
- **Minimal dependencies** — only `semver` and `js-yaml`

## Architecture

```
src/
  cli.ts                      # CLI entrypoint
  types.ts                    # All shared type definitions + defaults
  commands/
    init.ts                   # bumpy init — create .bumpy/ directory
    add.ts                    # bumpy add — create changeset (interactive + non-interactive)
    status.ts                 # bumpy status — show release plan (+ --json)
    version.ts                # bumpy version — apply changesets, bump versions, update changelogs
  core/
    config.ts                 # Load .bumpy/config.json + package.json["bumpy"], merge, validate
    workspace.ts              # Discover monorepo packages from workspace config (all PMs)
    dep-graph.ts              # Build dependency graph, query dependents, topological sort
    changeset.ts              # Parse/write changeset files (YAML frontmatter + markdown)
    release-plan.ts           # THE CORE ALGORITHM — assemble release plan with all propagation rules
    apply-release-plan.ts     # Write bumped versions to package.json, update changelogs, delete changesets
    changelog.ts              # Changelog entry generation
    semver.ts                 # Version bump utilities (wraps semver package)
  utils/
    fs.ts                     # node:fs/promises wrappers
    shell.ts                  # node:child_process wrappers
    logger.ts                 # Colored terminal output
    prompt.ts                 # Interactive prompts (node:readline)
    package-manager.ts        # Detect PM type, parse workspace globs
    names.ts                  # Random name generation for changeset files
```

## Config

Root config lives at `.bumpy/config.json`. Per-package config lives in `package-dir/package.json["bumpy"]`.

Changeset files (`.md`) also live in `.bumpy/`.

### Changeset file format

Simple format (same as changesets):
```yaml
---
"pkg-a": minor
"pkg-b": patch-isolated
---

Description of what changed and why.
```

Nested format with explicit cascade control:
```yaml
---
"@myorg/core":
  bump: minor
  cascade:
    "plugins/*": patch
    "@myorg/cli": minor
"@myorg/utils": patch
---

Added new encryption provider.
```

### Dependency bump algorithm

The release plan algorithm in `release-plan.ts` is the heart of bumpy:

1. **Collect** explicit bumps from changesets (highest wins, isolated if ALL changesets are isolated)
2. **Apply** fixed/linked groups
3. **Propagate** (iterative until stable):
   - Changeset-level cascade overrides (explicit, no trigger check)
   - Source-side `cascadeTo` config (with trigger threshold)
   - Dependency graph propagation with rule resolution:
     - `specificDependencyRules[depName]` on the dependent
     - `dependencyBumpRules[depType]` on the dependent
     - Global `dependencyBumpRules[depType]`
     - Built-in defaults
4. **Calculate** new versions

Default rules (the key difference from changesets):
- `dependencies`: trigger=patch, bumpAs=patch
- `peerDependencies`: trigger=major, bumpAs=major (**changesets does trigger=minor!**)
- `devDependencies`: trigger=none (never propagate)
- `optionalDependencies`: trigger=minor, bumpAs=patch

## Implementation Status

### Done (Phase 1 — Core MVP)
- [x] Type definitions and defaults
- [x] Config loading with 2-source merging (root + package.json)
- [x] Workspace discovery (npm, pnpm, yarn, bun)
- [x] Dependency graph
- [x] Changeset parsing (simple + nested with cascade)
- [x] Release plan algorithm with all propagation rules
- [x] Changelog generation
- [x] Apply release plan (bump versions, update changelogs, delete changesets)
- [x] CLI: init, add, status, version
- [x] 30 tests passing

### TODO (Phase 2 — Publish Pipeline)
- [ ] `bumpy publish` command
- [ ] Custom publish commands per package
- [ ] Git tagging
- [ ] Workspace protocol resolution before publish
- [ ] GitHub release creation (individual + aggregate)

### TODO (Phase 3 — Advanced)
- [ ] Prerelease mode (`bumpy pre enter/exit`)
- [ ] GitHub changelog generator (PR/author attribution)
- [ ] `bumpy migrate` from `.changeset/`
- [ ] Compatibility range management (smart range updates, explore explicit compat declarations)

### TODO (Phase 4 — CI/CD)
- [ ] GitHub Action
- [ ] PR status check / bot
- [ ] Bun standalone binary build

## Development

```bash
bun install
bun test
bun src/cli.ts --help
```
