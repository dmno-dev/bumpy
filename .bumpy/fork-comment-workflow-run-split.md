---
'@varlock/bumpy': minor
---

Add a `pull_request` + `workflow_run` option for commenting on fork PRs, so the privileged half never touches fork code. `bumpy ci check --emit-comment <dir>` renders the release-plan comment to `<dir>/comment.md` for upload as an artifact, and a new `bumpy ci comment --body-file <path>` posts it from a `workflow_run` job. The target PR is resolved from the trusted `workflow_run` event (`head_sha`), never from the (untrusted) artifact.
