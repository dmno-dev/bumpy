---
'@varlock/bumpy': patch
---

Disable npm staged publishing — feature is not yet ready for production use. Removes `npmStaged` config and the npm upgrade step from the release workflow. Also fix draft release functions (`createDraftRelease`, `updateReleaseBody`, `finalizeRelease`, `deleteRelease`) to use `BUMPY_GH_TOKEN` via `withReleaseToken` so that GitHub release events trigger downstream workflows.
