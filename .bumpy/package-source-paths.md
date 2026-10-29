---
'@varlock/bumpy': minor
---

New per-package `sourcePaths` option: globs (relative to the package dir like other per-package globs, `../` to reach out, `!` to exclude) for sources outside a package's directory. A changed file matching one marks the package as changed, so `bumpy check` requires a bump file for it and `bumpy generate` attributes the commit to it — e.g. a native-binary package built from a separate source package.
