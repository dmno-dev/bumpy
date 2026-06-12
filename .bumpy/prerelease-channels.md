---
'@varlock/bumpy': minor
---

Add prerelease channels — branch-based prerelease lines (e.g. `next` → `@next` dist-tag) where prerelease versions are never committed to git. Targets derive from bump files, counters from the registry; shipped bump files are tracked by moving them into `.bumpy/<channel>/`. Includes channel-aware `version` / `publish` / `status` / `ci release` flows, exact-pinned lockstep cycle publishes, and promotion-by-merge to stable.
