---
'@varlock/bumpy': minor
---

Rework `bumpy check` and `bumpy ci check` behavior: default mode now only fails when no bump files exist at all (matching changesets), new `--strict` flag requires every changed package to be covered, and `--no-fail` makes checks advisory-only. Also fix false positive "empty bump file found" when deleted bump files appear in git diff.
