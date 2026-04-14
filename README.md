# @varlock/bumpy

A modern monorepo versioning and changelog tool. Built as a replacement for [@changesets/changesets](https://github.com/changesets/changesets) — simpler, more flexible, and with sane defaults.

## Why?

Changesets is mature and widely adopted, but has stagnated. The community has hundreds of open issues around core design problems that are unlikely to be fixed without a rewrite. Bumpy addresses the biggest pain points:

### Sane dependency bump propagation

Changesets hardcodes aggressive behavior: a **minor** bump on a package triggers a **major** bump on all packages that peer-depend on it. This is the #1 community complaint with 8+ open issues and no fix in sight.

Bumpy makes this **fully configurable** at multiple levels, with sensible defaults:

- **Global rules by dependency type** — e.g., peer dep bumps only propagate on major (not minor)
- **Per-package overrides** — in `package.json["bumpy"]`
- **Per-specific-dependency rules** — "when core bumps, bump me at X"
- **Source-side cascade rules** — "when I bump, cascade to `plugins/*`" (with glob support)
- **Per-changeset cascade overrides** — explicit downstream control in each bump file
- **Isolated bumps** — `minor-isolated` / `patch-isolated` skip propagation entirely

### Custom publish commands

Changesets is hardcoded to `npm publish`. Bumpy supports per-package custom publish commands for VSCode extensions, Docker images, JSR, private registries, or anything else.

### Flexible package management

Changesets treats all private packages the same — either version them all or none. Bumpy lets you include/exclude any package individually via per-package config (`managed: true/false`), glob-based `include`/`ignore` lists, or the `privatePackages` setting.

### Non-interactive CLI

`bumpy add` works both interactively and fully non-interactively for CI/CD and AI-assisted development.

### Pack-then-publish

By default, bumpy uses your package manager to pack a tarball (resolving `workspace:` and `catalog:` protocols) and then publishes the tarball with `npm publish` (supporting OIDC/provenance). Fully configurable.

## Design Goals

- **Simple over clever** — one package, not a monorepo of tiny packages
- **Explicit intent** — developers declare what changed via changeset files (not inferred from commits)
- **Configurable propagation** — the dependency bump algorithm is the core differentiator
- **Node.js compatible** — developed with Bun but runs on Node.js too
- **All package managers** — npm, pnpm, yarn, and bun workspaces
- **Minimal dependencies** — only `semver` and `js-yaml`

## Getting Started

```bash
# Install
bun add -d @varlock/bumpy  # or npm/pnpm/yarn

# Initialize
bumpy init

# Create a changeset
bumpy add

# Preview releases
bumpy status

# Apply changesets
bumpy version

# Publish
bumpy publish
```

## CI / GitHub Actions

No separate action to install — just call `bumpy ci` directly in your workflows.

**PR check** — comments on PRs with a release plan:

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
      - run: bunx @varlock/bumpy ci check
        env:
          GH_TOKEN: ${{ github.token }}
```

**Release** — create a "Version Packages" PR on merge to main:

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
      id-token: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx @varlock/bumpy ci release
        env:
          GH_TOKEN: ${{ github.token }}
```

Or use `bumpy ci release --auto-publish` to version + publish directly without a PR.

## AI Integration

Bumpy ships with an AI skill that teaches LLMs how to create changesets.

```bash
# Claude Code — install as a plugin
claude plugin install @varlock/bumpy
# then use /bumpy:add-change

# OpenCode / Cursor / Codex — copy a command file into your project
bumpy ai setup --target opencode
bumpy ai setup --target cursor
bumpy ai setup --target codex
```

The skill teaches the AI to examine git changes, identify affected packages, choose bump levels, and run `bumpy add` with the right arguments.

## Documentation

See [llms.md](./llms.md) for the full configuration reference, CLI reference, and usage examples.

## Development

```bash
bun install
bun test
bun src/cli.ts --help
```

## Implementation Status

- [x] Core release plan algorithm with configurable dependency propagation
- [x] Isolated bumps, cascade rules, fixed/linked groups
- [x] Changeset parsing (simple + nested with cascade)
- [x] Workspace discovery (npm, pnpm, yarn, bun)
- [x] Catalog support (pnpm-workspace.yaml + package.json)
- [x] CLI: init, add, status (with --json/--packages/--filter), version, publish
- [x] Pack-then-publish pipeline with custom command support
- [x] Fine-grained package include/exclude with glob support
- [x] Migration from changesets (`bumpy migrate`)
- [x] GitHub releases (individual + aggregate)
- [x] CI commands (`bumpy ci check` / `bumpy ci release`) — no separate action needed
- [x] Conventional commits bridge (`bumpy generate`)
- [x] Pluggable changelog formatters (default, github, custom .ts/.js)
- [x] AI integration (Claude Code plugin + `bumpy ai setup` for OpenCode, Cursor, Codex)
- [x] 47 tests passing
- [ ] Prerelease mode (deferred — use pkg.pr.new for preview packages)
- [ ] Bun standalone binary build
