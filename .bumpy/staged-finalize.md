---
'@varlock/bumpy': minor
---

Handle staged publishing (`npmStaged`) honestly in GitHub releases. A `npm stage publish` is no longer treated as a live publish: the release target is marked **🟡 staged, awaiting approval** (with the npm stage id recorded), and the GitHub release stays a **draft** so the `release: published` event doesn't fire before the package is actually live. A new `bumpy publish finalize [name@version]` command reconciles staged releases once they're approved — it checks the registry and, if the version has gone live, flips the target to ✅ with the live URL and publishes the release. It's idempotent, so it can run on a schedule, manually, or from an approval webhook (`repository_dispatch`). See the new [finalize workflow](docs/github-actions.md#staged-publishing-finalize-workflow) docs.
