---
'@varlock/bumpy': minor
---

New per-package `sourcePaths` option: repo-root-relative globs (with `!` exclusions) for sources outside a package's directory. A changed file matching one marks the package as changed, so `bumpy check` requires a bump file for it and `bumpy generate` attributes the commit to it — e.g. a native-binary package built from a separate source package.
