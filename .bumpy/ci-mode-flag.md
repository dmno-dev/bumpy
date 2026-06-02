---
'@varlock/bumpy': minor
---

Add `--mode` flag to `bumpy ci release` for asserting the detected release mode (`version-pr` or `publish`). Enables split-job release workflows where each job fails loudly if the runtime state doesn't match what the job expects. Refactored `ReleaseOptions` to rename the existing `mode` field to `autoPublish: boolean` and add `assertMode`. `--mode` and `--auto-publish` cannot be combined.
