---
'@varlock/bumpy': minor
---

Added a `$changelog: false` reserved frontmatter key for bump files, which omits a file's body from the changelog and release notes while still applying its version bump. Clearer than relying on a blank body, and lets you keep notes for reviewers. A per-package `changelog: false` option in the nested form suppresses the entry for just some of a file's packages.
