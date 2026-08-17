---
'@varlock/bumpy': patch
---

Replaced the `semver` dependency with [verkit](https://github.com/sxzz/verkit) — a smaller, tree-shakeable, zero-dependency SemVer library. No behavior changes, except invalid snapshot versions are now also refused (previously only stable versions were).
