---
'@varlock/bumpy': minor
---

Added `requireBumpFile: true` per-package config — `bumpy check` and `bumpy ci check` always fail when such a package changed but no bump file lists it, even if other bump files (or an empty bump file) are present. List it with type `none` to acknowledge a change without releasing.
