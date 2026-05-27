---
'@varlock/bumpy': patch
---

Use `BUMPY_GH_TOKEN` for GitHub release creation so releases trigger downstream workflows. Also adds token redaction to error messages in `withPatToken` and the new `withReleaseToken` helper to prevent leakage in CI logs.
