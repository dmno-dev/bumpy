---
'@varlock/bumpy': minor
---

Add `bumpy ci deps` for Dependabot / Renovate PRs (modeled on changesets-dependencies-action). It diffs each package's `dependencies` / `peerDependencies` / `optionalDependencies` (plus `releaseTriggeringDevDeps`, and catalog updates) against the base branch, writes one patch bump file per affected package listing the added / updated / removed deps, and commits + pushes them to the PR branch. Re-running is idempotent and removes stale files. `bumpy generate --deps` does the same locally without committing.

Also fix `ci check` on PRs into a channel branch: the `package.json` field diff and catalog diff compared against `baseBranch` instead of the PR's base, so dependency drift already merged into the channel was attributed to every later PR.
