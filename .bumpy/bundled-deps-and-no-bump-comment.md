---
'@varlock/bumpy': minor
---

Change detection is now `package.json`-field-aware: when `package.json` is the only changed file in a package, bumpy diffs it against the base branch and only requires a bump file if a publish-affecting field changed. The new `ignoredPackageJsonFields` option (default `["devDependencies"]`) controls which fields are ignored, so a dev-only dependency bump (e.g. Dependabot) no longer requires a bump file — unless the changed dep matches the package's `bundledDependencies`.

`ci check` no longer posts a "you're good to go" comment while exiting 1. When the check fails because changed packages have no bump file, the comment now matches the failing status, lists the uncovered packages, and points at an empty bump file (`bumpy add --empty`) to acknowledge an intentional no-release.

Add a per-package `bundledDependencies` option: names/globs of workspace deps bundled into a package's published output (commonly under `devDependencies`). Any bump to a listed dep republishes the bundling package with a patch bump — shorthand for a `cascadeFrom` rule of `{ trigger: 'patch', bumpAs: 'patch' }`.
