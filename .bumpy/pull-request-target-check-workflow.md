---
'@varlock/bumpy': minor
---

Recommend `pull_request_target` for the `bumpy ci check` workflow so fork PRs receive release-plan comments. Previously, fork PRs running under `pull_request` got a read-only token, so the check would fail red with no helpful comment — a bad first impression for OSS projects. `bumpy ci check` now recognizes the `pull_request_target` event when reading the PR number from `GITHUB_EVENT_PATH`, and emits a clearer warning that links to the new docs when comment posting fails on a fork PR. See the updated [GitHub Actions docs](https://bumpy.varlock.dev/docs/github-actions) for the new workflow (the version is resolved from the base branch's `package.json`, so no version pinning duplication).
