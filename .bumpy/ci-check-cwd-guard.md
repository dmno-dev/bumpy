---
'@varlock/bumpy': none
---

`bumpy ci check` now fails when it runs under `pull_request_target` without an explicit `--cwd`, pointing users at the two-checkout workflow. Pass `--cwd .` to acknowledge an already-trusted checkout. Marked `none` because it's part of the `--cwd` feature already shipping in this release.
