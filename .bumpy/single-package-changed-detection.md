---
'@varlock/bumpy': patch
---

Fix changed-package detection in single-package (non-monorepo) repos. `findChangedPackages` matched changed files against `pkgRelDir + '/'`, but for the root package the relative dir is empty, so the check became `file.startsWith('/')` — always false for git's relative paths. As a result `ci check` always reported "No managed packages have changed" and never required a bump file or posted a PR comment. The root package (empty relative dir) now treats every changed file as belonging to it, while still honoring `changedFilePatterns`.
