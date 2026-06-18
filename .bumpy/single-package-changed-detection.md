---
'@varlock/bumpy': patch
---

Fix changed-package detection in single-package (non-monorepo) repos. Both `findChangedPackages` (used by `check`/`ci check`) and `mapFilesToPackages` (used by `generate`) matched changed files against `pkgRelDir + '/'`, but for the root package the relative dir is empty, so the check became `file.startsWith('/')` — always false for git's relative paths. As a result `ci check` always reported "No managed packages have changed" (never requiring a bump file or posting a PR comment) and `generate` never attributed commits to the root package. The root package (empty relative dir) now treats every changed file as belonging to it, while still honoring `changedFilePatterns`.
