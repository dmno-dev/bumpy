# Changelog

## 0.1.0

_2026-04-18_

- Preserve package.json formatting when bumping versions
  Instead of re-serializing the entire file with `JSON.stringify`, version bumps and dependency range updates now use targeted string replacements. This prevents reformatting issues like inline arrays being expanded to multi-line, indentation style changes, and other unnecessary churn.
- Restructured version propagation into Phase A/B/C architecture. Phase A (out-of-range fixes) always runs — peer deps now match the triggering bump level instead of always forcing major. Added workspace:^ protocol resolution for range checking. Removed minor-isolated and specificDependencyRules. Added none bump type and patch-isolated validation. Added warnings for ^0.x peer dep propagation and workspace:\* on peer deps.

## 0.0.2

_2026-04-15_

- Security hardening: eliminate shell injection vulnerabilities across all CLI commands
  - Replace shell string interpolation with `execFile`-based argument arrays (`runArgs`/`runArgsAsync`) throughout the codebase, preventing command injection via branch names, PR numbers, config values, package names, and registry URLs
  - Add input validation for git branch names and PR numbers from environment variables
  - Remove broken `escapeShell` function in favor of shell-free execution
  - Use `sq()` single-quote escaping for template substitutions in user-defined publish commands
  - Restrict dynamic changelog formatter imports to paths within the project root
  - Reduce changeset filename collisions by using three-word random names
- Fix git tag pushing and GitHub release creation
  - Use `git push --tags` instead of `--follow-tags` so lightweight tags are actually pushed to the remote
  - Pass `--target` commit SHA to `gh release create` as a fallback in case tags haven't propagated
- Revamp interactive prompts using `@clack/prompts` for a much nicer CLI UX.
  - `bumpy add` now uses arrow-key navigation, validation, grouped intro/outro framing, and a summary note
  - `bumpy migrate` cleanup prompt uses a spinner and intro/outro
  - Clean Ctrl-C / Esc cancellation on every prompt (no more stack traces)
  - Swapped `ansis` → `picocolors` to avoid bundling two color libraries
- Rework CI check PR comment
  - Restyle with frog images matching the version PR description
  - Filter to only changesets added/modified in the PR, not all pending changesets
  - Add links to view diff and edit each changeset file on GitHub
  - Add "click to add changeset" link for GitHub's file creation UI
  - Detect package manager for correct CLI instructions
  - Fix comment update using correct REST API numeric IDs and stdin flag
- Enhance GitHub changelog formatter with PR/commit links and contributor attribution.
  - Add commit hash links alongside PR links in changelog entries
  - Add "Thanks @username!" attribution (matching `@changesets/changelog-github` format)
  - Add `internalAuthors` option to suppress thanks for team members
  - Support metadata overrides in changeset summaries (`pr:`, `commit:`, `author:` lines)
  - Linkify bare `#123` issue references in summary text
  - Auto-detect repo slug from `gh` CLI when not configured
- Support custom token for triggering CI on version PRs
  - Add `BUMPY_GH_TOKEN` env var support — when set, bumpy pushes the version branch using the custom token, bypassing GitHub's anti-recursion guard so PR workflows fire automatically
  - Add `bumpy ci setup` interactive command to help create a fine-grained PAT or GitHub App and store it as a repo secret
  - When no custom token is set, log a warning with setup instructions

## 0.0.1

_2026-04-15_

- Initial release of bumpy - a modern monorepo versioning and changelog tool.
  - Interactive and non-interactive changeset creation
  - Flexible dependency bump propagation with cascade control
  - Isolated bump support to skip dependency propagation
  - Fixed and linked package group strategies
  - Pluggable changelog formatters
  - Conventional commits bridge for automatic changeset generation
  - GitHub CI integration for PR checks and automated releases
  - Migration path from @changesets/cli
  - AI skill for Claude Code integration
