---
'@varlock/bumpy': patch
---

Channel release PR titles and bodies now show deterministic versions: targets with a wildcard counter (`1.2.0-rc.x`) derived purely from committed state, instead of registry-derived counters that could drift between PR creation and publish. Multi-package cycles show a package count in the title instead of an arbitrary lead package. The PR check comment and `version` output use the same `.x` wildcard; `status` / `ci plan` still show live registry-derived counters (`.?` when offline).
