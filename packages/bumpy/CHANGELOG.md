# Changelog

## 1.0.0

_2026-04-21_

- [#13](https://github.com/dmno-dev/bumpy/pull/13) [`16ca818`](https://github.com/dmno-dev/bumpy/commit/16ca8184ceccecf4c9d1bfe396338cb695152307) - Preserve package.json formatting when bumping versions
  Instead of re-serializing the entire file with `JSON.stringify`, version bumps and dependency range updates now use targeted string replacements. This prevents reformatting issues like inline arrays being expanded to multi-line, indentation style changes, and other unnecessary churn.
- [#14](https://github.com/dmno-dev/bumpy/pull/14) [`920dd29`](https://github.com/dmno-dev/bumpy/commit/920dd2995f30b21f72df3f840d3446c55371c716) - Restructured version propagation into Phase A/B/C architecture. Phase A (out-of-range fixes) always runs — peer deps now match the triggering bump level instead of always forcing major. Added workspace:^ protocol resolution for range checking. Removed minor-isolated and specificDependencyRules. Added none bump type and patch-isolated validation. Added warnings for ^0.x peer dep propagation and workspace:\* on peer deps.
- [#17](https://github.com/dmno-dev/bumpy/pull/17) [`256a9db`](https://github.com/dmno-dev/bumpy/commit/256a9db0cc9e490bd631522c1118e7d793bc6e99) - Add `thankContributors` option to the GitHub changelog formatter to disable "Thanks @user" messages entirely. Add dedicated changelog formatters docs page.
- [#18](https://github.com/dmno-dev/bumpy/pull/18) [`c143126`](https://github.com/dmno-dev/bumpy/commit/c1431262185a3d5513a06456bcfe40b31131b706) - Fix "Bun is not defined" error in CI release command when running under Node.js by replacing `Bun.CryptoHasher` with `node:crypto`.
- [#20](https://github.com/dmno-dev/bumpy/pull/20) [`243a1c7`](https://github.com/dmno-dev/bumpy/commit/243a1c78963ae1f26fae86e3675dc02786e04e11) - Add `--pat-pr` and `--pat-comments` flags to CI commands, allowing users to opt in to using `BUMPY_GH_TOKEN` for PR creation and comment posting. Also fixes CI not triggering on newly created version PRs.
- [#21](https://github.com/dmno-dev/bumpy/pull/21) [`be42db2`](https://github.com/dmno-dev/bumpy/commit/be42db29f20e5ed6f14a2572a526825d6b56d242) - Redesign `bumpy add` interactive UI with a unified bump level selector. Packages are shown in two groups (changed/unchanged), navigated with arrow keys, and bump levels cycled with left/right. Changed packages default to patch.
- [#22](https://github.com/dmno-dev/bumpy/pull/22) [`25d135d`](https://github.com/dmno-dev/bumpy/commit/25d135d76719d5bfa10833aa6120716faf118b6e) - Removed `patch-isolated` bump type. The concept added complexity for minimal benefit — in most monorepos using `^` ranges, a patch bump already stays in range without triggering propagation. Users who need to prevent propagation can use per-package `dependencyBumpRules` config instead.
- [#23](https://github.com/dmno-dev/bumpy/pull/23) [`dcd398e`](https://github.com/dmno-dev/bumpy/commit/dcd398e8aa010bc621d495848ba46b9b5f7d1407) - Fix `internalAuthors` option being ignored by the GitHub changelog formatter. The `loadFormatter` function matched the built-in "github" entry before reaching the options-aware path, so options like `internalAuthors` were silently dropped.
- [#24](https://github.com/dmno-dev/bumpy/pull/24) [`ca2fd77`](https://github.com/dmno-dev/bumpy/commit/ca2fd77e49d0bc9587e4ac04dca5e1960e4e0826) - Security hardening: ephemeral git token auth, custom command gating via allowCustomCommands, bump file input validation, structured tarball path parsing, changelog formatter path traversal fix, and force-push safeguard
- [#25](https://github.com/dmno-dev/bumpy/pull/25) [`1b252dc`](https://github.com/dmno-dev/bumpy/commit/1b252dc862ea7d19c5ac49696f9788885fe649ae) - Bumpy v1 release
- [#26](https://github.com/dmno-dev/bumpy/pull/26) [`74f61d0`](https://github.com/dmno-dev/bumpy/commit/74f61d0216f438fc4c9c0ba41276c028f3eb3cb9) - Fix force-push guard that was incorrectly comparing against HEAD instead of the configured base branch
- [#27](https://github.com/dmno-dev/bumpy/pull/27) [`545913b`](https://github.com/dmno-dev/bumpy/commit/545913bbd5d92ae2365b39596bb5333a4e616795) - Fix git push auth: revert to URL rewriting approach and add token redaction on errors
- [#28](https://github.com/dmno-dev/bumpy/pull/28) [`9529716`](https://github.com/dmno-dev/bumpy/commit/952971655d6586b4588bfeb8595ae111160f2f0b) - Fix git push auth failure caused by case-sensitive includeIf regex not matching lowercase keys from git config

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
