---
'@varlock/bumpy': minor
---

Removed `patch-isolated` bump type. The concept added complexity for minimal benefit — in most monorepos using `^` ranges, a patch bump already stays in range without triggering propagation. Users who need to prevent propagation can use per-package `dependencyBumpRules` config instead.
