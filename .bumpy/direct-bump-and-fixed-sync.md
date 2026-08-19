---
'@varlock/bumpy': minor
---

Added `directBump: false` per-package config for packages that only receive propagated bumps (e.g. platform binary packages in a fixed group with their core package) — they are excluded from `bumpy add`/`bumpy generate`, rejected when a bump file names them directly, and `bumpy check` points at their fixed-group members instead. Release summaries collapse them under the package that drove the bump rather than repeating the same summary once per binary. Fixed groups now sync drifted members to a bump of the group's highest version so they reconverge.
