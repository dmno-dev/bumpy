---
'@varlock/bumpy': patch
---

Fix `internalAuthors` option being ignored by the GitHub changelog formatter. The `loadFormatter` function matched the built-in "github" entry before reaching the options-aware path, so options like `internalAuthors` were silently dropped.
