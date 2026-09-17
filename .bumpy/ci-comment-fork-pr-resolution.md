---
'@varlock/bumpy': patch
---

Fix `bumpy ci comment` failing to resolve the target PR for fork PRs. Under `workflow_run`, the PR was looked up via `GET commits/{head_sha}/pulls`, which only knows about commits in the base repo's own branches — for a fork PR it returns nothing, so the command exited with "Could not resolve a target PR" (defeating the whole point of the fork-safe `pull_request` + `workflow_run` split). When that lookup is empty, bumpy now scans the repo's open PRs (paginated) and matches `head.sha` against the trusted `workflow_run.head_sha`. The target still derives only from the trusted event, never from the artifact or from `workflow_run.pull_requests[]` (which GitHub leaves empty for forks).
