---
'@varlock/bumpy': minor
---

Change detection is now `package.json`-field-aware: when `package.json` is the only changed file in a package, bumpy diffs it against the base branch and only requires a bump file if a publish-affecting field changed. The new `ignoredPackageJsonFields` option (default `["devDependencies"]`) controls which fields are ignored, so a dev-only dependency bump (e.g. Dependabot) no longer requires a bump file — unless the changed dep matches the package's `releaseTriggeringDevDeps`.

`ci check` no longer posts a "you're good to go" comment while exiting 1. When the check fails because changed packages have no bump file, the comment now matches the failing status, lists the uncovered packages, and points at an empty bump file (`bumpy add --empty`) to acknowledge an intentional no-release.

Add a per-package `releaseTriggeringDevDeps` option: names/globs of `devDependencies` that affect a package's published output (most often because they're bundled in). A change to one requires a release, and a listed internal workspace dep's own releases cascade with a patch bump — shorthand for a `cascadeFrom` rule of `{ trigger: 'patch', bumpAs: 'patch' }`.
