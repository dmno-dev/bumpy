---
'@varlock/bumpy': minor
---

`ci check` no longer posts a "you're good to go" comment while exiting 1. When the check fails because changed packages have no bump file, the comment now matches the failing status, lists the uncovered packages, and points at an empty bump file (`bumpy add --empty`) to acknowledge an intentional no-release.

Add a per-package `bundledDependencies` option: names/globs of workspace deps bundled into a package's published output (commonly under `devDependencies`). Any bump to a listed dep republishes the bundling package with a patch bump — shorthand for a `cascadeFrom` rule of `{ trigger: 'patch', bumpAs: 'patch' }`.
