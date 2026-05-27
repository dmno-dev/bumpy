---
'@varlock/bumpy': patch
---

Fix draft release functions (`createDraftRelease`, `updateReleaseBody`, `finalizeRelease`, `deleteRelease`) to use `BUMPY_GH_TOKEN` via `withReleaseToken` so that GitHub release events trigger downstream workflows. Also disables npm staged publishing (not yet ready) and removes the npm upgrade step from the release workflow.
