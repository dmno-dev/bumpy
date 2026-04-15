---
'@varlock/bumpy': patch
---

Fix git tag pushing and GitHub release creation

- Use `git push --tags` instead of `--follow-tags` so lightweight tags are actually pushed to the remote
- Pass `--target` commit SHA to `gh release create` as a fallback in case tags haven't propagated
